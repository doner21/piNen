import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

import type {
  EffectRecord,
  EventStore,
  FailureCategory,
  JsonValue,
  NewRunEvent,
  ProjectedPhaseState,
  RunEvent,
  RunProjection,
  WorkspaceBinding,
} from "./types";

const SAFE_RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const PHASE_STATUS_RANK: Record<ProjectedPhaseState["status"], number> = {
  pending: 0,
  ready: 1,
  running: 2,
  waiting: 3,
  retrying: 3,
  succeeded: 5,
  failed: 5,
  "outcome-unknown": 5,
  cancelled: 5,
};

export class EventStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "EventStoreError";
    this.code = code;
  }
}

export class MemoryEventStore implements EventStore {
  readonly runId: string;
  readonly #events: RunEvent[] = [];
  readonly #clock: () => Date;

  constructor(runId: string, clock: () => Date = () => new Date()) {
    assertRunId(runId);
    this.runId = runId;
    this.#clock = clock;
  }

  append(event: NewRunEvent): RunEvent {
    assertEventRunId(event, this.runId);
    const stored: RunEvent = {
      version: 1,
      runId: this.runId,
      seq: this.#events.length + 1,
      at: event.at ?? this.#clock().toISOString(),
      type: event.type,
      ...(event.phaseId ? { phaseId: event.phaseId } : {}),
      ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
      data: cloneRecord(event.data),
    };
    validateEvent(stored, stored.seq);
    this.#events.push(stored);
    return cloneEvent(stored);
  }

  readAll(): RunEvent[] {
    return this.#events.map(cloneEvent);
  }
}

/**
 * Durable single-writer JSONL store. Each append is one complete line followed
 * by fsync. The kernel is the sole writer; readers reject torn or out-of-order
 * logs rather than guessing around them.
 */
export class FileEventStore implements EventStore {
  readonly runId: string;
  readonly filePath: string;
  readonly #clock: () => Date;
  readonly #lockPath: string;
  #lockFd: number | undefined;
  #nextSeq: number;

  private constructor(runId: string, filePath: string, nextSeq: number, clock: () => Date, lockPath: string, lockFd: number) {
    this.runId = runId;
    this.filePath = filePath;
    this.#nextSeq = nextSeq;
    this.#clock = clock;
    this.#lockPath = lockPath;
    this.#lockFd = lockFd;
  }

  static create(root: string, runId: string, clock: () => Date = () => new Date()): FileEventStore {
    assertRunId(runId);
    const canonicalRoot = ensureRoot(root);
    const runDirectory = path.join(canonicalRoot, runId);
    mkdirSync(runDirectory, { recursive: false });
    fsyncDirectoryBestEffort(canonicalRoot);
    const { lockPath, lockFd } = acquireWriterLease(runDirectory);
    try {
      const filePath = path.join(runDirectory, "events.jsonl");
      const fd = openSync(filePath, "wx");
      fsyncSync(fd);
      closeSync(fd);
      fsyncDirectoryBestEffort(runDirectory);
      return new FileEventStore(runId, filePath, 1, clock, lockPath, lockFd);
    } catch (error) {
      releaseWriterLease(lockPath, lockFd);
      throw error;
    }
  }

  static read(root: string, runId: string): { filePath: string; events: RunEvent[] } {
    assertRunId(runId);
    const canonicalRoot = realpathExistingDirectory(root);
    const runDirectory = assertContainedExisting(path.join(canonicalRoot, runId), canonicalRoot);
    const filePath = assertContainedExisting(path.join(runDirectory, "events.jsonl"), runDirectory);
    if (!statSync(filePath).isFile()) throw new EventStoreError("EVENT_LOG_NOT_FILE", filePath);
    return { filePath, events: readEventFile(filePath, runId) };
  }

  static open(root: string, runId: string, clock: () => Date = () => new Date()): FileEventStore {
    assertRunId(runId);
    const canonicalRoot = realpathExistingDirectory(root);
    const runDirectory = assertContainedExisting(path.join(canonicalRoot, runId), canonicalRoot);
    const filePath = assertContainedExisting(path.join(runDirectory, "events.jsonl"), runDirectory);
    if (!statSync(filePath).isFile()) throw new EventStoreError("EVENT_LOG_NOT_FILE", filePath);
    const { lockPath, lockFd } = acquireWriterLease(runDirectory);
    try {
      const events = readEventFile(filePath, runId);
      return new FileEventStore(runId, filePath, events.length + 1, clock, lockPath, lockFd);
    } catch (error) {
      releaseWriterLease(lockPath, lockFd);
      throw error;
    }
  }

  append(event: NewRunEvent): RunEvent {
    this.#assertOpen();
    assertEventRunId(event, this.runId);
    const current = readEventFile(this.filePath, this.runId);
    if (current.length + 1 !== this.#nextSeq) {
      throw new EventStoreError("EVENT_LOG_CHANGED_EXTERNALLY", `expected ${this.#nextSeq - 1} events, found ${current.length}`);
    }
    const stored: RunEvent = {
      version: 1,
      runId: this.runId,
      seq: this.#nextSeq,
      at: event.at ?? this.#clock().toISOString(),
      type: event.type,
      ...(event.phaseId ? { phaseId: event.phaseId } : {}),
      ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
      data: cloneRecord(event.data),
    };
    validateEvent(stored, this.#nextSeq);
    const line = `${JSON.stringify(stored)}\n`;
    const fd = openSync(this.filePath, "a");
    try {
      writeSync(fd, line, undefined, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.#nextSeq += 1;
    return cloneEvent(stored);
  }

  readAll(): RunEvent[] {
    this.#assertOpen();
    const events = readEventFile(this.filePath, this.runId);
    if (events.length + 1 !== this.#nextSeq) {
      throw new EventStoreError("EVENT_LOG_CHANGED_EXTERNALLY", `expected ${this.#nextSeq - 1} events, found ${events.length}`);
    }
    return events;
  }

  close(): void {
    if (this.#lockFd === undefined) return;
    const fd = this.#lockFd;
    this.#lockFd = undefined;
    releaseWriterLease(this.#lockPath, fd);
  }

  #assertOpen(): void {
    if (this.#lockFd === undefined) throw new EventStoreError("EVENT_STORE_CLOSED", this.runId);
  }
}

export function projectRun(events: RunEvent[]): RunProjection {
  if (!events.length) throw new EventStoreError("EMPTY_EVENT_LOG", "cannot project an empty event log");
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const runIds = new Set(ordered.map((event) => event.runId));
  if (runIds.size !== 1) throw new EventStoreError("MIXED_RUN_IDS", "event projection contains multiple run ids");
  ordered.forEach((event, index) => validateEvent(event, index + 1));
  const projection: RunProjection = {
    runId: ordered[0].runId,
    status: "created",
    phases: {},
    lastSeq: 0,
  };
  let runTerminal: RunProjection["status"] | undefined;

  for (const event of ordered) {
    projection.lastSeq = Math.max(projection.lastSeq, event.seq);
    if (event.type === "workflow.compiled" && typeof event.data.workflowHash === "string") projection.workflowHash = event.data.workflowHash;
    if (event.type === "run.resumed" && !runTerminal) projection.status = "running";
    if (event.type === "run.paused" && !runTerminal) projection.status = "paused";
    if (event.type === "workspace.prepared") {
      const phase = ensurePhase(projection, event);
      if (isWorkspaceBinding(event.data.binding)) phase.workspace = cloneWorkspaceBinding(event.data.binding);
    }
    if (event.type === "phase.ready") updatePhase(projection, event, "ready");
    if (event.type === "phase.attempt.started" || event.type === "worker.started") updatePhase(projection, event, "running");
    if (event.type === "phase.waiting") updatePhase(projection, event, "waiting");
    if (event.type === "phase.retry.scheduled") updatePhase(projection, event, "retrying");
    if (event.type === "effect.observed") {
      const phase = ensurePhase(projection, event);
      const effect = event.data.effect as EffectRecord | undefined;
      if (effect && typeof effect.path === "string") {
        phase.effects.status = "observed";
        const key = `${effect.kind}\0${effect.path}`;
        const seen = new Set(phase.effects.mutations.map((item) => `${item.kind}\0${item.path}`));
        if (!seen.has(key)) phase.effects.mutations.push({ path: effect.path, kind: effect.kind });
        phase.effects.mutations.sort((a, b) => `${a.path}\0${a.kind}`.localeCompare(`${b.path}\0${b.kind}`));
      }
    }
    if (event.type === "worker.result.validated") {
      const phase = ensurePhase(projection, event);
      if (event.data.output !== undefined) phase.output = cloneJson(event.data.output as JsonValue);
    }
    if (event.type === "phase.succeeded") updatePhase(projection, event, "succeeded");
    if (event.type === "phase.failed" || event.type === "phase.semantic.failed") updatePhase(projection, event, "failed");
    if (event.type === "phase.outcome.unknown") updatePhase(projection, event, "outcome-unknown");
    const nextTerminal = event.type === "run.completed"
      ? "succeeded"
      : event.type === "run.failed"
        ? "failed"
        : event.type === "run.cancelled"
          ? "cancelled"
          : undefined;
    if (nextTerminal) {
      if (runTerminal && runTerminal !== nextTerminal) {
        throw new EventStoreError("CONFLICTING_RUN_TERMINALS", `run has both ${runTerminal} and ${nextTerminal}`);
      }
      runTerminal = nextTerminal;
      projection.status = nextTerminal;
    }
  }
  if (!runTerminal && projection.status !== "paused" && Object.values(projection.phases).some((phase) => phase.status !== "pending")) projection.status = "running";
  return projection;
}

function updatePhase(projection: RunProjection, event: RunEvent, status: ProjectedPhaseState["status"]): void {
  const phase = ensurePhase(projection, event);
  phase.attempts = Math.max(phase.attempts, event.attempt ?? 0);
  const currentTerminal = PHASE_STATUS_RANK[phase.status] === 5;
  const nextTerminal = PHASE_STATUS_RANK[status] === 5;
  if (currentTerminal && nextTerminal && phase.status !== status) {
    throw new EventStoreError("CONFLICTING_PHASE_TERMINALS", `phase ${phase.id} has both ${phase.status} and ${status}`);
  }
  if (PHASE_STATUS_RANK[status] >= PHASE_STATUS_RANK[phase.status]) phase.status = status;
  if (typeof event.data.category === "string") phase.category = event.data.category as FailureCategory;
  if (event.data.output !== undefined) phase.output = cloneJson(event.data.output as JsonValue);
  const effectStatus = event.data.effectStatus;
  if (effectStatus === "unsupported" && phase.effects.status === "none") phase.effects.status = "unsupported";
}

function ensurePhase(projection: RunProjection, event: RunEvent): ProjectedPhaseState {
  if (!event.phaseId) throw new EventStoreError("MISSING_PHASE_ID", `${event.type} requires phaseId`);
  return projection.phases[event.phaseId] ??= {
    id: event.phaseId,
    status: "pending",
    attempts: 0,
    effects: { status: "none", mutations: [] },
  };
}

function isWorkspaceBinding(value: unknown): value is WorkspaceBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Partial<WorkspaceBinding>;
  return (binding.mode === "shared" || binding.mode === "isolated")
    && typeof binding.root === "string"
    && typeof binding.productRoot === "string"
    && typeof binding.phaseId === "string"
    && Number.isInteger(binding.attempt);
}

function cloneWorkspaceBinding(binding: WorkspaceBinding): WorkspaceBinding {
  return JSON.parse(JSON.stringify(binding)) as WorkspaceBinding;
}

function readEventFile(filePath: string, runId: string): RunEvent[] {
  const text = readFileSync(filePath, "utf8");
  if (!text) return [];
  if (!text.endsWith("\n")) throw new EventStoreError("TORN_EVENT_LOG", "event log does not end with a complete newline");
  const lines = text.slice(0, -1).split("\n");
  return lines.map((line, index) => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new EventStoreError("MALFORMED_EVENT", `line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    validateEvent(event, index + 1);
    if ((event as RunEvent).runId !== runId) throw new EventStoreError("EVENT_RUN_ID_MISMATCH", `line ${index + 1}`);
    return cloneEvent(event as RunEvent);
  });
}

function validateEvent(value: unknown, expectedSeq?: number): asserts value is RunEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EventStoreError("INVALID_EVENT", "event must be an object");
  const event = value as Partial<RunEvent>;
  if (event.version !== 1 || !SAFE_RUN_ID.test(String(event.runId ?? "")) || !Number.isInteger(event.seq) || (event.seq ?? 0) < 1) {
    throw new EventStoreError("INVALID_EVENT", "invalid version, runId, or sequence");
  }
  if (expectedSeq !== undefined && event.seq !== expectedSeq) throw new EventStoreError("EVENT_SEQUENCE_GAP", `expected ${expectedSeq}, got ${String(event.seq)}`);
  if (typeof event.at !== "string" || Number.isNaN(Date.parse(event.at))) throw new EventStoreError("INVALID_EVENT", "invalid timestamp");
  if (typeof event.type !== "string" || !event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
    throw new EventStoreError("INVALID_EVENT", "invalid type or data");
  }
  if (event.attempt !== undefined && (!Number.isInteger(event.attempt) || event.attempt < 1)) throw new EventStoreError("INVALID_EVENT", "attempt must be a positive integer");
}

function ensureRoot(root: string): string {
  const absolute = path.resolve(root);
  mkdirSync(absolute, { recursive: true });
  return realpathSync(absolute);
}

function realpathExistingDirectory(root: string): string {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new EventStoreError("EVENT_ROOT_MISSING", path.resolve(root));
  return realpathSync(root);
}

function assertContainedExisting(candidate: string, root: string): string {
  const canonical = realpathSync(candidate);
  const relative = path.relative(root, canonical);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new EventStoreError("EVENT_PATH_ESCAPE", canonical);
  }
  return canonical;
}

function acquireWriterLease(runDirectory: string): { lockPath: string; lockFd: number } {
  const lockPath = path.join(runDirectory, "writer.lock");
  let lockFd: number;
  try {
    lockFd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!breakDeadWriterLease(lockPath)) {
      throw new EventStoreError("RUN_ALREADY_OPEN", `an exclusive live writer lease already exists for ${runDirectory}`);
    }
    try {
      lockFd = openSync(lockPath, "wx", 0o600);
    } catch (retryError) {
      throw new EventStoreError("RUN_ALREADY_OPEN", `writer lease recovery raced for ${runDirectory}: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
    }
  }
  try {
    writeSync(lockFd, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, undefined, "utf8");
    fsyncSync(lockFd);
    fsyncDirectoryBestEffort(runDirectory);
    return { lockPath, lockFd };
  } catch (error) {
    releaseWriterLease(lockPath, lockFd);
    throw error;
  }
}

function breakDeadWriterLease(lockPath: string): boolean {
  let pid: number;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
    if (!Number.isInteger(parsed.pid) || (parsed.pid as number) < 1) return false;
    pid = parsed.pid as number;
  } catch {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return false;
    if (code !== "ESRCH") return false;
  }
  try {
    unlinkSync(lockPath);
    fsyncDirectoryBestEffort(path.dirname(lockPath));
    return true;
  } catch {
    return false;
  }
}

function releaseWriterLease(lockPath: string, lockFd: number): void {
  try {
    closeSync(lockFd);
  } finally {
    try {
      unlinkSync(lockPath);
      fsyncDirectoryBestEffort(path.dirname(lockPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function fsyncDirectoryBestEffort(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch (error) {
    // Windows commonly refuses directory handles through fs.open. File fsync
    // and the writer lease remain authoritative; directory fsync is best-effort.
    const code = (error as NodeJS.ErrnoException).code;
    if (!(["EACCES", "EPERM", "EINVAL", "EISDIR"] as Array<string | undefined>).includes(code)) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) throw new EventStoreError("INVALID_RUN_ID", JSON.stringify(runId));
}

function assertEventRunId(event: NewRunEvent, runId: string): void {
  if (event.runId !== runId) throw new EventStoreError("EVENT_RUN_ID_MISMATCH", `expected ${runId}, got ${event.runId}`);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function cloneEvent(event: RunEvent): RunEvent {
  return JSON.parse(JSON.stringify(event)) as RunEvent;
}
