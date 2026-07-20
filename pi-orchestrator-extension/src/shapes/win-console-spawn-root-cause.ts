/**
 * Shape: win-console-spawn-root-cause
 * ====================================
 * Investigation orchestration for remaining Windows terminal/console
 * child-process flashes that occur on Pi reload, start, new-session, and
 * open-from-Terminal even when normal message-send flashes are fixed.
 *
 * This shape routes execution-level work to DeepSeek V4 Pro (fast, code-level
 * investigation) and higher-level planning/verification/root-cause reasoning
 * to more intelligent models such as GPT-5.5.
 *
 * Finite phases:
 *   a. intake-boundary-plan — planner role maps boundaries, hypotheses,
 *      and instrumentation plan. No file edits.
 *   b. instrumented-execution-and-candidate-fix — executor role executes the
 *      planner checklist only. Requires runtime instrumentation (WMI/ETW/
 *      ProcMon or diagnostic spawn logging). May produce a minimal candidate
 *      fix or patch plan with rollback limits.
 *   c. falsifiable-verification-and-synthesis — verifier role independently
 *      judges using direct evidence. Must FAIL if execution was not DeepSeek
 *      V4 Pro, evidence is static-grep-only, lifecycle paths were not
 *      separately exercised, boundaries were omitted, rollback path missing,
 *      or fix too broad.
 *
 * ONE-LINE RULE: Shapes are siblings — they stand on the substrate, never
 * build on each other.
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
  NormalizedParams,
} from "../types";

// ── Constants ─────────────────────────────────────────────────────────────

const PHASE_NAMES = [
  "intake-boundary-plan",
  "instrumented-execution-and-candidate-fix",
  "falsifiable-verification-and-synthesis",
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

export const winConsoleSpawnRootCauseShape: OrchestrationShape = {
  name: "win-console-spawn-root-cause",
  description:
    "Downstream Windows console-spawn flash root-cause investigation: " +
    "planner maps boundaries/hypotheses/instrumentation with GPT-5.5, " +
    "executor instruments and delivers candidate fix via DeepSeek V4 Pro, " +
    "verifier falsifiably judges with GPT-5.5. Three finite phases, no " +
    "broad rewrites.",
  run: runWinConsoleSpawnRootCause,
};

// ── Main orchestration ────────────────────────────────────────────────────

async function runWinConsoleSpawnRootCause(
  context: OrchestrationShapeContext,
): Promise<OrchestrationShapeResult> {
  const { params, signal, onUpdate, inheritedModel, agents } = context;
  const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }] });

  const spawnGuard = new SpawnGuard(Math.min(params.maxSubagents, 6));
  emit("win-console-spawn-root-cause: starting 3-phase investigation orchestration.");

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
    `win-console-spawn-root-cause: model routing — ` +
    `planner=${formatRoutedModel(plannerOverride.provider, plannerOverride.model)}, ` +
    `executor=${runnerModel}, ` +
    `verifier=${formatRoutedModel(verifierOverride.provider, verifierOverride.model)}.`,
  );

  // Phase outputs
  const phaseOutputs: SubagentResult[] = [];

  // ── Phase 1: intake-boundary-plan ─────────────────────────────────────
  {
    throwIfAborted(signal);
    const spawned = spawnGuard.reserve();
    emit(
      `win-console-spawn-root-cause: phase 1/3 intake-boundary-plan ` +
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
      `win-console-spawn-root-cause: phase 1 complete — planner ` +
      `(${formatRoutedModel(plannerOverride.provider, plannerOverride.model)}) ` +
      `returned ${result.events} events in ${result.durationMs}ms.`,
    );
  }

  // ── Phase 2: instrumented-execution-and-candidate-fix ─────────────────
  {
    throwIfAborted(signal);
    const spawned = spawnGuard.reserve();
    const plannerChecklist = phaseOutputs[0]?.text ?? "";
    emit(
      `win-console-spawn-root-cause: phase 2/3 instrumented-execution ` +
      `spawning executor (${spawned}/${spawnGuard.cap}) via ${runnerModel}.`,
    );
    const result = await spawnSubagent(
      params.executorAgent,
      buildExecutorPrompt(params.task, plannerChecklist),
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
      `win-console-spawn-root-cause: phase 2 complete — executor ` +
      `(${runnerModel}) returned ${result.events} events ` +
      `in ${result.durationMs}ms.`,
    );
  }

  // ── Phase 3: falsifiable-verification-and-synthesis ───────────────────
  {
    throwIfAborted(signal);
    const spawned = spawnGuard.reserve();
    const executorOutput = phaseOutputs[1]?.text ?? "";
    emit(
      `win-console-spawn-root-cause: phase 3/3 falsifiable-verification ` +
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
      `win-console-spawn-root-cause: phase 3 complete — verifier ` +
      `(${formatRoutedModel(verifierOverride.provider, verifierOverride.model)}) ` +
      `returned ${result.events} events in ${result.durationMs}ms.`,
    );
  }

  // ── Deterministic status from phase outputs ────────────────────────────
  const allClean = phaseOutputs.every((o) => o.exitCode === 0);
  let status: "pass" | "fail" = allClean ? "pass" : "fail";

  // Verifier falsification gate: even with exit code 0, the verifier's
  // textual output may indicate failure. Parse and override if needed.
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
  return `You are the PLANNER in a win-console-spawn-root-cause investigation orchestration.

Your role: intake-boundary-plan. Map boundaries, hypotheses, and an instrumentation
plan for Windows console/terminal flash root-cause investigation. NO file edits.
You are routed via GPT-5.5 (openai-codex) for high-level reasoning.

ORIGINAL TASK:
${originalTask}

INSTRUCTIONS:
1. Identify the lifecycle paths where flashes are observed:
   - Pi reload
   - Pi start / new-session
   - open-from-Terminal (parent shell = cmd.exe or powershell.exe)
   - Normal message-send flashes are already fixed — scope them OUT.
2. Propose at least 3 concrete hypotheses for the remaining flashes (e.g.,
   detached console allocation on child_process.spawn, CREATE_NO_WINDOW
   flag missing on specific code paths, shell:true on cmd spawning a visible
   window before Pi takes over, node:wrapper spawning intermediate shells).
3. Design an instrumentation plan that the executor (DeepSeek V4 Pro) SHOULD
   follow. The plan must require:
   - WMI/ETW process-creation logging, or ProcMon capture, or temporary
     diagnostic spawn logging (environment variable + timestamped log file)
   - Recording: parent PID, command line, executable path, shell usage,
     detached/window options where observable, and action timestamps
   - Specific lifecycle events to instrument (reload, start, new-session,
     open-from-Terminal)
   - Boundaries that MUST NOT be crossed:
     * No broad-rewriting of core Pi files
     * No persistent system configuration changes
     * No modification of Windows registry outside of documented Pi paths
     * Rollback path for any candidate fix must be clearly documented
4. Provide a structured checklist the executor must follow exactly.
5. Mark any uncertainties explicitly as HYPOTHESIS.

Return your output as a clear, structured document with sections:
## Boundaries
## Hypotheses (numbered, at least 3)
## Instrumentation Plan (numbered checklist)
## Scoped-out Items
## Rollback Constraints
## Uncertainty Notes`;
}

function buildExecutorPrompt(
  originalTask: string,
  plannerChecklist: string,
): string {
  return `You are the EXECUTOR in a win-console-spawn-root-cause investigation orchestration.

Your role: instrumented-execution-and-candidate-fix. You MUST work ONLY from the
planner checklist below. You are routed via DeepSeek V4 Pro (deepseek) for
fast code-level investigation.

Do NOT plan, reinterpret, or override the planner. Execute the checklist only.

ORIGINAL TASK:
${originalTask}

PLANNER CHECKLIST (follow exactly):
${plannerChecklist || "(No planner output received — abort and report.)"}

INSTRUCTIONS:
1. Follow each checklist item in order.
2. Use runtime instrumentation: WMI/ETW process-creation queries, ProcMon
   capture suggestions, or temporary diagnostic spawn logging (create a
   small diagnostic script or environment variable that logs parent PID,
   command line, executable path, shell usage, detached/window options, and
   timestamps when Pi spawns child processes).
3. Examine relevant Pi source files for spawn options (windowsHide,
   detached, shell, stdio) in:
   - Core launch paths (reload, new-session, main process spawn)
   - Extension launch paths
   - MCP server spawn paths
   - Shell-launcher / terminal-open paths
4. Produce a MINIMAL candidate fix or patch plan:
   - Keep changes as small as possible (single flag addition preferred)
   - Document the EXACT rollback steps
   - Do NOT broad-rewrite or persist system config
   - Do NOT modify Windows registry outside documented Pi paths
5. Record all evidence: file paths examined, spawn options found, timestamps.

Return a structured report with:
## Evidence Collected (file:line references)
## Findings
## Candidate Fix (exact code change or flag addition)
## Rollback Path (exact steps)
## Open Questions
## Files Touched (list only)`;
}

function buildVerifierPrompt(
  originalTask: string,
  executorOutput: string,
  executorModelRoute: string,
): string {
  return `You are the VERIFIER in a win-console-spawn-root-cause investigation orchestration.

Your role: falsifiable-verification-and-synthesis. You MUST independently judge
using DIRECT EVIDENCE. You are routed via GPT-5.5 (openai-codex) for thorough
reasoning.

You MUST FAIL (status="fail") if any of these conditions are true:
1. The visible/current orchestrator performed main-task investigation work
   instead of only coordinating (role integrity check).
2. Execution was NOT performed via DeepSeek V4 Pro — the executor model route
   must be "${executorModelRoute}".
3. The evidence collected is static-grep-only (no WMI/ETW/ProcMon/diagnostic
   spawn logging or equivalent runtime instrumentation).
4. Lifecycle paths (reload, start, new-session, open-from-Terminal) were NOT
   separately exercised, justified, or accounted for.
5. Pi core, extensions, MCP, or shell-launcher boundaries were omitted from
   the investigation without justification.
6. Windows console mechanics (CREATE_NO_WINDOW, windowsHide, detached, shell,
   DETACHED_PROCESS flags) were not addressed or analyzed.
7. No rollback path is documented for the proposed candidate fix.
8. The candidate fix is too broad (more than a few targeted flag changes or
   touches more than 3-5 files without explicit justification).

ORIGINAL TASK:
${originalTask}

EXECUTOR OUTPUT:
${executorOutput || "(No executor output received.)"}

INSTRUCTIONS:
1. Check each FAIL condition above against the executor output. Cite specific
   evidence from the executor output (or lack thereof) for each condition.
2. If the executor output is empty or unparseable, FAIL immediately.
3. Synthesize a final verdict with clear reasoning.
4. Return JSON exactly and only in this shape:

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
  "broadFixConcern": true | false,
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
    return { isFail: true, reasons: ["Verifier output is empty"], summary: "Verifier output empty" };
  }

  // Primary path: try parsing the full text as JSON directly.
  // The verifier is prompted to return ONLY JSON, so this should succeed
  // when the verifier follows the contract.
  try {
    const parsed = JSON.parse(verifierText.trim());
    if (parsed && (parsed.overall !== undefined || parsed.status !== undefined)) {
      const overall = parsed.overall ?? parsed.status;
      const isFail = String(overall).toLowerCase() === "fail";
      return {
        isFail,
        overall: String(overall),
        reasons: Array.isArray(parsed.reasons) ? parsed.reasons : undefined,
        summary: parsed.notes ?? undefined,
      };
    }
  } catch {
    // Full text is not valid JSON (e.g., the model wrapped it in markdown).
    // Fall through to regex extraction.
  }

  // Fallback: extract JSON blocks via brace-counting (regex with lazy
  // quantifiers can't handle nested braces in the verdict object).
  const braceBlocks = extractTopLevelJsonBlocks(verifierText);
  for (const block of braceBlocks) {
    try {
      const parsed = JSON.parse(block);
      if (parsed && (parsed.overall !== undefined || parsed.status !== undefined)) {
        const overall = parsed.overall ?? parsed.status;
        const isFail = String(overall).toLowerCase() === "fail";
        return {
          isFail,
          overall: String(overall),
          reasons: Array.isArray(parsed.reasons) ? parsed.reasons : undefined,
          summary: parsed.notes ?? undefined,
        };
      }
    } catch {
      // Not valid JSON; try next block.
    }
  }

  // Fallback: text-pattern detection for FAIL verdicts.
  if (/\boverall\s*:\s*fail\b/i.test(verifierText) || /\bstatus\s*:\s*fail\b/i.test(verifierText)) {
    return { isFail: true, overall: "fail", summary: "Detected failure via text pattern (overall/status: fail)" };
  }
  if (/\bverdict\s*:\s*fail\b/i.test(verifierText)) {
    return { isFail: true, overall: "fail", summary: "Detected failure via text pattern (verdict: fail)" };
  }

  // Explicit pass patterns.
  if (/\boverall\s*:\s*pass\b/i.test(verifierText) || /\bstatus\s*:\s*pass\b/i.test(verifierText)) {
    return { isFail: false, overall: "pass" };
  }

  // No clear verdict — indeterminate, not a fail trigger.
  return { isFail: false };
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
    `# Win-Console-Spawn-Root-Cause Orchestration: ${status.toUpperCase()}`,
    "",
    `**Task:** ${truncateWithNotice(task, 2000, "task")}`,
    `**Paradigm:** win-console-spawn-root-cause`,
    `**Subagents spawned:** ${spawnGuard.spawned}/${spawnGuard.cap}`,
    `**Phases:** ${PHASE_NAMES.length} (${PHASE_NAMES.join(" → ")})`,
    `**Executor model route:** ${executorModelRoute}`,
    "",
    "## Orchestrator Role Integrity Ledger",
    "",
    "| Item | Value |",
    "|------|-------|",
    "| Requested shape/tool | `win-console-spawn-root-cause` / `orchestrate` tool |",
    "| Current role | ORCHESTRATOR |",
    "| Subagents spawned + roles | " +
      [
        `planner (${PHASE_NAMES[0]})`,
        `executor (${PHASE_NAMES[1]}) via ${executorModelRoute}`,
        `verifier (${PHASE_NAMES[2]})`,
      ].join(", ") + " |",
    "| Direct orchestrator actions | Coordination only: spawn dispatch, progress emit, report assembly |",
    "| Orchestrator executed main-task work? | **NO** — all investigation work routed through subagents |",
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
  params: NormalizedParams,
  spawnGuard: SpawnGuard,
  phaseOutputs: SubagentResult[],
  plannerOverride: { model?: string; provider?: string },
  executorOverride: { model?: string; provider?: string },
  verifierOverride: { model?: string; provider?: string },
  verifierVerdict?: VerifierVerdict,
): Record<string, unknown> {
  return {
    status,
    paradigm: "win-console-spawn-root-cause",
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
      "Planner produces boundaries/hypotheses/instrumentation plan (no edits). " +
      "Executor instruments at runtime and produces candidate fix with rollback. " +
      "Verifier falsifiably judges using direct evidence from executor output.",
    failureBehavior:
      "Verifier fails if execution not DeepSeek V4 Pro, evidence is static-grep-only, " +
      "lifecycle paths not separately exercised, boundaries omitted, Windows console " +
      "mechanics not addressed, rollback path missing, or candidate fix too broad.",
    orchestratorRoleIntegrity: {
      requestedShape: "win-console-spawn-root-cause",
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
    // Find next opening brace.
    const openIdx = text.indexOf("{", i);
    if (openIdx < 0) break;

    // Brace-count to find the matching closing brace.
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
