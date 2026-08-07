/**
 * Shape Builder Support
 * =====================
 * Neutral non-shape module providing deterministic helpers for the
 * shape-builder orchestration shape: parsing, validation, rendering,
 * lifecycle state management, anchored edits, verifier prompts, and
 * verifier-response parsing.
 *
 * This module is NOT a shape — it exports only pure functions and types,
 * and does not import substrate or shapes. It is consumed by the
 * shape-builder shape and by tests.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// ── Constants ─────────────────────────────────────────────────────────────

export const SHAPE_BUILDER_LIFECYCLE_STATUSES = [
  "proposed",
  "implementation_reported",
  /** Data-only artifact verification; unlike native code, never implies reload. */
  "declarative_verified",
  "implemented_verified",
  /** Same-process discovery for declarative workflows. */
  "runtime_discovered",
  /** Post-reload discovery retained for explicit native shapes. */
  "reloaded_discovered",
  "canary_passed",
] as const;

export type ShapeBuilderLifecycleStatus = (typeof SHAPE_BUILDER_LIFECYCLE_STATUSES)[number];

export const SHAPE_BUILDER_LIFECYCLE_RANK: Record<ShapeBuilderLifecycleStatus, number> = {
  proposed: 10,
  implementation_reported: 20,
  declarative_verified: 30,
  implemented_verified: 30,
  runtime_discovered: 40,
  reloaded_discovered: 40,
  canary_passed: 50,
};

export const SHAPE_BUILDER_SCHEMA_VERSION = 1;
export const MAX_SHAPE_BUILDER_PHASES = 8;
export const MIN_SHAPE_BUILDER_PHASES = 1;
export const MAX_SHAPE_BUILDER_MAX_SUBAGENTS = 20;
export const MIN_SHAPE_BUILDER_MAX_SUBAGENTS = 1;
export const MAX_SHAPE_BUILDER_NAME_CHARS = 64;
export const MAX_SHAPE_BUILDER_PURPOSE_CHARS = 2_000;
export const MAX_SHAPE_BUILDER_ROLE_CHARS = 64;
export const MAX_SHAPE_BUILDER_AGENT_NAME_CHARS = 128;
export const MAX_SHAPE_BUILDER_PROMPT_CHARS = 16_000;
export const MAX_SHAPE_BUILDER_EXPECTED_OUTPUT_CHARS = 4_000;
export const MAX_SHAPE_BUILDER_POLICY_CHARS = 2_000;
export const MAX_SHAPE_BUILDER_EXPLANATION_CHARS = 4_000;

const SHAPE_BUILDER_SPEC_KEYS = new Set([
  "schemaVersion", "action", "artifactKind", "scope", "targetName", "purpose",
  "phases", "maxSubagents", "maxIterations", "terminationCondition",
  "evidenceModel", "failureBehavior", "userFacingExplanation",
]);
const SHAPE_BUILDER_PHASE_KEYS = new Set([
  "name", "role", "agentName", "prompt", "expectedOutput",
]);
const SAFE_BUILDER_TOKEN = /^[a-zA-Z][a-zA-Z0-9._-]*$/;

// Collection of all reserved / registered names. Updated by shape builder.
export const RESERVED_SHAPE_NAMES: ReadonlySet<string> = new Set([
  "plan-execute-verify",
  "multi-verify-vote",
  "composable-pipeline",
  "dual-plan-synthesis-execute-verify",
  "verify-only",
  "paradigm-creator",
  "shape-builder",
  "win-console-spawn-root-cause",
  "win-lifecycle-process-trace",
  "frozen-gate-fix-loop",
  "evidence-audit",
  "independent-replication",
  "venue-rescue-synthesis",
  "preregistered-concurrency-spike",
  "m66-explicit-routing-proof",
  "ssi-single-writer-exclusive-lane",
]);

export const SHAPE_BUILDER_VERIFIER_MARKER = "SHAPE-BUILDER IMPLEMENTATION VERIFIER";

// ── Lifecycle State Types ─────────────────────────────────────────────────

export interface ShapeBuilderVerifierCheck {
  id: string;
  status: "pass" | "fail";
  citations: string[];
}

export interface ShapeBuilderVerifierCommand {
  command: string;
  exitCode: number;
  stdoutSnippet: string;
}

export interface ShapeBuilderVerifierJson {
  overall: "pass" | "fail";
  implemented_verified: boolean;
  reloadRequired: boolean;
  targetName: string;
  lifecycleStatePath: string;
  checks: ShapeBuilderVerifierCheck[];
  commands: ShapeBuilderVerifierCommand[];
  failReasons: string[];
}

/** Deterministic verification contract for ordinary declarative builds. */
export interface ShapeBuilderDeclarativeVerification {
  overall: "pass";
  implemented_verified: true;
  reloadRequired: false;
  targetName: string;
  artifactKind: "declarative-workflow";
  scope: "user" | "project";
  sourcePath: string;
  contentHash: string;
  schemaVersion: number;
  checks: Array<{
    id: "schema" | "trusted-write" | "runtime-discovery" | "deterministic-canary";
    status: "pass";
    citation: string;
  }>;
}

export interface ShapeBuilderAnchoredEdit {
  path: string;
  anchor: string;
  action: "insert" | "replace";
  content: string;
}

export interface ShapeBuilderLifecycleState {
  schemaVersion: 1;
  targetName: string;
  lifecycleStatus: ShapeBuilderLifecycleStatus;
  usable: boolean;
  reloadRequired: boolean;
  nextRequiredGate: "implementation" | "implementation_verification" | "agent_reload" | "runtime_discovery" | "canary" | "none";
  extensionRoot: string;
  lifecycleStatePath: string;
  createdAt: string;
  updatedAt: string;
  generatedFiles: string[];
  anchoredEdits: ShapeBuilderAnchoredEdit[];
  /** Absent on legacy state files; defaults conceptually to native-shape. */
  artifactKind?: "declarative-workflow" | "native-shape";
  scope?: "user" | "project";
  implementationReport?: Record<string, unknown>;
  verification?: ShapeBuilderVerifierJson | ShapeBuilderDeclarativeVerification;
  discoveryProbe?: Record<string, unknown>;
  canary?: Record<string, unknown>;
  failures: Array<{ at: string; gate: string; reason: string; evidence?: unknown }>;
  history: Array<{ at: string; from?: ShapeBuilderLifecycleStatus; to: ShapeBuilderLifecycleStatus; actor: string; evidence: unknown }>;
}

// ── Name / Identifier Helpers ─────────────────────────────────────────────

export function normalizeShapeName(input: string): string {
  return String(input ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function toIdentifier(name: string): string {
  const candidate = normalizeShapeName(name)
    .split("-")
    .map((part, index) => (index === 0 ? part : part.slice(0, 1).toUpperCase() + part.slice(1)))
    .join("") || "generated";
  return /^[a-zA-Z_]/.test(candidate) ? candidate : `shape${candidate}`;
}

export function toPascal(name: string): string {
  const id = toIdentifier(name);
  return id.slice(0, 1).toUpperCase() + id.slice(1);
}

// ── Spec Definition ──────────────────────────────────────────────────────

export interface ShapeBuilderSpecPhase {
  name: string;
  role: string;
  agentName: string;
  prompt: string;
  expectedOutput: string;
}

export interface ShapeBuilderSpec {
  schemaVersion: 1;
  action: "build";
  /** Ordinary builds are data-only and immediately discoverable. */
  artifactKind: "declarative-workflow" | "native-shape";
  /** Applies to declarative workflows; native shapes always target the extension. */
  scope: "user" | "project";
  targetName: string;
  purpose: string;
  phases: ShapeBuilderSpecPhase[];
  maxSubagents: number;
  maxIterations: number;
  terminationCondition: string;
  evidenceModel: string;
  failureBehavior: string;
  userFacingExplanation: string;
}

// ── Spec Parsing ──────────────────────────────────────────────────────────

export function parseShapeBuilderSpecFromTask(task: string): ShapeBuilderSpec | { error: string } {
  // Accept either first balanced JSON object in the task or a fenced block
  // after SHAPE_BUILDER_SPEC_JSON marker
  let jsonText: string | null = null;

  const markerIdx = task.indexOf("SHAPE_BUILDER_SPEC_JSON");
  if (markerIdx >= 0) {
    const afterMarker = task.slice(markerIdx + "SHAPE_BUILDER_SPEC_JSON".length);
    const fenceMatch = afterMarker.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonText = fenceMatch[1].trim();
    } else {
      const objMatch = extractBalancedObject(afterMarker);
      if (objMatch) jsonText = objMatch;
    }
  } else {
    jsonText = extractBalancedObject(task);
  }

  if (!jsonText) return { error: "No parseable SHAPE_BUILDER_SPEC_JSON or balanced JSON object found in task." };

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { error: "JSON parse failed for spec text." };
  }

  if (!parsed || typeof parsed !== "object") {
    return { error: "Parsed spec is not a JSON object." };
  }

  const raw = parsed as Record<string, unknown>;
  const unknownSpecKeys = Object.keys(raw).filter((key) => !SHAPE_BUILDER_SPEC_KEYS.has(key));
  if (unknownSpecKeys.length > 0) {
    return { error: `Spec contains unknown field(s): ${unknownSpecKeys.join(", ")}.` };
  }
  const scalarTypeErrors: string[] = [];
  for (const [key, expectedType] of [
    ["schemaVersion", "number"], ["action", "string"], ["artifactKind", "string"],
    ["scope", "string"], ["targetName", "string"], ["purpose", "string"],
    ["maxSubagents", "number"], ["maxIterations", "number"],
    ["terminationCondition", "string"], ["evidenceModel", "string"],
    ["failureBehavior", "string"], ["userFacingExplanation", "string"],
  ] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== expectedType) scalarTypeErrors.push(`${key} must be a ${expectedType}`);
  }
  if (scalarTypeErrors.length > 0) return { error: `Invalid spec field type(s): ${scalarTypeErrors.join("; ")}.` };
  if (raw.phases !== undefined && !Array.isArray(raw.phases)) return { error: "phases must be an array." };

  const phases: ShapeBuilderSpecPhase[] = [];
  for (const [index, item] of (Array.isArray(raw.phases) ? raw.phases : []).entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { error: `phases[${index}] must be an object.` };
    }
    const phase = item as Record<string, unknown>;
    const unknownPhaseKeys = Object.keys(phase).filter((key) => !SHAPE_BUILDER_PHASE_KEYS.has(key));
    if (unknownPhaseKeys.length > 0) {
      return { error: `phases[${index}] contains unknown field(s): ${unknownPhaseKeys.join(", ")}.` };
    }
    const nonString = [...SHAPE_BUILDER_PHASE_KEYS].filter(
      (key) => phase[key] !== undefined && typeof phase[key] !== "string",
    );
    if (nonString.length > 0) return { error: `phases[${index}] field(s) must be strings: ${nonString.join(", ")}.` };
    phases.push({
      name: String(phase.name ?? "").trim(),
      role: String(phase.role ?? "").trim(),
      agentName: String(phase.agentName ?? "").trim(),
      prompt: String(phase.prompt ?? "").trim(),
      expectedOutput: String(phase.expectedOutput ?? "").trim(),
    });
  }

  return {
    schemaVersion: raw.schemaVersion as 1,
    action: raw.action as "build",
    artifactKind: (raw.artifactKind === undefined ? "declarative-workflow" : raw.artifactKind) as ShapeBuilderSpec["artifactKind"],
    scope: (raw.scope === undefined ? "user" : raw.scope) as ShapeBuilderSpec["scope"],
    targetName: String(raw.targetName ?? "").trim(),
    purpose: String(raw.purpose ?? "").trim(),
    phases,
    maxSubagents: typeof raw.maxSubagents === "number" && Number.isFinite(raw.maxSubagents) ? Number(raw.maxSubagents) : 0,
    maxIterations: typeof raw.maxIterations === "number" && Number.isFinite(raw.maxIterations) ? Number(raw.maxIterations) : 0,
    terminationCondition: String(raw.terminationCondition ?? "").trim(),
    evidenceModel: String(raw.evidenceModel ?? "").trim(),
    failureBehavior: String(raw.failureBehavior ?? "").trim(),
    userFacingExplanation: String(raw.userFacingExplanation ?? "").trim(),
  };
}

// ── Spec Validation ───────────────────────────────────────────────────────

export function validateShapeBuilderSpec(spec: ShapeBuilderSpec, reservedNames: ReadonlySet<string>): string[] {
  const errors: string[] = [];

  if (spec.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
  if (spec.action !== "build") errors.push("action must be 'build'.");
  if (spec.artifactKind !== "declarative-workflow" && spec.artifactKind !== "native-shape") {
    errors.push("artifactKind must be 'declarative-workflow' or 'native-shape'.");
  }
  if (spec.scope !== "user" && spec.scope !== "project") {
    errors.push("scope must be 'user' or 'project'.");
  }
  if (spec.artifactKind === "native-shape" && spec.scope !== "user") {
    errors.push("native-shape builds do not accept project scope; native code is extension-owned and reload-gated.");
  }

  const rawName = String(spec.targetName ?? "").trim();
  const name = normalizeShapeName(rawName);
  if (!rawName) errors.push("targetName is required.");
  if (rawName && (rawName !== name || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(rawName))) {
    errors.push("targetName must already be safe lowercase kebab-case starting with a letter.");
  }
  if (rawName.length > MAX_SHAPE_BUILDER_NAME_CHARS) {
    errors.push(`targetName must be at most ${MAX_SHAPE_BUILDER_NAME_CHARS} characters.`);
  }
  if (name && reservedNames.has(name)) {
    errors.push(`targetName "${name}" is already registered or reserved.`);
  }

  if (!spec.purpose.trim()) errors.push("purpose is required.");
  if (spec.purpose.length > MAX_SHAPE_BUILDER_PURPOSE_CHARS) {
    errors.push(`purpose must be at most ${MAX_SHAPE_BUILDER_PURPOSE_CHARS} characters.`);
  }

  if (!Array.isArray(spec.phases) || spec.phases.length < MIN_SHAPE_BUILDER_PHASES) {
    errors.push(`At least ${MIN_SHAPE_BUILDER_PHASES} phase is required.`);
  } else if (spec.phases.length > MAX_SHAPE_BUILDER_PHASES) {
    errors.push(`At most ${MAX_SHAPE_BUILDER_PHASES} phases are allowed.`);
  } else {
    const phaseIds = new Set<string>();
    spec.phases.forEach((phase, index) => {
      const phaseId = normalizeShapeName(phase.name);
      if (!phase.name.trim()) errors.push(`Phase ${index + 1} requires a name.`);
      if (!phaseId || phaseId.length > MAX_SHAPE_BUILDER_NAME_CHARS) errors.push(`Phase ${index + 1} name must normalize to a safe ID of at most ${MAX_SHAPE_BUILDER_NAME_CHARS} characters.`);
      if (phaseId && phaseIds.has(phaseId)) errors.push(`Phase ${index + 1} duplicates normalized phase id "${phaseId}".`);
      if (phaseId) phaseIds.add(phaseId);
      if (!phase.role.trim()) errors.push(`Phase ${index + 1} requires a role.`);
      if (phase.role.length > MAX_SHAPE_BUILDER_ROLE_CHARS || (phase.role && !SAFE_BUILDER_TOKEN.test(phase.role))) errors.push(`Phase ${index + 1} role must be a bounded identifier token.`);
      if (!phase.agentName.trim()) errors.push(`Phase ${index + 1} requires an agentName.`);
      if (phase.agentName.length > MAX_SHAPE_BUILDER_AGENT_NAME_CHARS || (phase.agentName && !SAFE_BUILDER_TOKEN.test(phase.agentName))) errors.push(`Phase ${index + 1} agentName must be a bounded identifier token.`);
      if (!phase.prompt.trim()) errors.push(`Phase ${index + 1} requires a prompt.`);
      if (phase.prompt.length > MAX_SHAPE_BUILDER_PROMPT_CHARS) errors.push(`Phase ${index + 1} prompt must be at most ${MAX_SHAPE_BUILDER_PROMPT_CHARS} characters.`);
      if (!phase.expectedOutput.trim()) errors.push(`Phase ${index + 1} requires expectedOutput.`);
      if (phase.expectedOutput.length > MAX_SHAPE_BUILDER_EXPECTED_OUTPUT_CHARS) errors.push(`Phase ${index + 1} expectedOutput must be at most ${MAX_SHAPE_BUILDER_EXPECTED_OUTPUT_CHARS} characters.`);
    });
  }

  const maxSubagents = spec.maxSubagents;
  if (!Number.isFinite(maxSubagents) || !Number.isInteger(maxSubagents) || maxSubagents < MIN_SHAPE_BUILDER_MAX_SUBAGENTS || maxSubagents > MAX_SHAPE_BUILDER_MAX_SUBAGENTS) {
    errors.push(`maxSubagents must be between ${MIN_SHAPE_BUILDER_MAX_SUBAGENTS} and ${MAX_SHAPE_BUILDER_MAX_SUBAGENTS}.`);
  }
  const phaseCount = Array.isArray(spec.phases) ? spec.phases.length : 0;
  if (Number.isFinite(maxSubagents) && phaseCount > 0 && maxSubagents < phaseCount) {
    errors.push(`maxSubagents (${maxSubagents}) must be at least the number of phases (${phaseCount}).`);
  }
  if (spec.maxIterations !== 1) {
    errors.push("maxIterations must be exactly 1 — shape builder uses one sequential pass.");
  }

  for (const [field, label, max] of [
    [spec.terminationCondition, "Termination condition", MAX_SHAPE_BUILDER_POLICY_CHARS],
    [spec.evidenceModel, "Evidence model", MAX_SHAPE_BUILDER_POLICY_CHARS],
    [spec.failureBehavior, "Failure behavior", MAX_SHAPE_BUILDER_POLICY_CHARS],
    [spec.userFacingExplanation, "User-facing explanation", MAX_SHAPE_BUILDER_EXPLANATION_CHARS],
  ] as const) {
    if (!field.trim()) errors.push(`${label} is required.`);
    if (field.length > max) errors.push(`${label} must be at most ${max} characters.`);
  }

  const joined = JSON.stringify(spec).toLowerCase();
  const textScan = joined.replace(/\\"/g, '"').replace(/\\'/g, "'");
  if (/\b(?:forever|unbounded|infinite|until perfect|until it is perfect|keep iterating until)\b/.test(textScan)) {
    errors.push("Spec contains unbounded-loop language; provide a finite stopping condition.");
  }
  if (/\b(?:import|export)\b[\s\S]{0,120}\bfrom\s*["']\.\.?\//.test(textScan) || /\brequire\s*\(\s*["']\.\.?\//.test(textScan)) {
    errors.push("Spec contains sibling-import text; generated shapes may import only substrate/types via the deterministic template.");
  }
  if (/\b(?:agent_reload_runtime|agent_scheduler|executecommand|sendusermessage|orchestrate)\s*\(/.test(textScan)) {
    errors.push("Spec contains forbidden runtime-call text.");
  }

  return errors;
}

// ── Declarative Workflow Compilation ─────────────────────────────────────

/**
 * Compile the builder spec to JSON-compatible workflow data. Dependencies are
 * deliberately sequential to preserve the historical ShapeBuilderSpec phase
 * semantics without generating executable TypeScript.
 */
export function compileDeclarativeWorkflow(spec: ShapeBuilderSpec): Record<string, unknown> {
  const phases = spec.phases.map((phase, index) => {
    const id = normalizeShapeName(phase.name);
    const previousId = index > 0 ? normalizeShapeName(spec.phases[index - 1].name) : undefined;
    const routeRole = (["planner", "executor", "verifier"] as string[]).includes(phase.role.toLowerCase())
      ? phase.role.toLowerCase()
      : "inherit";
    return {
      id,
      role: phase.role,
      agentName: phase.agentName,
      prompt: phase.prompt,
      expectedOutput: phase.expectedOutput,
      dependsOn: previousId ? [previousId] : [],
      route: { role: routeRole },
    };
  });
  return {
    schemaVersion: 1,
    name: normalizeShapeName(spec.targetName),
    description: spec.purpose,
    phases,
    maxSubagents: spec.maxSubagents,
    maxConcurrency: 1,
    maxIterations: spec.maxIterations,
    continueOnFailure: false,
    terminationCondition: spec.terminationCondition,
    evidenceModel: spec.evidenceModel,
    failureBehavior: spec.failureBehavior,
    userFacingExplanation: spec.userFacingExplanation,
  };
}

// ── Native Shape Source Rendering ─────────────────────────────────────────

/** Native code generation is retained only for artifactKind=native-shape. */
export function renderShapeSource(spec: ShapeBuilderSpec): string {
  const name = normalizeShapeName(spec.targetName);
  const exportName = `${toIdentifier(name)}Shape`;
  const phases = spec.phases.map((phase) => ({
    name: String(phase.name).trim(),
    role: String(phase.role).trim(),
    agentName: String(phase.agentName).trim(),
    prompt: String(phase.prompt).trim(),
    expectedOutput: String(phase.expectedOutput).trim(),
  }));

  return `/**
 * Shape: ${name}
 * ${"=".repeat(Math.max(8, name.length + 7))}
 * ${escapeComment(spec.purpose)}
 *
 * Generated by the shape-builder deterministic constructor.
 * ONE-LINE RULE: Shapes are siblings — they stand on the substrate,
 * never build on each other.
 */

import {
  SpawnGuard,
  spawnSubagent,
  throwIfAborted,
  truncateWithNotice,
  type SubagentResult,
} from "../substrate";
import { formatRouteLabel, resolveShapePhaseRoute } from "../routes";

import type {
  OrchestrationShape,
  OrchestrationShapeContext,
  OrchestrationShapeResult,
} from "../types";

const PHASES = ${JSON.stringify(phases, null, 2)} as const;
const MAX_FINAL_CHARS = 20_000;

export const ${exportName}: OrchestrationShape = {
  name: ${JSON.stringify(name)},
  description: ${JSON.stringify(spec.purpose)},
  run: run${toPascal(name)},
};

async function run${toPascal(name)}(context: OrchestrationShapeContext): Promise<OrchestrationShapeResult> {
  const { params, signal, onUpdate, inheritedModel, agents } = context;
  const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }] });
  const requestedVerifierCount = Math.max(1, params.verifierCount);
  const requiredSpawns = PHASES.reduce(
    (total, phase) => total + (phase.role === "verifier" ? requestedVerifierCount : 1),
    0,
  );
  const spawnGuard = new SpawnGuard(Math.min(params.maxSubagents, Math.max(${Math.max(1, Math.trunc(spec.maxSubagents))}, requiredSpawns)));

  // Deterministic canary branch — no subagent spawn, no file mutation
  if (params.task.trim().startsWith("SHAPE_CANARY:${name}")) {
    return {
      markdown: "# ${name} Canary: PASS\\n\\nDeterministic generated-shape canary passed.",
      details: {
        status: "pass",
        paradigm: "${name}",
        canary: true,
        targetName: "${name}",
        spawnedCount: 0,
        spawnedCap: 0,
      },
    };
  }

  const outputs: SubagentResult[] = [];
  const outputRecords: Array<{ phase: string; role: string; instance: number; output: SubagentResult }> = [];

  for (const [index, phase] of PHASES.entries()) {
    throwIfAborted(signal);
    const instanceCount = phase.role === "verifier" ? requestedVerifierCount : 1;
    const route = resolveShapePhaseRoute(phase.role, phase.agentName, params);
    const priorOutputs = [...outputs];
    const launches = Array.from({ length: instanceCount }, (_, instanceIndex) => {
      const spawned = spawnGuard.reserve();
      emit(\`${name}: phase \${index + 1}/\${PHASES.length} \${phase.name} spawning \${phase.agentName} instance \${instanceIndex + 1}/\${instanceCount} on \${formatRouteLabel(route)} (\${spawned}/\${spawnGuard.cap}).\`);
      return spawnSubagent(
        phase.agentName,
        buildPhasePrompt(phase, params.task, priorOutputs),
        { agents, cwd: params.cwd, allowLocalModel: params.allowLocalModel, signal, inheritedModel, onProgress: emit, modelOverride: route },
      );
    });
    // Explicit verifierCount is a parallel independent-verifier contract.
    const phaseOutputs = await Promise.all(launches);
    outputs.push(...phaseOutputs);
    phaseOutputs.forEach((output, instance) => outputRecords.push({ phase: phase.name, role: phase.role, instance: instance + 1, output }));
  }

  const status = outputs.every((output) => output.exitCode === 0) ? "pass" : "fail";
  const markdown = buildReport(status, params.task, spawnGuard, outputs);
  return {
    markdown,
    details: {
      status,
      paradigm: ${JSON.stringify(name)},
      spawnedCount: spawnGuard.spawned,
      spawnedCap: spawnGuard.cap,
      terminationCondition: ${JSON.stringify(spec.terminationCondition)},
      evidenceModel: ${JSON.stringify(spec.evidenceModel)},
      failureBehavior: ${JSON.stringify(spec.failureBehavior)},
      controls: {
        executorConcurrency: params.concurrency,
        verifierCount: requestedVerifierCount,
        preflight: params.preflight,
        hardGates: params.hardGates,
        contextIsolation: "separate pi --no-session subprocess per spawn",
      },
      routingRequirements: [
        { role: "planner", agentName: params.plannerAgent, provider: params.plannerProvider, model: params.plannerModel, essential: Boolean(params.plannerProvider || params.plannerModel) },
        { role: "executor", agentName: params.executorAgent, provider: params.executorProvider, model: params.executorModel, essential: Boolean(params.executorProvider || params.executorModel) },
        { role: "verifier", agentName: params.verifierAgent, provider: params.verifierProvider, model: params.verifierModel, essential: Boolean(params.verifierProvider || params.verifierModel), count: requestedVerifierCount },
      ].filter((route) => route.essential),
      roleResults: outputRecords.map(({ phase, role, instance, output }) => ({
        phase, role, instance, agentName: output.agentName,
        provider: output.provider, model: output.model,
        isolatedContext: true, exitCode: output.exitCode,
      })),
      verifierResults: outputRecords.filter((record) => record.role === "verifier").map(({ phase, instance, output }) => ({
        phase, role: "verifier", instance, agentName: output.agentName,
        provider: output.provider, model: output.model,
        status: output.exitCode === 0 ? "pass" : "fail", isolatedContext: true,
      })),
      outputs: outputs.map((output) => ({
        agentName: output.agentName,
        provider: output.provider,
        model: output.model,
        exitCode: output.exitCode,
        durationMs: output.durationMs,
        text: truncateWithNotice(output.text, 2000, "phase output"),
      })),
    },
  };
}

function buildPhasePrompt(phase: typeof PHASES[number], originalTask: string, prior: SubagentResult[]): string {
  return [
    \`You are running phase "\${phase.name}" (role: \${phase.role}) in a bounded orchestration shape.\`,
    "Do not invoke recursive orchestration. Work only on the phase prompt below.",
    \`Original task:\\n\${originalTask}\`,
    prior.length ? \`Prior phase outputs:\\n\${prior.map((item, index) => \`[\${index + 1}] \${item.agentName}: \${truncateWithNotice(item.text, 3000, "prior output")}\`).join("\\n\\n")}\` : "Prior phase outputs: none.",
    \`Phase prompt:\\n\${phase.prompt}\`,
    \`Expected output:\\n\${phase.expectedOutput}\`,
  ].join("\\n\\n");
}

function buildReport(status: "pass" | "fail", task: string, spawnGuard: SpawnGuard, outputs: SubagentResult[]): string {
  const lines = [
    \`# ${name} Orchestration: \${status.toUpperCase()}\`,
    "",
    \`**Task:** \${truncateWithNotice(task, 2000, "task")}\`,
    \`**Subagents spawned:** \${spawnGuard.spawned}/\${spawnGuard.cap}\`,
    "**Termination:** " + ${JSON.stringify(spec.terminationCondition)},
    "**Evidence model:** " + ${JSON.stringify(spec.evidenceModel)},
    "",
    "## Phase outputs",
  ];
  outputs.forEach((output, index) => {
    lines.push(\`### Phase \${index + 1}: \${PHASES[index]?.name ?? output.agentName}\`, truncateWithNotice(output.text, 3000, "phase output"));
  });
  lines.push("", "## Orchestration Used", ${JSON.stringify(spec.userFacingExplanation)});
  return truncateWithNotice(lines.join("\\n"), MAX_FINAL_CHARS, "final report");
}
`;
}

// ── Shape Test Rendering ──────────────────────────────────────────────────

export function renderShapeTest(name: string): string {
  const kebab = normalizeShapeName(name);
  const pascal = toPascal(name);
  return `#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PI_NODE_MODULES = path.join(
  os.homedir(),
  "AppData",
  "Roaming",
  "npm",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "node_modules",
);

process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

const createJiti = require(path.join(PI_NODE_MODULES, "jiti", "lib", "jiti.cjs"));

function makeJiti() {
  return createJiti(__filename, { interopDefault: true, moduleCache: false });
}

function loadShapeModule() {
  return makeJiti()(path.join(PROJECT_ROOT, "src", "shapes", "${kebab}.ts"));
}

function testCommittedShapeStaticRules() {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, "src", "shapes", "${kebab}.ts"), "utf8");
  assert.match(source, /name:\\s*"${kebab}"/);
  assert.match(source, /SpawnGuard/);
  assert.match(source, /spawnSubagent/);
  assert.doesNotMatch(source, /from\\s+["']\\.\\//, "shape must not import sibling shapes");
  assert.doesNotMatch(source, /agent_reload_runtime\\s*\\(/, "shape must not call reload bridge");
  assert.doesNotMatch(source, /agent_scheduler\\s*\\(/, "shape must not call scheduler bridge");
  assert.doesNotMatch(source, /executeCommand\\s*\\(/, "shape must not call executeCommand");
  assert.doesNotMatch(source, /sendUserMessage\\s*\\(/, "shape must not send reload slash command");
  assert.doesNotMatch(source, /orchestrate\\s*\\(/, "shape must not call orchestrate");
}

function testCanaryBranch() {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, "src", "shapes", "${kebab}.ts"), "utf8");
  assert.match(source, /SHAPE_CANARY:${kebab}/, "generated shape must include deterministic SHAPE_CANARY branch");
  assert.match(source, /canary:\\s*true/, "canary response must include canary: true");
  assert.match(source, /spawnedCount:\\s*0/, "canary must not spawn subagents");
}

function testRegistryDiscovery() {
  // Shape must be registered: load index and probe with unknown paradigm
  const tool = loadOrchestrateTool();
  // done via loadOrchestrateTool checking shapeRegistry
}

function loadOrchestrateTool() {
  const mod = makeJiti()(path.join(PROJECT_ROOT, "src", "index.ts"));
  const extension = mod.default ?? mod;
  let tool;
  extension({
    registerTool(definition) {
      if (definition.name === "orchestrate") tool = definition;
    },
    registerCommand() {},
  });
  assert.ok(tool, "orchestrate tool should be registered");
  return tool;
}

async function run() {
  testCommittedShapeStaticRules();
  testCanaryBranch();
  console.log("PASS ${kebab}: static rules, canary branch");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
}

// ── Static Checks for Generated Shape ─────────────────────────────────────

const FORBIDDEN_RUNTIME_CALLS = [
  "agent_reload_runtime",
  "agent_scheduler",
  "executeCommand",
  "sendUserMessage",
  "orchestrate(",
  "orchestrate({",
];

export function staticCheckGeneratedShape(source: string): string[] {
  const errors: string[] = [];
  if (!/export const \w+Shape\s*:\s*OrchestrationShape/.test(source)) {
    errors.push("Generated shape must export an OrchestrationShape constant.");
  }
  if (!/new SpawnGuard\(/.test(source)) errors.push("Generated shape must use SpawnGuard.");
  if (!/spawnSubagent\(/.test(source)) errors.push("Generated shape must use spawnSubagent.");
  if (!/SHAPE_CANARY:/.test(source)) errors.push("Generated shape must include a deterministic SHAPE_CANARY branch.");
  if (!/canary:\s*true/.test(source)) errors.push("Generated shape canary response must include canary: true.");
  if (/from\s+["']\.\//.test(source)) errors.push("Generated shape must not import sibling shapes.");
  if (/while\s*\(\s*true\s*\)/i.test(source)) errors.push("Generated shape must not contain while(true).");
  if (/for\s*\(\s*;\s*;\s*\)/.test(source)) errors.push("Generated shape must not contain an infinite for loop.");
  for (const forbidden of FORBIDDEN_RUNTIME_CALLS) {
    if (source.includes(forbidden)) errors.push(`Generated shape must not contain forbidden runtime call: ${forbidden}.`);
  }
  return errors;
}

// ── Extension Root Resolution ─────────────────────────────────────────────

export function resolveExtensionRoot(importMetaUrl: string): string {
  const explicit = process.env.PI_SHAPE_BUILDER_EXTENSION_ROOT;
  if (explicit && explicit.trim()) return path.resolve(explicit.trim());

  // From src/shapes/shape-builder.ts → go up to extension root
  const shapeDir = path.dirname(fileURLToPath(importMetaUrl));
  return path.resolve(shapeDir, "..", "..");
}

export function verifyExtensionRoot(root: string): string[] {
  const errors: string[] = [];
  const required = ["src/index.ts", "package.json", "README.md", "PARADIGMS.md"];
  for (const file of required) {
    if (!existsSync(path.join(root, file))) {
      errors.push(`Extension root ${root} missing required file: ${file}.`);
    }
  }
  return errors;
}

// ── Resolve Path Inside Extension Root ────────────────────────────────────

export function resolveInRoot(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  // Safety: must stay inside extensionRoot
  const normalizedRoot = path.resolve(root) + path.sep;
  if (!path.resolve(resolved).startsWith(normalizedRoot)) {
    throw new Error(`Path ${relative} escapes extension root ${root}.`);
  }
  return resolved;
}

// ── Lifecycle State Management ────────────────────────────────────────────

export function lifecycleStatePath(extensionRoot: string, targetName: string): string {
  return path.join(extensionRoot, "shape-builder-lifecycle", `${targetName}.json`);
}

export function computeUsable(status: ShapeBuilderLifecycleStatus): boolean {
  return status === "canary_passed";
}

export function computeReloadRequired(status: ShapeBuilderLifecycleStatus): boolean {
  return status === "implemented_verified";
}

export function computeNextRequiredGate(status: ShapeBuilderLifecycleStatus): ShapeBuilderLifecycleState["nextRequiredGate"] {
  switch (status) {
    case "proposed": return "implementation";
    case "implementation_reported": return "implementation_verification";
    case "declarative_verified": return "runtime_discovery";
    case "implemented_verified": return "agent_reload";
    case "runtime_discovered": return "canary";
    case "reloaded_discovered": return "canary";
    case "canary_passed": return "none";
  }
}

export function transitionLifecycleState(
  current: ShapeBuilderLifecycleStatus,
  next: ShapeBuilderLifecycleStatus,
): { ok: true } | { ok: false; error: string } {
  const currentRank = SHAPE_BUILDER_LIFECYCLE_RANK[current];
  const nextRank = SHAPE_BUILDER_LIFECYCLE_RANK[next];

  // Allow same-status write (idempotent — for adding evidence/failure data),
  // but never cross between native and declarative statuses at the same rank.
  if (current === next) return { ok: true };
  if (currentRank === nextRank) {
    return { ok: false, error: `Incompatible lifecycle transition from "${current}" to "${next}".` };
  }

  // Forward transitions only — must be exactly adjacent
  const allowedForward = nextRank === currentRank + 10;

  if (allowedForward) return { ok: true };

  if (nextRank < currentRank) {
    return { ok: false, error: `Backward transition from "${current}" to "${next}" is not allowed.` };
  }

  return { ok: false, error: `Skipped transition from "${current}" to "${next}" — only adjacent forward transitions are allowed.` };
}

export function buildInitialLifecycleState(
  extensionRoot: string,
  targetName: string,
  generatedFiles: string[],
  anchoredEdits: ShapeBuilderAnchoredEdit[],
): ShapeBuilderLifecycleState {
  const now = new Date().toISOString();
  const statePath = lifecycleStatePath(extensionRoot, targetName);
  return {
    schemaVersion: 1,
    targetName,
    lifecycleStatus: "proposed",
    usable: false,
    reloadRequired: false,
    nextRequiredGate: "implementation",
    extensionRoot,
    lifecycleStatePath: statePath,
    createdAt: now,
    updatedAt: now,
    generatedFiles,
    anchoredEdits,
    failures: [],
    history: [{ at: now, to: "proposed", actor: "shape-builder", evidence: { phase: "initial" } }],
  };
}

export async function writeLifecycleState(
  state: ShapeBuilderLifecycleState,
): Promise<void> {
  const dir = path.dirname(state.lifecycleStatePath);
  await mkdir(dir, { recursive: true });
  const trustedRoot = realpathSync.native(path.resolve(state.extensionRoot));
  const trustedDirectory = realpathSync.native(path.resolve(dir));
  const relative = path.relative(trustedRoot, trustedDirectory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Lifecycle path escapes trusted root: ${state.lifecycleStatePath}`);
  }
  if (existsSync(state.lifecycleStatePath) && lstatSync(state.lifecycleStatePath).isSymbolicLink()) {
    throw new Error(`Refusing to replace symlink lifecycle state: ${state.lifecycleStatePath}`);
  }
  const temporary = path.join(trustedDirectory, `.${path.basename(state.lifecycleStatePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    await rename(temporary, state.lifecycleStatePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readLifecycleState(filePath: string): Promise<ShapeBuilderLifecycleState | null> {
  try {
    if (!existsSync(filePath)) return null;
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as ShapeBuilderLifecycleState;
  } catch {
    return null;
  }
}

export function transitionAndUpdateState(
  state: ShapeBuilderLifecycleState,
  to: ShapeBuilderLifecycleStatus,
  actor: string,
  evidence: Record<string, unknown>,
): { success: true; state: ShapeBuilderLifecycleState } | { success: false; error: string } {
  const result = transitionLifecycleState(state.lifecycleStatus, to);
  if (!result.ok) return { success: false, error: result.error };

  const now = new Date().toISOString();
  const updated: ShapeBuilderLifecycleState = {
    ...state,
    lifecycleStatus: to,
    usable: computeUsable(to),
    reloadRequired: computeReloadRequired(to),
    nextRequiredGate: computeNextRequiredGate(to),
    updatedAt: now,
    history: [...state.history, { at: now, from: state.lifecycleStatus, to, actor, evidence }],
  };
  return { success: true, state: updated };
}

export function recordFailure(
  state: ShapeBuilderLifecycleState,
  gate: string,
  reason: string,
  evidence?: unknown,
): ShapeBuilderLifecycleState {
  return {
    ...state,
    updatedAt: new Date().toISOString(),
    failures: [...state.failures, { at: new Date().toISOString(), gate, reason, evidence }],
  };
}

// ── Anchored Edit Application ─────────────────────────────────────────────

export async function applyAnchoredEdit(
  extensionRoot: string,
  edit: ShapeBuilderAnchoredEdit,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let filePath: string;
  try {
    filePath = resolveInRoot(extensionRoot, edit.path);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!existsSync(filePath)) {
    return { ok: false, error: `File not found: ${filePath}` };
  }

  const content = await readFile(filePath, "utf8");

  if (edit.path === "package.json" && edit.action === "insert" && edit.anchor === "scripts.test.append") {
    try {
      const pkg = JSON.parse(content) as Record<string, unknown>;
      const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts as Record<string, unknown> : null;
      if (!scripts || typeof scripts.test !== "string") {
        return { ok: false, error: "package.json scripts.test must exist and be a string for deterministic test-script append." };
      }
      const command = edit.content.trim().replace(/^&&\s*/, "");
      if (!command) return { ok: false, error: "package.json test-script append content is empty." };
      if (!scripts.test.includes(command)) {
        scripts.test = `${scripts.test} && ${command}`;
        await writeFile(filePath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `package.json deterministic edit failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  switch (edit.action) {
    case "insert": {
      // Insert content right before the anchor. Idempotent if content already exists.
      if (!content.includes(edit.anchor)) {
        return { ok: false, error: `Anchor not found in ${edit.path}: ${edit.anchor.slice(0, 100)}...` };
      }
      if (content.includes(edit.content)) return { ok: true };
      const newContent = content.replace(edit.anchor, `${edit.content}\n${edit.anchor}`);
      await writeFile(filePath, newContent, "utf8");
      return { ok: true };
    }
    case "replace": {
      // Replace content between start/end anchors. Accept either a logical anchor name
      // ("generated-shapes") or an explicit full start/end anchor stem.
      const start = edit.anchor.startsWith("<!--") ? edit.anchor : `<!-- shape-builder:${edit.anchor}:start -->`;
      const end = edit.anchor.startsWith("<!--")
        ? edit.anchor.replace(":start -->", ":end -->")
        : `<!-- shape-builder:${edit.anchor}:end -->`;
      if (!content.includes(start)) {
        return { ok: false, error: `Start anchor not found in ${edit.path}: ${start}` };
      }
      if (!content.includes(end)) {
        return { ok: false, error: `End anchor not found in ${edit.path}: ${end}` };
      }
      const newContent = content.replace(
        new RegExp(`${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}`),
        `${start}\n${edit.content}\n${end}`,
      );
      await writeFile(filePath, newContent, "utf8");
      return { ok: true };
    }
    default:
      return { ok: false, error: `Unknown anchored edit action: ${edit.action}` };
  }
}

// ── Verifier Prompt ───────────────────────────────────────────────────────

export function buildImplementationVerifierPrompt(params: {
  targetName: string;
  extensionRoot: string;
  lifecycleStatePath: string;
  generatedFiles: string[];
  anchoredEditPaths: string[];
  testCommand: string;
}): string {
  return `${SHAPE_BUILDER_VERIFIER_MARKER}

You are an INDEPENDENT IMPLEMENTATION VERIFIER for the shape-builder lifecycle.
You must gather direct evidence yourself using read, bash, and grep.
Do not trust the executor's narrative — verify everything from the filesystem.

Target shape: ${params.targetName}
Extension root: ${params.extensionRoot}
Lifecycle state path: ${params.lifecycleStatePath}

Required checks:
1. **files**: Verify these generated files exist and are non-empty:
${params.generatedFiles.map((f) => `   - ${f}`).join("\n")}
2. **registry**: Verify src/index.ts imports and registers the shape.
3. **docs**: Verify README.md and PARADIGMS.md include the new shape.
4. **tests**: Run the generated test and npm test.
5. **forbidden-behavior**: Grep for forbidden runtime calls (agent_reload_runtime, agent_scheduler, executeCommand, sendUserMessage, orchestrate) in the generated shape source — must be ABSENT.
6. **sibling-rule**: The generated shape must not import sibling shapes (no imports from "./dir").
7. **lifecycle**: Verify the lifecycle JSON exists at ${params.lifecycleStatePath} and shows status "implementation_reported".
8. **canary-template**: Verify the generated shape source includes the SHAPE_CANARY branch.

Commands to run from ${params.extensionRoot}:
1. \`${params.testCommand}\`
2. \`npm test\` (or npm.cmd test on Windows)

Your response must be EXACTLY and ONLY a single JSON object in this shape:

\`\`\`json
{
  "overall": "pass",
  "implemented_verified": true,
  "reloadRequired": true,
  "targetName": ${JSON.stringify(params.targetName)},
  "lifecycleStatePath": ${JSON.stringify(params.lifecycleStatePath)},
  "checks": [
    {"id":"files", "status":"pass", "citations":["src/shapes/<target>.ts:1", "tests/test-<target>.cjs:1"]},
    {"id":"registry", "status":"pass", "citations":["src/index.ts:<line>"]},
    {"id":"docs", "status":"pass", "citations":["README.md:<line>", "PARADIGMS.md:<line>"]},
    {"id":"tests", "status":"pass", "citations":["command: ... exit 0", "command: npm test exit 0"]},
    {"id":"forbidden-behavior", "status":"pass", "citations":["grep: no forbidden calls found"]},
    {"id":"sibling-rule", "status":"pass", "citations":["grep: no sibling-shape imports"]},
    {"id":"lifecycle", "status":"pass", "citations":["<lifecycle json path>:<line>"]},
    {"id":"canary-template", "status":"pass", "citations":["src/shapes/<target>.ts:<line>"]}
  ],
  "commands": [
    {"command":"...", "exitCode":0, "stdoutSnippet":"PASS"},
    {"command":"npm test", "exitCode":0, "stdoutSnippet":"PASS"}
  ],
  "failReasons": []
}
\`\`\`

Important:
- If ANY check fails, overall must be "fail" and implemented_verified must be false.
- Every check MUST have at least one specific citation (file:line or command output snippet).
- Do not add prose outside the JSON. Only the JSON object.`;
}

// ── Verifier Response Parsing ─────────────────────────────────────────────

export function parseVerifierJson(
  text: string,
  expectedTargetName: string,
  expectedLifecyclePath: string,
): ShapeBuilderVerifierJson | { error: string } {
  const trimmed = text.trim();
  const candidates = [trimmed, ...extractFenceContents(trimmed), extractBalancedObject(trimmed)].filter(Boolean) as string[];

  let parsed: unknown = null;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      // try next
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return { error: "Verifier did not return parseable JSON." };
  }

  const raw = parsed as Record<string, unknown>;

  // Validate required fields
  if (raw.overall !== "pass" && raw.overall !== "fail") {
    return { error: `Verifier JSON must have overall "pass" or "fail", got ${JSON.stringify(raw.overall)}.` };
  }

  if (raw.overall !== "pass") {
    return {
      overall: "fail",
      implemented_verified: false,
      reloadRequired: false,
      targetName: expectedTargetName,
      lifecycleStatePath: expectedLifecyclePath,
      checks: [],
      commands: [],
      failReasons: [String(raw.reasons ?? raw.failReasons ?? "Verifier returned overall: fail.")],
    };
  }

  // Strictly validate PASS verdict
  if (raw.implemented_verified !== true) {
    return { error: "Overall pass but implemented_verified is not true." };
  }
  if (raw.reloadRequired !== true) {
    return { error: "Overall pass but reloadRequired is not true." };
  }
  if (String(raw.targetName ?? "") !== expectedTargetName) {
    return { error: `targetName mismatch: expected "${expectedTargetName}", got "${String(raw.targetName ?? "")}".` };
  }
  if (String(raw.lifecycleStatePath ?? "") !== expectedLifecyclePath) {
    return { error: `lifecycleStatePath mismatch: expected "${expectedLifecyclePath}", got "${String(raw.lifecycleStatePath ?? "")}".` };
  }

  const checks = Array.isArray(raw.checks) ? raw.checks as unknown[] : [];
  const rawFailReasons = Array.isArray(raw.failReasons) ? raw.failReasons as string[] : [];

  // Required check IDs
  const requiredCheckIds = ["files", "registry", "docs", "tests", "forbidden-behavior", "sibling-rule", "lifecycle", "canary-template"];
  const checkMap = new Map<string, ShapeBuilderVerifierCheck>();

  for (const check of checks) {
    if (!check || typeof check !== "object") continue;
    const c = check as Record<string, unknown>;
    const id = String(c.id ?? "");
    const status = c.status === "pass" ? "pass" : "fail";
    const citations = Array.isArray(c.citations) ? c.citations.map(String) : [];
    if (id) checkMap.set(id, { id, status: status as "pass" | "fail", citations });
  }

  for (const id of requiredCheckIds) {
    if (!checkMap.has(id)) {
      return { error: `Missing required check: ${id}.` };
    }
    const check = checkMap.get(id)!;
    if (check.status !== "pass") {
      return { error: `Check "${id}" status is not "pass".` };
    }
    if (check.citations.length === 0) {
      return { error: `Check "${id}" has no citations.` };
    }
  }

  // Validate commands
  const commands = Array.isArray(raw.commands) ? raw.commands as unknown[] : [];
  if (commands.length < 2) {
    return { error: "At least 2 command results required." };
  }

  const parsedCommands: ShapeBuilderVerifierCommand[] = [];
  for (const cmd of commands) {
    if (!cmd || typeof cmd !== "object") continue;
    const c = cmd as Record<string, unknown>;
    parsedCommands.push({
      command: String(c.command ?? ""),
      exitCode: Number(c.exitCode ?? -1),
      stdoutSnippet: String(c.stdoutSnippet ?? ""),
    });
  }

  if (parsedCommands.length < 2) {
    return { error: "At least 2 parseable command results required." };
  }
  const failedCommand = parsedCommands.find((c) => c.exitCode !== 0);
  if (failedCommand) {
    return { error: `Verifier command did not exit 0: ${failedCommand.command || "<missing command>"} exit ${failedCommand.exitCode}.` };
  }
  const hasGeneratedTestCommand = parsedCommands.some((c) => c.command.includes(`tests/test-${expectedTargetName}.cjs`));
  if (!hasGeneratedTestCommand) {
    return { error: `Missing required generated test command for ${expectedTargetName}.` };
  }
  const hasNpmTestCommand = parsedCommands.some((c) => /(^|\s)npm(?:\.cmd)?\s+test\b/.test(c.command));
  if (!hasNpmTestCommand) {
    return { error: "Missing required npm test command result." };
  }

  return {
    overall: "pass",
    implemented_verified: true,
    reloadRequired: true,
    targetName: expectedTargetName,
    lifecycleStatePath: expectedLifecyclePath,
    checks: requiredCheckIds.map((id) => checkMap.get(id)!),
    commands: parsedCommands,
    failReasons: rawFailReasons,
  };
}

// ── Continuation Template ─────────────────────────────────────────────────

export function buildContinuationTemplate(targetName: string): string {
  return [
    "RESUME AFTER PI RELOAD:",
    "1. Read reload diagnostics at ~/.pi/agent/agent-reload-diagnostics.json.",
    "2. Continue only if diagnostics confirm reload success and do not show a rejected command or silent failure.",
    `3. Verify runtime discovery lists "${targetName}" before using it.`,
    `4. If discovery succeeds, run the downstream task with --paradigm ${targetName}; otherwise ask for a manual reload and stop.`,
  ].join("\n");
}

export function reloadDiagnosticsPath(): string {
  const explicit = process.env.PI_AGENT_RELOAD_DIAGNOSTICS;
  if (explicit && explicit.trim()) return explicit.trim();
  const home = process.env.USERPROFILE || process.env.HOME || "~";
  return `${home.replace(/\\/g, "/")}/.pi/agent/agent-reload-diagnostics.json`;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractFenceContents(text: string): string[] {
  const results: string[] = [];
  const regex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) results.push(match[1].trim());
  return results;
}

function extractBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function escapeComment(value: string): string {
  return String(value).replace(/\*\//g, "* /");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
