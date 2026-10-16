import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Stable reason surfaced to a worker when a no-force-kill mission blocks bash. */
export const BASH_TIMEOUT_BLOCK_REASON =
  "NO_FORCE_KILL_CONSTRAINT: bash arguments must omit the timeout key or set it to null; the call was blocked before dispatch.";

/** Host-observable proof that the explicitly requested worker extension loaded. */
export const NO_FORCE_KILL_GUARD_READY_MARKER = "NO_FORCE_KILL_GUARD_READY:v1";

/**
 * Pure ownership check: does `input` recursively own a "timeout" property at
 * all, regardless of its value? `null`, `undefined`, zero, strings, numbers,
 * objects and arrays all count as "owning" the key when it is present. It
 * walks JSON-like own properties and arrays, ignores prototypes, and
 * tolerates cycles defensively. This answers "is the key present anywhere",
 * not "is this call forbidden" -- see `ownsForbiddenBashTimeoutArgument` for
 * the policy decision the guard actually blocks on.
 */
export function ownsBashTimeoutArgument(input: unknown, seen = new Set<object>()): boolean {
  if (!input || typeof input !== "object" || seen.has(input)) return false;
  seen.add(input);
  if (Object.prototype.hasOwnProperty.call(input, "timeout")) return true;
  return Object.keys(input).some((key) => ownsBashTimeoutArgument((input as Record<string, unknown>)[key], seen));
}

/**
 * NULL-TIMEOUT-ALLOWED (owner rule, 6 October 2026, superseding the prior
 * "key presence, including null, is forbidden" policy for null only):
 * OpenAI's strict tool schema always sends `timeout: null` for an omitted
 * optional field, so a GPT-6.1 Sol worker could never run bash under the
 * pure-ownership policy above. A bash call is forbidden only when some own
 * "timeout" property -- at the top level or nested, anywhere in the
 * recursive walk -- holds a value other than `null`. A `timeout` key that is
 * absent, or present and `null`, at every level is allowed. `undefined`,
 * zero, a string, a boolean, an object and an array remain forbidden
 * wherever they appear, exactly as before; only the literal value `null`
 * changed. Same recursive walk, prototype exclusion and cycle tolerance as
 * `ownsBashTimeoutArgument`.
 */
export function ownsForbiddenBashTimeoutArgument(input: unknown, seen = new Set<object>()): boolean {
  if (!input || typeof input !== "object" || seen.has(input)) return false;
  seen.add(input);
  if (Object.prototype.hasOwnProperty.call(input, "timeout")
    && (input as Record<string, unknown>).timeout !== null) {
    return true;
  }
  return Object.keys(input).some((key) => {
    if (key === "timeout") return false; // null here is allowed; already decided above
    return ownsForbiddenBashTimeoutArgument((input as Record<string, unknown>)[key], seen);
  });
}

/**
 * Explicit-only worker extension. The orchestrator loads this file solely for
 * missions whose frozen execution constraints opt into no-force-kill mode;
 * ordinary extension discovery remains disabled by the child launcher.
 */
export default function workerExecutionConstraints(pi: ExtensionAPI): void {
  // Pi emits raw arguments here before schema validation. Validation clones the
  // arguments and removes optional nulls, so retain only the forbidden-key
  // decision and correlate it to the later, block-capable tool_call event.
  const rawBashTimeoutByCallId = new Map<string, boolean>();
  const clearPending = (): void => rawBashTimeoutByCallId.clear();

  // stderr is already captured by the host-owned worker stream and never
  // enters model context. The launcher fails closed if this fixed marker is
  // absent, so an ignored or unloadable explicit extension cannot masquerade
  // as an enforced mission.
  process.stderr.write(`${NO_FORCE_KILL_GUARD_READY_MARKER}\n`);

  pi.on("tool_execution_start", (event) => {
    rawBashTimeoutByCallId.set(
      event.toolCallId,
      event.toolName === "bash" && ownsForbiddenBashTimeoutArgument(event.args),
    );
  });
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return undefined;
    if (!rawBashTimeoutByCallId.get(event.toolCallId) && !ownsForbiddenBashTimeoutArgument(event.input)) {
      return undefined;
    }
    return { block: true, reason: BASH_TIMEOUT_BLOCK_REASON };
  });
  pi.on("tool_execution_end", (event) => {
    rawBashTimeoutByCallId.delete(event.toolCallId);
  });

  // Bound correlation state to one active run/turn and clear it on session
  // lifecycle edges. Normal calls are removed individually on execution end;
  // these boundaries cover validation failures and interrupted event streams.
  pi.on("agent_start", clearPending);
  pi.on("agent_end", clearPending);
  pi.on("turn_start", clearPending);
  pi.on("turn_end", clearPending);
  pi.on("session_start", clearPending);
  pi.on("session_shutdown", clearPending);
}
