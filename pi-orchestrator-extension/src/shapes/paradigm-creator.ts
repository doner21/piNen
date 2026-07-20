/**
 * Shape: paradigm-creator
 * =======================
 * Conservative meta-orchestration for proposing new reusable orchestration
 * paradigms. V1 is explicit and propose-only: it renders deterministic shape
 * code, registry/doc/test edit guidance, static checks, and a parent-session
 * reload handoff, but it does not mutate files.
 *
 * ONE-LINE RULE: Shapes are siblings — they stand on the substrate, never
 * build on each other.
 */

import {
  SpawnGuard,
  spawnSubagent,
  throwIfAborted,
  truncateWithNotice,
  type AgentProfile,
} from "../substrate";

import type {
  OrchestrationShape,
  OrchestrationShapeContext,
  OrchestrationShapeResult,
  NormalizedParams,
} from "../types";

// ── Public constants/types ────────────────────────────────────────────────

export const PARADIGM_CREATOR_CONFIDENCE_THRESHOLD = 0.85;
export const PARADIGM_CREATOR_MODE = "propose" as const;

// Keep in sync with shapeRegistry in src/index.ts; used for reserved-name validation and assessment prompts.
export const KNOWN_PARADIGMS = [
  "plan-execute-verify",
  "multi-verify-vote",
  "composable-pipeline",
  "dual-plan-synthesis-execute-verify",
  "verify-only",
  "paradigm-creator",
  "shape-builder",
  "win-console-spawn-root-cause",
  "win-lifecycle-process-trace",
] as const;

export type ParadigmCreatorAction = "reuse-existing" | "create" | "human-gate";

export interface ParadigmPhaseSpec {
  name: string;
  role: string;
  agentName: string;
  prompt: string;
  expectedOutput: string;
}

export interface ParadigmSpec {
  name: string;
  purpose: string;
  phases: ParadigmPhaseSpec[];
  maxSubagents: number;
  maxIterations: number;
  terminationCondition: string;
  evidenceModel: string;
  failureBehavior: string;
  userFacingExplanation: string;
}

export interface ParadigmCreationDecision {
  action: ParadigmCreatorAction;
  confidence: number;
  rationale: string;
  existingParadigm?: string;
  targetName?: string;
  downstreamTask?: string;
  spec?: ParadigmSpec;
}

export interface DeterministicDecision {
  action: ParadigmCreatorAction;
  confidence: number;
  normalizedName?: string;
  reasons: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────

const MAX_FINAL_CHARS = 24_000;
const MAX_DETAIL_CHARS = 5_000;
const MAX_TEMPLATE_CHARS = 12_000;
const MAX_PHASES = 8;
const MAX_TEMPLATE_SPAWNS = 20;
const V1_TEMPLATE_ITERATIONS = 1;

// Built without embedding sensitive bridge names in this shape source.
const FORBIDDEN_RUNTIME_CALLS = [
  "agent_" + "reload_runtime",
  "agent_" + "scheduler",
  "execute" + "Command",
  "send" + "UserMessage",
  "orchestrate(",
  "orchestrate({",
];

// ── Shape export ─────────────────────────────────────────────────────────

export const paradigmCreatorShape: OrchestrationShape = {
  name: "paradigm-creator",
  description:
    "Conservative propose-only meta-paradigm for designing new bounded orchestration " +
    "shapes. It normalizes and validates a requested paradigm, renders deterministic " +
    "TypeScript shape code and handoff guidance, and never mutates files in v1.",
  run: runParadigmCreator,
};

// ── Main orchestration ────────────────────────────────────────────────────

async function runParadigmCreator(
  context: OrchestrationShapeContext,
): Promise<OrchestrationShapeResult> {
  const { params, signal, onUpdate, inheritedModel, agents } = context;
  const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }] });
  const spawnGuard = new SpawnGuard(Math.min(params.maxSubagents, 1));

  emit("Paradigm creator: v1 propose-only mode; no file mutations will be performed.");
  throwIfAborted(signal);

  const assessmentAgents = buildAssessmentAgents(agents, params.plannerAgent);
  const spawned = spawnGuard.reserve();
  emit(`Paradigm creator: spawning assessment planner (${spawned}/${spawnGuard.cap}).`);
  const assessment = await spawnSubagent(
    params.plannerAgent,
    buildAssessmentPrompt(params),
    {
      agents: assessmentAgents,
      cwd: params.cwd,
      allowLocalModel: params.allowLocalModel,
      signal,
      inheritedModel,
      onProgress: emit,
      modelOverride: modelOverride(params.plannerModel, params.plannerProvider),
    },
  );

  const plannerDecision = parseDecision(assessment.text);
  const decision = completeDecision(plannerDecision, params.task);
  const spec = decision.spec ? { ...decision.spec, name: normalizeParadigmName(decision.spec.name || decision.targetName || "") } : undefined;
  const specErrors = spec ? validateParadigmSpec(spec) : ["No paradigm spec was provided."];
  const deterministic = decideCreationAction({ ...decision, spec }, specErrors);

  let renderedShape = "";
  let staticErrors: string[] = [];
  if (deterministic.action === "create" && spec) {
    renderedShape = renderShapeFromTemplate(spec);
    staticErrors = staticCheckGeneratedShape(renderedShape);
    if (staticErrors.length > 0) {
      deterministic.action = "human-gate";
      deterministic.reasons.push(...staticErrors.map((error) => `Static check failed: ${error}`));
    }
  }

  const markdown = buildResultMarkdown({
    params,
    spawnGuard,
    assessmentText: assessment.text,
    decision: { ...decision, spec },
    deterministic,
    specErrors,
    staticErrors,
    renderedShape,
  });

  return {
    markdown,
    details: {
      status: deterministic.action === "human-gate" ? "fail" : "pass",
      paradigm: "paradigm-creator",
      mode: PARADIGM_CREATOR_MODE,
      action: deterministic.action,
      targetName: deterministic.normalizedName,
      confidence: deterministic.confidence,
      threshold: PARADIGM_CREATOR_CONFIDENCE_THRESHOLD,
      spawnedCount: spawnGuard.spawned,
      spawnedCap: spawnGuard.cap,
      noFileMutation: true,
      reloadRequired: false,
      reloadRequiredAfterApply: deterministic.action === "create" && staticErrors.length === 0,
      diagnosticsPath: reloadDiagnosticsPath(),
      continuationTemplate: buildContinuationTemplate(deterministic.normalizedName),
      deterministicReasons: deterministic.reasons,
      specErrors,
      staticErrors,
      proposedShape: truncateWithNotice(renderedShape, MAX_DETAIL_CHARS, "proposed generated shape"),
      plannerRaw: truncateWithNotice(assessment.text, MAX_DETAIL_CHARS, "planner raw output"),
    },
  };
}

// ── Deterministic spine helpers ───────────────────────────────────────────

export function normalizeParadigmName(input: string): string {
  return String(input ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function validateParadigmSpec(spec: Partial<ParadigmSpec> | undefined): string[] {
  const errors: string[] = [];
  if (!spec || typeof spec !== "object") return ["Spec must be an object."];

  const name = normalizeParadigmName(String(spec.name ?? ""));
  if (!name) errors.push("Spec name is required.");
  if (name && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
    errors.push("Spec name must normalize to safe kebab-case starting with a letter.");
  }
  if ((KNOWN_PARADIGMS as readonly string[]).includes(name)) {
    errors.push(`Spec name ${name} is already registered or reserved.`);
  }

  if (!nonEmpty(spec.purpose)) errors.push("Purpose is required.");
  if (!Array.isArray(spec.phases) || spec.phases.length === 0) {
    errors.push("At least one phase is required.");
  } else if (spec.phases.length > MAX_PHASES) {
    errors.push(`At most ${MAX_PHASES} phases are allowed in v1.`);
  } else {
    spec.phases.forEach((phase, index) => {
      if (!nonEmpty(phase?.name)) errors.push(`Phase ${index + 1} requires a name.`);
      if (!nonEmpty(phase?.role)) errors.push(`Phase ${index + 1} requires a role.`);
      if (!nonEmpty(phase?.agentName)) errors.push(`Phase ${index + 1} requires an agentName.`);
      if (!nonEmpty(phase?.prompt)) errors.push(`Phase ${index + 1} requires a prompt.`);
      if (!nonEmpty(phase?.expectedOutput)) errors.push(`Phase ${index + 1} requires expectedOutput.`);
    });
  }

  if (!Number.isFinite(spec.maxSubagents) || Number(spec.maxSubagents) < 1 || Number(spec.maxSubagents) > MAX_TEMPLATE_SPAWNS) {
    errors.push(`maxSubagents must be between 1 and ${MAX_TEMPLATE_SPAWNS}.`);
  }
  const phaseCount = Array.isArray(spec.phases) ? spec.phases.length : 0;
  const requestedMaxSubagents = Number(spec.maxSubagents);
  if (Number.isFinite(requestedMaxSubagents) && phaseCount > 0 && requestedMaxSubagents < phaseCount) {
    errors.push(`maxSubagents must be at least the number of phases (${phaseCount}) in v1.`);
  }
  if (Number(spec.maxIterations) !== V1_TEMPLATE_ITERATIONS) {
    errors.push("maxIterations must be exactly 1 in v1 because the generated template runs one sequential pass.");
  }

  for (const [field, label] of [
    [spec.terminationCondition, "Termination condition"],
    [spec.evidenceModel, "Evidence model"],
    [spec.failureBehavior, "Failure behavior"],
    [spec.userFacingExplanation, "User-facing explanation"],
  ] as const) {
    if (!nonEmpty(field)) errors.push(`${label} is required.`);
  }

  const joined = JSON.stringify(spec).toLowerCase();
  if (/\b(?:forever|unbounded|infinite|until perfect|until it is perfect|keep iterating until)\b/.test(joined)) {
    errors.push("Spec contains unbounded-loop language; provide a finite maxIterations/termination condition instead.");
  }

  return errors;
}

export function decideCreationAction(
  decision: Partial<ParadigmCreationDecision> | undefined,
  specErrors: string[] = [],
): DeterministicDecision {
  const confidence = clampConfidence(decision?.confidence);
  const reasons: string[] = [];
  const requested = decision?.action;
  const existing = normalizeParadigmName(String(decision?.existingParadigm ?? ""));

  if (requested === "reuse-existing") {
    if ((KNOWN_PARADIGMS as readonly string[]).includes(existing)) {
      reasons.push(`Planner recommended reusing ${existing}; no new paradigm is needed.`);
      return { action: "reuse-existing", confidence, normalizedName: existing, reasons };
    }
    reasons.push("Planner recommended reuse but did not name a known existing paradigm.");
    return { action: "human-gate", confidence, reasons };
  }

  if (requested !== "create") {
    reasons.push("Planner did not request creation.");
    return { action: "human-gate", confidence, reasons };
  }

  const normalizedName = normalizeParadigmName(
    String(decision?.spec?.name ?? decision?.targetName ?? ""),
  );
  if (confidence < PARADIGM_CREATOR_CONFIDENCE_THRESHOLD) {
    reasons.push(
      `Confidence ${confidence.toFixed(2)} is below threshold ${PARADIGM_CREATOR_CONFIDENCE_THRESHOLD.toFixed(2)}.`,
    );
  }
  if (specErrors.length > 0) reasons.push(...specErrors);

  if (reasons.length > 0) return { action: "human-gate", confidence, normalizedName, reasons };
  reasons.push("Spec passed deterministic validation and confidence gate; v1 will propose files only.");
  return { action: "create", confidence, normalizedName, reasons };
}

export function renderShapeFromTemplate(spec: ParadigmSpec): string {
  const name = normalizeParadigmName(spec.name);
  const exportName = `${toIdentifier(name)}Shape`;
  const phases = spec.phases.map((phase) => ({
    name: String(phase.name).trim(),
    role: String(phase.role).trim(),
    agentName: String(phase.agentName).trim(),
    prompt: String(phase.prompt).trim(),
    expectedOutput: String(phase.expectedOutput).trim(),
  }));

  return `/**\n * Shape: ${name}\n * ${"=".repeat(Math.max(8, name.length + 7))}\n * ${escapeComment(spec.purpose)}\n *\n * Generated from the paradigm-creator conservative template. Review before use.\n * ONE-LINE RULE: Shapes are siblings — they stand on the substrate, never build on each other.\n */\n\nimport {\n  SpawnGuard,\n  spawnSubagent,\n  throwIfAborted,\n  truncateWithNotice,\n  type SubagentResult,\n} from "../substrate";\n\nimport type {\n  OrchestrationShape,\n  OrchestrationShapeContext,\n  OrchestrationShapeResult,\n} from "../types";\n\nconst PHASES = ${JSON.stringify(phases, null, 2)} as const;\nconst MAX_FINAL_CHARS = 20_000;\n\nexport const ${exportName}: OrchestrationShape = {\n  name: ${JSON.stringify(name)},\n  description: ${JSON.stringify(spec.purpose)},\n  run: run${toPascal(name)},\n};\n\nasync function run${toPascal(name)}(context: OrchestrationShapeContext): Promise<OrchestrationShapeResult> {\n  const { params, signal, onUpdate, inheritedModel, agents } = context;\n  const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }] });\n  const spawnGuard = new SpawnGuard(Math.min(params.maxSubagents, ${Math.max(1, Math.trunc(spec.maxSubagents))}));\n  const outputs: SubagentResult[] = [];\n\n  for (const [index, phase] of PHASES.entries()) {\n    throwIfAborted(signal);\n    const spawned = spawnGuard.reserve();\n    emit(\`${name}: phase \${index + 1}/\${PHASES.length} \${phase.name} spawning \${phase.agentName} (\${spawned}/\${spawnGuard.cap}).\`);\n    const result = await spawnSubagent(\n      phase.agentName,\n      buildPhasePrompt(phase, params.task, outputs),\n      { agents, cwd: params.cwd, allowLocalModel: params.allowLocalModel, signal, inheritedModel, onProgress: emit },\n    );\n    outputs.push(result);\n  }\n\n  const status = outputs.every((output) => output.exitCode === 0) ? "pass" : "fail";\n  const markdown = buildReport(status, params.task, spawnGuard, outputs);\n  return {\n    markdown,\n    details: {\n      status,\n      paradigm: ${JSON.stringify(name)},\n      spawnedCount: spawnGuard.spawned,\n      spawnedCap: spawnGuard.cap,\n      terminationCondition: ${JSON.stringify(spec.terminationCondition)},\n      evidenceModel: ${JSON.stringify(spec.evidenceModel)},\n      failureBehavior: ${JSON.stringify(spec.failureBehavior)},\n      outputs: outputs.map((output) => ({\n        agentName: output.agentName,\n        exitCode: output.exitCode,\n        durationMs: output.durationMs,\n        text: truncateWithNotice(output.text, 2000, "phase output"),\n      })),\n    },\n  };\n}\n\nfunction buildPhasePrompt(phase: typeof PHASES[number], originalTask: string, prior: SubagentResult[]): string {\n  return [\n    \`You are running phase \"\${phase.name}\" (role: \${phase.role}) in a bounded orchestration shape.\`,\n    "Do not invoke recursive orchestration. Work only on the phase prompt below.",\n    \`Original task:\\n\${originalTask}\`,\n    prior.length ? \`Prior phase outputs:\\n\${prior.map((item, index) => \`[\${index + 1}] \${item.agentName}: \${truncateWithNotice(item.text, 3000, "prior output")}\`).join("\\n\\n")}\` : "Prior phase outputs: none.",\n    \`Phase prompt:\\n\${phase.prompt}\`,\n    \`Expected output:\\n\${phase.expectedOutput}\`,\n  ].join("\\n\\n");\n}\n\nfunction buildReport(status: "pass" | "fail", task: string, spawnGuard: SpawnGuard, outputs: SubagentResult[]): string {\n  const lines = [\n    \`# ${name} Orchestration: \${status.toUpperCase()}\`,\n    "",\n    \`**Task:** \${truncateWithNotice(task, 2000, "task")}\`,\n    \`**Subagents spawned:** \${spawnGuard.spawned}/\${spawnGuard.cap}\`,\n    \`**Termination:** ${escapeTemplateLiteral(spec.terminationCondition)}\`,\n    \`**Evidence model:** ${escapeTemplateLiteral(spec.evidenceModel)}\`,\n    "",\n    "## Phase outputs",\n  ];\n  outputs.forEach((output, index) => {\n    lines.push(\`### Phase \${index + 1}: \${PHASES[index]?.name ?? output.agentName}\`, truncateWithNotice(output.text, 3000, "phase output"));\n  });\n  lines.push("", "## Orchestration Used", ${JSON.stringify(spec.userFacingExplanation)});\n  return truncateWithNotice(lines.join("\\n"), MAX_FINAL_CHARS, "final report");\n}\n`;
}

export function staticCheckGeneratedShape(source: string): string[] {
  const errors: string[] = [];
  if (!/export const \w+Shape\s*:\s*OrchestrationShape/.test(source)) {
    errors.push("Generated shape must export an OrchestrationShape constant.");
  }
  if (!/new SpawnGuard\(/.test(source)) errors.push("Generated shape must use SpawnGuard.");
  if (!/spawnSubagent\(/.test(source)) errors.push("Generated shape must use spawnSubagent.");
  if (/from\s+["']\.\//.test(source)) errors.push("Generated shape must not import sibling shapes.");
  if (/while\s*\(\s*true\s*\)/i.test(source)) errors.push("Generated shape must not contain while(true).");
  if (/for\s*\(\s*;\s*;\s*\)/.test(source)) errors.push("Generated shape must not contain an infinite for loop.");
  for (const forbidden of FORBIDDEN_RUNTIME_CALLS) {
    if (source.includes(forbidden)) errors.push(`Generated shape must not contain forbidden runtime call: ${forbidden}.`);
  }
  return errors;
}

// ── Prompting/parsing ─────────────────────────────────────────────────────

function buildAssessmentPrompt(params: NormalizedParams): string {
  return `PARADIGM-CREATOR ASSESSMENT

You are assessing whether a requested orchestration need deserves a reusable Pi orchestration paradigm.

V1 safety rules:
- This run is PROPOSE-ONLY. Do not write files. Do not ask tools to edit files.
- Prefer an existing paradigm when it is sufficient.
- Do not invoke recursive orchestration.
- A new paradigm must be finite, bounded, explainable, and reusable.

Known paradigms:
${KNOWN_PARADIGMS.map((name) => `- ${name}`).join("\n")}

Task/request:
${params.task}

Return JSON exactly and only in this shape:
{
  "action": "reuse-existing" | "create" | "human-gate",
  "confidence": 0.0,
  "rationale": "short reason",
  "existingParadigm": "known-name when reusing",
  "targetName": "safe proposed name when creating",
  "downstreamTask": "task the new paradigm would later run",
  "spec": {
    "name": "safe proposed name",
    "purpose": "what reusable loop this implements",
    "phases": [
      {"name":"phase-name","role":"role name","agentName":"planner|coder|reviewer|other configured agent","prompt":"bounded phase prompt","expectedOutput":"required output"}
    ],
    "maxSubagents": 3,
    "maxIterations": 1,
    "terminationCondition": "finite stopping rule",
    "evidenceModel": "what evidence proves completion",
    "failureBehavior": "what makes the paradigm fail",
    "userFacingExplanation": "how to explain the orchestration after use"
  }
}`;
}

function parseDecision(text: string): Partial<ParadigmCreationDecision> {
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== "object") {
    return { action: "human-gate", confidence: 0, rationale: "Planner did not return parseable JSON." };
  }
  const raw = parsed as Record<string, unknown>;
  const spec = raw.spec && typeof raw.spec === "object" ? normalizeRawSpec(raw.spec as Record<string, unknown>) : undefined;
  return {
    action: parseAction(raw.action),
    confidence: clampConfidence(raw.confidence),
    rationale: stringValue(raw.rationale),
    existingParadigm: stringValue(raw.existingParadigm),
    targetName: stringValue(raw.targetName),
    downstreamTask: stringValue(raw.downstreamTask),
    spec,
  };
}

function normalizeRawSpec(raw: Record<string, unknown>): ParadigmSpec {
  return {
    name: stringValue(raw.name),
    purpose: stringValue(raw.purpose),
    phases: Array.isArray(raw.phases)
      ? raw.phases.map((item) => {
          const phase = item && typeof item === "object" ? item as Record<string, unknown> : {};
          return {
            name: stringValue(phase.name),
            role: stringValue(phase.role),
            agentName: stringValue(phase.agentName),
            prompt: stringValue(phase.prompt),
            expectedOutput: stringValue(phase.expectedOutput),
          };
        })
      : [],
    maxSubagents: Number(raw.maxSubagents),
    maxIterations: Number(raw.maxIterations),
    terminationCondition: stringValue(raw.terminationCondition),
    evidenceModel: stringValue(raw.evidenceModel),
    failureBehavior: stringValue(raw.failureBehavior),
    userFacingExplanation: stringValue(raw.userFacingExplanation),
  };
}

function completeDecision(decision: Partial<ParadigmCreationDecision>, task: string): ParadigmCreationDecision {
  return {
    action: decision.action ?? "human-gate",
    confidence: clampConfidence(decision.confidence),
    rationale: decision.rationale || "No rationale supplied.",
    existingParadigm: decision.existingParadigm,
    targetName: decision.targetName,
    downstreamTask: decision.downstreamTask || task,
    spec: decision.spec,
  };
}

function parseAction(value: unknown): ParadigmCreatorAction {
  return value === "reuse-existing" || value === "create" || value === "human-gate" ? value : "human-gate";
}

function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  const candidates = [trimmed, ...extractFenceContents(trimmed), extractBalancedObject(trimmed)].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next candidate
    }
  }
  return null;
}

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

// ── Reports/handoff ───────────────────────────────────────────────────────

function buildResultMarkdown(input: {
  params: NormalizedParams;
  spawnGuard: SpawnGuard;
  assessmentText: string;
  decision: ParadigmCreationDecision;
  deterministic: DeterministicDecision;
  specErrors: string[];
  staticErrors: string[];
  renderedShape: string;
}): string {
  const { params, spawnGuard, decision, deterministic, specErrors, staticErrors, renderedShape } = input;
  const status = deterministic.action === "human-gate" ? "HUMAN GATE" : "PASS";
  const target = deterministic.normalizedName || "(none)";
  const lines: string[] = [
    `# Paradigm Creator: ${status}`,
    "",
    `**Mode:** ${PARADIGM_CREATOR_MODE} (no file mutation performed)` ,
    `**Requested task:** ${truncateWithNotice(params.task, 2000, "task")}`,
    `**Subagents spawned:** ${spawnGuard.spawned}/${spawnGuard.cap}`,
    "",
    "## Reuse Existing Paradigm?",
    deterministic.action === "reuse-existing"
      ? `Yes — reuse \`${target}\`. ${decision.rationale}`
      : `No deterministic reuse was selected. Planner rationale: ${decision.rationale}`,
    "",
    "## Creation Confidence",
    `Confidence: **${deterministic.confidence.toFixed(2)}** (threshold ${PARADIGM_CREATOR_CONFIDENCE_THRESHOLD.toFixed(2)})`,
    ...deterministic.reasons.map((reason) => `- ${reason}`),
    "",
    "## Proposed Files",
  ];

  if (deterministic.action === "create" && decision.spec) {
    const name = deterministic.normalizedName ?? normalizeParadigmName(decision.spec.name);
    lines.push(
      `- \`src/shapes/${name}.ts\` (rendered below; not written)`,
      "- `src/index.ts` import + `shapeRegistry` entry (not written)",
      "- `PARADIGMS.md` documentation entry (not written)",
      "- `README.md` supported paradigm list/example (not written)",
      "- `tests/test-<name>.cjs` registry/static/helper tests (not written)",
    );
  } else {
    lines.push("- No files proposed for writing in this run.");
  }

  lines.push("", "## Static Verification");
  if (specErrors.length === 0 && staticErrors.length === 0) {
    lines.push("- PASS: deterministic spec validation and generated-source static checks passed.");
  } else {
    for (const error of specErrors) lines.push(`- Spec: ${error}`);
    for (const error of staticErrors) lines.push(`- Static: ${error}`);
  }

  if (renderedShape) {
    lines.push(
      "",
      "## Rendered Shape Preview",
      "```typescript",
      truncateWithNotice(renderedShape, MAX_TEMPLATE_CHARS, "rendered shape"),
      "```",
    );
  }

  lines.push(
    "",
    "## Reload Handoff Details",
    deterministic.action === "create"
      ? "After a human or future explicit apply mode writes the proposed files and tests pass, the parent Pi session must schedule a continuation, trigger a runtime reload, stop immediately, then verify reload diagnostics before using the new paradigm."
      : "No reload is needed because no new paradigm files were written.",
    "",
    "Continuation template:",
    "```text",
    buildContinuationTemplate(deterministic.normalizedName),
    "```",
    "",
    "## Orchestration Used",
    "Used `paradigm-creator` v1 in propose-only mode: one bounded assessment planner spawn, deterministic name/spec/confidence/static checks in TypeScript, no file mutation, and parent-session reload handoff guidance only.",
  );

  return truncateWithNotice(lines.join("\n"), MAX_FINAL_CHARS, "paradigm-creator report");
}

function buildContinuationTemplate(targetName?: string): string {
  const target = targetName || "<new-paradigm-name>";
  return [
    "RESUME AFTER PI RELOAD:",
    `1. Read reload diagnostics at ${reloadDiagnosticsPath()}.`,
    "2. Continue only if diagnostics confirm reload success and do not show a rejected command or silent failure.",
    `3. Verify runtime discovery lists ${target} before using it.`,
    `4. If discovery succeeds, run the downstream task with --paradigm ${target}; otherwise ask for a manual reload and stop.`,
  ].join("\n");
}

function reloadDiagnosticsPath(): string {
  const explicit = process.env.PI_AGENT_RELOAD_DIAGNOSTICS;
  if (explicit && explicit.trim()) return explicit.trim();
  const home = process.env.USERPROFILE || process.env.HOME || "~";
  return `${home.replace(/\\/g, "/")}/.pi/agent/agent-reload-diagnostics.json`;
}

// ── Local utilities ───────────────────────────────────────────────────────

function buildAssessmentAgents(agents: Map<string, AgentProfile>, plannerAgent: string): Map<string, AgentProfile> {
  const cloned = new Map(agents);
  const profile = agents.get(plannerAgent) ?? { name: plannerAgent };
  cloned.set(plannerAgent, { ...profile, name: plannerAgent, tools: [] });
  return cloned;
}

function modelOverride(model?: string, provider?: string): { model?: string; provider?: string } | undefined {
  if (!model && !provider) return undefined;
  return { model, provider };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampConfidence(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function toIdentifier(name: string): string {
  const candidate = normalizeParadigmName(name)
    .split("-")
    .map((part, index) => index === 0 ? part : part.slice(0, 1).toUpperCase() + part.slice(1))
    .join("") || "generated";
  return /^[a-zA-Z_]/.test(candidate) ? candidate : `shape${candidate}`;
}

function toPascal(name: string): string {
  const id = toIdentifier(name);
  return id.slice(0, 1).toUpperCase() + id.slice(1);
}

function escapeComment(value: string): string {
  return String(value).replace(/\*\//g, "* /");
}

function escapeTemplateLiteral(value: string): string {
  return String(value).replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}
