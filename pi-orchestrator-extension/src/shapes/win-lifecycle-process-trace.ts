/**
 * Shape: win-lifecycle-process-trace
 * ===================================
 * Non-invasive Windows lifecycle process-trace runbook and harness
 * materialization shape. Creates a repeatable diagnostic harness and
 * verification contract for Windows Pi process-creation tracing across
 * cold start, open-from-Terminal, reload, and new-session lifecycles.
 *
 * This shape does NOT run the monitor or investigation itself. It produces
 * a runbook, a non-invasive diagnostic harness (scripts/configs that do not
 * modify Pi or Windows config), and a falsifiable verification contract.
 * A SEPARATE human-approved run is required to execute the harness against
 * live Pi processes.
 *
 * One-line rule: Shapes are siblings — they stand on the substrate, never
 * build on each other.
 *
 * Finite phases:
 *   a. trace-runbook-and-harness-plan — planner role (openai-codex/gpt-5.5)
 *      maps lifecycle boundaries, instrumentation plan, and correlation
 *      windows. No file edits, no external process launch.
 *   b. non-invasive-harness-materialization — executor role
 *      (deepseek/deepseek-v4-pro) produces the harness artifacts
 *      (scripts, configs, trace instructions) and verification checklist.
 *      NON-INVASIVE: no config mutation, no live Pi interception.
 *   c. trace-evidence-verification — reviewer/verifier role
 *      (openai-codex/gpt-5.5) judges the harness materials against the
 *      verification contract. Must FAIL if evidence is static-only, lacks
 *      external process-creation logs, lacks action markers/correlation
 *      windows, omits cold/reload/new-session paths, lacks rollback/safety,
 *      executor route is wrong, or visible orchestrator did main-task work.
 */

import {
  SpawnGuard,
  spawnSubagent,
  throwIfAborted,
  truncateWithNotice,
  formatRoutedModel,
  type AgentProfile,
  type SubagentResult,
} from "../substrate";

import type {
  OrchestrationShape,
  OrchestrationShapeContext,
  OrchestrationShapeResult,
} from "../types";

// ── Constants ─────────────────────────────────────────────────────────────

const PHASE_NAMES = [
  "trace-runbook-and-harness-plan",
  "non-invasive-harness-materialization",
  "trace-evidence-verification",
] as const;

const MAX_FINAL_CHARS = 24_000;
const MAX_DETAIL_CHARS = 5_000;

const DEFAULT_PLANNER_PROVIDER = "openai-codex";
const DEFAULT_PLANNER_MODEL = "gpt-5.5";
const DEFAULT_EXECUTOR_PROVIDER = "deepseek";
const DEFAULT_EXECUTOR_MODEL = "deepseek-v4-pro";
const DEFAULT_VERIFIER_PROVIDER = "openai-codex";
const DEFAULT_VERIFIER_MODEL = "gpt-5.5";

// ── Shape export ─────────────────────────────────────────────────────────

export const winLifecycleProcessTraceShape: OrchestrationShape = {
  name: "win-lifecycle-process-trace",
  description:
    "Non-invasive Windows lifecycle process-trace runbook + harness " +
    "materialization: planner maps lifecycle boundaries and correlation " +
    "windows via GPT-5.5, executor produces non-invasive harness materials " +
    "via DeepSeek V4 Pro, verifier judges with GPT-5.5. " +
    "Shape is non-invasive until a separate human-approved run; must not " +
    "fake evidence.",
  run: runWinLifecycleProcessTrace,
};

// ── Main orchestration ────────────────────────────────────────────────────

async function runWinLifecycleProcessTrace(
  context: OrchestrationShapeContext,
): Promise<OrchestrationShapeResult> {
  const { params, signal, onUpdate, inheritedModel, agents } = context;
  const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }] });

  const spawnGuard = new SpawnGuard(Math.min(params.maxSubagents, 6));
  emit("win-lifecycle-process-trace: starting 3-phase non-invasive harness orchestration.");

  throwIfAborted(signal);

  // Resolve model/provider overrides: explicit params > shape defaults.
  const plannerOverride = resolveModelOverride(
    params.plannerModel,
    params.plannerProvider,
    DEFAULT_PLANNER_MODEL,
    DEFAULT_PLANNER_PROVIDER,
  );
  const executorOverride = resolveModelOverride(
    params.executorModel,
    params.executorProvider,
    DEFAULT_EXECUTOR_MODEL,
    DEFAULT_EXECUTOR_PROVIDER,
  );
  const verifierOverride = resolveModelOverride(
    params.verifierModel,
    params.verifierProvider,
    DEFAULT_VERIFIER_MODEL,
    DEFAULT_VERIFIER_PROVIDER,
  );

  const runnerModel = formatRoutedModel(
    executorOverride.provider,
    executorOverride.model,
  );
  emit(
    `win-lifecycle-process-trace: model routing — ` +
    `planner=${formatRoutedModel(plannerOverride.provider, plannerOverride.model)}, ` +
    `executor=${runnerModel}, ` +
    `verifier=${formatRoutedModel(verifierOverride.provider, verifierOverride.model)}.`,
  );

  // Phase outputs
  const phaseOutputs: SubagentResult[] = [];

  // ── Phase 1: trace-runbook-and-harness-plan ────────────────────────────
  {
    throwIfAborted(signal);
    const spawned = spawnGuard.reserve();
    emit(
      `win-lifecycle-process-trace: phase 1/3 trace-runbook-and-harness-plan ` +
      `spawning planner (${spawned}/${spawnGuard.cap}).`,
    );
    const result = await spawnSubagent(
      params.plannerAgent,
      buildPlannerPrompt(params.task),
      {
        agents,
        cwd: params.cwd,
        allowLocalModel: params.allowLocalModel,
        signal,
        inheritedModel,
        onProgress: emit,
        modelOverride: plannerOverride,
      },
    );
    phaseOutputs.push(result);
    emit(
      `win-lifecycle-process-trace: phase 1 complete — planner ` +
      `(${formatRoutedModel(plannerOverride.provider, plannerOverride.model)}) ` +
      `returned ${result.events} events in ${result.durationMs}ms.`,
    );
  }

  // ── Phase 2: non-invasive-harness-materialization ─────────────────────
  {
    throwIfAborted(signal);
    const spawned = spawnGuard.reserve();
    const plannerRunbook = phaseOutputs[0]?.text ?? "";
    emit(
      `win-lifecycle-process-trace: phase 2/3 non-invasive-harness-materialization ` +
      `spawning executor (${spawned}/${spawnGuard.cap}) via ${runnerModel}.`,
    );
    const result = await spawnSubagent(
      params.executorAgent,
      buildExecutorPrompt(params.task, plannerRunbook),
      {
        agents,
        cwd: params.cwd,
        allowLocalModel: params.allowLocalModel,
        signal,
        inheritedModel,
        onProgress: emit,
        modelOverride: executorOverride,
      },
    );
    phaseOutputs.push(result);
    emit(
      `win-lifecycle-process-trace: phase 2 complete — executor ` +
      `(${runnerModel}) returned ${result.events} events ` +
      `in ${result.durationMs}ms.`,
    );
  }

  // ── Phase 3: trace-evidence-verification ──────────────────────────────
  {
    throwIfAborted(signal);
    const spawned = spawnGuard.reserve();
    const executorOutput = phaseOutputs[1]?.text ?? "";
    emit(
      `win-lifecycle-process-trace: phase 3/3 trace-evidence-verification ` +
      `spawning verifier (${spawned}/${spawnGuard.cap}).`,
    );
    const result = await spawnSubagent(
      params.verifierAgent,
      buildVerifierPrompt(params.task, executorOutput, runnerModel),
      {
        agents,
        cwd: params.cwd,
        allowLocalModel: params.allowLocalModel,
        signal,
        inheritedModel,
        onProgress: emit,
        modelOverride: verifierOverride,
      },
    );
    phaseOutputs.push(result);
    emit(
      `win-lifecycle-process-trace: phase 3 complete — verifier ` +
      `(${formatRoutedModel(verifierOverride.provider, verifierOverride.model)}) ` +
      `returned ${result.events} events in ${result.durationMs}ms.`,
    );
  }

  // ── Deterministic status from phase outputs ────────────────────────────
  const allClean = phaseOutputs.every((o) => o.exitCode === 0);
  let status: "pass" | "fail" = allClean ? "pass" : "fail";

  // Verifier falsification gate: even with exit code 0, the verifier's
  // textual output may indicate failure. Parse and override if needed.
  // Empty/unparseable verifier output fails closed.
  const verifierPhase = phaseOutputs[2];
  const verifierVerdict = parseVerifierVerdict(verifierPhase?.text ?? "");
  if (verifierVerdict.isFail) {
    status = "fail";
  }

  const markdown = buildReport(
    status,
    params.task,
    spawnGuard,
    phaseOutputs,
    runnerModel,
    verifierVerdict,
  );
  const details = buildDetails(
    status,
    params,
    spawnGuard,
    phaseOutputs,
    plannerOverride,
    executorOverride,
    verifierOverride,
    verifierVerdict,
  );

  return { markdown, details };
}

// ── Prompt builders ───────────────────────────────────────────────────────

function buildPlannerPrompt(originalTask: string): string {
  return `You are the PLANNER in a win-lifecycle-process-trace orchestration.

Your role: trace-runbook-and-harness-plan. Map lifecycle boundaries, correlation
windows, and an instrumentation plan for Windows Pi process-creation tracing.
NO file edits, NO external process launches. You are routed via GPT-5.5
(openai-codex) for high-level reasoning.

THIS SHAPE IS NON-INVASIVE. It produces a runbook and harness plan only. A
separate human-approved run is required to execute the harness against live Pi
processes. Do NOT design plans that assume live execution now.

ORIGINAL TASK:
${originalTask}

INSTRUCTIONS:
1. Identify the lifecycle paths where process-creation tracing is needed:
   - Cold start (Pi launched from scratch — Windows Start Menu, terminal, or
     direct executable launch)
   - Open-from-Terminal (parent shell = cmd.exe or powershell.exe launching Pi)
   - Reload (Pi reload triggered via /reload or equivalent)
   - New-session (Pi starts a clean session, e.g. /new or equivalent)
2. Define action markers for each lifecycle path — distinct identifiers that
   will bracket each traced event window so a verifier can correlate harness
   output to specific lifecycle actions:
   - Marker format: timestamped labels (e.g. "COLD_START_BEGIN",
     "COLD_START_END", "RELOAD_BEGIN", etc.)
   - Correlation windows: time-bounded regions around each action marker
     within which process-creation events must be captured
3. Design a non-invasive instrumentation plan the executor should
   materialize:
   - PowerShell or batch diagnostic scripts that use WMI (Win32_ProcessStartTrace)
     or equivalent ETW-based process-creation queries
   - Scripts must capture: parent PID, child PID, command line, executable
     path, shell usage, window/console flags where observable, and timestamps
   - Scripts must use the action-marker scheme for each lifecycle path
   - Scripts must NOT modify Pi source, Pi configuration, Windows registry, or
     system services
   - Scripts must include rollback/cleanup instructions (stop listeners, remove
     temp logs)
4. Define correlation windows explicitly:
   - Cold start: bracket from Pi.exe launch to first render
   - Open-from-Terminal: bracket from terminal spawn command to Pi attach
   - Reload: bracket from /reload trigger to post-reload idle
   - New-session: bracket from /new trigger to new session render
5. Provide a structured checklist the executor must follow exactly.
6. Mark any uncertainties explicitly as HYPOTHESIS.

Return your output as a clear, structured document with sections:
## Lifecycle Paths (numbered, one per path with action markers)
## Action Marker Scheme (format, naming conventions, timestamp requirements)
## Correlation Windows (per-lifecycle-path time brackets)
## Instrumentation Plan (numbered checklist)
## Scoped-out Items
## Rollback/Safety Constraints
## Uncertainty Notes
## Expected Harness Deliverables`;
}

function buildExecutorPrompt(
  originalTask: string,
  plannerRunbook: string,
): string {
  return `You are the EXECUTOR in a win-lifecycle-process-trace orchestration.

Your role: non-invasive-harness-materialization. You MUST work ONLY from the
planner runbook below. You are routed via DeepSeek V4 Pro (deepseek) for
fast harness materialization.

THIS SHAPE IS NON-INVASIVE UNTIL A SEPARATE HUMAN-APPROVED RUN. Do not run
monitors, do not launch Pi processes, do not modify Pi config or Windows
system state. Produce harness artifacts (scripts, configs, instructions) only.

Do NOT fake evidence. Every claim must be traceable to the planner runbook.
Do NOT plan, reinterpret, or override the planner.

ORIGINAL TASK:
${originalTask}

PLANNER RUNBOOK (follow exactly):
${plannerRunbook || "(No planner output received — abort and report.)"}

INSTRUCTIONS:
1. Follow each checklist item from the planner runbook in order.
2. Materialize the non-invasive diagnostic harness:
   a. Create PowerShell diagnostic scripts that query WMI (Win32_ProcessStartTrace
      events) or equivalent ETW process-creation logging, matching the planner's
      action-marker scheme and correlation windows.
   b. For each lifecycle path (cold start, open-from-Terminal, reload,
      new-session), produce a script or script section that brackets the
      action with the planner's markers and captures the correlation window.
   c. Include cleanup/rollback procedures in every script.
3. Produce a verification checklist document that a future manual run can
   follow, including:
   - Step-by-step execution instructions per lifecycle path
   - Expected external process-creation evidence per path
   - Action marker insertion points
   - Correlation window boundaries
   - Acceptance criteria for a passing trace
   - Rollback/safety steps after trace collection
4. Keep all harness artifacts non-invasive:
   - No Pi source code modification
   - No Windows registry changes
   - No system service configuration
   - No persistent hooks or injection
   - No live Pi process interception
   - All scripts terminate cleanly and are removable
5. Label every file as a HARNESS ARTIFACT — non-invasive diagnostic tooling
   for a future human-approved run.
6. Document the EXACT rollback/cleanup steps for every artifact produced.

Return a structured report with:
## Harness Artifacts Produced (file: description)
## Verification Checklist (numbered, per-lifecycle-path)
## Action Markers Implemented (per lifecycle path)
## Correlation Windows (defined time brackets)
## Rollback/Cleanup Procedures (exact steps)
## External Process-Creation Evidence Contract (what a future run MUST capture)
## Open Questions
## Non-Invasiveness Attestation`;
}

function buildVerifierPrompt(
  originalTask: string,
  executorOutput: string,
  executorModelRoute: string,
): string {
  return `You are the VERIFIER in a win-lifecycle-process-trace orchestration.

Your role: trace-evidence-verification. You MUST independently judge using
DIRECT EVIDENCE from BOTH the executor output AND the ORCHESTRATION EVIDENCE
block below. You are routed via GPT-5.5 (openai-codex) for thorough reasoning.

THIS SHAPE IS NON-INVASIVE UNTIL A HUMAN-APPROVED RUN. The harness materials
are preparation only. The verifier judges the HARNESS MATERIALS (not live
trace data).

--- ORCHESTRATION EVIDENCE (verifier brief) ---
This block is the authoritative source for role-integrity and model-route
checks. Cite these fields directly — do NOT infer them from executor output.

| Field | Value |
|-------|-------|
| Requested shape/tool | win-lifecycle-process-trace / orchestrate |
| Current visible role | ORCHESTRATOR |
| Direct orchestrator actions | Coordination only: spawn dispatch, progress emit, report assembly |
| orchestratorExecutedMainTaskWork | false |
| Live monitoring run by orchestrator | false |
| Executor model route | ${executorModelRoute} |
| Subagents spawned | 3 (planner, executor via ${executorModelRoute}, verifier) |
| Phases | trace-runbook-and-harness-plan → non-invasive-harness-materialization → trace-evidence-verification |
--- END ORCHESTRATION EVIDENCE ---

You MUST FAIL (status="fail") if any of these conditions are true:
1. Role integrity: The ORCHESTRATION EVIDENCE block declares
   orchestratorExecutedMainTaskWork=true OR liveMonitoringRunByOrchestrator=true.
   (Judge this against the ORCHESTRATION EVIDENCE block — do NOT infer from
   executor output.)
2. Executor model route: The ORCHESTRATION EVIDENCE block does NOT show
   Executor model route exactly "${executorModelRoute}".
   (Judge this against the ORCHESTRATION EVIDENCE block — do NOT infer from
   executor output.)
3. The evidence delivered is static-only — no external process-creation
   logging artifacts, no WMI/ETW query scripts, no diagnostic harness
   materials that reference external process capture.
   (Judge this against the EXECUTOR OUTPUT.)
4. Action markers are missing or undefined — there must be a concrete
   action-marker scheme (e.g., COLD_START_BEGIN/END, TERMINAL_OPEN_BEGIN/END,
   RELOAD_BEGIN/END, NEW_SESSION_BEGIN/END) that correlates harness output to
   specific lifecycle actions.
   (Judge this against the EXECUTOR OUTPUT.)
5. Correlation windows are missing — time-bounded regions around each action
   marker must be defined so a future manual run knows what window of
   process-creation events to capture.
   (Judge this against the EXECUTOR OUTPUT.)
6. One or more lifecycle paths are omitted without justification:
   - Cold start
   - Open-from-Terminal
   - Reload
   - New-session
   Each must be addressed with action markers, correlation windows, and
   harness instructions.
   (Judge this against the EXECUTOR OUTPUT.)
7. Rollback/safety procedures are missing — harness artifacts must include
   cleanup instructions for every script or configuration produced.
   (Judge this against the EXECUTOR OUTPUT.)
8. The executor output is empty or unparseable — fail closed.
9. The shape claims it ran live tracing or produced evidence from an actual
   Pi process run when this is a non-invasive harness-materialization shape.
   (Judge this against the EXECUTOR OUTPUT.)

ORIGINAL TASK:
${originalTask}

EXECUTOR OUTPUT:
${executorOutput || "(No executor output received.)"}

INSTRUCTIONS:
1. First, verify the ORCHESTRATION EVIDENCE block is present and check
   conditions 1 and 2 against it. Cite the evidence fields explicitly.
2. Then, check FAIL conditions 3-9 against the executor output. Cite specific
   evidence from the executor output (or lack thereof) for each condition.
3. If the executor output is empty or unparseable, FAIL immediately.
4. Synthesize a final verdict with clear reasoning.
5. Return JSON exactly and only in this shape:

{
  "overall": "pass" | "fail",
  "reasons": ["reason 1", "reason 2"],
  "falsificationChecks": [
    {
      "condition": "description of the fail condition",
      "status": "pass" | "fail",
      "evidence": "specific citation or 'not addressed'"
    }
  ],
  "rollbackAssessment": "adequate" | "missing" | "inadequate",
  "actionMarkersPresent": true | false,
  "correlationWindowsDefined": true | false,
  "notes": "additional observations"
}`;
}

// ── Verifier verdict parsing ──────────────────────────────────────────────

interface VerifierVerdict {
  isFail: boolean;
  overall?: string;
  reasons?: string[];
  summary?: string;
}

function parseVerifierVerdict(verifierText: string): VerifierVerdict {
  if (!verifierText || verifierText.trim().length === 0) {
    return { isFail: true, reasons: ["Verifier output is empty"], summary: "Verifier output empty — failing closed" };
  }

  // Primary path: try parsing the full text as JSON directly.
  // The verifier is prompted to return ONLY JSON.
  try {
    const parsed = JSON.parse(verifierText.trim());
    if (parsed && (parsed.overall !== undefined || parsed.status !== undefined)) {
      const overall = parsed.overall ?? parsed.status;
      const normalized = String(overall).toLowerCase();
      const isPassExplicit = normalized === "pass";
      const isFailExplicit = normalized === "fail";
      const isFail = !isPassExplicit; // fail closed for non-pass/fail values
      const lacksVerdictMsg = `Verifier JSON lacks a clear pass/fail verdict: "${String(overall)}"`;
      const summary = (isPassExplicit || isFailExplicit)
        ? (parsed.notes ?? undefined)
        : (parsed.notes ? `${lacksVerdictMsg} — ${parsed.notes}` : lacksVerdictMsg);
      return {
        isFail,
        overall: String(overall),
        reasons: Array.isArray(parsed.reasons) ? parsed.reasons : undefined,
        summary,
      };
    }
  } catch {
    // Full text is not valid JSON. Fall through to regex extraction.
  }

  // Fallback: extract JSON blocks via brace-counting.
  // Embedded JSON blocks can only detect FAIL, never PASS.
  // A non-JSON wrapper with an embedded {"overall":"pass"} block must fail closed.
  const braceBlocks = extractTopLevelJsonBlocks(verifierText);
  for (const block of braceBlocks) {
    try {
      const parsed = JSON.parse(block);
      if (parsed && (parsed.overall !== undefined || parsed.status !== undefined)) {
        const overall = parsed.overall ?? parsed.status;
        const normalized = String(overall).toLowerCase();
        if (normalized === "fail") {
          return {
            isFail: true,
            overall: "fail",
            reasons: Array.isArray(parsed.reasons) ? parsed.reasons : undefined,
            summary: parsed.notes ?? "Embedded JSON block detected failure",
          };
        }
        // Explicit pass or unknown/non-fail in an embedded block: continue searching.
        // Never PASS from embedded JSON — only full-text JSON.parse may pass.
      }
    } catch {
      // Not valid JSON; try next block.
    }
  }

  // Fallback: text-pattern detection for FAIL verdicts (fail-closed only).
  if (/\boverall\s*:\s*fail\b/i.test(verifierText) || /\bstatus\s*:\s*fail\b/i.test(verifierText)) {
    return { isFail: true, overall: "fail", summary: "Detected failure via text pattern (overall/status: fail)" };
  }
  if (/\bverdict\s*:\s*fail\b/i.test(verifierText)) {
    return { isFail: true, overall: "fail", summary: "Detected failure via text pattern (verdict: fail)" };
  }

  // No regex-based PASS: only valid parseable JSON with explicit "pass" may pass.
  // Unparseable text without a detected FAIL pattern fails closed.
  // No clear verdict in non-empty output — fail closed.
  return {
    isFail: true,
    reasons: ["Verifier output is unparseable or lacks a clear verdict"],
    summary: "Verifier output is unparseable or lacks a clear verdict — failing closed",
  };
}

// ── Report / detail builders ──────────────────────────────────────────────

function buildReport(
  status: "pass" | "fail",
  task: string,
  spawnGuard: SpawnGuard,
  phaseOutputs: SubagentResult[],
  executorModelRoute: string,
  verifierVerdict?: VerifierVerdict,
): string {
  const lines: string[] = [
    `# Win-Lifecycle-Process-Trace Orchestration: ${status.toUpperCase()}`,
    "",
    `**Task:** ${truncateWithNotice(task, 2000, "task")}`,
    `**Paradigm:** win-lifecycle-process-trace`,
    `**Subagents spawned:** ${spawnGuard.spawned}/${spawnGuard.cap}`,
    `**Phases:** ${PHASE_NAMES.length} (${PHASE_NAMES.join(" → ")})`,
    `**Executor model route:** ${executorModelRoute}`,
    "",
    "## Orchestrator Role Integrity Ledger",
    "",
    "| Item | Value |",
    "|------|-------|",
    "| Requested shape/tool | `win-lifecycle-process-trace` / `orchestrate` tool |",
    "| Current role | ORCHESTRATOR |",
    "| Subagents spawned + roles | " +
      [
        `planner (${PHASE_NAMES[0]})`,
        `executor (${PHASE_NAMES[1]}) via ${executorModelRoute}`,
        `verifier (${PHASE_NAMES[2]})`,
      ].join(", ") + " |",
    "| Direct orchestrator actions | Coordination only: spawn dispatch, progress emit, report assembly |",
    "| Orchestrator executed main-task work? | **NO** — all harness materialization work routed through subagents |",
    "| Classification | Orchestration support / progress reporting / report assembly |",
    "| Final role-integrity verdict | CLEAN — orchestrator did NOT execute main-task work |",
    "",
    "---",
    "",
    "## Phase Outputs",
  ];

  for (let i = 0; i < PHASE_NAMES.length; i++) {
    const output = phaseOutputs[i];
    lines.push(
      "",
      `### Phase ${i + 1}: ${PHASE_NAMES[i]}`,
      `**Agent:** ${output?.agentName ?? "N/A"}  `,
      `**Exit code:** ${output?.exitCode ?? "N/A"}  `,
      `**Duration:** ${output?.durationMs ?? 0}ms  `,
      `**Events:** ${output?.events ?? 0}`,
      "",
      "**Output:**",
      "",
      truncateWithNotice(output?.text ?? "(no output)", 6000, `phase ${i + 1} output`),
    );
  }

  // Verifier gate section (when verdict is available).
  if (verifierVerdict) {
    lines.push(
      "",
      "---",
      "",
      "## Verifier Gate",
      `**Overall:** ${verifierVerdict.overall ?? "unknown"}  `,
      `**Gate triggered:** ${verifierVerdict.isFail ? "FAIL" : "PASS"}`,
    );
    if (verifierVerdict.reasons && verifierVerdict.reasons.length > 0) {
      lines.push("", "**Reasons:**");
      for (const reason of verifierVerdict.reasons) {
        lines.push(`- ${reason}`);
      }
    }
    if (verifierVerdict.summary) {
      lines.push("", `**Summary:** ${verifierVerdict.summary}`);
    }
  }

  lines.push("", "---", "", `**Final status:** ${status.toUpperCase()}`);

  return truncateWithNotice(lines.join("\n"), MAX_FINAL_CHARS, "final report");
}

function buildDetails(
  status: "pass" | "fail",
  params: { task: string; maxSubagents: number },
  spawnGuard: SpawnGuard,
  phaseOutputs: SubagentResult[],
  plannerOverride: { model?: string; provider?: string },
  executorOverride: { model?: string; provider?: string },
  verifierOverride: { model?: string; provider?: string },
  verifierVerdict?: VerifierVerdict,
): Record<string, unknown> {
  return {
    status,
    paradigm: "win-lifecycle-process-trace",
    spawnedCount: spawnGuard.spawned,
    spawnedCap: spawnGuard.cap,
    phases: PHASE_NAMES.length,
    modelRouting: {
      planner: formatRoutedModel(plannerOverride.provider, plannerOverride.model),
      executor: formatRoutedModel(executorOverride.provider, executorOverride.model),
      verifier: formatRoutedModel(verifierOverride.provider, verifierOverride.model),
    },
    phaseOutputs: phaseOutputs.map((output, index) => ({
      phaseIndex: index + 1,
      phaseName: PHASE_NAMES[index] ?? "unknown",
      agentName: output?.agentName ?? "N/A",
      exitCode: output?.exitCode ?? null,
      durationMs: output?.durationMs ?? 0,
      events: output?.events ?? 0,
      text: truncateWithNotice(output?.text ?? "", MAX_DETAIL_CHARS, `phase ${index + 1} output`),
    })),
    terminationCondition: "After all 3 phases complete (no retry loop in this shape).",
    evidenceModel:
      "Planner produces lifecycle boundaries, action markers, correlation windows, " +
      "and instrumentation plan (no edits, no process launch). " +
      "Executor materializes non-invasive diagnostic harness scripts, configs, and " +
      "verification checklist with rollback/safety procedures. " +
      "Verifier judges harness materials against falsifiable contract: must have " +
      "external process-creation references, action markers, correlation windows, " +
      "all lifecycle paths, and rollback/safety.",
    failureBehavior:
      "Verifier fails if orchestrator did main-task work, executor route is wrong, " +
      "evidence is static-only (no external process-creation logging artifacts), " +
      "action markers missing, correlation windows missing, lifecycle paths " +
      "omitted (cold/reload/new-session), rollback/safety absent, output empty, " +
      "or shape faked live evidence when non-invasive.",
    nonInvasiveAttestation:
      "This shape is non-invasive until a separate human-approved run. " +
      "Harness artifacts are diagnostic tooling only — scripts, configs, " +
      "and verification checklists. No live Pi interception, no config " +
      "mutation, no Windows registry changes, no system service modifications.",
    orchestratorRoleIntegrity: {
      requestedShape: "win-lifecycle-process-trace",
      currentRole: "ORCHESTRATOR",
      subagentsSpawned: spawnGuard.spawned,
      subagentRoles: PHASE_NAMES.map((name, i) => ({
        phase: name,
        role: i === 0 ? "planner" : i === 1 ? "executor" : "verifier",
        modelRoute: i === 0
          ? formatRoutedModel(plannerOverride.provider, plannerOverride.model)
          : i === 1
            ? formatRoutedModel(executorOverride.provider, executorOverride.model)
            : formatRoutedModel(verifierOverride.provider, verifierOverride.model),
      })),
      orchestratorExecutedMainTaskWork: false,
    },
    verifierVerdict: verifierVerdict
      ? {
          isFail: verifierVerdict.isFail,
          overall: verifierVerdict.overall ?? null,
          reasons: verifierVerdict.reasons ?? null,
          summary: verifierVerdict.summary ?? null,
        }
      : null,
  };
}

/**
 * Extract top-level JSON blocks from text using brace counting.
 * Handles nested objects/arrays that regex lazy matching cannot.
 */
function extractTopLevelJsonBlocks(text: string): string[] {
  const blocks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const openIdx = text.indexOf("{", i);
    if (openIdx < 0) break;

    let depth = 0;
    let inString = false;
    let escape = false;
    let endIdx = -1;
    for (let j = openIdx; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
      } else {
        if (ch === '"') {
          inString = true;
        } else if (ch === "{") {
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0) {
            endIdx = j;
            break;
          }
        }
      }
    }

    if (endIdx >= 0) {
      const block = text.slice(openIdx, endIdx + 1);
      blocks.push(block);
      i = endIdx + 1;
    } else {
      i = openIdx + 1;
    }
  }
  return blocks;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function resolveModelOverride(
  explicitModel: string | undefined,
  explicitProvider: string | undefined,
  defaultModel: string,
  defaultProvider: string,
): { model?: string; provider?: string } {
  return {
    model: explicitModel || defaultModel,
    provider: explicitProvider || defaultProvider,
  };
}
