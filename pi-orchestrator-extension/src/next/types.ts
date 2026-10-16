/**
 * Orchestrator Next v2 public contracts.
 *
 * Workflows are inert data. The compiler owns graph validation and the kernel
 * owns scheduling, retries, result validation, and terminal classification.
 */

export const NEXT_SCHEMA_VERSION = 2 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type PhaseKind = "agent" | "deterministic-command" | "join" | "integrate";
export type AccessMode = "read-only" | "workspace-write";
export type WorkspaceMode = "shared" | "isolated";
export type ResultMode = "informational" | "gate" | "deterministic";

export type FailureCategory =
  | "compile-error"
  | "capability-mismatch"
  | "launch-failure"
  | "provider-transient"
  | "protocol-failure"
  | "detached-survivor"
  | "result-file-pending"
  | "candidate-result-preserved"
  | "effects-unobservable"
  | "semantic-failure"
  | "deterministic-check-failure"
  | "authorization-violation"
  | "outcome-unknown"
  | "cancelled"
  | "budget-exhausted"
  | "internal-error";

export interface InputFieldSpec {
  type: "string" | "number" | "boolean";
  required?: boolean;
  default?: JsonPrimitive;
}

export interface WorkflowDefaultsSpec {
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface WorkflowLimitsSpec {
  maxConcurrency?: number;
  maxTotalAttempts?: number;
}

export interface RetrySpec {
  on: FailureCategory[];
  maxAttempts?: number;
}

export interface WorkspaceSpec {
  mode: WorkspaceMode;
}

export interface AgentRouteSpec {
  provider?: string;
  model?: string;
}

export interface AgentSpec extends AgentRouteSpec {
  name: string;
  /** Ordered, compiler-pinned routes used only for safe pre-effect provider failure. */
  fallbacks?: AgentRouteSpec[];
}

export interface IntegrationSpec {
  /** Isolated writer phase ids whose candidate workspaces are applied. */
  sources: string[];
  /** v2 intentionally supports only conflict-checked application. */
  strategy?: "apply-clean";
}

export interface CommandSpec {
  /** Logical executable key resolved by the command adapter allowlist. */
  executable: string;
  /** Argument vector. Shell parsing is never used. */
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface WorkflowPhaseSpec {
  id: string;
  kind: PhaseKind;
  dependsOn?: string[];
  access: AccessMode;
  workspace?: WorkspaceSpec;
  resultMode: ResultMode;
  outputSchema: string;
  input?: JsonObject;
  role?: string;
  agent?: AgentSpec;
  command?: CommandSpec;
  integrate?: IntegrationSpec;
  retry?: RetrySpec;
  timeoutMs?: number;
}

export interface CompletionSpec {
  terminalPhase: string;
  require?: "success" | "pass";
}

export interface WorkflowSpec {
  schemaVersion: typeof NEXT_SCHEMA_VERSION;
  name: string;
  description?: string;
  inputs?: Record<string, InputFieldSpec>;
  defaults?: WorkflowDefaultsSpec;
  limits?: WorkflowLimitsSpec;
  phases: WorkflowPhaseSpec[];
  completion: CompletionSpec;
}

export interface CompiledInputField {
  type: InputFieldSpec["type"];
  required: boolean;
  default?: JsonPrimitive;
}

export interface CompiledRetryPolicy {
  on: FailureCategory[];
  maxAttempts: number;
}

export interface CompiledPhase {
  id: string;
  kind: PhaseKind;
  dependsOn: string[];
  access: AccessMode;
  workspace: WorkspaceSpec;
  resultMode: ResultMode;
  outputSchema: string;
  input: JsonObject;
  role?: string;
  agent?: AgentSpec;
  command?: CommandSpec;
  integrate?: Required<IntegrationSpec>;
  retry: CompiledRetryPolicy;
  timeoutMs: number;
}

export interface CanonicalWorkflowIR {
  schemaVersion: typeof NEXT_SCHEMA_VERSION;
  name: string;
  description: string;
  inputs: Record<string, CompiledInputField>;
  defaults: {
    timeoutMs: number;
    maxAttempts: number;
  };
  limits: {
    maxConcurrency: number;
    maxTotalAttempts: number;
  };
  phases: CompiledPhase[];
  completion: {
    terminalPhase: string;
    require: "success" | "pass";
  };
}

export interface DryRunPhase {
  id: string;
  kind: PhaseKind;
  access: AccessMode;
  workspace: WorkspaceMode;
  resultMode: ResultMode;
  maxAttempts: number;
}

export interface DryRunSchedule {
  workflow: string;
  workflowHash: string;
  maxConcurrency: number;
  maximumAttempts: number;
  waves: DryRunPhase[][];
}

export interface CompiledWorkflow {
  ir: CanonicalWorkflowIR;
  canonicalJson: string;
  hash: string;
  schedule: DryRunSchedule;
}

export interface ProcessStatus {
  started: boolean;
  exitCode: number | null;
  signal?: string;
}

export interface ProtocolStatus {
  status: "valid" | "invalid" | "missing";
  schema: string;
  error?: string;
}

export interface SemanticStatus {
  status: "not-applicable" | "pass" | "fail";
  summary?: string;
}

export interface EffectRecord {
  path: string;
  kind: "created" | "modified" | "deleted" | "external";
}

export interface EffectStatus {
  status: "none" | "observed" | "unsupported";
  mutations: EffectRecord[];
}

export interface WorkspaceBinding {
  mode: WorkspaceMode;
  /** Canonical root supplied to this phase/attempt. */
  root: string;
  /** Canonical product workspace that explicit integration may mutate. */
  productRoot: string;
  phaseId: string;
  attempt: number;
  /** Durable workspace-manager metadata for isolated candidates. */
  metadataFile?: string;
  baseFingerprint?: string;
}

export interface PhaseOutcome {
  phaseId: string;
  attempt: number;
  status: "succeeded" | "failed" | "pending" | "outcome-unknown" | "cancelled";
  category?: FailureCategory;
  process: ProcessStatus;
  protocol: ProtocolStatus;
  semantic: SemanticStatus;
  effects: EffectStatus;
  workspace?: WorkspaceBinding;
  output?: JsonValue;
  error?: string;
}

export interface WorkerCapabilities {
  adapter: string;
  phaseKinds: PhaseKind[];
  accessModes: AccessMode[];
  structuredOutput: boolean;
  inspect: boolean;
  cancel: boolean;
}

export interface WorkerRequest {
  runId: string;
  workerRunId: string;
  phase: CompiledPhase;
  attempt: number;
  input: JsonObject;
  workspaceRoot: string;
  signal?: AbortSignal;
}

export interface WorkerPublication {
  manifestFile: string;
  /** Reserved exclusively for successful abort-survivor completion. */
  resultFile: string;
  /** Preserved ambiguous terminal candidate; never auto-promoted as success. */
  candidateFile?: string;
  pid?: number;
}

export type WorkerEvent =
  | { type: "started"; workerRunId: string }
  | { type: "progress"; message: string }
  | { type: "effect"; effect: EffectRecord }
  | { type: "result"; output: JsonValue; exitCode: number; signal?: string; publication?: WorkerPublication }
  | { type: "failed"; category: FailureCategory; message: string; exitCode?: number | null; publication?: WorkerPublication; candidate?: JsonValue };

export interface ResumeRequest {
  runId: string;
  workerRunId: string;
  phase: CompiledPhase;
  attempt: number;
  workspaceRoot: string;
  signal?: AbortSignal;
}

export interface WorkerInspection {
  workerRunId: string;
  state: "running" | "completed" | "failed" | "unknown";
  effects: EffectStatus;
  output?: JsonValue;
  exitCode?: number | null;
  signal?: string;
  publication?: WorkerPublication;
  error?: string;
}

export interface CancelResult {
  workerRunId: string;
  cancelled: boolean;
}

export interface WorkerAdapter {
  capabilities(): Promise<WorkerCapabilities>;
  start(request: WorkerRequest): AsyncIterable<WorkerEvent>;
  resume(request: ResumeRequest): AsyncIterable<WorkerEvent>;
  cancel(workerRunId: string): Promise<CancelResult>;
  inspect(workerRunId: string): Promise<WorkerInspection>;
}

export interface RunEvent {
  version: 1;
  runId: string;
  seq: number;
  at: string;
  type:
    | "run.created"
    | "run.resumed"
    | "run.paused"
    | "workflow.compiled"
    | "workspace.prepared"
    | "workspace.preserved"
    | "workspace.integrated"
    | "phase.ready"
    | "phase.attempt.started"
    | "worker.started"
    | "worker.event.received"
    | "effect.observed"
    | "worker.transport.failed"
    | "worker.detached"
    | "worker.candidate.preserved"
    | "worker.inspected"
    | "worker.result.published"
    | "worker.result.received"
    | "worker.result.validated"
    | "phase.semantic.failed"
    | "phase.waiting"
    | "phase.succeeded"
    | "phase.failed"
    | "phase.outcome.unknown"
    | "phase.retry.scheduled"
    | "run.completed"
    | "run.cancelled"
    | "run.failed";
  phaseId?: string;
  attempt?: number;
  data: Record<string, unknown>;
}

export type NewRunEvent = Omit<RunEvent, "version" | "seq" | "at"> & { at?: string };

export interface EventStore {
  readonly runId: string;
  append(event: NewRunEvent): RunEvent;
  readAll(): RunEvent[];
  /** Durable stores release their exclusive writer lease here. */
  close?(): void;
}

export interface ProjectedPhaseState {
  id: string;
  status: "pending" | "ready" | "running" | "waiting" | "retrying" | "succeeded" | "failed" | "outcome-unknown" | "cancelled";
  attempts: number;
  category?: FailureCategory;
  output?: JsonValue;
  effects: EffectStatus;
  workspace?: WorkspaceBinding;
}

export interface WorkspacePrepareRequest {
  runId: string;
  phase: CompiledPhase;
  attempt: number;
  productRoot: string;
}

export interface WorkspaceIntegrationRequest {
  runId: string;
  phase: CompiledPhase;
  attempt: number;
  productRoot: string;
  sources: WorkspaceBinding[];
}

export interface WorkspaceIntegrationResult {
  output: JsonValue;
  effects: EffectStatus;
}

export interface WorkspaceManager {
  prepare(request: WorkspacePrepareRequest): Promise<WorkspaceBinding>;
  preserve(binding: WorkspaceBinding, reason: string): Promise<void>;
  integrate(request: WorkspaceIntegrationRequest): Promise<WorkspaceIntegrationResult>;
}

export interface RunProjection {
  runId: string;
  workflowHash?: string;
  status: "created" | "running" | "paused" | "succeeded" | "failed" | "cancelled";
  phases: Record<string, ProjectedPhaseState>;
  lastSeq: number;
}

export interface KernelOptions {
  runId: string;
  workspaceRoot: string;
  input: Record<string, JsonPrimitive>;
  /** Host/runtime capability policy pinned into run.created and checked on resume. */
  runtimePolicy?: JsonObject;
  eventStore: EventStore;
  agentAdapter: WorkerAdapter;
  commandAdapter?: WorkerAdapter;
  workspaceManager?: WorkspaceManager;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
}

export interface KernelResult {
  runId: string;
  status: "pass" | "fail" | "pending" | "cancelled";
  workflowHash: string;
  phaseOutcomes: Record<string, PhaseOutcome>;
  projection: RunProjection;
}
