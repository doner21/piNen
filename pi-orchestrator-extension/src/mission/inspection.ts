import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import { compileMissionContract } from "./contract";
import { FileMissionJournal } from "./event-store";
import { inspectProcessClaimLock } from "./file-lock";
import { FileWorkspaceLease } from "./lease";
import { normalizeProcessStartIdentity, SystemProcessInspector } from "./process";
import { defaultMissionRunsRoot } from "./runner";
import type {
  CompiledMission,
  CompiledMissionContractV1,
  MissionBudgets,
  MissionProjection,
  MissionUsage,
  MissionValidatorResult,
  MissionWorkerIdentity,
  ProcessInspector,
  WorkspaceLeaseRecord,
} from "./types";

export type MissionProcessStatus = "alive" | "dead" | "unknown" | "not-recorded";
export type MissionSessionStatus = "present" | "missing" | "unsafe" | "unreadable" | "not-recorded";
export type MissionSafeActionCode =
  | "none"
  | "wait-worker"
  | "wait-supervisor"
  | "resume-mission"
  | "reconcile-outcome"
  | "inspect-worker"
  | "inspect-session"
  | "inspect-runtime";

export interface MissionProcessInspection {
  status: MissionProcessStatus;
  pid: number | null;
  expectedStartedAt?: string;
  observedStartedAt?: string;
  reason?: string;
}

export interface MissionWorkerInspectionReport {
  identity: MissionWorkerIdentity;
  process: MissionProcessInspection;
  session: { status: MissionSessionStatus; file: string | null; reason?: string };
  lastHeartbeatAt: string | null;
  heartbeatAgeMs: number | null;
}

export interface MissionBudgetInspection {
  limits: Required<MissionBudgets>;
  consumed: MissionUsage;
  remaining: { wallClockMs: number; turns: number; restarts: number; specialists: number; tokens: number };
  exhausted: Array<"wallClockMs" | "turns" | "restarts" | "specialists" | "tokens">;
}

export interface MissionSupervisorInspection {
  state: "absent" | "active" | "released" | "unknown";
  generation?: number;
  acquiredAt?: string;
  process?: MissionProcessInspection;
  reason?: string;
}

export interface MissionLeaseInspection {
  state: "absent" | "active" | "released" | "unknown";
  belongsToMission: boolean | null;
  expired: boolean | null;
  generation?: number;
  runId?: string;
  missionHash?: string;
  workspaceFingerprint?: string;
  acquiredAt?: string;
  renewedAt?: string;
  expiresAt?: string;
  ownerProcess?: MissionProcessInspection;
  workerProcess?: MissionProcessInspection;
  reason?: string;
}

export interface DurableMissionInspection {
  version: 1;
  inspectedAt: string;
  runId: string;
  runDirectory: string;
  missionHash: string;
  objectiveHash: string;
  cwd: string;
  workspaceFingerprint: string;
  state: MissionProjection["state"];
  reason?: string;
  projectedNextAction: MissionProjection["nextAction"];
  safeAction: { code: MissionSafeActionCode; reason: string };
  worker: MissionWorkerInspectionReport | null;
  budgets: MissionBudgetInspection;
  validator: MissionValidatorResult | null;
  supervisor: MissionSupervisorInspection;
  workspaceLease: MissionLeaseInspection;
  effects: MissionProjection["effects"];
  lastSeq: number;
  generation: number;
}

export interface InspectDurableMissionOptions {
  runId: string;
  runsRoot?: string;
  processInspector?: ProcessInspector;
  clock?: () => Date;
}

export class MissionInspectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "MissionInspectionError";
    this.code = code;
  }
}

/** Read durable mission state without opening a journal lock or changing runtime files. */
export function inspectDurableMission(options: InspectDurableMissionOptions): DurableMissionInspection {
  const now = (options.clock ?? (() => new Date()))();
  if (Number.isNaN(now.getTime())) throw new MissionInspectionError("MISSION_INSPECTION_CLOCK_INVALID", String(now));
  const runsRoot = realpathSync(path.resolve(options.runsRoot ?? defaultMissionRunsRoot()));
  const { events, projection } = FileMissionJournal.inspect(runsRoot, options.runId);
  const pinned = readPinnedContract(events[0]?.data.canonicalJson, projection.missionHash);
  const inspector = options.processInspector ?? new SystemProcessInspector();
  const heartbeat = [...events].reverse().find((event) => event.type === "worker.heartbeat")?.at ?? null;
  const worker = projection.worker ? inspectWorker(projection.worker, heartbeat, now, inspector) : null;
  const budgets = inspectBudgets(pinned.budgets, projection.usage, now);
  const supervisor = inspectSupervisor(path.join(runsRoot, projection.runId), inspector);
  const workspaceLease = inspectLease(runsRoot, pinned, projection, now, inspector);
  const safeAction = deriveSafeAction(projection, worker, budgets, supervisor, workspaceLease);

  return {
    version: 1,
    inspectedAt: now.toISOString(),
    runId: projection.runId,
    runDirectory: path.join(runsRoot, projection.runId),
    missionHash: projection.missionHash!,
    objectiveHash: computeMissionObjectiveHash(pinned.objective),
    cwd: pinned.cwd,
    workspaceFingerprint: pinned.workspaceFingerprint,
    state: projection.state,
    ...(projection.reason ? { reason: projection.reason } : {}),
    projectedNextAction: projection.nextAction,
    safeAction,
    worker,
    budgets,
    validator: projection.validator,
    supervisor,
    workspaceLease,
    effects: projection.effects,
    lastSeq: projection.lastSeq,
    generation: projection.generation,
  };
}

export function loadDurableMissionContract(runsRootInput: string, runId: string): CompiledMission {
  const runsRoot = realpathSync(path.resolve(runsRootInput));
  const { events, projection } = FileMissionJournal.inspect(runsRoot, runId);
  const canonicalJson = events[0]?.data.canonicalJson;
  const contract = readPinnedContract(canonicalJson, projection.missionHash);
  return { contract, canonicalJson: canonicalJson as string, missionHash: projection.missionHash! };
}

export function computeMissionObjectiveHash(objective: string): string {
  return createHash("sha256").update(`pi-durable-objective-v1\0${objective}`).digest("hex");
}

function readPinnedContract(canonical: unknown, expectedHash: string | null): CompiledMissionContractV1 {
  if (typeof canonical !== "string" || !expectedHash) {
    throw new MissionInspectionError("MISSION_INSPECTION_CONTRACT_MISSING", "mission.created lacks its canonical contract");
  }
  const actualHash = createHash("sha256").update(canonical).digest("hex");
  if (actualHash !== expectedHash) throw new MissionInspectionError("MISSION_INSPECTION_HASH_MISMATCH", actualHash);
  let value: unknown;
  try { value = JSON.parse(canonical); }
  catch (error) { throw new MissionInspectionError("MISSION_INSPECTION_CONTRACT_MALFORMED", error instanceof Error ? error.message : String(error)); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MissionInspectionError("MISSION_INSPECTION_CONTRACT_MALFORMED", "contract is not an object");
  }
  const { workspaceFingerprint, ...source } = value as Record<string, unknown>;
  let compiled;
  try { compiled = compileMissionContract(source); }
  catch (error) { throw new MissionInspectionError("MISSION_INSPECTION_CONTRACT_MALFORMED", error instanceof Error ? error.message : String(error)); }
  if (typeof workspaceFingerprint !== "string" || compiled.contract.workspaceFingerprint !== workspaceFingerprint
    || compiled.canonicalJson !== canonical || compiled.missionHash !== expectedHash) {
    throw new MissionInspectionError("MISSION_INSPECTION_CONTRACT_MALFORMED", "compiled contract identity does not match the journal");
  }
  return compiled.contract;
}

function inspectWorker(identity: MissionWorkerIdentity, heartbeat: string | null, now: Date, inspector: ProcessInspector): MissionWorkerInspectionReport {
  const session = inspectSession(identity.sessionFile);
  return {
    identity: publicWorkerIdentity(identity),
    process: inspectProcess(identity.pid, identity.processStartedAt, inspector),
    session,
    lastHeartbeatAt: heartbeat,
    heartbeatAgeMs: heartbeat ? Math.max(0, now.getTime() - Date.parse(heartbeat)) : null,
  };
}

function inspectSession(file: string): MissionWorkerInspectionReport["session"] {
  if (!file) return { status: "not-recorded", file: null };
  if (!path.isAbsolute(file)) return { status: "unsafe", file, reason: "session path is not absolute" };
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return { status: "unsafe", file, reason: "session path is not a regular non-symlink file" };
    return { status: "present", file };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { status: "missing", file, reason: "durable session file is absent" }
      : { status: "unreadable", file, reason: error instanceof Error ? error.message : String(error) };
  }
}

function inspectProcess(pid: number | null, expectedStartedAt: string | undefined, inspector: ProcessInspector): MissionProcessInspection {
  if (!pid) return { status: "not-recorded", pid: null };
  const base = { pid, ...(expectedStartedAt ? { expectedStartedAt } : {}) };
  try {
    const observed = inspector.inspect(pid);
    if (!observed.alive) return { ...base, status: "dead" };
    if (!expectedStartedAt || !observed.startedAt) return { ...base, status: "unknown", reason: "exact process-start identity is unavailable" };
    const expected = normalizeProcessStartIdentity(expectedStartedAt, "expected process start");
    const actual = normalizeProcessStartIdentity(observed.startedAt, "observed process start");
    if (expected !== actual) return { ...base, status: "dead", observedStartedAt: actual, reason: "PID belongs to a newer process" };
    return { ...base, status: "alive", observedStartedAt: actual };
  } catch (error) {
    return { ...base, status: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
}

function inspectBudgets(limits: Required<MissionBudgets>, usage: MissionUsage, now: Date): MissionBudgetInspection {
  const consumed = structuredClone(usage);
  consumed.elapsedMs = Math.max(consumed.elapsedMs, Math.max(0, now.getTime() - Date.parse(consumed.startedAt)));
  const remaining = {
    wallClockMs: Math.max(0, limits.wallClockMs - consumed.elapsedMs),
    turns: Math.max(0, limits.maxTurns - consumed.turns),
    restarts: Math.max(0, limits.maxRestarts - consumed.restarts),
    specialists: Math.max(0, limits.maxSpecialists - consumed.specialists),
    tokens: Math.max(0, limits.maxTokens - consumed.tokens),
  };
  const exhausted: MissionBudgetInspection["exhausted"] = [];
  if (!remaining.wallClockMs) exhausted.push("wallClockMs");
  if (!remaining.turns) exhausted.push("turns");
  if (!remaining.restarts) exhausted.push("restarts");
  if (!remaining.specialists && limits.maxSpecialists > 0) exhausted.push("specialists");
  if (!remaining.tokens) exhausted.push("tokens");
  return { limits: structuredClone(limits), consumed, remaining, exhausted };
}

function inspectSupervisor(runDirectory: string, inspector: ProcessInspector): MissionSupervisorInspection {
  try {
    const claim = inspectProcessClaimLock(path.join(runDirectory, "supervisor-lock-claims"), "supervisor");
    return {
      state: claim.state,
      ...(claim.generation ? { generation: claim.generation } : {}),
      ...(claim.acquiredAt ? { acquiredAt: claim.acquiredAt } : {}),
      ...(claim.pid ? { process: inspectProcess(claim.pid, claim.processStartedAt, inspector) } : {}),
    };
  } catch (error) {
    return { state: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
}

function inspectLease(
  runsRoot: string,
  pinned: CompiledMissionContractV1,
  projection: MissionProjection,
  now: Date,
  inspector: ProcessInspector,
): MissionLeaseInspection {
  let record: WorkspaceLeaseRecord | null;
  try { record = FileWorkspaceLease.inspect(path.join(runsRoot, "workspace-leases"), pinned.workspaceFingerprint); }
  catch (error) {
    return { state: "unknown", belongsToMission: null, expired: null, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!record) return { state: "absent", belongsToMission: null, expired: null };
  return {
    state: record.status,
    belongsToMission: record.runId === projection.runId && record.missionHash === projection.missionHash,
    expired: now.getTime() >= Date.parse(record.expiresAt),
    generation: record.generation,
    runId: record.runId,
    missionHash: record.missionHash,
    workspaceFingerprint: record.workspaceFingerprint,
    acquiredAt: record.acquiredAt,
    renewedAt: record.renewedAt,
    expiresAt: record.expiresAt,
    ownerProcess: inspectProcess(record.ownerPid, record.ownerProcessStartedAt, inspector),
    workerProcess: inspectProcess(record.workerPid, record.workerProcessStartedAt, inspector),
  };
}

function deriveSafeAction(
  projection: MissionProjection,
  worker: MissionWorkerInspectionReport | null,
  budgets: MissionBudgetInspection,
  supervisor: MissionSupervisorInspection,
  lease: MissionLeaseInspection,
): DurableMissionInspection["safeAction"] {
  if (projection.state === "SUCCEEDED" || projection.state === "FAILED" || projection.state === "CANCELLED") {
    return { code: "none", reason: `mission is terminal (${projection.state})` };
  }
  if (projection.state === "OUTCOME_UNKNOWN" || projection.nextAction === "inspect-outcome") {
    return { code: "reconcile-outcome", reason: "workspace effects must be reconciled before another writer starts" };
  }
  if (lease.state === "unknown" || (lease.state === "active" && lease.belongsToMission === false)) {
    return { code: "inspect-runtime", reason: lease.reason ?? "workspace lease ownership is not safe for this mission" };
  }
  if (supervisor.state === "unknown") return { code: "inspect-runtime", reason: supervisor.reason ?? "supervisor lock state is malformed" };
  if (supervisor.state === "active" && (supervisor.process?.status === "alive" || supervisor.process?.status === "unknown")) {
    return { code: "wait-supervisor", reason: "the exact recorded supervisor still owns the mission journal" };
  }
  if (worker?.process.status === "alive") return { code: "wait-worker", reason: "the exact recorded worker process is still alive" };
  if (worker?.process.status === "unknown") return { code: "inspect-worker", reason: "worker death is not proven; starting another writer is unsafe" };
  if (lease.state === "active" && lease.belongsToMission) {
    if (lease.workerProcess?.status === "not-recorded") {
      return { code: "inspect-runtime", reason: "the prior supervisor died before fencing a worker process; duplicate-writer safety requires reconciliation" };
    }
    const recoverableExpiredLease = lease.expired === true && lease.workerProcess?.status === "dead";
    if (!recoverableExpiredLease && (lease.ownerProcess?.status === "alive" || lease.ownerProcess?.status === "unknown")) {
      return { code: "wait-supervisor", reason: "the recorded supervisor still holds the workspace lease" };
    }
  }
  if ((projection.nextAction === "resume-worker" || projection.nextAction === "repair") && worker?.session.status !== "present") {
    return { code: "inspect-session", reason: "the durable worker session is not safely available for resume" };
  }
  if (projection.nextAction !== "validate" && projection.nextAction !== "none" && budgets.exhausted.length) {
    return { code: "resume-mission", reason: `resume to publish budget exhaustion (${budgets.exhausted.join(", ")}) without unbounded work` };
  }
  return { code: "resume-mission", reason: describeResume(projection) };
}

function describeResume(projection: MissionProjection): string {
  if (projection.nextAction === "validate") return "resume the supervisor to run the pinned host validator before starting another worker";
  if (projection.nextAction === "repair") return "resume the same durable session with the recorded validator failure";
  if (projection.nextAction === "none" && projection.validator?.status === "pass") return "resume the supervisor to publish the durable validator pass";
  if (projection.nextAction === "start-worker") return "resume the mission to start its first fenced worker";
  return "resume the supervisor under the unchanged mission and workspace lease";
}

function publicWorkerIdentity(identity: MissionWorkerIdentity): MissionWorkerIdentity {
  return {
    adapter: identity.adapter,
    workerId: identity.workerId,
    pid: identity.pid,
    ...(identity.processStartedAt ? { processStartedAt: identity.processStartedAt } : {}),
    sessionId: identity.sessionId,
    sessionFile: identity.sessionFile,
    cursor: identity.cursor,
    generation: identity.generation,
    ...(identity.route ? { route: {
      provider: identity.route.provider,
      model: identity.route.model,
      thinkingLevel: identity.route.thinkingLevel,
    } } : {}),
  };
}
