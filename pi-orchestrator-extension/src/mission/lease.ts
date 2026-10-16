import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeSync } from "node:fs";
import path from "node:path";

import { computeWorkspaceFingerprint } from "./contract";
import { acquireProcessClaimLock, releaseProcessClaimLock, type ProcessClaimLock } from "./file-lock";
import { requireProcessStartIdentity, SystemProcessInspector } from "./process";
import type {
  ProcessInspector,
  ProcessObservation,
  WorkspaceLeaseHandle,
  WorkspaceLeaseRecord,
} from "./types";

const DEFAULT_TTL_MS = 30_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 10 * 60_000;
const MUTEX_PROCESS_INSPECTOR = new SystemProcessInspector();
let mutexProcessStartedAt: string | undefined;

export class WorkspaceLeaseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "WorkspaceLeaseError";
    this.code = code;
  }
}

export interface AcquireWorkspaceLeaseOptions {
  /** Shared lease directory under the runtime root, not a per-run directory. */
  leaseRoot: string;
  workspacePath: string;
  workspaceFingerprint: string;
  runId: string;
  missionHash: string;
  ttlMs?: number;
  processInspector?: ProcessInspector;
  clock?: () => Date;
  ownerPid?: number;
  ownerProcessStartedAt?: string;
}

export class FileWorkspaceLease implements WorkspaceLeaseHandle {
  readonly file: string;
  readonly #workspaceFingerprint: string;
  readonly #workspacePath: string;
  readonly #runId: string;
  readonly #missionHash: string;
  readonly #generation: number;
  readonly #ownerToken: string;
  readonly #processInspector: ProcessInspector;
  readonly #clock: () => Date;
  readonly #defaultTtlMs: number;
  #released = false;

  private constructor(options: {
    file: string;
    record: WorkspaceLeaseRecord;
    processInspector: ProcessInspector;
    clock: () => Date;
    defaultTtlMs: number;
  }) {
    this.file = options.file;
    this.#workspaceFingerprint = options.record.workspaceFingerprint;
    this.#workspacePath = options.record.workspacePath;
    this.#runId = options.record.runId;
    this.#missionHash = options.record.missionHash;
    this.#generation = options.record.generation;
    this.#ownerToken = options.record.ownerToken;
    this.#processInspector = options.processInspector;
    this.#clock = options.clock;
    this.#defaultTtlMs = options.defaultTtlMs;
  }

  static inspect(leaseRootInput: string, workspaceFingerprint: string): WorkspaceLeaseRecord | null {
    if (!/^[a-f0-9]{64}$/.test(workspaceFingerprint)) {
      throw new WorkspaceLeaseError("WORKSPACE_LEASE_FINGERPRINT_INVALID", workspaceFingerprint);
    }
    const leaseRoot = path.resolve(leaseRootInput);
    if (!existsSync(leaseRoot)) return null;
    if (lstatSync(leaseRoot).isSymbolicLink() || !statSync(leaseRoot).isDirectory()) {
      throw new WorkspaceLeaseError("WORKSPACE_LEASE_ROOT_INVALID", leaseRoot);
    }
    const canonicalRoot = realpathSync(leaseRoot);
    const candidate = path.join(canonicalRoot, `${workspaceFingerprint}.json`);
    if (!existsSync(candidate)) return null;
    if (lstatSync(candidate).isSymbolicLink() || !statSync(candidate).isFile()) {
      throw new WorkspaceLeaseError("WORKSPACE_LEASE_PATH_INVALID", candidate);
    }
    const canonicalFile = realpathSync(candidate);
    const relative = path.relative(canonicalRoot, canonicalFile);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new WorkspaceLeaseError("WORKSPACE_LEASE_PATH_ESCAPE", canonicalFile);
    }
    const record = readLease(canonicalFile);
    if (record.workspaceFingerprint !== workspaceFingerprint) {
      throw new WorkspaceLeaseError("WORKSPACE_LEASE_IDENTITY_MISMATCH", record.workspaceFingerprint);
    }
    return record;
  }

  static acquire(options: AcquireWorkspaceLeaseOptions): FileWorkspaceLease {
    const leaseRoot = ensureLeaseRoot(options.leaseRoot);
    const workspacePath = canonicalWorkspace(options.workspacePath);
    if (!/^[a-f0-9]{64}$/.test(options.workspaceFingerprint)
      || options.workspaceFingerprint !== computeWorkspaceFingerprint(workspacePath)) {
      throw new WorkspaceLeaseError("WORKSPACE_LEASE_FINGERPRINT_INVALID", options.workspaceFingerprint);
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(options.runId)) throw new WorkspaceLeaseError("WORKSPACE_LEASE_RUN_ID_INVALID", options.runId);
    if (!/^[a-f0-9]{64}$/.test(options.missionHash)) throw new WorkspaceLeaseError("WORKSPACE_LEASE_HASH_INVALID", options.missionHash);
    const ttlMs = boundedTtl(options.ttlMs ?? DEFAULT_TTL_MS);
    const processInspector = options.processInspector ?? new NodeProcessInspector();
    const clock = options.clock ?? (() => new Date());
    const ownerPid = options.ownerPid ?? process.pid;
    if (!Number.isInteger(ownerPid) || ownerPid < 1) throw new WorkspaceLeaseError("WORKSPACE_LEASE_PID_INVALID", String(ownerPid));
    const ownerProcessStartedAt = options.ownerProcessStartedAt
      ? normalizeTimestamp(options.ownerProcessStartedAt, "ownerProcessStartedAt")
      : normalizeTimestamp(requireProcessStartIdentity(processInspector, ownerPid, "workspace lease owner"), "ownerProcessStartedAt");
    const file = path.join(leaseRoot, `${options.workspaceFingerprint}.json`);
    const mutex = acquireMutex(leaseRoot, options.workspaceFingerprint);
    let record: WorkspaceLeaseRecord;
    try {
      const prior = existsSync(file) ? readLease(file) : undefined;
      let generation = 1;
      if (prior) {
        if (prior.workspaceFingerprint !== options.workspaceFingerprint || !sameWorkspacePath(prior.workspacePath, workspacePath)) {
          throw new WorkspaceLeaseError("WORKSPACE_LEASE_IDENTITY_MISMATCH", `${prior.workspaceFingerprint}/${prior.workspacePath}`);
        }
        generation = prior.generation + 1;
        if (prior.status === "active") assertPriorOwnerDead(prior, processInspector, clock());
      }
      const now = clock();
      record = {
        version: 2,
        workspaceFingerprint: options.workspaceFingerprint,
        workspacePath,
        runId: options.runId,
        missionHash: options.missionHash,
        generation,
        ownerToken: randomBytes(24).toString("hex"),
        ownerPid,
        ownerProcessStartedAt,
        workerPid: null,
        acquiredAt: now.toISOString(),
        renewedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        status: "active",
      };
      writeJsonAtomic(file, record);
    } finally {
      releaseMutex(mutex);
    }
    return new FileWorkspaceLease({ file, record, processInspector, clock, defaultTtlMs: ttlMs });
  }

  get record(): WorkspaceLeaseRecord {
    const record = readLease(this.file);
    this.#assertIdentity(record);
    return record;
  }

  bindWorker(pid: number, processStartedAt?: string): WorkspaceLeaseRecord {
    if (!Number.isInteger(pid) || pid < 1) throw new WorkspaceLeaseError("WORKSPACE_LEASE_PID_INVALID", String(pid));
    const workerProcessStartedAt = processStartedAt
      ? normalizeTimestamp(processStartedAt, "workerProcessStartedAt")
      : normalizeTimestamp(requireProcessStartIdentity(this.#processInspector, pid, "workspace lease worker"), "workerProcessStartedAt");
    return this.#update((record) => ({
      ...record,
      workerPid: pid,
      workerProcessStartedAt,
    }));
  }

  renew(ttlMs: number = this.#defaultTtlMs): WorkspaceLeaseRecord {
    const bounded = boundedTtl(ttlMs);
    return this.#update((record) => {
      const now = this.#clock();
      return { ...record, renewedAt: now.toISOString(), expiresAt: new Date(now.getTime() + bounded).toISOString() };
    });
  }

  assertPublisher(generation: number, ownerToken: string): void {
    const record = readLease(this.file);
    if (record.status !== "active" || record.generation !== generation || record.ownerToken !== ownerToken
      || generation !== this.#generation || ownerToken !== this.#ownerToken) {
      throw new WorkspaceLeaseError("WORKSPACE_LEASE_STALE_PUBLISHER", `generation ${generation}`);
    }
  }

  release(): WorkspaceLeaseRecord {
    if (this.#released) return this.record;
    const released = this.#update((record) => {
      const now = this.#clock().toISOString();
      return { ...record, status: "released", releasedAt: now, renewedAt: now, expiresAt: now };
    });
    this.#released = true;
    return released;
  }

  #update(transform: (record: WorkspaceLeaseRecord) => WorkspaceLeaseRecord): WorkspaceLeaseRecord {
    if (this.#released) throw new WorkspaceLeaseError("WORKSPACE_LEASE_RELEASED", this.file);
    const mutex = acquireMutex(path.dirname(this.file), this.#workspaceFingerprint);
    try {
      const current = readLease(this.file);
      this.#assertIdentity(current);
      if (current.status !== "active") throw new WorkspaceLeaseError("WORKSPACE_LEASE_RELEASED", this.file);
      const next = transform(current);
      validateLease(next);
      if (next.generation !== current.generation || next.ownerToken !== current.ownerToken) {
        throw new WorkspaceLeaseError("WORKSPACE_LEASE_IDENTITY_MUTATION", this.file);
      }
      writeJsonAtomic(this.file, next);
      return clone(next);
    } finally {
      releaseMutex(mutex);
    }
  }

  #assertIdentity(record: WorkspaceLeaseRecord): void {
    if (record.workspaceFingerprint !== this.#workspaceFingerprint || !sameWorkspacePath(record.workspacePath, this.#workspacePath)
      || record.runId !== this.#runId || record.missionHash !== this.#missionHash
      || record.generation !== this.#generation || record.ownerToken !== this.#ownerToken) {
      throw new WorkspaceLeaseError("WORKSPACE_LEASE_STALE_PUBLISHER", `${record.runId} generation ${record.generation}`);
    }
  }
}

export class NodeProcessInspector extends SystemProcessInspector {}

function assertPriorOwnerDead(record: WorkspaceLeaseRecord, inspector: ProcessInspector, now: Date): void {
  const owner = inspector.inspect(record.ownerPid);
  if (!record.workerPid) {
    if (sameProcessStillAlive(owner, record.ownerProcessStartedAt)) {
      throw new WorkspaceLeaseError("WORKSPACE_SUPERVISOR_ACTIVE", `owner pid ${record.ownerPid}, generation ${record.generation}`);
    }
    throw new WorkspaceLeaseError("WORKSPACE_WRITER_UNCLASSIFIED", `generation ${record.generation} ended before worker identity was fenced`);
  }
  const worker = inspector.inspect(record.workerPid);
  if (sameProcessStillAlive(worker, record.workerProcessStartedAt)) {
    throw new WorkspaceLeaseError("WORKSPACE_WRITER_ACTIVE", `worker pid ${record.workerPid}, generation ${record.generation}`);
  }
  const boundWorkerConfirmedDead = true;
  if (sameProcessStillAlive(owner, record.ownerProcessStartedAt)) {
    const expired = now.getTime() >= Date.parse(record.expiresAt);
    // Pending runs intentionally keep a fail-closed lease while a worker may
    // survive their call. Once that exact worker is confirmed dead and the
    // lease has expired, the long-lived Pi host PID alone must not make the
    // workspace permanently unrecoverable.
    if (boundWorkerConfirmedDead && expired) return;
    throw new WorkspaceLeaseError("WORKSPACE_SUPERVISOR_ACTIVE", `owner pid ${record.ownerPid}, generation ${record.generation}`);
  }
}

function sameProcessStillAlive(observation: ProcessObservation, expectedStartedAt?: string): boolean {
  if (!observation.alive) return false;
  if (!expectedStartedAt || !observation.startedAt) return true;
  return normalizeTimestamp(observation.startedAt, "observed process start") === expectedStartedAt;
}

function acquireMutex(leaseRoot: string, workspaceFingerprint: string): ProcessClaimLock {
  return acquireProcessClaimLock({
    directory: path.join(leaseRoot, `${workspaceFingerprint}.mutex-claims`),
    prefix: "lease-mutex",
    processInspector: MUTEX_PROCESS_INSPECTOR,
    processStartedAt: mutexProcessStartedAt ??= requireProcessStartIdentity(MUTEX_PROCESS_INSPECTOR, process.pid, "workspace lease mutex"),
    busy: () => new WorkspaceLeaseError("WORKSPACE_LEASE_BUSY", leaseRoot),
  });
}

function releaseMutex(mutex: ProcessClaimLock): void {
  releaseProcessClaimLock(mutex);
}

function readLease(file: string): WorkspaceLeaseRecord {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new WorkspaceLeaseError("WORKSPACE_LEASE_MALFORMED", error instanceof Error ? error.message : String(error));
  }
  validateLease(value);
  return clone(value);
}

function validateLease(value: unknown): asserts value is WorkspaceLeaseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceLeaseError("WORKSPACE_LEASE_MALFORMED", "not object");
  const record = value as Partial<WorkspaceLeaseRecord>;
  if (record.version !== 2 || !/^[a-f0-9]{64}$/.test(String(record.workspaceFingerprint ?? ""))
    || typeof record.workspacePath !== "string" || !path.isAbsolute(record.workspacePath)
    || typeof record.runId !== "string" || !/^[a-f0-9]{64}$/.test(String(record.missionHash ?? ""))
    || !Number.isInteger(record.generation) || (record.generation as number) < 1 || typeof record.ownerToken !== "string" || record.ownerToken.length < 32
    || !Number.isInteger(record.ownerPid) || (record.ownerPid as number) < 1 || !(record.workerPid === null || (Number.isInteger(record.workerPid) && (record.workerPid as number) > 0))
    || !(record.status === "active" || record.status === "released")) {
    throw new WorkspaceLeaseError("WORKSPACE_LEASE_MALFORMED", "identity fields");
  }
  for (const [label, timestamp] of [["acquiredAt", record.acquiredAt], ["renewedAt", record.renewedAt], ["expiresAt", record.expiresAt]] as const) {
    if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) throw new WorkspaceLeaseError("WORKSPACE_LEASE_MALFORMED", label);
  }
  if (record.ownerProcessStartedAt !== undefined) normalizeTimestamp(record.ownerProcessStartedAt, "ownerProcessStartedAt");
  if (record.workerProcessStartedAt !== undefined) normalizeTimestamp(record.workerProcessStartedAt, "workerProcessStartedAt");
  if (record.status === "released" && (typeof record.releasedAt !== "string" || Number.isNaN(Date.parse(record.releasedAt)))) {
    throw new WorkspaceLeaseError("WORKSPACE_LEASE_MALFORMED", "releasedAt");
  }
}

function ensureLeaseRoot(root: string): string {
  const absolute = path.resolve(root);
  mkdirSync(absolute, { recursive: true });
  if (lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isDirectory()) {
    throw new WorkspaceLeaseError("WORKSPACE_LEASE_ROOT_INVALID", absolute);
  }
  return realpathSync(absolute);
}

function canonicalWorkspace(workspacePath: string): string {
  const absolute = path.resolve(workspacePath);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new WorkspaceLeaseError("WORKSPACE_LEASE_WORKSPACE_INVALID", absolute);
  }
  return realpathSync(absolute);
}

function sameWorkspacePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US") : left === right;
}

function boundedTtl(value: number): number {
  if (!Number.isInteger(value) || value < MIN_TTL_MS || value > MAX_TTL_MS) {
    throw new WorkspaceLeaseError("WORKSPACE_LEASE_TTL_INVALID", String(value));
  }
  return value;
}

function normalizeTimestamp(value: string, label: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new WorkspaceLeaseError("WORKSPACE_LEASE_TIMESTAMP_INVALID", label);
  return new Date(time).toISOString();
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
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
