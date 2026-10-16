import { createHash } from "node:crypto";
import path from "node:path";

import { OutputSchemaRegistry, createBuiltinSchemaRegistry } from "./schemas";
import {
  NEXT_SCHEMA_VERSION,
  type AccessMode,
  type CanonicalWorkflowIR,
  type CommandSpec,
  type CompiledInputField,
  type CompiledPhase,
  type CompiledWorkflow,
  type CompletionSpec,
  type DryRunSchedule,
  type FailureCategory,
  type InputFieldSpec,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type RetrySpec,
  type WorkflowPhaseSpec,
  type WorkflowSpec,
} from "./types";

const SAFE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SAFE_TOKEN = /^[a-zA-Z][a-zA-Z0-9._-]*$/;
const SAFE_SCHEMA = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-v[1-9][0-9]*$/;
const FULL_EXPRESSION = /^\$\{(inputs\.([a-z][a-zA-Z0-9_-]*)|phases\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.output|workspace\.root)\}$/;
const FORBIDDEN_COMMAND_ENV = new Set([
  "NODE_OPTIONS", "NODE_PATH", "PATH", "LD_PRELOAD", "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "PYTHONPATH", "RUBYOPT",
]);
const ALL_FAILURE_CATEGORIES: FailureCategory[] = [
  "compile-error", "capability-mismatch", "launch-failure", "provider-transient", "protocol-failure",
  "detached-survivor", "result-file-pending", "candidate-result-preserved", "effects-unobservable",
  "semantic-failure", "deterministic-check-failure", "authorization-violation", "outcome-unknown",
  "cancelled", "budget-exhausted", "internal-error",
];
const RETRYABLE_CATEGORIES = new Set<FailureCategory>([
  "launch-failure", "provider-transient", "protocol-failure", "result-file-pending",
]);

const WORKFLOW_KEYS = new Set(["schemaVersion", "name", "description", "inputs", "defaults", "limits", "phases", "completion"]);
const INPUT_FIELD_KEYS = new Set(["type", "required", "default"]);
const DEFAULT_KEYS = new Set(["timeoutMs", "maxAttempts"]);
const LIMIT_KEYS = new Set(["maxConcurrency", "maxTotalAttempts"]);
const PHASE_KEYS = new Set([
  "id", "kind", "dependsOn", "access", "workspace", "resultMode", "outputSchema", "input",
  "role", "agent", "command", "integrate", "retry", "timeoutMs",
]);
const WORKSPACE_KEYS = new Set(["mode"]);
const AGENT_KEYS = new Set(["name", "provider", "model", "fallbacks"]);
const AGENT_ROUTE_KEYS = new Set(["provider", "model"]);
const COMMAND_KEYS = new Set(["executable", "args", "cwd", "env", "timeoutMs", "maxOutputBytes"]);
const INTEGRATE_KEYS = new Set(["sources", "strategy"]);
const RETRY_KEYS = new Set(["on", "maxAttempts"]);
const COMPLETION_KEYS = new Set(["terminalPhase", "require"]);

export const NEXT_LIMITS = Object.freeze({
  MAX_PHASES: 64,
  MAX_CONCURRENCY: 16,
  MAX_ATTEMPTS_PER_PHASE: 5,
  MAX_TOTAL_ATTEMPTS: 128,
  MAX_TIMEOUT_MS: 60 * 60 * 1000,
  MAX_INPUT_FIELDS: 64,
  MAX_COMMAND_ARGS: 128,
  MAX_STRING_CHARS: 32_000,
  MAX_OUTPUT_BYTES: 4 * 1024 * 1024,
});

export class WorkflowCompileError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(code: string, message: string, fieldPath?: string) {
    super(`${code}${fieldPath ? ` at ${fieldPath}` : ""}: ${message}`);
    this.name = "WorkflowCompileError";
    this.code = code;
    this.path = fieldPath;
  }
}

export interface CompileOptions {
  schemas?: OutputSchemaRegistry;
}

export function compileWorkflow(source: unknown, options: CompileOptions = {}): CompiledWorkflow {
  const schemas = options.schemas ?? createBuiltinSchemaRegistry();
  const doc = expectRecord(source, "workflow");
  rejectUnknown(doc, WORKFLOW_KEYS, "workflow");
  if (doc.schemaVersion !== NEXT_SCHEMA_VERSION) {
    fail("UNSUPPORTED_SCHEMA_VERSION", `schemaVersion must be ${NEXT_SCHEMA_VERSION}`, "schemaVersion");
  }

  const name = safeId(doc.name, "name", 96);
  const description = optionalString(doc.description, "description", 4_000);
  const inputs = compileInputs(doc.inputs);
  const defaultsDoc = optionalRecord(doc.defaults, "defaults");
  rejectUnknown(defaultsDoc, DEFAULT_KEYS, "defaults");
  const defaultTimeoutMs = integer(defaultsDoc.timeoutMs, "defaults.timeoutMs", 1, NEXT_LIMITS.MAX_TIMEOUT_MS, 15 * 60 * 1000);
  const defaultMaxAttempts = integer(defaultsDoc.maxAttempts, "defaults.maxAttempts", 1, NEXT_LIMITS.MAX_ATTEMPTS_PER_PHASE, 1);

  const limitsDoc = optionalRecord(doc.limits, "limits");
  rejectUnknown(limitsDoc, LIMIT_KEYS, "limits");
  const maxConcurrency = integer(limitsDoc.maxConcurrency, "limits.maxConcurrency", 1, NEXT_LIMITS.MAX_CONCURRENCY, 4);
  const maxTotalAttempts = integer(limitsDoc.maxTotalAttempts, "limits.maxTotalAttempts", 1, NEXT_LIMITS.MAX_TOTAL_ATTEMPTS, NEXT_LIMITS.MAX_TOTAL_ATTEMPTS);

  if (!Array.isArray(doc.phases) || doc.phases.length < 1 || doc.phases.length > NEXT_LIMITS.MAX_PHASES) {
    fail("INVALID_PHASES", `phases must contain 1-${NEXT_LIMITS.MAX_PHASES} entries`, "phases");
  }

  const phases = (doc.phases as unknown[]).map((value, index) => compilePhase(
    value,
    index,
    defaultTimeoutMs,
    defaultMaxAttempts,
    schemas,
  ));
  phases.sort((a, b) => a.id.localeCompare(b.id));
  assertGraph(phases);
  assertExpressions(phases, inputs);
  assertWorkspacePolicy(phases);
  assertIntegrationPolicy(phases);

  const maximumAttempts = phases.reduce((total, phase) => total + phase.retry.maxAttempts, 0);
  if (maximumAttempts > maxTotalAttempts) {
    fail("IMPOSSIBLE_ATTEMPT_BUDGET", `phase retry policies require up to ${maximumAttempts} attempts, exceeding maxTotalAttempts=${maxTotalAttempts}`, "limits.maxTotalAttempts");
  }

  const completion = compileCompletion(doc.completion, phases);
  assertTerminalCoversGraph(completion, phases);

  const ir: CanonicalWorkflowIR = {
    schemaVersion: NEXT_SCHEMA_VERSION,
    name,
    description,
    inputs,
    defaults: { timeoutMs: defaultTimeoutMs, maxAttempts: defaultMaxAttempts },
    limits: { maxConcurrency, maxTotalAttempts },
    phases,
    completion,
  };
  const canonicalJson = stableStringify(ir);
  const hash = createHash("sha256").update(canonicalJson).digest("hex");
  const schedule = buildDryRunSchedule(ir, hash);
  return { ir: deepClone(ir), canonicalJson, hash, schedule };
}

export function validateWorkflowInput(
  workflow: CanonicalWorkflowIR,
  supplied: Record<string, unknown>,
): Record<string, JsonPrimitive> {
  const unknown = Object.keys(supplied).filter((key) => !Object.hasOwn(workflow.inputs, key));
  if (unknown.length) fail("UNKNOWN_INPUT", `unknown workflow input(s): ${unknown.sort().join(", ")}`, "inputs");
  const resolved: Record<string, JsonPrimitive> = {};
  for (const key of Object.keys(workflow.inputs).sort()) {
    const field = workflow.inputs[key];
    const value = Object.hasOwn(supplied, key) ? supplied[key] : field.default;
    if (value === undefined) {
      if (field.required) fail("MISSING_INPUT", `required input ${key} was not supplied`, `inputs.${key}`);
      continue;
    }
    if (typeof value !== field.type) {
      fail("INVALID_INPUT", `expected ${field.type}, got ${value === null ? "null" : typeof value}`, `inputs.${key}`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) fail("INVALID_INPUT", "number must be finite", `inputs.${key}`);
    resolved[key] = value as JsonPrimitive;
  }
  return resolved;
}

export function buildDryRunSchedule(ir: CanonicalWorkflowIR, workflowHash: string): DryRunSchedule {
  const byId = new Map(ir.phases.map((phase) => [phase.id, phase]));
  const waves: DryRunSchedule["waves"] = topologicalWaveIds(ir.phases).map((wave) => wave.map((id) => {
    const phase = byId.get(id)!;
    return {
      id,
      kind: phase.kind,
      access: phase.access,
      workspace: phase.workspace.mode,
      resultMode: phase.resultMode,
      maxAttempts: phase.retry.maxAttempts,
    };
  }));
  return {
    workflow: ir.name,
    workflowHash,
    maxConcurrency: ir.limits.maxConcurrency,
    maximumAttempts: ir.phases.reduce((total, phase) => total + phase.retry.maxAttempts, 0),
    waves,
  };
}

function compileInputs(value: unknown): Record<string, CompiledInputField> {
  const source = optionalRecord(value, "inputs");
  const keys = Object.keys(source).sort();
  if (keys.length > NEXT_LIMITS.MAX_INPUT_FIELDS) fail("INPUT_LIMIT_EXCEEDED", `at most ${NEXT_LIMITS.MAX_INPUT_FIELDS} inputs are allowed`, "inputs");
  const result: Record<string, CompiledInputField> = {};
  for (const key of keys) {
    if (!/^[a-z][a-zA-Z0-9_-]*$/.test(key)) fail("INVALID_INPUT_NAME", `unsafe input name ${JSON.stringify(key)}`, `inputs.${key}`);
    const field = expectRecord(source[key], `inputs.${key}`) as unknown as InputFieldSpec & Record<string, unknown>;
    rejectUnknown(field, INPUT_FIELD_KEYS, `inputs.${key}`);
    if (!(["string", "number", "boolean"] as unknown[]).includes(field.type)) fail("INVALID_INPUT_FIELD", "type must be string, number, or boolean", `inputs.${key}.type`);
    const required = field.required === undefined ? field.default === undefined : expectBoolean(field.required, `inputs.${key}.required`);
    if (field.default !== undefined) {
      if (field.default === null || typeof field.default !== field.type) fail("INVALID_INPUT_DEFAULT", `default does not match ${String(field.type)}`, `inputs.${key}.default`);
      if (typeof field.default === "number" && !Number.isFinite(field.default)) fail("INVALID_INPUT_DEFAULT", "default number must be finite", `inputs.${key}.default`);
    }
    result[key] = {
      type: field.type,
      required,
      ...(field.default !== undefined ? { default: field.default } : {}),
    };
  }
  return result;
}

function compilePhase(
  value: unknown,
  index: number,
  defaultTimeoutMs: number,
  defaultMaxAttempts: number,
  schemas: OutputSchemaRegistry,
): CompiledPhase {
  const label = `phases[${index}]`;
  const phase = expectRecord(value, label) as unknown as WorkflowPhaseSpec & Record<string, unknown>;
  rejectUnknown(phase, PHASE_KEYS, label);
  const id = safeId(phase.id, `${label}.id`, 96);
  if (!(["agent", "deterministic-command", "join", "integrate"] as unknown[]).includes(phase.kind)) fail("INVALID_PHASE_KIND", "kind must be agent, deterministic-command, join, or integrate", `${label}.kind`);
  const dependsOn = phase.dependsOn === undefined ? [] : stringArray(phase.dependsOn, `${label}.dependsOn`, NEXT_LIMITS.MAX_PHASES, 96).map((entry) => safeId(entry, `${label}.dependsOn`, 96)).sort();
  if (new Set(dependsOn).size !== dependsOn.length) fail("DUPLICATE_DEPENDENCY", `phase ${id} has duplicate dependencies`, `${label}.dependsOn`);
  if (!(["read-only", "workspace-write"] as unknown[]).includes(phase.access)) fail("INVALID_ACCESS_MODE", "access must be read-only or workspace-write", `${label}.access`);
  if (!(["informational", "gate", "deterministic"] as unknown[]).includes(phase.resultMode)) fail("INVALID_RESULT_MODE", "invalid resultMode", `${label}.resultMode`);
  const outputSchema = string(phase.outputSchema, `${label}.outputSchema`, 128);
  if (!SAFE_SCHEMA.test(outputSchema) || !schemas.has(outputSchema)) fail("UNKNOWN_OUTPUT_SCHEMA", `output schema ${JSON.stringify(outputSchema)} is not registered`, `${label}.outputSchema`);

  const workspaceDoc = optionalRecord(phase.workspace, `${label}.workspace`);
  rejectUnknown(workspaceDoc, WORKSPACE_KEYS, `${label}.workspace`);
  const workspaceMode = workspaceDoc.mode === undefined ? "shared" : string(workspaceDoc.mode, `${label}.workspace.mode`, 16);
  if (workspaceMode !== "shared" && workspaceMode !== "isolated") fail("INVALID_WORKSPACE_MODE", "workspace mode must be shared or isolated", `${label}.workspace.mode`);
  const timeoutMs = integer(phase.timeoutMs, `${label}.timeoutMs`, 1, NEXT_LIMITS.MAX_TIMEOUT_MS, defaultTimeoutMs);
  const retry = compileRetry(phase.retry, `${label}.retry`, defaultMaxAttempts);
  const input = phase.input === undefined ? {} : jsonObject(phase.input, `${label}.input`);

  const common = {
    id,
    kind: phase.kind,
    dependsOn,
    access: phase.access as AccessMode,
    workspace: { mode: workspaceMode },
    resultMode: phase.resultMode,
    outputSchema,
    input,
    retry,
    timeoutMs,
  } as const;

  if (phase.kind === "agent") {
    if (phase.command !== undefined || phase.integrate !== undefined) fail("PHASE_CONTRACT_CONFLICT", "agent phase cannot declare command or integrate", label);
    const role = safeToken(phase.role, `${label}.role`, 64);
    const agentDoc = expectRecord(phase.agent, `${label}.agent`);
    rejectUnknown(agentDoc, AGENT_KEYS, `${label}.agent`);
    const fallbacks = agentDoc.fallbacks === undefined
      ? []
      : compileAgentFallbacks(agentDoc.fallbacks, `${label}.agent.fallbacks`);
    const agent = {
      name: safeToken(agentDoc.name, `${label}.agent.name`, 128),
      ...(agentDoc.provider === undefined ? {} : { provider: safeToken(agentDoc.provider, `${label}.agent.provider`, 128) }),
      ...(agentDoc.model === undefined ? {} : { model: modelToken(agentDoc.model, `${label}.agent.model`) }),
      ...(fallbacks.length ? { fallbacks } : {}),
    };
    if (phase.resultMode === "deterministic") fail("PHASE_CONTRACT_CONFLICT", "agent phases cannot use deterministic resultMode", `${label}.resultMode`);
    if (phase.resultMode === "gate" && outputSchema !== "verification-v1") {
      fail("PHASE_CONTRACT_CONFLICT", "gate phases require verification-v1 until schema metadata can provide a typed semantic extractor", `${label}.outputSchema`);
    }
    return { ...common, role, agent } as CompiledPhase;
  }

  if (phase.kind === "deterministic-command") {
    if (phase.agent !== undefined || phase.role !== undefined || phase.integrate !== undefined) fail("PHASE_CONTRACT_CONFLICT", "command phase cannot declare role, agent, or integrate", label);
    if (phase.resultMode !== "deterministic" || outputSchema !== "command-result-v1") {
      fail("PHASE_CONTRACT_CONFLICT", "command phase requires deterministic resultMode and command-result-v1 schema", label);
    }
    return { ...common, command: compileCommand(phase.command, `${label}.command`, timeoutMs) } as CompiledPhase;
  }

  if (phase.kind === "integrate") {
    if (phase.agent !== undefined || phase.role !== undefined || phase.command !== undefined) fail("PHASE_CONTRACT_CONFLICT", "integrate phase cannot declare role, agent, or command", label);
    if (phase.access !== "workspace-write" || workspaceMode !== "shared" || phase.resultMode !== "deterministic" || outputSchema !== "integration-result-v1") {
      fail("PHASE_CONTRACT_CONFLICT", "integrate phase must be workspace-write/shared/deterministic with integration-result-v1 schema", label);
    }
    const integrateDoc = expectRecord(phase.integrate, `${label}.integrate`);
    rejectUnknown(integrateDoc, INTEGRATE_KEYS, `${label}.integrate`);
    const sources = stringArray(integrateDoc.sources, `${label}.integrate.sources`, NEXT_LIMITS.MAX_PHASES, 96)
      .map((entry) => safeId(entry, `${label}.integrate.sources`, 96))
      .sort();
    if (!sources.length || new Set(sources).size !== sources.length) fail("INVALID_INTEGRATION", "integrate.sources must contain unique phase ids", `${label}.integrate.sources`);
    const strategy = integrateDoc.strategy === undefined ? "apply-clean" : string(integrateDoc.strategy, `${label}.integrate.strategy`, 32);
    if (strategy !== "apply-clean") fail("INVALID_INTEGRATION", "only apply-clean integration is supported", `${label}.integrate.strategy`);
    if (JSON.stringify(sources) !== JSON.stringify(dependsOn)) {
      fail("INVALID_INTEGRATION", "integrate.sources must exactly match dependsOn so every candidate is dependency-pinned", `${label}.integrate.sources`);
    }
    return { ...common, integrate: { sources, strategy }, retry: { on: [], maxAttempts: 1 } } as CompiledPhase;
  }

  if (phase.agent !== undefined || phase.role !== undefined || phase.command !== undefined || phase.integrate !== undefined) fail("PHASE_CONTRACT_CONFLICT", "join phase cannot declare role, agent, command, or integrate", label);
  if (phase.access !== "read-only" || workspaceMode !== "shared" || phase.resultMode !== "informational" || outputSchema !== "join-v1") {
    fail("PHASE_CONTRACT_CONFLICT", "join phase must be read-only/shared/informational with join-v1 schema", label);
  }
  if (!dependsOn.length) fail("INVALID_JOIN", "join phase requires at least one dependency", `${label}.dependsOn`);
  return { ...common, retry: { on: [], maxAttempts: 1 } } as CompiledPhase;
}

function compileAgentFallbacks(value: unknown, label: string): Array<{ provider?: string; model?: string }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
    fail("INVALID_AGENT_FALLBACKS", "fallbacks must contain 1-5 route objects", label);
  }
  return value.map((entry, index) => {
    const route = expectRecord(entry, `${label}[${index}]`);
    rejectUnknown(route, AGENT_ROUTE_KEYS, `${label}[${index}]`);
    const provider = route.provider === undefined ? undefined : safeToken(route.provider, `${label}[${index}].provider`, 128);
    const model = route.model === undefined ? undefined : modelToken(route.model, `${label}[${index}].model`);
    if (!provider && !model) fail("INVALID_AGENT_FALLBACKS", "fallback route must set provider or model", `${label}[${index}]`);
    return { ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
  });
}

function compileRetry(value: unknown, label: string, defaultMaxAttempts: number): { on: FailureCategory[]; maxAttempts: number } {
  const retry = optionalRecord(value, label) as unknown as RetrySpec & Record<string, unknown>;
  rejectUnknown(retry, RETRY_KEYS, label);
  const on = retry.on === undefined ? [] : stringArray(retry.on, `${label}.on`, ALL_FAILURE_CATEGORIES.length, 64) as FailureCategory[];
  for (const category of on) {
    if (!ALL_FAILURE_CATEGORIES.includes(category)) fail("INVALID_RETRY_CATEGORY", `unknown failure category ${category}`, `${label}.on`);
    if (!RETRYABLE_CATEGORIES.has(category)) fail("UNSAFE_RETRY_CATEGORY", `${category} is not eligible for automatic retry`, `${label}.on`);
  }
  const unique = [...new Set(on)].sort() as FailureCategory[];
  const maxAttempts = integer(retry.maxAttempts, `${label}.maxAttempts`, 1, NEXT_LIMITS.MAX_ATTEMPTS_PER_PHASE, defaultMaxAttempts);
  if (maxAttempts > 1 && !unique.length) fail("INVALID_RETRY_POLICY", "maxAttempts > 1 requires at least one retry category", label);
  return { on: unique, maxAttempts };
}

function compileCommand(value: unknown, label: string, phaseTimeoutMs: number): CommandSpec {
  const command = expectRecord(value, label);
  rejectUnknown(command, COMMAND_KEYS, label);
  const executable = safeToken(command.executable, `${label}.executable`, 128);
  const args = stringArray(command.args, `${label}.args`, NEXT_LIMITS.MAX_COMMAND_ARGS, 8_192);
  const cwd = command.cwd === undefined ? "." : string(command.cwd, `${label}.cwd`, 4_096);
  if (path.isAbsolute(cwd) || cwd.split(/[\\/]+/).includes("..")) fail("UNSAFE_COMMAND_CWD", "command cwd must stay beneath the phase workspace", `${label}.cwd`);
  const envDoc = optionalRecord(command.env, `${label}.env`);
  const env: Record<string, string> = {};
  for (const key of Object.keys(envDoc).sort()) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) fail("UNSAFE_COMMAND_ENV", `unsafe environment key ${key}`, `${label}.env.${key}`);
    if (FORBIDDEN_COMMAND_ENV.has(key) || key.startsWith("DYLD_")) {
      fail("UNSAFE_COMMAND_ENV", `${key} can alter executable or loader behavior and is host-owned`, `${label}.env.${key}`);
    }
    env[key] = string(envDoc[key], `${label}.env.${key}`, 8_192);
  }
  return {
    executable,
    args,
    cwd,
    env,
    timeoutMs: integer(command.timeoutMs, `${label}.timeoutMs`, 1, NEXT_LIMITS.MAX_TIMEOUT_MS, phaseTimeoutMs),
    maxOutputBytes: integer(command.maxOutputBytes, `${label}.maxOutputBytes`, 1, NEXT_LIMITS.MAX_OUTPUT_BYTES, 256 * 1024),
  };
}

function compileCompletion(value: unknown, phases: CompiledPhase[]): CanonicalWorkflowIR["completion"] {
  const completion = expectRecord(value, "completion") as unknown as CompletionSpec & Record<string, unknown>;
  rejectUnknown(completion, COMPLETION_KEYS, "completion");
  const terminalPhase = safeId(completion.terminalPhase, "completion.terminalPhase", 96);
  const phase = phases.find((candidate) => candidate.id === terminalPhase);
  if (!phase) fail("INVALID_COMPLETION", `terminal phase ${terminalPhase} does not exist`, "completion.terminalPhase");
  const require = completion.require ?? (phase!.resultMode === "gate" ? "pass" : "success");
  if (require !== "success" && require !== "pass") fail("INVALID_COMPLETION", "require must be success or pass", "completion.require");
  if (phase!.resultMode === "gate" && require !== "pass") fail("INVALID_COMPLETION", "gate terminal phases must require semantic pass", "completion.require");
  if (require === "pass" && phase!.resultMode !== "gate") fail("INVALID_COMPLETION", "require=pass needs a gate terminal phase", "completion.require");
  return { terminalPhase, require };
}

function assertGraph(phases: CompiledPhase[]): void {
  const ids = new Set<string>();
  for (const phase of phases) {
    if (ids.has(phase.id)) fail("DUPLICATE_PHASE_ID", `duplicate phase id ${phase.id}`, "phases");
    ids.add(phase.id);
  }
  for (const phase of phases) {
    for (const dependency of phase.dependsOn) {
      if (!ids.has(dependency)) fail("MISSING_DEPENDENCY", `phase ${phase.id} depends on missing phase ${dependency}`, `phases.${phase.id}.dependsOn`);
      if (dependency === phase.id) fail("WORKFLOW_CYCLE", `phase ${phase.id} depends on itself`, `phases.${phase.id}.dependsOn`);
    }
  }
  topologicalWaveIds(phases);
}

function topologicalWaveIds(phases: CompiledPhase[]): string[][] {
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  const remaining = new Set(phases.map((phase) => phase.id));
  const done = new Set<string>();
  const waves: string[][] = [];
  while (remaining.size) {
    const ready = [...remaining]
      .filter((id) => byId.get(id)!.dependsOn.every((dependency) => done.has(dependency)))
      .sort();
    if (!ready.length) fail("INVALID_WORKFLOW_GRAPH", "workflow graph contains a cycle", "phases");
    waves.push(ready);
    for (const id of ready) {
      remaining.delete(id);
      done.add(id);
    }
  }
  return waves;
}

function assertExpressions(phases: CompiledPhase[], inputs: Record<string, CompiledInputField>): void {
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  const ancestors = new Map<string, Set<string>>();
  const visit = (id: string): Set<string> => {
    const cached = ancestors.get(id);
    if (cached) return cached;
    const found = new Set<string>();
    for (const dependency of byId.get(id)!.dependsOn) {
      found.add(dependency);
      for (const ancestor of visit(dependency)) found.add(ancestor);
    }
    ancestors.set(id, found);
    return found;
  };
  for (const phase of phases) {
    walkJson(phase.input, `phases.${phase.id}.input`, (text, fieldPath) => {
      if (!text.includes("${")) return;
      const match = FULL_EXPRESSION.exec(text);
      if (!match) fail("INVALID_EXPRESSION", "expressions must occupy the complete string and use inputs.*, phases.*.output, or workspace.root", fieldPath);
      if (match[2] && !Object.hasOwn(inputs, match[2])) fail("UNKNOWN_EXPRESSION_INPUT", `unknown input ${match[2]}`, fieldPath);
      if (match[3] && !visit(phase.id).has(match[3])) fail("UNREADY_PHASE_REFERENCE", `phase ${phase.id} cannot reference non-ancestor ${match[3]}`, fieldPath);
    });
  }
}

function assertWorkspacePolicy(phases: CompiledPhase[]): void {
  const sharedWriters = phases.filter((phase) => phase.access === "workspace-write" && phase.workspace.mode === "shared");
  if (sharedWriters.length > 1) {
    fail("SHARED_WORKSPACE_WRITER_CONFLICT", `shared workspace permits exactly one writer; found ${sharedWriters.map((phase) => phase.id).join(", ")}`, "phases");
  }
  for (const phase of phases) {
    if (phase.workspace.mode === "isolated" && phase.access !== "workspace-write") {
      fail("INVALID_ISOLATED_WORKSPACE", `isolated phase ${phase.id} must be a writer`, `phases.${phase.id}.workspace`);
    }
    if (phase.kind === "integrate" && phase.workspace.mode !== "shared") {
      fail("INVALID_INTEGRATION", `integrate phase ${phase.id} must use the shared product workspace`, `phases.${phase.id}.workspace`);
    }
  }
}

function assertIntegrationPolicy(phases: CompiledPhase[]): void {
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  const integrated = new Set<string>();
  for (const phase of phases.filter((candidate) => candidate.kind === "integrate")) {
    for (const sourceId of phase.integrate!.sources) {
      const source = byId.get(sourceId);
      if (!source) fail("MISSING_DEPENDENCY", `integration source ${sourceId} does not exist`, `phases.${phase.id}.integrate.sources`);
      if (source.access !== "workspace-write" || source.workspace.mode !== "isolated") {
        fail("INVALID_INTEGRATION_SOURCE", `integration source ${sourceId} must be an isolated writer`, `phases.${phase.id}.integrate.sources`);
      }
      if (integrated.has(sourceId)) fail("DUPLICATE_INTEGRATION_SOURCE", `isolated candidate ${sourceId} is integrated more than once`, "phases");
      integrated.add(sourceId);
    }
  }
  const orphaned = phases.filter((phase) => phase.access === "workspace-write" && phase.workspace.mode === "isolated" && !integrated.has(phase.id));
  if (orphaned.length) fail("UNINTEGRATED_ISOLATED_WRITER", `isolated writer candidates are never integrated: ${orphaned.map((phase) => phase.id).join(", ")}`, "phases");
}

function assertTerminalCoversGraph(completion: CanonicalWorkflowIR["completion"], phases: CompiledPhase[]): void {
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  const covered = new Set<string>();
  const visit = (id: string): void => {
    if (covered.has(id)) return;
    covered.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
  };
  visit(completion.terminalPhase);
  const uncovered = phases.map((phase) => phase.id).filter((id) => !covered.has(id));
  if (uncovered.length) fail("UNREACHABLE_PHASE", `terminal phase does not depend on: ${uncovered.join(", ")}`, "completion.terminalPhase");
}

export function stableStringify(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(item as Record<string, unknown>).sort()) output[key] = normalize((item as Record<string, unknown>)[key]);
      return output;
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function walkJson(value: JsonValue, fieldPath: string, visit: (text: string, fieldPath: string) => void): void {
  if (typeof value === "string") return visit(value, fieldPath);
  if (Array.isArray(value)) return value.forEach((item, index) => walkJson(item, `${fieldPath}[${index}]`, visit));
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) walkJson(item, `${fieldPath}.${key}`, visit);
  }
}

function jsonObject(value: unknown, fieldPath: string): JsonObject {
  const object = expectRecord(value, fieldPath);
  try {
    const cloned = JSON.parse(JSON.stringify(object)) as JsonObject;
    if (JSON.stringify(cloned) !== JSON.stringify(object)) fail("INVALID_JSON_VALUE", "input must contain only JSON values", fieldPath);
    return cloned;
  } catch (error) {
    if (error instanceof WorkflowCompileError) throw error;
    fail("INVALID_JSON_VALUE", error instanceof Error ? error.message : String(error), fieldPath);
  }
}

function expectRecord(value: unknown, fieldPath: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_SCHEMA", "expected an object", fieldPath);
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown, fieldPath: string): Record<string, unknown> {
  return value === undefined ? {} : expectRecord(value, fieldPath);
}

function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>, fieldPath: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) fail("UNKNOWN_FIELD", `unknown field(s): ${unknown.sort().join(", ")}`, fieldPath);
}

function string(value: unknown, fieldPath: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail("INVALID_STRING", `expected non-empty string up to ${max} characters`, fieldPath);
  return value.trim();
}

function optionalString(value: unknown, fieldPath: string, max: number): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > max) fail("INVALID_STRING", `expected string up to ${max} characters`, fieldPath);
  return value.trim();
}

function safeId(value: unknown, fieldPath: string, max: number): string {
  const result = string(value, fieldPath, max);
  if (!SAFE_ID.test(result)) fail("UNSAFE_IDENTIFIER", "expected lowercase kebab-case identifier", fieldPath);
  return result;
}

function safeToken(value: unknown, fieldPath: string, max: number): string {
  const result = string(value, fieldPath, max);
  if (!SAFE_TOKEN.test(result)) fail("UNSAFE_TOKEN", "expected a bounded identifier token", fieldPath);
  return result;
}

function modelToken(value: unknown, fieldPath: string): string {
  const result = string(value, fieldPath, 256);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(result)) fail("UNSAFE_MODEL_TOKEN", "invalid model token", fieldPath);
  return result;
}

function stringArray(value: unknown, fieldPath: string, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) fail("INVALID_ARRAY", `expected array with at most ${maxItems} items`, fieldPath);
  return value.map((item, index) => string(item, `${fieldPath}[${index}]`, maxChars));
}

function integer(value: unknown, fieldPath: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || !Number.isFinite(value) || (value as number) < min || (value as number) > max) {
    fail("INVALID_LIMIT", `expected integer from ${min} through ${max}`, fieldPath);
  }
  return value as number;
}

function expectBoolean(value: unknown, fieldPath: string): boolean {
  if (typeof value !== "boolean") fail("INVALID_BOOLEAN", "expected boolean", fieldPath);
  return value;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fail(code: string, message: string, fieldPath?: string): never {
  throw new WorkflowCompileError(code, message, fieldPath);
}
