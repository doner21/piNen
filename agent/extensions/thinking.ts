/**
 * Thinking Level Extension for Pi Code
 *
 * Provides a /think slash command with an interactive selector to switch
 * between all reasoning depths at any time — from off to xhigh.
 *
 * Usage:
 *   /think            → opens interactive level picker
 *   /think off        → no reasoning
 *   /think minimal    → 1k token budget
 *   /think low        → 4k token budget
 *   /think medium     → 10k token budget
 *   /think high       → 32k token budget
 *   /think xhigh      → maximum reasoning budget
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ─── Types ───────────────────────────────────────────────────────────────────

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const LEVELS: { value: ThinkingLevel; label: string; budget: string; description: string }[] = [
	{ value: "off",     label: "off",     budget: "0 tokens",    description: "No reasoning — fastest responses" },
	{ value: "minimal", label: "minimal", budget: "~1k tokens",  description: "Very light chain-of-thought" },
	{ value: "low",     label: "low",     budget: "~4k tokens",  description: "Simple reasoning tasks" },
	{ value: "medium",  label: "medium",  budget: "~10k tokens", description: "General use — good balance ✓" },
	{ value: "high",    label: "high",    budget: "~32k tokens", description: "Complex multi-step problems" },
	{ value: "xhigh",   label: "xhigh",  budget: "maximum",     description: "Hardest tasks — slowest, most thorough" },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

const settingsPath = join(homedir(), ".pi", "agent", "settings.json");

function readSettings(): Record<string, unknown> {
	try {
		if (!existsSync(settingsPath)) return {};
		return JSON.parse(readFileSync(settingsPath, "utf-8"));
	} catch {
		return {};
	}
}

function writeSettings(settings: Record<string, unknown>) {
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
}

function getCurrentLevel(): ThinkingLevel {
	const settings = readSettings();
	return (settings.defaultThinkingLevel as ThinkingLevel) ?? "off";
}

function setLevel(level: ThinkingLevel) {
	const settings = readSettings();
	settings.defaultThinkingLevel = level;
	settings.hideThinkingBlock = false; // always keep visible
	writeSettings(settings);
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function thinkingExtension(pi: ExtensionAPI) {
	pi.registerCommand("think", {
		description: "Set reasoning depth: /think [off|minimal|low|medium|high|xhigh]",

		getArgumentCompletions: (prefix) => {
			const current = getCurrentLevel();
			return LEVELS
				.filter((l) => l.value.startsWith(prefix ?? ""))
				.map((l) => ({
					value: l.value,
					label: `${l.value === current ? "→ " : "  "}${l.value.padEnd(8)} ${l.budget.padEnd(14)} ${l.description}`,
				}));
		},

		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase() as ThinkingLevel | "";
			const current = getCurrentLevel();

			// ── No args → interactive picker ──
			if (!trimmed) {
				const menuItems = LEVELS.map(
					(l) =>
						`${l.value === current ? "→ " : "  "}${l.value.padEnd(8)}  ${l.budget.padEnd(14)}  ${l.description}`,
				);

				const selected = await ctx.ui.select(
					`Thinking Level  (current: ${current})`,
					menuItems,
				);

				if (!selected) return;

				// Extract the level value from the selected item
				const matchedLevel = LEVELS.find((l) => selected.trimStart().startsWith(l.value));
				if (!matchedLevel) return;

				if (matchedLevel.value === current) {
					ctx.ui.notify(`Already on "${current}" — no change.`, "info");
					return;
				}

				setLevel(matchedLevel.value);
				showConfirmation(matchedLevel.value, current, ctx);
				return;
			}

			// ── Explicit arg ──
			const matchedLevel = LEVELS.find((l) => l.value === trimmed);

			if (!matchedLevel) {
				const validValues = LEVELS.map((l) => l.value).join(", ");
				ctx.ui.notify(
					`❌ Unknown level "${trimmed}"\nValid values: ${validValues}`,
					"error",
				);
				return;
			}

			if (matchedLevel.value === current) {
				ctx.ui.notify(`Already on "${current}" — no change.`, "info");
				return;
			}

			setLevel(matchedLevel.value);
			showConfirmation(matchedLevel.value, current, ctx);
		},
	});

	function showConfirmation(newLevel: ThinkingLevel, oldLevel: ThinkingLevel, ctx: any) {
		const info = LEVELS.find((l) => l.value === newLevel)!;
		const arrow = `${oldLevel} → ${newLevel}`;

		const msg =
			newLevel === "off"
				? `🔕 Thinking disabled\n${arrow}\n\nThe model will respond directly without reasoning.\nUse /reload or restart Pi to apply.`
				: `🧠 Thinking set to "${newLevel}"\n${arrow}\n\nBudget: ${info.budget}\n${info.description}\n\nUse /reload or restart Pi to apply.`;

		ctx.ui.notify(msg, "info");
	}
}
