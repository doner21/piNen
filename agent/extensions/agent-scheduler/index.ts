/**
 * Agent Scheduler Extension
 * =========================
 *
 * Lets agents (via the `agent_scheduler` tool) and users (via slash commands)
 * schedule future wake-ups. A wake-up re-injects a user message into the active
 * Pi session with `pi.sendUserMessage()` so the agent resumes with a concrete
 * task — e.g. "check whether download X finished".
 *
 * Design highlights (see `intake.md` for the full spec):
 *
 * - Persistence: state lives in `<agentDir>/scheduler.json`. Writes go to a
 *   unique temp file then `rename()` atomically into place.
 * - Advisory lock: `<agentDir>/scheduler.lock` (O_EXCL acquire + stale break)
 *   serializes every read-modify-write so multiple Pi processes can't clobber
 *   each other.
 * - cwd-scoped schedules: each schedule records an `originCwdKey`. Only
 *   schedules whose key matches the *current* session cwd are drained or
 *   timer-fired in that session. A schedule created in project A never fires
 *   while you're working in project B.
 * - Claim-before-deliver: firing atomically transitions a schedule
 *   `pending -> delivering` (persisted) *before* sending the message, so two
 *   timers/processes can never double-deliver the same wake-up. A `claimToken`
 *   is minted at claim time and must match before the record can be finalized
 *   as delivered/failed, so a stale recovered `delivering` record cannot be
 *   completed by a later, unrelated claim.
 * - Single session-scoped timer: at most one `setTimeout` per session, always
 *   aimed at the earliest due schedule for the current cwd. Cleared on
 *   `session_shutdown`; never started in the factory.
 * - Reason-aware `session_start` drain: `startup`/`new`/`resume` recover stuck
 *   deliveries, drain (deferred ~250ms) only schedules due at the session-start
 *   instant, suppress any leftover overdue, then arm. `reload`/`fork` recover
 *   and suppress everything due before the session-start instant, arming only
 *   future schedules. Suppressed records (`dueAt <= suppressOverdueDueAtOrBefore`)
 *   are skipped by both `armTimer` and `onTimerFire`.
 * - Guards: minimum-delay nudge (no immediate self-triggering loops), maximum
 *   delay cap, per-cwd pending backlog cap, terminal-record retention pruning,
 *   stuck-`delivering` recovery, and "deliver at most once" via status machine.
 *
 * The whole extension is self-contained in this one file. Pure helpers and
 * types are exported at the bottom for unit testing.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type SessionStartEvent,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join, resolve } from "node:path";
import { Type, type Static } from "typebox";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum accepted delay. Due-at-or-before-now is nudged to this to prevent
 *  immediate self-triggering feedback loops. */
const MIN_DELAY_MS = 5_000;
/** Maximum accepted delay (caps the scheduling horizon). ~365 days. */
const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000;
/** setTimeout clamps below ~2^31 ms; stay safely under. ~23 days. */
const MAX_TIMER_MS = 2_000_000_000;
/** How many overdue schedules a single session_start drain delivers at once. */
const MAX_DRAIN_BATCH = 10;
/** Max pending schedules per origin cwd (backlog guard). */
const MAX_PENDING_PER_CWD = 200;
/** Terminal records (delivered/cancelled/failed) are pruned after this. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard cap on total stored records (oldest terminal dropped first). */
const MAX_RECORDS = 1000;
/** A `delivering` record older than this is considered crashed -> failed. */
const STUCK_DELIVERING_MS = 10 * 60 * 1000;
/** Lock files older than this are considered stale and broken. */
const LOCK_STALE_MS = 60_000;
/** Lock acquire timeout. */
const LOCK_TIMEOUT_MS = 5_000;
/** Lock poll interval. */
const LOCK_POLL_MS = 50;
/** Deferred drain delay on startup/new/resume so the UI/runtime settles first. */
const SESSION_START_DRAIN_DELAY_MS = 250;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScheduleStatus =
	| "pending"
	| "delivering"
	| "delivered"
	| "cancelled"
	| "failed";

/** Who created the schedule. */
export type ScheduleCreatedBy = "tool" | "slash";

export interface ScheduleRecord {
	id: string;
	message: string;
	label?: string;
	/** Epoch ms when the wake-up is due. */
	dueAt: number;
	/** Epoch ms when the schedule was created. */
	createdAt: number;
	status: ScheduleStatus;
	/** Normalized cwd key this schedule is scoped to. */
	originCwdKey: string;
	/** Human-readable cwd captured at creation time. */
	originCwd?: string;
	/** Session file the schedule was created in (for traceability). */
	originSessionFile?: string;
	/** Whether the schedule was created via the tool or a slash command. */
	createdBy?: ScheduleCreatedBy;
	/** Epoch ms when the record was last mutated. */
	updatedAt?: number;
	/** Opaque token minted on claim; must match to finalize delivery. */
	claimToken?: string;
	/** Epoch ms when delivery was claimed. */
	triggeredAt?: number;
	/** Epoch ms when the message was actually delivered. */
	deliveredAt?: number;
	/** Epoch ms when cancelled. */
	cancelledAt?: number;
	/** Reason for failure. */
	failureReason?: string;
	/** True when delivered after being past due (Pi was offline). */
	overdue?: boolean;
	/** Delivery attempt count. */
	attempt?: number;
}

export interface SchedulerStore {
	version: 1;
	schedules: Record<string, ScheduleRecord>;
	nextSeq: number;
}

/** Subset of ScheduleRecord needed to render a wake-up envelope. */
export type WakeEnvelopeInput = Pick<
	ScheduleRecord,
	| "id"
	| "message"
	| "label"
	| "dueAt"
	| "originCwd"
	| "originCwdKey"
	| "originSessionFile"
>;

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const AgentSchedulerParams = Type.Object({
	action: StringEnum(["schedule", "list", "get", "cancel"] as const, {
		description:
			"schedule: create a future wake-up; list: list schedules; get: inspect one; cancel: cancel one.",
	}),
	message: Type.Optional(
		Type.String({
			description: "Future user prompt to deliver (required for schedule).",
		}),
	),
	delaySeconds: Type.Optional(
		Type.Number({ description: "Relative countdown in seconds (schedule)." }),
	),
	delayMinutes: Type.Optional(
		Type.Number({ description: "Relative countdown in minutes (schedule)." }),
	),
	delayHours: Type.Optional(
		Type.Number({ description: "Relative countdown in hours (schedule)." }),
	),
	delayDays: Type.Optional(
		Type.Number({ description: "Relative countdown in days (schedule)." }),
	),
	at: Type.Optional(
		Type.String({
			description: "Absolute due time, ISO 8601 preferred. Local parses accepted (schedule).",
		}),
	),
	label: Type.Optional(
		Type.String({ description: "Optional human-readable purpose (schedule)." }),
	),
	id: Type.Optional(
		Type.String({
			description: "Schedule id or unique prefix (required for get/cancel).",
		}),
	),
	status: Type.Optional(
		StringEnum(
			["pending", "delivering", "delivered", "cancelled", "failed", "all"] as const,
			{ description: "Filter for list. Defaults to pending." },
		),
	),
	scope: Type.Optional(
		StringEnum(["current", "all"] as const, {
			description: "List scope: current cwd only (default) or all cwds.",
		}),
	),
});

export type AgentSchedulerInput = Static<typeof AgentSchedulerParams>;

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Normalize a cwd into a stable scope key (case-insensitive on Windows). */
export function normalizeCwdKey(cwd: string): string {
	const resolved = cwd ? resolve(cwd) : "";
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Parse a human delay token like "10m", "2h", "1d", "90s", or "30" (seconds).
 *  Returns ms, or null if unparseable. */
export function parseDelay(input: string): number | null {
	const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(input.trim());
	if (!m) return null;
	const n = Number.parseFloat(m[1]);
	const unit = m[2] || "s";
	const mult: Record<string, number> = {
		s: 1000,
		m: 60_000,
		h: 3_600_000,
		d: 86_400_000,
	};
	const ms = n * mult[unit];
	if (!Number.isFinite(ms) || ms < 0) return null;
	return ms;
}

/** Parse an absolute time string (ISO 8601 preferred, local formats accepted).
 *  Returns epoch ms, or null if unparseable. */
export function parseAbsolute(input: string): number | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	// Accept "YYYY-MM-DD HH:MM[:SS]" by upgrading to ISO form.
	const candidate = trimmed.includes("T")
		? trimmed
		: trimmed.replace(/^(\d{4}-\d{2}-\d{2})\s+/, "$1T");
	const ms = Date.parse(candidate);
	if (!Number.isFinite(ms)) return null;
	return ms;
}

/** Split on the first " -- " separator, returning [before, after] or null. */
function splitOnDashDash(s: string): [string, string] | null {
	const m = /^(.*?)\s+--\s+(.*)$/.exec(s);
	if (!m) return null;
	return [m[1], m[2]];
}

/** Parse `/schedule-agent` argument strings.
 *
 *  Supported forms:
 *  - `<delay> <message>`        e.g. `10m check the download`
 *  - `<delay> -- <message>`     e.g. `2h -- check the download`
 *  - `at <iso> <message>`       e.g. `at 2026-06-20T12:00:00Z check the download`
 *  - `at <date> <time> -- <message>`  e.g. `at 2026-06-20 12:00 -- check the download`
 *  - `at <date> <time> <message>`     e.g. `at 2026-06-20 12:00 check the download`
 *
 *  Returns the source kind plus the parsed timing and message, or null on
 *  missing message / unparseable delay or date. */
export function parseScheduleArgs(
	args: string,
):
	| { source: "relative"; delayMs: number; message: string }
	| { source: "absolute"; dueAt: number; message: string }
	| null {
	const trimmed = args.trim();
	if (!trimmed) return null;

	// Absolute form: "at <time> [--] <message>".
	const atMatch = /^at\s+/i.exec(trimmed);
	if (atMatch) {
		const rest = trimmed.slice(atMatch[0].length).trim();
		if (!rest) return null;
		let timePart: string;
		let message: string;
		const sep = splitOnDashDash(rest);
		if (sep) {
			[timePart, message] = sep;
		} else {
			// No " -- ": consume date token(s).
			const tokens = rest.split(/\s+/);
			const first = tokens[0];
			const isDate = /^\d{4}-\d{2}-\d{2}/.test(first);
			if (isDate && first.includes("T")) {
				// Single ISO token like 2026-06-20T12:00:00Z.
				timePart = first;
				message = tokens.slice(1).join(" ").trim();
			} else if (
				isDate &&
				tokens.length >= 2 &&
				/^\d{2}:\d{2}/.test(tokens[1])
			) {
				// "YYYY-MM-DD HH:MM[:SS]"
				timePart = `${first} ${tokens[1]}`;
				message = tokens.slice(2).join(" ").trim();
			} else {
				// Bare single-token absolute (e.g. a time or date); require a message.
				timePart = first;
				message = tokens.slice(1).join(" ").trim();
			}
		}
		if (!message) return null;
		const dueAt = parseAbsolute(timePart);
		if (dueAt === null) return null;
		return { source: "absolute", dueAt, message };
	}

	// Relative form.
	let delayTok: string;
	let message: string;
	const sep = splitOnDashDash(trimmed);
	if (sep) {
		[delayTok, message] = sep;
		delayTok = delayTok.trim();
		message = message.trim();
	} else {
		const space = trimmed.search(/\s/);
		if (space === -1) return null; // no message
		delayTok = trimmed.slice(0, space);
		message = trimmed.slice(space + 1).trim();
	}
	if (!delayTok || !message) return null;
	const delayMs = parseDelay(delayTok);
	if (delayMs === null) return null;
	return { source: "relative", delayMs, message };
}

/** Compute a due time (epoch ms) from tool schedule params. Exactly one timing
 *  selector must be provided, and numeric selectors must be finite & >= 0. */
export function computeDueAt(
	params: Pick<
		AgentSchedulerInput,
		"at" | "delaySeconds" | "delayMinutes" | "delayHours" | "delayDays"
	>,
	now: number,
): { dueAt: number; source: string } {
	const selectors: string[] = [];
	if (params.at) selectors.push("at");
	if (typeof params.delaySeconds === "number") selectors.push("delaySeconds");
	if (typeof params.delayMinutes === "number") selectors.push("delayMinutes");
	if (typeof params.delayHours === "number") selectors.push("delayHours");
	if (typeof params.delayDays === "number") selectors.push("delayDays");
	if (selectors.length !== 1) {
		throw new Error(
			selectors.length === 0
				? "Provide exactly one of: at, delaySeconds, delayMinutes, delayHours, delayDays."
				: `Provide exactly one timing selector; got ${selectors.length}: ${selectors.join(", ")}.`,
		);
	}
	const requireFinite = (v: number, name: string): number => {
		if (!Number.isFinite(v) || v < 0) {
			throw new Error(`${name} must be a finite non-negative number.`);
		}
		return v;
	};
	if (params.at) {
		const ms = parseAbsolute(params.at);
		if (ms === null) throw new Error(`Could not parse 'at' time: ${params.at}`);
		return { dueAt: ms, source: "absolute" };
	}
	if (typeof params.delaySeconds === "number") {
		return { dueAt: now + requireFinite(params.delaySeconds, "delaySeconds") * 1000, source: "delaySeconds" };
	}
	if (typeof params.delayMinutes === "number") {
		return { dueAt: now + requireFinite(params.delayMinutes, "delayMinutes") * 60_000, source: "delayMinutes" };
	}
	if (typeof params.delayHours === "number") {
		return { dueAt: now + requireFinite(params.delayHours, "delayHours") * 3_600_000, source: "delayHours" };
	}
	if (typeof params.delayDays === "number") {
		return { dueAt: now + requireFinite(params.delayDays, "delayDays") * 86_400_000, source: "delayDays" };
	}
	// Unreachable: exactly one selector is present and handled above.
	throw new Error("No timing selector provided.");
}

/** Enforce min/max delay bounds (loop + horizon guards). */
export function nudgeDueAt(dueAt: number, now: number): number {
	if (dueAt <= now) return now + MIN_DELAY_MS;
	if (dueAt > now + MAX_DELAY_MS) return now + MAX_DELAY_MS;
	return dueAt;
}

/** Human-readable relative delay. */
export function formatDelay(ms: number): string {
	const abs = Math.abs(ms);
	if (abs < 60_000) return `${Math.round(abs / 1000)}s`;
	if (abs < 3_600_000) return `${(abs / 60_000).toFixed(1)}m`;
	if (abs < 86_400_000) return `${(abs / 3_600_000).toFixed(1)}h`;
	return `${(abs / 86_400_000).toFixed(1)}d`;
}

/** Build the structured wake-up envelope delivered via sendUserMessage. */
export function buildWakeEnvelope(rec: WakeEnvelopeInput, deliveredAt: number): string {
	const dueIso = new Date(rec.dueAt).toISOString();
	const deliveredIso = new Date(deliveredAt).toISOString();
	const overdueByMs = Math.max(0, deliveredAt - rec.dueAt);
	const overdueBy = overdueByMs > 0 ? formatDelay(overdueByMs) : "0s";
	const originCwd = rec.originCwd ?? rec.originCwdKey ?? "(unknown)";
	const originSession = rec.originSessionFile ?? "(unavailable)";
	const label = rec.label ? ` (${rec.label})` : "";
	return [
		"[Agent Scheduler Wake-Up]",
		`Schedule: #${rec.id}${label}`,
		`Due at: ${dueIso}`,
		`Delivered at: ${deliveredIso}`,
		`Overdue by: ${overdueBy} (${overdueByMs}ms)`,
		`Origin cwd: ${originCwd}`,
		`Origin session: ${originSession}`,
		"",
		"Task:",
		rec.message,
	].join("\n");
}

/** Format a schedule for display. */
export function formatSchedule(s: ScheduleRecord, now: number): string {
	const due = new Date(s.dueAt).toISOString();
	const delta = s.dueAt - now;
	const when =
		s.status === "pending"
			? delta > 0
				? `in ${formatDelay(delta)}`
				: `overdue by ${formatDelay(-delta)}`
			: "";
	const label = s.label ? ` ${JSON.stringify(s.label)}` : "";
	const overdue = s.overdue ? " (overdue)" : "";
	const reason = s.failureReason ? ` :: ${s.failureReason}` : "";
	return `#${s.id} [${s.status}]${overdue} due ${due}${when ? ` (${when})` : ""}${label}${reason}`;
}

/** Return an empty store. */
export function emptyStore(): SchedulerStore {
	return { version: 1, schedules: {}, nextSeq: 1 };
}

/** Validate/normalize a parsed store object, preserving new optional fields. */
export function normalizeStore(parsed: unknown): SchedulerStore {
	if (!parsed || typeof parsed !== "object") return emptyStore();
	const obj = parsed as Partial<SchedulerStore>;
	const store: SchedulerStore = {
		version: 1,
		schedules: {},
		nextSeq: typeof obj.nextSeq === "number" && obj.nextSeq > 0 ? obj.nextSeq : 1,
	};
	const records = obj.schedules;
	if (records && typeof records === "object") {
		for (const [id, rec] of Object.entries(records)) {
			if (!rec || typeof rec !== "object") continue;
			const r = rec as Partial<ScheduleRecord>;
			if (typeof r.id !== "string" || typeof r.dueAt !== "number") continue;
			store.schedules[id] = {
				id: r.id,
				message: typeof r.message === "string" ? r.message : "",
				label: r.label,
				dueAt: r.dueAt,
				createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
				status: (r.status as ScheduleStatus) || "pending",
				originCwdKey: typeof r.originCwdKey === "string" ? r.originCwdKey : "",
				originCwd: r.originCwd,
				originSessionFile: r.originSessionFile,
				createdBy: r.createdBy,
				updatedAt: r.updatedAt,
				claimToken: r.claimToken,
				triggeredAt: r.triggeredAt,
				deliveredAt: r.deliveredAt,
				cancelledAt: r.cancelledAt,
				failureReason: r.failureReason,
				overdue: r.overdue,
				attempt: r.attempt,
			};
		}
	}
	return store;
}

/** Resolve a schedule id from a full id or a unique prefix.
 *  Returns `{ id }` on success or `{ error }` when missing/ambiguous. */
export function resolveScheduleId(
	store: SchedulerStore,
	input: string,
): { id: string } | { error: string } {
	const key = input.trim();
	if (!key) return { error: "id is required." };
	if (store.schedules[key]) return { id: key };
	const matches = Object.keys(store.schedules)
		.filter((id) => id.startsWith(key))
		.sort();
	if (matches.length === 1) return { id: matches[0] };
	if (matches.length === 0) return { error: `no schedule matching ${key}` };
	const shown = matches.slice(0, 5).join(", ");
	const more = matches.length > 5 ? "…" : "";
	return { error: `ambiguous id ${key}: ${shown}${more}` };
}

/** Prune terminal records older than RETENTION_MS and enforce MAX_RECORDS. */
export function pruneStore(store: SchedulerStore, now = Date.now()): void {
	const keep: ScheduleRecord[] = [];
	const terminal: ScheduleRecord[] = [];
	for (const rec of Object.values(store.schedules)) {
		if (rec.status === "pending" || rec.status === "delivering") {
			keep.push(rec);
		} else {
			terminal.push(rec);
		}
	}
	// Drop terminal records past retention.
	const fresh = terminal.filter((r) => {
		const ts = r.deliveredAt ?? r.cancelledAt ?? r.createdAt;
		return now - ts < RETENTION_MS;
	});
	// Enforce hard cap, dropping oldest terminal first.
	if (fresh.length > MAX_RECORDS) {
		fresh.sort(
			(a, b) =>
				(a.deliveredAt ?? a.cancelledAt ?? a.createdAt) -
				(b.deliveredAt ?? b.cancelledAt ?? b.createdAt),
		);
		fresh.splice(0, fresh.length - MAX_RECORDS);
	}
	const next: Record<string, ScheduleRecord> = {};
	for (const r of [...keep, ...fresh]) next[r.id] = r;
	store.schedules = next;
}

// ---------------------------------------------------------------------------
// Storage paths
// ---------------------------------------------------------------------------

/** Resolve store + lock paths under the agent dir. Exported for tests. */
export function getSchedulerPaths(): { dir: string; store: string; lock: string } {
	const dir = getAgentDir();
	return {
		dir,
		store: join(dir, "scheduler.json"),
		lock: join(dir, "scheduler.lock"),
	};
}

function randomHex(bytes: number): string {
	return randomBytes(bytes).toString("hex");
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Advisory lock around a critical section. Acquires `lockPath` with O_EXCL,
 * breaking stale locks older than LOCK_STALE_MS. Releases (unlinks) in finally.
 */
async function withLock<T>(
	lockPath: string,
	fn: () => Promise<T>,
	timeoutMs: number = LOCK_TIMEOUT_MS,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	type Handle = Awaited<ReturnType<typeof fsp.open>>;
	let fh: Handle | undefined;
	for (;;) {
		try {
			fh = await fsp.open(lockPath, "wx");
			break;
		} catch (e) {
			const err = e as NodeJS.ErrnoException;
			if (err.code !== "EEXIST") throw err;
			// Stale lock break.
			try {
				const stat = await fsp.stat(lockPath);
				if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
					await fsp.unlink(lockPath).catch(() => {});
					continue;
				}
			} catch {
				/* ignore */
			}
			if (Date.now() > deadline) {
				throw new Error(`agent-scheduler: lock acquire timed out: ${lockPath}`);
			}
			await sleep(LOCK_POLL_MS);
		}
	}
	try {
		await fh.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
		return await fn();
	} finally {
		try {
			await fh.close();
		} catch {
			/* ignore */
		}
		await fsp.unlink(lockPath).catch(() => {});
	}
}

/** Read the store without locking (rename makes reads atomic). */
async function readStore(): Promise<SchedulerStore> {
	const { store: storePath, dir } = getSchedulerPaths();
	try {
		await fsp.mkdir(dir, { recursive: true });
	} catch {
		/* ignore */
	}
	try {
		const raw = await fsp.readFile(storePath, "utf8");
		return normalizeStore(JSON.parse(raw));
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return emptyStore();
		// Corrupt: back it up so we don't lose data silently, then start fresh.
		try {
			await fsp.copyFile(storePath, `${storePath}.corrupt.${Date.now()}`);
		} catch {
			/* ignore */
		}
		return emptyStore();
	}
}

/** Atomic write: unique temp file -> rename. Caller must hold the lock. */
async function writeStoreAtomic(store: SchedulerStore): Promise<void> {
	const { store: storePath, dir } = getSchedulerPaths();
	pruneStore(store);
	await fsp.mkdir(dir, { recursive: true });
	const data = JSON.stringify(store, null, 2);
	const tmp = `${storePath}.${process.pid}.${randomHex(6)}.tmp`;
	await fsp.writeFile(tmp, data, "utf8");
	await fsp.rename(tmp, storePath);
}

/** Lock + read + mutate + write. */
async function mutateStore<T>(
	fn: (store: SchedulerStore) => Promise<T> | T,
): Promise<T> {
	const { lock: lockPath } = getSchedulerPaths();
	return withLock(lockPath, async () => {
		const store = await readStore();
		const result = await fn(store);
		await writeStoreAtomic(store);
		return result;
	});
}

/** Best-effort origin session file for new records. */
function sessionFileOf(ctx: ExtensionContext | undefined): string | undefined {
	if (!ctx) return undefined;
	try {
		return ctx.sessionManager?.getSessionFile();
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Runtime (session-scoped)
// ---------------------------------------------------------------------------

class SchedulerRuntime {
	/** Active timer handle (single, session-scoped). */
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** Deferred session-start drain handle (startup/new/resume). Tracked so it
	 *  is cleared on session_shutdown like the wake timer. Not cleared in
	 *  clearTimer() so a tool rearm during the drain window can't cancel it. */
	private drainTimer: ReturnType<typeof setTimeout> | undefined;
	/** Id the current timer is aimed at, for cancellation checks. */
	private armedId: string | undefined;
	/** Current session cwd, captured from session_start / tool ctx. */
	private cwd: string | undefined;
	/** Suppresses re-entrancy in the timer fire path. */
	private firing = false;
	/** Epoch ms captured at session_start; used to bound the startup drain. */
	private sessionStartAt: number | undefined;
	/** When set, pending records with dueAt <= this are suppressed (not armed
	 *  or timer-fired) for the rest of the session. Used to drop overdue
	 *  schedules that were already drained or should not fire on reload/fork. */
	private suppressOverdueDueAtOrBefore: number | undefined;

	constructor(private readonly pi: ExtensionAPI) {}

	// -- lifecycle ---------------------------------------------------------

	onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): void {
		this.cwd = ctx.cwd;
		const startedAt = Date.now();
		this.sessionStartAt = startedAt;
		// Inspect the start reason to decide how overdue schedules are handled.
		const reason = event.reason;
		if (reason === "reload" || reason === "fork") {
			// Recover crashed deliveries, then suppress everything due before the
			// session-start instant and arm only future schedules. We do NOT
			// drain on reload/fork: the prior session already had its chance and
			// re-draining could double-deliver into a forked conversation.
			this.suppressOverdueDueAtOrBefore = startedAt - 1;
			this.safeAsync("recoverStuck", () => this.recoverStuck(), ctx);
			this.safeAsync("armTimer", () => this.armTimer(ctx), ctx);
		} else {
			// startup / new / resume: recover, then defer the overdue drain so the
			// UI/runtime settles. Drain only schedules due at the session-start
			// instant, then suppress any leftover overdue and arm.
			this.safeAsync("recoverStuck", () => this.recoverStuck(), ctx);
			this.drainTimer = setTimeout(() => {
				this.drainTimer = undefined;
				this.safeAsync("drainOverdue", async () => {
					await this.drainOverdue(ctx, startedAt);
					// Suppress any overdue that the (batched) drain could not deliver.
					this.suppressOverdueDueAtOrBefore = startedAt;
					await this.armTimer(ctx);
				}, ctx);
			}, SESSION_START_DRAIN_DELAY_MS);
		}
	}

	onSessionShutdown(): void {
		this.clearTimer();
		if (this.drainTimer) {
			clearTimeout(this.drainTimer);
			this.drainTimer = undefined;
		}
		this.cwd = undefined;
		this.sessionStartAt = undefined;
		this.suppressOverdueDueAtOrBefore = undefined;
	}

	private clearTimer(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
			this.armedId = undefined;
		}
	}

	/** Re-arm the session timer after external state changes (tool/command). */
	rearm(ctx?: ExtensionContext): void {
		this.safeAsync("armTimer", () => this.armTimer(ctx));
	}

	/** Fire-and-forget an async operation, surfacing failures via UI. */
	private safeAsync(
		label: string,
		fn: () => Promise<unknown>,
		ctx?: ExtensionContext,
	): void {
		void fn().catch((e) => {
			this.notify(
				ctx,
				`agent-scheduler ${label} failed: ${(e as Error).message}`,
				"error",
			);
		});
	}

	// -- scoping -----------------------------------------------------------

	private cwdKey(): string | undefined {
		return this.cwd ? normalizeCwdKey(this.cwd) : undefined;
	}

	/** True when a dueAt is suppressed for this session. */
	private isSuppressed(dueAt: number): boolean {
		return (
			typeof this.suppressOverdueDueAtOrBefore === "number" &&
			dueAt <= this.suppressOverdueDueAtOrBefore
		);
	}

	// -- recovery ----------------------------------------------------------

	/** Mark `delivering` records older than STUCK_DELIVERING_MS as failed. */
	private async recoverStuck(): Promise<void> {
		const now = Date.now();
		await mutateStore((store) => {
			for (const rec of Object.values(store.schedules)) {
				if (
					rec.status === "delivering" &&
					typeof rec.triggeredAt === "number" &&
					now - rec.triggeredAt > STUCK_DELIVERING_MS
				) {
					rec.status = "failed";
					rec.failureReason = "delivery timed out (stuck delivering)";
					rec.updatedAt = now;
				}
			}
		});
	}

	// -- drain -------------------------------------------------------------

	/** Deliver overdue pending schedules for the current cwd (max MAX_DRAIN_BATCH).
	 *
	 *  Only records with `dueAt <= cutoff` are drained. The unlocked read here is
	 *  safe: `claimDeliver` re-checks status and atomically claims under the
	 *  advisory lock, so concurrent sessions/timers enumerating the same records
	 *  can never double-deliver — at most one claimer wins the pending->delivering
	 *  transition for each id. */
	private async drainOverdue(ctx: ExtensionContext, cutoff: number): Promise<void> {
		const key = this.cwdKey();
		if (!key) return;
		const due = await readStore();
		const overdue = Object.values(due.schedules)
			.filter(
				(r) => r.status === "pending" && r.originCwdKey === key && r.dueAt <= cutoff,
			)
			.sort((a, b) => a.dueAt - b.dueAt)
			.slice(0, MAX_DRAIN_BATCH);
		for (const rec of overdue) {
			await this.claimDeliver(rec.id, true);
		}
		if (overdue.length > 0) {
			this.notify(ctx, `Delivered ${overdue.length} overdue schedule(s).`, "info");
		}
	}

	// -- delivery ----------------------------------------------------------

	/** Claim a pending schedule (pending -> delivering) and deliver its message.
	 *  Claim is atomic and mints a `claimToken`; finalization (delivered/failed)
	 *  only proceeds when the record is still `delivering` and the token matches. */
	private async claimDeliver(id: string, overdue: boolean): Promise<void> {
		const claimToken = randomHex(8);
		const claimed = await mutateStore((store) => {
			const rec = store.schedules[id];
			if (!rec || rec.status !== "pending") return null;
			rec.status = "delivering";
			rec.triggeredAt = Date.now();
			rec.attempt = (rec.attempt ?? 0) + 1;
			rec.overdue = overdue || rec.overdue;
			rec.claimToken = claimToken;
			rec.updatedAt = Date.now();
			return {
				id: rec.id,
				message: rec.message,
				label: rec.label,
				dueAt: rec.dueAt,
				originCwd: rec.originCwd,
				originCwdKey: rec.originCwdKey,
				originSessionFile: rec.originSessionFile,
			} satisfies WakeEnvelopeInput;
		});
		if (!claimed) return; // already claimed/cancelled/missing
		const deliveredAt = Date.now();
		try {
			const envelope = buildWakeEnvelope(claimed, deliveredAt);
			// followUp never interrupts an active turn; triggers a turn if idle.
			// Must settle before we mark delivered. Note: the ExtensionAPI surface
			// types sendUserMessage as void and the runtime binding may swallow the
			// rejection, so the failed-on-reject path below is best-effort.
			await this.pi.sendUserMessage(envelope, { deliverAs: "followUp" });
		} catch (e) {
			await mutateStore((store) => {
				const rec = store.schedules[id];
				if (rec && rec.status === "delivering" && rec.claimToken === claimToken) {
					rec.status = "failed";
					rec.failureReason =
						e instanceof Error && e.message ? e.message : String(e ?? "delivery failed");
					rec.updatedAt = Date.now();
				}
			});
			return;
		}
		await mutateStore((store) => {
			const rec = store.schedules[id];
			if (rec && rec.status === "delivering" && rec.claimToken === claimToken) {
				rec.status = "delivered";
				rec.deliveredAt = Date.now();
				rec.updatedAt = Date.now();
			}
		});
	}

	// -- timer -------------------------------------------------------------

	/** Arm the single session timer at the earliest pending schedule for cwd. */
	private async armTimer(ctx?: ExtensionContext): Promise<void> {
		this.clearTimer();
		const key = this.cwdKey();
		if (!key) return;
		const store = await readStore();
		const earliest = Object.values(store.schedules)
			.filter(
				(r) =>
					r.status === "pending" &&
					r.originCwdKey === key &&
					!this.isSuppressed(r.dueAt),
			)
			.sort((a, b) => a.dueAt - b.dueAt)[0];
		if (!earliest) return;
		const now = Date.now();
		const delta = earliest.dueAt - now;
		const delay = delta <= 0 ? 0 : Math.min(delta, MAX_TIMER_MS);
		this.armedId = earliest.id;
		this.timer = setTimeout(() => {
			this.safeAsync("onTimerFire", () => this.onTimerFire(), ctx);
		}, delay);
		// Don't keep the event loop alive solely for a wake-up timer when Pi is
		// otherwise idle in print/headless modes — but .unref would prevent
		// delivery in long-running headless runs, so we keep it referenced.
	}

	private async onTimerFire(): Promise<void> {
		if (this.firing) return;
		this.firing = true;
		this.timer = undefined;
		this.armedId = undefined;
		try {
			const key = this.cwdKey();
			if (!key) return;
			const store = await readStore();
			const earliest = Object.values(store.schedules)
				.filter(
					(r) =>
						r.status === "pending" &&
						r.originCwdKey === key &&
						!this.isSuppressed(r.dueAt),
				)
				.sort((a, b) => a.dueAt - b.dueAt)[0];
			if (!earliest) return;
			const now = Date.now();
			if (earliest.dueAt > now) {
				// Not yet due (clock drift / earlier record changed). Re-arm.
				await this.armTimer();
				return;
			}
			await this.claimDeliver(earliest.id, false);
		} finally {
			this.firing = false;
			// Re-arm for the next pending schedule.
			this.safeAsync("armTimer", () => this.armTimer());
		}
	}

	// -- tool actions ------------------------------------------------------

	async executeTool(
		params: AgentSchedulerInput,
		ctx: ExtensionContext,
	): Promise<{ content: { type: "text"; text: string }[]; details: unknown }> {
		// Keep cwd fresh even if a tool runs before session_start wired it.
		if (!this.cwd) this.cwd = ctx.cwd;

		switch (params.action) {
			case "schedule":
				return this.actionSchedule(params, ctx);
			case "list":
				return this.actionList(params);
			case "get":
				return this.actionGet(params);
			case "cancel":
				return this.actionCancel(params, ctx);
			default:
				return textResult(`Unknown action: ${params.action as string}`);
		}
	}

	private async actionSchedule(
		params: AgentSchedulerInput,
		ctx: ExtensionContext,
	) {
		const message = (params.message ?? "").trim();
		if (!message) return textResult("Error: message is required for schedule.");
		const now = Date.now();
		let dueAt: number;
		try {
			const computed = computeDueAt(params, now);
			dueAt = nudgeDueAt(computed.dueAt, now);
		} catch (e) {
			return textResult(`Error: ${(e as Error).message}`);
		}
		const originCwdKey = normalizeCwdKey(ctx.cwd);
		const originSessionFile = sessionFileOf(ctx);
		const created = await mutateStore((store) => {
			const pendingForCwd = Object.values(store.schedules).filter(
				(r) => r.status === "pending" && r.originCwdKey === originCwdKey,
			).length;
			if (pendingForCwd >= MAX_PENDING_PER_CWD) {
				return {
					error: `Backlog limit reached (${MAX_PENDING_PER_CWD} pending for this cwd).`,
				};
			}
			const id = `sched-${store.nextSeq.toString(36)}-${randomHex(3)}`;
			store.nextSeq += 1;
			const rec: ScheduleRecord = {
				id,
				message,
				label: params.label,
				dueAt,
				createdAt: now,
				status: "pending",
				originCwdKey,
				originCwd: ctx.cwd,
				originSessionFile,
				createdBy: "tool",
				updatedAt: now,
			};
			store.schedules[id] = rec;
			return { id, dueAt };
		});
		if ("error" in created) {
			return textResult(`Error: ${created.error}`);
		}
		// Re-arm so the new earliest schedule is targeted.
		this.safeAsync("armTimer", () => this.armTimer(ctx), ctx);
		const iso = new Date(created.dueAt).toISOString();
		const inStr = formatDelay(created.dueAt - now);
		return textResult(
			`Scheduled #${created.id} for ${iso} (in ${inStr}).` +
				(params.label ? ` Label: ${JSON.stringify(params.label)}` : "") +
				`\nMessage: ${message}`,
			{ id: created.id, dueAt: created.dueAt, label: params.label },
		);
	}

	private async actionList(params: AgentSchedulerInput) {
		const status = params.status ?? "pending";
		const scope = params.scope ?? "current";
		const key = this.cwdKey();
		const store = await readStore();
		const now = Date.now();
		let records = Object.values(store.schedules).sort(
			(a, b) => a.dueAt - b.dueAt,
		);
		if (scope === "current" && key) {
			records = records.filter((r) => r.originCwdKey === key);
		}
		if (status !== "all") {
			records = records.filter((r) => r.status === status);
		}
		if (records.length === 0) {
			return textResult(`No ${status === "all" ? "" : status + " "}schedules${scope === "current" ? " for this cwd" : ""}.`);
		}
		const lines = records.map((r) => formatSchedule(r, now));
		return textResult(lines.join("\n"), { count: records.length });
	}

	private async actionGet(params: AgentSchedulerInput) {
		const idInput = params.id?.trim();
		if (!idInput) return textResult("Error: id is required for get.");
		const store = await readStore();
		const resolved = resolveScheduleId(store, idInput);
		if ("error" in resolved) return textResult(`Error: ${resolved.error}`);
		const rec = store.schedules[resolved.id];
		const now = Date.now();
		return textResult(
			[
				formatSchedule(rec, now),
				`message: ${rec.message}`,
				`cwd: ${rec.originCwd ?? rec.originCwdKey}`,
				`created: ${new Date(rec.createdAt).toISOString()}`,
				rec.originSessionFile ? `origin session: ${rec.originSessionFile}` : "",
				rec.createdBy ? `created by: ${rec.createdBy}` : "",
				rec.triggeredAt ? `triggered: ${new Date(rec.triggeredAt).toISOString()}` : "",
				rec.deliveredAt ? `delivered: ${new Date(rec.deliveredAt).toISOString()}` : "",
				rec.cancelledAt ? `cancelled: ${new Date(rec.cancelledAt).toISOString()}` : "",
				rec.failureReason ? `failure: ${rec.failureReason}` : "",
			]
				.filter(Boolean)
				.join("\n"),
			rec,
		);
	}

	private async actionCancel(params: AgentSchedulerInput, ctx: ExtensionContext) {
		const idInput = params.id?.trim();
		if (!idInput) return textResult("Error: id is required for cancel.");
		const result = await mutateStore((store) => {
			const resolved = resolveScheduleId(store, idInput);
			if ("error" in resolved) return { ok: false as const, reason: resolved.error };
			const rec = store.schedules[resolved.id];
			if (rec.status === "cancelled") return { ok: false as const, reason: "already cancelled" };
			if (rec.status === "delivered") return { ok: false as const, reason: "already delivered" };
			if (rec.status === "delivering") return { ok: false as const, reason: "currently delivering" };
			rec.status = "cancelled";
			rec.cancelledAt = Date.now();
			rec.updatedAt = Date.now();
			return { ok: true as const, id: resolved.id };
		});
		if (result.ok) {
			this.safeAsync("armTimer", () => this.armTimer(ctx), ctx);
			this.notify(ctx, `Cancelled schedule #${result.id}.`, "info");
			return textResult(`Cancelled schedule #${result.id}.`, { id: result.id });
		}
		return textResult(`Cannot cancel #${idInput}: ${result.reason}.`);
	}

	// -- ui ----------------------------------------------------------------

	private notify(ctx: ExtensionContext | undefined, message: string, type: "info" | "warning" | "error"): void {
		if (!ctx) return;
		try {
			if (ctx.hasUI) ctx.ui.notify(message, type);
		} catch {
			/* ignore */
		}
	}
}

function textResult(
	text: string,
	details?: unknown,
): { content: { type: "text"; text: string }[]; details: unknown } {
	return { content: [{ type: "text", text }], details: details ?? {} };
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function agentScheduler(pi: ExtensionAPI): void {
	const runtime = new SchedulerRuntime(pi);

	// session_start: capture cwd, recover stuck deliveries, then drain/arm per
	// the start reason (see onSessionStart). Never start the timer in factory.
	pi.on("session_start", async (event, ctx) => {
		runtime.onSessionStart(event, ctx);
	});

	// session_shutdown: clear the session-scoped timer. Persisted state survives.
	pi.on("session_shutdown", async () => {
		runtime.onSessionShutdown();
	});

	// LLM-callable tool.
	pi.registerTool({
		name: "agent_scheduler",
		label: "Agent Scheduler",
		description:
			"Schedule future agent wake-ups. Actions: schedule (create a future " +
			"user message via exactly one of at/delaySeconds/delayMinutes/delayHours/" +
			"delayDays + message), list, get, cancel. Schedule ids accept unique " +
			"prefixes for get/cancel. Schedules are scoped to the cwd where created.",
		promptSnippet: "Schedule delayed agent wake-ups that re-inject a user message later",
		promptGuidelines: [
			"Use agent_scheduler to wake yourself up later to check on long-running work " +
				"(downloads, subagents, builds) instead of staying active.",
		],
		parameters: AgentSchedulerParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return runtime.executeTool(params, ctx);
		},
	});

	// /schedule-agent <delay> <message>  e.g. /schedule-agent 10m check the download
	// Also: /schedule-agent 2h -- check the download
	//       /schedule-agent at 2026-06-20T12:00:00Z check the download
	//       /schedule-agent at 2026-06-20 12:00 -- check the download
	pi.registerCommand("schedule-agent", {
		description:
			"Schedule a future agent wake-up. Forms: /schedule-agent <delay> <message>, " +
			"/schedule-agent <delay> -- <message>, /schedule-agent at <iso> <message>, " +
			"/schedule-agent at <date> <time> [--] <message>. Delays like 10m, 2h, 1d, 30s.",
		handler: async (args, ctx) => {
			const parsed = parseScheduleArgs(args);
			if (!parsed) {
				ctx.ui.notify(
					"Usage: /schedule-agent <delay> <message> | <delay> -- <message> | " +
						"at <iso> <message> | at <date> <time> [--] <message>",
					"warning",
				);
				return;
			}
			const now = Date.now();
			const dueAt =
				parsed.source === "relative"
					? nudgeDueAt(now + parsed.delayMs, now)
					: nudgeDueAt(parsed.dueAt, now);
			const originCwdKey = normalizeCwdKey(ctx.cwd);
			const originSessionFile = sessionFileOf(ctx);
			const created = await mutateStore((store) => {
				const pendingForCwd = Object.values(store.schedules).filter(
					(r) => r.status === "pending" && r.originCwdKey === originCwdKey,
				).length;
				if (pendingForCwd >= MAX_PENDING_PER_CWD) {
					return { error: `Backlog limit reached (${MAX_PENDING_PER_CWD} pending).` };
				}
				const id = `sched-${store.nextSeq.toString(36)}-${randomHex(3)}`;
				store.nextSeq += 1;
				store.schedules[id] = {
					id,
					message: parsed.message,
					dueAt,
					createdAt: now,
					status: "pending",
					originCwdKey,
					originCwd: ctx.cwd,
					originSessionFile,
					createdBy: "slash",
					updatedAt: now,
				};
				return { id, dueAt };
			});
			if ("error" in created) {
				ctx.ui.notify(created.error ?? "Scheduling failed", "error");
				return;
			}
			ctx.ui.notify(
				`Scheduled #${created.id} for ${new Date(created.dueAt).toISOString()} ` +
					`(in ${formatDelay(created.dueAt - now)}).`,
				"info",
			);
			runtime.rearm(ctx);
		},
	});

	// /schedules [all]  — list pending (or all) schedules
	pi.registerCommand("schedules", {
		description: "List pending schedules (or /schedules all for every status/cwd)",
		handler: async (args, ctx) => {
			const wantAll = args.trim() === "all";
			const store = await readStore();
			const now = Date.now();
			const key = normalizeCwdKey(ctx.cwd);
			let records = Object.values(store.schedules).sort((a, b) => a.dueAt - b.dueAt);
			if (!wantAll) {
				records = records.filter(
					(r) => r.status === "pending" && r.originCwdKey === key,
				);
			}
			if (records.length === 0) {
				ctx.ui.notify(
					wantAll ? "No schedules stored." : "No pending schedules for this cwd.",
					"info",
				);
				return;
			}
			const lines = records.map((r) => formatSchedule(r, now));
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// /cancel-schedule <id|prefix>
	pi.registerCommand("cancel-schedule", {
		description:
			"Cancel a scheduled wake-up by id or unique prefix " +
			"(e.g. /cancel-schedule sched-abc)",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				ctx.ui.notify("Usage: /cancel-schedule <id|prefix>", "warning");
				return;
			}
			const result = await mutateStore((store) => {
				const resolved = resolveScheduleId(store, input);
				if ("error" in resolved) return { ok: false as const, reason: resolved.error };
				const rec = store.schedules[resolved.id];
				if (rec.status === "cancelled") return { ok: false as const, reason: "already cancelled" };
				if (rec.status === "delivered") return { ok: false as const, reason: "already delivered" };
				if (rec.status === "delivering") return { ok: false as const, reason: "currently delivering" };
				rec.status = "cancelled";
				rec.cancelledAt = Date.now();
				rec.updatedAt = Date.now();
				return { ok: true as const, id: resolved.id };
			});
			if (result.ok) {
				ctx.ui.notify(`Cancelled schedule #${result.id}.`, "info");
				runtime.rearm(ctx);
			} else {
				ctx.ui.notify(`Cannot cancel #${input}: ${result.reason}.`, "warning");
			}
		},
	});
}
