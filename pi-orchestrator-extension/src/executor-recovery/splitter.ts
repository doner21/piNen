/**
 * splitter.ts — Task Splitting for Context-Exhaustion Recovery
 * =============================================================
 *
 * Layer: src/executor-recovery/ (shape-adjacent, not substrate)
 *
 * When an executor exhausts its context window, the tiered recovery system
 * escalates: handoff continuation → split-and-respawn → replan-with-learning.
 * This module implements the SPLIT tier: breaking a failed task into chained
 * ≤150-word subtasks that a fresh executor can complete incrementally.
 *
 * Key guarantees:
 *   - Subtask descriptions are ≤150 words (configurable).
 *   - Subtasks are chained sequentially (part-N depends on part-(N-1)).
 *   - Recursive split depth is capped (default 3) to prevent infinite
 *     fragmentation.
 *   - Prior partial output is preserved as bounded context (≤4000 chars)
 *     to inform the continuation executor without re-exhausting its window.
 *   - Recovery metadata is produced for recovery-aware replanning when
 *     splitting at this level also fails.
 *
 * Dependencies: contract-types.ts (RecoveryMetadata,
 * ExecutorContinuationContract, deriveMinimalContract).
 */

import type {
  RecoveryMetadata,
  ExecutorContinuationContract,
} from "./contract-types";
import { deriveMinimalContract } from "./contract-types";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Structured representation of an executor output from the substrate/shape
 * layer. Defined locally to avoid coupling to shape-specific types; the
 * recovery layer operates on a minimal interface.
 */
export interface RecoveryExecutorOutput {
  taskId: string;
  description: string;
  agentName: string;
  output: string;
  stderr?: string;
  exitCode: number | null;
  durationMs: number;
}

/**
 * A single subtask produced by splitTaskOnFailure().
 */
export interface SubtaskSpec {
  /** Stable subtask identifier (e.g. "task-1-split-1"). */
  id: string;
  /** Self-contained description ≤ maxWordsPerSubtask words. */
  description: string;
  /** Dependencies: first part inherits parent deps; others depend on prior part. */
  dependsOn: string[];
  /** 0-based index within the split chain. */
  partIndex: number;
  /** Total number of parts in this split chain. */
  totalParts: number;
}

/**
 * Options controlling splitTaskOnFailure() behavior.
 */
export interface SplitTaskOptions {
  /**
   * Maximum words per subtask description (default 150).
   * Subtasks exceeding this are split further (up to maxSplitDepth).
   */
  maxWordsPerSubtask?: number;
  /**
   * Maximum recursive split depth (default 3). When reached, each subtask
   * is accepted as-is regardless of size.
   */
  maxSplitDepth?: number;
  /**
   * Original dependencies the parent task had. Subtask part 0 inherits
   * these; subsequent parts depend on the prior part.
   */
  preserveDependsOn?: string[];
}

/**
 * Result of a split operation.
 */
export interface SplitResult {
  /** The chained subtasks produced. */
  subtasks: SubtaskSpec[];
  /** Recovery metadata derived from the split (for replanning if needed). */
  metadata: RecoveryMetadata;
  /** The split depth that was applied (original depth + 1). */
  newDepth: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_MAX_WORDS_PER_SUBTASK = 150;
const DEFAULT_MAX_SPLIT_DEPTH = 3;
const MAX_PRIOR_OUTPUT_CHARS = 4000;

// ═══════════════════════════════════════════════════════════════════════════
// splitTaskOnFailure — primary entry point
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Split a failed executor task into chained subtasks, each capped at
 * `maxWordsPerSubtask` words (default 150). Produces recovery metadata
 * so the orchestrator can escalate to replan-with-learning if this
 * split also fails.
 *
 * Strategy:
 *   1. Split the task description into sentences.
 *   2. Group sentences into chunks ≤ maxWordsPerSubtask words.
 *   3. Chain chunks sequentially (part-N depends on part-(N-1)).
 *   4. Cap recursive split depth at maxSplitDepth.
 *   5. Derive recovery metadata from partial output for the new subtasks.
 *
 * @param taskId             The failed task's ID (e.g. "task-3").
 * @param taskDescription    The failed task's description.
 * @param partialOutput      Any partial output the failing executor produced.
 * @param recoveryDepth      Current recovery depth for this task chain.
 * @param options            Configuration overrides.
 * @returns                  SplitResult with subtasks and recovery metadata.
 */
export function splitTaskOnFailure(
  taskId: string,
  taskDescription: string,
  partialOutput: string,
  recoveryDepth: number,
  options?: SplitTaskOptions,
): SplitResult {
  const maxWords = options?.maxWordsPerSubtask ?? DEFAULT_MAX_WORDS_PER_SUBTASK;
  const maxDepth = options?.maxSplitDepth ?? DEFAULT_MAX_SPLIT_DEPTH;
  const preserveDependsOn = options?.preserveDependsOn ?? [];

  const newDepth = recoveryDepth + 1;

  // ── Depth cap: if we've hit the max depth, return a single "best effort" subtask ──
  if (newDepth > maxDepth) {
    const cappedDescription = capDescription(taskDescription, maxWords);
    const subtask: SubtaskSpec = {
      id: `${taskId}-split${newDepth}-p1`,
      description: cappedDescription,
      dependsOn: [...preserveDependsOn],
      partIndex: 0,
      totalParts: 1,
    };

    return {
      subtasks: [subtask],
      metadata: deriveMinimalContract(taskId, taskDescription, partialOutput),
      newDepth,
    };
  }

  // ── Split the description into chunks ────────────────────────────────────
  const chunks = splitDescriptionIntoChunks(taskDescription, maxWords);

  // If splitting didn't produce multiple chunks, still hand back as one subtask
  if (chunks.length <= 1) {
    const subtask: SubtaskSpec = {
      id: `${taskId}-split${newDepth}-p1`,
      description: chunks[0] ?? capDescription(taskDescription, maxWords),
      dependsOn: [...preserveDependsOn],
      partIndex: 0,
      totalParts: 1,
    };
    return {
      subtasks: [subtask],
      metadata: deriveMinimalContract(taskId, taskDescription, partialOutput),
      newDepth,
    };
  }

  // ── Build chained subtasks ───────────────────────────────────────────────
  const subtasks: SubtaskSpec[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1
      ? `[Part ${i + 1}/${chunks.length} — continuation of ${taskId}] `
      : "";
    const subtaskId = `${taskId}-split${newDepth}-p${i + 1}`;

    // First part inherits original dependencies; subsequent parts depend on the prior
    const dependsOn: string[] =
      i === 0
        ? [...preserveDependsOn]
        : [`${taskId}-split${newDepth}-p${i}`];

    subtasks.push({
      id: subtaskId,
      description: prefix + chunks[i],
      dependsOn,
      partIndex: i,
      totalParts: chunks.length,
    });
  }

  // ── Derive recovery metadata ─────────────────────────────────────────────
  const metadata = deriveMinimalContract(taskId, taskDescription, partialOutput);
  // Tag with the SPLIT tier and current depth
  metadata.recoveryTier = "SPLIT";
  metadata.recoveryDepth = newDepth;

  return { subtasks, metadata, newDepth };
}

// ═══════════════════════════════════════════════════════════════════════════
// buildSubtaskExecutorPrompt — prompt builder for continuation subtask
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the executor prompt for a continuation subtask. The subtask prompt
 * includes:
 *
 *   1. A preamble explaining this is a split continuation of a prior task.
 *   2. The original (full) task description for context.
 *   3. Bounded prior partial output (≤4000 chars) so the executor knows
 *      what was already done without re-exhausting its context window.
 *   4. The specific subtask description (the work to complete now).
 *   5. Continuation rules adapted from buildExecutorContinuationPrompt.
 *
 * @param subtask             The subtask spec being dispatched.
 * @param originalTaskDesc    The full original task description.
 * @param priorPartialOutput  Bounded prior output from the failed executor.
 * @param contractOrMetadata  Optional continuation contract or derived metadata.
 * @returns                   Full executor prompt string.
 */
export function buildSubtaskExecutorPrompt(
  subtask: SubtaskSpec,
  originalTaskDesc: string,
  priorPartialOutput: string,
  contractOrMetadata?: ExecutorContinuationContract | RecoveryMetadata,
): string {
  const lines: string[] = [];

  // ── Preamble ─────────────────────────────────────────────────────────
  lines.push(
    "## EXECUTOR CONTINUATION SUBTASK",
    "",
    "You are executing a SPLIT SUBTASK — part of a larger task that the",
    "previous executor could not finish due to context exhaustion. Your job",
    "is to complete only this subtask. Do NOT attempt the full original task.",
    "",
    `This is part ${subtask.partIndex + 1} of ${subtask.totalParts} for the`,
    `original task "${subtask.id.replace(/-split\d+-p\d+$/, "")}".`,
    "",
  );

  // ── Original task (full context) ─────────────────────────────────────
  lines.push(
    "## ORIGINAL TASK (for context only — do NOT complete the full task)",
    "",
    originalTaskDesc,
    "",
  );

  // ── Contract or metadata (if available) ──────────────────────────────
  if (contractOrMetadata) {
    const isContract = "artifactType" in contractOrMetadata;
    lines.push(
      isContract
        ? "## CONTINUATION CONTRACT (from prior executor)"
        : "## RECOVERY METADATA (derived from partial output)",
      "",
      "```json",
      JSON.stringify(compactContractOrMetadata(contractOrMetadata), null, 2),
      "```",
      "",
    );
  }

  // ── Prior partial output (bounded) ───────────────────────────────────
  if (priorPartialOutput) {
    const bounded = priorPartialOutput.length > MAX_PRIOR_OUTPUT_CHARS
      ? priorPartialOutput.slice(0, MAX_PRIOR_OUTPUT_CHARS) +
        "\n\n_(prior output truncated — use the subtask description for actual objectives)_"
      : priorPartialOutput;
    lines.push(
      "## PRIOR EXECUTOR OUTPUT (for context only)",
      "",
      bounded,
      "",
    );
  }

  // ── Subtask description (the actual work) ────────────────────────────
  lines.push(
    "## YOUR SUBTASK",
    "",
    subtask.description,
    "",
  );

  // ── Continuation rules ───────────────────────────────────────────────
  lines.push(
    "## SUBTASK RULES",
    "",
    "1. Complete ONLY the subtask description above — not the full original task.",
    "2. If the prior output includes a continuation contract, validate its file",
    "   claims against disk state before trusting them.",
    "3. Do NOT redo work that is genuinely completed by the prior executor.",
    "4. Use write/edit/bash tools to produce actual file artifacts when the",
    "   subtask involves CREATE, IMPLEMENT, BUILD, or MODIFY work.",
    "5. Return a concise report with: changes made, files touched, commands/tests",
    "   run, and remaining issues or uncertainty.",
    `6. This is part ${subtask.partIndex + 1}/${subtask.totalParts}. If you are`,
    `   ${subtask.partIndex + 1 < subtask.totalParts ? "NOT" : ""} the last part,`,
    `   ${subtask.partIndex + 1 < subtask.totalParts
        ? "do NOT attempt to produce a final result — later parts will chain from your output."
        : "produce a complete result for this subtask chain."
      }`,
    "",
  );

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// chainExecutorOutputs — combine subtask outputs into a single output
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Chain the outputs from multiple sequential subtask runs into a single
 * coherent executor output report. This is used when the split-and-respawn
 * recovery tier succeeds: the orchestrator combines all subtask outputs
 * into one ExecutorOutput that the verifier can evaluate as a unit.
 *
 * @param subtaskOutputs          Outputs from the chained subtask runs, in order.
 * @param originalTaskDescription The original task description (for context).
 * @param originalTaskId          The original task ID (without split suffixes).
 * @returns                       A single combined output string.
 */
export function chainExecutorOutputs(
  subtaskOutputs: RecoveryExecutorOutput[],
  originalTaskDescription: string,
  originalTaskId: string,
): string {
  if (subtaskOutputs.length === 0) {
    return `Task ${originalTaskId}: no subtask outputs produced (all subtask executors failed).`;
  }

  const parts: string[] = [];

  parts.push(
    `## Combined Result for ${originalTaskId} (split into ${subtaskOutputs.length} subtasks)`,
    "",
    `Original task: ${originalTaskDescription}`,
    "",
  );

  for (const [index, output] of subtaskOutputs.entries()) {
    const header = index === 0
      ? "## Subtask Outputs"
      : ""; // Only emit header once before the first subtask
    if (header) parts.push(header, "");

    parts.push(
      `### Part ${index + 1}/${subtaskOutputs.length}: ${output.taskId}`,
      "",
      `**Agent:** ${output.agentName} | **Duration:** ${output.durationMs}ms | **Exit:** ${output.exitCode ?? "N/A"}`,
      "",
      output.output || "_(No output produced)_",
      "",
    );

    if (output.stderr) {
      const truncatedStderr = output.stderr.length > 1000
        ? output.stderr.slice(0, 1000) + "\n_(stderr truncated)_"
        : output.stderr;
      parts.push(
        `_stderr:_`,
        "```",
        truncatedStderr,
        "```",
        "",
      );
    }
  }

  // ── Summary block ────────────────────────────────────────────────────
  const totalDurationMs = subtaskOutputs.reduce((sum, o) => sum + o.durationMs, 0);
  const allExitedClean = subtaskOutputs.every((o) => o.exitCode === 0);
  const failCount = subtaskOutputs.filter((o) => o.exitCode !== 0).length;

  parts.push(
    "## Split Chain Summary",
    "",
    `- Subtasks: ${subtaskOutputs.length}`,
    `- Total duration: ${totalDurationMs}ms`,
    `- All subtasks clean exit: ${allExitedClean ? "yes" : `no (${failCount} failed)`}`,
    `- Recovery tier: SPLIT`,
    "",
  );

  return parts.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Split a description into chunks of ≤ maxWords words by grouping on
 * sentence boundaries.
 */
function splitDescriptionIntoChunks(description: string, maxWords: number): string[] {
  const sentences = splitIntoSentences(description);
  const chunks: string[] = [];
  let current = "";
  let currentWordCount = 0;

  for (const sentence of sentences) {
    const sentenceWords = sentence.split(/\s+/).filter(Boolean).length;

    if (currentWordCount === 0) {
      current = sentence;
      currentWordCount = sentenceWords;
      continue;
    }

    if (currentWordCount + sentenceWords <= maxWords) {
      current += " " + sentence;
      currentWordCount += sentenceWords;
    } else {
      chunks.push(current.trim());
      current = sentence;
      currentWordCount = sentenceWords;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  // If no chunks produced (shouldn't happen), return the whole description
  if (chunks.length === 0) {
    return [description];
  }

  return chunks;
}

/**
 * Split text into sentences, handling edge cases like decimal numbers,
 * abbreviations, and inline code.
 */
function splitIntoSentences(text: string): string[] {
  // Protect decimal numbers (e.g., "3.5") from being misidentified as sentence boundaries
  const decimalPlaceholder = "__DEC__";
  const protected_ = text.replace(/(\d)\.(\d)/g, `$1${decimalPlaceholder}$2`);

  // Split on sentence boundaries: . ! ? followed by space and capital letter or digit
  const parts = protected_.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);

  return parts
    .map((part) => part.replaceAll(decimalPlaceholder, ".").trim())
    .filter(Boolean);
}

/**
 * Cap a description to maxWords by truncating with ellipsis.
 */
function capDescription(description: string, maxWords: number): string {
  const words = description.split(/\s+/);
  if (words.length <= maxWords) return description;
  const capped = words.slice(0, maxWords).join(" ");
  return capped + "… (truncated from original — complete only the described portion)";
}

/**
 * Compact an ExecutorContinuationContract or RecoveryMetadata for prompt
 * JSON display, keeping only the fields relevant to a continuation executor.
 */
function compactContractOrMetadata(
  input: ExecutorContinuationContract | RecoveryMetadata,
): Record<string, unknown> {
  if ("artifactType" in input) {
    // ExecutorContinuationContract
    return {
      taskId: input.taskId,
      completed: input.completed,
      remaining: input.remaining,
      filesTouched: input.filesTouched,
      decisions: input.decisions,
      notes: input.notes,
    };
  }
  // RecoveryMetadata
  return {
    taskId: input.taskId,
    completedObjectives: input.completedObjectives,
    remainingObjectives: input.remainingObjectives,
    filesMentioned: input.filesMentioned,
    derivationMethod: input.derivationMethod,
    recoveryTier: input.recoveryTier,
    recoveryDepth: input.recoveryDepth,
  };
}
