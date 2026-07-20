/**
 * Deterministic non-LLM phase primitive — shape runtime capability.
 * =================================================================
 * Substrate-level module (NOT a shape). The generated-shape phase model can
 * only spawn LLM subagents; deterministic steps (sha256 freeze of a
 * pre-registration, hash verification, artifact manifests) were therefore
 * orchestrator-held and OUTSIDE shape audit trails
 * (see WAVE2-SPEC.md ITEM A; preregistered-concurrency-spike's usage contract
 * admits this gap).
 *
 * This module executes a SMALL, FIXED set of deterministic operations
 * (v1: hash-file, verify-hash, freeze-record, manifest) using pure Node
 * stdlib only — crypto/fs/path. It performs:
 *   - NO subagent spawn
 *   - NO network
 *   - NO LLM
 *   - NO arbitrary command execution (no process-spawning module is imported).
 *
 * Results are structured and machine-readable, checkpointed via the existing
 * RunStateStore with a `deterministic: true` marker (checkpointPayload emits a
 * SubagentResult superset that round-trips losslessly through the store's
 * JSON.stringify/parse), and rendered in shape reports with a
 * `DETERMINISTIC (no LLM)` tag (formatDeterministicPhaseForReport).
 *
 * Failure model: deterministic failures are FAIL-CLOSED. A missing file or an
 * invalid input throws a DeterministicPhaseError (the shape renders a
 * structured FAIL and aborts — retrying a pure function is pointless). A
 * verify-hash MISMATCH is NOT a throw: it is a valid computed structured
 * failure (`ok:false, match:false`) so callers can branch on it.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

import type { SubagentResult } from "./substrate";

// ── Public types ─────────────────────────────────────────────────────────

/** The fixed v1 operation set — no arbitrary command execution. */
export type DeterministicOp = "hash-file" | "verify-hash" | "freeze-record" | "manifest";

/** Stable, machine-readable error codes for deterministic failures. */
export type DeterministicErrorCode =
  | "MISSING_FILE"
  | "FREEZE_RECORD_EXISTS"
  | "INVALID_MANIFEST_PATH"
  | "INVALID_HASH";

export interface DeterministicPhaseInput {
  op: DeterministicOp;
  /** Working directory that relative source/output paths resolve against. */
  cwd: string;
  /** Operation-specific inputs (see each op contract below). */
  inputs: Record<string, unknown>;
}

export interface DeterministicPhaseOutput {
  readonly deterministic: true;
  op: DeterministicOp;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  /** True when the op computed a successful result (verify-hash mismatch ⇒ false). */
  ok: boolean;
  error?: { code: DeterministicErrorCode; message: string };
}

/**
 * Thrown for FAIL-CLOSED deterministic failures (missing file, invalid hash,
 * invalid manifest path, freeze-record overwrite). A verify-hash MISMATCH does
 * NOT throw — it is a structured `ok:false` output.
 */
export class DeterministicPhaseError extends Error {
  readonly code: DeterministicErrorCode;
  readonly op: DeterministicOp;
  readonly inputs: Record<string, unknown>;

  constructor(code: DeterministicErrorCode, message: string, op: DeterministicOp, inputs: Record<string, unknown>) {
    super(message);
    this.name = "DeterministicPhaseError";
    this.code = code;
    this.op = op;
    this.inputs = inputs;
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;
const GLOB_META = /[*?[\]{}!]/;

function sha256OfFile(absPath: string, op: DeterministicOp, inputs: Record<string, unknown>): { sha256: string; bytes: number } {
  if (!existsSync(absPath) || !statSync(absPath).isFile()) {
    throw new DeterministicPhaseError("MISSING_FILE", `File not found for ${op}: ${absPath}`, op, inputs);
  }
  const buf = readFileSync(absPath);
  return { sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
}

/** Resolve a source path against cwd (absolute allowed, relative resolved). */
function resolveSourcePath(cwd: string, p: unknown, op: DeterministicOp, inputs: Record<string, unknown>): string {
  if (typeof p !== "string" || !p.trim()) {
    throw new DeterministicPhaseError("MISSING_FILE", `${op} requires a non-empty "path" input.`, op, inputs);
  }
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

/** Sanitize a freeze-record name to a bare token (strip separators/traversal). */
function sanitizeName(name: unknown): string {
  const raw = typeof name === "string" && name.trim() ? name.trim() : "record";
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned || "record";
}

// ── Executor ─────────────────────────────────────────────────────────────

/**
 * Execute one deterministic phase operation. Pure Node stdlib; no spawn, no
 * network, no LLM. Throws DeterministicPhaseError for fail-closed failures;
 * returns a structured `ok:false` output for a verify-hash mismatch.
 */
export async function runDeterministicPhase(input: DeterministicPhaseInput): Promise<DeterministicPhaseOutput> {
  const { op, cwd, inputs } = input;

  switch (op) {
    case "hash-file": {
      const abs = resolveSourcePath(cwd, inputs.path, op, inputs);
      const { sha256, bytes } = sha256OfFile(abs, op, inputs);
      return { deterministic: true, op, inputs, outputs: { path: abs, sha256, bytes }, ok: true };
    }

    case "verify-hash": {
      const abs = resolveSourcePath(cwd, inputs.path, op, inputs);
      const reference = typeof inputs.reference === "string" ? inputs.reference.trim().toLowerCase() : "";
      if (!HEX64.test(reference)) {
        throw new DeterministicPhaseError("INVALID_HASH", `verify-hash reference is not a 64-char lowercase sha256 hex: "${String(inputs.reference)}".`, op, inputs);
      }
      const { sha256, bytes } = sha256OfFile(abs, op, inputs);
      const match = sha256.toLowerCase() === reference;
      // A mismatch is a valid, structured, machine-readable failure — NOT a throw.
      return {
        deterministic: true,
        op,
        inputs,
        outputs: { path: abs, sha256, reference, match, bytes },
        ok: match,
      };
    }

    case "freeze-record": {
      const abs = resolveSourcePath(cwd, inputs.path, op, inputs);
      const { sha256, bytes } = sha256OfFile(abs, op, inputs);
      const name = sanitizeName(inputs.name);
      const recordPath = path.resolve(cwd, `FREEZE-${name}.txt`);
      const timestamp = new Date().toISOString();
      const runId = typeof inputs.runId === "string" ? inputs.runId : "";
      const body = [
        `path: ${abs}`,
        `sha256: ${sha256}`,
        `timestamp: ${timestamp}`,
        `runId: ${runId}`,
        "",
      ].join("\n");
      try {
        // wx: never truncate/overwrite an existing freeze record.
        writeFileSync(recordPath, body, { flag: "wx", encoding: "utf8" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new DeterministicPhaseError(
            "FREEZE_RECORD_EXISTS",
            `Freeze record already exists (refusing to overwrite): ${recordPath}.`,
            op,
            inputs,
          );
        }
        throw error;
      }
      return {
        deterministic: true,
        op,
        inputs,
        outputs: { path: abs, sha256, bytes, recordPath, timestamp, runId },
        ok: true,
      };
    }

    case "manifest": {
      const rawPaths = Array.isArray(inputs.paths) ? inputs.paths : [];
      const entries: Array<{ path: string; sha256: string; bytes: number }> = [];
      for (const rel of rawPaths) {
        if (typeof rel !== "string" || !rel.trim()) {
          throw new DeterministicPhaseError("INVALID_MANIFEST_PATH", `manifest entries must be non-empty relative paths (got ${JSON.stringify(rel)}).`, op, inputs);
        }
        if (path.isAbsolute(rel) || GLOB_META.test(rel) || rel.split(/[\\/]+/).includes("..")) {
          throw new DeterministicPhaseError("INVALID_MANIFEST_PATH", `manifest path must be a glob-free relative path staying under cwd: "${rel}".`, op, inputs);
        }
        const abs = path.resolve(cwd, rel);
        const rootWithSep = path.resolve(cwd) + path.sep;
        if (abs !== path.resolve(cwd) && !abs.startsWith(rootWithSep)) {
          throw new DeterministicPhaseError("INVALID_MANIFEST_PATH", `manifest path escapes cwd: "${rel}".`, op, inputs);
        }
        const { sha256, bytes } = sha256OfFile(abs, op, inputs); // missing ⇒ MISSING_FILE (fail-closed, aborts op)
        entries.push({ path: rel, sha256, bytes });
      }
      return { deterministic: true, op, inputs, outputs: { entries }, ok: true };
    }

    default: {
      // Exhaustive guard — unknown ops are a fail-closed error, never a spawn.
      throw new DeterministicPhaseError("INVALID_MANIFEST_PATH", `Unknown deterministic op "${String(op)}".`, op as DeterministicOp, inputs);
    }
  }
}

// ── Checkpoint payload (SubagentResult superset) ─────────────────────────

/**
 * Structural SubagentResult superset carrying the deterministic marker and
 * full inputs/outputs. RunStateStore.checkpointPhase JSON.stringifies its arg
 * and load() JSON.parses it back, so the extra fields round-trip losslessly —
 * no run-state.ts change is needed.
 */
export interface DeterministicCheckpoint extends SubagentResult {
  deterministic: true;
  op: DeterministicOp;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  ok: boolean;
}

export function checkpointPayload(output: DeterministicPhaseOutput): DeterministicCheckpoint {
  return {
    agentName: "deterministic",
    task: `deterministic:${output.op}`,
    text: formatDeterministicPhaseForReport(output),
    stderr: "",
    exitCode: output.ok ? 0 : 1,
    durationMs: 0,
    events: 0,
    toolCalls: { total: 0, byTool: {} },
    deterministic: true,
    op: output.op,
    inputs: output.inputs,
    outputs: output.outputs,
    ok: output.ok,
  };
}

// ── Report rendering ─────────────────────────────────────────────────────

/**
 * Render a deterministic phase for a shape report: the operation, inputs, and
 * output hashes, tagged `DETERMINISTIC (no LLM)`.
 */
export function formatDeterministicPhaseForReport(output: DeterministicPhaseOutput): string {
  const lines: string[] = [
    `DETERMINISTIC (no LLM) — op: ${output.op} — ${output.ok ? "OK" : "FAILED"}`,
  ];
  const inputSummary = summarizeRecord(output.inputs);
  if (inputSummary) lines.push(`- inputs: ${inputSummary}`);
  const outputSummary = summarizeRecord(output.outputs);
  if (outputSummary) lines.push(`- outputs: ${outputSummary}`);
  if (output.error) lines.push(`- error: [${output.error.code}] ${output.error.message}`);
  return lines.join("\n");
}

function summarizeRecord(record: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) {
      // Expand arrays of structured entries (e.g. manifest `entries`) so that
      // the actual per-entry path/sha256/bytes values appear in the report
      // rather than an opaque count. WAVE2-SPEC ITEM A requires deterministic
      // report rendering to surface actual output hashes for every op.
      const rendered = value.map((item) => summarizeValue(item));
      parts.push(`${key}=[${rendered.join("; ")}]`);
    } else if (value && typeof value === "object") {
      parts.push(`${key}={${summarizeRecord(value as Record<string, unknown>)}}`);
    } else {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.join(", ");
}

/** Render a single (possibly nested) value for a report summary. */
function summarizeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => summarizeValue(item)).join("; ")}]`;
  }
  if (value && typeof value === "object") {
    return `{${summarizeRecord(value as Record<string, unknown>)}}`;
  }
  return String(value);
}
