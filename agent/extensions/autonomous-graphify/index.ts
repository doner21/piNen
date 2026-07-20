import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { Type, type Static } from "typebox";

// ---------------------------------------------------------------------------
// Types / defaults
// ---------------------------------------------------------------------------

type GateMode = "off" | "soft" | "strict";

type ModelRoute = {
	provider: string;
	model: string;
};

type GraphifyAutonomyConfig = {
	enabled: boolean;
	paused: boolean;
	gateMode: GateMode;
	debounceSeconds: number;
	cooldownMinutes: number;
	significantChangeThreshold: number;
	semanticChangeThreshold: number;
	semanticDocExtensions: string[];
	semanticDebounceSeconds: number;
	semanticTimeoutMs: number;
	autoVerifierEnabled: boolean;
	verifierGates: boolean;
	verifierTimeoutMs: number;
	models: {
		semantic: ModelRoute;
		verifier: ModelRoute;
	};
	runner: {
		subagent: string;
	};
	ignoreGlobs: string[];
	brainSyncAfterRun: boolean;
	maxRunLogEntries: number;
	codeExtensions: string[];
	runTimeoutMs: number;
	maxOutputTailBytes: number;
};

type GraphifyAutonomyState = {
	lastRunAt: string | null;
	lastRunReason: string | null;
	lastRunMode: string | null;
	pendingReason: string | null;
	pendingSince: string | null;
	cooldownUntil: string | null;
	failureCount: number;
	lastFailureReason: string | null;
	lastFailureNotifiedHash: string | null;
	significantChangeCount: number;
	changedFiles: string[];
	docChangeCount: number;
	docChangedFiles: string[];
	lastMutationAt: string | null;
	runStatus: "idle" | "debouncing" | "running" | "failed";
	semanticRunStatus: "idle" | "debouncing" | "running" | "failed";
	semanticPendingReason: string | null;
	semanticPendingSince: string | null;
	semanticScheduledFor: string | null;
	semanticActiveRunId: string | null;
	semanticActiveRunStartedAt: string | null;
	lastSemanticRunAt: string | null;
	lastSemanticRunReason: string | null;
	lastSemanticModel: string | null;
	lastSemanticSubagent: string | null;
	lastSemanticOk: boolean | null;
	lastSemanticExitCode: number | null;
	lastSemanticDurationMs: number | null;
	lastSemanticOutputTail: string | null;
	lastVerifierOk: boolean | null;
	lastVerifierVerdict: string | null;
	lastBrainSyncOk: boolean | null;
	semanticFailureCount: number;
	lastSemanticFailureReason: string | null;
	activeRunId: string | null;
	activeRunStartedAt: string | null;
	scheduledFor: string | null;
	lastRunExitCode: number | null;
	lastRunDurationMs: number | null;
	lastRunStdoutTail: string | null;
	lastRunStderrTail: string | null;
};

type Freshness = {
	status: "fresh" | "stale" | "no-graph" | "unknown";
	reportCommit?: string;
	headCommit?: string;
	reason?: string;
};

const DEFAULT_CONFIG: GraphifyAutonomyConfig = {
	enabled: true,
	paused: false,
	gateMode: "soft",
	debounceSeconds: 60,
	cooldownMinutes: 30,
	significantChangeThreshold: 3,
	semanticChangeThreshold: 5,
	semanticDocExtensions: [".md", ".mdx", ".txt", ".rst", ".adoc", ".wiki"],
	semanticDebounceSeconds: 120,
	semanticTimeoutMs: 600000,
	autoVerifierEnabled: true,
	verifierGates: false,
	verifierTimeoutMs: 120000,
	models: {
		semantic: { provider: "deepseek", model: "deepseek-v4-flash" },
		verifier: { provider: "deepseek", model: "deepseek-v4-pro" },
	},
	runner: { subagent: "graphify-autonomy-runner" },
	ignoreGlobs: [
		"**/node_modules/**",
		"**/graphify-out/**",
		"**/graphify-autonomy/**",
		"**/.git/**",
		"**/scheduler.json",
		"**/*.log",
		"**/*.tmp",
	],
	brainSyncAfterRun: true,
	maxRunLogEntries: 500,
	codeExtensions: [
		".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs",
		".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".rb", ".php",
		".swift", ".kt", ".scala", ".sh", ".sql", ".vue", ".svelte",
	],
	runTimeoutMs: 180000,
	maxOutputTailBytes: 4000,
};

const DEFAULT_STATE: GraphifyAutonomyState = {
	lastRunAt: null,
	lastRunReason: null,
	lastRunMode: null,
	pendingReason: null,
	pendingSince: null,
	cooldownUntil: null,
	failureCount: 0,
	lastFailureReason: null,
	lastFailureNotifiedHash: null,
	significantChangeCount: 0,
	changedFiles: [],
	docChangeCount: 0,
	docChangedFiles: [],
	lastMutationAt: null,
	runStatus: "idle",
	semanticRunStatus: "idle",
	semanticPendingReason: null,
	semanticPendingSince: null,
	semanticScheduledFor: null,
	semanticActiveRunId: null,
	semanticActiveRunStartedAt: null,
	lastSemanticRunAt: null,
	lastSemanticRunReason: null,
	lastSemanticModel: null,
	lastSemanticSubagent: null,
	lastSemanticOk: null,
	lastSemanticExitCode: null,
	lastSemanticDurationMs: null,
	lastSemanticOutputTail: null,
	lastVerifierOk: null,
	lastVerifierVerdict: null,
	lastBrainSyncOk: null,
	semanticFailureCount: 0,
	lastSemanticFailureReason: null,
	activeRunId: null,
	activeRunStartedAt: null,
	scheduledFor: null,
	lastRunExitCode: null,
	lastRunDurationMs: null,
	lastRunStdoutTail: null,
	lastRunStderrTail: null,
};

const GraphifyAutoParams = Type.Object({
	action: StringEnum(["status", "mark_needed", "pause", "resume", "run_now", "schedule"] as const),
	reason: Type.Optional(Type.String({ description: "Reason for mark_needed, pause, or run." })),
	mode: Type.Optional(StringEnum(["code-only", "semantic"] as const)),
	force: Type.Optional(Type.Boolean({ description: "Bypass pause/cooldown for manual override." })),
});

type GraphifyAutoParamsType = Static<typeof GraphifyAutoParams>;

// ---------------------------------------------------------------------------
// Paths / storage
// ---------------------------------------------------------------------------

function paths(): { dir: string; config: string; state: string; runLog: string; lock: string } {
	const dir = join(getAgentDir(), "graphify-autonomy");
	return {
		dir,
		config: join(dir, "config.json"),
		state: join(dir, "state.json"),
		runLog: join(dir, "run-log.jsonl"),
		lock: join(dir, "lock"),
	};
}

async function ensureRuntimeFiles(): Promise<void> {
	const p = paths();
	await fsp.mkdir(p.dir, { recursive: true });
	if (!existsSync(p.config)) {
		await writeJsonAtomic(p.config, DEFAULT_CONFIG);
	}
	if (!existsSync(p.state)) {
		await writeJsonAtomic(p.state, DEFAULT_STATE);
	}
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	await fsp.mkdir(dirname(filePath), { recursive: true });
	const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await fsp.rename(tmp, filePath);
}

function normalizeConfig(raw: Partial<GraphifyAutonomyConfig>): GraphifyAutonomyConfig {
	const gateMode: GateMode =
		raw.gateMode === "off" || raw.gateMode === "strict" || raw.gateMode === "soft"
			? raw.gateMode
			: DEFAULT_CONFIG.gateMode;
	return {
		...DEFAULT_CONFIG,
		...raw,
		gateMode,
		models: {
			semantic: { ...DEFAULT_CONFIG.models.semantic, ...(raw.models?.semantic ?? {}) },
			verifier: { ...DEFAULT_CONFIG.models.verifier, ...(raw.models?.verifier ?? {}) },
		},
		runner: { ...DEFAULT_CONFIG.runner, ...(raw.runner ?? {}) },
		ignoreGlobs: Array.isArray(raw.ignoreGlobs) ? raw.ignoreGlobs : DEFAULT_CONFIG.ignoreGlobs,
		codeExtensions: Array.isArray(raw.codeExtensions) ? raw.codeExtensions : DEFAULT_CONFIG.codeExtensions,
		semanticDocExtensions: Array.isArray(raw.semanticDocExtensions)
			? raw.semanticDocExtensions
			: DEFAULT_CONFIG.semanticDocExtensions,
		semanticChangeThreshold: Number.isFinite(raw.semanticChangeThreshold)
			? Number(raw.semanticChangeThreshold)
			: DEFAULT_CONFIG.semanticChangeThreshold,
		semanticDebounceSeconds: Number.isFinite(raw.semanticDebounceSeconds)
			? Number(raw.semanticDebounceSeconds)
			: DEFAULT_CONFIG.semanticDebounceSeconds,
		semanticTimeoutMs: Number.isFinite(raw.semanticTimeoutMs)
			? Number(raw.semanticTimeoutMs)
			: DEFAULT_CONFIG.semanticTimeoutMs,
		autoVerifierEnabled: typeof raw.autoVerifierEnabled === "boolean"
			? raw.autoVerifierEnabled
			: DEFAULT_CONFIG.autoVerifierEnabled,
		verifierGates: typeof raw.verifierGates === "boolean" ? raw.verifierGates : DEFAULT_CONFIG.verifierGates,
		verifierTimeoutMs: Number.isFinite(raw.verifierTimeoutMs)
			? Number(raw.verifierTimeoutMs)
			: DEFAULT_CONFIG.verifierTimeoutMs,
		runTimeoutMs: Number.isFinite(raw.runTimeoutMs) ? Number(raw.runTimeoutMs) : DEFAULT_CONFIG.runTimeoutMs,
		maxOutputTailBytes: Number.isFinite(raw.maxOutputTailBytes)
			? Number(raw.maxOutputTailBytes)
			: DEFAULT_CONFIG.maxOutputTailBytes,
	};
}

function normalizeState(raw: Partial<GraphifyAutonomyState>): GraphifyAutonomyState {
	return {
		...DEFAULT_STATE,
		...raw,
		changedFiles: Array.isArray(raw.changedFiles) ? raw.changedFiles.slice(0, 200) : [],
		docChangedFiles: Array.isArray(raw.docChangedFiles) ? raw.docChangedFiles.slice(0, 200) : [],
		significantChangeCount: Number.isFinite(raw.significantChangeCount)
			? Number(raw.significantChangeCount)
			: 0,
		docChangeCount: Number.isFinite(raw.docChangeCount) ? Number(raw.docChangeCount) : 0,
		semanticFailureCount: Number.isFinite(raw.semanticFailureCount)
			? Number(raw.semanticFailureCount)
			: 0,
		runStatus: ["idle", "debouncing", "running", "failed"].includes(String(raw.runStatus))
			? (raw.runStatus as GraphifyAutonomyState["runStatus"])
			: "idle",
		semanticRunStatus: ["idle", "debouncing", "running", "failed"].includes(String(raw.semanticRunStatus))
			? (raw.semanticRunStatus as GraphifyAutonomyState["semanticRunStatus"])
			: "idle",
	};
}

async function readConfig(): Promise<GraphifyAutonomyConfig> {
	await ensureRuntimeFiles();
	try {
		return normalizeConfig(JSON.parse(await fsp.readFile(paths().config, "utf8")));
	} catch {
		return DEFAULT_CONFIG;
	}
}

async function readState(): Promise<GraphifyAutonomyState> {
	await ensureRuntimeFiles();
	const p = paths();
	try {
		return normalizeState(JSON.parse(await fsp.readFile(p.state, "utf8")));
	} catch {
		const corruptPath = `${p.state}.corrupt.${Date.now()}`;
		await fsp.rename(p.state, corruptPath).catch(() => {});
		await writeJsonAtomic(p.state, DEFAULT_STATE);
		return DEFAULT_STATE;
	}
}

async function updateConfig(mutator: (config: GraphifyAutonomyConfig) => void): Promise<GraphifyAutonomyConfig> {
	const config = await readConfig();
	mutator(config);
	await writeJsonAtomic(paths().config, config);
	return config;
}

async function updateState(mutator: (state: GraphifyAutonomyState) => void): Promise<GraphifyAutonomyState> {
	const state = await readState();
	mutator(state);
	state.changedFiles = state.changedFiles.slice(-200);
	state.docChangedFiles = state.docChangedFiles.slice(-200);
	await writeJsonAtomic(paths().state, state);
	return state;
}

// ---------------------------------------------------------------------------
// Freshness / mutation helpers
// ---------------------------------------------------------------------------

function normalizePathForMatch(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

function isIgnoredPath(filePath: string, config: GraphifyAutonomyConfig): boolean {
	const normalized = normalizePathForMatch(filePath);
	const withSlashes = `/${normalized}`;
	if (withSlashes.includes("/node_modules/")) return true;
	if (withSlashes.includes("/graphify-out/")) return true;
	if (withSlashes.includes("/graphify-autonomy/")) return true;
	if (withSlashes.includes("/.git/")) return true;
	if (normalized.endsWith("/scheduler.json") || normalized === "scheduler.json") return true;
	if (/\.(log|tmp)$/i.test(normalized)) return true;
	if (/\.jsonl$/i.test(normalized)) return true;
	for (const glob of config.ignoreGlobs) {
		if (glob === "**/node_modules/**" && withSlashes.includes("/node_modules/")) return true;
		if (glob === "**/graphify-out/**" && withSlashes.includes("/graphify-out/")) return true;
		if (glob === "**/graphify-autonomy/**" && withSlashes.includes("/graphify-autonomy/")) return true;
		if (glob === "**/.git/**" && withSlashes.includes("/.git/")) return true;
		if (glob === "**/scheduler.json" && normalized.endsWith("scheduler.json")) return true;
		if (glob === "**/*.log" && normalized.endsWith(".log")) return true;
		if (glob === "**/*.tmp" && normalized.endsWith(".tmp")) return true;
	}
	return false;
}

function pathFromToolInput(input: Record<string, unknown>): string | null {
	const maybe = input.path ?? input.file_path ?? input.filePath;
	return typeof maybe === "string" && maybe.trim() ? maybe.trim() : null;
}

function isReadOnlyBashPipeline(command: string): boolean {
	if (/[;&]|\|\||&&|`|\$\(|[>]>{0,1}/.test(command)) return false;
	const readOnlyCommands = /^(?:env\s+\S+=\S+\s+)*(?:graphify|grep|rg|find|ls|cat|sed|head|tail|pwd|wc|sort|uniq|git\s+(?:status|diff|log|show|rev-parse|branch))/;
	return command.split("|").map((part) => part.trim()).every((part) => readOnlyCommands.test(part));
}

function isMutatingBash(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	if (isReadOnlyBashPipeline(trimmed)) return false;
	return (
		/[>]>{0,1}/.test(trimmed) ||
		/\b(tee|mv|cp|rm|mkdir|touch|python|node|npm|pnpm|yarn|git\s+commit)\b/.test(trimmed)
	);
}

async function recordMutation(ctx: ExtensionContext, changedPath: string): Promise<void> {
	const config = await readConfig();
	const cwd = ctx.cwd ?? process.cwd();
	const displayPath = changedPath.startsWith("bash:")
		? changedPath
		: normalizePathForMatch(relative(cwd, resolve(cwd, changedPath)) || changedPath);
	if (!changedPath.startsWith("bash:") && isIgnoredPath(displayPath, config)) return;
	const docExts = new Set(config.semanticDocExtensions.map((ext) => ext.toLowerCase()));
	const isDoc = !changedPath.startsWith("bash:") && docExts.has(extname(displayPath).toLowerCase());
	await updateState((state) => {
		state.significantChangeCount += 1;
		state.lastMutationAt = new Date().toISOString();
		if (!state.changedFiles.includes(displayPath)) state.changedFiles.push(displayPath);
		if (isDoc) {
			state.docChangeCount += 1;
			if (!state.docChangedFiles.includes(displayPath)) state.docChangedFiles.push(displayPath);
		}
	});
}

async function maybeMarkPendingAfterAgentEnd(): Promise<void> {
	const [config, state] = await Promise.all([readConfig(), readState()]);
	if (!config.enabled || config.paused || state.pendingReason) return;
	if (state.significantChangeCount < config.significantChangeThreshold) return;
	const reason = `${state.significantChangeCount} significant file change(s) detected; autonomous graphify maintenance should run.`;
	await updateState((next) => {
		next.pendingReason = reason;
		next.pendingSince = new Date().toISOString();
	});
}

type ChangeClassification = "codeOnly" | "docsOrMixed" | "ignoredOnly";
type LockMeta = { pid: number; runId: string; startedAt: string; host?: string };
type RunResult = {
	ok: boolean;
	exitCode: number | null;
	durationMs: number;
	stdoutTail: string;
	stderrTail: string;
	runId: string;
	skippedReason?: "already-running";
};

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let semanticDebounceTimer: ReturnType<typeof setTimeout> | undefined;
let runInProgress = false;
let lastKnownCwd: string | undefined;
let graphifyMaintenanceEmitter: ((event: { cwd: string; ok: boolean; mode: "code-only" | "semantic"; reason: string; runId: string }) => void) | undefined;

function lockStaleWindowMs(config: GraphifyAutonomyConfig): number {
	return Math.max(config.runTimeoutMs, config.semanticTimeoutMs) + 60000;
}

function classifyChangedFiles(changedFiles: string[], config: GraphifyAutonomyConfig): ChangeClassification {
	const relevant = changedFiles.filter((file) => !file.startsWith("bash:") && !isIgnoredPath(file, config));
	if (relevant.length === 0) return "ignoredOnly";
	const codeExtensions = new Set(config.codeExtensions.map((ext) => ext.toLowerCase()));
	return relevant.every((file) => codeExtensions.has(extname(file).toLowerCase())) ? "codeOnly" : "docsOrMixed";
}

function countDocWorthyFiles(changedFiles: string[], config: GraphifyAutonomyConfig): number {
	const docExts = new Set(config.semanticDocExtensions.map((ext) => ext.toLowerCase()));
	return changedFiles
		.filter((file) => !file.startsWith("bash:") && !isIgnoredPath(file, config))
		.filter((file) => docExts.has(extname(file).toLowerCase()))
		.length;
}

function shouldAutoRunCodeOnly(
	config: GraphifyAutonomyConfig,
	state: GraphifyAutonomyState,
	classification: ChangeClassification,
	now: number,
	options: { allowDebouncing?: boolean } = {},
): { run: boolean; reason: string } {
	if (!config.enabled) return { run: false, reason: "disabled" };
	if (config.paused) return { run: false, reason: "paused" };
	const allowedStatuses: GraphifyAutonomyState["runStatus"][] = options.allowDebouncing
		? ["idle", "failed", "debouncing"]
		: ["idle", "failed"];
	if (!allowedStatuses.includes(state.runStatus)) return { run: false, reason: `run status is ${state.runStatus}` };
	if (state.significantChangeCount < config.significantChangeThreshold) return { run: false, reason: "below threshold" };
	if (classification !== "codeOnly") return { run: false, reason: `classification is ${classification}` };
	if (state.cooldownUntil && Date.parse(state.cooldownUntil) > now) return { run: false, reason: "cooldown active" };
	return { run: true, reason: "code-only changes passed threshold" };
}

function shouldAutoRunSemantic(
	config: GraphifyAutonomyConfig,
	state: GraphifyAutonomyState,
	now: number,
	options: { allowDebouncing?: boolean } = {},
): { run: boolean; reason: string } {
	if (!config.enabled) return { run: false, reason: "disabled" };
	if (config.paused) return { run: false, reason: "paused" };
	const allowedCodeStatuses: GraphifyAutonomyState["runStatus"][] = ["idle", "failed"];
	if (!allowedCodeStatuses.includes(state.runStatus)) return { run: false, reason: `code run status is ${state.runStatus}` };
	const allowedSemanticStatuses: GraphifyAutonomyState["semanticRunStatus"][] = options.allowDebouncing
		? ["idle", "failed", "debouncing"]
		: ["idle", "failed"];
	if (!allowedSemanticStatuses.includes(state.semanticRunStatus)) {
		return { run: false, reason: `semantic status is ${state.semanticRunStatus}` };
	}
	const semanticFiles = state.docChangedFiles.length > 0 ? state.docChangedFiles : state.changedFiles;
	const classification = classifyChangedFiles(semanticFiles, config);
	if (classification !== "docsOrMixed") return { run: false, reason: `classification is ${classification}` };
	const docFiles = countDocWorthyFiles(semanticFiles, config);
	const meetsThreshold = state.docChangeCount >= config.semanticChangeThreshold;
	if (!meetsThreshold) return { run: false, reason: "below semantic threshold" };
	if (state.cooldownUntil && Date.parse(state.cooldownUntil) > now) return { run: false, reason: "cooldown active" };
	return { run: true, reason: `${state.docChangeCount} doc change(s)/${docFiles} doc file(s) passed semantic threshold` };
}

function tailBytes(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf8");
	return buf.length <= maxBytes ? text : buf.subarray(buf.length - maxBytes).toString("utf8");
}

type RunnerAgent = { name: string; model?: string; tools?: string; systemPrompt?: string };
type SubagentResult = { ok: boolean; exitCode: number | null; output: string; durationMs: number };
type SemanticGraphifyResult = {
	ok: boolean;
	runId: string;
	durationMs: number;
	semantic: SubagentResult | null;
	verifier: { ok: boolean; verdict: string } | null;
	brainSyncOk: boolean | null;
	skippedReason?: "already-running" | "no-runner";
};

function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "project";
}

async function loadRunnerAgent(config: GraphifyAutonomyConfig): Promise<RunnerAgent | null> {
	try {
		const agentPath = join(getAgentDir(), "agents", `${config.runner.subagent}.json`);
		return JSON.parse(await fsp.readFile(agentPath, "utf8")) as RunnerAgent;
	} catch {
		return null;
	}
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

function modelOverrideFor(route: ModelRoute): string {
	return route.model;
}

function textFromMessageEnd(event: unknown): string | null {
	const record = event as Record<string, unknown>;
	if (record.type !== "message_end") return null;
	const candidates = [record.message, record.content, record.text, record.output];
	for (const candidate of candidates) {
		if (typeof candidate === "string") return candidate;
		if (Array.isArray(candidate)) {
			const text = candidate
				.map((part) => {
					const item = part as Record<string, unknown>;
					return typeof item.text === "string" ? item.text : "";
				})
				.filter(Boolean)
				.join("\n");
			if (text) return text;
		}
		if (candidate && typeof candidate === "object") {
			const nested = candidate as Record<string, unknown>;
			if (typeof nested.text === "string") return nested.text;
			if (Array.isArray(nested.content)) {
				const text = nested.content
					.map((part) => {
						const item = part as Record<string, unknown>;
						return typeof item.text === "string" ? item.text : "";
					})
					.filter(Boolean)
					.join("\n");
				if (text) return text;
			}
		}
	}
	return null;
}

async function spawnSubagent(
	cwd: string,
	agent: RunnerAgent,
	modelOverride: string,
	task: string,
	timeoutMs: number,
	maxOutputTailBytes: number,
): Promise<SubagentResult> {
	const started = Date.now();
	let tmpDir: string | null = null;
	try {
		tmpDir = await fsp.mkdtemp(join(tmpdir(), "graphify-semantic-"));
		const args = ["--mode", "json", "-p", "--no-session", "--model", modelOverride];
		const prompt = agent.systemPrompt?.trim();
		if (agent.tools?.trim()) args.push("--tools", agent.tools.trim());
		if (prompt) {
			const promptFile = join(tmpDir, "prompt.md");
			await fsp.writeFile(promptFile, prompt, { encoding: "utf8", mode: 0o600 });
			args.push("--append-system-prompt", promptFile);
		}
		args.push(`Task: ${task}`);
		const inv = getPiInvocation(args);
		const outputParts: string[] = [];
		const stderrParts: string[] = [];
		let stdoutBuffer = "";
		let timedOut = false;
		const result = await new Promise<SubagentResult>((resolveResult) => {
			const child = spawn(inv.command, inv.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			let settled = false;
			const timeout = setTimeout(() => {
				timedOut = true;
				child.kill();
			}, timeoutMs);
			const settle = (exitCode: number | null, fallbackOutput?: string) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				const stderr = stderrParts.join("");
				const output = outputParts.join("\n") || fallbackOutput || (timedOut ? `Timed out after ${timeoutMs}ms.` : stderr);
				resolveResult({
					ok: exitCode === 0 && !timedOut,
					exitCode,
					output: tailBytes(output, maxOutputTailBytes),
					durationMs: Date.now() - started,
				});
			};
			const processLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const text = textFromMessageEnd(JSON.parse(line));
					if (text) outputParts.push(text);
				} catch {
					// Ignore non-JSON progress lines; Pi's JSON mode should still emit message_end.
				}
			};
			child.stdout?.on("data", (chunk: Buffer) => {
				stdoutBuffer += chunk.toString("utf8");
				const lines = stdoutBuffer.split(/\r?\n/);
				stdoutBuffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			child.stderr?.on("data", (chunk: Buffer) => stderrParts.push(chunk.toString("utf8")));
			child.on("error", (error) => settle(null, error.message));
			child.on("close", (exitCode) => {
				if (stdoutBuffer) processLine(stdoutBuffer);
				settle(exitCode);
			});
		});
		return result;
	} catch (error) {
		return {
			ok: false,
			exitCode: null,
			output: tailBytes((error as Error).message, maxOutputTailBytes),
			durationMs: Date.now() - started,
		};
	} finally {
		if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}

async function readLockMeta(): Promise<LockMeta | null> {
	try {
		return JSON.parse(await fsp.readFile(paths().lock, "utf8")) as LockMeta;
	} catch {
		return null;
	}
}

function isLockStale(meta: LockMeta, now: number, maxAgeMs: number): boolean {
	const started = Date.parse(meta.startedAt);
	return !Number.isFinite(started) || now - started > maxAgeMs;
}

async function acquireGraphifyLock(runId: string): Promise<LockMeta | null> {
	const config = await readConfig();
	const lockPath = paths().lock;
	const meta: LockMeta = { pid: process.pid, runId, startedAt: new Date().toISOString(), host: hostname() };
	async function tryAcquire(): Promise<LockMeta | null> {
		try {
			const handle = await fsp.open(lockPath, "wx");
			await handle.writeFile(JSON.stringify(meta, null, 2), "utf8");
			await handle.close();
			return meta;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			return null;
		}
	}
	const acquired = await tryAcquire();
	if (acquired) return acquired;
	const existing = await readLockMeta();
	if (existing && isLockStale(existing, Date.now(), lockStaleWindowMs(config))) {
		await fsp.unlink(lockPath).catch(() => {});
		return tryAcquire();
	}
	return null;
}

async function releaseGraphifyLock(runId: string): Promise<void> {
	const meta = await readLockMeta();
	if (meta?.runId === runId) await fsp.unlink(paths().lock).catch(() => {});
}

async function appendRunLog(record: Record<string, unknown>): Promise<void> {
	const config = await readConfig();
	const p = paths();
	await fsp.mkdir(p.dir, { recursive: true });
	await fsp.appendFile(p.runLog, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, "utf8");
	try {
		const lines = (await fsp.readFile(p.runLog, "utf8")).trimEnd().split("\n");
		if (lines.length > config.maxRunLogEntries) {
			await fsp.writeFile(p.runLog, `${lines.slice(-config.maxRunLogEntries).join("\n")}\n`, "utf8");
		}
	} catch {
		// Best-effort logging only.
	}
}

async function copyDirectoryRecursive(src: string, dest: string): Promise<number> {
	let copied = 0;
	await fsp.mkdir(dest, { recursive: true });
	const entries = await fsp.readdir(src, { withFileTypes: true });
	for (const entry of entries) {
		const from = join(src, entry.name);
		const to = join(dest, entry.name);
		try {
			if (entry.isDirectory()) {
				copied += await copyDirectoryRecursive(from, to);
			} else if (entry.isFile()) {
				await fsp.copyFile(from, to);
				copied += 1;
			}
		} catch {
			// Keep brain sync best-effort and continue copying remaining artifacts.
		}
	}
	return copied;
}

async function syncBrainAfterSemantic(cwd: string): Promise<boolean> {
	const outDir = join(cwd, "graphify-out");
	const reportPath = join(outDir, "GRAPH_REPORT.md");
	if (!existsSync(reportPath)) return false;
	const destBase = join(homedir(), ".pi", "graphify-brain", slugify(basename(cwd)));
	await fsp.mkdir(destBase, { recursive: true });
	let reportCopied = false;
	for (const artifact of ["GRAPH_REPORT.md", "graph.json"]) {
		const src = join(outDir, artifact);
		if (!existsSync(src)) continue;
		try {
			await fsp.copyFile(src, join(destBase, artifact));
			if (artifact === "GRAPH_REPORT.md") reportCopied = true;
		} catch {
			// Best-effort artifact copy.
		}
	}
	try {
		const entries = await fsp.readdir(outDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() || !/graphrag.*\.json$/i.test(entry.name)) continue;
			await fsp.copyFile(join(outDir, entry.name), join(destBase, entry.name)).catch(() => {});
		}
	} catch {
		// Best-effort GraphRAG artifact discovery.
	}
	const wikiSrc = join(outDir, "wiki");
	if (existsSync(wikiSrc)) {
		await copyDirectoryRecursive(wikiSrc, join(destBase, "wiki")).catch(() => 0);
	}
	return reportCopied;
}

async function runSemanticGraphify(cwd: string, reason: string, opts?: { force?: boolean }): Promise<SemanticGraphifyResult> {
	void opts;
	const runId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
	const started = Date.now();
	if (runInProgress) {
		return { ok: true, runId, durationMs: 0, semantic: null, verifier: null, brainSyncOk: null, skippedReason: "already-running" };
	}
	const config = await readConfig();
	const agent = await loadRunnerAgent(config);
	if (!agent) {
		return { ok: false, runId, durationMs: Date.now() - started, semantic: null, verifier: null, brainSyncOk: null, skippedReason: "no-runner" };
	}
	const lock = await acquireGraphifyLock(runId);
	if (!lock) {
		return { ok: true, runId, durationMs: 0, semantic: null, verifier: null, brainSyncOk: null, skippedReason: "already-running" };
	}
	runInProgress = true;
	let semantic: SubagentResult | null = null;
	let verifier: { ok: boolean; verdict: string } | null = null;
	let brainSyncOk: boolean | null = null;
	try {
		await updateState((state) => {
			state.semanticRunStatus = "running";
			state.semanticActiveRunId = runId;
			state.semanticActiveRunStartedAt = new Date(started).toISOString();
			state.semanticScheduledFor = null;
		});
		await appendRunLog({
			event: "semantic-start",
			runId,
			cwd,
			reason,
			mode: "semantic",
			model: config.models.semantic.model,
			subagent: agent.name,
		});
		const state = await readState();
		const changedFiles = (state.docChangedFiles.length ? state.docChangedFiles : state.changedFiles).slice(-50);
		const task = [
			`Run semantic graphify maintenance for ${cwd}.`,
			`Changed files: ${changedFiles.length ? changedFiles.join(", ") : "none"}`,
			`Reason: ${reason}`,
			"Instructions: Run `graphify` for semantic extraction, community labeling, and wiki generation against this project's graphify-out/ output directory. Prefer incremental updates. Report artifacts produced, commands run, and any errors. Do NOT touch graphify-autonomy/ runtime files.",
		].join("\n");
		semantic = await spawnSubagent(
			cwd,
			agent,
			modelOverrideFor(config.models.semantic),
			task,
			config.semanticTimeoutMs,
			config.maxOutputTailBytes,
		);
		if (config.autoVerifierEnabled && semantic.ok) {
			const verifyTask = [
				`Verify the graphify semantic output at ${join(cwd, "graphify-out")}.`,
				"Expected artifacts: wiki/*.md, updated GRAPH_REPORT.md, community labels.",
				"Check for: parseable JSON/HTML, coherent community names, graph consistency.",
				"Return exactly PASS or FAIL on the first line, with brief evidence after.",
			].join("\n");
			const verifierResult = await spawnSubagent(
				cwd,
				agent,
				modelOverrideFor(config.models.verifier),
				verifyTask,
				config.verifierTimeoutMs,
				config.maxOutputTailBytes,
			);
			const firstLine = verifierResult.output.trim().split(/\r?\n/)[0] ?? "";
			const verdict = /\bPASS\b/i.test(firstLine) && !/\bFAIL\b/i.test(firstLine) ? "PASS" : "FAIL";
			verifier = { ok: verdict === "PASS", verdict };
		}
		const ok = semantic.ok && (!config.verifierGates || verifier?.ok !== false);
		if (ok && config.brainSyncAfterRun) brainSyncOk = await syncBrainAfterSemantic(cwd).catch(() => false);
		const durationMs = Date.now() - started;
		await appendRunLog({
			event: "semantic-end",
			runId,
			ok,
			exitCode: semantic.exitCode,
			durationMs,
			verifier: verifier?.verdict ?? null,
			brainSyncOk,
		});
		return { ok, runId, durationMs, semantic, verifier, brainSyncOk };
	} catch (error) {
		const durationMs = Date.now() - started;
		semantic = semantic ?? {
			ok: false,
			exitCode: null,
			output: tailBytes((error as Error).message, config.maxOutputTailBytes),
			durationMs,
		};
		await appendRunLog({ event: "semantic-end", runId, ok: false, exitCode: semantic.exitCode, durationMs, error: semantic.output }).catch(() => {});
		return { ok: false, runId, durationMs, semantic, verifier, brainSyncOk };
	} finally {
		runInProgress = false;
		await releaseGraphifyLock(runId);
	}
}

async function runCodeOnlyGraphify(cwd: string, reason: string, opts?: { force?: boolean }): Promise<RunResult> {
	const config = await readConfig();
	const runId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
	const started = Date.now();
	if (runInProgress) {
		return { ok: true, exitCode: null, durationMs: 0, stdoutTail: "", stderrTail: "already running/locked", runId, skippedReason: "already-running" };
	}
	const lock = await acquireGraphifyLock(runId);
	if (!lock) {
		return { ok: true, exitCode: null, durationMs: 0, stdoutTail: "", stderrTail: "already running/locked", runId, skippedReason: "already-running" };
	}
	runInProgress = true;
	await updateState((state) => {
		state.runStatus = "running";
		state.activeRunId = runId;
		state.activeRunStartedAt = new Date(started).toISOString();
		state.scheduledFor = null;
	});
	await appendRunLog({ event: "start", runId, cwd, reason, mode: "code-only" });
	try {
		const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolveRun) => {
			const child = execFile("graphify", ["update", "."], { cwd, timeout: config.runTimeoutMs, windowsHide: true }, (error, stdout, stderr) => {
				const exitCode = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
					? ((error as NodeJS.ErrnoException & { code: number }).code)
					: error
						? null
						: 0;
				resolveRun({ stdout: String(stdout ?? ""), stderr: String(stderr || error?.message || ""), exitCode });
			});
			child.on("error", (error) => resolveRun({ stdout: "", stderr: error.message, exitCode: null }));
		});
		const durationMs = Date.now() - started;
		const finalResult: RunResult = {
			ok: result.exitCode === 0,
			exitCode: result.exitCode,
			durationMs,
			stdoutTail: tailBytes(result.stdout, config.maxOutputTailBytes),
			stderrTail: tailBytes(result.stderr, config.maxOutputTailBytes),
			runId,
		};
		await appendRunLog({ event: "end", runId, ok: finalResult.ok, exitCode: finalResult.exitCode, durationMs });
		return finalResult;
	} finally {
		runInProgress = false;
		await releaseGraphifyLock(runId);
	}
}

async function hasActiveRunLock(): Promise<boolean> {
	if (runInProgress) return true;
	const [config, meta] = await Promise.all([readConfig(), readLockMeta()]);
	return Boolean(meta && !isLockStale(meta, Date.now(), lockStaleWindowMs(config)));
}

async function finalizeRun(result: RunResult, reason: string, cwd = lastKnownCwd ?? process.cwd()): Promise<void> {
	if (result.skippedReason === "already-running") {
		await appendRunLog({ event: "skip", runId: result.runId, reason, skippedReason: result.skippedReason });
		await updateState((state) => {
			if (state.runStatus !== "running") {
				state.activeRunId = null;
				state.activeRunStartedAt = null;
				state.scheduledFor = null;
				state.runStatus = "idle";
			}
		});
		return;
	}
	const config = await readConfig();
	const now = Date.now();
	await updateState((state) => {
		state.activeRunId = null;
		state.activeRunStartedAt = null;
		state.scheduledFor = null;
		state.lastRunExitCode = result.exitCode;
		state.lastRunDurationMs = result.durationMs;
		state.lastRunStdoutTail = result.stdoutTail;
		state.lastRunStderrTail = result.stderrTail;
		if (result.ok) {
			state.lastRunAt = new Date(now).toISOString();
			state.lastRunReason = reason;
			state.lastRunMode = "code-only";
			state.cooldownUntil = new Date(now + config.cooldownMinutes * 60_000).toISOString();
			state.runStatus = "idle";
			state.pendingReason = null;
			state.pendingSince = null;
			state.significantChangeCount = 0;
			state.changedFiles = [];
			state.failureCount = 0;
			state.lastFailureReason = null;
		} else {
			state.runStatus = "failed";
			state.failureCount += 1;
			state.lastFailureReason = result.stderrTail || `graphify exited with ${result.exitCode}`;
		}
	});
	graphifyMaintenanceEmitter?.({ cwd, ok: result.ok, mode: "code-only", reason, runId: result.runId });
}

async function finalizeSemanticRun(result: SemanticGraphifyResult, reason: string, cwd = lastKnownCwd ?? process.cwd()): Promise<void> {
	if (result.skippedReason) {
		await appendRunLog({ event: "semantic-skip", runId: result.runId, reason, skippedReason: result.skippedReason });
		await updateState((state) => {
			if (state.semanticRunStatus !== "running") {
				state.semanticActiveRunId = null;
				state.semanticActiveRunStartedAt = null;
				state.semanticScheduledFor = null;
				state.semanticRunStatus = "idle";
			}
		});
		return;
	}
	const config = await readConfig();
	const now = Date.now();
	await updateState((state) => {
		state.semanticActiveRunId = null;
		state.semanticActiveRunStartedAt = null;
		state.semanticScheduledFor = null;
		state.lastSemanticModel = config.models.semantic.model;
		state.lastSemanticSubagent = config.runner.subagent;
		state.lastSemanticExitCode = result.semantic?.exitCode ?? null;
		state.lastSemanticDurationMs = result.durationMs;
		state.lastSemanticOutputTail = result.semantic?.output ?? null;
		state.lastVerifierOk = result.verifier?.ok ?? null;
		state.lastVerifierVerdict = result.verifier?.verdict ?? null;
		state.lastBrainSyncOk = result.brainSyncOk;
		if (result.ok) {
			state.lastSemanticRunAt = new Date(now).toISOString();
			state.lastSemanticRunReason = reason;
			state.lastSemanticOk = true;
			state.cooldownUntil = new Date(now + config.cooldownMinutes * 60_000).toISOString();
			state.semanticRunStatus = "idle";
			state.semanticPendingReason = null;
			state.semanticPendingSince = null;
			state.docChangeCount = 0;
			state.docChangedFiles = [];
			state.semanticFailureCount = 0;
			state.lastSemanticFailureReason = null;
		} else {
			state.semanticRunStatus = "failed";
			state.lastSemanticOk = false;
			state.semanticFailureCount += 1;
			state.lastSemanticFailureReason = result.semantic?.output?.slice(-500) || "semantic subagent failed";
		}
	});
	graphifyMaintenanceEmitter?.({ cwd, ok: result.ok, mode: "semantic", reason, runId: result.runId });
}

function clearDebounce(): void {
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = undefined;
	if (semanticDebounceTimer) clearTimeout(semanticDebounceTimer);
	semanticDebounceTimer = undefined;
}

function clearSemanticDebounce(): void {
	if (semanticDebounceTimer) clearTimeout(semanticDebounceTimer);
	semanticDebounceTimer = undefined;
}

function armDebounce(cwd: string, reason: string, delayMs: number): void {
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => {
		void (async () => {
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = undefined;
			const [config, state] = await Promise.all([readConfig(), readState()]);
			const gate = shouldAutoRunCodeOnly(config, state, classifyChangedFiles(state.changedFiles, config), Date.now(), { allowDebouncing: true });
			if (!gate.run) {
				await updateState((next) => {
					if (next.runStatus === "debouncing") next.runStatus = "idle";
					next.scheduledFor = null;
				});
				return;
			}
			const result = await runCodeOnlyGraphify(cwd, reason);
			await finalizeRun(result, reason, cwd);
		})();
	}, delayMs);
}

function armSemanticDebounce(cwd: string, reason: string, delayMs: number): void {
	clearSemanticDebounce();
	semanticDebounceTimer = setTimeout(() => {
		void (async () => {
			clearSemanticDebounce();
			const [config, state] = await Promise.all([readConfig(), readState()]);
			if (runInProgress || state.runStatus === "running" || state.semanticRunStatus === "running" || await hasActiveRunLock()) {
				const retryDelayMs = Math.min(30000, config.semanticDebounceSeconds * 1000);
				const retryFor = new Date(Date.now() + retryDelayMs).toISOString();
				await updateState((next) => {
					if (next.semanticRunStatus !== "running") next.semanticRunStatus = "debouncing";
					next.semanticScheduledFor = retryFor;
				});
				armSemanticDebounce(cwd, reason, retryDelayMs);
				return;
			}
			const gate = shouldAutoRunSemantic(config, state, Date.now(), { allowDebouncing: true });
			if (!gate.run) {
				await updateState((next) => {
					if (next.semanticRunStatus === "debouncing") next.semanticRunStatus = "idle";
					next.semanticScheduledFor = null;
				});
				return;
			}
			const result = await runSemanticGraphify(cwd, reason);
			await finalizeSemanticRun(result, reason, cwd);
		})();
	}, delayMs);
}

async function maybeScheduleAfterAgentEnd(cwd: string): Promise<void> {
	await maybeMarkPendingAfterAgentEnd();
	const [config, state] = await Promise.all([readConfig(), readState()]);
	const classification = classifyChangedFiles(state.changedFiles, config);
	const gate = shouldAutoRunCodeOnly(config, state, classification, Date.now());
	let codeOnlyArmed = false;
	if (gate.run) {
		const scheduledFor = new Date(Date.now() + config.debounceSeconds * 1000).toISOString();
		const reason = state.pendingReason ?? `${state.significantChangeCount} code-only change(s) detected.`;
		await updateState((next) => {
			next.pendingReason = reason;
			next.pendingSince = next.pendingSince ?? new Date().toISOString();
			next.runStatus = "debouncing";
			next.scheduledFor = scheduledFor;
		});
		armDebounce(cwd, reason, config.debounceSeconds * 1000);
		codeOnlyArmed = true;
	}

	const [cfg2, st2] = await Promise.all([readConfig(), readState()]);
	const semanticFiles = st2.docChangedFiles.length > 0 ? st2.docChangedFiles : st2.changedFiles;
	if (classifyChangedFiles(semanticFiles, cfg2) !== "docsOrMixed" || countDocWorthyFiles(semanticFiles, cfg2) === 0) return;
	const codeDebounceArmed = codeOnlyArmed || st2.runStatus === "debouncing";
	const semanticGateState = codeDebounceArmed
		? { ...st2, runStatus: "idle" as const }
		: st2;
	const semGate = shouldAutoRunSemantic(cfg2, semanticGateState, Date.now());
	if (!semGate.run) return;
	const baseDelayMs = cfg2.semanticDebounceSeconds * 1000;
	const delayMs = codeDebounceArmed ? baseDelayMs + 60000 : baseDelayMs;
	const semScheduledFor = new Date(Date.now() + delayMs).toISOString();
	const semReason = st2.semanticPendingReason ?? semGate.reason;
	await updateState((next) => {
		next.semanticPendingReason = semReason;
		next.semanticPendingSince = next.semanticPendingSince ?? new Date().toISOString();
		next.semanticRunStatus = "debouncing";
		next.semanticScheduledFor = semScheduledFor;
	});
	armSemanticDebounce(cwd, semReason, delayMs);
}

function computeFreshness(cwd: string): Freshness {
	const reportPath = join(cwd, "graphify-out", "GRAPH_REPORT.md");
	if (!existsSync(reportPath)) return { status: "no-graph", reason: "No graphify-out/GRAPH_REPORT.md found." };
	let reportCommit: string | undefined;
	try {
		const report = readFileSync(reportPath, "utf8");
		reportCommit = report.match(/Built from commit:\s*`?([a-f0-9]+)`?/i)?.[1];
	} catch (e) {
		return { status: "unknown", reason: `Could not read GRAPH_REPORT.md: ${(e as Error).message}` };
	}
	if (!reportCommit) return { status: "unknown", reason: "GRAPH_REPORT.md has no Built from commit marker." };
	try {
		const headCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
		const fresh = headCommit.startsWith(reportCommit) || reportCommit.startsWith(headCommit);
		return {
			status: fresh ? "fresh" : "stale",
			reportCommit,
			headCommit,
			reason: fresh ? "Graph commit matches current HEAD." : "Graph commit differs from current HEAD.",
		};
	} catch {
		return { status: "unknown", reportCommit, reason: "Not a git checkout or git is unavailable." };
	}
}

async function statusText(cwd: string): Promise<string> {
	const [config, state] = await Promise.all([readConfig(), readState()]);
	const freshness = computeFreshness(cwd);
	const lines = [
		"Autonomous Graphify status",
		`enabled: ${config.enabled}`,
		`paused: ${config.paused}`,
		`gateMode: ${config.gateMode}`,
		`freshness: ${freshness.status}${freshness.reason ? ` — ${freshness.reason}` : ""}`,
		`semantic model: ${config.models.semantic.provider}/${config.models.semantic.model}`,
		`verifier model: ${config.models.verifier.provider}/${config.models.verifier.model}`,
		`pending: ${state.pendingReason ?? "none"}`,
		`runStatus: ${state.runStatus}`,
		`scheduledFor: ${state.scheduledFor ?? "none"}`,
		`semanticRunStatus: ${state.semanticRunStatus}`,
		`semanticScheduledFor: ${state.semanticScheduledFor ?? "none"}`,
		`semanticPending: ${state.semanticPendingReason ?? "none"}`,
		`cooldownUntil: ${state.cooldownUntil ?? "none"}`,
		`activeRunId: ${state.activeRunId ?? "none"}`,
		`semanticActiveRunId: ${state.semanticActiveRunId ?? "none"}`,
		`changes: ${state.significantChangeCount} significant${state.lastMutationAt ? `, last ${state.lastMutationAt}` : ""}`,
		`docChangeCount: ${state.docChangeCount}${state.docChangedFiles.length ? `, files ${state.docChangedFiles.slice(-5).join(", ")}` : ""}`,
		`lastRun: ${state.lastRunAt ?? "never"}`,
		`lastRunExitCode: ${state.lastRunExitCode ?? "none"}`,
		`lastRunDurationMs: ${state.lastRunDurationMs ?? "none"}`,
		`lastSemanticRunAt: ${state.lastSemanticRunAt ?? "never"}`,
		`lastSemanticModel: ${state.lastSemanticModel ?? "none"}`,
		`lastSemanticSubagent: ${state.lastSemanticSubagent ?? "none"}`,
		`lastSemanticOk: ${state.lastSemanticOk ?? "n/a"}`,
		`lastVerifierOk: ${state.lastVerifierOk ?? "n/a"}`,
		`lastVerifierVerdict: ${state.lastVerifierVerdict ?? "n/a"}`,
		`lastBrainSyncOk: ${state.lastBrainSyncOk ?? "n/a"}`,
		`semanticFailureCount: ${state.semanticFailureCount}`,
		`lastFailure: ${state.lastFailureReason ?? "none"}`,
		`lastSemanticFailure: ${state.lastSemanticFailureReason ?? "none"}`,
	];
	if (freshness.reportCommit || freshness.headCommit) {
		lines.push(`reportCommit: ${freshness.reportCommit ?? "unknown"}`);
		lines.push(`headCommit: ${freshness.headCommit ?? "unknown"}`);
	}
	if (state.lastRunStdoutTail) lines.push(`lastStdoutTail: ${state.lastRunStdoutTail.slice(-500)}`);
	if (state.lastRunStderrTail) lines.push(`lastStderrTail: ${state.lastRunStderrTail.slice(-500)}`);
	if (state.changedFiles.length > 0) {
		lines.push(`changedFiles: ${state.changedFiles.slice(-10).join(", ")}`);
	}
	return lines.join("\n");
}

function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(text, level);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function autonomousGraphify(pi: ExtensionAPI): void {
	graphifyMaintenanceEmitter = (event) => pi.events.emit("graphify:maintenance-complete", event);
	pi.on("session_start", async (_event, ctx) => {
		await ensureRuntimeFiles();
		lastKnownCwd = ctx.cwd;
		const [config, state, lock] = await Promise.all([readConfig(), readState(), readLockMeta()]);
		const lockIsMissingOrStale = !lock || isLockStale(lock, Date.now(), lockStaleWindowMs(config));
		if (state.runStatus === "running" && lockIsMissingOrStale) {
			await updateState((next) => {
				next.runStatus = "idle";
				next.activeRunId = null;
				next.activeRunStartedAt = null;
			});
		}
		if (state.semanticRunStatus === "running" && lockIsMissingOrStale) {
			await updateState((next) => {
				next.semanticRunStatus = "idle";
				next.semanticActiveRunId = null;
				next.semanticActiveRunStartedAt = null;
			});
		}
		if (state.runStatus === "debouncing" && state.scheduledFor) {
			const delayMs = Math.max(0, Date.parse(state.scheduledFor) - Date.now());
			armDebounce(ctx.cwd, state.pendingReason ?? "Re-armed pending code-only graphify update.", delayMs);
		}
		if (state.semanticRunStatus === "debouncing" && state.semanticScheduledFor) {
			const delayMs = Math.max(0, Date.parse(state.semanticScheduledFor) - Date.now());
			armSemanticDebounce(ctx.cwd, state.semanticPendingReason ?? "Re-armed pending semantic graphify run.", delayMs);
		}
		notify(ctx, "Autonomous Graphify loaded (Phase 3 semantic runs enabled).", "info");
	});

	pi.on("session_shutdown", async () => {
		clearDebounce();
		graphifyMaintenanceEmitter = undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		lastKnownCwd = ctx.cwd;
		if ((event as unknown as { isError?: boolean }).isError) return;
		const toolName = (event as unknown as { toolName?: string }).toolName;
		const input = ((event as unknown as { input?: Record<string, unknown> }).input ?? {}) as Record<string, unknown>;
		if (toolName === "write" || toolName === "edit") {
			const changedPath = pathFromToolInput(input);
			if (changedPath) await recordMutation(ctx, changedPath);
			return;
		}
		if (toolName === "bash") {
			const command = typeof input.command === "string" ? input.command : "";
			if (isMutatingBash(command)) {
				const preview = command.length > 80 ? `${command.slice(0, 80)}…` : command;
				await recordMutation(ctx, `bash:${preview}`);
			}
		}
	});

	pi.on("agent_end", async () => {
		await maybeScheduleAfterAgentEnd(lastKnownCwd ?? process.cwd());
	});

	pi.on("before_agent_start", async (event) => {
		const cwd = event.systemPromptOptions?.cwd ?? process.cwd();
		const [config, state] = await Promise.all([readConfig(), readState()]);
		if (!config.enabled) return;
		const freshness = computeFreshness(cwd);
		const shouldInject = state.pendingReason || state.semanticPendingReason || state.semanticRunStatus === "debouncing" || freshness.status === "stale";
		if (!shouldInject) return;
		const advisory = [
			"\n\n## Autonomous Graphify Advisory",
			`Graphify gate mode is \`${config.gateMode}\` (default workflow is advisory, not blocking).`,
			`Run status: ${state.runStatus}${state.scheduledFor ? `, scheduled for ${state.scheduledFor}` : ""}`,
			state.semanticRunStatus !== "idle" || state.semanticScheduledFor
				? `Semantic run status: ${state.semanticRunStatus}${state.semanticScheduledFor ? `, scheduled for ${state.semanticScheduledFor}` : ""}`
				: undefined,
			state.cooldownUntil ? `Cooldown until: ${state.cooldownUntil}` : undefined,
			state.pendingReason ? `Pending graphify maintenance: ${state.pendingReason}` : undefined,
			state.semanticPendingReason ? `Pending semantic graphify maintenance: ${state.semanticPendingReason}` : undefined,
			freshness.status === "stale" ? `Graph appears stale: ${freshness.reason}` : undefined,
			state.lastRunAt ? `Last code-only graphify run: ${state.lastRunAt}` : undefined,
			state.lastSemanticRunAt ? `Last semantic graphify run: ${state.lastSemanticRunAt}${state.lastVerifierVerdict ? `, verifier ${state.lastVerifierVerdict}` : ""}` : undefined,
			state.lastFailureReason ? `Last autonomous graphify failure: ${state.lastFailureReason}` : undefined,
			state.lastSemanticFailureReason ? `Last semantic graphify failure: ${state.lastSemanticFailureReason}` : undefined,
			"Do not run expensive full graphify inline during latency-sensitive work unless explicitly asked.",
			"If this turn makes meaningful project changes, use graphify_auto mark_needed or leave the pending maintenance marker in place.",
		].filter(Boolean).join("\n");
		return { systemPrompt: event.systemPrompt + advisory };
	});

	pi.registerTool({
		name: "graphify_auto",
		label: "Autonomous Graphify",
		description:
			"Control autonomous Graphify upkeep. Actions: status, mark_needed, pause, resume, run_now, schedule. " +
			"Supports code-only, LLM-free `graphify update .` maintenance and Phase 3 semantic subagent runs with optional verifier/brain sync.",
		promptSnippet: "Inspect, schedule, or run code-only/semantic autonomous Graphify maintenance",
		promptGuidelines: [
			"Use graphify_auto status before deciding whether a graphify update is already pending.",
			"Use graphify_auto mark_needed after meaningful project file changes when graph artifacts should be refreshed later.",
			"Use graphify_auto run_now with mode code-only for an immediate LLM-free `graphify update .` run.",
			"Use graphify_auto run_now with mode semantic for a Phase 3 semantic subagent run (DeepSeek V4 Flash worker, optional V4 Pro verifier, best-effort brain sync).",
			"Use graphify_auto schedule with mode semantic to debounce semantic maintenance after documentation or mixed content changes.",
		],
		parameters: GraphifyAutoParams,
		async execute(_toolCallId, params: GraphifyAutoParamsType, _signal, _onUpdate, ctx) {
			if (params.action === "status") {
				return { content: [{ type: "text" as const, text: await statusText(ctx.cwd) }] };
			}
			if (params.action === "mark_needed") {
				const reason = params.reason?.trim() || "Agent marked graphify maintenance needed.";
				await updateState((state) => {
					state.pendingReason = reason;
					state.pendingSince = new Date().toISOString();
				});
				return { content: [{ type: "text" as const, text: `Marked graphify maintenance needed: ${reason}` }] };
			}
			if (params.action === "pause") {
				await updateConfig((config) => {
					config.paused = true;
				});
				return { content: [{ type: "text" as const, text: `Autonomous Graphify paused${params.reason ? `: ${params.reason}` : "."}` }] };
			}
			if (params.action === "resume") {
				await updateConfig((config) => {
					config.paused = false;
				});
				return { content: [{ type: "text" as const, text: "Autonomous Graphify resumed." }] };
			}
			if (params.action === "schedule") {
				const config = await readConfig();
				const reason = params.reason?.trim() || "Scheduled via graphify_auto tool.";
				if (params.mode === "semantic") {
					const delayMs = config.semanticDebounceSeconds * 1000;
					const scheduledFor = new Date(Date.now() + delayMs).toISOString();
					await updateState((state) => {
						state.semanticPendingReason = reason;
						state.semanticPendingSince = state.semanticPendingSince ?? new Date().toISOString();
						state.semanticRunStatus = "debouncing";
						state.semanticScheduledFor = scheduledFor;
					});
					armSemanticDebounce(ctx.cwd, reason, delayMs);
					return { content: [{ type: "text" as const, text: `Scheduled semantic graphify subagent run for ${scheduledFor}.` }] };
				}
				const scheduledFor = new Date(Date.now() + config.debounceSeconds * 1000).toISOString();
				await updateState((state) => {
					state.pendingReason = reason;
					state.pendingSince = state.pendingSince ?? new Date().toISOString();
					state.runStatus = "debouncing";
					state.scheduledFor = scheduledFor;
				});
				armDebounce(ctx.cwd, reason, config.debounceSeconds * 1000);
				return { content: [{ type: "text" as const, text: `Scheduled code-only graphify update for ${scheduledFor}.` }] };
			}
			const config = await readConfig();
			if ((!config.enabled || config.paused) && !params.force) {
				return { content: [{ type: "text" as const, text: "Autonomous Graphify is disabled or paused; pass force to override." }] };
			}
			if (await hasActiveRunLock()) {
				const lockedText = params.mode === "semantic"
					? "A graphify run is already running/locked."
					: "A code-only graphify update is already running/locked.";
				return { content: [{ type: "text" as const, text: lockedText }] };
			}
			const reason = params.reason?.trim() || "Run requested via graphify_auto tool.";
			if (params.mode === "semantic") {
				void runSemanticGraphify(ctx.cwd, reason, { force: params.force }).then((result) => finalizeSemanticRun(result, reason, ctx.cwd));
				return { content: [{ type: "text" as const, text: "Started semantic graphify subagent run." }] };
			}
			void runCodeOnlyGraphify(ctx.cwd, reason, { force: params.force }).then((result) => finalizeRun(result, reason, ctx.cwd));
			return { content: [{ type: "text" as const, text: "Started code-only `graphify update .` run." }] };
		},
	});

	pi.registerCommand("graphify-auto", {
		description: "Autonomous Graphify controls: status, pause, resume, enable, disable, mark-needed, gate, config, run-now.",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const cmd = parts[0] ?? "status";
			if (cmd === "status") {
				ctx.ui.notify(await statusText(ctx.cwd), "info");
				return;
			}
			if (cmd === "pause") {
				await updateConfig((config) => {
					config.paused = true;
				});
				ctx.ui.notify(`Autonomous Graphify paused${parts.slice(1).length ? `: ${parts.slice(1).join(" ")}` : "."}`, "info");
				return;
			}
			if (cmd === "resume") {
				await updateConfig((config) => {
					config.paused = false;
				});
				ctx.ui.notify("Autonomous Graphify resumed.", "info");
				return;
			}
			if (cmd === "enable" || cmd === "disable") {
				await updateConfig((config) => {
					config.enabled = cmd === "enable";
				});
				ctx.ui.notify(`Autonomous Graphify ${cmd === "enable" ? "enabled" : "disabled"}.`, "info");
				return;
			}
			if (cmd === "mark-needed") {
				const reason = parts.slice(1).join(" ") || "Human/agent marked graphify maintenance needed.";
				await updateState((state) => {
					state.pendingReason = reason;
					state.pendingSince = new Date().toISOString();
				});
				ctx.ui.notify(`Marked graphify maintenance needed: ${reason}`, "info");
				return;
			}
			if (cmd === "gate") {
				const mode = parts[1] as GateMode | undefined;
				if (mode !== "off" && mode !== "soft" && mode !== "strict") {
					ctx.ui.notify("Usage: /graphify-auto gate off|soft|strict", "warning");
					return;
				}
				await updateConfig((config) => {
					config.gateMode = mode;
				});
				ctx.ui.notify(`Graphify gate mode set to ${mode}.`, "info");
				return;
			}
			if (cmd === "config") {
				ctx.ui.notify(JSON.stringify(await readConfig(), null, 2), "info");
				return;
			}
			if (cmd === "run-now") {
				const flags = new Set(parts.slice(1).filter((part) => part.startsWith("--")));
				const usage = "Usage: /graphify-auto run-now (--code-only|--semantic) [--force] [path]";
				if (flags.has("--full")) {
					ctx.ui.notify("Full graphify runs are out of scope for autonomous run-now; use manual /graphify.", "warning");
					return;
				}
				if (flags.has("--code-only") && flags.has("--semantic")) {
					ctx.ui.notify(usage, "warning");
					return;
				}
				if (!flags.has("--code-only") && !flags.has("--semantic")) {
					ctx.ui.notify(usage, "warning");
					return;
				}
				const config = await readConfig();
				if ((!config.enabled || config.paused) && !flags.has("--force")) {
					ctx.ui.notify("Autonomous Graphify is disabled or paused; use --force to override.", "warning");
					return;
				}
				if (await hasActiveRunLock()) {
					ctx.ui.notify(flags.has("--semantic") ? "A graphify run is already running/locked." : "A code-only graphify update is already running/locked.", "warning");
					return;
				}
				const explicitPath = parts.slice(1).find((part) => !part.startsWith("--"));
				const runCwd = resolve(ctx.cwd, explicitPath ?? ".");
				if (flags.has("--semantic")) {
					const reason = "Run requested via /graphify-auto run-now --semantic.";
					void runSemanticGraphify(runCwd, reason, { force: flags.has("--force") }).then((result) => finalizeSemanticRun(result, reason, runCwd));
					ctx.ui.notify(`Started semantic graphify subagent run in ${runCwd}.`, "info");
					return;
				}
				const reason = "Run requested via /graphify-auto run-now --code-only.";
				void runCodeOnlyGraphify(runCwd, reason, { force: flags.has("--force") }).then((result) => finalizeRun(result, reason, runCwd));
				ctx.ui.notify(`Started code-only \`graphify update .\` in ${runCwd}.`, "info");
				return;
			}
			ctx.ui.notify("Usage: /graphify-auto status|pause|resume|enable|disable|mark-needed|gate|config|run-now (--code-only|--semantic) [--force] [path]", "warning");
		},
	});
}

export {
	classifyChangedFiles,
	computeFreshness,
	countDocWorthyFiles,
	isIgnoredPath,
	isLockStale,
	isMutatingBash,
	modelOverrideFor,
	normalizeConfig,
	normalizeState,
	shouldAutoRunCodeOnly,
	shouldAutoRunSemantic,
	slugify,
};
