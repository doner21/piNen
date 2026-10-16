import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeSync } from "node:fs";
import path from "node:path";

import type { MissionValidatorResult, NodeWorkspaceValidatorSpec } from "./types";

export interface PinnedNodeValidator {
  version: 1;
  sourceFile: string;
  pinnedFile: string;
  metadataFile: string;
  sha256: string;
  bytes: Buffer;
  spec: NodeWorkspaceValidatorSpec;
}

export class MissionValidatorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "MissionValidatorError";
    this.code = code;
  }
}

export function pinNodeWorkspaceValidator(
  workspaceRoot: string,
  runDirectory: string,
  spec: NodeWorkspaceValidatorSpec,
  resume = false,
): PinnedNodeValidator {
  const workspace = realpathSync(path.resolve(workspaceRoot));
  const hostInputs = path.join(path.resolve(runDirectory), "host-inputs");
  const pinnedFile = path.join(hostInputs, "validator.cjs");
  const metadataFile = path.join(hostInputs, "validator.json");
  if (resume) {
    if (!existsSync(pinnedFile) || !existsSync(metadataFile)) throw new MissionValidatorError("MISSION_VALIDATOR_PIN_MISSING", hostInputs);
    assertRegularNonSymlink(pinnedFile);
    assertRegularNonSymlink(metadataFile);
    const bytes = readFileSync(pinnedFile);
    const metadata = JSON.parse(readFileSync(metadataFile, "utf8")) as { version?: unknown; sha256?: unknown; spec?: unknown; source?: unknown };
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (metadata.version !== 1 || metadata.sha256 !== sha256 || JSON.stringify(metadata.spec) !== JSON.stringify(spec)) {
      throw new MissionValidatorError("MISSION_VALIDATOR_PIN_DRIFT", metadataFile);
    }
    return { version: 1, sourceFile: String(metadata.source ?? spec.script), pinnedFile: realpathSync(pinnedFile), metadataFile: realpathSync(metadataFile), sha256, bytes, spec };
  }

  if (existsSync(hostInputs)) throw new MissionValidatorError("MISSION_VALIDATOR_PIN_EXISTS", hostInputs);
  const sourceFile = path.resolve(workspace, spec.script);
  if (!existsSync(sourceFile)) throw new MissionValidatorError("MISSION_VALIDATOR_SOURCE_MISSING", sourceFile);
  const canonicalSource = realpathSync(sourceFile);
  assertContained(canonicalSource, workspace);
  assertRegularNonSymlink(sourceFile);
  const bytes = readFileSync(canonicalSource);
  if (bytes.length > 1024 * 1024) throw new MissionValidatorError("MISSION_VALIDATOR_SOURCE_TOO_LARGE", `${bytes.length}`);
  mkdirSync(hostInputs, { recursive: false });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  writeAtomic(pinnedFile, bytes);
  writeAtomic(metadataFile, Buffer.from(`${JSON.stringify({ version: 1, sha256, source: spec.script, spec }, null, 2)}\n`, "utf8"));
  return { version: 1, sourceFile: canonicalSource, pinnedFile: realpathSync(pinnedFile), metadataFile: realpathSync(metadataFile), sha256, bytes: Buffer.from(bytes), spec };
}

export async function runPinnedNodeValidator(
  pinned: PinnedNodeValidator,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<MissionValidatorResult> {
  const cwd = realpathSync(path.resolve(workspaceRoot));
  const started = performance.now();
  const child = spawn(process.execPath, ["-"], {
    cwd,
    env: validatorEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let outputTruncated = false;
  let timedOut = false;
  let aborted = false;
  let spawnError: Error | undefined;
  const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
    const remaining = pinned.spec.maxOutputBytes - current.length;
    if (remaining <= 0) {
      outputTruncated = true;
      return current;
    }
    if (chunk.length > remaining) outputTruncated = true;
    return Buffer.concat([current, chunk.subarray(0, remaining)]);
  };
  child.stdout?.on("data", (chunk: Buffer<ArrayBufferLike>) => { stdout = append(stdout, chunk); });
  child.stderr?.on("data", (chunk: Buffer<ArrayBufferLike>) => { stderr = append(stderr, chunk); });
  child.once("error", (error) => { spawnError = error; });

  const terminate = async (): Promise<void> => {
    if (!child.pid || child.exitCode !== null) return;
    await terminateProcessTree(child.pid);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    void terminate();
  }, pinned.spec.timeoutMs);
  const onAbort = (): void => {
    aborted = true;
    void terminate();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    child.stdin?.end(pinned.bytes);
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, childSignal) => resolve({ code, signal: childSignal }));
    });
    const durationMs = Math.round((performance.now() - started) * 10) / 10;
    const status = spawnError || timedOut || aborted ? "error" : exit.code === 0 ? "pass" : "fail";
    const suffix = outputTruncated ? `\n[output truncated at ${pinned.spec.maxOutputBytes} bytes]` : "";
    return {
      status,
      exitCode: exit.code,
      timedOut,
      durationMs,
      stdout: `${stdout.toString("utf8")}${suffix}`,
      stderr: `${stderr.toString("utf8")}${spawnError ? `\n${spawnError.message}` : ""}${aborted ? "\nvalidator aborted" : ""}`,
      outputTruncated,
      validatorSha256: pinned.sha256,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function validatorEnvironment(): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = { DMS_VALIDATOR: "1", NODE_ENV: "test" };
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "Path", "HOME", "USERPROFILE"]) {
    if (process.env[key]) output[key] = process.env[key];
  }
  return output;
}

async function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, shell: false });
      killer.once("close", () => resolve());
      killer.once("error", () => {
        try { process.kill(pid, "SIGKILL"); } catch {}
        resolve();
      });
    });
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch {}
  await new Promise((resolve) => setTimeout(resolve, 250));
  try { process.kill(pid, "SIGKILL"); } catch {}
}

function assertRegularNonSymlink(file: string): void {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new MissionValidatorError("MISSION_VALIDATOR_SOURCE_UNSAFE", file);
}

function assertContained(candidate: string, root: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new MissionValidatorError("MISSION_VALIDATOR_PATH_ESCAPE", candidate);
  }
}

function writeAtomic(file: string, bytes: Buffer): void {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
}
