/**
 * contract-types.ts — Executor Recovery Contract Types & Continuation Helpers
 * ==========================================================================
 *
 * Layer: src/executor-recovery/ (shape-adjacent, not substrate)
 *
 * Defines the structured handoff contracts that enable recovery when an
 * executor agent exhausts its context window. Two contract flavors exist:
 *
 *   1. ExecutorContinuationContract — proactive, written by the executor itself
 *      before total failure. Contains completed work, remaining work, files
 *      touched, decisions made, notes.
 *
 *   2. RecoveryMetadata — reactive, derived by the orchestrator from partial
 *      output when the executor is too far gone to write its own contract.
 *
 * RecoveryEntry tracks every recovery attempt so the orchestrator can enforce
 * depth limits and prevent infinite recovery loops.
 *
 * Dependencies: none. This module is pure type definitions and string/builder
 * functions. It does not import from substrate, shape, or any other module.
 */

// ── Core contract types ────────────────────────────────────────────────────

/**
 * Structured handoff contract an executor agent writes proactively before
 * context exhaustion. Written to a temp file by the executor via the
 * continuation guardrail injected into its system prompt.
 *
 * The receiving (continuation) executor validates claimed files against
 * disk state before proceeding. Any file not found on disk is reported as
 * a discrepancy and the continuation executor may redo that work.
 */
export interface ExecutorContinuationContract {
  /** Always "EXECUTOR_CONTINUATION_CONTRACT". */
  artifactType: "EXECUTOR_CONTINUATION_CONTRACT";
  /** The task ID from the plan this contract covers. */
  taskId: string;
  /** ISO-8601 timestamp when this contract was written. */
  timestamp: string;
  /** Estimated context saturation percent at time of writing (0-100). */
  contextSaturation: number;

  /** Objectives the executor believes are fully completed. */
  completed: string[];
  /** Objectives that remain to be done. */
  remaining: string[];
  /** File paths the executor has created or modified. */
  filesTouched: string[];
  /** Key decisions made and their rationale. */
  decisions: Array<{
    decision: string;
    rationale: string;
    alternativesConsidered?: string[];
  }>;
  /** Free-form notes for the continuation executor. */
  notes: string;

  /** File-level detail for validation against disk state. */
  fileDetails?: Array<{
    path: string;
    action: "created" | "modified" | "deleted";
    lineRange?: string;
    summary: string;
  }>;
}

/**
 * Recovery metadata derived by the orchestrator when the executor could
 * not write its own continuation contract. Produced by scanning partial
 * output text with regex heuristics.
 */
export interface RecoveryMetadata {
  /** The task ID this recovery metadata covers. */
  taskId: string;
  /** Original task description from the plan. */
  taskDescription: string;
  /** Any partial output the failing executor produced. */
  partialOutput: string;
  /** File paths mentioned in the partial output (regex-extracted, best-effort). */
  filesMentioned: string[];
  /** How this metadata was produced. */
  derivationMethod: "executor_contract" | "regex_scan" | "fallback_empty";
  /** Best-effort list of sub-objectives that may have been completed. */
  completedObjectives: string[];
  /** Best-effort list of sub-objectives that likely remain. */
  remainingObjectives: string[];
  /** The tier at which this recovery metadata was produced. */
  recoveryTier: RecoveryTier;
  /** Depth of the recovery chain for this task. */
  recoveryDepth: number;
}

/** Types of recovery action attempted by the tiered escalation system. */
export type RecoveryTier =
  | "CONTINUE"       // Handoff continuation (Approach A)
  | "SPLIT"          // Split-and-respawn (Approach B)
  | "REPLAN"         // Replan-with-learning (Approach C)
  | "SCOPE_REDUCE";  // Progressive scope reduction (Approach D)

/**
 * A single recovery attempt entry, recorded in OrchestrationState.recoveryLog.
 * Enables depth enforcement and aggregate pattern reporting.
 */
export interface RecoveryEntry {
  /** Unique identifier for this recovery entry. */
  id: string;
  /** The task ID being recovered. */
  taskId: string;
  /** Orchestration attempt number when this recovery was triggered. */
  attempt: number;
  /** Recovery tier attempted. */
  tier: RecoveryTier;
  /** Agent name spawned for the recovery attempt. */
  agentName: string;
  /** Whether this recovery attempt succeeded. */
  success: boolean;
  /** Number of subagent spawns consumed by this recovery. */
  spawnCount: number;
  /** Duration of the recovery attempt in ms. */
  durationMs: number;
  /** Human-readable summary of what happened. */
  summary: string;
  /** The recovery metadata used (if any). */
  metadata?: RecoveryMetadata;
}

// ── Drive minimal contract from partial output ─────────────────────────────

/**
 * Derive a minimal continuation contract from a failed executor's partial
 * output and the original task description. Used when the agent was too
 * far gone to write its own contract.
 *
 * Produces RecoveryMetadata with derivationMethod "regex_scan" (when file
 * mentions are extractable) or "fallback_empty" (when nothing useful remains).
 */
export function deriveMinimalContract(
  taskId: string,
  taskDescription: string,
  partialOutput: string,
): RecoveryMetadata {
  const filesMentioned = extractFilesMentioned(partialOutput);
  const completedObjectives = extractCompletedObjectives(partialOutput, taskDescription);
  const remainingObjectives = computeRemainingObjectives(
    taskDescription,
    completedObjectives,
  );
  const derivationMethod =
    filesMentioned.length > 0
      ? "regex_scan"
      : "fallback_empty";

  return {
    taskId,
    taskDescription,
    partialOutput,
    filesMentioned,
    derivationMethod,
    completedObjectives,
    remainingObjectives,
    recoveryTier: "CONTINUE",
    recoveryDepth: 0,
  };
}

/**
 * Convert an ExecutorContinuationContract (written proactively by executor)
 * into RecoveryMetadata for uniform handling in the recovery pipeline.
 */
export function contractToRecoveryMetadata(
  contract: ExecutorContinuationContract,
  taskDescription: string,
  depth: number,
): RecoveryMetadata {
  return {
    taskId: contract.taskId,
    taskDescription,
    partialOutput: "",
    filesMentioned: contract.filesTouched.map((p) => normalizeFilePath(p)),
    derivationMethod: "executor_contract",
    completedObjectives: contract.completed,
    remainingObjectives: contract.remaining,
    recoveryTier: "CONTINUE",
    recoveryDepth: depth,
  };
}

// ── Regex helpers for partial output scanning ──────────────────────────────

/**
 * Extract file paths mentioned in the executor's output text using patterns
 * that match common code-file references.
 */
function extractFilesMentioned(text: string): string[] {
  if (!text) return [];
  const patterns: RegExp[] = [
    // Typical code file references: src/foo.ts, lib/bar.js, etc.
    /\b(?:[\w./-]+\.(?:ts|js|json|md|py|go|rs|java|cpp|c|h|css|html|yaml|yml|toml|cjs|mjs))\b/gi,
    // Absolute paths on Windows/Unix
    /\b(?:[A-Za-z]:[\\/][\w./\\-]+\.\w+)\b/g,
    /\b(?:\/[\w./-]+\.\w+)\b/g,
  ];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const filePath = normalizeFilePath(match[0]);
      if (filePath && !isLikelyNonFile(filePath)) seen.add(filePath);
    }
  }
  return [...seen].slice(0, 50); // cap at 50 to prevent runaway
}

/** Normalize a file path — strip surrounding quotes, backslashes to forward. */
function normalizeFilePath(raw: string): string {
  return raw
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\\/g, "/")
    .trim();
}

/** Heuristic: filter out likely non-file references (URLs, package names). */
function isLikelyNonFile(candidate: string): boolean {
  // Exclude HTTP URLs and npm-like package references
  if (/^https?:\/\//i.test(candidate)) return true;
  if (/^@[\w-]+\/[\w-]+$/i.test(candidate)) return true;
  // Exclude single-segment "names" that look like identifiers not paths
  if (!candidate.includes("/") && !candidate.includes("\\")) {
    return candidate.length < 4 || /^[a-z]+$/i.test(candidate);
  }
  return false;
}

/**
 * Extract sub-objectives that appear to have been completed from partial
 * output text. Uses task description as a reference to understand what
 * sub-objectives exist.
 */
function extractCompletedObjectives(
  partialOutput: string,
  _taskDescription: string,
): string[] {
  if (!partialOutput) return [];
  const completed: string[] = [];

  // Patterns for "completed" signals in executor output
  const completedPatterns: RegExp[] = [
    // Explicit completion markers
    /\b(?:created|implemented|added|built|wrote|finished|completed)\s+([\w./-]+(?:\.\w+)?)\b/gi,
    // Task-specific completion: "Task X: done/completed/implemented"
    /\b(?:task\s+\S+\s*(?::|is|was)\s*(?:done|complete|implemented|finished))\b/gi,
    // File change markers
    /\b(?:modified|edited|updated|changed)\s+([\w./-]+(?:\.\w+)?)\b/gi,
    // Test passing
    /\b(?:tests?\s+(?:pass|succeed)|all\s+tests?\s+(?:pass|green))\b/gi,
  ];

  for (const pattern of completedPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(partialOutput)) !== null) {
      const text = match[0].trim();
      if (text && !completed.includes(text)) {
        completed.push(text);
      }
    }
  }

  return [...new Set(completed)].slice(0, 30);
}

/**
 * Compute remaining objectives as the complement of completed objectives
 * against the task description. When extraction yields nothing, returns
 * the full task description as the only remaining objective.
 */
function computeRemainingObjectives(
  taskDescription: string,
  completed: string[],
): string[] {
  if (completed.length === 0) return [taskDescription];
  // Simple heuristic: if we found completion signals, remaining is task minus
  // those. In practice the planner re-derives this; here we provide a hint.
  return [`(remaining from: ${truncate(taskDescription, 120)})`];
}

// ── Continuation guardrail ─────────────────────────────────────────────────

/**
 * Returns the guardrail text to inject into an executor's system prompt.
 * This instructs the executor to proactively write a continuation contract
 * to a temp file when it detects context pressure, increasing the chance
 * a recoverable snapshot exists before total exhaustion.
 *
 * This should be injected BEFORE the output format rules in the executor
 * prompt so it takes precedence as a background instruction.
 */
export function injectContinuationGuardrail(
  taskId: string,
  tempDir?: string,
): string {
  const contractPath = tempDir
    ? `${tempDir}/continuation-${taskId}.md`
    : `continuation-${taskId}.md`;
  return [
    "",
    "── CONTINUATION GUARDRAIL ──",
    "",
    "If you detect you are running low on context (you cannot hold the full task",
    "in mind, you are repeating yourself, or your output is being truncated),",
    "you MUST write a continuation contract BEFORE proceeding further.",
    "",
    `Write it to: \`${contractPath}\``,
    "",
    "Use this exact JSON format:",
    "```json",
    "{",
    '  "artifactType": "EXECUTOR_CONTINUATION_CONTRACT",',
    `  "taskId": "${taskId}",`,
    '  "timestamp": "<ISO-8601 now>",',
    '  "contextSaturation": <0-100>,',
    '  "completed": ["<list of completed sub-objectives>"],',
    '  "remaining": ["<list of remaining sub-objectives>"],',
    '  "filesTouched": ["<list of file paths created or modified>"],',
    '  "decisions": [',
    '    { "decision": "<what>", "rationale": "<why>" }',
    "  ],",
    '  "notes": "<free-form critical context for continuation>"',
    "}",
    "```",
    "",
    "Do NOT include this contract in your final text output.",
    "Write it ONLY to the specified file path.",
    "After writing the contract, proceed with your remaining work if possible.",
    "If you are fully exhausted, signal with a brief final message and stop.",
    "── END GUARDRAIL ──",
    "",
  ].join("\n");
}

/**
 * Returns the system-prompt-level guardrail variant. This is a shorter,
 * always-on instruction that can be appended to the agent's system prompt
 * (not just the task prompt) for agents configured with systemPrompt.
 */
export function injectContinuationGuardrailSystemPrompt(
  taskId: string,
): string {
  return [
    "CONTEXT EXHAUSTION SAFETY: If you detect context pressure (repetition,",
    "output truncation, inability to hold the full task in mind), write a",
    "continuation contract to `continuation-{taskId}.md` in JSON format with",
    'fields: artifactType:"EXECUTOR_CONTINUATION_CONTRACT", taskId, timestamp,',
    "contextSaturation, completed[], remaining[], filesTouched[], decisions[],",
    "notes. Write to file only, not your output. Then try to finish or stop.",
  ].join(" ");
}

// ── Continuation prompt builder ────────────────────────────────────────────

/**
 * Build the prompt for a continuation executor that resumes work from a
 * prior (failed) executor. The continuation executor receives:
 *
 * 1. A preamble explaining this is a continuation, not a fresh start
 * 2. The original task to provide full context
 * 3. The continuation contract/derived metadata
 * 4. Validation instructions against disk state
 * 5. Rules to not redo completed work
 */
export function buildExecutorContinuationPrompt(params: {
  taskId: string;
  taskDescription: string;
  contract?: ExecutorContinuationContract;
  metadata?: RecoveryMetadata;
  priorOutput?: string;
}): string {
  const { taskId, taskDescription, contract, metadata, priorOutput } = params;
  const lines: string[] = [];

  // ── Preamble ──
  lines.push(
    "## EXECUTOR CONTINUATION TASK",
    "",
    `You are a CONTINUATION executor for task "${taskId}". The previous executor`,
    "exhausted its context window before completing this task. Your job is to",
    "pick up where the prior executor left off and finish ONLY the remaining work.",
    "",
  );

  // ── Original task ──
  lines.push(
    "## ORIGINAL TASK",
    "",
    taskDescription,
    "",
  );

  // ── Contract or derived metadata ──
  if (contract) {
    lines.push(
      "## CONTINUATION CONTRACT (written by prior executor)",
      "",
      "The prior executor wrote this handoff contract. It represents their best",
      "understanding of what was completed and what remains. HOWEVER, the prior",
      "executor may have hallucinated — you MUST validate against disk state.",
      "",
      "```json",
      JSON.stringify(
        {
          taskId: contract.taskId,
          completed: contract.completed,
          remaining: contract.remaining,
          filesTouched: contract.filesTouched,
          decisions: contract.decisions,
          notes: contract.notes,
          fileDetails: contract.fileDetails,
        },
        null,
        2,
      ),
      "```",
      "",
    );
  } else if (metadata) {
    lines.push(
      "## RECOVERY METADATA (derived by orchestrator from partial output)",
      "",
      "The prior executor did NOT write a continuation contract. The following",
      "metadata was derived by scanning the partial output. It may be inaccurate.",
      "You MUST validate against disk state.",
      "",
      "```json",
      JSON.stringify(
        {
          taskId: metadata.taskId,
          completedObjectives: metadata.completedObjectives,
          remainingObjectives: metadata.remainingObjectives,
          filesMentioned: metadata.filesMentioned,
          derivationMethod: metadata.derivationMethod,
        },
        null,
        2,
      ),
      "```",
      "",
    );
  }

  // ── Prior partial output (for context) ──
  if (priorOutput) {
    const capped = priorOutput.length > 4000
      ? priorOutput.slice(0, 4000) + "\n\n_(prior output truncated — see full task above)_"
      : priorOutput;
    lines.push(
      "## PRIOR EXECUTOR PARTIAL OUTPUT (for context only)",
      "",
      capped,
      "",
    );
  }

  // ── Validation instructions ──
  lines.push(
    "## CONTINUATION RULES",
    "",
    "1. FIRST — read the continuation contract/metadata above carefully.",
    "2. VALIDATE every file claim against actual disk state before trusting it.",
    "   - If a file claimed as 'touched' does NOT exist on disk, note the discrepancy.",
    "   - Use `bash` to run `ls` or `git status --short` to check what really exists.",
    "3. Do NOT redo work that is genuinely completed. If a file exists with the",
    "   expected contents, move on.",
    "4. Complete ONLY the `remaining` objectives (or `remainingObjectives`).",
    "5. If the contract/metadata is wrong about what's completed, redo that work.",
    "6. Produce a normal executor output reporting:",
    "   - What was validated from the prior work",
    "   - What new work you completed",
    "   - Files you touched",
    "   - Any discrepancies found in the handoff contract",
    "7. If you MUST use write/edit/bash tools for implementation work, do so —",
    "   a text-only report is insufficient for CREATE/IMPLEMENT/MODIFY tasks.",
    "",
  );

  // ── Output rule (preserved from standard executor prompt) ──
  lines.push(
    "Return a concise report with: changes made, files touched, validation",
    "discrepancies found, commands/tests run, and remaining issues.",
  );

  return lines.join("\n");
}

// ── Utility helpers ────────────────────────────────────────────────────────

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen - 3) + "...";
}
