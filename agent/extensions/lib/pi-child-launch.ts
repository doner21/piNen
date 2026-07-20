import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ResolvedPiChildCommand {
	command: string;
	argsPrefix: string[];
	shell?: boolean;
	env?: NodeJS.ProcessEnv;
	launchRuntime: "node" | "electron-as-node" | "native" | "shell";
}

export interface ResolvePiChildCommandOptions {
	hostExecPath?: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}

const JS_CLI_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const DEFAULT_FIRST_JSON_TIMEOUT_MS = 60_000;

/**
 * Top-level JSONL event types emitted by Pi `--mode json` print mode.
 * The first-valid-protocol-event watchdog must fail closed: arbitrary
 * well-formed JSON such as {"type":"noise"} is not evidence that a Pi
 * child reached protocol startup.
 */
export const PI_JSON_PROTOCOL_EVENT_TYPES = new Set([
	"session",
	"agent_start",
	"agent_end",
	"agent_settled",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"queue_update",
	"compaction_start",
	"compaction_end",
	"entry_appended",
	"session_info_changed",
	"thinking_level_changed",
	"auto_retry_start",
	"auto_retry_end",
]);

export function isPiJsonProtocolEvent(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const eventType = (value as { type?: unknown }).type;
	return typeof eventType === "string" && PI_JSON_PROTOCOL_EVENT_TYPES.has(eventType);
}

export function resolvePiChildCommand(
	cliPath: string,
	envName = "PI_CLI_PATH",
	options: ResolvePiChildCommandOptions = {},
): ResolvedPiChildCommand {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	if (!existsSync(cliPath)) {
		throw new Error(`${envName} points to a missing Pi CLI path: ${cliPath}`);
	}
	const ext = path.extname(cliPath).toLowerCase();
	if (!JS_CLI_EXTENSIONS.has(ext)) {
		return {
			command: cliPath,
			argsPrefix: [],
			shell: shouldUseWindowsShell(cliPath, platform),
			launchRuntime: shouldUseWindowsShell(cliPath, platform) ? "shell" : "native",
		};
	}
	return resolveJavaScriptCliCommand(cliPath, options);
}

export function resolveJavaScriptCliCommand(
	cliPath: string,
	options: ResolvePiChildCommandOptions = {},
): ResolvedPiChildCommand {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const hostExecPath = options.hostExecPath ?? process.execPath;

	const explicitNode = resolveExplicitNodePath(env);
	if (explicitNode) return { command: explicitNode, argsPrefix: [cliPath], launchRuntime: "node" };

	if (isNodeExecutable(hostExecPath) && !isElectronExecutable(hostExecPath)) {
		return { command: hostExecPath, argsPrefix: [cliPath], launchRuntime: "node" };
	}

	const pathNode = resolveNodeFromPath(env, platform);
	if (pathNode) return { command: pathNode, argsPrefix: [cliPath], launchRuntime: "node" };

	if (isElectronExecutable(hostExecPath)) {
		return {
			command: hostExecPath,
			argsPrefix: [cliPath],
			env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
			launchRuntime: "electron-as-node",
		};
	}

	throw new Error(
		`Cannot launch JavaScript Pi CLI under a Node-compatible runtime. ` +
		`Host executable is '${path.basename(hostExecPath)}'; set PI_NODE_PATH to node.exe or use a native Pi CLI command.`,
	);
}

export function isElectronExecutable(execPath: string | undefined): boolean {
	const base = path.basename(execPath || "").toLowerCase();
	return base === "electron.exe" || base === "electron";
}

export function isNodeExecutable(execPath: string | undefined): boolean {
	const base = path.basename(execPath || "").toLowerCase();
	return base === "node.exe" || base === "node";
}

export function shouldUseWindowsShell(command: string, platform: NodeJS.Platform = process.platform): boolean | undefined {
	if (platform !== "win32") return undefined;
	return /\.(cmd|bat)(?:$|\s)/i.test(command) ? true : undefined;
}

export function getPiChildFirstJsonTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_CHILD_FIRST_JSON_TIMEOUT_MS;
	if (!raw) return DEFAULT_FIRST_JSON_TIMEOUT_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_FIRST_JSON_TIMEOUT_MS;
	return Math.max(250, Math.min(10 * 60_000, Math.trunc(parsed)));
}

export function killOwnedProcessTree(pid: number | undefined, reason = "pi-child-cleanup"): void {
	if (!pid || pid <= 0) return;
	try {
		if (process.platform === "win32") {
			const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
				detached: true,
			});
			killer.unref?.();
			return;
		}
		try { process.kill(pid, "SIGTERM"); } catch {}
		const pkill = spawn("pkill", ["-TERM", "-P", String(pid)], { stdio: "ignore", detached: true });
		pkill.unref?.();
		setTimeout(() => {
			try { process.kill(pid, "SIGKILL"); } catch {}
			try {
				const pkillHard = spawn("pkill", ["-KILL", "-P", String(pid)], { stdio: "ignore", detached: true });
				pkillHard.unref?.();
			} catch {}
		}, 1500).unref?.();
	} catch {
		try { process.kill(pid, "SIGKILL"); } catch {}
	}
}

function resolveExplicitNodePath(env: NodeJS.ProcessEnv): string | null {
	const explicit = env.PI_NODE_PATH?.trim();
	if (explicit && existsSync(explicit) && isNodeExecutable(explicit)) return explicit;
	return null;
}

function resolveNodeFromPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
	const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
	const names = platform === "win32" ? ["node.exe", "node.cmd", "node.bat"] : ["node"];
	for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
		for (const name of names) {
			const candidate = path.join(dir, name);
			if (existsSync(candidate) && isNodeExecutable(candidate)) return candidate;
		}
	}
	if (platform === "win32") {
		const candidates = [
			path.join(env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
			path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "nodejs", "node.exe"),
			path.join(os.homedir(), "AppData", "Roaming", "npm", "node.exe"),
		];
		return candidates.find((candidate) => existsSync(candidate) && isNodeExecutable(candidate)) ?? null;
	}
	return null;
}
