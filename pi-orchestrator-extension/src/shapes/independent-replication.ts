/**
 * Shape: independent-replication
 * ==============================
 * Codifies the production-proven K1/G2 two-shape pattern (WAVE3-SPEC ITEM B):
 * TWO INDEPENDENT implementations of ONE frozen gate, in isolated subdirectories,
 * routed to (ideally) different models, then compared HONESTLY with an
 * auto-computed diversity caveat.
 *
 * This is a self-contained META-shape: it spawns its OWN executor/verifier pairs
 * per lane; it does NOT invoke other shapes. The overall verdict is aggregated
 * IN CODE (not by an LLM), and the diversity statement is COMPUTED from the
 * RESOLVED routes — never hardcoded — so the honest caveat we hand-wrote in the
 * K1/G2 ledgers is now mechanical.
 *
 * Phases (in order):
 *   1. freeze-verify   (DETERMINISTIC): frozen doc sha256 == reference? Mismatch
 *                       ⇒ structured FAIL, ZERO LLM spawns.
 *   2. implement-A     (executor, CONFINED to the lane-A subdir).
 *   3. verify-A        (verifier, raw artifacts, fail-closed JSON).
 *   4. mid-re-verify   (DETERMINISTIC): frozen doc unchanged after lane A.
 *   5. implement-B     (executor per lane-B routes, CONFINED to the lane-B subdir;
 *                       prompt forbids reading the lane-A subdir).
 *   6. verify-B        (verifier per lane-B routes, fail-closed JSON).
 *   7. final-re-verify (DETERMINISTIC): frozen doc unchanged after lane B.
 *   8. IN-CODE verdict aggregation: overall PASS iff verdictA==pass AND
 *      verdictB==pass AND all three freeze checks passed. A diversity statement
 *      is auto-emitted from the resolved lane-A vs lane-B routes.
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
const STAGE_NAMES: readonly string[] = [
  "freeze-verify", "implement-A", "verify-A", "mid-re-verify", "implement-B", "verify-B", "final-re-verify",
];

// A lane-confinement instruction reused (verbatim substring) in BOTH executor
// prompts, so the static test can assert its presence.
const LANE_CONFINEMENT = "LANE CONFINEMENT: You MUST confine ALL file reads and writes to your assigned lane subdirectory";

type Route = { provider?: string; model?: string } | undefined;

// ── Parsed inputs ────────────────────────────────────────────────────────

interface IndependentReplicationInputs {
  frozenDocPath?: string;
  frozenSha256?: string;
  baseCwd?: string;
  laneASubdir: string;
  laneBSubdir: string;
  laneBExecutorProvider?: string;
  laneBExecutorModel?: string;
  laneBVerifierProvider?: string;
  laneBVerifierModel?: string;
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

export const independentReplicationShape: OrchestrationShape = {
  name: "independent-replication",
  description:
    "Two INDEPENDENT implementations of ONE frozen gate, in isolated lane subdirectories, routed to " +
    "(ideally) different models, compared honestly. Deterministically verifies the frozen gate document's " +
    "sha256 (no LLM) before, between, and after the two lanes (tamper-proof). Each lane runs its own " +
    "executor (confined to its subdir; lane B forbidden from reading lane A) then verifier (fail-closed JSON). " +
    "The overall verdict is aggregated IN CODE (PASS iff both lanes PASS and all freeze checks hold), and a " +
    "diversity caveat is COMPUTED from the resolved lane routes (fully-disjoint vs shared-model narrowed).",
  run: runIndependentReplication,
};

// ── Main flow ────────────────────────────────────────────────────────────

async function runIndependentReplication(context: OrchestrationShapeContext): Promise<OrchestrationShapeResult> {
  const { params, signal, onUpdate, inheritedModel, agents } = context;
  const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }] });

  // Deterministic canary branch — no subagent spawn, no file mutation.
  if (params.task.trim().startsWith("SHAPE_CANARY:independent-replication")) {
    return {
      markdown: "# independent-replication Canary: PASS\n\nDeterministic shape canary passed.",
      details: {
        status: "pass",
        paradigm: "independent-replication",
        canary: true,
        targetName: "independent-replication",
        spawnedCount: 0,
        spawnedCap: 0,
      },
    };
  }

  const spawnGuard = new SpawnGuard(Math.max(4, Math.min(params.maxSubagents, 4)));
  const indexOf = (name: string): number => STAGE_NAMES.indexOf(name);

  const phaseRecords: PhaseRecord[] = [];

  // Parse inputs (task text overrides SPEC_FILE).
  const inputs = parseInputs(params.task, params.cwd);

  // Resolve lane routes. Lane A = executor/verifier override params. Lane B =
  // labeled LANE_B_* fields, falling back to lane A routes.
  const laneAExec: Route = resolveRouteOverride(params.executorModel, params.executorProvider);
  const laneAVerif: Route = resolveRouteOverride(params.verifierModel, params.verifierProvider);
  const laneBExec: Route = resolveRouteOverride(inputs.laneBExecutorModel, inputs.laneBExecutorProvider) ?? laneAExec;
  const laneBVerif: Route = resolveRouteOverride(inputs.laneBVerifierModel, inputs.laneBVerifierProvider) ?? laneAVerif;
  const routesLine =
    `LaneA[Executor=${formatRouteLabel(laneAExec)} Verifier=${formatRouteLabel(laneAVerif)}] ` +
    `LaneB[Executor=${formatRouteLabel(laneBExec)} Verifier=${formatRouteLabel(laneBVerif)}]`;

  // Missing required fields ⇒ structured FAIL, ZERO spawns.
  if (!inputs.frozenDocPath || !inputs.frozenSha256 || !inputs.baseCwd) {
    return failReport(
      "Missing required independent-replication inputs.",
      `The task must supply FROZEN_DOC_PATH, FROZEN_DOC_SHA256, and BASE_CWD (the spec-file pattern via SPEC_FILE is preferred). ` +
        `Parsed: FROZEN_DOC_PATH=${inputs.frozenDocPath ?? "(none)"}, FROZEN_DOC_SHA256=${inputs.frozenSha256 ?? "(none)"}, BASE_CWD=${inputs.baseCwd ?? "(none)"}.`,
      params.task,
      spawnGuard,
      routesLine,
      phaseRecords,
    );
  }
  const frozenDocAbs = path.isAbsolute(inputs.frozenDocPath)
    ? inputs.frozenDocPath
    : path.resolve(params.cwd, inputs.frozenDocPath);
  const baseCwdAbs = path.isAbsolute(inputs.baseCwd) ? inputs.baseCwd : path.resolve(params.cwd, inputs.baseCwd);
  const laneADir = path.resolve(baseCwdAbs, inputs.laneASubdir);
  const laneBDir = path.resolve(baseCwdAbs, inputs.laneBSubdir);

  // Checkpoint/resume wiring (ABORT-RESUME-DESIGN.md). Deterministic phases
  // re-execute; only LLM phases restore/collect/respawn.
  const runId = context.runId;
  const resume = context.resumeState;
  const store = resume
    ? RunStateStore.open(resume.state.runId)
    : runId
      ? RunStateStore.create(runId, "independent-replication", params.task, serializableParams(params), [...STAGE_NAMES])
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

  // Lane subdirs must be pre-existing or creatable (only AFTER freeze passes).
  try {
    fs.mkdirSync(laneADir, { recursive: true });
    fs.mkdirSync(laneBDir, { recursive: true });
  } catch (error) {
    return failReport(
      "Could not create/access the lane subdirectories.",
      `laneA=${laneADir}, laneB=${laneBDir}: ${(error as Error).message}`,
      params.task,
      spawnGuard,
      routesLine,
      phaseRecords,
    );
  }

  // ── Lane A: implement-A → verify-A ───────────────────────────────────────
  throwIfAborted(signal);
  let verdictA: Verdict;
  {
    const implPrompt = buildExecutorPrompt("A", frozenDocAbs, laneADir, undefined, params.task, inputs);
    let implResult: SubagentResult;
    try {
      implResult = await runLlmPhase("implement-A", params.executorAgent, implPrompt, laneAExec);
    } catch (error) {
      return handleDetach(error, store, indexOf, "implement-A");
    }
    phaseRecords.push({
      name: "implement-A", kind: "llm", agentName: implResult.agentName,
      route: formatRouteLabel(laneAExec), durationMs: implResult.durationMs,
      detail: truncateWithNotice(implResult.text, 3000, "implement-A output"),
    });

    // mid-re-verify happens AFTER verify-A below; but detect a lane-A tamper as
    // early as possible via verify-A's own artifacts is not deterministic, so we
    // rely on the deterministic mid-re-verify gate.
    const verifyPrompt = buildVerifierPrompt("A", frozenDocAbs, laneADir, implResult.text, params.task, inputs);
    let verifyResult: SubagentResult;
    try {
      verifyResult = await runLlmPhase("verify-A", params.verifierAgent, verifyPrompt, laneAVerif);
    } catch (error) {
      return handleDetach(error, store, indexOf, "verify-A");
    }
    verdictA = parseVerdict(verifyResult.text);
    phaseRecords.push({
      name: "verify-A", kind: "llm", agentName: verifyResult.agentName,
      route: formatRouteLabel(laneAVerif), durationMs: verifyResult.durationMs,
      detail: `verdict=${verdictA.overall.toUpperCase()} — ${verdictA.reasons.join("; ") || "no reasons"}`,
    });
  }

  // ── Phase 4: mid-re-verify (DETERMINISTIC tamper check after lane A) ─────
  let midOut: DeterministicPhaseOutput;
  try {
    midOut = await runDeterministicVerify("mid-re-verify", frozenDocAbs, inputs.frozenSha256, params.cwd, store, indexOf, emit);
  } catch (error) {
    return deterministicFailReport("mid-re-verify", error, params.task, spawnGuard, routesLine, phaseRecords);
  }
  phaseRecords.push({ name: "mid-re-verify", kind: "deterministic", detail: formatDeterministicPhaseForReport(midOut) });
  if (!midOut.ok || midOut.outputs.match !== true) {
    return failReport(
      `Frozen gate document was modified during lane A (tamper detected at mid-re-verify).`,
      `Post-lane-A sha256=${String(midOut.outputs.sha256)} no longer matches the reference ${inputs.frozenSha256}. ` +
        `Lane executors must NEVER modify the frozen gate document; this is an automatic FAIL. Lane B was NOT run.`,
      params.task,
      spawnGuard,
      routesLine,
      phaseRecords,
    );
  }

  // ── Lane B: implement-B → verify-B ───────────────────────────────────────
  throwIfAborted(signal);
  let verdictB: Verdict;
  {
    const implPrompt = buildExecutorPrompt("B", frozenDocAbs, laneBDir, laneADir, params.task, inputs);
    let implResult: SubagentResult;
    try {
      implResult = await runLlmPhase("implement-B", params.executorAgent, implPrompt, laneBExec);
    } catch (error) {
      return handleDetach(error, store, indexOf, "implement-B");
    }
    phaseRecords.push({
      name: "implement-B", kind: "llm", agentName: implResult.agentName,
      route: formatRouteLabel(laneBExec), durationMs: implResult.durationMs,
      detail: truncateWithNotice(implResult.text, 3000, "implement-B output"),
    });

    const verifyPrompt = buildVerifierPrompt("B", frozenDocAbs, laneBDir, implResult.text, params.task, inputs);
    let verifyResult: SubagentResult;
    try {
      verifyResult = await runLlmPhase("verify-B", params.verifierAgent, verifyPrompt, laneBVerif);
    } catch (error) {
      return handleDetach(error, store, indexOf, "verify-B");
    }
    verdictB = parseVerdict(verifyResult.text);
    phaseRecords.push({
      name: "verify-B", kind: "llm", agentName: verifyResult.agentName,
      route: formatRouteLabel(laneBVerif), durationMs: verifyResult.durationMs,
      detail: `verdict=${verdictB.overall.toUpperCase()} — ${verdictB.reasons.join("; ") || "no reasons"}`,
    });
  }

  // ── Phase 7: final-re-verify (DETERMINISTIC tamper check after lane B) ───
  let finalOut: DeterministicPhaseOutput;
  try {
    finalOut = await runDeterministicVerify("final-re-verify", frozenDocAbs, inputs.frozenSha256, params.cwd, store, indexOf, emit);
  } catch (error) {
    return deterministicFailReport("final-re-verify", error, params.task, spawnGuard, routesLine, phaseRecords);
  }
  phaseRecords.push({ name: "final-re-verify", kind: "deterministic", detail: formatDeterministicPhaseForReport(finalOut) });
  if (!finalOut.ok || finalOut.outputs.match !== true) {
    return failReport(
      `Frozen gate document was modified during lane B (tamper detected at final-re-verify).`,
      `Post-lane-B sha256=${String(finalOut.outputs.sha256)} no longer matches the reference ${inputs.frozenSha256}. ` +
        `Lane executors must NEVER modify the frozen gate document; this is an automatic FAIL.`,
      params.task,
      spawnGuard,
      routesLine,
      phaseRecords,
    );
  }

  // ── Phase 8: IN-CODE verdict aggregation + computed diversity statement ──
  const allFreezeOk = freezeOut.outputs.match === true && midOut.outputs.match === true && finalOut.outputs.match === true;
  const status: "pass" | "fail" = verdictA.overall === "pass" && verdictB.overall === "pass" && allFreezeOk ? "pass" : "fail";
  const diversity = computeDiversityStatement(laneAExec, laneBExec, laneAVerif, laneBVerif);

  const markdown = buildReport(status, params.task, spawnGuard, routesLine, phaseRecords, verdictA, verdictB, diversity);
  return {
    markdown,
    details: {
      status,
      paradigm: "independent-replication",
      spawnedCount: spawnGuard.spawned,
      spawnedCap: spawnGuard.cap,
      routes: routesLine,
      verdictA: verdictA.overall,
      verdictB: verdictB.overall,
      diversity,
      phases: phaseRecords.map((r) => ({ name: r.name, kind: r.kind, agentName: r.agentName, route: r.route })),
    },
  };

  // ── Inner helpers (closures capturing store/signal/agents/etc.) ──────────

  async function runLlmPhase(
    name: string,
    agentName: string,
    prompt: string,
    route: Route,
  ): Promise<SubagentResult> {
    const index = indexOf(name);
    const checkpoint = resume?.checkpoints.get(index);
    if (checkpoint) {
      emit(`independent-replication: ${name} restored from checkpoint (resume).`);
      return checkpoint;
    }
    const survivor = resume?.survivors.get(index);
    if (survivor && store) {
      const collected = await collectSurvivorResult<SubagentResult>(survivor, emit, signal, "independent-replication");
      if (collected) {
        store.checkpointPhase(index, name, collected);
        return collected;
      }
      emit(`independent-replication: survivor for ${name} yielded no result — respawning.`);
    }

    throwIfAborted(signal);
    const spawned = spawnGuard.reserve();
    emit(`independent-replication: ${name} spawning ${agentName} (${spawned}/${spawnGuard.cap}).`);
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
  emit(`independent-replication: ${name} (DETERMINISTIC verify-hash, no LLM).`);
  const out = await runDeterministicPhase({ op: "verify-hash", cwd, inputs: { path: docAbs, reference } });
  store?.checkpointPhase(indexOf(name), name, checkpointPayload(out));
  return out;
}

// ── Diversity statement (COMPUTED from resolved routes; never hardcoded) ──

function routeKey(route: Route): string {
  return `${route?.provider ?? "(inherited)"}/${route?.model ?? "(inherited)"}`;
}

function routesEqual(a: Route, b: Route): boolean {
  return routeKey(a) === routeKey(b);
}

/**
 * Compute the honest diversity caveat from the RESOLVED lane routes. When both
 * lanes share the same executor (and/or verifier) route — including the
 * both-inherited case — independence is structural (separate subdirs/prompts)
 * but NOT model-diverse, so we emit the narrowed-independence caveat. When the
 * executor AND verifier routes are both disjoint, we state full disjointness.
 */
function computeDiversityStatement(laneAExec: Route, laneBExec: Route, laneAVerif: Route, laneBVerif: Route): string {
  const execSame = routesEqual(laneAExec, laneBExec);
  const verifSame = routesEqual(laneAVerif, laneBVerif);
  if (!execSame && !verifSame) {
    return `Route diversity: fully disjoint — lane A (executor ${routeKey(laneAExec)}, verifier ${routeKey(laneAVerif)}) and ` +
      `lane B (executor ${routeKey(laneBExec)}, verifier ${routeKey(laneBVerif)}) use different executor AND verifier routes; ` +
      `the two implementations are maximally independent.`;
  }
  const shared: string[] = [];
  if (execSame) shared.push(`shared executor model (${routeKey(laneAExec)})`);
  if (verifSame) shared.push(`shared verifier model (${routeKey(laneAVerif)})`);
  return `Route diversity: narrowed — independent implementations, ${shared.join(" and ")} — diversity narrowed. ` +
    `Independence is structural (separate lane subdirectories and lane-confined prompts) rather than model-diverse.`;
}

// ── Input parsing ────────────────────────────────────────────────────────

interface ParsedFields {
  frozenDocPath?: string;
  frozenSha256?: string;
  baseCwd?: string;
  laneASubdir?: string;
  laneBSubdir?: string;
  laneBExecutorProvider?: string;
  laneBExecutorModel?: string;
  laneBVerifierProvider?: string;
  laneBVerifierModel?: string;
  specFile?: string;
}

function parseLabeledFields(text: string): ParsedFields {
  const field = (label: string): string | undefined => {
    const m = text.match(new RegExp(`^[ \\t]*${label}[ \\t]*:[ \\t]*(.+?)[ \\t]*$`, "im"));
    return m && m[1].trim() ? m[1].trim() : undefined;
  };
  return {
    frozenDocPath: field("FROZEN_DOC_PATH"),
    frozenSha256: field("FROZEN_DOC_SHA256"),
    baseCwd: field("BASE_CWD"),
    laneASubdir: field("LANE_A_SUBDIR"),
    laneBSubdir: field("LANE_B_SUBDIR"),
    laneBExecutorProvider: field("LANE_B_EXECUTOR_PROVIDER"),
    laneBExecutorModel: field("LANE_B_EXECUTOR_MODEL"),
    laneBVerifierProvider: field("LANE_B_VERIFIER_PROVIDER"),
    laneBVerifierModel: field("LANE_B_VERIFIER_MODEL"),
    specFile: field("SPEC_FILE"),
  };
}

function parseInputs(task: string, cwd: string): IndependentReplicationInputs {
  const fromTask = parseLabeledFields(task);

  let fromSpec: ParsedFields = {};
  const specFileRef = fromTask.specFile;
  if (specFileRef) {
    const specAbs = path.isAbsolute(specFileRef) ? specFileRef : path.resolve(cwd, specFileRef);
    try {
      fromSpec = parseLabeledFields(fs.readFileSync(specAbs, "utf8"));
    } catch {
      // Invalid/unreadable spec file: fall back to task-only inputs.
    }
  }

  const pick = (a?: string, b?: string): string | undefined => a ?? b;
  return {
    frozenDocPath: pick(fromTask.frozenDocPath, fromSpec.frozenDocPath),
    frozenSha256: pick(fromTask.frozenSha256, fromSpec.frozenSha256)?.toLowerCase(),
    baseCwd: pick(fromTask.baseCwd, fromSpec.baseCwd),
    laneASubdir: pick(fromTask.laneASubdir, fromSpec.laneASubdir) ?? "laneA",
    laneBSubdir: pick(fromTask.laneBSubdir, fromSpec.laneBSubdir) ?? "laneB",
    laneBExecutorProvider: pick(fromTask.laneBExecutorProvider, fromSpec.laneBExecutorProvider),
    laneBExecutorModel: pick(fromTask.laneBExecutorModel, fromSpec.laneBExecutorModel),
    laneBVerifierProvider: pick(fromTask.laneBVerifierProvider, fromSpec.laneBVerifierProvider),
    laneBVerifierModel: pick(fromTask.laneBVerifierModel, fromSpec.laneBVerifierModel),
    specFile: pick(fromTask.specFile, fromSpec.specFile),
  };
}

// ── Prompts ──────────────────────────────────────────────────────────────

function buildExecutorPrompt(
  lane: "A" | "B",
  frozenDocAbs: string,
  laneDir: string,
  forbiddenLaneDir: string | undefined,
  originalTask: string,
  inputs: IndependentReplicationInputs,
): string {
  return [
    `You are the EXECUTOR for LANE ${lane} in an independent-replication orchestration.`,
    "Do not invoke recursive orchestration. Work only on the phase prompt below.",
    inputs.specFile ? `Read this spec file FIRST (authoritative): ${inputs.specFile}` : "",
    `A FROZEN gate document governs acceptance: ${frozenDocAbs}`,
    "You MUST NOT modify the frozen gate document in any way — it is content-hash locked and re-verified after you finish.",
    `${LANE_CONFINEMENT}: ${laneDir}`,
    forbiddenLaneDir
      ? `You MUST NOT read, inspect, copy, or reference the other lane's subdirectory (${forbiddenLaneDir}) — the two implementations must be INDEPENDENT. Reading lane A is a contract violation the verifier will FAIL.`
      : "Implement your solution from the frozen gate document ALONE — this is one of two independent implementations.",
    "Produce a real, self-contained implementation of the frozen gate inside your lane subdirectory.",
    `Original task:\n${truncateWithNotice(originalTask, 3000, "task")}`,
    "Expected output: the list of files you created (all under your lane subdir), and an explicit statement that the frozen gate document was NOT modified.",
  ].filter(Boolean).join("\n\n");
}

function buildVerifierPrompt(
  lane: "A" | "B",
  frozenDocAbs: string,
  laneDir: string,
  executorText: string,
  originalTask: string,
  inputs: IndependentReplicationInputs,
): string {
  return [
    `You are the VERIFIER for LANE ${lane} in an independent-replication orchestration.`,
    "Do not trust the executor narrative. Verify raw artifacts yourself.",
    inputs.specFile ? `Read this spec file FIRST (authoritative): ${inputs.specFile}` : "",
    `Frozen gate document (do NOT modify): ${frozenDocAbs}`,
    `Lane ${lane} implementation directory to verify: ${laneDir}`,
    "Checks (all must hold for PASS):",
    `1. The lane ${lane} implementation satisfies the frozen gate document.`,
    `2. All artifacts are confined to the lane subdirectory (${laneDir}); nothing leaked outside it.`,
    "3. The frozen gate document was not modified.",
    `Executor report (untrusted):\n${truncateWithNotice(executorText, 3000, "executor report")}`,
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
    reasons: ["Verifier output was not parseable as the required independent-replication JSON verdict."],
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
  verdictA: Verdict,
  verdictB: Verdict,
  diversity: string,
): string {
  const lines: string[] = [
    `# independent-replication Orchestration: ${status.toUpperCase()}`,
    "",
    `**Task:** ${truncateWithNotice(task, 2000, "task")}`,
    `**Routes:** ${routesLine}`,
    `**Subagents spawned:** ${spawnGuard.spawned}/${spawnGuard.cap}`,
    `**Lane A verdict:** ${verdictA.overall.toUpperCase()} | **Lane B verdict:** ${verdictB.overall.toUpperCase()}`,
    `**${diversity}**`,
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
    "independent-replication runs TWO independent implementations of one sha256-content-frozen gate document in " +
      "isolated lane subdirectories. Phases 1, 4, and 7 are DETERMINISTIC (non-LLM) sha256 verifications proving the " +
      "gate was untouched before, between, and after the two lanes. Each lane runs its own lane-confined executor then " +
      "an independent verifier with fail-closed JSON parsing. The overall verdict is aggregated IN CODE (PASS iff both " +
      "lanes PASS and all freeze checks hold), and the diversity caveat above is COMPUTED from the resolved lane routes.",
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
    `# independent-replication Orchestration: FAIL`,
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
      paradigm: "independent-replication",
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
