import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import type {
  CancelResult,
  ResumeRequest,
  WorkerAdapter,
  WorkerCapabilities,
  WorkerEvent,
  WorkerInspection,
  WorkerRequest,
} from "./types";
import { HashWorkspaceObserver, type WorkspaceObserver } from "./workspace-observer";

export interface CommandWorkerOptions {
  /** Logical command key -> executable path. No PATH lookup is performed by the workflow. */
  executables: Record<string, string>;
  /** Host-owned argv replacement by executable key (workflow argv is ignored). */
  fixedArgs?: Record<string, string[]>;
  /** Host-owned stdin bytes captured before any worker can mutate disk. */
  fixedStdin?: Record<string, string | Buffer>;
  inheritedEnvironment?: string[];
  effectObservation?: {
    maxEntries?: number;
    maxBytes?: number;
  };
  workspaceObserver?: WorkspaceObserver;
}

/**
 * Direct argv command adapter. It never enables a shell, bounds output and
 * duration, and resolves executable names through a host-owned allowlist.
 */
export class CommandWorkerAdapter implements WorkerAdapter {
  readonly #executables: Record<string, string>;
  readonly #environmentKeys: string[];
  readonly #fixedArgs: Record<string, string[]>;
  readonly #fixedStdin: Record<string, Buffer>;
  readonly #workspaceObserver: WorkspaceObserver;
  readonly #children = new Map<string, ReturnType<typeof spawn>>();
  readonly #inspections = new Map<string, WorkerInspection>();

  constructor(options: CommandWorkerOptions) {
    this.#executables = {};
    for (const [key, executable] of Object.entries(options.executables)) {
      if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(key)) throw new Error(`Unsafe executable allowlist key: ${JSON.stringify(key)}`);
      if (!path.isAbsolute(executable) || !existsSync(executable) || !statSync(executable).isFile()) {
        throw new Error(`Executable allowlist entries must be absolute existing files (${key}: ${JSON.stringify(executable)})`);
      }
      this.#executables[key] = realpathSync(executable);
    }
    this.#fixedArgs = {};
    for (const [key, args] of Object.entries(options.fixedArgs ?? {})) {
      if (!Object.hasOwn(this.#executables, key) || !Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
        throw new Error(`Invalid host-owned fixed argv profile: ${key}`);
      }
      this.#fixedArgs[key] = [...args];
    }
    this.#fixedStdin = {};
    for (const [key, input] of Object.entries(options.fixedStdin ?? {})) {
      if (!Object.hasOwn(this.#executables, key) || !(typeof input === "string" || Buffer.isBuffer(input))) {
        throw new Error(`Invalid host-owned fixed stdin profile: ${key}`);
      }
      this.#fixedStdin[key] = Buffer.from(input);
    }
    this.#environmentKeys = options.inheritedEnvironment ?? [
      "PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE",
    ];
    this.#workspaceObserver = options.workspaceObserver ?? new HashWorkspaceObserver({
      maxEntries: options.effectObservation?.maxEntries,
      maxBytes: options.effectObservation?.maxBytes,
    });
  }

  async capabilities(): Promise<WorkerCapabilities> {
    return {
      adapter: "direct-command-v1",
      phaseKinds: ["deterministic-command"],
      accessModes: ["read-only", "workspace-write"],
      structuredOutput: true,
      inspect: true,
      cancel: true,
    };
  }

  async *start(request: WorkerRequest): AsyncIterable<WorkerEvent> {
    const command = request.phase.command;
    if (!command) {
      yield { type: "failed", category: "internal-error", message: "deterministic-command phase has no command contract" };
      return;
    }
    const executable = this.#executables[command.executable];
    if (!executable) {
      yield { type: "failed", category: "capability-mismatch", message: `Executable key is not allowlisted: ${command.executable}` };
      return;
    }
    let cwd: string;
    try {
      cwd = containedCwd(request.workspaceRoot, command.cwd ?? ".");
    } catch (error) {
      yield { type: "failed", category: "authorization-violation", message: error instanceof Error ? error.message : String(error) };
      return;
    }
    const environment: NodeJS.ProcessEnv = {};
    for (const key of this.#environmentKeys) {
      if (process.env[key] !== undefined) environment[key] = process.env[key];
    }
    Object.assign(environment, command.env ?? {});

    const before = this.#workspaceObserver.capture(request.workspaceRoot);
    if (!before.ok) {
      this.#inspections.set(request.workerRunId, {
        workerRunId: request.workerRunId,
        state: "failed",
        effects: { status: "unsupported", mutations: [] },
      });
      yield { type: "failed", category: "effects-unobservable", message: before.error };
      return;
    }

    yield { type: "started", workerRunId: request.workerRunId };
    const result = await runProcess({
      executable,
      args: this.#fixedArgs[command.executable] ?? command.args,
      cwd,
      env: environment,
      timeoutMs: command.timeoutMs ?? request.phase.timeoutMs,
      maxOutputBytes: command.maxOutputBytes ?? 256 * 1024,
      signal: request.signal,
      stdin: this.#fixedStdin[command.executable],
      onChild: (child) => this.#children.set(request.workerRunId, child),
    });
    this.#children.delete(request.workerRunId);

    const after = this.#workspaceObserver.capture(request.workspaceRoot);
    if (!after.ok) {
      this.#inspections.set(request.workerRunId, {
        workerRunId: request.workerRunId,
        state: "failed",
        effects: { status: "unsupported", mutations: [] },
      });
      yield { type: "failed", category: "effects-unobservable", message: after.error, exitCode: result.exitCode };
      return;
    }
    const mutations = this.#workspaceObserver.diff(before, after);
    const effects = mutations.length
      ? { status: "observed" as const, mutations }
      : { status: "none" as const, mutations: [] };
    const output = { exitCode: result.exitCode ?? -1, stdout: result.stdout, stderr: result.stderr };
    this.#inspections.set(request.workerRunId, {
      workerRunId: request.workerRunId,
      state: result.category || result.exitCode !== 0 ? "failed" : "completed",
      effects,
      output,
      exitCode: result.exitCode,
      ...(result.signal ? { signal: result.signal } : {}),
    });
    for (const effect of mutations) yield { type: "effect", effect };

    if (result.category) {
      yield { type: "failed", category: result.category, message: result.error ?? result.category, exitCode: result.exitCode };
      return;
    }
    yield { type: "result", output, exitCode: result.exitCode ?? -1, ...(result.signal ? { signal: result.signal } : {}) };
  }

  async *resume(request: ResumeRequest): AsyncIterable<WorkerEvent> {
    const inspection = await this.inspect(request.workerRunId);
    if (inspection.state === "completed" && inspection.output !== undefined && Number.isInteger(inspection.exitCode)) {
      yield { type: "result", output: inspection.output, exitCode: inspection.exitCode!, ...(inspection.signal ? { signal: inspection.signal } : {}) };
      return;
    }
    yield { type: "failed", category: "protocol-failure", message: `Command worker ${request.workerRunId} is not resumable (${inspection.state})` };
  }

  async cancel(workerRunId: string): Promise<CancelResult> {
    const child = this.#children.get(workerRunId);
    if (!child) return { workerRunId, cancelled: false };
    child.kill("SIGTERM");
    return { workerRunId, cancelled: true };
  }

  async inspect(workerRunId: string): Promise<WorkerInspection> {
    if (this.#children.has(workerRunId)) {
      return { workerRunId, state: "running", effects: { status: "unsupported", mutations: [] } };
    }
    return this.#inspections.get(workerRunId) ?? {
      workerRunId,
      state: "unknown",
      effects: { status: "unsupported", mutations: [] },
    };
  }
}

interface ProcessResult {
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  category?: "launch-failure" | "deterministic-check-failure" | "cancelled" | "protocol-failure";
  error?: string;
}

async function runProcess(options: {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  stdin?: Buffer;
  onChild: (child: ReturnType<typeof spawn>) => void;
}): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve) => {
    let settled = false;
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let overflow = false;
    let timedOut = false;
    let aborted = false;
    let launchError: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let outputBytes = 0;
    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve(result);
    };
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      const remaining = Math.max(0, options.maxOutputBytes - outputBytes);
      const accepted = chunk.subarray(0, remaining);
      outputBytes += accepted.length;
      if (chunk.length > remaining) overflow = true;
      return accepted.length ? Buffer.concat([current, accepted]) : current;
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.executable, options.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
      options.onChild(child);
      if (options.stdin && child.stdin) {
        child.stdin.on("error", (error) => { launchError = error; });
        child.stdin.end(options.stdin);
      }
    } catch (error) {
      finish({ exitCode: null, stdout: "", stderr: "", category: "launch-failure", error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const terminate = (): void => {
      child.kill("SIGTERM");
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 250);
        forceKillTimer.unref?.();
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, Buffer.from(chunk));
      if (overflow) terminate();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, Buffer.from(chunk));
      if (overflow) terminate();
    });
    child.on("error", (error) => { launchError = error; });
    child.on("close", (exitCode, signal) => {
      const base = {
        exitCode,
        ...(signal ? { signal } : {}),
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      };
      if (aborted) return finish({ ...base, category: "cancelled", error: "command cancelled" });
      if (timedOut) return finish({ ...base, category: "deterministic-check-failure", error: `command exceeded ${options.timeoutMs}ms` });
      if (overflow) return finish({ ...base, category: "protocol-failure", error: `command output exceeded ${options.maxOutputBytes} bytes` });
      if (launchError) return finish({ ...base, category: "launch-failure", error: launchError.message });
      finish(base);
    });
    options.signal?.addEventListener("abort", () => {
      aborted = true;
      terminate();
    }, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
  });
}

function containedCwd(root: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split(/[\\/]+/).includes("..")) throw new Error(`Command cwd escapes workspace: ${relative}`);
  const canonicalRoot = realpathSync(root);
  const lexicalCandidate = path.resolve(canonicalRoot, relative);
  if (!existsSync(lexicalCandidate) || !statSync(lexicalCandidate).isDirectory()) throw new Error(`Command cwd is not an existing directory: ${relative}`);
  const canonicalCandidate = realpathSync(lexicalCandidate);
  const relation = path.relative(canonicalRoot, canonicalCandidate);
  if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) throw new Error(`Command cwd escapes workspace through a link: ${relative}`);
  return canonicalCandidate;
}
