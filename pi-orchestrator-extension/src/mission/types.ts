export const MISSION_SCHEMA_VERSION = 1 as const;
export const MISSION_EVENT_VERSION = 1 as const;

export type MissionState =
  | "CREATED"
  | "RUNNING"
  | "WAITING_FOR_WORKER"
  | "VALIDATING"
  | "REPAIRING"
  | "PAUSED"
  | "OUTCOME_UNKNOWN"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface MissionRoute {
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
}

export interface MissionBudgets {
  wallClockMs: number;
  maxTurns: number;
  maxRestarts: number;
  maxSpecialists: number;
  maxTokens?: number;
}

export interface NodeWorkspaceValidatorSpec {
  kind: "node-workspace-validator";
  /** Fixed v1 profile. The script must be a regular `validate.cjs` at the workspace root. */
  script: "validate.cjs";
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ReadOnlyMissionSpec {
  kind: "none";
  readOnly: true;
}

export type MissionValidatorSpec = NodeWorkspaceValidatorSpec | ReadOnlyMissionSpec;

export interface MissionContractV1 {
  schemaVersion: typeof MISSION_SCHEMA_VERSION;
  objective: string;
  cwd: string;
  route: MissionRoute;
  fallbacks?: MissionRoute[];
  budgets: MissionBudgets;
  validator: MissionValidatorSpec;
  constraints?: string[];
}

export interface CompiledMissionContractV1 {
  schemaVersion: typeof MISSION_SCHEMA_VERSION;
  objective: string;
  cwd: string;
  /** Stable identity of the canonical workspace, used to key the global writer lease. */
  workspaceFingerprint: string;
  route: Required<MissionRoute>;
  fallbacks: Required<MissionRoute>[];
  budgets: Required<MissionBudgets>;
  validator: MissionValidatorSpec;
  constraints: string[];
}

export interface CompiledMission {
  contract: CompiledMissionContractV1;
  canonicalJson: string;
  missionHash: string;
}

export interface WorkspaceEffect {
  path: string;
  kind: "created" | "modified" | "deleted";
}

export interface WorkspaceSnapshotRecord {
  version: 1;
  root: string;
  digest: string;
  entries: Record<string, string>;
  capturedAt: string;
}

export interface MissionValidatorResult {
  status: "pass" | "fail" | "error";
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  validatorSha256: string;
}

export interface MissionWorkerIdentity {
  adapter: string;
  workerId: string;
  pid: number | null;
  processStartedAt?: string;
  sessionId: string;
  sessionFile: string;
  cursor: string | null;
  generation: number;
  /** Exact selected route, persisted so recovery does not silently change model identity. */
  route?: Required<MissionRoute>;
}

export interface MissionUsage {
  turns: number;
  restarts: number;
  specialists: number;
  tokens: number;
  startedAt: string;
  elapsedMs: number;
}

export type MissionEventType =
  | "mission.created"
  | "mission.started"
  | "mission.resumed"
  | "mission.paused"
  | "mission.outcome-unknown"
  | "mission.succeeded"
  | "mission.failed"
  | "mission.cancelled"
  | "lease.acquired"
  | "lease.renewed"
  | "lease.released"
  | "workspace.snapshot"
  | "effects.observed"
  | "worker.started"
  | "worker.heartbeat"
  | "worker.cursor"
  | "worker.event"
  | "worker.settled"
  | "worker.failed"
  | "worker.exited"
  | "worker.recovery-requested"
  | "validator.pinned"
  | "validator.started"
  | "validator.completed"
  | "repair.requested"
  | "budget.exhausted";

export interface MissionEvent {
  version: typeof MISSION_EVENT_VERSION;
  runId: string;
  seq: number;
  at: string;
  type: MissionEventType;
  generation: number;
  data: Record<string, unknown>;
}

export type NewMissionEvent = Omit<MissionEvent, "version" | "seq" | "at"> & { at?: string };

export interface MissionProjection {
  version: 1;
  runId: string;
  missionHash: string | null;
  state: MissionState;
  lastSeq: number;
  generation: number;
  worker: MissionWorkerIdentity | null;
  cursor: string | null;
  usage: MissionUsage;
  effects: WorkspaceEffect[];
  baselineSnapshotDigest: string | null;
  latestSnapshotDigest: string | null;
  validator: MissionValidatorResult | null;
  nextAction: "start-worker" | "wait-worker" | "resume-worker" | "validate" | "repair" | "inspect-outcome" | "none";
  reason?: string;
}

export interface MissionJournal {
  readonly runId: string;
  readonly runDirectory: string;
  readonly eventFile: string;
  readonly projectionFile: string;
  append(event: NewMissionEvent): MissionEvent;
  readAll(): MissionEvent[];
  projection(): MissionProjection;
  close(): void;
}

export interface ProcessObservation {
  pid: number;
  alive: boolean;
  startedAt?: string;
}

export interface ProcessInspector {
  inspect(pid: number): ProcessObservation;
}

export interface WorkspaceLeaseRecord {
  version: 2;
  workspaceFingerprint: string;
  workspacePath: string;
  runId: string;
  missionHash: string;
  generation: number;
  ownerToken: string;
  ownerPid: number;
  ownerProcessStartedAt?: string;
  workerPid: number | null;
  workerProcessStartedAt?: string;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
  status: "active" | "released";
  releasedAt?: string;
}

export interface WorkspaceLeaseHandle {
  readonly file: string;
  readonly record: WorkspaceLeaseRecord;
  bindWorker(pid: number, processStartedAt?: string): WorkspaceLeaseRecord;
  renew(ttlMs?: number): WorkspaceLeaseRecord;
  assertPublisher(generation: number, ownerToken: string): void;
  release(): WorkspaceLeaseRecord;
}

export type MissionWorkerEvent =
  | { type: "heartbeat"; at?: string }
  | { type: "cursor"; cursor: string }
  | { type: "tool"; toolCallId: string; toolName: string; phase: "start" | "update" | "end"; isError?: boolean }
  | { type: "settled"; cursor: string | null; tokens: number }
  | { type: "failed"; message: string; retryable: boolean; cursor?: string | null };

export interface MissionWorkerInspection {
  state: "running" | "idle" | "exited" | "unknown";
  identity: MissionWorkerIdentity;
  exitCode?: number | null;
  error?: string;
}

export interface OpenMissionWorkerRequest {
  runId: string;
  generation: number;
  cwd: string;
  route: Required<MissionRoute>;
  fallbacks: Required<MissionRoute>[];
  readOnly: boolean;
  resume?: MissionWorkerIdentity;
}

export interface MissionWorker {
  readonly identity: MissionWorkerIdentity;
  prompt(message: string, signal?: AbortSignal): AsyncIterable<MissionWorkerEvent>;
  inspect(): Promise<MissionWorkerInspection>;
  abort(): Promise<void>;
  close(): Promise<void>;
}

export interface MissionWorkerFactory {
  readonly adapterName: string;
  open(request: OpenMissionWorkerRequest): Promise<MissionWorker>;
  inspect(identity: MissionWorkerIdentity): Promise<MissionWorkerInspection>;
  terminate(identity: MissionWorkerIdentity): Promise<boolean>;
}
