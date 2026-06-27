/**
 * Context Awareness Extension for Pi
 *
 * Gives the agent self-awareness of its own context-window budget.
 *
 *  1. `context_usage` tool  — agent calls on demand (pull).
 *  2. Threshold nudge       — ephemeral, cache-safe warning injected before
 *                              the LLM call once usage crosses a band (push).
 *
 * Design notes (verified against @earendil-works/pi-coding-agent source):
 *  - ctx.getContextUsage() -> { tokens:number|null, contextWindow:number, percent:number|null }
 *    Returns null tokens/percent right after compaction until the next assistant
 *    response carries fresh usage. (agent-session.js:2403)
 *  - The "context" event = Agent.transformContext (sdk.js:221). Its output is used
 *    for THAT LLM call only and is never persisted to session state. So injection
 *    here is ephemeral, never accumulates, never pollutes the saved session, and
 *    refreshes before every LLM call.
 *  - A `custom`-role message converts to a `user` message for the LLM
 *    (messages.js:88). We MERGE into the trailing user/toolResult message when
 *    possible to avoid two consecutive user turns (Anthropic 400).
 *  - We deliberately do NOT mutate the system prompt with dynamic values: that
 *    would invalidate the provider prompt cache every turn.
 *
 * ⚠️ For this extension to take effect, restart Pi completely — /reload is
 *    unreliable for extension source changes in already-running processes.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// Inject a fresh nudge each time usage moves up into a higher band.
// Bands mirror the footer's own thresholds (70 warn / 90 critical).
const NUDGE_BANDS = [70, 85, 92] as const;

function bandFor(percent: number): number | null {
  let hit: number | null = null;
  for (const b of NUDGE_BANDS) if (percent >= b) hit = b;
  return hit;
}

function fmt(u: { tokens: number | null; contextWindow: number; percent: number | null }): string {
  const win = u.contextWindow;
  const winK = win >= 1000 ? `${Math.round(win / 1000)}k` : `${win}`;
  if (u.percent === null || u.tokens === null) {
    return `Context usage is currently UNKNOWN (the conversation was just compacted; it refreshes after the next model response). Window: ${winK} tokens.`;
  }
  const remaining = Math.max(0, win - u.tokens);
  const remPct = (100 - u.percent).toFixed(1);
  return `Context: ${u.percent.toFixed(1)}% used (${u.tokens.toLocaleString()}/${winK} tokens). ~${remaining.toLocaleString()} tokens (${remPct}%) remain before the window is full; auto-compaction reserves ~16k.`;
}

export default function contextAwareness(pi: ExtensionAPI) {
  // ─────────────────────────────────────────────────────────── pull: the tool
  pi.registerTool({
    name: "context_usage",
    label: "Context Usage",
    description:
      "Report current context-window usage: tokens used, total window, percent used, and tokens remaining. " +
      "Returns UNKNOWN immediately after a compaction until the next model response.",
    promptSnippet: "Check remaining context-window budget (tokens used / total / percent)",
    promptGuidelines: [
      "Call context_usage before deciding to compact, fork, summarize, or start a large multi-file task, so you can budget the work.",
      "When context_usage reports 85%+ used, prefer to wrap up, persist important state (e.g. memory/notes), and propose compaction rather than starting new large reads.",
      "If context_usage returns UNKNOWN (just compacted), proceed normally; it refreshes after your next response.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const u = ctx.getContextUsage();
      if (!u) {
        return {
          content: [
            { type: "text", text: "Context usage unavailable (no active model / unknown window)." },
          ],
          details: { available: false },
        };
      }
      return {
        content: [{ type: "text", text: fmt(u) }],
        details: { tokens: u.tokens, contextWindow: u.contextWindow, percent: u.percent },
      };
    },
  });

  // ───────────────────────────────────────────── push: threshold-gated nudge
  // Track the highest band we've already warned about so we don't repeat every
  // call. Reset downward if usage drops (e.g. after compaction) so a later
  // climb re-warns.
  let lastWarnedBand = 0;

  pi.on("context", async (event, ctx) => {
    const u = ctx.getContextUsage();
    if (!u || u.percent === null) {
      // Unknown (post-compaction). Reset so the next real climb re-warns.
      lastWarnedBand = 0;
      return; // no modification
    }

    const band = bandFor(u.percent);
    if (band === null) {
      lastWarnedBand = 0;
      return;
    }
    if (band <= lastWarnedBand) {
      return; // already warned at this band or higher
    }
    lastWarnedBand = band;

    const note =
      `[automatic context check] ${fmt(u)} ` +
      (band >= 92
        ? "You are very close to the limit — finish and persist state now; compaction is imminent."
        : band >= 85
          ? "You are running low — wrap up the current step and avoid new large reads."
          : "Heads up: over 70% used — plan the rest of this task to fit the remaining budget.");

    const messages = event.messages.slice();
    const tail = messages[messages.length - 1];

    // Merge into a trailing user-equivalent message to preserve role alternation.
    const mergeText = `\n\n${note}`;
    if (tail && (tail.role === "user" || tail.role === "toolResult")) {
      const content = Array.isArray(tail.content)
        ? [...tail.content, { type: "text" as const, text: mergeText }]
        : [
            { type: "text" as const, text: String(tail.content ?? "") },
            { type: "text" as const, text: mergeText },
          ];
      messages[messages.length - 1] = { ...tail, content };
    } else {
      // Tail is assistant (or empty) — safe to append a fresh user-equivalent turn.
      messages.push({
        role: "custom",
        customType: "context-awareness-nudge",
        content: note,
        display: false,
        details: undefined,
        timestamp: Date.now(),
      } as any);
    }

    return { messages };
  });

  // Reset band tracking on each user prompt so warnings aren't suppressed
  // across long gaps (important for unattended Telegram runs).
  pi.on("before_agent_start", async () => {
    lastWarnedBand = 0;
  });
}
