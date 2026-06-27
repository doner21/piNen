/**
 * metadata.ts — Recovery Metadata Builder for Executor Outputs
 * ==============================================================
 *
 * Layer: src/executor-recovery/ (shape-adjacent, not substrate)
 *
 * Produces RecoveryMetadata from executor outputs when a task fails due
 * to context exhaustion or quality gate failures. The metadata feeds into
 * the tiered escalation system:
 *
 *   HANDOFF (CONTINUE) → SPLIT → REPLAN
 *
 * Functions:
 *   - buildRecoveryMetadata() — primary entry point: collects structured
 *     metadata from executor outputs and partial results.
 *   - extractCompletedObjectives() — scans executor output text for
 *     evidence of completed sub-objectives using regex heuristics.
 *
 * Dependencies: contract-types.ts (RecoveryMetadata, RecoveryTier,
 * ExecutorContinuationContract, contractToRecoveryMetadata).
 */

import type {
  RecoveryMetadata,
  RecoveryTier,
  ExecutorContinuationContract,
} from "./contract-types";
import { contractToRecoveryMetadata } from "./contract-types";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Minimal executor output shape consumed by the recovery metadata layer.
 * Defined locally to avoid coupling to shape-specific types.
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
 * Options controlling metadata derivation behavior.
 */
export interface RecoveryMetadataOptions {
  /** If provided, the executor proactively wrote this continuation contract. */
  continuationContract?: ExecutorContinuationContract;
  /** If provided, partial output from the failing executor. */
  priorPartialOutput?: string;
  /** Additional file paths known to have been touched (e.g. from git status). */
  knownFilesTouched?: string[];
  /** Additional context about why recovery was triggered. */
  triggerReason?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// buildRecoveryMetadata — primary entry point
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build RecoveryMetadata for a failed executor task. The metadata is used
 * by the tiered escalation system to decide the next recovery action and,
 * if escalation reaches REPLAN, to inform the planner about what was
 * completed and what remains.
 *
 * Priority order for source material:
 *   1. Explicit continuation contract (proactive executor snapshot) — most reliable.
 *   2. Regex-scanned partial output — medium reliability, file claims may be inaccurate.
 *   3. Fallback (empty metadata) — least reliable, triggers full replan.
 *
 * @param taskId               The failed task's ID.
 * @param taskDescription      The task's description (from the plan).
 * @param executorOutputs      All executor outputs available (may include partial outputs).
 * @param recoveryTier         The recovery tier that triggered this metadata build.
 * @param recoveryDepth        Current recovery depth for this task.
 * @param options              Additional context (contract, partial output, known files).
 * @returns                    RecoveryMetadata for the recovery pipeline.
 */
export function buildRecoveryMetadata(
  taskId: string,
  taskDescription: string,
  executorOutputs: RecoveryExecutorOutput[],
  recoveryTier: RecoveryTier,
  recoveryDepth: number,
  options?: RecoveryMetadataOptions,
): RecoveryMetadata {
  // ── Source 1: Proactive continuation contract ─────────────────────────
  if (options?.continuationContract) {
    const metadata = contractToRecoveryMetadata(
      options.continuationContract,
      taskDescription,
      recoveryDepth,
    );
    metadata.recoveryTier = recoveryTier;
    return metadata;
  }

  // ── Source 2: Regex-scan partial output ─────────────────────────────
  const taskOutput = executorOutputs.find((o) => o.taskId === taskId);
  const partialOutput =
    options?.priorPartialOutput ??
    taskOutput?.output ??
    "";

  if (partialOutput) {
    const completed = extractCompletedObjectives(
      [taskOutput].filter(Boolean) as RecoveryExecutorOutput[],
      taskDescription,
    );
    // Merge any known files touched
    const filesMentioned = collectFilesMentioned(
      [taskOutput].filter(Boolean) as RecoveryExecutorOutput[],
      options?.knownFilesTouched ?? [],
    );

    const metadata: RecoveryMetadata = {
      taskId,
      taskDescription,
      partialOutput,
      filesMentioned,
      derivationMethod: filesMentioned.length > 0 || completed.length > 0
        ? "regex_scan"
        : "fallback_empty",
      completedObjectives: completed,
      remainingObjectives: computeRemaining(completed, taskDescription),
      recoveryTier,
      recoveryDepth,
    };
    return metadata;
  }

  // ── Source 3: Fallback (no output available) ─────────────────────────
  return {
    taskId,
    taskDescription,
    partialOutput: "",
    filesMentioned: options?.knownFilesTouched ?? [],
    derivationMethod: "fallback_empty",
    completedObjectives: [],
    remainingObjectives: [taskDescription],
    recoveryTier,
    recoveryDepth,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// extractCompletedObjectives — scan executor outputs for completion evidence
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract which sub-objectives appear to have been completed by scanning
 * executor output text with regex heuristics. This is best-effort and
 * may miss completed work or incorrectly flag incomplete work.
 *
 * Patterns matched:
 *   - Explicit completion markers: "created X", "implemented X", "built X", etc.
 *   - File artifact references: mentions of files created or modified.
 *   - Test-pass signals: "tests pass", "all tests pass", "tests succeed".
 *   - Task-done declarations: "Task X: done", "Completed task X", etc.
 *
 * @param outputs          Executor outputs to scan (may be from multiple subtasks).
 * @param taskDescription  The original task description for context.
 * @returns                Array of completed objective strings (deduplicated, max 50).
 */
export function extractCompletedObjectives(
  outputs: RecoveryExecutorOutput[],
  taskDescription: string,
): string[] {
  const completed = new Set<string>();

  for (const output of outputs) {
    const text = output.output;
    if (!text) continue;

    // ── Pattern 1: Explicit completion markers with file references ─────
    const explicitFilePatterns = [
      /\b(?:created|implemented|added|built|wrote|finished|completed)\s+(?:the\s+)?(?:file\s+)?[`"']?([^\s`"',;]+(?:\.(?:ts|js|json|md|py|go|rs|java|cpp|c|h|css|html|yaml|yml|toml|cjs|mjs|tsx|jsx)))[`"']?/gi,
      /\b(?:modified|edited|updated|changed|refactored|fixed)\s+(?:the\s+)?(?:file\s+)?[`"']?([^\s`"',;]+(?:\.(?:ts|js|json|md|py|go|rs|java|cpp|c|h|css|html|yaml|yml|toml|cjs|mjs|tsx|jsx)))[`"']?/gi,
    ];

    for (const pattern of explicitFilePatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        completed.add(match[0].trim());
      }
    }

    // ── Pattern 2: File artifact claims (generated/created file) ────────
    const fileClaimPatterns = [
      /\b(?:generated?|produced?|wrote?|emitted?)\s+(?:a\s+)?(?:new\s+)?(?:file\s+)?(?:at\s+|to\s+)?[`"']?([^\s`"',;]+(?:\.(?:ts|js|json|md|py|go|rs|java|cpp|c|h|css|html|yaml|yml|toml|cjs|mjs|tsx|jsx|png|svg|jpg|gif|pdf|txt|xml)))[`"']?/gi,
    ];
    for (const pattern of fileClaimPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        completed.add("File: " + match[0].trim());
      }
    }

    // ── Pattern 3: Task-done / objective-complete declarations ──────────
    const taskDonePatterns = [
      /\b[Tt]ask\s+\S+\s*(?::|is|was|—)\s*(?:done|complete|implemented|finished|resolved)/g,
      /\b(?:completed?|finished?|done)\s+(?:the\s+)?(?:task|implementation|work|change|fix|feature)/gi,
      /\b(?:objective|goal|milestone)\s+\S+\s*(?:achieved|met|reached|complete)/gi,
    ];
    for (const pattern of taskDonePatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        completed.add(match[0].trim());
      }
    }

    // ── Pattern 4: Test-pass signals ────────────────────────────────────
    const testPassPatterns = [
      /\b(?:all\s+)?(?:tests?|specs?|suites?)\s+(?:pass|succeed|are\s+green|are\s+passing)/gi,
      /\b(?:ran?\s+(?:the\s+)?tests?|tests?\s+ran?)\s*(?:—|:|and)\s*(?:all\s+)?(?:pass|succeed|green)/gi,
      /\bno\s+(?:test\s+)?failures?\b/gi,
      /\b(?:test|spec)\s+suite\s+(?:passed|succeeded)\b/gi,
    ];
    for (const pattern of testPassPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        completed.add(match[0].trim());
      }
    }

    // ── Pattern 5: Commands/tests run with success ──────────────────────
    const cmdRunPatterns = [
      /\b(?:ran?|executed?|invoked?)\s+(?:`[^`]+`|"[^"]+")\s*(?:successfully|and\s+(?:it\s+)?(?:passed|worked|succeeded))/gi,
    ];
    for (const pattern of cmdRunPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        completed.add(match[0].trim());
      }
    }
  }

  // ── Deduplicate and cap ────────────────────────────────────────────────
  const result = [...completed].slice(0, 50);

  // If nothing was found, try a broader scan for any positive outcome signals
  if (result.length === 0) {
    for (const output of outputs) {
      const text = output.output;
      if (!text) continue;
      // Broad scan: look for any sentence that ends with "done.", "completed.", etc.
      const broadMatches = text.match(/(?:^|[.;!?]\s+)([^.;!?]{10,120}\b(?:done|completed|finished|implemented|created|built|passed|succeeded|working|works)\b[^.;!?]*)(?=[.;!?]|$)/gi);
      if (broadMatches) {
        for (const m of broadMatches) {
          const trimmed = m.replace(/^[.;!?\s]+/, "").trim();
          if (trimmed.length >= 10) {
            completed.add(trimmed);
          }
        }
        if (completed.size > 0) break;
      }
    }
  }

  return [...completed].slice(0, 50);
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Collect all file paths mentioned across executor outputs, plus any
 * additional known-files-touched list.
 */
function collectFilesMentioned(
  outputs: RecoveryExecutorOutput[],
  knownFilesTouched: string[],
): string[] {
  const seen = new Set<string>();

  // Start with known files
  for (const file of knownFilesTouched) {
    seen.add(file);
  }

  // Scan executor outputs for file path mentions
  for (const output of outputs) {
    const text = output.output;
    if (!text) continue;

    const patterns = [
      // Common code file paths: src/foo.ts, lib/bar.js, etc.
      /\b(?:[\w./-]+\.(?:ts|js|json|md|py|go|rs|java|cpp|c|h|css|html|yaml|yml|toml|cjs|mjs|tsx|jsx))\b/gi,
      // Windows absolute paths
      /\b(?:[A-Za-z]:[\\/][\w./\\-]+\.\w+)\b/g,
      // Unix absolute paths
      /\b(?:\/[\w./-]+\.\w+)\b/g,
    ];

    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const filePath = normalizeFilePath(match[0]);
        if (filePath && !isLikelyNonFile(filePath)) {
          seen.add(filePath);
        }
      }
    }
  }

  return [...seen].slice(0, 100);
}

/** Normalize a file path — strip quotes, backslashes to forward slashes. */
function normalizeFilePath(raw: string): string {
  return raw
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\\/g, "/")
    .trim();
}

/** Heuristic filter for likely non-file references. */
function isLikelyNonFile(candidate: string): boolean {
  if (/^https?:\/\//i.test(candidate)) return true;
  if (/^@[\w-]+\/[\w-]+$/i.test(candidate)) return true;
  if (!candidate.includes("/") && !candidate.includes("\\")) {
    return candidate.length < 4 || /^[a-z]+$/i.test(candidate);
  }
  return false;
}

/**
 * Compute remaining objectives as the complement of completed objectives
 * against the task description. When nothing was extracted, the full
 * task description is the only remaining objective.
 */
function computeRemaining(
  completed: string[],
  taskDescription: string,
): string[] {
  if (completed.length === 0) return [taskDescription];
  return [`Remaining work from: ${truncate(taskDescription, 120)} (${completed.length} sub-objective(s) completed by prior executor)`];
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen - 3) + "...";
}
