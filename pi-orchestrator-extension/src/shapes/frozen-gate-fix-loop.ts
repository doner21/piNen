/**
 * Shape: frozen-gate-fix-loop
 * ===========================
 * Codifies the production-proven bounded-fix pattern (K1 Shape B attempt 6;
 * Wave-1 bounded fix) as a first-class registered shape. It is for the specific
 * situation of: an EXISTING near-passing implementation + a FROZEN gate/spec
 * document (sha256-content-locked) + a set of enumerated residual findings.
 *
 * The shape is the first consumer of the deterministic non-LLM phase primitive
 * (src/deterministic-phase.ts, WAVE2-SPEC ITEM A): phases 1 and 3 recompute the
 * frozen document's sha256 WITHOUT spawning an LLM, so gate integrity is an
 * auditable first-class phase rather than orchestrator-held.
 *
 * Phases (in order):
 *   1. freeze-verify   (DETERMINISTIC verify-hash): frozen doc sha256 == reference?
 *                       Mismatch ⇒ automatic structured FAIL, ZERO LLM spawns.
 *   2. bounded-fix     (executor): fix EXACTLY the enumerated findings; rerun the
 *                       gate pipeline with a fresh run-id; restructuring beyond
 *                       the findings is a contract violation the verifier FAILs.
 *   3. re-verify-freeze(DETERMINISTIC verify-hash): frozen doc STILL byte-identical
 *                       after the executor worked (tamper check). Mismatch ⇒ FAIL.
 *   4. verify          (verifier): raw-artifact verification, run-id binding,
 *                       diff-scope boundedness; strict JSON verdict; fail-closed.
 *   5. Bounded retry loop: on verifier FAIL with retry slots left, feed the
 *                       findings/feedback back into a new bounded-fix. Default
 *                       maxRetries 2 (maxAttempts 3).
 *
 * Inputs are supplied via labeled fields in the task text and/or a referenced
 * spec file. THE SPEC-FILE PATTERN IS PREFERRED: put the residual findings and
 * gate coordinates in a residuals/spec file and reference it via SPEC_FILE so
 * every role reads the same authoritative source first.
 *
 * ONE-LINE RULE: Shapes are siblings — they stand on the substrate, never build
 * on each other.
 */

import fs from "node:fs";
import path from "node:path";

import {
  SpawnGuard,
  spawnSubagent,
  SubagentDetachedError,
  clampIterations,
  throwIfAborted,
  truncateWithNotice,
  type SubagentResult,
} from "../substrate";
import { RunStateStore, collectSurvivorResult } from "../run-state";
import { resolveRouteOverride, formatRouteLabel } from "../routes";
import {
  runDeterministicPhase,
  checkpointPayload,
  formatDeterministicPhaseForReport,
  DeterministicPhaseError,
  type DeterministicPhaseOutput,
} from "../deterministic-phase";

import type {
  OrchestrationShape,
  OrchestrationShapeContext,
  OrchestrationShapeResult,
} from "../types";

const MAX_FINAL_CHARS = 20_000;
const DEFAULT_MAX_RETRIES = 2;

// ── Parsed inputs ────────────────────────────────────────────────────────

interface FrozenGateInputs {
  frozenDocPath?: string;
  frozenSha256?: string;
  findings: string[];
  specFile?: string;
  runIdLabel?: string;
}

/** Per-phase record accumulated for the final report. */
interface PhaseRecord {
  name: string;
  kind: "deterministic" | "llm";
  detail: string;
  agentName?: string;
  route?: string;
  durationMs?: number;
}

// ── Shape export ─────────────────────────────────────────────────────────

export const frozenGateFixLoopShape: OrchestrationShape = {
  name: "frozen-gate-fix-loop",
  description:
    "Bounded-fix loop for an EXISTING near-passing implementation against a FROZEN gate/spec " +
    "document with enumerated residual findings. Deterministically verifies the frozen document's " +
    "sha256 (no LLM) before and after each executor fix (tamper-proof), spawns an executor to fix " +
    "EXACTLY the enumerated findings, then an independent verifier with fail-closed JSON parsing; " +
    "retries bounded on verifier FAIL (default maxRetries 2). The spec-file input pattern is preferred.",
  run: runFrozenGateFixLoop,
};

// ── Main loop ────────────────────────────────────────────────────────────

async function runFrozenGateFixLoop(context: OrchestrationShapeContext): Promise<OrchestrationShapeResult> {
  const { params, signal, onUpdate, inheritedModel, agents } = context;
  const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }] });

  // Deterministic canary branch — no subagent spawn, no file mutation.
  if (params.task.trim().startsWith("SHAPE_CANARY:frozen-gate-fix-loop")) {
    return {
      markdown: "# frozen-gate-fix-loop Canary: PASS\n\nDeterministic shape canary passed.",
      details: {
        status: "pass",
        paradigm: "frozen-gate-fix-loop",
        canary: true,
        targetName: "frozen-gate-fix-loop",
        spawnedCount: 0,
        spawnedCap: 0,
      },
    };
  }

  const maxRetries = Number.isFinite(params.maxRetries) && params.maxRetries >= 0 ? params.maxRetries : DEFAULT_MAX_RETRIES;
  const maxAttempts = clampIterations(maxRetries + 1);
  const spawnGuard = new SpawnGuard(Math.min(params.maxSubagents, maxAttempts * 2));

  // Pre-allocated stage names for index stability across resume.
  const stageNames = ["freeze-verify"];
  for (let k = 1; k <= maxAttempts; k++) {
    stageNames.push(`bounded-fix-${k}`, `re-verify-freeze-${k}`, `verify-${k}`);
  }
  const indexOf = (name: string): number => stageNames.indexOf(name);

  const executorRoute = resolveRouteOverride(params.executorModel, params.executorProvider);
  const verifierRoute = resolveRouteOverride(params.verifierModel, params.verifierProvider);
  const routesLine = `Executor=${formatRouteLabel(executorRoute)} Verifier=${formatRouteLabel(verifierRoute)}`;

  const phaseRecords: PhaseRecord[] = [];

  // Parse inputs. The spec-file pattern is PREFERRED: labels referenced through
  // SPEC_FILE are merged in (task text overrides the spec file). Missing frozen
  // doc path/hash ⇒ structured FAIL, ZERO spawns.
  const inputs = parseFrozenGateInputs(params.task, params.cwd);
  if (!inputs.frozenDocPath || !inputs.frozenSha256) {
    return failReport(
      "Missing required frozen gate inputs.",
      `The task must supply FROZEN_DOC_PATH and FROZEN_DOC_SHA256 (the spec-file pattern via SPEC_FILE is preferred). ` +
        `Parsed: FROZEN_DOC_PATH=${inputs.frozenDocPath ?? "(none)"}, FROZEN_DOC_SHA256=${inputs.frozenSha256 ?? "(none)"}.`,
      params.task,
      spawnGuard,
      routesLine,
      phaseRecords,
    );
  }
  const frozenDocAbs = path.isAbsolute(inputs.frozenDocPath)
    ? inputs.frozenDocPath
    : path.resolve(params.cwd, inputs.frozenDocPath);

  // Checkpoint/resume wiring (ABORT-RESUME-DESIGN.md). Deterministic phases
  // re-execute on every invocation (cheap, pure, and a tamper check); only LLM
  // phases restore from checkpoint / collect a survivor / respawn.
  const runId = context.runId;
  const resume = context.resumeState;
  const store = resume
    ? RunStateStore.open(resume.state.runId)
    : runId
      ? RunStateStore.create(runId, "frozen-gate-fix-loop", params.task, serializableParams(params), stageNames)
      : undefined;

  // ── Phase 1: freeze-verify (DETERMINISTIC) — guaranteed before any spawn ──
  let freezeOut: DeterministicPhaseOutput;
  try {
    freezeOut = await runDeterministicVerify("freeze-verify", frozenDocAbs, inputs.frozenSha256, params.cwd, store, indexOf, emit);
  } catch (error) {
    return deterministicFailReport("freeze-verify", error, params.task, spawnGuard, routesLine, phaseRecords);
  }
  phaseRecords.push({ name: "freeze-verify", kind: "deterministic", detail: formatDeterministicPhaseForReport(freezeOut) });
  if (!freezeOut.ok || freezeOut.outputs.match !== true) {
    return failReport(
      "Frozen gate document sha256 mismatch at freeze-verify — no LLM was spawned.",
      `The frozen document at ${frozenDocAbs} does not match the reference sha256 ${inputs.frozenSha256}. ` +
        `Computed sha256=${String(freezeOut.outputs.sha256)}. The pre-registration was tampered with after freeze; this is an automatic FAIL.`,
      params.task,
      spawnGuard,
      routesLine,
      phaseRecords,
    );
  }

  // ── Bounded retry loop ───────────────────────────────────────────────────
  let status: "pass" | "fail" = "fail";
  let priorFeedback = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfAborted(signal);

    // Phase 2: bounded-fix (LLM executor).
    const fixName = `bounded-fix-${attempt}`;
    const fixPrompt = buildExecutorPrompt(inputs, frozenDocAbs, priorFeedback, attempt, maxAttempts, params.task);
    let fixResult: SubagentResult;
    try {
      fixResult = await runLlmPhase(fixName, params.executorAgent, fixPrompt, executorRoute);
    } catch (error) {
      return handleDetach(error, store, indexOf, fixName);
    }
    phaseRecords.push({
      name: fixName, kind: "llm", agentName: fixResult.agentName,
      route: formatRouteLabel(executorRoute), durationMs: fixResult.durationMs,
      detail: truncateWithNotice(fixResult.text, 3000, "bounded-fix output"),
    });

    // Phase 3: re-verify-freeze (DETERMINISTIC tamper check).
    const reVerifyName = `re-verify-freeze-${attempt}`;
    let reVerifyOut: DeterministicPhaseOutput;
    try {
      reVerifyOut = await runDeterministicVerify(reVerifyName, frozenDocAbs, inputs.frozenSha256, params.cwd, store, indexOf, emit);
    } catch (error) {
      return deterministicFailReport(reVerifyName, error, params.task, spawnGuard, routesLine, phaseRecords);
    }
    phaseRecords.push({ name: reVerifyName, kind: "deterministic", detail: formatDeterministicPhaseForReport(reVerifyOut) });
    if (!reVerifyOut.ok || reVerifyOut.outputs.match !== true) {
      // Tamper detected between phases — abort the loop; NO verifier spawn this attempt.
      return failReport(
        `Frozen gate document was modified during ${fixName} (tamper detected at ${reVerifyName}).`,
        `Post-fix sha256=${String(reVerifyOut.outputs.sha256)} no longer matches the reference ${inputs.frozenSha256}. ` +
          `The bounded-fix executor must NEVER modify the frozen gate document; this is an automatic FAIL.`,
        params.task,
        spawnGuard,
        routesLine,
        phaseRecords,
      );
    }

    // Phase 4: verify (LLM verifier) with fail-closed JSON parsing.
    const verifyName = `verify-${attempt}`;
    const verifyPrompt = buildVerifierPrompt(inputs, frozenDocAbs, fixResult.text, attempt, maxAttempts, params.task);
    let verifyResult: SubagentResult;
    try {
      verifyResult = await runLlmPhase(verifyName, params.verifierAgent, verifyPrompt, verifierRoute);
    } catch (error) {
      return handleDetach(error, store, indexOf, verifyName);
    }
    const verdict = parseVerdict(verifyResult.text);
    phaseRecords.push({
      name: verifyName, kind: "llm", agentName: verifyResult.agentName,
      route: formatRouteLabel(verifierRoute), durationMs: verifyResult.durationMs,
      detail: `verdict=${verdict.overall.toUpperCase()} — ${verdict.reasons.join("; ") || "no reasons"}`,
    });
    emit(`frozen-gate-fix-loop: attempt ${attempt}/${maxAttempts} verifier ${verdict.overall.toUpperCase()}.`);

    if (verdict.overall === "pass") {
      status = "pass";
      break;
    }
    // Fail-closed: feed feedback/reasons forward if retry slots remain.
    priorFeedback = [verdict.feedback, ...verdict.reasons].filter(Boolean).join("\n");
    status = "fail";
  }

  const markdown = buildReport(status, params.task, spawnGuard, routesLine, phaseRecords, maxAttempts);
  return {
    markdown,
    details: {
      status,
      paradigm: "frozen-gate-fix-loop",
      spawnedCount: spawnGuard.spawned,
      spawnedCap: spawnGuard.cap,
      routes: routesLine,
      maxAttempts,
      phases: phaseRecords.map((r) => ({ name: r.name, kind: r.kind, agentName: r.agentName, route: r.route })),
    },
  };

  // ── Inner helpers (closures capturing store/signal/agents/etc.) ──────────

  async function runLlmPhase(
    name: string,
    agentName: string,
    prompt: string,
    route: { model?: string; provider?: string } | undefined,
  ): Promise<SubagentResult> {
    const index = indexOf(name);
    // Resume path 1: completed LLM checkpoint — restore without respawning.
    const checkpoint = resume?.checkpoints.get(index);
    if (checkpoint) {
      emit(`frozen-gate-fix-loop: ${name} restored from checkpoint (resume).`);
      return checkpoint;
    }
    // Resume path 2: detached survivor — collect its result or respawn.
    const survivor = resume?.survivors.get(index);
    if (survivor && store) {
      const collected = await collectSurvivorResult<SubagentResult>(survivor, emit, signal, "frozen-gate-fix-loop");
      if (collected) {
        store.checkpointPhase(index, name, collected);
        return collected;
      }
      emit(`frozen-gate-fix-loop: survivor for ${name} yielded no result — respawning.`);
    }

    throwIfAborted(signal);
    const spawned = spawnGuard.reserve();
    emit(`frozen-gate-fix-loop: ${name} spawning ${agentName} (${spawned}/${spawnGuard.cap}).`);
    const result = await spawnSubagent(agentName, prompt, {
      agents, cwd: params.cwd, allowLocalModel: params.allowLocalModel, signal, inheritedModel, onProgress: emit,
      modelOverride: route,
      ...(store
        ? {
            abortSurvival: {
              resultFile: store.survivorResultPath(index, name),
              manifestFile: store.survivorManifestPath(index, name),
              phaseName: name,
              phaseIndex: index,
            },
          }
        : {}),
    });
    store?.checkpointPhase(index, name, result);
    return result;
  }

  function handleDetach(error: unknown, s: RunStateStore | undefined, idxOf: (n: string) => number, name: string): never {
    if (error instanceof SubagentDetachedError && s) {
      s.markDetached(idxOf(name), name, error.manifest);
      throw new Error(
        `Orchestration aborted mid-phase but the ${name} subagent (pid=${error.manifest.pid}) ` +
          `continues in the background. Resume this run by re-invoking the orchestrate tool with { resume: "${s.runId}" }. ` +
          `Completed phases are checkpointed and will not be re-executed.`,
      );
    }
    throw error as Error;
  }
}

// ── Deterministic phase runner (always re-executes + checkpoints) ────────

async function runDeterministicVerify(
  name: string,
  docAbs: string,
  reference: string,
  cwd: string,
  store: RunStateStore | undefined,
  indexOf: (n: string) => number,
  emit: (text: string) => void,
): Promise<DeterministicPhaseOutput> {
  emit(`frozen-gate-fix-loop: ${name} (DETERMINISTIC verify-hash, no LLM).`);
  const out = await runDeterministicPhase({ op: "verify-hash", cwd, inputs: { path: docAbs, reference } });
  store?.checkpointPhase(indexOf(name), name, checkpointPayload(out));
  return out;
}

// ── Input parsing ────────────────────────────────────────────────────────

/** Labeled fields parsed from a single text source (task text OR a spec file). */
interface ParsedFields {
  frozenDocPath?: string;
  frozenSha256?: string;
  specFile?: string;
  runIdLabel?: string;
  findings: string[];
}

function parseLabeledFields(text: string): ParsedFields {
  const field = (label: string): string | undefined => {
    const m = text.match(new RegExp(`^[ \\t]*${label}[ \\t]*:[ \\t]*(.+?)[ \\t]*$`, "im"));
    return m && m[1].trim() ? m[1].trim() : undefined;
  };
  return {
    frozenDocPath: field("FROZEN_DOC_PATH"),
    frozenSha256: field("FROZEN_DOC_SHA256"),
    specFile: field("SPEC_FILE"),
    runIdLabel: field("RUN_ID_LABEL"),
    findings: parseFindings(text),
  };
}

/**
 * Merge labeled inputs from the task text and (preferred) a referenced SPEC_FILE.
 * Precedence is deterministic: a value present in the TASK TEXT always overrides
 * the same label sourced from the spec file. If SPEC_FILE is absent, unreadable,
 * or invalid, we silently fall back to task-only inputs — missing required fields
 * then yield the structured zero-spawn FAIL downstream (never a throw).
 */
function parseFrozenGateInputs(task: string, cwd: string): FrozenGateInputs {
  const fromTask = parseLabeledFields(task);

  let fromSpec: ParsedFields = { findings: [] };
  const specFileRef = fromTask.specFile;
  if (specFileRef) {
    const specAbs = path.isAbsolute(specFileRef) ? specFileRef : path.resolve(cwd, specFileRef);
    try {
      const specText = fs.readFileSync(specAbs, "utf8");
      fromSpec = parseLabeledFields(specText);
    } catch {
      // Invalid/unreadable spec file: fall back to task-only inputs.
    }
  }

  return {
    frozenDocPath: fromTask.frozenDocPath ?? fromSpec.frozenDocPath,
    frozenSha256: (fromTask.frozenSha256 ?? fromSpec.frozenSha256)?.toLowerCase(),
    specFile: fromTask.specFile ?? fromSpec.specFile,
    runIdLabel: fromTask.runIdLabel ?? fromSpec.runIdLabel,
    findings: fromTask.findings.length ? fromTask.findings : fromSpec.findings,
  };
}

function parseFindings(task: string): string[] {
  const lines = task.split(/\r?\n/);
  const startIndex = lines.findIndex((l) => /^[ \t]*FINDINGS[ \t]*:/i.test(l));
  if (startIndex < 0) return [];
  const collected: string[] = [];
  const inline = lines[startIndex].replace(/^[ \t]*FINDINGS[ \t]*:/i, "").trim();
  if (inline) collected.push(...inline.split(/;/));
  for (let i = startIndex + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (/^[ \t]*[A-Z_]{3,}[ \t]*:/.test(raw)) break; // next labeled field
    const trimmed = raw.trim();
    if (!trimmed) {
      if (collected.length) break; // blank line ends the findings block
      continue;
    }
    collected.push(trimmed.replace(/^[-*\d.)\]]+[ \t]*/, ""));
  }
  return collected.map((s) => s.trim()).filter(Boolean);
}

// ── Prompts ──────────────────────────────────────────────────────────────

function buildExecutorPrompt(
  inputs: FrozenGateInputs,
  frozenDocAbs: string,
  priorFeedback: string,
  attempt: number,
  maxAttempts: number,
  originalTask: string,
): string {
  const findingsBlock = inputs.findings.length
    ? inputs.findings.map((f, i) => `${i + 1}. ${f}`).join("\n")
    : "(No findings were enumerated in the task; fix only what the referenced spec file lists.)";
  return [
    "You are the EXECUTOR in a frozen-gate-fix-loop orchestration.",
    "Do not invoke recursive orchestration. Work only on the phase prompt below.",
    inputs.specFile ? `Read this spec/residuals file FIRST (authoritative): ${inputs.specFile}` : "",
    `This is bounded-fix attempt ${attempt} of ${maxAttempts}.`,
    `The existing implementation lives in the working directory. A FROZEN gate document governs acceptance.`,
    `FROZEN_DOC_ABS: ${frozenDocAbs}`,
    "You MUST NOT modify the frozen gate document in any way — it is content-hash locked and re-verified after you finish.",
    "Fix EXACTLY the enumerated findings below. Rebuilding from scratch or restructuring beyond the findings is a CONTRACT VIOLATION the verifier will FAIL.",
    "Rerun the full gate pipeline with a FRESH run-id; keep all evidence artifacts run-id-bound.",
    `Enumerated findings to fix:\n${findingsBlock}`,
    priorFeedback ? `Prior verifier feedback to address this attempt:\n${priorFeedback}` : "",
    `Original task:\n${truncateWithNotice(originalTask, 4000, "task")}`,
    "Expected output: the list of files changed (paths), an explicit statement that the frozen gate document was NOT modified, and the run-id used for the gate pipeline.",
  ].filter(Boolean).join("\n\n");
}

function buildVerifierPrompt(
  inputs: FrozenGateInputs,
  frozenDocAbs: string,
  executorText: string,
  attempt: number,
  maxAttempts: number,
  originalTask: string,
): string {
  const findingsBlock = inputs.findings.length
    ? inputs.findings.map((f, i) => `${i + 1}. ${f}`).join("\n")
    : "(no enumerated findings — use the referenced spec file)";
  return [
    "You are the VERIFIER in a frozen-gate-fix-loop orchestration.",
    "Do not trust the executor narrative. Verify raw artifacts yourself.",
    inputs.specFile ? `Read this spec/residuals file FIRST (authoritative): ${inputs.specFile}` : "",
    `Frozen gate document (do NOT modify): ${frozenDocAbs}`,
    `This is verification for bounded-fix attempt ${attempt} of ${maxAttempts}.`,
    "Checks (all must hold for PASS):",
    "1. Re-run the gate/tests yourself where feasible and confirm the enumerated findings are resolved.",
    "2. Confirm the fix stayed BOUNDED — inspect the diff scope; restructuring beyond the enumerated findings is a FAIL.",
    "3. Confirm evidence artifacts are run-id-bound to the fresh gate run.",
    `Enumerated findings that were supposed to be fixed:\n${findingsBlock}`,
    `Executor report (untrusted):\n${truncateWithNotice(executorText, 3000, "executor report")}`,
    `Original task:\n${truncateWithNotice(originalTask, 3000, "task")}`,
    'Return JSON exactly and only in this shape: {"overall":"pass"|"fail","reasons":["..."],"feedback":"...","evidence":["..."]}',
    'Use overall "pass" ONLY if every check passes. Empty/unparseable/unknown output is treated as FAIL.',
  ].filter(Boolean).join("\n\n");
}

// ── Verdict parsing (fail-closed; inline duplicate of the shared pattern) ─

interface Verdict {
  overall: "pass" | "fail";
  reasons: string[];
  feedback: string;
}

function parseVerdict(text: string): Verdict {
  const parsed = extractJson(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const raw = parsed as Record<string, unknown>;
    const overallRaw = String(raw.overall ?? raw.status ?? "").toLowerCase();
    // Fail-closed: only an exact "pass" is a pass; everything else FAILs.
    const overall: "pass" | "fail" = overallRaw === "pass" ? "pass" : "fail";
    const reasons = stringArray(raw.reasons) ?? [];
    const feedback = typeof raw.feedback === "string" ? raw.feedback.trim() : "";
    if (overallRaw === "pass" || overallRaw === "fail") return { overall, reasons, feedback };
  }
  return {
    overall: "fail",
    reasons: ["Verifier output was not parseable as the required frozen-gate-fix-loop JSON verdict."],
    feedback: "",
  };
}

function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  for (const candidate of [trimmed, ...extractFenceContents(trimmed), extractBalancedObject(trimmed)].filter(Boolean) as string[]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
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

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item).trim()).filter(Boolean);
}

// ── Report ───────────────────────────────────────────────────────────────

function serializableParams(params: OrchestrationShapeContext["params"]): Record<string, unknown> {
  return JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
}

function buildReport(
  status: "pass" | "fail",
  task: string,
  spawnGuard: SpawnGuard,
  routesLine: string,
  phaseRecords: PhaseRecord[],
  maxAttempts: number,
): string {
  const attempts = phaseRecords.filter((r) => r.name.startsWith("verify-")).length;
  const lines: string[] = [
    `# frozen-gate-fix-loop Orchestration: ${status.toUpperCase()}`,
    "",
    `**Task:** ${truncateWithNotice(task, 2000, "task")}`,
    `**Routes:** ${routesLine}`,
    `**Subagents spawned:** ${spawnGuard.spawned}/${spawnGuard.cap}`,
    `**Bounded-fix attempts:** ${attempts}/${maxAttempts}`,
    "",
    "## Phases",
  ];
  for (const record of phaseRecords) {
    const header = record.kind === "deterministic"
      ? `### ${record.name} — DETERMINISTIC (no LLM)`
      : `### ${record.name} — ${record.agentName ?? "?"} (route ${record.route ?? "inherited"}, ${record.durationMs ?? 0}ms)`;
    lines.push(header, record.detail);
  }
  lines.push(
    "",
    "## Orchestration Used",
    "frozen-gate-fix-loop runs a bounded-fix loop against a sha256-content-frozen gate document. " +
      "Phases 1 and 3 are DETERMINISTIC (non-LLM) sha256 verifications proving the gate was untouched before and after each executor fix. " +
      "The executor fixes ONLY the enumerated findings; an independent verifier re-checks raw artifacts with fail-closed JSON parsing; " +
      "the loop retries bounded on verifier FAIL and stops on the first PASS or when attempts are exhausted.",
  );
  return truncateWithNotice(lines.join("\n"), MAX_FINAL_CHARS, "final report");
}

function failReport(
  headline: string,
  detail: string,
  task: string,
  spawnGuard: SpawnGuard,
  routesLine: string,
  phaseRecords: PhaseRecord[],
): OrchestrationShapeResult {
  const lines: string[] = [
    `# frozen-gate-fix-loop Orchestration: FAIL`,
    "",
    `**Task:** ${truncateWithNotice(task, 2000, "task")}`,
    `**Routes:** ${routesLine}`,
    `**Subagents spawned:** ${spawnGuard.spawned}/${spawnGuard.cap}`,
    "",
    `## FAIL: ${headline}`,
    detail,
  ];
  if (phaseRecords.length) {
    lines.push("", "## Phases");
    for (const record of phaseRecords) {
      const header = record.kind === "deterministic"
        ? `### ${record.name} — DETERMINISTIC (no LLM)`
        : `### ${record.name} — ${record.agentName ?? "?"} (route ${record.route ?? "inherited"})`;
      lines.push(header, record.detail);
    }
  }
  return {
    markdown: truncateWithNotice(lines.join("\n"), MAX_FINAL_CHARS, "final report"),
    details: {
      status: "fail",
      paradigm: "frozen-gate-fix-loop",
      spawnedCount: spawnGuard.spawned,
      spawnedCap: spawnGuard.cap,
      routes: routesLine,
      failure: headline,
    },
  };
}

function deterministicFailReport(
  phaseName: string,
  error: unknown,
  task: string,
  spawnGuard: SpawnGuard,
  routesLine: string,
  phaseRecords: PhaseRecord[],
): OrchestrationShapeResult {
  const message = error instanceof DeterministicPhaseError
    ? `[${error.code}] ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
  return failReport(
    `Deterministic phase ${phaseName} failed (fail-closed, no retry).`,
    message,
    task,
    spawnGuard,
    routesLine,
    phaseRecords,
  );
}
