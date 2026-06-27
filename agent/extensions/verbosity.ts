/**
 * Verbosity Extension for Pi Code
 *
 * Controls how concise or detailed the model's responses are,
 * regardless of which Gemma model is active (26B or 31B).
 *
 * Usage:
 *   /verbosity           → interactive picker
 *   /verbosity brief     → single-sentence answers, bullet points only
 *   /verbosity concise   → short, to-the-point (recommended for coding)
 *   /verbosity normal    → model default behaviour
 *   /verbosity detailed  → thorough explanations with examples
 *   /verbosity verbose   → exhaustive, comprehensive responses
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ─── Types ───────────────────────────────────────────────────────────────────

type VerbosityLevel = "brief" | "concise" | "normal" | "detailed" | "verbose";

interface VerbosityOption {
	value: VerbosityLevel;
	emoji: string;
	label: string;
	description: string;
	instruction: string | null;
}

const LEVELS: VerbosityOption[] = [
	{
		value: "brief",
		emoji: "⚡",
		label: "brief",
		description: "One-liners and bullet points only. No preamble.",
		instruction:
			"VERBOSITY: Be extremely concise. Use bullet points. One sentence per idea. Skip all preamble, summaries, and sign-offs. If the answer fits in one line, give one line.",
	},
	{
		value: "concise",
		emoji: "✂️",
		label: "concise",
		description: "Short and direct — best for coding tasks",
		instruction:
			"VERBOSITY: Keep responses short and direct. Skip unnecessary preamble and filler. Get to the point immediately. Code blocks are fine, but explanations should be minimal.",
	},
	{
		value: "normal",
		emoji: "📄",
		label: "normal",
		description: "Model default — balanced responses",
		instruction: null, // no override
	},
	{
		value: "detailed",
		emoji: "📚",
		label: "detailed",
		description: "Thorough explanations with context and examples",
		instruction:
			"VERBOSITY: Provide thorough, detailed explanations. Include relevant context, edge cases, and concrete examples. Use headers to organise longer responses.",
	},
	{
		value: "verbose",
		emoji: "🔬",
		label: "verbose",
		description: "Exhaustive — cover every angle comprehensively",
		instruction:
			"VERBOSITY: Be comprehensive and exhaustive. Explain the reasoning behind every decision. Cover edge cases, alternatives, trade-offs, and best practices. Assume the reader wants to fully understand the topic.",
	},
];

// ─── Persistence ─────────────────────────────────────────────────────────────

const statePath = join(homedir(), ".pi", "agent", "verbosity-state.json");

function loadLevel(): VerbosityLevel {
	try {
		if (!existsSync(statePath)) return "normal";
		const state = JSON.parse(readFileSync(statePath, "utf-8"));
		return (state.level as VerbosityLevel) ?? "normal";
	} catch {
		return "normal";
	}
}

function saveLevel(level: VerbosityLevel) {
	writeFileSync(statePath, JSON.stringify({ level }, null, 2), "utf-8");
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function verbosityExtension(pi: ExtensionAPI) {
	// Module-level state — survives across turns within a session
	let currentLevel: VerbosityLevel = loadLevel();

	// ── Inject verbosity instruction before every agent turn ──
	pi.on("before_agent_start", async (event) => {
		const option = LEVELS.find((l) => l.value === currentLevel);
		if (!option?.instruction) return; // "normal" → no override

		// Append verbosity instruction to the existing system prompt
		const modified = `${event.systemPrompt}\n\n${option.instruction}`;
		return { systemPrompt: modified };
	});

	// ── Register /verbosity command ──
	pi.registerCommand("verbosity", {
		description: "Set response verbosity: /verbosity [brief|concise|normal|detailed|verbose]",

		getArgumentCompletions: (prefix) => {
			return LEVELS.filter((l) => l.value.startsWith(prefix ?? "")).map((l) => ({
				value: l.value,
				label: `${l.value === currentLevel ? "→ " : "  "}${l.emoji} ${l.value.padEnd(10)} ${l.description}`,
			}));
		},

		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase() as VerbosityLevel | "";

			// ── No args → interactive picker ──
			if (!trimmed) {
				const items = LEVELS.map(
					(l) =>
						`${l.value === currentLevel ? "→ " : "  "}${l.emoji}  ${l.value.padEnd(10)}  ${l.description}`,
				);

				const selected = await ctx.ui.select(`Response Verbosity  (current: ${currentLevel})`, items);
				if (!selected) return;

				const matched = LEVELS.find((l) => selected.includes(l.value));
				if (!matched) return;

				applyLevel(matched, ctx);
				return;
			}

			// ── Explicit arg ──
			const matched = LEVELS.find((l) => l.value === trimmed);
			if (!matched) {
				ctx.ui.notify(
					`❌ Unknown level "${trimmed}"\nValid: ${LEVELS.map((l) => l.value).join(", ")}`,
					"error",
				);
				return;
			}

			applyLevel(matched, ctx);
		},
	});

	function applyLevel(option: VerbosityOption, ctx: any) {
		const previous = currentLevel;
		currentLevel = option.value;
		saveLevel(option.value);

		// Update status bar so the current verbosity is always visible
		ctx.ui.setStatus("verbosity", `${option.emoji} ${option.value}`);

		const arrow = `${previous} → ${option.value}`;
		ctx.ui.notify(
			option.value === "normal"
				? `📄 Verbosity reset to default\n${arrow}`
				: `${option.emoji} Verbosity: ${option.value}\n${arrow}\n\n${option.description}\n\nTakes effect from the next message.`,
			"info",
		);
	}

	// ── Show current level in status bar on startup ──
	pi.on("session_start", async (_event, ctx) => {
		const option = LEVELS.find((l) => l.value === currentLevel)!;
		if (currentLevel !== "normal") {
			ctx.ui.setStatus("verbosity", `${option.emoji} ${option.value}`);
		}
	});
}
