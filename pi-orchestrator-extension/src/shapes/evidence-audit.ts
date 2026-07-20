/**
 * Shape: evidence-audit
 * =====================
 * A hardened re-verifier over a COMPLETED run's evidence — what `verify-only`
 * should be for falsifier-grade work (WAVE3-SPEC ITEM A). It would have
 * mechanically caught the Shape-A stale-gate-JSON transient PASS: it audits raw
 * artifacts, never an executor narrative, and it NEVER modifies the audited tree.
 *
 * There is NO executor role in this shape — it spawns exactly ONE verifier and
 * ZERO executors. The verifier is instructed it has READ-ONLY intent toward the
 * evidence cwd (running read-only recompute commands is allowed; writing into
 * the audited tree is a contract violation).
 *
 * Phases (in order):
 *   1. freeze-verify     (DETERMINISTIC verify-hash): frozen gate doc sha256 ==
 *                         reference? Mismatch ⇒ structured FAIL, ZERO spawns.
 *   2. evidence-manifest (DETERMINISTIC manifest): sha256 + bytes of the declared
 *                         gate-evidence files (relative to EVIDENCE_CWD). Missing
 *                         file ⇒ structured FAIL, ZERO spawns so far. The manifest
 *                         IS the audit fingerprint — it is checkpointed.
 *   3. integrity-audit   (verifier): from raw artifacts only — run-id binding,
 *                         internal consistency, freshness; NO reliance on any
 *                         executor narrative. Strict fail-closed JSON verdict.
 *   4. final-re-verify   (DETERMINISTIC verify-hash): frozen doc byte-identical
 *                         after the audit (the auditor never modified it).
 *
 * Inputs are supplied via labeled fields in the task text and/or a referenced
 * SPEC_FILE (the spec-file pattern is preferred). Deterministic phases re-execute
 * on every invocation (resume-safe); the verifier restores from checkpoint.
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

// Fixed, pre-allocated stage names for index stability across resume.
const STAGE_NAMES: readonly string[] = ["freeze-verify", "evidence-manifest", "integrity-audit", "final-re-verify"];

// ── Parsed inputs ────────────────────────────────────────────────────────

interface EvidenceAuditInputs {
  frozenDocPath?: string;
  frozenSha256?: string;
  evidenceCwd?: string;
  runIdLabel?: string;
  auditFocus?: string;
  gateEvidenceFiles: string[];
  specFile?: string;
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

export const evidenceAuditShape: OrchestrationShape = {
  name: "evidence-audit",
  description:
    "Hardened re-verifier over a COMPLETED run's evidence (falsifier-grade verify-only). " +
    "Deterministically verifies the frozen gate document's sha256 (no LLM), builds a checkpointed " +
    "sha256 manifest of declared gate-evidence files (missing file ⇒ zero-spawn FAIL), then spawns " +
    "exactly ONE read-only verifier to audit run-id binding, internal consistency, and freshness from " +
    "raw artifacts (fail-closed JSON), and re-verifies the frozen doc was untouched. Spawns NO executor " +
    "and never writes into the audited tree. The spec-file input pattern is preferred.",
  run: runEvidenceAudit,
};

// ── Main flow ────────────────────────────────────────────────────────────

async function runEvidenceAudit(context: OrchestrationShapeContext): Promise<OrchestrationShapeResult> {
  const { params, signal, onUpdate, inheritedModel, agents } = context;
  const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }] });

  // Deterministic canary branch — no subagent spawn, no file mutation.
  if (params.task.trim().startsWith("SHAPE_CANARY:evidence-audit")) {
    return {
      markdown: "# evidence-audit Canary: PASS\n\nDeterministic shape canary passed.",
      details: {
        status: "pass",
        paradigm: "evidence-audit",
        canary: true,
        targetName: "evidence-audit",
        spawnedCount: 0,
        spawnedCap: 0,
      },
    };
  }

  // At most one verifier spawn — but keep the guard honest against maxSubagents.
  const spawnGuard = new SpawnGuard(Math.max(1, Math.min(params.maxSubagents, 1)));
  const indexOf = (name: string): number => STAGE_NAMES.indexOf(name);

  const verifierRoute = resolveRouteOverride(params.verifierModel, params.verifierProvider);
  const routesLine = `Verifier=${formatRouteLabel(verifierRoute)}`;

  const phaseRecords: PhaseRecord[] = [];

  // Parse inputs (task text overrides SPEC_FILE). Missing required fields ⇒
  // structured FAIL, ZERO spawns.
  const inputs = parseEvidenceAuditInputs(params.task, params.cwd);
  if (!inputs.frozenDocPath || !inputs.frozenSha256 || !inputs.evidenceCwd) {
    return failReport(
      "Missing required evidence-audit inputs.",
      `The task must supply FROZEN_DOC_PATH, FROZEN_DOC_SHA256, and EVIDENCE_CWD (the spec-file pattern via SPEC_FILE is preferred). ` +
        `Parsed: FROZEN_DOC_PATH=${inputs.frozenDocPath ?? "(none)"}, FROZEN_DOC_SHA256=${inputs.frozenSha256 ?? "(none)"}, EVIDENCE_CWD=${inputs.evidenceCwd ?? "(none)"}.`,
      params.task,
      spawnGuard,
      routesLine,
      phaseRecords,
    );
  }
  const frozenDocAbs = path.isAbsolute(inputs.frozenDocPath)
    ? inputs.frozenDocPath
    : path.resolve(params.cwd, inputs.frozenDocPath);
  const evidenceCwdAbs = path.isAbsolute(inputs.evidenceCwd)
    ? inputs.evidenceCwd
    : path.resolve(params.cwd, inputs.evidenceCwd);

  // Checkpoint/resume wiring (ABORT-RESUME-DESIGN.md). Deterministic phases
  // re-execute on every invocation; only the verifier restores/collects/respawns.
  const runId = context.runId;
  const resume = context.resumeState;
  const store = resume
    ? RunStateStore.open(resume.state.runId)
    : runId
      ? RunStateStore.create(runId, "evidence-audit", params.task, serializableParams(params), [...STAGE_NAMES])
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
        `Computed sha256=${String(freezeOut.outputs.sha256)}. This is an automatic FAIL.`,
      params.task,
      spawnGuard,
      routesLine,
      phaseRecords,
    );
  }

  // ── Phase 2: evidence-manifest (DETERMINISTIC) — still before any spawn ──
  let manifestOut: DeterministicPhaseOutput;
  try {
    emit(`evidence-audit: evidence-manifest (DETERMINISTIC manifest, no LLM, cwd=${evidenceCwdAbs}).`);
    manifestOut = await runDeterministicPhase({ op: "manifest", cwd: evidenceCwdAbs, inputs: { paths: inputs.gateEvidenceFiles } });
    store?.checkpointPhase(indexOf("evidence-manifest"), "evidence-manifest", checkpointPayload(manifestOut));
  } catch (error) {
    // Missing evidence file (MISSING_FILE) or invalid manifest path ⇒ zero-spawn FAIL.
    return deterministicFailReport("evidence-manifest", error, params.task, spawnGuard, routesLine, phaseRecords);
  }
  phaseRecords.push({ name: "evidence-manifest", kind: "deterministic", detail: formatDeterministicPhaseForReport(manifestOut) });

  // ── Phase 3: integrity-audit (LLM verifier, fail-closed JSON) ────────────
  throwIfAborted(signal);
  const auditName = "integrity-audit";
  const auditPrompt = buildAuditorPrompt(inputs, frozenDocAbs, evidenceCwdAbs, manifestOut, params.task);
  let auditResult: SubagentResult;
  try {
    auditResult = await runLlmPhase(auditName, params.verifierAgent, auditPrompt, verifierRoute);
  } catch (error) {
    return handleDetach(error, store, indexOf, auditName);
  }
  const verdict = parseVerdict(auditResult.text);
  phaseRecords.push({
    name: auditName, kind: "llm", agentName: auditResult.agentName,
    route: formatRouteLabel(verifierRoute), durationMs: auditResult.durationMs,
    detail: `verdict=${verdict.overall.toUpperCase()} — ${verdict.reasons.join("; ") || "no reasons"}`,
  });
  emit(`evidence-audit: integrity-audit verifier ${verdict.overall.toUpperCase()}.`);

  // ── Phase 4: final-re-verify (DETERMINISTIC tamper check) ────────────────
  let finalOut: DeterministicPhaseOutput;
  try {
    finalOut = await runDeterministicVerify("final-re-verify", frozenDocAbs, inputs.frozenSha256, params.cwd, store, indexOf, emit);
  } catch (error) {
    return deterministicFailReport("final-re-verify", error, params.task, spawnGuard, routesLine, phaseRecords);
  }
  phaseRecords.push({ name: "final-re-verify", kind: "deterministic", detail: formatDeterministicPhaseForReport(finalOut) });

  const freezeIntact = finalOut.ok && finalOut.outputs.match === true;
  if (!freezeIntact) {
    return failReport(
      `Frozen gate document was modified during the audit (tamper detected at final-re-verify).`,
      `Post-audit sha256=${String(finalOut.outputs.sha256)} no longer matches the reference ${inputs.frozenSha256}. ` +
        `The evidence-audit verifier must NEVER modify the frozen gate document; this is an automatic FAIL.`,
      params.task,
      spawnGuard,
      routesLine,
      phaseRecords,
    );
  }

  const status: "pass" | "fail" = verdict.overall === "pass" && freezeIntact ? "pass" : "fail";
  const markdown = buildReport(status, params.task, spawnGuard, routesLine, phaseRecords, verdict, manifestOut);
  return {
    markdown,
    details: {
      status,
      paradigm: "evidence-audit",
      spawnedCount: spawnGuard.spawned,
      spawnedCap: spawnGuard.cap,
      routes: routesLine,
      verdict: verdict.overall,
      manifest: manifestOut.outputs.entries,
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
      emit(`evidence-audit: ${name} restored from checkpoint (resume).`);
      return checkpoint;
    }
    // Resume path 2: detached survivor — collect its result or respawn.
    const survivor = resume?.survivors.get(index);
    if (survivor && store) {
      const collected = await collectSurvivorResult<SubagentResult>(survivor, emit, signal, "evidence-audit");
      if (collected) {
        store.checkpointPhase(index, name, collected);
        return collected;
      }
      emit(`evidence-audit: survivor for ${name} yielded no result — respawning.`);
    }

    throwIfAborted(signal);
    const spawned = spawnGuard.reserve();
    emit(`evidence-audit: ${name} spawning ${agentName} (${spawned}/${spawnGuard.cap}).`);
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
  emit(`evidence-audit: ${name} (DETERMINISTIC verify-hash, no LLM).`);
  const out = await runDeterministicPhase({ op: "verify-hash", cwd, inputs: { path: docAbs, reference } });
  store?.checkpointPhase(indexOf(name), name, checkpointPayload(out));
  return out;
}

// ── Input parsing ────────────────────────────────────────────────────────

interface ParsedFields {
  frozenDocPath?: string;
  frozenSha256?: string;
  evidenceCwd?: string;
  runIdLabel?: string;
  auditFocus?: string;
  specFile?: string;
  gateEvidenceFiles: string[];
}

function parseLabeledFields(text: string): ParsedFields {
  const field = (label: string): string | undefined => {
    const m = text.match(new RegExp(`^[ \\t]*${label}[ \\t]*:[ \\t]*(.+?)[ \\t]*$`, "im"));
    return m && m[1].trim() ? m[1].trim() : undefined;
  };
  return {
    frozenDocPath: field("FROZEN_DOC_PATH"),
    frozenSha256: field("FROZEN_DOC_SHA256"),
    evidenceCwd: field("EVIDENCE_CWD"),
    runIdLabel: field("RUN_ID_LABEL"),
    auditFocus: field("AUDIT_FOCUS"),
    specFile: field("SPEC_FILE"),
    gateEvidenceFiles: parseBlockList(text, "GATE_EVIDENCE_FILES"),
  };
}

/**
 * Merge labeled inputs from the task text and (preferred) a referenced SPEC_FILE.
 * Task text always overrides the same label sourced from the spec file. An
 * unreadable/invalid SPEC_FILE silently falls back to task-only inputs.
 */
function parseEvidenceAuditInputs(task: string, cwd: string): EvidenceAuditInputs {
  const fromTask = parseLabeledFields(task);

  let fromSpec: ParsedFields = { gateEvidenceFiles: [] };
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
    evidenceCwd: fromTask.evidenceCwd ?? fromSpec.evidenceCwd,
    runIdLabel: fromTask.runIdLabel ?? fromSpec.runIdLabel,
    auditFocus: fromTask.auditFocus ?? fromSpec.auditFocus,
    specFile: fromTask.specFile ?? fromSpec.specFile,
    gateEvidenceFiles: fromTask.gateEvidenceFiles.length ? fromTask.gateEvidenceFiles : fromSpec.gateEvidenceFiles,
  };
}

/**
 * Parse a labeled block list (inline `LABEL: a; b` and/or a following bullet
 * block). Same shape as frozen-gate-fix-loop's findings parser so the input
 * dialect is consistent across shapes.
 */
function parseBlockList(task: string, label: string): string[] {
  const lines = task.split(/\r?\n/);
  const startIndex = lines.findIndex((l) => new RegExp(`^[ \\t]*${label}[ \\t]*:`, "i").test(l));
  if (startIndex < 0) return [];
  const collected: string[] = [];
  const inline = lines[startIndex].replace(new RegExp(`^[ \\t]*${label}[ \\t]*:`, "i"), "").trim();
  if (inline) collected.push(...inline.split(/;/));
  for (let i = startIndex + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (/^[ \t]*[A-Z_]{3,}[ \t]*:/.test(raw)) break; // next labeled field
    const trimmed = raw.trim();
    if (!trimmed) {
      if (collected.length) break; // blank line ends the block
      continue;
    }
    collected.push(trimmed.replace(/^[-*\d.)\]]+[ \t]*/, ""));
  }
  return collected.map((s) => s.trim()).filter(Boolean);
}

// ── Prompt ───────────────────────────────────────────────────────────────

function buildAuditorPrompt(
  inputs: EvidenceAuditInputs,
  frozenDocAbs: string,
  evidenceCwdAbs: string,
  manifestOut: DeterministicPhaseOutput,
  originalTask: string,
): string {
  const manifestBlock = formatDeterministicPhaseForReport(manifestOut);
  return [
    "You are the VERIFIER in an evidence-audit orchestration.",
    "Do not invoke recursive orchestration. Work only on the phase prompt below.",
    "Do not trust any executor narrative — audit the RAW artifacts yourself.",
    inputs.specFile ? `Read this spec/audit file FIRST (authoritative): ${inputs.specFile}` : "",
    `Evidence cwd (the COMPLETED run's directory to audit): ${evidenceCwdAbs}`,
    `Frozen gate document (do NOT modify): ${frozenDocAbs}`,
    "READ-ONLY INTENT: You may run read-only recompute commands (re-run verification/tests, recompute hashes) " +
      "against the evidence cwd. You MUST NOT write, edit, delete, or otherwise modify ANY file inside the evidence " +
      "cwd or the frozen document — doing so is a contract violation that FAILs this audit.",
    inputs.runIdLabel ? `Expected run-id label: every gate-evidence file must be bound to run-id "${inputs.runIdLabel}" — no stale/mismatched run ids.` : "",
    inputs.auditFocus ? `Audit focus/questions: ${inputs.auditFocus}` : "",
    "Deterministic evidence manifest (sha256 + bytes of the declared gate-evidence files — this IS the audit fingerprint):",
    manifestBlock,
    "Checks (ALL must hold for PASS):",
    "1. Run-id binding: every gate-evidence file is bound to the expected run (no stale/mismatched/absent run ids).",
    "2. Internal consistency: metrics/gate JSONs are recomputable from the raw evidence where feasible (re-run the verification commands).",
    "3. Freshness: evidence timestamps are coherent with the run (no stale artifacts carried over from a prior run).",
    "4. No reliance on any executor narrative — cite raw-artifact evidence only.",
    `Original task:\n${truncateWithNotice(originalTask, 3000, "task")}`,
    'Return JSON exactly and only in this shape: {"overall":"pass"|"fail","reasons":["..."],"feedback":"...","evidence":["..."]}',
    'Use overall "pass" ONLY if every check passes. Empty/unparseable/unknown output is treated as FAIL.',
  ].filter(Boolean).join("\n\n");
}

// ── Verdict parsing (fail-closed) ─────────────────────────────────────────

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
    const overall: "pass" | "fail" = overallRaw === "pass" ? "pass" : "fail";
    const reasons = stringArray(raw.reasons) ?? [];
    const feedback = typeof raw.feedback === "string" ? raw.feedback.trim() : "";
    if (overallRaw === "pass" || overallRaw === "fail") return { overall, reasons, feedback };
  }
  return {
    overall: "fail",
    reasons: ["Verifier output was not parseable as the required evidence-audit JSON verdict."],
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
  verdict: Verdict,
  manifestOut: DeterministicPhaseOutput,
): string {
  const lines: string[] = [
    `# evidence-audit Orchestration: ${status.toUpperCase()}`,
    "",
    `**Task:** ${truncateWithNotice(task, 2000, "task")}`,
    `**Routes:** ${routesLine}`,
    `**Subagents spawned:** ${spawnGuard.spawned}/${spawnGuard.cap} (verifier only; NO executor)`,
    `**Audit verdict:** ${verdict.overall.toUpperCase()}${verdict.reasons.length ? ` — ${verdict.reasons.join("; ")}` : ""}`,
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
    "## Evidence Manifest (audit fingerprint)",
    formatDeterministicPhaseForReport(manifestOut),
    "",
    "## Orchestration Used",
    "evidence-audit re-verifies a COMPLETED run's raw evidence. Phases 1 and 4 are DETERMINISTIC (non-LLM) sha256 " +
      "verifications proving the frozen gate document was untouched before and after the audit. Phase 2 is a DETERMINISTIC " +
      "sha256 manifest of the declared gate-evidence files (the audit fingerprint; a missing file is a zero-spawn FAIL). " +
      "Phase 3 spawns exactly ONE read-only verifier (NO executor) that audits run-id binding, internal consistency, and " +
      "freshness from raw artifacts with fail-closed JSON parsing. The shape never writes into the audited tree.",
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
    `# evidence-audit Orchestration: FAIL`,
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
      paradigm: "evidence-audit",
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
