import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { getPackageDir } from "@earendil-works/pi-coding-agent";

import { resolveJavaScriptCliCommand } from "../child-launch";
import { SystemProcessInspector } from "./process";
import type {
  MissionRoute,
  MissionWorker,
  MissionWorkerEvent,
  MissionWorkerFactory,
  MissionWorkerIdentity,
  MissionWorkerInspection,
  OpenMissionWorkerRequest,
  ProcessInspector,
  ProcessObservation,
} from "./types";

const RPC_ADAPTER_NAME = "pi-rpc-mission-worker-v1";
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;
const READ_ONLY_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);
const BASE_CHILD_ENV_NAMES = [
  "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT", "PATH", "Path", "path",
  "TEMP", "TMP", "TMPDIR", "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "PROGRAMDATA", "ProgramFiles", "ProgramFiles(x86)", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
  "USERNAME", "USER", "SHELL", "LANG", "LC_ALL", "TERM", "COLORTERM",
] as const;

const RPC_EVENT_TYPES = new Set([
  "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end", "queue_update", "compaction_start", "compaction_end",
  "auto_retry_start", "auto_retry_end", "extension_error",
]);

interface RpcState {
  model: { provider?: unknown; id?: unknown } | null;
  thinkingLevel: unknown;
  isStreaming: unknown;
  sessionFile?: unknown;
  sessionId: unknown;
}

interface RpcEntries {
  entries: unknown[];
  leafId: string | null;
}

interface RpcStats {
  tokens?: { total?: unknown };
}

interface RpcClientOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell?: boolean;
  commandTimeoutMs: number;
  maxFrameBytes: number;
}

interface PendingRequest {
  command: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface PiRpcMissionWorkerFactoryOptions {
  sessionRoot: string;
  cliPath?: string;
  /** Explicit child-environment additions. Values here are caller-authorized. */
  env?: NodeJS.ProcessEnv;
  /** Additional host variable names to forward; all other ambient variables are stripped. */
  forwardEnv?: string[];
  processInspector?: ProcessInspector;
  commandTimeoutMs?: number;
  promptTimeoutMs?: number;
  heartbeatMs?: number;
  shutdownGraceMs?: number;
  maxFrameBytes?: number;
  /** Extra bounded CLI arguments, primarily for deterministic test fixtures. */
  extraArgs?: string[];
}

/**
 * Isolated Pi RPC worker adapter for the Durable Mission Supervisor.
 *
 * It deliberately owns its JSONL parser and child lifecycle rather than relying on
 * print-mode final text. Session file + leaf entry form the durable continuation
 * identity; PID + OS process-start identity fence PID reuse.
 */
export class PiRpcMissionWorkerFactory implements MissionWorkerFactory {
  readonly adapterName = RPC_ADAPTER_NAME;
  #sessionRoot: string;
  readonly #cliPath: string;
  readonly #hostEnv: NodeJS.ProcessEnv;
  readonly #explicitEnv: NodeJS.ProcessEnv;
  readonly #forwardEnv: string[];
  readonly #inspector: ProcessInspector;
  readonly #commandTimeoutMs: number;
  readonly #promptTimeoutMs: number;
  readonly #heartbeatMs: number;
  readonly #shutdownGraceMs: number;
  readonly #maxFrameBytes: number;
  readonly #extraArgs: string[];
  readonly #active = new Map<string, PiRpcMissionWorker>();

  constructor(options: PiRpcMissionWorkerFactoryOptions) {
    this.#sessionRoot = path.resolve(options.sessionRoot);
    this.#cliPath = path.resolve(options.cliPath ?? path.join(getPackageDir(), "dist", "cli.js"));
    if (!existsSync(this.#cliPath) || !statSync(this.#cliPath).isFile()) throw new RpcMissionWorkerError("RPC_CLI_MISSING", this.#cliPath);
    this.#hostEnv = { ...process.env };
    this.#explicitEnv = { ...options.env };
    this.#forwardEnv = [...(options.forwardEnv ?? [])].map(assertEnvironmentName);
    this.#inspector = options.processInspector ?? new SystemProcessInspector(this.#hostEnv);
    this.#commandTimeoutMs = positiveMs(options.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, "commandTimeoutMs");
    this.#promptTimeoutMs = positiveMs(options.promptTimeoutMs, DEFAULT_PROMPT_TIMEOUT_MS, "promptTimeoutMs");
    this.#heartbeatMs = positiveMs(options.heartbeatMs, DEFAULT_HEARTBEAT_MS, "heartbeatMs");
    this.#shutdownGraceMs = positiveMs(options.shutdownGraceMs, DEFAULT_SHUTDOWN_GRACE_MS, "shutdownGraceMs");
    this.#maxFrameBytes = positiveMs(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, "maxFrameBytes");
    this.#extraArgs = [...(options.extraArgs ?? [])];
  }

  async open(request: OpenMissionWorkerRequest): Promise<MissionWorker> {
    this.#sessionRoot = prepareSessionRootOutsideWorkspace(request.cwd, this.#sessionRoot);
    const routes = orderedRoutes(request);
    const failures: string[] = [];
    for (const route of routes) {
      try {
        const worker = await this.#openRoute(request, route);
        this.#active.set(worker.identity.workerId, worker);
        return worker;
      } catch (error) {
        failures.push(`${route.provider}/${route.model}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new RpcMissionWorkerError("RPC_ROUTE_CHAIN_EXHAUSTED", failures.join(" | "));
  }

  async inspect(identity: MissionWorkerIdentity): Promise<MissionWorkerInspection> {
    const active = this.#active.get(identity.workerId);
    if (active && sameProcessIdentity(active.identity, identity)) return active.inspect();
    const observation = identity.pid ? this.#inspector.inspect(identity.pid) : undefined;
    if (!observation?.alive) return { state: "exited", identity, exitCode: null };
    if (!observation.startedAt) {
      return { state: "unknown", identity, error: "worker PID may be alive but its process-start identity is unavailable" };
    }
    if (!sameStartIdentity(identity.processStartedAt, observation.startedAt)) {
      return { state: "exited", identity, exitCode: null, error: "PID is occupied by a different process-start identity" };
    }
    return { state: "running", identity, error: "worker process is alive but this supervisor does not own its stdio transport" };
  }

  async terminate(identity: MissionWorkerIdentity): Promise<boolean> {
    const active = this.#active.get(identity.workerId);
    if (active && sameProcessIdentity(active.identity, identity)) {
      const stopped = await active.terminate();
      if (stopped) this.#active.delete(identity.workerId);
      return stopped;
    }
    return terminateOwnedProcessTree(identity, this.#inspector, this.#shutdownGraceMs);
  }

  async #openRoute(request: OpenMissionWorkerRequest, route: Required<MissionRoute>): Promise<PiRpcMissionWorker> {
    const runtime = resolveJavaScriptCliCommand(this.#cliPath, { env: this.#hostEnv });
    const childEnv = buildWorkerEnvironment(this.#hostEnv, this.#explicitEnv, this.#forwardEnv, route);
    if (runtime.launchRuntime === "electron-as-node") childEnv.ELECTRON_RUN_AS_NODE = "1";
    const tools = request.readOnly ? "read,grep,find,ls" : "read,bash,edit,write,grep,find,ls";
    const requestedSessionFile = request.resume
      ? assertResumeSession(this.#sessionRoot, request.resume.sessionFile)
      : reserveNewSessionFile(this.#sessionRoot, request.runId);
    const args = [
      ...runtime.argsPrefix,
      "--mode", "rpc",
      "--provider", route.provider,
      "--model", route.model,
      "--thinking", route.thinkingLevel,
      "--session-dir", this.#sessionRoot,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--tools", tools,
      "--session", requestedSessionFile,
      ...this.#extraArgs,
    ];
    const client = new StrictRpcClient({
      command: runtime.command,
      args,
      cwd: request.cwd,
      env: childEnv,
      shell: runtime.shell,
      commandTimeoutMs: this.#commandTimeoutMs,
      maxFrameBytes: this.#maxFrameBytes,
    });
    try {
      await client.start();
      const pid = client.pid;
      if (!pid) throw new RpcMissionWorkerError("RPC_PID_MISSING", request.runId);
      const processObservation = await observeStartedProcess(this.#inspector, pid);
      if (!processObservation.alive || !processObservation.startedAt) {
        throw new RpcMissionWorkerError("RPC_PROCESS_IDENTITY_UNAVAILABLE", String(pid));
      }
      const state = await client.getState();
      const sessionId = requiredString(state.sessionId, "sessionId");
      const sessionFile = assertDurableSessionFile(this.#sessionRoot, state.sessionFile, sessionId, request.cwd);
      if (!sameFilePath(sessionFile, requestedSessionFile)) {
        throw new RpcMissionWorkerError("RPC_SESSION_IDENTITY_MISMATCH", `${sessionFile} != ${requestedSessionFile}`);
      }
      assertRouteState(state, route);
      const entries = await client.getEntries(request.resume?.cursor ?? undefined);
      const cursor = entries.leafId;
      if (request.resume?.sessionId && request.resume.sessionId !== sessionId) {
        throw new RpcMissionWorkerError("RPC_RESUME_SESSION_ID_MISMATCH", `${request.resume.sessionId} != ${sessionId}`);
      }
      const identity: MissionWorkerIdentity = {
        adapter: this.adapterName,
        workerId: `${request.runId}:primary:${request.generation}`,
        pid,
        processStartedAt: processObservation.startedAt,
        sessionId,
        sessionFile,
        cursor,
        generation: request.generation,
        route,
      };
      return new PiRpcMissionWorker({
        identity,
        client,
        inspector: this.#inspector,
        promptTimeoutMs: this.#promptTimeoutMs,
        heartbeatMs: this.#heartbeatMs,
        shutdownGraceMs: this.#shutdownGraceMs,
        readOnly: request.readOnly,
      });
    } catch (error) {
      await client.forceStop(this.#inspector, this.#shutdownGraceMs).catch(() => false);
      throw error;
    }
  }
}

interface PiRpcMissionWorkerOptions {
  identity: MissionWorkerIdentity;
  client: StrictRpcClient;
  inspector: ProcessInspector;
  promptTimeoutMs: number;
  heartbeatMs: number;
  shutdownGraceMs: number;
  readOnly: boolean;
}

class PiRpcMissionWorker implements MissionWorker {
  readonly identity: MissionWorkerIdentity;
  readonly #client: StrictRpcClient;
  readonly #inspector: ProcessInspector;
  readonly #promptTimeoutMs: number;
  readonly #heartbeatMs: number;
  readonly #shutdownGraceMs: number;
  readonly #readOnly: boolean;
  #promptActive = false;
  #closed = false;
  #termination: Promise<boolean> | undefined;

  constructor(options: PiRpcMissionWorkerOptions) {
    this.identity = options.identity;
    this.#client = options.client;
    this.#inspector = options.inspector;
    this.#promptTimeoutMs = options.promptTimeoutMs;
    this.#heartbeatMs = options.heartbeatMs;
    this.#shutdownGraceMs = options.shutdownGraceMs;
    this.#readOnly = options.readOnly;
    this.#client.onProtocolFailure(() => {
      if (!this.#termination) this.#termination = this.#terminateNow();
    });
  }

  async *prompt(message: string, signal?: AbortSignal): AsyncIterable<MissionWorkerEvent> {
    if (this.#closed) throw new RpcMissionWorkerError("RPC_WORKER_CLOSED", this.identity.workerId);
    if (this.#promptActive) throw new RpcMissionWorkerError("RPC_PROMPT_ALREADY_ACTIVE", this.identity.workerId);
    if (signal?.aborted) throw new RpcMissionWorkerError("RPC_PROMPT_ABORTED", "aborted before prompt acceptance");
    const beforeStats = await this.#client.getSessionStats();
    const beforeTokens = tokenTotal(beforeStats);
    this.#promptActive = true;
    const queue = new AsyncQueue<MissionWorkerEvent>();
    let terminal = false;
    let latestAssistantFailure: string | undefined;
    let abortReason: string | undefined;
    let transportFailureHandled = false;

    const finish = async (): Promise<void> => {
      if (terminal) return;
      terminal = true;
      try {
        const entries = await this.#client.getEntries(this.identity.cursor ?? undefined);
        if (entries.leafId && entries.leafId !== this.identity.cursor) {
          this.identity.cursor = entries.leafId;
          queue.push({ type: "cursor", cursor: entries.leafId });
        }
        if (abortReason || latestAssistantFailure) {
          queue.push({ type: "failed", message: abortReason ?? latestAssistantFailure!, retryable: false, cursor: this.identity.cursor });
        } else {
          const stats = await this.#client.getSessionStats();
          queue.push({ type: "settled", cursor: this.identity.cursor, tokens: Math.max(0, tokenTotal(stats) - beforeTokens) });
        }
        queue.end();
      } catch (error) {
        queue.fail(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const unsubscribeEvent = this.#client.onEvent((event) => {
      const type = event.type;
      if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
        const toolName = requiredString(event.toolName, "toolName");
        if (this.#readOnly && type === "tool_execution_start" && !READ_ONLY_TOOL_NAMES.has(toolName)) {
          latestAssistantFailure = `read-only worker attempted forbidden tool '${toolName}'`;
          void this.#client.abort().catch(() => undefined);
        }
        queue.push({
          type: "tool",
          toolCallId: requiredString(event.toolCallId, "toolCallId"),
          toolName,
          phase: type === "tool_execution_start" ? "start" : type === "tool_execution_update" ? "update" : "end",
          ...(type === "tool_execution_end" ? { isError: event.isError === true } : {}),
        });
      } else if (type === "message_end") {
        const messageRecord = record(event.message);
        if (messageRecord?.role === "assistant") {
          const stopReason = typeof messageRecord.stopReason === "string" ? messageRecord.stopReason : "";
          if (stopReason === "error" || stopReason === "aborted") {
            latestAssistantFailure ??= typeof messageRecord.errorMessage === "string"
              ? messageRecord.errorMessage
              : `assistant stopped with ${stopReason}`;
          }
        }
      } else if (type === "extension_error") {
        latestAssistantFailure = `extension error: ${String(event.error ?? "unknown extension failure")}`;
      } else if (type === "agent_settled") {
        void finish();
      }
    });
    const unsubscribeExit = this.#client.onExit((exit) => {
      if (terminal || transportFailureHandled) return;
      transportFailureHandled = true;
      void this.terminate().then((stopped) => {
        queue.fail(new RpcMissionWorkerError(
          stopped ? "RPC_PROCESS_EXITED" : "RPC_PROCESS_TREE_CLEANUP_FAILED",
          describeExit(exit),
        ));
      }).catch((error) => queue.fail(error instanceof Error ? error : new Error(String(error))));
    });
    const heartbeat = setInterval(() => queue.push({ type: "heartbeat", at: new Date().toISOString() }), this.#heartbeatMs);
    heartbeat.unref?.();
    queue.push({ type: "heartbeat", at: new Date().toISOString() });
    const timeout = setTimeout(() => {
      abortReason = `worker prompt exceeded ${this.#promptTimeoutMs}ms`;
      void this.#client.abort().catch(() => undefined);
      setTimeout(() => void finish(), Math.min(5_000, this.#shutdownGraceMs)).unref?.();
    }, this.#promptTimeoutMs);
    timeout.unref?.();
    const onAbort = (): void => {
      abortReason = "worker prompt aborted by supervisor signal";
      void this.#client.abort().catch(() => undefined);
      setTimeout(() => void finish(), Math.min(5_000, this.#shutdownGraceMs)).unref?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await this.#client.prompt(message);
      for await (const event of queue) yield event;
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      unsubscribeEvent();
      unsubscribeExit();
      this.#promptActive = false;
    }
  }

  async inspect(): Promise<MissionWorkerInspection> {
    const pid = this.identity.pid;
    if (!pid) return { state: "unknown", identity: this.identity, error: "worker PID is absent" };
    const observation = this.#inspector.inspect(pid);
    if (!observation.alive) return { state: "exited", identity: this.identity, exitCode: this.#client.exit?.code ?? null };
    if (!observation.startedAt) {
      return { state: "unknown", identity: this.identity, error: "worker PID may be alive but its process-start identity is unavailable" };
    }
    if (!sameStartIdentity(this.identity.processStartedAt, observation.startedAt)) {
      return { state: "exited", identity: this.identity, exitCode: null, error: "PID start identity changed" };
    }
    try {
      const state = await this.#client.getState();
      return { state: state.isStreaming === true ? "running" : "idle", identity: this.identity };
    } catch (error) {
      return { state: "running", identity: this.identity, error: `process alive; RPC inspection failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async abort(): Promise<void> {
    if (this.#closed) return;
    await this.#client.abort();
  }

  async close(): Promise<void> {
    if (this.#termination) {
      if (!await this.#termination) throw new RpcMissionWorkerError("RPC_PROCESS_TREE_CLEANUP_FAILED", this.identity.workerId);
      return;
    }
    if (this.#closed) return;
    this.#closed = true;
    if (this.#promptActive) await this.#client.abort().catch(() => undefined);
    const stopped = await this.#client.gracefulStop(this.#inspector, this.#shutdownGraceMs, this.identity.processStartedAt);
    if (!stopped) throw new RpcMissionWorkerError("RPC_PROCESS_TREE_CLEANUP_FAILED", this.identity.workerId);
  }

  async terminate(): Promise<boolean> {
    this.#termination ??= this.#terminateNow();
    return this.#termination;
  }

  async #terminateNow(): Promise<boolean> {
    this.#closed = true;
    return this.#client.forceStop(this.#inspector, this.#shutdownGraceMs, this.identity.processStartedAt);
  }
}

class StrictRpcClient {
  readonly #options: RpcClientOptions;
  readonly #events = new Set<(event: Record<string, unknown>) => void>();
  readonly #exits = new Set<(exit: ProcessExit) => void>();
  readonly #protocolFailures = new Set<(error: Error) => void>();
  readonly #pending = new Map<string, PendingRequest>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #requestSequence = 0;
  #stderr = "";
  #protocolError: Error | undefined;
  #exit: ProcessExit | undefined;
  #stopReader: (() => void) | undefined;

  constructor(options: RpcClientOptions) {
    this.#options = options;
  }

  get pid(): number | undefined { return this.#child?.pid; }
  get exit(): ProcessExit | undefined { return this.#exit; }

  async start(): Promise<void> {
    if (this.#child) throw new RpcMissionWorkerError("RPC_ALREADY_STARTED", this.#options.cwd);
    const child = spawn(this.#options.command, this.#options.args, {
      cwd: this.#options.cwd,
      env: this.#options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: this.#options.shell,
      detached: process.platform !== "win32",
    });
    this.#child = child;
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr = `${this.#stderr}${chunk.toString("utf8")}`.slice(-STDERR_LIMIT);
    });
    this.#stopReader = attachStrictJsonl(child.stdout, this.#options.maxFrameBytes, (value) => this.#handleRecord(value), (error) => this.#failProtocol(error));
    child.once("exit", (code, signal) => this.#publishExit({ code, signal }));
    child.once("error", (error) => this.#publishExit({ code: null, signal: null, error }));
    child.stdin.on("error", (error) => this.#failProtocol(new RpcMissionWorkerError("RPC_STDIN_ERROR", error.message)));
    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => { cleanup(); resolve(); };
      const onError = (error: Error): void => { cleanup(); reject(error); };
      const cleanup = (): void => { child.off("spawn", onSpawn); child.off("error", onError); };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  onEvent(listener: (event: Record<string, unknown>) => void): () => void {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  onExit(listener: (exit: ProcessExit) => void): () => void {
    this.#exits.add(listener);
    if (this.#exit) queueMicrotask(() => listener(this.#exit!));
    return () => this.#exits.delete(listener);
  }

  onProtocolFailure(listener: (error: Error) => void): () => void {
    this.#protocolFailures.add(listener);
    if (this.#protocolError) queueMicrotask(() => listener(this.#protocolError!));
    return () => this.#protocolFailures.delete(listener);
  }

  getState(): Promise<RpcState> { return this.#request<RpcState>("get_state", {}); }
  getEntries(since?: string): Promise<RpcEntries> { return this.#request<RpcEntries>("get_entries", since ? { since } : {}); }
  getSessionStats(): Promise<RpcStats> { return this.#request<RpcStats>("get_session_stats", {}); }
  prompt(message: string): Promise<void> { return this.#request<void>("prompt", { message }); }
  abort(): Promise<void> { return this.#request<void>("abort", {}); }

  async gracefulStop(inspector: ProcessInspector, graceMs: number, expectedStartedAt?: string): Promise<boolean> {
    const pid = this.pid;
    if (!pid) return true;
    try { this.#child?.stdin.end(); } catch {}
    if (await this.#waitForExit(graceMs)) return true;
    return this.forceStop(inspector, graceMs, expectedStartedAt);
  }

  async forceStop(inspector: ProcessInspector, graceMs: number, expectedStartedAt?: string): Promise<boolean> {
    const pid = this.pid;
    if (!pid) return true;
    const observedStart = inspector.inspect(pid).startedAt;
    const identity: MissionWorkerIdentity = {
      adapter: RPC_ADAPTER_NAME,
      workerId: "cleanup",
      pid,
      processStartedAt: expectedStartedAt ?? observedStart,
      sessionId: "cleanup",
      sessionFile: path.resolve("cleanup.jsonl"),
      cursor: null,
      generation: 0,
    };
    const stopped = await terminateOwnedProcessTree(identity, inspector, graceMs);
    if (stopped) this.#stopReader?.();
    return stopped;
  }

  async #request<T>(command: string, data: Record<string, unknown>): Promise<T> {
    if (!this.#child || this.#child.exitCode !== null) throw this.#exitError();
    if (this.#protocolError) throw this.#protocolError;
    const id = `dms_${++this.#requestSequence}_${randomBytes(3).toString("hex")}`;
    const payload = `${JSON.stringify({ id, type: command, ...data })}\n`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RpcMissionWorkerError("RPC_COMMAND_TIMEOUT", `${command} exceeded ${this.#options.commandTimeoutMs}ms; stderr=${this.#stderr}`));
      }, this.#options.commandTimeoutMs);
      timer.unref?.();
      this.#pending.set(id, {
        command,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.#child!.stdin.write(payload, "utf8", (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new RpcMissionWorkerError("RPC_WRITE_FAILED", error.message));
      });
    });
  }

  #handleRecord(value: unknown): void {
    const message = record(value);
    if (!message || typeof message.type !== "string") return this.#failProtocol(new RpcMissionWorkerError("RPC_RECORD_INVALID", "record lacks a string type"));
    if (message.type === "response") {
      const id = typeof message.id === "string" ? message.id : "";
      const pending = this.#pending.get(id);
      if (!pending) return this.#failProtocol(new RpcMissionWorkerError("RPC_RESPONSE_UNCORRELATED", id || "missing id"));
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if (message.command !== pending.command) {
        const error = new RpcMissionWorkerError("RPC_RESPONSE_COMMAND_MISMATCH", `${String(message.command)} != ${pending.command}`);
        pending.reject(error);
        this.#failProtocol(error);
        return;
      }
      if (message.success !== true) return pending.reject(new RpcMissionWorkerError("RPC_COMMAND_FAILED", `${pending.command}: ${String(message.error ?? "unknown error")}`));
      pending.resolve(message.data);
      return;
    }
    if (!RPC_EVENT_TYPES.has(message.type)) return this.#failProtocol(new RpcMissionWorkerError("RPC_EVENT_UNKNOWN", message.type));
    for (const listener of this.#events) listener(message);
  }

  #failProtocol(error: Error): void {
    if (this.#protocolError) return;
    this.#protocolError = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const listener of this.#protocolFailures) listener(error);
    for (const listener of this.#exits) listener({ code: this.#child?.exitCode ?? null, signal: this.#child?.signalCode ?? null, error });
  }

  #publishExit(exit: ProcessExit): void {
    if (this.#exit) return;
    this.#exit = exit;
    this.#stopReader?.();
    const error = this.#exitError();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const listener of this.#exits) listener(exit);
  }

  #exitError(): Error {
    return this.#protocolError ?? new RpcMissionWorkerError("RPC_PROCESS_EXITED", `${describeExit(this.#exit)}; stderr=${this.#stderr}`);
  }

  async #waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.#exit || this.#child?.exitCode !== null) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { unsubscribe(); resolve(false); }, timeoutMs);
      timer.unref?.();
      const unsubscribe = this.onExit(() => { clearTimeout(timer); unsubscribe(); resolve(true); });
    });
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{ resolve: (value: IteratorResult<T>) => void; reject: (error: Error) => void }> = [];
  #ended = false;
  #error: Error | undefined;

  push(value: T): void {
    if (this.#ended || this.#error) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.#values.push(value);
  }

  end(): void {
    if (this.#ended || this.#error) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined as T, done: true });
  }

  fail(error: Error): void {
    if (this.#ended || this.#error) return;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.#values.length) return Promise.resolve({ value: this.#values.shift()!, done: false });
        if (this.#error) return Promise.reject(this.#error);
        if (this.#ended) return Promise.resolve({ value: undefined as T, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }
}

function attachStrictJsonl(
  stream: NodeJS.ReadableStream,
  maxFrameBytes: number,
  onRecord: (value: unknown) => void,
  onError: (error: Error) => void,
): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let stopped = false;
  const parseLine = (raw: string): void => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line) return onError(new RpcMissionWorkerError("RPC_EMPTY_FRAME", "empty JSONL frame"));
    try { onRecord(JSON.parse(line)); }
    catch (error) { onError(new RpcMissionWorkerError("RPC_MALFORMED_JSON", error instanceof Error ? error.message : String(error))); }
  };
  const onData = (chunk: Buffer | string): void => {
    if (stopped) return;
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    if (Buffer.byteLength(buffer, "utf8") > maxFrameBytes) return onError(new RpcMissionWorkerError("RPC_FRAME_TOO_LARGE", String(maxFrameBytes)));
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      parseLine(line);
    }
  };
  const onEnd = (): void => {
    if (stopped) return;
    buffer += decoder.end();
    if (buffer) onError(new RpcMissionWorkerError("RPC_TORN_FRAME", "stdout ended before LF terminator"));
    buffer = "";
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    if (stopped) return;
    stopped = true;
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

async function terminateOwnedProcessTree(identity: MissionWorkerIdentity, inspector: ProcessInspector, graceMs: number): Promise<boolean> {
  const pid = identity.pid;
  if (!pid) return true;
  const before = inspector.inspect(pid);
  if (!before.alive) return true;
  if (!sameStartIdentity(identity.processStartedAt, before.startedAt)) return false;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, shell: false });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
  } else {
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
    await sleep(Math.min(graceMs, 750));
    if (inspector.inspect(pid).alive) {
      try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  }
  const deadline = Date.now() + Math.max(graceMs, 1_000);
  while (Date.now() < deadline) {
    if (!inspector.inspect(pid).alive && (process.platform === "win32" || !posixProcessGroupAlive(pid))) return true;
    await sleep(50);
  }
  return !inspector.inspect(pid).alive && (process.platform === "win32" || !posixProcessGroupAlive(pid));
}

/** Verifies the detached worker process group; intentionally does not claim control of self-daemonized new groups. */
function posixProcessGroupAlive(groupId: number): boolean {
  const result = spawnSync("ps", ["-e", "-o", "pgid="], { encoding: "utf8", timeout: 5_000, shell: false });
  if (result.status !== 0) return true;
  return result.stdout.split(/\r?\n/).some((line) => Number(line.trim()) === groupId);
}

async function observeStartedProcess(inspector: ProcessInspector, pid: number): Promise<ProcessObservation> {
  const deadline = Date.now() + 5_000;
  let observation = inspector.inspect(pid);
  while (observation.alive && !observation.startedAt && Date.now() < deadline) {
    await sleep(50);
    observation = inspector.inspect(pid);
  }
  return observation;
}

function orderedRoutes(request: OpenMissionWorkerRequest): Required<MissionRoute>[] {
  if (request.resume) {
    if (!request.resume.route) throw new RpcMissionWorkerError("RPC_RESUME_ROUTE_MISSING", request.runId);
    return [request.resume.route];
  }
  const routes = [request.route, ...request.fallbacks];
  const seen = new Set<string>();
  return routes.filter((route) => {
    const key = `${route.provider}\u0000${route.model}\u0000${route.thinkingLevel}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function prepareSessionRootOutsideWorkspace(cwd: string, sessionRoot: string): string {
  const workspace = realpathSync(cwd);
  const prospective = prospectiveRealPath(sessionRoot);
  assertPathOutsideWorkspace(workspace, prospective, sessionRoot);
  mkdirSync(sessionRoot, { recursive: true });
  const runtime = realpathSync(sessionRoot);
  assertPathOutsideWorkspace(workspace, runtime, sessionRoot);
  return runtime;
}

function prospectiveRealPath(target: string): string {
  const missing: string[] = [];
  let current = path.resolve(target);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new RpcMissionWorkerError("RPC_SESSION_ROOT_INVALID", target);
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(realpathSync(current), ...missing);
}

function assertPathOutsideWorkspace(workspace: string, candidate: string, reported: string): void {
  const relative = path.relative(workspace, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new RpcMissionWorkerError("RPC_SESSION_ROOT_INSIDE_WORKSPACE", reported);
  }
}

function buildWorkerEnvironment(
  host: NodeJS.ProcessEnv,
  explicit: NodeJS.ProcessEnv,
  forwarded: string[],
  route: Required<MissionRoute>,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const names = new Set<string>([...BASE_CHILD_ENV_NAMES, ...providerCredentialEnvironmentNames(route.provider), ...forwarded]);
  for (const name of names) {
    const value = host[name];
    if (value !== undefined) result[name] = value;
  }
  for (const [name, value] of Object.entries(explicit)) {
    assertEnvironmentName(name);
    if (value === undefined) delete result[name];
    else result[name] = value;
  }
  return result;
}

function providerCredentialEnvironmentNames(provider: string): string[] {
  const normalized = provider.toLowerCase();
  if (normalized.includes("anthropic")) return ["ANTHROPIC_API_KEY"];
  if (normalized.includes("openai")) return ["OPENAI_API_KEY"];
  if (normalized.includes("deepseek")) return ["DEEPSEEK_API_KEY"];
  if (normalized.includes("google") || normalized.includes("gemini")) return ["GOOGLE_API_KEY", "GEMINI_API_KEY"];
  if (normalized.includes("zai") || normalized.includes("zhipu") || normalized.includes("bigmodel")) return ["ZAI_API_KEY", "ZHIPU_API_KEY"];
  if (normalized.includes("openrouter")) return ["OPENROUTER_API_KEY"];
  if (normalized.includes("xai")) return ["XAI_API_KEY"];
  if (normalized.includes("mistral")) return ["MISTRAL_API_KEY"];
  if (normalized.includes("groq")) return ["GROQ_API_KEY"];
  return [];
}

function assertEnvironmentName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new RpcMissionWorkerError("RPC_ENV_NAME_INVALID", value);
  return value;
}

function reserveNewSessionFile(root: string, runId: string): string {
  const stem = runId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "mission";
  for (let attempt = 0; attempt < 8; attempt++) {
    const file = path.join(root, `${stem}-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}.jsonl`);
    try {
      const fd = openSync(file, "wx", 0o600);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new RpcMissionWorkerError("RPC_SESSION_RESERVATION_FAILED", String(error));
    }
  }
  throw new RpcMissionWorkerError("RPC_SESSION_RESERVATION_FAILED", root);
}

function assertResumeSession(root: string, value: string): string {
  const resolved = assertSessionPath(root, value);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) throw new RpcMissionWorkerError("RPC_RESUME_SESSION_MISSING", resolved);
  if (lstatSync(resolved).isSymbolicLink()) throw new RpcMissionWorkerError("RPC_RESUME_SESSION_SYMLINK", resolved);
  const real = realpathSync(resolved);
  assertContainedSessionPath(root, real);
  return real;
}

function assertDurableSessionFile(root: string, value: unknown, sessionId: string, cwd: string): string {
  const resolved = assertSessionPath(root, value);
  if (!existsSync(resolved)) throw new RpcMissionWorkerError("RPC_SESSION_NOT_DURABLE", `${resolved} does not exist`);
  const lexical = lstatSync(resolved);
  if (lexical.isSymbolicLink()) throw new RpcMissionWorkerError("RPC_SESSION_SYMLINK", resolved);
  if (!lexical.isFile()) throw new RpcMissionWorkerError("RPC_SESSION_NOT_REGULAR", resolved);
  const real = realpathSync(resolved);
  assertContainedSessionPath(root, real);
  const header = readSessionHeader(real);
  if (header.type !== "session" || header.id !== sessionId) {
    throw new RpcMissionWorkerError("RPC_SESSION_HEADER_MISMATCH", `${String(header.type)}/${String(header.id)} != session/${sessionId}`);
  }
  const headerCwd = requiredString(header.cwd, "session header cwd");
  let canonicalHeaderCwd: string;
  try { canonicalHeaderCwd = realpathSync(headerCwd); }
  catch { throw new RpcMissionWorkerError("RPC_SESSION_HEADER_CWD_INVALID", headerCwd); }
  if (!sameFilePath(canonicalHeaderCwd, realpathSync(cwd))) {
    throw new RpcMissionWorkerError("RPC_SESSION_HEADER_CWD_MISMATCH", `${canonicalHeaderCwd} != ${cwd}`);
  }
  return real;
}

function assertSessionPath(root: string, value: unknown): string {
  const sessionFile = path.resolve(requiredString(value, "sessionFile"));
  assertContainedSessionPath(root, sessionFile);
  return sessionFile;
}

function assertContainedSessionPath(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new RpcMissionWorkerError("RPC_SESSION_OUTSIDE_ROOT", candidate);
  }
}

function readSessionHeader(file: string): Record<string, unknown> {
  const maximum = 256 * 1024;
  const fd = openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < maximum) {
      const chunk = Buffer.allocUnsafe(Math.min(8 * 1024, maximum - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      const value = chunk.subarray(0, count);
      const newline = value.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(value.subarray(0, newline));
        const text = Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
        try {
          const parsed = JSON.parse(text);
          const header = record(parsed);
          if (!header) throw new Error("header is not an object");
          return header;
        } catch (error) {
          throw new RpcMissionWorkerError("RPC_SESSION_HEADER_INVALID", error instanceof Error ? error.message : String(error));
        }
      }
      chunks.push(value);
      total += count;
    }
  } finally {
    closeSync(fd);
  }
  throw new RpcMissionWorkerError("RPC_SESSION_HEADER_INVALID", `missing LF-delimited header within ${maximum} bytes`);
}

function sameFilePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US") : left === right;
}

function assertRouteState(state: RpcState, route: Required<MissionRoute>): void {
  if (!state.model || state.model.provider !== route.provider || state.model.id !== route.model || state.thinkingLevel !== route.thinkingLevel) {
    throw new RpcMissionWorkerError(
      "RPC_ROUTE_MISMATCH",
      `expected ${route.provider}/${route.model}:${route.thinkingLevel}; observed ${String(state.model?.provider)}/${String(state.model?.id)}:${String(state.thinkingLevel)}`,
    );
  }
}

function sameProcessIdentity(left: MissionWorkerIdentity, right: MissionWorkerIdentity): boolean {
  return left.pid === right.pid && sameStartIdentity(left.processStartedAt, right.processStartedAt);
}

function sameStartIdentity(expected: string | undefined, observed: string | undefined): boolean {
  return Boolean(expected && observed && expected === observed);
}

function tokenTotal(stats: RpcStats): number {
  const value = stats.tokens?.total;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new RpcMissionWorkerError("RPC_FIELD_INVALID", name);
  return value;
}

function positiveMs(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new RpcMissionWorkerError("RPC_OPTION_INVALID", name);
  return value;
}

function describeExit(exit: ProcessExit | undefined): string {
  if (!exit) return "process state unavailable";
  return exit.error ? exit.error.message : `code=${String(exit.code)} signal=${String(exit.signal)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RpcMissionWorkerError extends Error {
  readonly code: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "RpcMissionWorkerError";
    this.code = code;
  }
}
