import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { promises as fsp } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Agent-operated Pi reload bridge — phase-machine + session_shutdown
 * confirmation edition (v3, diagnostics-reporting-fix).
 *
 * Design (see FIX_PLAN.md):
 * - The LLM-callable `agent_reload_runtime` tool schedules a background idle
 *   poll that waits for `ctx.isIdle() && !ctx.hasPendingMessages()` (2 stable
 *   ticks), then invokes `/agent-reload-runtime` via `pi.executeCommand`.
 * - Success is confirmed via the `session_shutdown` event with reason
 *   "reload" (fires in the still-alive OLD instance, correct cwd, before
 *   teardown). NOT session_start (cwd-fragile in the rebuilt instance,
 *   module state reset).
 * - An explicit phase machine guards against double-fire and stuck state.
 * - A verification timer affirms FAILURE only (on success the process is
 *   rebuilt; the timer's purpose collapses). On silent failure, one bounded
 *   autonomous retry is attempted (the agent has stopped; only the timer
 *   can retry).
 * - Diagnostics merge on every write (audit trail across polls/reloads).
 *
 * IMPORTANT: `pi.executeCommand` is not in the public Pi API; it requires the
 * local core patch (agent/core-patch/reapply-pi-core-patch.mjs). Without it,
 * the tool returns a clear error and does not start the poll.
 *
 * The tool never uses `pi.sendUserMessage('/...')`.
 *
 * Diagnostics: ONE canonical location at `~/.pi/agent/agent-reload-diagnostics.json`
 * regardless of session cwd. Atomic writes (temp + rename). Write failures
 * are logged to stderr (never swallowed silently).
 */
const RELOAD_COMMAND = "agent-reload-runtime";
const POLL_INTERVAL_MS = 500;
const MAX_WAIT_MS = 30_000;
const IDLE_TICKS_REQUIRED = 2;
const VERIFICATION_TIMEOUT_MS = 6_000;
const EXECUTE_COMMAND_HARD_TIMEOUT_MS = 25_000;
const RETRY_DELAY_MS = 2_000;
const MAX_RETRIES = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase = "idle" | "polling" | "command-in-flight" | "verifying" | "done" | "failed";

interface ExecuteEntry {
	ts: number;
	phase: Phase;
	requestId?: string;
	executeCommandAvailable: boolean;
	cwd: string;
	coalesced: boolean;
}

interface TickEntry {
	ts: number;
	isIdle: boolean;
	hasPendingMessages: boolean;
	stableIdle: boolean;
	idleTicks: number;
}

interface ReloadDiagnostics {
	requestId?: string;
	phase: Phase;
	scheduled?: number;
	requested?: number;
	idleDetected?: number;
	reloadInvoked?: number;
	executeCommandResolved?: number;
	executeCommandDurationMs?: number;
	executeCommandRejected?: boolean;
	reloadConfirmed?: boolean;
	confirmedAt?: number;
	confirmedBy?: string;
	reloadSilentlyFailed?: boolean;
	retried?: boolean;
	retryCount?: number;
	timeout?: boolean;
	hardTimeout?: boolean;
	error?: string;
	attempts: number;
	cwd: string;
	executeCommandAvailable: boolean;
	lastUpdated?: string;
	executeEntries?: ExecuteEntry[];
	tickLog?: TickEntry[];
}

// ---------------------------------------------------------------------------
// Diagnostics — canonical path, atomic write, success-preserving, stderr-aware
// ---------------------------------------------------------------------------

const USER_HOME = process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
const PI_HOME_DIR = process.env.PI_HOME
	? resolve(process.env.PI_HOME)
	: resolve(USER_HOME, ".pi");
const CANONICAL_DIAG_DIR = resolve(PI_HOME_DIR, "agent");
const CANONICAL_DIAG_PATH = resolve(CANONICAL_DIAG_DIR, "agent-reload-diagnostics.json");

/** Authoritative success signal emitted by session_shutdown handler. */
const RELOAD_CONFIRMATION = "session_shutdown:reload";

/**
 * Write diagnostics to the ONE canonical location with success-preserving
 * merge semantics (backported from agent-new-session v3 lifecycle-race-fix).
 *
 * Rules:
 *  - One canonical path: ~/.pi/agent/agent-reload-diagnostics.json always.
 *  - Atomic write: temp file + rename (survives partial-write during teardown).
 *  - Success-preserving: once reloadConfirmed is observed, phase is locked to
 *    "done" and failure fields are cleared (confirmation dominance).
 *  - Write failures are logged to stderr; never swallowed silently.
 *  - Merge: patch overwrites scalars; arrays append and cap.
 */
async function writeDiagnostics(
	patch: Partial<ReloadDiagnostics> & { attempts?: number; cwd?: string; executeCommandAvailable?: boolean },
	_cwd: string, // kept for caller compatibility; IGNORED — always uses canonical path
): Promise<void> {
	try {
		await fsp.mkdir(CANONICAL_DIAG_DIR, { recursive: true });

		// 1. Read existing file; recover confirmation from raw text if malformed.
		let raw: string | undefined;
		let existing: ReloadDiagnostics;
		let recoveredConfirmation = false;

		try {
			raw = await fsp.readFile(CANONICAL_DIAG_PATH, "utf8");
			existing = JSON.parse(raw as string);
		} catch {
			if (raw !== undefined) {
				// JSON parse failed — check raw text for confirmation evidence.
				if (raw.includes('"reloadConfirmed"') && raw.includes('true') &&
				    raw.includes('"confirmedBy"') && raw.includes(`"${RELOAD_CONFIRMATION}"`)) {
					recoveredConfirmation = true;
				}
			}
			existing = {
				phase: "idle",
				attempts: 0,
				cwd: _cwd,
				executeCommandAvailable: false,
			};
		}

		// 2. Merge: patch overwrites scalars; arrays append and cap.
		const merged: ReloadDiagnostics = { ...existing, ...patch };

		if (patch.executeEntries && existing.executeEntries) {
			merged.executeEntries = [...existing.executeEntries, ...patch.executeEntries].slice(-20);
		} else if (existing.executeEntries && !patch.executeEntries) {
			merged.executeEntries = existing.executeEntries;
		}
		if (patch.tickLog && existing.tickLog) {
			merged.tickLog = [...existing.tickLog, ...patch.tickLog].slice(-80);
		} else if (existing.tickLog && !patch.tickLog) {
			merged.tickLog = existing.tickLog;
		}

		// 3. Success-preserving: if confirmation was ever observed, force canonical success.
		const confirmationObserved =
			recoveredConfirmation ||
			merged.reloadConfirmed === true ||
			merged.confirmedBy === RELOAD_CONFIRMATION;

		merged.lastUpdated = new Date().toISOString();

		if (confirmationObserved) {
			merged.phase = "done";
			merged.reloadConfirmed = true;
			merged.confirmedBy = RELOAD_CONFIRMATION;
			merged.reloadSilentlyFailed = false;
			merged.executeCommandRejected = false;
			delete merged.hardTimeout;
			delete merged.timeout;
			delete merged.error;
		}

		// 4. Atomic write: temp file + rename.
		const tmpPath = resolve(CANONICAL_DIAG_DIR, `.agent-reload-diagnostics.tmp-${randomUUID().slice(0, 8)}`);
		await fsp.writeFile(tmpPath, JSON.stringify(merged, null, 2), "utf8");
		await fsp.rename(tmpPath, CANONICAL_DIAG_PATH);
	} catch (err) {
		/* diagnostics must never throw, but MUST log to stderr */
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[agent-reload] writeDiagnostics FAILED: ${msg}\n`);
	}
}

// ---------------------------------------------------------------------------
// Phase-machine state (module-scoped; reset on in-process reload via jiti)
// ---------------------------------------------------------------------------

let phase: Phase = "idle";
let pollInterval: ReturnType<typeof setInterval> | undefined;
let hardTimer: ReturnType<typeof setTimeout> | undefined;
let verifyTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let activeRequestId: string | undefined;
let reloadConfirmed = false;
let retryCount = 0;
let executeCommandAvailable = false;
let lastKnownCwd: string | undefined;

function clearAllTimers(): void {
	if (pollInterval) { clearInterval(pollInterval); pollInterval = undefined; }
	if (hardTimer) { clearTimeout(hardTimer); hardTimer = undefined; }
	if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = undefined; }
	if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
}

/**
 * Reset state to idle. Does NOT clear reloadConfirmed — that flag survives
 * for the success-preserving writer in session_shutdown and any late write.
 * Only clear it when starting a new request cycle (scheduleIdleReload).
 */
function resetToIdle(cwd: string): void {
	clearAllTimers();
	phase = "idle";
	activeRequestId = undefined;
	// NOTE: reloadConfirmed is NOT cleared here. See above.
}

// ---------------------------------------------------------------------------
// Idle poll + executeCommand dispatch
// ---------------------------------------------------------------------------

function scheduleIdleReload(pi: ExtensionAPI, ctx: ExtensionContext): void {
	// Only schedule from a terminal phase.
	if (phase !== "idle" && phase !== "done" && phase !== "failed") {
		// Should not reach here (execute() guards), but be safe.
		void writeDiagnostics({
			phase,
			error: `scheduleIdleReload called from non-terminal phase ${phase}; coalesced`,
			cwd: ctx.cwd,
		}, ctx.cwd);
		return;
	}

	phase = "polling";
	reloadConfirmed = false;
	activeRequestId = `reload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

	const startedAt = Date.now();
	const cwd = ctx.cwd;
	let idleTicks = 0;
	let attempts = 0;

	void writeDiagnostics({
		requestId: activeRequestId,
		phase: "polling",
		scheduled: startedAt,
		requested: startedAt,
		attempts: 0,
		cwd,
		executeCommandAvailable,
	}, cwd);

	pollInterval = setInterval(() => {
		attempts++;

		// --- max-wait timeout ---
		if (Date.now() - startedAt > MAX_WAIT_MS) {
			void writeDiagnostics({
				requestId: activeRequestId,
				phase: "failed",
				attempts,
				timeout: true,
				error: `idle poll timed out after ${MAX_WAIT_MS}ms without ${IDLE_TICKS_REQUIRED} stable idle ticks`,
				cwd,
				executeCommandAvailable,
			}, cwd);
			resetToIdle(cwd);
			return;
		}

		// --- stable idle check: isIdle AND no pending messages ---
		let isIdle = false;
		let hasPending = false;
		try {
			isIdle = ctx.isIdle();
			// hasPendingMessages may not exist on older Pi; treat absence as false.
			hasPending = typeof (ctx as { hasPendingMessages?: () => boolean }).hasPendingMessages === "function"
				? (ctx as { hasPendingMessages: () => boolean }).hasPendingMessages()
				: false;
		} catch (e) {
			void writeDiagnostics({
				requestId: activeRequestId,
				phase: "failed",
				attempts,
				error: `isIdle/hasPendingMessages error: ${(e as Error).message}`,
				cwd,
				executeCommandAvailable,
			}, cwd);
			resetToIdle(cwd);
			return;
		}
		const stableIdle = isIdle && !hasPending;
		if (stableIdle) {
			idleTicks++;
		} else {
			idleTicks = 0;
		}

		// per-tick log (cap applied in writeDiagnostics)
		void writeDiagnostics({
			requestId: activeRequestId,
			phase: "polling",
			attempts,
			tickLog: [{ ts: Date.now(), isIdle, hasPendingMessages: hasPending, stableIdle, idleTicks }],
			cwd,
			executeCommandAvailable,
		}, cwd);

		// --- idle confirmed: fire reload ---
		if (idleTicks >= IDLE_TICKS_REQUIRED) {
			if (pollInterval) { clearInterval(pollInterval); pollInterval = undefined; }
			phase = "command-in-flight";
			void writeDiagnostics({
				requestId: activeRequestId,
				phase: "command-in-flight",
				idleDetected: Date.now(),
				attempts,
				cwd,
				executeCommandAvailable,
			}, cwd);
			fireReload(pi, ctx, cwd, attempts);
		}
	}, POLL_INTERVAL_MS);
}

function fireReload(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cwd: string,
	attempts: number,
): void {
	const requestId = activeRequestId!;

	const executeCommand = (pi as unknown as {
		executeCommand?: (name: string, args?: string) => Promise<void>;
	}).executeCommand;
	if (typeof executeCommand !== "function") {
		phase = "failed";
		void writeDiagnostics({
			requestId,
			phase: "failed",
			attempts,
			error: "executeCommand error: pi.executeCommand is not available at fire time",
			cwd,
			executeCommandAvailable,
		}, cwd);
		resetToIdle(cwd);
		return;
	}

	// Hard timeout: if executeCommand never resolves/rejects, reset state.
	hardTimer = setTimeout(() => {
		void writeDiagnostics({
			requestId,
			phase: "failed",
			attempts,
			hardTimeout: true,
			error: `executeCommand hard timeout after ${EXECUTE_COMMAND_HARD_TIMEOUT_MS}ms`,
			cwd,
			executeCommandAvailable,
		}, cwd);
		// Cannot cancel the underlying promise; reset state so a new call can proceed.
		resetToIdle(cwd);
	}, EXECUTE_COMMAND_HARD_TIMEOUT_MS);

	const cmdStartedAt = Date.now();
	void Promise.resolve(
		Promise.race([
			executeCommand.call(pi, RELOAD_COMMAND),
			new Promise<void>((_, reject) =>
				setTimeout(() => reject(new Error("hard-timeout")), EXECUTE_COMMAND_HARD_TIMEOUT_MS),
			),
		]),
	).then(
		() => {
			// Clear the hard timer (the race resolved first).
			if (hardTimer) { clearTimeout(hardTimer); hardTimer = undefined; }
			const duration = Date.now() - cmdStartedAt;
			void writeDiagnostics({
				requestId,
				phase: reloadConfirmed ? "done" : "verifying",
				attempts,
				reloadInvoked: Date.now(),
				executeCommandResolved: Date.now(),
				executeCommandDurationMs: duration,
				executeCommandRejected: false,
				reloadConfirmed,
				cwd,
				executeCommandAvailable,
			}, cwd);

			if (reloadConfirmed) {
				// session_shutdown already confirmed during executeCommand.
				phase = "done";
				retryCount = 0;
				return;
			}
			// executeCommand resolved but session_shutdown did NOT fire →
			// handleReloadCommand likely silently no-op'd. Start a short
			// verification backstop in case session_shutdown is delayed.
			phase = "verifying";
			verifyTimer = setTimeout(
				() => onVerificationTimeout(pi, ctx, cwd, attempts),
				VERIFICATION_TIMEOUT_MS,
			);
		},
		(e: unknown) => {
			if (hardTimer) { clearTimeout(hardTimer); hardTimer = undefined; }
			const msg = e instanceof Error ? e.message : String(e);
			const isHardTimeout = msg === "hard-timeout";
			void writeDiagnostics({
				requestId,
				phase: "failed",
				attempts,
				executeCommandRejected: true,
				executeCommandDurationMs: Date.now() - cmdStartedAt,
				hardTimeout: isHardTimeout,
				error: `executeCommand rejected: ${msg}`,
				cwd,
				executeCommandAvailable,
			}, cwd);
			// A rejection is a real failure (e.g. AgentHarnessError "busy"),
			// not a silent no-op. Do not retry on rejection.
			retryCount = 0;
			resetToIdle(cwd);
		},
	);
}

function onVerificationTimeout(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cwd: string,
	attempts: number,
): void {
	verifyTimer = undefined;
	if (reloadConfirmed) {
		// Confirmed late; nothing to do.
		phase = "done";
		retryCount = 0;
		return;
	}
	// Silent failure: executeCommand resolved but no session_shutdown{reason:reload}.
	void writeDiagnostics({
		requestId: activeRequestId,
		phase: "failed",
		attempts,
		reloadSilentlyFailed: true,
		error: "executeCommand resolved but session_shutdown{reason:reload} was not observed — handleReloadCommand silently no-op'd (isStreaming/isCompacting race or swallowed error)",
		cwd,
		executeCommandAvailable,
	}, cwd);

	// Bounded autonomous retry (the agent has stopped; only the timer can retry).
	if (retryCount < MAX_RETRIES) {
		retryCount++;
		void writeDiagnostics({
			requestId: activeRequestId,
			retried: true,
			retryCount,
			cwd,
			executeCommandAvailable,
		}, cwd);
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			// Re-arm the poll from the failed phase.
			phase = "idle";
			scheduleIdleReload(pi, ctx);
		}, RETRY_DELAY_MS);
	} else {
		// Terminal failure; the scheduled continuation will surface it.
		retryCount = 0;
		resetToIdle(cwd);
	}
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function agentReload(pi: ExtensionAPI): void {
	{
		const probe = pi as Record<string, unknown>;
		executeCommandAvailable = typeof probe.executeCommand === "function";
	}

	// session_shutdown: the reliable SUCCESS signal. Fires in the still-alive
	// OLD instance (correct cwd, lastKnownCwd intact) BEFORE teardown.
	// Success-preserving: once confirmed, no later write can regress to failure.
	pi.on("session_shutdown", (event: { reason?: string; targetSessionFile?: string }) => {
		clearAllTimers();
		if (event?.reason === "reload" && activeRequestId) {
			reloadConfirmed = true;
			phase = "done";
			retryCount = 0;
			const cwd = lastKnownCwd ?? process.cwd();
			void writeDiagnostics({
				requestId: activeRequestId,
				phase: "done",
				reloadConfirmed: true,
				confirmedAt: Date.now(),
				confirmedBy: RELOAD_CONFIRMATION,
				cwd,
				executeCommandAvailable,
			}, cwd);
		}
	});

	pi.on("session_start", (_event: { reason?: string }) => {
		// session_start is NOT used for confirmation (cwd-fragile in the rebuilt
		// instance, module state reset). session_shutdown is the signal.
	});

	pi.registerTool({
		name: "agent_reload_runtime",
		label: "Agent Reload Runtime",
		description:
			"Schedule a deferred Pi runtime reload that fires when the agent becomes idle. " +
			"Confirms success via the session_shutdown{reason:reload} event. " +
			"Requires the pi.executeCommand core patch. " +
			"Without it, returns a clear error and does not start the idle poll.",
		promptSnippet:
			"Schedule a deferred reload that fires when the agent becomes idle after the turn ends",
		promptGuidelines: [
			"Call agent_scheduler first in a separate call and confirm success.",
			"Then call agent_reload_runtime with {} and stop immediately.",
			"The reload runs shortly after your turn ends and the agent becomes idle, " +
				"before the scheduled continuation arrives.",
			"The scheduled continuation's FIRST action must be to READ " +
				"agent/agent-reload-diagnostics.json and check `reloadConfirmed` / " +
				"`reloadSilentlyFailed` / `executeCommandRejected` / `phase` before relying " +
				"on any new tool actions. If reloadSilentlyFailed is true, the reload did " +
				"NOT apply — tell the user to run /agent-reload-runtime manually.",
			"If this tool returns an error about pi.executeCommand not being available, " +
				"the reload DID NOT fire and WILL NOT fire. Use manual /agent-reload-runtime " +
				"in the TUI, or reapply the core patch (agent/core-patch/reapply-pi-core-patch.mjs).",
		],
		parameters: Type.Object({}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			lastKnownCwd = ctx.cwd;

			// Top-of-execute diagnostics (runs before any guard).
			const entry: ExecuteEntry = {
				ts: Date.now(),
				phase,
				requestId: activeRequestId,
				executeCommandAvailable,
				cwd: ctx.cwd,
				coalesced: phase === "polling" || phase === "command-in-flight" || phase === "verifying",
			};
			void writeDiagnostics({
				executeEntries: [entry],
				cwd: ctx.cwd,
			}, ctx.cwd);

			// Coalesce: reject new calls during non-terminal phases.
			if (phase === "polling" || phase === "command-in-flight" || phase === "verifying") {
				return {
					content: [{
						type: "text",
						text:
							`A reload is already in progress (phase: ${phase}, request: ${activeRequestId}). ` +
							`No new reload scheduled. Wait for the current attempt to finish ` +
							`(read agent/agent-reload-diagnostics.json for status).`,
					}],
					details: { command: RELOAD_COMMAND, deferred: false, coalesced: true, phase, requestId: activeRequestId },
				};
			}

			if (!executeCommandAvailable) {
				phase = "failed";
				void writeDiagnostics({
					phase: "failed",
					error: "executeCommand error: pi.executeCommand is not available",
					cwd: ctx.cwd,
					executeCommandAvailable: false,
				}, ctx.cwd);
				return {
					content: [{
						type: "text",
						text:
							"pi.executeCommand is not available in this Pi runtime (core patch not applied). " +
							"Options: (1) type /agent-reload-runtime manually in the TUI, or " +
							"(2) reapply the core patch: " +
							"node agent/core-patch/reapply-pi-core-patch.mjs apply",
					}],
					details: { command: RELOAD_COMMAND, deferred: false, error: "executeCommand not available" },
				};
			}

			// Reset retry count on a fresh terminal-phase call.
			retryCount = 0;
			scheduleIdleReload(pi, ctx);
			return {
				content: [{
					type: "text",
					text:
						"Reload deferred (request: " + activeRequestId + "). A background idle poll " +
						"will invoke /agent-reload-runtime shortly after your turn ends and the " +
						"agent becomes idle (isIdle && !hasPendingMessages). Success is confirmed " +
						"via session_shutdown{reason:reload}. STOP now — do no further work in this " +
						"runtime. The scheduled continuation should read " +
						"agent/agent-reload-diagnostics.json first to verify the reload applied.",
				}],
				details: { command: RELOAD_COMMAND, deferred: true, requestId: activeRequestId, phase: "polling" },
			};
		},
	});

	pi.registerCommand(RELOAD_COMMAND, {
		description:
			"Reload Pi extensions, skills, prompts, and themes for agent-initiated " +
			"continuation workflows. Terminal handler: calls ctx.reload() and returns immediately.",
		handler: async (_args, ctx) => {
			// Cheap yield: wait for any in-flight turn to settle. Only works
			// because we fire from a timer (never await executeCommand
			// synchronously inside the tool's execute — that would deadlock).
			const waitForIdle = (ctx as { waitForIdle?: () => Promise<void> }).waitForIdle;
			if (typeof waitForIdle === "function") {
				try { await waitForIdle(); } catch { /* best-effort */ }
			}
			await ctx.reload();
			return;
		},
	});
}
