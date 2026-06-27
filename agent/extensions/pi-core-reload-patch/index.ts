import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const USER_HOME = process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
const PI_HOME_DIR = process.env.PI_HOME
	? resolve(process.env.PI_HOME)
	: resolve(USER_HOME, ".pi");
const AGENT_DIR = resolve(PI_HOME_DIR, "agent");
const PATCHER_SCRIPT = resolve(
	AGENT_DIR,
	"core-patch",
	"reapply-pi-core-patch.mjs",
);

const ALLOWED_ACTIONS = new Set(["check", "apply", "verify"]);
const ACTIONS = ["check", "apply", "verify"] as const;
type PatchAction = (typeof ACTIONS)[number];

/** Which type of core patch the user is managing. */
type PatchType = "reload" | "new-session";

interface PatcherResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

function runPatcher(action: PatchAction): Promise<PatcherResult> {
	return new Promise((resolvePromise, rejectPromise) => {
		if (!existsSync(PATCHER_SCRIPT)) {
			rejectPromise(new Error(`Patcher script not found: ${PATCHER_SCRIPT}`));
			return;
		}

		const child = spawn(process.execPath, [PATCHER_SCRIPT, action], {
			cwd: AGENT_DIR,
			env: process.env,
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", rejectPromise);
		child.on("close", (code, signal) => {
			resolvePromise({ code, signal, stdout, stderr });
		});
	});
}

// ── Per-patch-type command names ────────────────────────────────────────────

function commandFor(action: PatchAction, patchType: PatchType): string {
	const prefix = patchType === "new-session"
		? "pi-core-new-session-patch"
		: "pi-core-reload-patch";
	return `${prefix}-${action}`;
}

function slashCommand(patchType: PatchType): string {
	return patchType === "new-session"
		? "/pi-core-new-session-patch"
		: "/pi-core-reload-patch";
}

function patchDisplayLabel(patchType: PatchType): string {
	return patchType === "new-session"
		? "Pi core new-session patch"
		: "Pi core reload patch";
}

// ── Output formatting ──────────────────────────────────────────────────────

function exitSummary(action: PatchAction, result: PatcherResult, patchType: PatchType): string {
	const cmd = commandFor(action, patchType);
	if (result.signal) return `/${cmd} terminated by ${result.signal}`;
	const code = result.code ?? -1;
	if (code === 0) return `/${cmd} completed successfully`;
	if (action === "check" && code === 1) {
		return `/${cmd} completed: patch is not fully applied`;
	}
	if (code === 1) return `/${cmd} completed: verification/check failed`;
	if (code === 2) return `/${cmd} safe-failed: Pi source drift or unmatched target`;
	if (code === 3) return `/${cmd} usage error`;
	return `/${cmd} exited with code ${code}`;
}

/**
 * Build the shared-bridge explanation for the output message.
 * The same `pi.executeCommand` core patch enables both `agent_reload_runtime`
 * and `agent_new_session`, so we surface that fact regardless of which
 * slash-command path the user invoked.
 */
function sharedBridgeNote(patchType: PatchType): string {
	const invokedCommands = patchType === "new-session"
		? "`/pi-core-new-session-patch` commands"
		: "`/pi-core-reload-patch` commands";

	const lines = [
		"",
		"The `pi.executeCommand` core patch is shared between:",
		"  • `agent_reload_runtime`  — automatic Pi reload (repair via `/pi-core-reload-patch`)",
		"  • `agent_new_session`     — automatic Pi new-session (repair via `/pi-core-new-session-patch`)",
		"",
		`You invoked the ${invokedCommands}; they run the same underlying ` +
			"`agent/core-patch/reapply-pi-core-patch.mjs` runner as the other command set.",
		"",
		"**Design invariants:** user-invoked only — no silent auto-patching, no startup/background",
		"patching, no live reload from patcher or slash commands, no `pi.sendUserMessage('/command')`",
		"as a command bridge (that path does not dispatch commands — see UPSTREAM_REQUEST.md §2).",
	];

	if (patchType === "new-session") {
		lines.push(
			"",
			"After a successful apply, the running Pi process still has the OLD (unpatched) code.",
			"To load the patched core, the user must manually run:",
			"    /reload",
			"  (or /agent-reload-runtime, or restart Pi).",
			"Only then can `agent_new_session` work.",
		);
	}
	return lines.join("\n");
}

function formatOutput(action: PatchAction, result: PatcherResult, patchType: PatchType): string {
	const parts = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean);
	const body = parts.join("\n\n[stderr]\n");
	const suffix = action === "apply"
		? "\n\nAfter a successful apply, manually run `/reload` or restart Pi to load the patched core."
		: "";

	return [
		exitSummary(action, result, patchType),
		"",
		"```text",
		body || "(no output)",
		"```",
		suffix,
		sharedBridgeNote(patchType),
	].join("\n");
}

// ── Run and display ────────────────────────────────────────────────────────

async function runAndDisplay(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	action: PatchAction,
	patchType: PatchType,
): Promise<void> {
	const label = patchDisplayLabel(patchType);
	ctx.ui.notify(`Running ${label} ${action}...`, "info");
	try {
		const result = await runPatcher(action);
		const content = formatOutput(action, result, patchType);
		const customType = patchType === "new-session"
			? "pi-core-new-session-patch"
			: "pi-core-reload-patch";
		pi.sendMessage({
			customType,
			content,
			display: true,
			details: {
				action,
				patchType,
				code: result.code,
				signal: result.signal,
				patcherScript: PATCHER_SCRIPT,
			},
		});

		const level = result.code === 0 || (action === "check" && result.code === 1)
			? "info"
			: "warning";
		ctx.ui.notify(exitSummary(action, result, patchType), level);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const customType = patchType === "new-session"
			? "pi-core-new-session-patch"
			: "pi-core-reload-patch";
		pi.sendMessage({
			customType,
			content: `${label} ${action} failed to launch.\n\n\`\`\`text\n${message}\n\`\`\``,
			display: true,
			details: { action, patchType, error: message, patcherScript: PATCHER_SCRIPT },
		});
		ctx.ui.notify(`${label} ${action} failed: ${message}`, "error");
	}
}

// ── Argument parsing ───────────────────────────────────────────────────────

function parseAction(args: string): PatchAction | undefined {
	const action = args.trim().split(/\s+/, 1)[0] as PatchAction | "";
	if (ALLOWED_ACTIONS.has(action)) return action as PatchAction;
	return undefined;
}

// ── Extension registration ─────────────────────────────────────────────────

export default function piCoreReloadPatch(pi: ExtensionAPI): void {
	// ── Reload patch commands (existing) ──────────────────────────────────

	pi.registerCommand("pi-core-reload-patch", {
		description:
			"Run the user-invoked Pi core reload patcher. Usage: /pi-core-reload-patch check|apply|verify",
		getArgumentCompletions: (prefix: string) => {
			const items = ACTIONS
				.filter((action) => action.startsWith(prefix.trim()))
				.map((action) => ({
					value: action,
					label: action,
					description: `Run pi core reload patch ${action}`,
				}));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const action = parseAction(args);
			if (!action) {
				ctx.ui.notify(
					"Usage: /pi-core-reload-patch check|apply|verify",
					"warning",
				);
				return;
			}
			await runAndDisplay(pi, ctx, action, "reload");
		},
	});

	for (const action of ACTIONS) {
		pi.registerCommand(commandFor(action, "reload"), {
			description: `Run Pi core reload patch ${action}`,
			handler: async (_args, ctx) => {
				await runAndDisplay(pi, ctx, action, "reload");
			},
		});
	}

	// ── New-session patch commands (new) ─────────────────────────────────

	pi.registerCommand("pi-core-new-session-patch", {
		description:
			"Run the user-invoked Pi core new-session patcher. Usage: /pi-core-new-session-patch check|apply|verify",
		getArgumentCompletions: (prefix: string) => {
			const items = ACTIONS
				.filter((action) => action.startsWith(prefix.trim()))
				.map((action) => ({
					value: action,
					label: action,
					description: `Run pi core new-session patch ${action}`,
				}));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const action = parseAction(args);
			if (!action) {
				ctx.ui.notify(
					"Usage: /pi-core-new-session-patch check|apply|verify",
					"warning",
				);
				return;
			}
			await runAndDisplay(pi, ctx, action, "new-session");
		},
	});

	for (const action of ACTIONS) {
		pi.registerCommand(commandFor(action, "new-session"), {
			description: `Run Pi core new-session patch ${action}`,
			handler: async (_args, ctx) => {
				await runAndDisplay(pi, ctx, action, "new-session");
			},
		});
	}
}
