import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { acquireProcessClaimLock, releaseProcessClaimLock, type ProcessClaimLock } from "./file-lock";
import { requireProcessStartIdentity, SystemProcessInspector } from "./process";
import {
  MISSION_EVENT_VERSION,
  type MissionEvent,
  type MissionEventType,
  type MissionJournal,
  type MissionProjection,
  type MissionUsage,
  type MissionValidatorResult,
  type MissionWorkerIdentity,
  type NewMissionEvent,
  type WorkspaceEffect,
} from "./types";

const SAFE_RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const EVENT_TYPES = new Set<MissionEventType>([
  "mission.created", "mission.started", "mission.resumed", "mission.paused", "mission.outcome-unknown",
  "mission.succeeded", "mission.failed", "mission.cancelled", "lease.acquired", "lease.renewed", "lease.released",
  "workspace.snapshot", "effects.observed", "worker.started", "worker.heartbeat", "worker.cursor", "worker.event",
  "worker.settled", "worker.failed", "worker.exited", "worker.recovery-requested", "validator.pinned",
  "validator.started", "validator.completed", "repair.requested", "budget.exhausted",
]);
const TERMINAL_STATES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
const SYSTEM_PROCESS_INSPECTOR = new SystemProcessInspector();
let currentProcessStartedAt: string | undefined;

export class MissionJournalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "MissionJournalError";
    this.code = code;
  }
}

export class FileMissionJournal implements MissionJournal {
  readonly runId: string;
  readonly runDirectory: string;
  readonly eventFile: string;
  readonly projectionFile: string;
  readonly #lockFile: string;
  readonly #lockReleaseFile: string;
  readonly #lockToken: string;
  readonly #lockGeneration: number;
  readonly #clock: () => Date;
  #lockFd: number | undefined;
  #nextSeq: number;

  private constructor(options: {
    runId: string;
    runDirectory: string;
    eventFile: string;
    projectionFile: string;
    lockFile: string;
    lockReleaseFile: string;
    lockToken: string;
    lockGeneration: number;
    lockFd: number;
    nextSeq: number;
    clock: () => Date;
  }) {
    this.runId = options.runId;
    this.runDirectory = options.runDirectory;
    this.eventFile = options.eventFile;
    this.projectionFile = options.projectionFile;
    this.#lockFile = options.lockFile;
    this.#lockReleaseFile = options.lockReleaseFile;
    this.#lockToken = options.lockToken;
    this.#lockGeneration = options.lockGeneration;
    this.#lockFd = options.lockFd;
    this.#nextSeq = options.nextSeq;
    this.#clock = options.clock;
  }

  static create(root: string, runId: string, clock: () => Date = () => new Date()): FileMissionJournal {
    assertRunId(runId);
    const canonicalRoot = ensureDirectory(root);
    const runDirectory = path.join(canonicalRoot, runId);
    mkdirSync(runDirectory, { recursive: false });
    const lease = acquireJournalLock(runDirectory);
    try {
      const eventFile = path.join(runDirectory, "events.jsonl");
      const fd = openSync(eventFile, "wx", 0o600);
      fsyncSync(fd);
      closeSync(fd);
      fsyncDirectoryBestEffort(runDirectory);
      return new FileMissionJournal({
        runId,
        runDirectory,
        eventFile,
        projectionFile: path.join(runDirectory, "current.json"),
        lockFile: lease.file,
        lockReleaseFile: lease.releaseFile,
        lockToken: lease.token,
        lockGeneration: lease.generation,
        lockFd: lease.fd,
        nextSeq: 1,
        clock,
      });
    } catch (error) {
      releaseProcessClaimLock(lease);
      throw error;
    }
  }

  static open(root: string, runId: string, clock: () => Date = () => new Date()): FileMissionJournal {
    assertRunId(runId);
    const canonicalRoot = realDirectory(root);
    const runDirectory = containedExistingDirectory(path.join(canonicalRoot, runId), canonicalRoot);
    const lease = acquireJournalLock(runDirectory);
    let journal: FileMissionJournal | undefined;
    try {
      const eventFile = containedExistingFile(path.join(runDirectory, "events.jsonl"), runDirectory);
      const events = readEventFile(eventFile, runId);
      journal = new FileMissionJournal({
        runId,
        runDirectory,
        eventFile,
        projectionFile: path.join(runDirectory, "current.json"),
        lockFile: lease.file,
        lockReleaseFile: lease.releaseFile,
        lockToken: lease.token,
        lockGeneration: lease.generation,
        lockFd: lease.fd,
        nextSeq: events.length + 1,
        clock,
      });
      if (events.length) journal.#publishProjection(projectMission(events));
      return journal;
    } catch (error) {
      if (journal) journal.close();
      else releaseProcessClaimLock(lease);
      throw error;
    }
  }

  static inspect(root: string, runId: string): { events: MissionEvent[]; projection: MissionProjection } {
    assertRunId(runId);
    const canonicalRoot = realDirectory(root);
    const runDirectory = containedExistingDirectory(path.join(canonicalRoot, runId), canonicalRoot);
    const eventFile = containedExistingFile(path.join(runDirectory, "events.jsonl"), runDirectory);
    const events = readEventFileConsistent(eventFile, runId);
    if (!events.length) throw new MissionJournalError("MISSION_LOG_EMPTY", runId);
    return { events, projection: projectMission(events) };
  }

  append(event: NewMissionEvent): MissionEvent {
    this.#assertOpen();
    if (event.runId !== this.runId) throw new MissionJournalError("MISSION_RUN_ID_MISMATCH", `${event.runId} != ${this.runId}`);
    const events = readEventFile(this.eventFile, this.runId);
    if (events.length + 1 !== this.#nextSeq) {
      throw new MissionJournalError("MISSION_LOG_CHANGED", `expected ${this.#nextSeq - 1} events, found ${events.length}`);
    }
    const stored: MissionEvent = {
      version: MISSION_EVENT_VERSION,
      runId: this.runId,
      seq: this.#nextSeq,
      at: event.at ?? this.#clock().toISOString(),
      type: event.type,
      generation: event.generation,
      data: cloneRecord(event.data),
    };
    validateEvent(stored, this.#nextSeq, events.at(-1));
    // Validate the full state transition before making the append durable. An
    // invalid transition must never poison the authoritative event log.
    const nextProjection = projectMission([...events, stored]);
    const fd = openSync(this.eventFile, "a");
    try {
      writeSync(fd, `${JSON.stringify(stored)}\n`, undefined, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.#nextSeq += 1;
    this.#publishProjection(nextProjection);
    return clone(stored);
  }

  readAll(): MissionEvent[] {
    this.#assertOpen();
    const events = readEventFile(this.eventFile, this.runId);
    if (events.length + 1 !== this.#nextSeq) {
      throw new MissionJournalError("MISSION_LOG_CHANGED", `expected ${this.#nextSeq - 1} events, found ${events.length}`);
    }
    return events;
  }

  projection(): MissionProjection {
    const events = this.readAll();
    if (!events.length) throw new MissionJournalError("MISSION_LOG_EMPTY", this.runId);
    return projectMission(events);
  }

  close(): void {
    if (this.#lockFd === undefined) return;
    const fd = this.#lockFd;
    releaseProcessClaimLock({
      file: this.#lockFile,
      releaseFile: this.#lockReleaseFile,
      token: this.#lockToken,
      generation: this.#lockGeneration,
      fd,
    });
    this.#lockFd = undefined;
  }

  #publishProjection(projection: MissionProjection): void {
    writeJsonAtomic(this.projectionFile, projection);
  }

  #assertOpen(): void {
    if (this.#lockFd === undefined) throw new MissionJournalError("MISSION_JOURNAL_CLOSED", this.runId);
  }
}

export function projectMission(source: MissionEvent[]): MissionProjection {
  if (!source.length) throw new MissionJournalError("MISSION_LOG_EMPTY", "cannot project zero events");
  const events = [...source].sort((a, b) => a.seq - b.seq);
  events.forEach((event, index) => validateEvent(event, index + 1, index ? events[index - 1] : undefined));
  if (new Set(events.map((event) => event.runId)).size !== 1) throw new MissionJournalError("MISSION_RUN_ID_MIXED", "multiple run ids");
  const startedAt = events[0].at;
  const usage: MissionUsage = { turns: 0, restarts: 0, specialists: 0, tokens: 0, startedAt, elapsedMs: 0 };
  const projection: MissionProjection = {
    version: 1,
    runId: events[0].runId,
    missionHash: null,
    state: "CREATED",
    lastSeq: 0,
    generation: 1,
    worker: null,
    cursor: null,
    usage,
    effects: [],
    baselineSnapshotDigest: null,
    latestSnapshotDigest: null,
    validator: null,
    nextAction: "start-worker",
  };
  let terminal: MissionProjection["state"] | undefined;

  for (const event of events) {
    projection.lastSeq = event.seq;
    projection.generation = Math.max(projection.generation, event.generation);
    projection.usage.elapsedMs = Math.max(0, Date.parse(event.at) - Date.parse(startedAt));
    if (event.type === "mission.created") {
      if (typeof event.data.missionHash !== "string" || event.data.missionHash.length !== 64) {
        throw new MissionJournalError("MISSION_HASH_MISSING", "mission.created requires missionHash");
      }
      if (projection.missionHash && projection.missionHash !== event.data.missionHash) {
        throw new MissionJournalError("MISSION_HASH_CONFLICT", "multiple mission hashes");
      }
      projection.missionHash = event.data.missionHash;
      projection.state = "CREATED";
      projection.nextAction = "start-worker";
    } else if (event.type === "mission.started") {
      assertNotTerminal(terminal, event.type);
      projection.state = "RUNNING";
      projection.nextAction = "start-worker";
    } else if (event.type === "mission.resumed") {
      assertNotTerminal(terminal, event.type);
      projection.state = "RUNNING";
      projection.usage.restarts += 1;
      projection.nextAction = projection.worker ? "resume-worker" : "start-worker";
    } else if (event.type === "worker.started") {
      assertNotTerminal(terminal, event.type);
      projection.worker = requireWorkerIdentity(event.data.identity);
      projection.cursor = projection.worker.cursor;
      projection.state = "WAITING_FOR_WORKER";
      projection.nextAction = "wait-worker";
    } else if (event.type === "worker.cursor") {
      const cursor = event.data.cursor;
      if (typeof cursor !== "string" || !cursor) throw new MissionJournalError("MISSION_CURSOR_INVALID", String(cursor));
      projection.cursor = cursor;
      if (projection.worker) projection.worker = { ...projection.worker, cursor };
    } else if (event.type === "worker.settled") {
      assertNotTerminal(terminal, event.type);
      projection.state = "VALIDATING";
      projection.nextAction = "validate";
      projection.usage.turns += 1;
      if (typeof event.data.cursor === "string" && event.data.cursor) {
        projection.cursor = event.data.cursor;
        if (projection.worker) projection.worker = { ...projection.worker, cursor: event.data.cursor };
      }
      if (Number.isInteger(event.data.tokens) && (event.data.tokens as number) >= 0) projection.usage.tokens += event.data.tokens as number;
    } else if (event.type === "worker.failed") {
      assertNotTerminal(terminal, event.type);
      projection.state = "PAUSED";
      projection.reason = textOrUndefined(event.data.message);
      projection.nextAction = event.data.recoverable === true ? "resume-worker" : "inspect-outcome";
    } else if (event.type === "worker.exited") {
      if (!terminal) {
        projection.state = "PAUSED";
        projection.reason = textOrUndefined(event.data.reason) ?? "worker exited";
        projection.nextAction = projection.worker?.sessionFile ? "resume-worker" : "inspect-outcome";
      }
    } else if (event.type === "validator.started") {
      assertNotTerminal(terminal, event.type);
      projection.state = "VALIDATING";
      projection.nextAction = "validate";
    } else if (event.type === "validator.completed") {
      assertNotTerminal(terminal, event.type);
      projection.validator = requireValidatorResult(event.data.result);
      if (projection.validator.status === "pass") {
        projection.state = "VALIDATING";
        projection.nextAction = "none";
      } else {
        projection.state = "REPAIRING";
        projection.nextAction = "repair";
        projection.reason = projection.validator.timedOut ? "validator timed out" : `validator ${projection.validator.status}`;
      }
    } else if (event.type === "repair.requested" || event.type === "worker.recovery-requested") {
      assertNotTerminal(terminal, event.type);
      projection.state = "REPAIRING";
      projection.nextAction = "wait-worker";
    } else if (event.type === "workspace.snapshot") {
      const digest = event.data.digest;
      if (typeof digest !== "string" || digest.length !== 64) throw new MissionJournalError("MISSION_SNAPSHOT_INVALID", String(digest));
      if (event.data.role === "baseline") projection.baselineSnapshotDigest = digest;
      projection.latestSnapshotDigest = digest;
    } else if (event.type === "effects.observed") {
      for (const effect of requireEffects(event.data.effects)) addEffect(projection.effects, effect);
    } else if (event.type === "mission.paused") {
      assertNotTerminal(terminal, event.type);
      projection.state = "PAUSED";
      projection.reason = textOrUndefined(event.data.reason);
      projection.nextAction = normalizeNextAction(event.data.nextAction);
    } else if (event.type === "mission.outcome-unknown") {
      assertNotTerminal(terminal, event.type);
      projection.state = "OUTCOME_UNKNOWN";
      projection.reason = textOrUndefined(event.data.reason);
      projection.nextAction = "inspect-outcome";
    } else if (event.type === "budget.exhausted") {
      assertNotTerminal(terminal, event.type);
      projection.state = "FAILED";
      projection.reason = textOrUndefined(event.data.reason) ?? "budget exhausted";
      projection.nextAction = "none";
      terminal = "FAILED";
    } else if (event.type === "mission.succeeded" || event.type === "mission.failed" || event.type === "mission.cancelled") {
      const next = event.type === "mission.succeeded" ? "SUCCEEDED" : event.type === "mission.failed" ? "FAILED" : "CANCELLED";
      if (terminal && terminal !== next) throw new MissionJournalError("MISSION_TERMINAL_CONFLICT", `${terminal} vs ${next}`);
      terminal = next;
      projection.state = next;
      projection.reason = textOrUndefined(event.data.reason);
      projection.nextAction = "none";
    }
  }
  if (!projection.missionHash) throw new MissionJournalError("MISSION_HASH_MISSING", "no mission.created event");
  return clone(projection);
}

function readEventFileConsistent(file: string, runId: string): MissionEvent[] {
  let lastTorn: MissionJournalError | undefined;
  for (let attempt = 0; attempt < 6; attempt++) {
    try { return readEventFile(file, runId); }
    catch (error) {
      if (!(error instanceof MissionJournalError) || error.code !== "MISSION_LOG_TORN") throw error;
      lastTorn = error;
      if (attempt < 5) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  throw lastTorn!;
}

function readEventFile(file: string, runId: string): MissionEvent[] {
  const text = readFileSync(file, "utf8");
  if (!text) return [];
  if (!text.endsWith("\n")) throw new MissionJournalError("MISSION_LOG_TORN", file);
  return text.slice(0, -1).split("\n").map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new MissionJournalError("MISSION_EVENT_MALFORMED", `line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    validateEvent(value, index + 1, undefined);
    const event = value as MissionEvent;
    if (event.runId !== runId) throw new MissionJournalError("MISSION_RUN_ID_MISMATCH", `line ${index + 1}`);
    return clone(event);
  });
}

function validateEvent(value: unknown, expectedSeq: number, previous?: MissionEvent): asserts value is MissionEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MissionJournalError("MISSION_EVENT_INVALID", "not an object");
  const event = value as Partial<MissionEvent>;
  if (event.version !== MISSION_EVENT_VERSION || !SAFE_RUN_ID.test(String(event.runId ?? ""))) throw new MissionJournalError("MISSION_EVENT_INVALID", "version/runId");
  if (event.seq !== expectedSeq) throw new MissionJournalError("MISSION_SEQUENCE_INVALID", `expected ${expectedSeq}, got ${String(event.seq)}`);
  if (typeof event.at !== "string" || Number.isNaN(Date.parse(event.at))) throw new MissionJournalError("MISSION_EVENT_INVALID", "timestamp");
  if (typeof event.type !== "string" || !EVENT_TYPES.has(event.type as MissionEventType)) throw new MissionJournalError("MISSION_EVENT_INVALID", `type ${String(event.type)}`);
  if (!Number.isInteger(event.generation) || (event.generation as number) < 1) throw new MissionJournalError("MISSION_EVENT_INVALID", "generation");
  if (previous && (event.generation as number) < previous.generation) throw new MissionJournalError("MISSION_GENERATION_REGRESSION", `${event.generation} < ${previous.generation}`);
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) throw new MissionJournalError("MISSION_EVENT_INVALID", "data");
}

function acquireJournalLock(runDirectory: string): ProcessClaimLock {
  return acquireProcessClaimLock({
    directory: path.join(runDirectory, "supervisor-lock-claims"),
    prefix: "supervisor",
    processInspector: SYSTEM_PROCESS_INSPECTOR,
    processStartedAt: currentProcessStartedAt ??= requireProcessStartIdentity(SYSTEM_PROCESS_INSPECTOR, process.pid, "mission journal supervisor"),
    busy: () => new MissionJournalError("MISSION_ALREADY_OPEN", runDirectory),
  });
}

function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  fsyncDirectoryBestEffort(path.dirname(file));
}

function ensureDirectory(root: string): string {
  const absolute = path.resolve(root);
  mkdirSync(absolute, { recursive: true });
  return realpathSync(absolute);
}

function realDirectory(root: string): string {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new MissionJournalError("MISSION_ROOT_MISSING", path.resolve(root));
  return realpathSync(root);
}

function containedExistingDirectory(candidate: string, root: string): string {
  const canonical = realpathSync(candidate);
  assertContained(canonical, root);
  if (!statSync(canonical).isDirectory()) throw new MissionJournalError("MISSION_PATH_INVALID", canonical);
  return canonical;
}

function containedExistingFile(candidate: string, root: string): string {
  const canonical = realpathSync(candidate);
  assertContained(canonical, root);
  if (!statSync(canonical).isFile()) throw new MissionJournalError("MISSION_PATH_INVALID", canonical);
  return canonical;
}

function assertContained(candidate: string, root: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new MissionJournalError("MISSION_PATH_ESCAPE", candidate);
  }
}

function fsyncDirectoryBestEffort(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!(code === "EACCES" || code === "EPERM" || code === "EINVAL" || code === "EISDIR")) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) throw new MissionJournalError("MISSION_RUN_ID_INVALID", JSON.stringify(runId));
}

function assertNotTerminal(terminal: MissionProjection["state"] | undefined, type: string): void {
  if (terminal && TERMINAL_STATES.has(terminal)) throw new MissionJournalError("MISSION_EVENT_AFTER_TERMINAL", `${type} after ${terminal}`);
}

function requireWorkerIdentity(value: unknown): MissionWorkerIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MissionJournalError("MISSION_WORKER_INVALID", "identity missing");
  const item = value as Partial<MissionWorkerIdentity> & Record<string, unknown>;
  const allowed = new Set(["adapter", "workerId", "pid", "processStartedAt", "sessionId", "sessionFile", "cursor", "generation", "route"]);
  if (Object.keys(item).some((key) => !allowed.has(key))
    || !validIdentityText(item.adapter) || !validIdentityText(item.workerId)
    || !(item.pid === null || (Number.isSafeInteger(item.pid) && (item.pid as number) > 0))
    || !validIdentityText(item.sessionId) || !validIdentityText(item.sessionFile)
    || !(item.cursor === null || validIdentityText(item.cursor)) || !Number.isSafeInteger(item.generation) || (item.generation as number) < 1
    || (item.processStartedAt !== undefined && (typeof item.processStartedAt !== "string" || Number.isNaN(Date.parse(item.processStartedAt))))) {
    throw new MissionJournalError("MISSION_WORKER_INVALID", "identity fields");
  }
  const routeValue = item.route as Record<string, unknown> | undefined;
  let route: MissionWorkerIdentity["route"];
  if (routeValue !== undefined) {
    const routeKeys = new Set(["provider", "model", "thinkingLevel"]);
    const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    if (!routeValue || typeof routeValue !== "object" || Array.isArray(routeValue)
      || Object.keys(routeValue).some((key) => !routeKeys.has(key))
      || !validIdentityText(routeValue.provider) || !validIdentityText(routeValue.model)
      || typeof routeValue.thinkingLevel !== "string" || !levels.has(routeValue.thinkingLevel)) {
      throw new MissionJournalError("MISSION_WORKER_INVALID", "route fields");
    }
    route = {
      provider: routeValue.provider,
      model: routeValue.model,
      thinkingLevel: routeValue.thinkingLevel as NonNullable<MissionWorkerIdentity["route"]>["thinkingLevel"],
    };
  }
  return {
    adapter: item.adapter,
    workerId: item.workerId,
    pid: item.pid,
    ...(item.processStartedAt ? { processStartedAt: item.processStartedAt } : {}),
    sessionId: item.sessionId,
    sessionFile: item.sessionFile,
    cursor: item.cursor,
    generation: item.generation,
    ...(route ? { route } : {}),
  } as MissionWorkerIdentity;
}

function validIdentityText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768 && !value.includes("\0");
}

function requireValidatorResult(value: unknown): MissionValidatorResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MissionJournalError("MISSION_VALIDATOR_RESULT_INVALID", "missing result");
  const item = value as MissionValidatorResult;
  if (!(item.status === "pass" || item.status === "fail" || item.status === "error") || !(item.exitCode === null || Number.isInteger(item.exitCode))
    || typeof item.timedOut !== "boolean" || typeof item.durationMs !== "number" || typeof item.stdout !== "string" || typeof item.stderr !== "string"
    || typeof item.outputTruncated !== "boolean" || typeof item.validatorSha256 !== "string") {
    throw new MissionJournalError("MISSION_VALIDATOR_RESULT_INVALID", "invalid fields");
  }
  return clone(item);
}

function requireEffects(value: unknown): WorkspaceEffect[] {
  if (!Array.isArray(value)) throw new MissionJournalError("MISSION_EFFECTS_INVALID", "effects must be array");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new MissionJournalError("MISSION_EFFECTS_INVALID", "effect object");
    const effect = item as WorkspaceEffect;
    if (typeof effect.path !== "string" || !(effect.kind === "created" || effect.kind === "modified" || effect.kind === "deleted")) {
      throw new MissionJournalError("MISSION_EFFECTS_INVALID", "effect fields");
    }
    return { path: effect.path, kind: effect.kind };
  });
}

function addEffect(target: WorkspaceEffect[], effect: WorkspaceEffect): void {
  const key = `${effect.path}\0${effect.kind}`;
  if (!target.some((item) => `${item.path}\0${item.kind}` === key)) target.push(effect);
  target.sort((a, b) => `${a.path}\0${a.kind}`.localeCompare(`${b.path}\0${b.kind}`));
}

function normalizeNextAction(value: unknown): MissionProjection["nextAction"] {
  const allowed = new Set<MissionProjection["nextAction"]>(["start-worker", "wait-worker", "resume-worker", "validate", "repair", "inspect-outcome", "none"]);
  return typeof value === "string" && allowed.has(value as MissionProjection["nextAction"])
    ? value as MissionProjection["nextAction"]
    : "none";
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return clone(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
