import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type WriteDiagnosticsOptions,
	writeDiagnostics as writeCanonicalDiagnostics,
} from "./diagnostics.ts";

/**
 * Agent-operated "new session" bridge — public command-dispatch +
 * session_shutdown confirmation edition (v4, bundled-runtime fix).
 *
 * Pi 0.84.2+ supports dispatching registered extension commands through
 * pi.sendUserMessage(..., { expandPromptTemplates: true }). We deliberately
 * invoke that public path only after the idle poll settles. This avoids the
 * private pi.executeCommand core patch, which patched dist/core/* while the
 * 0.84.3+ CLI actually runs dist/bundle/cli.js.
 *
 * Fixes false `agent_new_session` failure diagnostics (RUN_20260627-164912):
 * - session_shutdown:new is authoritative. Once confirmed, later
 *   hard-timeout/rejection must NOT overwrite final diagnostics to failure.
 * - Dual-timeout pattern eliminated: single cancellable timeout handle.
 * - Atomic writes via temp-file + rename.
 * - Success-preserving diagnostics merge: confirmation dominance enforced in
 *   every write.
 * - Late confirmation grace window: hard-timeout without confirmation enters
 *   "verifying" and waits for bounded shutdown confirmation before terminal
 *   failure.
 *
 * Diagnostics: ONE canonical Pi-home location at
 * `<PI_HOME>/agent/agent-new-session-diagnostics.json` (`~/.pi/agent/...` by
 * default), regardless of the active project cwd.
 */

const NEW_SESSION_COMMAND = "agent-new-session";
const POLL_INTERVAL_MS = 500;
const IDLE_TICKS_REQUIRED = 2;
const VERIFICATION_TIMEOUT_MS = 10_000;
const EXECUTE_COMMAND_HARD_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 2_000;
const MAX_RETRIES = 1;

// ---------------------------------------------------------------------------
// Lifecycle-race-fix constants
// ---------------------------------------------------------------------------

/** Authoritative success signal emitted by session_shutdown handler. */
const NEW_SESSION_CONFIRMATION = "session_shutdown:new";

/**
 * How long to wait after executeCommand hard-timeout (no confirmation yet)
 * before writing terminal failure and resetting. During this window the
 * shutdown confirmation may still arrive.
 */
const LATE_CONFIRMATION_GRACE_MS = 20_000;

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

interface NewSessionDiagnostics {
	// Identity
	requestId?: string;
	phase: Phase;

	// Timing
	scheduled?: number;
	requested?: number;
	idleDetected?: number;
	newSessionInvoked?: number;
	executeCommandResolved?: number;
	executeCommandDurationMs?: number;
	confirmedAt?: number;
	lastUpdated?: string;

	// Success fields (canonical)
	newSessionConfirmed?: boolean;
	confirmedBy?: string;

	// Failure fields
	executeCommandRejected?: boolean;
	hardTimeout?: boolean;
	newSessionSilentlyFailed?: boolean;
	newSessionCancelled?: boolean;
	timeout?: boolean;
	error?: string;

	// Late-overwrite audit fields (lifecycle-race-fix)
	lateExecuteCommandRejectedAfterConfirmation?: boolean;
	lateHardTimeoutAfterConfirmation?: boolean;
	lateErrorAfterConfirmation?: string;
	executeCommandTimedOut?: boolean;

	// Retry
	retried?: boolean;
	retryCount?: number;

	// Counters / metadata
	attempts: number;
	cwd: string;
	executeCommandAvailable: boolean;

	// Logs
	executeEntries?: ExecuteEntry[];
	tickLog?: TickEntry[];
}

/** Minimal required fields for a canonical diagnostics document. */
interface CanonicalDefaults {
	requestId?: string;
	phase: Phase;
	attempts: number;
	cwd: string;
	executeCommandAvailable: boolean;
	newSessionConfirmed: boolean;
	newSessionSilentlyFailed: boolean;
	executeCommandRejected: boolean;
	hardTimeout: boolean;
	confirmedBy?: string;
	lastUpdated: string;
}

// ---------------------------------------------------------------------------
// Diagnostics — success-preserving + atomic write
// ---------------------------------------------------------------------------

/**
 * Compute canonical defaults after a merge.
 * If confirmation was observed (in existing patch or raw text recovery),
 * force top-level success fields.
 */
function applyCanonicalDefaults(
	merged: NewSessionDiagnostics,
	confirmationObserved: boolean,
): void {
	merged.lastUpdated = new Date().toISOString();

	if (confirmationObserved) {
		// Force success — confirmation is authoritative.
		merged.phase = "done";
		merged.newSessionConfirmed = true;
		merged.confirmedBy = NEW_SESSION_CONFIRMATION;
		merged.newSessionSilentlyFailed = false;
		merged.newSessionCancelled = false;
		merged.executeCommandRejected = false;
		delete merged.hardTimeout;
		delete merged.error;
		delete merged.executeCommandTimedOut;
		delete merged.timeout;
		return;
	}

	// No confirmation — ensure canonical fields exist with default false.
	if (merged.newSessionConfirmed === undefined) {
		merged.newSessionConfirmed = false;
	}
	if (merged.newSessionSilentlyFailed === undefined) {
		merged.newSessionSilentlyFailed = false;
	}
	if (merged.executeCommandRejected === undefined) {
		merged.executeCommandRejected = false;
	}
}

/**
 * Attempt to recover `confirmedBy: "session_shutdown:new"` evidence from
 * raw text when JSON parsing fails (e.g. partial write during teardown).
 */
function rawTextContainsConfirmation(raw: string): boolean {
	return raw.includes('"confirmedBy"') && raw.includes('"session_shutdown:new"');
}

/**
 * Write diagnostics atomically with success-preserving semantics.
 *
 * 1. Read existing file; parse JSON if possible.
 * 2. If parse fails, recover confirmation from raw text.
 * 3. Merge patch into existing, capping log arrays.
 * 4. If confirmation observed (existing, patch, or raw-text recovery),
 *    force canonical success: phase:"done", newSessionConfirmed:true, etc.
 * 5. Write to temp file; rename to final path.
 *
 * Must NEVER throw — best-effort diagnostics.
 */
async function writeDiagnostics(
	patch: Partial<NewSessionDiagnostics> & { attempts?: number; cwd?: string; executeCommandAvailable?: boolean },
	cwd: string,
	options?: WriteDiagnosticsOptions,
): Promise<void> {
	return writeCanonicalDiagnostics(patch, cwd, options);
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
let newSessionConfirmed = false;
let retryCount = 0;
let executeCommandAvailable = false;
let lastKnownCwd: string | undefined;
let kickoffMessage: string | undefined;

/** Tracks whether a late-confirmation grace timer is active. */
let lateConfirmationTimer: ReturnType<typeof setTimeout> | undefined;

function clearAllTimers(): void {
	if (pollInterval) { clearInterval(pollInterval); pollInterval = undefined; }
	if (hardTimer) { clearTimeout(hardTimer); hardTimer = undefined; }
	if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = undefined; }
	if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
	if (lateConfirmationTimer) { clearTimeout(lateConfirmationTimer); lateConfirmationTimer = undefined; }
}

/**
 * Reset state to idle. Safe for confirmed sessions: confirmation flags are
 * preserved for the success-preserving writer to read.
 */
function resetToIdle(cwd: string): void {
	clearAllTimers();
	phase = "idle";
	activeRequestId = undefined;
	kickoffMessage = undefined;
	// NOTE: newSessionConfirmed is NOT cleared here. It must remain set so
	// the success-preserving writer in the shutdown handler and any late
	// write can still read it. Only clear it when explicitly starting a new
	// request cycle (scheduleIdleNewSession).
}

// ---------------------------------------------------------------------------
// Idle poll + executeCommand dispatch
// ---------------------------------------------------------------------------

function scheduleIdleNewSession(pi: ExtensionAPI, ctx: ExtensionContext, message?: string): void {
	if (phase !== "idle" && phase !== "done" && phase !== "failed") {
		void writeDiagnostics({
			phase,
			error: `scheduleIdleNewSession called from non-terminal phase ${phase}; coalesced`,
			cwd: ctx.cwd,
		}, ctx.cwd);
		return;
	}

	phase = "polling";
	newSessionConfirmed = false; // Only now safe to clear.
	activeRequestId = `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	kickoffMessage = message;

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
	}, cwd, { resetForRequest: true });

	pollInterval = setInterval(() => {
		attempts++;

		// No give-up deadline. An owner message or scheduler wake arriving after
		// the request starts a normal turn; the switch waits for that turn to end
		// instead of failing after a fixed window (13 Oct 2026: two refreshes were
		// lost this way and the owner had to type /agent-new-session by hand).

		let isIdle = false;
		let hasPending = false;
		try {
			isIdle = ctx.isIdle();
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
		const previousIdleTicks = idleTicks;
		if (stableIdle) {
			idleTicks++;
		} else {
			idleTicks = 0;
		}

		// Record only state changes so an indefinite wait does not rewrite the
		// diagnostics file twice a second.
		if (attempts > 1 && stableIdle === (previousIdleTicks > 0) && idleTicks < IDLE_TICKS_REQUIRED) return;

		void writeDiagnostics({
			requestId: activeRequestId,
			phase: "polling",
			attempts,
			tickLog: [{ ts: Date.now(), isIdle, hasPendingMessages: hasPending, stableIdle, idleTicks }],
			cwd,
			executeCommandAvailable,
		}, cwd);

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
			fireNewSession(pi, ctx, cwd, attempts);
		}
	}, POLL_INTERVAL_MS);
}

/**
 * Dispatch `/agent-new-session` through Pi's public extension-command path.
 * The async wrapper preserves the existing verification phase machine while
 * pi.sendUserMessage itself remains fire-and-forget on ExtensionAPI.
 *
 * Lifecycle-race-fix changes:
 * - Single timeout, not dual (no anonymous uncancellable setTimeout in race).
 * - On hard-timeout without confirmation: enter "verifying" with a
 *   late-confirmation grace window instead of immediate terminal failure.
 * - On non-hard rejection without confirmation: terminal failure.
 * - On any late rejection *after* confirmation: record as audit metadata
 *   only, do not change success status (handled by success-preserving writer).
 */
function fireNewSession(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cwd: string,
	attempts: number,
): void {
	const requestId = activeRequestId!;

	const sendUserMessage = (pi as unknown as {
		sendUserMessage?: (
			content: string,
			options?: { expandPromptTemplates?: boolean },
		) => void;
	}).sendUserMessage;
	if (typeof sendUserMessage !== "function") {
		phase = "failed";
		void writeDiagnostics({
			requestId,
			phase: "failed",
			attempts,
			error: "command dispatch error: pi.sendUserMessage is not available",
			cwd,
			executeCommandAvailable,
		}, cwd);
		resetToIdle(cwd);
		return;
	}

	const args = kickoffMessage
		? JSON.stringify({ kickoff: kickoffMessage })
		: undefined;
	const commandText = args
		? `/${NEW_SESSION_COMMAND} ${args}`
		: `/${NEW_SESSION_COMMAND}`;
	const executeCommand = async (): Promise<void> => {
		sendUserMessage.call(pi, commandText, { expandPromptTemplates: true });
	};

	const cmdStartedAt = Date.now();

	// Single cancellable hard-timeout handle (removed dual-timeout pattern).
	hardTimer = setTimeout(() => {
		hardTimer = undefined;
		// Hard-timeout fired. Check if confirmation arrived before the timeout.
		if (newSessionConfirmed) {
			// Confirmation already observed — record as late audit metadata only.
			void writeDiagnostics({
				requestId,
				attempts,
				executeCommandTimedOut: true,
				lateHardTimeoutAfterConfirmation: true,
				executeCommandDurationMs: Date.now() - cmdStartedAt,
				lateErrorAfterConfirmation: `executeCommand hard-timeout after ${EXECUTE_COMMAND_HARD_TIMEOUT_MS}ms (post-confirmation)`,
				cwd,
				executeCommandAvailable,
			}, cwd);
			return; // resetToIdle handled by shutdown confirmation path.
		}

		// No confirmation yet. Write ambiguous timeout and enter late-confirmation
		// grace window. Keep activeRequestId alive.
		void writeDiagnostics({
			requestId,
			phase: "verifying",
			attempts,
			executeCommandTimedOut: true,
			executeCommandDurationMs: Date.now() - cmdStartedAt,
			executeCommandRejected: false, // Not yet — awaiting grace.
			hardTimeout: true,
			error: `executeCommand hard-timeout after ${EXECUTE_COMMAND_HARD_TIMEOUT_MS}ms (grace window active)`,
			cwd,
			executeCommandAvailable,
		}, cwd);

		phase = "verifying";

		// Late-confirmation grace: if session_shutdown:new arrives within this
		// window, it will set newSessionConfirmed=true and write canonical success.
		lateConfirmationTimer = setTimeout(() => {
			lateConfirmationTimer = undefined;
			if (newSessionConfirmed) {
				// Confirmation arrived during grace window. Success.
				phase = "done";
				retryCount = 0;
				void writeDiagnostics({
					requestId,
					phase: "done",
					newSessionConfirmed: true,
					confirmedBy: NEW_SESSION_CONFIRMATION,
					executeCommandRejected: false,
					cwd,
					executeCommandAvailable,
				}, cwd);
				resetToIdle(cwd);
			} else {
				// Grace expired — no confirmation. Terminal failure.
				void writeDiagnostics({
					requestId,
					phase: "failed",
					attempts,
					executeCommandRejected: true,
					executeCommandDurationMs: Date.now() - cmdStartedAt,
					executeCommandTimedOut: true,
					hardTimeout: true,
					error: `executeCommand hard-timeout after ${EXECUTE_COMMAND_HARD_TIMEOUT_MS}ms and grace window expired`,
					cwd,
					executeCommandAvailable,
				}, cwd);
				retryCount = 0;
				resetToIdle(cwd);
			}
		}, LATE_CONFIRMATION_GRACE_MS);
	}, EXECUTE_COMMAND_HARD_TIMEOUT_MS);

	// Execute command via pi.executeCommand directly (no Promise.race wrapping).
	void executeCommand().then(
		() => {
			if (hardTimer) { clearTimeout(hardTimer); hardTimer = undefined; }
			const duration = Date.now() - cmdStartedAt;

			// NOTE: if newSessionConfirmed is already true (set by shutdown handler),
			// the success-preserving writer ensures phase="done" regardless of
			// what we write here. We still write the resolution data.
			void writeDiagnostics({
				requestId,
				phase: newSessionConfirmed ? "done" : "verifying",
				attempts,
				newSessionInvoked: Date.now(),
				executeCommandResolved: Date.now(),
				executeCommandDurationMs: duration,
				executeCommandRejected: false,
				newSessionConfirmed,
				cwd,
				executeCommandAvailable,
			}, cwd);

			if (newSessionConfirmed) {
				phase = "done";
				retryCount = 0;
				return;
			}
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

			if (newSessionConfirmed) {
				// Confirmation already observed — success dominance.
				// Record late rejection as audit metadata only.
				void writeDiagnostics({
					requestId,
					attempts,
					lateExecuteCommandRejectedAfterConfirmation: true,
					lateHardTimeoutAfterConfirmation: isHardTimeout,
					executeCommandDurationMs: Date.now() - cmdStartedAt,
					lateErrorAfterConfirmation: `executeCommand rejected after confirmation: ${msg}`,
					cwd,
					executeCommandAvailable,
				}, cwd);
				return;
			}

			// No confirmation. Non-hard rejection → terminal failure.
			// Hard rejection here is informational; the single timeout already
			// handles hard-timeout (this path is unlikely to be hit for hard-timeout).
			void writeDiagnostics({
				requestId,
				phase: "failed",
				attempts,
				executeCommandRejected: true,
				executeCommandDurationMs: Date.now() - cmdStartedAt,
				executeCommandTimedOut: isHardTimeout,
				hardTimeout: isHardTimeout,
				error: `executeCommand rejected: ${msg}`,
				cwd,
				executeCommandAvailable,
			}, cwd);
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

	// Re-check confirmation before failing (lifecycle-race-fix).
	if (newSessionConfirmed) {
		phase = "done";
		retryCount = 0;
		void writeDiagnostics({
			requestId: activeRequestId,
			phase: "done",
			newSessionConfirmed: true,
			confirmedBy: NEW_SESSION_CONFIRMATION,
			cwd,
			executeCommandAvailable,
		}, cwd);
		resetToIdle(cwd);
		return;
	}

	void writeDiagnostics({
		requestId: activeRequestId,
		phase: "failed",
		attempts,
		newSessionSilentlyFailed: true,
		error: "executeCommand resolved but session_shutdown{reason:new} was not observed — newSession may have been cancelled (session_before_switch) or the session switch did not take effect",
		cwd,
		executeCommandAvailable,
	}, cwd);

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
			phase = "idle";
			scheduleIdleNewSession(pi, ctx, kickoffMessage);
		}, RETRY_DELAY_MS);
	} else {
		retryCount = 0;
		resetToIdle(cwd);
	}
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function agentNewSession(pi: ExtensionAPI): void {
	{
		const probe = pi as Record<string, unknown>;
		// Historical diagnostics retain the executeCommandAvailable field, but
		// from v4 it represents availability of the supported command-dispatch
		// transport used by this bridge.
		executeCommandAvailable = typeof probe.sendUserMessage === "function";
	}

	// session_shutdown: the reliable SUCCESS signal for new-session.
	// teardownCurrent("new", ...) emits session_shutdown with reason "new"
	// BEFORE the old instance is torn down.
	pi.on("session_shutdown", (event: { reason?: string; targetSessionFile?: string }) => {
		clearAllTimers();

		if (event?.reason === "new") {
			const cwd = lastKnownCwd ?? process.cwd();
			newSessionConfirmed = true;
			phase = "done";
			retryCount = 0;

			void writeDiagnostics({
				requestId: activeRequestId,
				phase: "done",
				newSessionConfirmed: true,
				confirmedAt: Date.now(),
				confirmedBy: NEW_SESSION_CONFIRMATION,
				cwd,
				executeCommandAvailable,
			}, cwd);
		}
	});

	pi.on("session_start", (_event: { reason?: string }) => {
		// session_start NOT used for confirmation (cwd-fragile, module state reset).
	});

	pi.registerTool({
		name: "agent_new_session",
		label: "Agent New Session",
		description:
			"Start a fresh Pi session with a clean context window (equivalent to " +
			"the human /new command). Schedules a deferred new-session creation that " +
			"fires when the agent becomes idle, then dispatches /agent-new-session " +
			"through Pi's supported command-expansion API. The old session is torn " +
			"down; the agent MUST stop immediately after calling this tool. Confirms " +
			"success via session_shutdown{reason:new}. No core patch is required on " +
			"Pi 0.84.2 or newer.",
		promptSnippet:
			"Start a new Pi session with a clean context window (like /new)",
		promptGuidelines: [
			"To start a clean session: (1) write a concise continuation/kickoff " +
				"message, (2) schedule that continuation via agent_scheduler with " +
				"delayMinutes: 30 as a FALLBACK only, (3) call agent_new_session with " +
				"the same continuation as `kickoff`, (4) stop immediately. The kickoff " +
				"is delivered into the new session at the moment of the switch and is " +
				"the normal way work resumes. The switch waits as long as needed for " +
				"the agent to become idle; an owner message or wake arriving first only " +
				"delays it. Always schedule the fallback BEFORE calling agent_new_session.",
			"The fallback wake must first read the diagnostics. If phase is " +
				"'polling', the switch is still waiting for idle: end the turn at once " +
				"so it can happen. If phase is 'done' and work already resumed from the " +
				"kickoff, do nothing more. Only if phase is 'failed', tell the user once " +
				"to run /agent-new-session.",
			"The old session and all its in-memory state will be torn down. Only " +
				"filesystem state (such as agent_scheduler schedules) survives.",
			"The scheduled continuation's FIRST action must be to READ " +
				"the canonical Pi-home diagnostics file `<PI_HOME>/agent/agent-new-session-diagnostics.json` " +
				"(`~/.pi/agent/agent-new-session-diagnostics.json` by default; " +
				"`C:/Users/you/.pi/agent/agent-new-session-diagnostics.json` on this Windows host) " +
				"and check `newSessionConfirmed` / " +
				"`newSessionSilentlyFailed` / `executeCommandRejected` / `phase`. If " +
				"phase is 'done' and newSessionConfirmed is true, the switch succeeded. " +
				"If phase is 'polling', the switch is still waiting for this session to " +
				"go idle: end the turn. If phase is 'failed', the switch did NOT happen — " +
				"tell the user to run /agent-new-session manually.",
			"This bridge uses pi.sendUserMessage with expandPromptTemplates:true only " +
				"after Pi is stably idle. Do not remove that option or call it directly " +
				"from the active tool turn; otherwise the slash command may become plain " +
				"model input or run during streaming.",
			"NOTE: newSessionConfirmed:true and confirmedBy:'session_shutdown:new' are " +
				"authoritative success signals. If these are present, the session switch " +
				"succeeded even if executeCommandRejected or hardTimeout are also present " +
				"(those are late race artifacts that do not affect final status).",
		],
		parameters: Type.Object(
			{
				kickoff: Type.Optional(
					Type.String({
						description:
							"The continuation message (normally beginning 'RESUME AFTER NEW " +
							"SESSION:'), delivered into the replacement session at the moment " +
							"of the switch. This is the normal way work resumes; the scheduled " +
							"wake is only a fallback.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastKnownCwd = ctx.cwd;

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

			if (phase === "polling" || phase === "command-in-flight" || phase === "verifying") {
				return {
					content: [{
						type: "text",
						text:
							`A new-session switch is already in progress (phase: ${phase}, ` +
							`request: ${activeRequestId}). No new switch scheduled. Wait for the ` +
							`current attempt to finish (read the canonical Pi-home file ` +
							`<PI_HOME>/agent/agent-new-session-diagnostics.json; ` +
							`~/.pi/agent/agent-new-session-diagnostics.json by default).`,
					}],
					details: { command: NEW_SESSION_COMMAND, deferred: false, coalesced: true, phase, requestId: activeRequestId },
				};
			}

			retryCount = 0;
			scheduleIdleNewSession(pi, ctx, params.kickoff);
			return {
				content: [
					{
						type: "text",
						text:
							"New session deferred (request: " + activeRequestId + "). A background " +
							"idle poll will dispatch /agent-new-session through Pi's public command API shortly after your turn ends " +
							"and the agent becomes idle (isIdle && !hasPendingMessages), however long " +
							"that takes; incoming messages only delay it. The old " +
							"session is torn down; the new session starts with a clean context window. " +
							"Success is confirmed via session_shutdown{reason:new}. STOP now — do " +
							"no further work in this runtime. Work resumes from the kickoff in the new " +
							"session; the fallback wake reads <PI_HOME>/agent/agent-new-session-diagnostics.json " +
							"first and ends its turn at once if the phase is still 'polling'.",
					},
				],
				details: { command: NEW_SESSION_COMMAND, deferred: true, requestId: activeRequestId, phase: "polling" },
			};
		},
	});

	pi.registerCommand(NEW_SESSION_COMMAND, {
		description:
			"Start a clean Pi session (agent-initiated /new). Terminal handler: " +
			"calls ctx.newSession() to tear down the old session and create a " +
			"fresh one. Passes optional kickoff into withSession.",
		handler: async (args, ctx) => {
			let kickoff: string | undefined;
			if (args) {
				try {
					const parsed = JSON.parse(args);
					kickoff = parsed.kickoff;
				} catch {
					kickoff = args;
				}
			}

			const parentSession = ctx.sessionManager.getSessionFile();
			const cwd = lastKnownCwd ?? ctx.cwd;

			// A direct/manual command needs its own request generation. Tool-driven
			// dispatch already created one in scheduleIdleNewSession().
			if (!activeRequestId) {
				const startedAt = Date.now();
				activeRequestId = `new-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
				phase = "command-in-flight";
				newSessionConfirmed = false;
				await writeDiagnostics({
					requestId: activeRequestId,
					phase,
					scheduled: startedAt,
					requested: startedAt,
					newSessionInvoked: startedAt,
					attempts: 1,
					cwd,
					executeCommandAvailable,
				}, cwd, { resetForRequest: true });
			}

			// The deferred tool already waits for a settled agent. A second
			// waitForIdle() inside the command adds no safety and can deadlock a
			// command-dispatch implementation that counts itself as pending.
			//
			// Most importantly, do not await a default LLM turn from withSession.
			// Awaiting sendUserMessage keeps ctx.newSession()/executeCommand open for
			// the entire new-session agent run; any later model/tool failure then
			// reaches InteractiveMode's fatal replacement handler and exits to the
			// parent shell. The scheduler continuation is the normal wake-up path.
			const result = await ctx.newSession({
				parentSession,
				withSession: kickoff
					? async (sessionCtx) => {
						void sessionCtx.sendUserMessage(kickoff).catch((error: unknown) => {
							const message = error instanceof Error ? error.message : String(error);
							void writeDiagnostics({
								requestId: activeRequestId,
								lateErrorAfterConfirmation: `non-blocking kickoff failed: ${message}`,
								cwd,
								executeCommandAvailable,
							}, cwd);
						});
					}
					: undefined,
			});

			if (result.cancelled) {
				// An extension cancelled via session_before_switch.
				// session_shutdown{reason:new} did NOT fire — the verification
				// timer in fireNewSession will catch this as a silent failure.
				// Write a cancellation marker for diagnostics.
				try {
					const cwd = lastKnownCwd ?? process.cwd();
					await writeDiagnostics({
						newSessionCancelled: true,
						error: "ctx.newSession() returned { cancelled: true } — an extension cancelled via session_before_switch",
						cwd,
					}, cwd);
				} catch { /* best-effort */ }
			}
		},
	});
}
