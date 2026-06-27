/**
 * Telegram ↔ Pi Active-Session Integration
 * ========================================
 *
 * Global Pi extension that bridges a Telegram bot to the *active* Pi session.
 * Telegram-origin text appears as a visible, labelled, neutralized user message
 * in the active TUI/RPC session, and the assistant reply for a Telegram-origin
 * prompt is mirrored back to Telegram as plaintext.
 *
 * Security invariants (see agent/extensions/telegram-pi/intake.md):
 *  - The bot token is NEVER printed, logged, returned by status/tool, or passed
 *    as a process argument. Env var (`TELEGRAM_BOT_TOKEN`) is preferred; an
 *    optional 0600 `secret.token` file is used only as a fallback.
 *  - The `telegram_pi` tool exposes only non-secret actions.
 *  - Only private/group/supergroup text updates whose `from.id` is in the
 *    allowlist are handled. Group/forum-topic visibility can depend on BotFather
 *    privacy settings: disable privacy to see all group messages, or have users
 *    mention the bot, use commands, or reply to bot messages.
 *  - Only `message.text` updates are handled; everything else is ignored.
 *  - Outgoing messages are plaintext (no `parse_mode`).
 *  - `send_photo` uploads local images via multipart/form-data only after
 *    magic-byte validation (JPEG/PNG/WebP), size <=10MB, and symlink rejection;
 *    requires an explicit paired chat, never logs file contents, and surfaces
 *    only the basename in errors. No `parse_mode` on captions.
 *  - Reply mirroring is request-id correlated and fail-closed.
 *  - Offset is persisted only AFTER delivery/ignore.
 *  - Polling is abortable with exponential backoff, calls `deleteWebhook`, and
 *    handles HTTP 409 (conflict) without crashing.
 *  - A heartbeat/advisory lock prevents the boot daemon from competing with an
 *    active TUI session.
 *  - No agent-scheduler file is touched.
 *
 * Background resources (polling, heartbeat timer) start only on `session_start`
 * or from commands/tools — never in the factory.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import {
	type AgentEndEvent,
	type BeforeAgentStartEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionStartEvent,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join, resolve, basename } from "node:path";
import { Type, type Static } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bot API base. The token is appended to URLs but never logged. */
const BOT_API_BASE = "https://api.telegram.org/bot";
/** Env var read first for the bot token. */
const ENV_TOKEN = "TELEGRAM_BOT_TOKEN";
/** Env var for a comma-separated allowlist of Telegram `from.id` values. */
const ENV_ALLOWLIST = "TELEGRAM_ALLOWED_FROM";
/** Env var for the paired chat id (optional). */
const ENV_CHAT_ID = "TELEGRAM_CHAT_ID";

const TELEGRAM_MAX_TEXT = 4096;
const TELEGRAM_MAX_CAPTION = 1024; // Telegram photo caption limit (NOT 4096)
const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // Telegram photo upload limit
const PHOTO_UPLOAD_TIMEOUT_MS = 60_000; // multipart upload abort timeout
const LONG_POLL_TIMEOUT = 30; // seconds
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_STALE_MS = 60_000; // daemon treats heartbeat older than this as inactive
const LOCK_STALE_MS = 60_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 50;
const MAX_INCOMING_TEXT = 4_000; // cap neutralized incoming text

const STATE_VERSION = 1;

// Supported image formats (magic-byte validation). Only these are uploadable
// via send_photo; prevents accidental upload of renamed secret files.
// WebP uses the RIFF container, so we additionally verify the 'WEBP' FourCC at
// offset 8 (RIFF alone is shared with WAV/AVI).
const IMAGE_MAGIC: {
	mime: string;
	bytes: { off: number; bytes: number[] }[];
}[] = [
	{ mime: "image/jpeg", bytes: [{ off: 0, bytes: [0xff, 0xd8, 0xff] }] },
	{ mime: "image/png", bytes: [{ off: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }] },
	{
		mime: "image/webp",
		bytes: [
			{ off: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // 'RIFF'
			{ off: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // 'WEBP'
		],
	},
];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Runtime directory: <agentDir>/telegram-pi (i.e. ~/.pi/agent/telegram-pi). */
function runtimeDir(): string {
	return join(getAgentDir(), "telegram-pi");
}

function paths() {
	const dir = runtimeDir();
	return {
		dir,
		state: join(dir, "state.json"),
		lock: join(dir, "state.lock"),
		secret: join(dir, "secret.token"),
		heartbeat: join(dir, "heartbeat.json"),
		activeSession: join(dir, "active-session.json"),
		logs: join(dir, "logs"),
		daemon: join(dir, "daemon.mjs"),
		installScript: join(dir, "install-windows-task.ps1"),
		uninstallScript: join(dir, "uninstall-windows-task.ps1"),
	};
}

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

interface TelegramState {
	version: number;
	enabled: boolean;
	offset: number;
	pairedChatId: number | null;
	pairedThreadId: number | null;
	pairedFromId: number | null;
	allowlist: number[];
	lastSeenFromId: number | null;
	lastSeenFromName: string;
	lastSeenChatId: number | null;
	lastSeenThreadId: number | null;
	lastSeenIsTopicMessage: boolean;
	lastError: string; // redacted
	polling: boolean;
}

function emptyState(): TelegramState {
	return {
		version: STATE_VERSION,
		enabled: false,
		offset: 0,
		pairedChatId: null,
		pairedThreadId: null,
		pairedFromId: null,
		allowlist: [],
		lastSeenFromId: null,
		lastSeenFromName: "",
		lastSeenChatId: null,
		lastSeenThreadId: null,
		lastSeenIsTopicMessage: false,
		lastError: "",
		polling: false,
	};
}

function normalizeState(parsed: unknown): TelegramState {
	const base = emptyState();
	if (!parsed || typeof parsed !== "object") return base;
	const o = parsed as Partial<TelegramState>;
	return {
		version: STATE_VERSION,
		enabled: Boolean(o.enabled),
		offset: typeof o.offset === "number" && o.offset >= 0 ? o.offset : 0,
		pairedChatId: typeof o.pairedChatId === "number" ? o.pairedChatId : null,
		pairedThreadId: positiveThreadId(o.pairedThreadId) ?? null,
		pairedFromId: typeof o.pairedFromId === "number" ? o.pairedFromId : null,
		allowlist: Array.isArray(o.allowlist)
			? o.allowlist.filter((x): x is number => typeof x === "number" && Number.isFinite(x))
			: [],
		lastSeenFromId: typeof o.lastSeenFromId === "number" ? o.lastSeenFromId : null,
		lastSeenFromName: typeof o.lastSeenFromName === "string" ? o.lastSeenFromName : "",
		lastSeenChatId: typeof o.lastSeenChatId === "number" ? o.lastSeenChatId : null,
		lastSeenThreadId: positiveThreadId(o.lastSeenThreadId) ?? null,
		lastSeenIsTopicMessage: Boolean(o.lastSeenIsTopicMessage),
		lastError: typeof o.lastError === "string" ? o.lastError : "",
		polling: false, // never restore live-polling flag from disk
	};
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** Redact the bot token (and any Bot API URL embedding it) from a string. */
function redact(text: string, token: string | undefined): string {
	if (!text) return text;
	let out = text;
	if (token && token.length >= 8) {
		// Replace the token wherever it appears, and the canonical Bot API URL.
		out = out.split(token).join("<redacted-token>");
		out = out.replace(/https?:\/\/api\.telegram\.org\/bot[^\s/"']+/gi, "<redacted-bot-api-url>");
	}
	// Also scrub any lingering bot/<token> style leakage without a known token.
	out = out.replace(/https?:\/\/api\.telegram\.org\/bot[0-9]+:[A-Za-z0-9_-]+/gi, "<redacted-bot-api-url>");
	return out;
}

// ---------------------------------------------------------------------------
// Locking + atomic state I/O
// ---------------------------------------------------------------------------

function randomHex(bytes: number): string {
	return randomBytes(bytes).toString("hex");
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function withLock<T>(lockPath: string, fn: () => Promise<T> | T): Promise<T> {
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		let fh: Awaited<ReturnType<typeof fsp.open>> | undefined;
		try {
			fh = await fsp.open(lockPath, "wx");
			try {
				await fh.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
			} finally {
				try {
					await fh.close();
				} catch {
					/* ignore */
				}
			}
			break;
		} catch (e) {
			const err = e as NodeJS.ErrnoException;
			if (err.code !== "EEXIST") throw err;
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
				throw new Error(`telegram-pi: lock acquire timed out: ${lockPath}`);
			}
			await sleep(LOCK_POLL_MS);
		}
	}
	try {
		return await fn();
	} finally {
		await fsp.unlink(lockPath).catch(() => {});
	}
}

async function ensureDir(): Promise<void> {
	const { dir, logs } = paths();
	await fsp.mkdir(dir, { recursive: true }).catch(() => {});
	await fsp.mkdir(logs, { recursive: true }).catch(() => {});
}

async function readState(): Promise<TelegramState> {
	const { state: statePath, dir } = paths();
	await fsp.mkdir(dir, { recursive: true }).catch(() => {});
	try {
		const raw = await fsp.readFile(statePath, "utf8");
		return normalizeState(JSON.parse(raw));
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return emptyState();
		try {
			await fsp.copyFile(statePath, `${statePath}.corrupt.${Date.now()}`);
		} catch {
			/* ignore */
		}
		return emptyState();
	}
}

async function writeStateAtomic(state: TelegramState): Promise<void> {
	const { state: statePath, dir } = paths();
	await fsp.mkdir(dir, { recursive: true });
	const data = JSON.stringify(state, null, 2);
	const tmp = `${statePath}.${process.pid}.${randomHex(6)}.tmp`;
	await fsp.writeFile(tmp, data, "utf8");
	await fsp.rename(tmp, statePath);
}

async function mutateState<T>(fn: (state: TelegramState) => Promise<T> | T): Promise<T> {
	const { lock: lockPath } = paths();
	return withLock(lockPath, async () => {
		const state = await readState();
		const result = await fn(state);
		await writeStateAtomic(state);
		return result;
	});
}

// ---------------------------------------------------------------------------
// Token handling
// ---------------------------------------------------------------------------

/** Resolve the bot token. Env var first; then 0600 secret file. Never logged. */
async function resolveToken(): Promise<string | undefined> {
	const env = process.env[ENV_TOKEN];
	if (env && env.trim()) return env.trim();
	const { secret: secretPath } = paths();
	try {
		const raw = await fsp.readFile(secretPath, "utf8");
		const tok = raw.trim();
		return tok || undefined;
	} catch {
		return undefined;
	}
}

/** Persist a token to the 0600 secret file (only when env var is absent). */
async function storeToken(token: string): Promise<void> {
	const { secret: secretPath, dir } = paths();
	await fsp.mkdir(dir, { recursive: true });
	const tmp = `${secretPath}.${process.pid}.tmp`;
	await fsp.writeFile(tmp, token.trim() + "\n", "utf8");
	// chmod 0600 (best effort on Windows it is a no-op but harmless).
	try {
		await fsp.chmod(tmp, 0o600);
	} catch {
		/* ignore */
	}
	await fsp.rename(tmp, secretPath);
	try {
		await fsp.chmod(secretPath, 0o600);
	} catch {
		/* ignore */
	}
}

async function hasStoredToken(): Promise<boolean> {
	const { secret: secretPath } = paths();
	try {
		const raw = await fsp.readFile(secretPath, "utf8");
		return raw.trim().length > 0;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Heartbeat (advisory lock for the daemon)
// ---------------------------------------------------------------------------

interface Heartbeat {
	pid: number;
	mode: string;
	ts: number;
	at?: number;
	cwd: string;
}

async function writeHeartbeat(mode: string, cwd: string): Promise<void> {
	const { heartbeat: hbPath, dir } = paths();
	await fsp.mkdir(dir, { recursive: true }).catch(() => {});
	const hb: Heartbeat = { pid: process.pid, mode, ts: Date.now(), at: Date.now(), cwd };
	const tmp = `${hbPath}.${process.pid}.tmp`;
	await fsp.writeFile(tmp, JSON.stringify(hb), "utf8");
	await fsp.rename(tmp, hbPath).catch(() => {});
}

async function clearHeartbeat(): Promise<void> {
	const { heartbeat: hbPath } = paths();
	await fsp.unlink(hbPath).catch(() => {});
}

async function readHeartbeat(): Promise<Heartbeat | undefined> {
	const { heartbeat: hbPath } = paths();
	try {
		const raw = await fsp.readFile(hbPath, "utf8");
		return JSON.parse(raw) as Heartbeat;
	} catch {
		return undefined;
	}
}

interface ActiveSessionClaim {
	pid: number;
	mode: string;
	cwd: string;
	ts: number;
	reason: string;
}

async function readActiveSessionClaim(): Promise<ActiveSessionClaim | undefined> {
	const { activeSession } = paths();
	try {
		const raw = await fsp.readFile(activeSession, "utf8");
		const parsed = JSON.parse(raw) as Partial<ActiveSessionClaim>;
		if (typeof parsed.pid !== "number" || typeof parsed.ts !== "number") return undefined;
		return {
			pid: parsed.pid,
			mode: String(parsed.mode ?? ""),
			cwd: String(parsed.cwd ?? ""),
			ts: parsed.ts,
			reason: String(parsed.reason ?? ""),
		};
	} catch {
		return undefined;
	}
}

async function writeActiveSessionClaim(mode: string, cwd: string, reason: string): Promise<void> {
	const { activeSession, dir } = paths();
	await fsp.mkdir(dir, { recursive: true }).catch(() => {});
	const claim: ActiveSessionClaim = { pid: process.pid, mode, cwd, ts: Date.now(), reason };
	const tmp = `${activeSession}.${process.pid}.tmp`;
	await fsp.writeFile(tmp, JSON.stringify(claim), "utf8");
	await fsp.rename(tmp, activeSession).catch(() => {});
}

async function refreshActiveSessionClaimIfOwner(mode: string, cwd: string, reason: string): Promise<void> {
	const claim = await readActiveSessionClaim();
	if (claim && claim.pid !== process.pid && Date.now() - claim.ts <= HEARTBEAT_STALE_MS) return;
	await writeActiveSessionClaim(mode, cwd, reason);
}

async function clearActiveSessionClaimIfOwner(pid = process.pid): Promise<void> {
	const claim = await readActiveSessionClaim();
	if (!claim || claim.pid !== pid) return;
	const { activeSession } = paths();
	await fsp.unlink(activeSession).catch(() => {});
}

function isPidAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e: any) {
		return e?.code === "EPERM";
	}
}

/** True if a non-stale TUI/RPC heartbeat exists (daemon should yield). */
async function isActiveHeartbeat(): Promise<boolean> {
	const hb = await readHeartbeat();
	if (!hb) return false;
	const ts = hb.ts ?? hb.at ?? 0;
	return Date.now() - ts < HEARTBEAT_STALE_MS;
}

// ---------------------------------------------------------------------------
// Neutralization of incoming Telegram text
// ---------------------------------------------------------------------------

/** Strip control chars (keep \t and \n), collapse dangerous line separators,
 *  cap length. Returns the neutralized text. */
function neutralize(text: string): string {
	if (typeof text !== "string") return "";
	let out = text;
	// Remove Unicode line/paragraph separators (U+2028/U+2029) and other C0/C1
	// control chars except \t (\x09) and \n (\x0A).
	out = out.replace(/[\u2028\u2029]/g, " ");
	out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
	if (out.length > MAX_INCOMING_TEXT) out = out.slice(0, MAX_INCOMING_TEXT) + "…[truncated]";
	return out;
}

/** Build the visible, labelled user-message text injected into the session. */
function buildTelegramUserMessage(fromName: string, fromIdPrefix: string, text: string, requestId?: string): string {
	const safe = neutralize(text);
	const mirrorTag = requestId ? ` · mirror ${requestId}` : "";
	return `[Telegram · from ${fromName || "unknown"} · id ${fromIdPrefix}${mirrorTag}]\n${safe}`;
}

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const TelegramPiParams = Type.Object({
	action: StringEnum(
		["status", "send", "send_photo", "start", "stop", "takeover", "daemon_status", "list_chats", "setup", "pair"] as const,
		{
			description:
				"Non-secret actions only. status: runtime state; send: plaintext to paired chat; " +
				"send_photo: upload a local image (JPEG/PNG/WebP, <=10MB) to paired chat; " +
				"start/stop: control polling; takeover: make this session the active Telegram receiver; " +
				"daemon_status: heartbeat/daemon state; " +
				"list_chats: known chat id prefixes; " +
				"setup: one-shot setup from env vars (TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_FROM, TELEGRAM_CHAT_ID); " +
				"pair: pair the most recent Telegram sender.",
		},
	),
	text: Type.Optional(
		Type.String({ description: "Plaintext to send (action=send). No Markdown." }),
	),
	file: Type.Optional(
		Type.String({ description: "Absolute or cwd-relative path to a local image (action=send_photo)." }),
	),
	caption: Type.Optional(
		Type.String({ description: "Optional plaintext caption for the photo (action=send_photo). Max 1024 chars." }),
	),
	thread_id: Type.Optional(
		Type.Number({ description: "Optional Telegram forum topic message_thread_id for action=send/send_photo; positive integers only." }),
	),
});

type TelegramPiInput = Static<typeof TelegramPiParams>;

// ---------------------------------------------------------------------------
// Runtime (session-scoped)
// ---------------------------------------------------------------------------

class TelegramRuntime {
	/** Active long-poll AbortController. */
	private pollAbort: AbortController | undefined;
	/** True while the poll loop is running. */
	private polling = false;
	/** Heartbeat interval handle. */
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	/** Current session cwd. */
	private cwd = "";
	/** Current session mode. */
	private mode = "";

	/**
	 * Pending mirror correlation. Set when a Telegram-origin user message is
	 * injected; consumed by before_agent_start when that exact prompt begins. */
	private pendingMirrors: { chatId: number; threadId: number | undefined; requestId: string; promptText: string }[] = [];
	/**
	 * Active mirror for the in-flight agent turn. Set by before_agent_start when
	 * the prompt matches a pending Telegram-origin prompt; consumed by
	 * agent_end. If a different prompt starts, this is cleared (fail-closed). */
	private activeMirror: { chatId: number; threadId: number | undefined; requestId: string } | undefined;

	constructor(private readonly pi: ExtensionAPI) {}

	// -- lifecycle ---------------------------------------------------------

	onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): void {
		this.cwd = ctx.cwd;
		this.mode = ctx.mode;
		// Write an immediate heartbeat so the daemon can yield right away.
		void writeHeartbeat(ctx.mode, ctx.cwd).catch(() => {});
		this.heartbeatTimer = setInterval(() => {
			void writeHeartbeat(this.mode, this.cwd).catch(() => {});
			if (this.polling) {
				void refreshActiveSessionClaimIfOwner(this.mode, this.cwd, "heartbeat").catch(() => {});
			}
		}, HEARTBEAT_INTERVAL_MS);
		// Unref so we don't keep the event loop alive solely for the heartbeat.
		this.heartbeatTimer.unref?.();

		// Auto-start polling if enabled, but only in interactive/rpc sessions
		// where a visible session exists. Defer slightly so the UI settles.
		const reason = event.reason;
		if (reason === "startup" || reason === "new" || reason === "resume") {
			setTimeout(() => {
				void this.maybeAutoStart(ctx).catch(() => {});
			}, 500).unref?.();
		}
	}

	async onSessionShutdown(): Promise<void> {
		await this.stopPolling("session shutdown");
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		await clearHeartbeat();
		this.pendingMirrors = [];
		this.activeMirror = undefined;
	}

	private async maybeAutoStart(ctx: ExtensionContext): Promise<void> {
		const state = await readState();
		if (!state.enabled) return;
		if (this.mode === "print" || this.mode === "json") return;
		const token = await resolveToken();
		if (!token) {
			this.notify(ctx, "Telegram enabled but no token set. Run /telegram setup.", "warning");
			return;
		}
		if (state.allowlist.length === 0) {
			this.notify(ctx, "Telegram enabled but allowlist empty. Run /telegram pair.", "warning");
			return;
		}
		await this.startPolling(ctx);
	}

	// -- polling -----------------------------------------------------------

	async startPolling(ctx?: ExtensionContext, reason = "start"): Promise<{ ok: boolean; message: string }> {
		if (this.polling) return { ok: true, message: "Already polling." };
		const token = await resolveToken();
		if (!token) {
			this.notify(ctx, "No Telegram bot token. Run /telegram setup.", "warning");
			return { ok: false, message: "No bot token configured." };
		}
		const state = await readState();
		if (state.allowlist.length === 0) {
			this.notify(ctx, "Allowlist empty. Pair first (/telegram pair).", "warning");
			return { ok: false, message: "Allowlist empty." };
		}
		await this.claimCurrentSession(reason);
		this.polling = true;
		await mutateState((s) => {
			s.polling = true;
			s.lastError = "";
		});
		this.pollAbort = new AbortController();
		// Fire and forget; loop self-manages lifetime/abort.
		void this.pollLoop(token, this.pollAbort.signal, ctx).catch((e) => {
			void this.recordError(redact((e as Error).message, token));
		});
		this.notify(ctx, "Telegram polling started.", "info");
		return { ok: true, message: "Polling started." };
	}

	async stopPolling(reason = "stopped", clearClaim = true): Promise<{ ok: boolean; message: string }> {
		if (!this.polling) {
			await mutateState((s) => {
				s.polling = false;
			});
			if (clearClaim) await clearActiveSessionClaimIfOwner();
			return { ok: true, message: "Not polling." };
		}
		this.pollAbort?.abort();
		this.pollAbort = undefined;
		this.polling = false;
		await mutateState((s) => {
			s.polling = false;
		});
		if (clearClaim) await clearActiveSessionClaimIfOwner();
		return { ok: true, message: `Polling ${reason}.` };
	}

	async takeover(ctx?: ExtensionContext): Promise<{ ok: boolean; message: string; status?: Record<string, unknown> }> {
		await writeHeartbeat(this.mode, this.cwd);
		await this.claimCurrentSession("takeover");
		const daemonRes = await stopDaemonIfRunning();
		await this.stopPolling("takeover reset", false);
		await sleep(1_000);
		const pollRes = await this.startPolling(ctx, "takeover");
		await sleep(1_500);
		const status = await this.buildStatus();
		const lastError = typeof status.lastError === "string" ? status.lastError : "";
		let message = `Telegram takeover claimed by current session pid ${process.pid}. ${pollRes.message}`;
		if (daemonRes.message) message += ` ${daemonRes.message}`;
		if (lastError) message += ` Last error: ${lastError}`;
		return { ok: pollRes.ok && !lastError.includes("409"), message, status };
	}

	private async claimCurrentSession(reason: string): Promise<void> {
		await writeActiveSessionClaim(this.mode, this.cwd, reason);
	}

	private async shouldYieldToAnotherSession(): Promise<boolean> {
		const claim = await readActiveSessionClaim();
		if (!claim || claim.pid === process.pid) return false;
		const stale = Date.now() - claim.ts > HEARTBEAT_STALE_MS;
		if (stale) return false;
		return isPidAlive(claim.pid);
	}

	/** Long-poll loop. Abortable, backoff, deleteWebhook + 409 handling. */
	private async pollLoop(
		token: string,
		signal: AbortSignal,
		ctx?: ExtensionContext,
	): Promise<void> {
		// Drop any pending webhook + queued updates so getUpdates is clean.
		try {
			await this.botCall(token, "deleteWebhook", { drop_pending_updates: false }, signal);
		} catch (e) {
			// 409 here means another poller is active (e.g. the daemon). We still
			// proceed; getUpdates will surface 409 and we back off.
			void this.recordError(redact((e as Error).message, token));
		}

		let backoff = MIN_BACKOFF_MS;
		let notified409 = false;
		while (!signal.aborted) {
			if (await this.shouldYieldToAnotherSession()) {
				this.notify(ctx, "Telegram polling yielded to the current active session.", "info");
				await this.stopPolling("superseded by another active Telegram session", false);
				return;
			}
			let state = await readState();
			const offset = state.offset;
			try {
				const res = await this.botCall(
					token,
					"getUpdates",
					{ offset, timeout: LONG_POLL_TIMEOUT, allowed_updates: ["message"] },
					signal,
				);
				if (res.ok && Array.isArray(res.result)) {
					for (const update of res.result as any[]) {
						await this.handleUpdate(update, token, ctx);
					}
				}
				backoff = MIN_BACKOFF_MS;
				notified409 = false;
			} catch (e) {
				if (signal.aborted) break;
				const err = e as { status?: number; message?: string };
				const status = err.status;
				if (status === 409) {
					if (!notified409) {
						this.notify(
							ctx,
							"Telegram 409 conflict — another poller is active. Backing off.",
							"warning",
						);
						notified409 = true;
					}
					await this.recordError("409 conflict (another poller active)");
				} else if (status === 401 || status === 404) {
					await this.recordError(`Telegram auth error (${status}). Check token.`);
					this.notify(ctx, "Telegram token rejected. Stopping polling.", "error");
					await this.stopPolling("auth error");
					return;
				} else {
					await this.recordError(redact(err.message ?? "network error", token));
				}
				await sleep(backoff);
				backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
			}
		}
	}

	/** Make a Bot API call. Throws an object with `.status` on HTTP errors.
	 *  Error messages never include the raw Bot API URL or token. */
	private async botCall(
		token: string,
		method: string,
		body: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<any> {
		try {
			const resp = await fetch(`${BOT_API_BASE}${token}/${method}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal,
			});
			if (!resp.ok) {
				let detail = "";
				try {
					const j = (await resp.json()) as { description?: string };
					detail = j.description ?? "";
				} catch {
					/* ignore */
				}
				const err: Error & { status?: number } = new Error(
					`Telegram ${method} HTTP ${resp.status}${detail ? `: ${detail}` : ""}`,
				);
				err.status = resp.status;
				throw err;
			}
			return resp.json();
		} catch (e: any) {
			if (e && typeof e.status === "number") throw e;
			throw new Error(redact((e as Error).message ?? `fetch ${method} failed`, token));
		}
	}

	/** Handle a single update. Persists offset only after delivery/ignore. */
	private async handleUpdate(update: any, token: string, ctx?: ExtensionContext): Promise<void> {
		const updateId: number = update?.update_id;
		const nextOffset = updateId + 1;
		try {
			const msg = update?.message;
			// Only text messages in private chats, groups, or supergroups are handled.
			if (msg && typeof msg.text === "string") {
				const chat = msg.chat;
				const from = msg.from;
				const chatType = chat?.type;
				const isSupportedChat = chatType === "private" || chatType === "group" || chatType === "supergroup";
				const fromId: number | undefined = from?.id;
				const chatId: number | undefined = chat?.id;
				const threadId = positiveThreadId(msg.message_thread_id);
				const isTopicMessage = msg.is_topic_message === true;
				if (fromId != null && chatId != null) {
					// Record last-seen sender/thread for pairing regardless of allowlist.
					await mutateState((s) => {
						s.lastSeenFromId = fromId;
						s.lastSeenFromName = String(from?.username ?? from?.first_name ?? fromId);
						s.lastSeenChatId = chatId;
						s.lastSeenThreadId = threadId ?? null;
						s.lastSeenIsTopicMessage = isTopicMessage;
					});
					const state = await readState();
					if (isSupportedChat && state.allowlist.includes(fromId)) {
						await this.deliverTelegramMessage(chatId, threadId, fromId, state, msg, ctx);
					}
					// else: ignored (unsupported chat type or unallowlisted). Not an error.
				}
			}
			// Non-text updates (photos, stickers, callbacks...) are deliberately
			// ignored here — never errored.
		} finally {
			// Persist offset only after the update is delivered or ignored.
			await mutateState((s) => {
				if (updateId + 1 > s.offset) s.offset = updateId + 1;
			});
		}
	}

	/** Deliver a Telegram-origin text message as a visible user message. */
	private async deliverTelegramMessage(
		chatId: number,
		threadId: number | undefined,
		fromId: number,
		state: TelegramState,
		msg: any,
		ctx?: ExtensionContext,
	): Promise<void> {
		const fromName = String(msg?.from?.username ?? msg?.from?.first_name ?? fromId);
		const fromIdPrefix = String(fromId);
		const requestId = randomHex(6);
		const promptText = buildTelegramUserMessage(fromName, fromIdPrefix, String(msg.text), requestId);
		// Push to pending queue BEFORE injecting, so before_agent_start can
		// correlate the upcoming turn. Cap queue at 50.
		if (this.pendingMirrors.length >= 50) this.pendingMirrors.shift();
		this.pendingMirrors.push({ chatId, threadId, requestId, promptText });
		try {
			// followUp never interrupts an active turn; triggers a turn if idle.
			this.pi.sendUserMessage(promptText, { deliverAs: "followUp" });
		} catch (e) {
			// Remove from queue on delivery failure.
			const idx = this.pendingMirrors.findIndex(m => m.requestId === requestId);
			if (idx >= 0) this.pendingMirrors.splice(idx, 1);
			this.notify(ctx, `Telegram delivery failed: ${redact((e as Error).message, undefined)}`, "error");
		}
	}

	// -- reply mirroring ---------------------------------------------------

	onBeforeAgentStart(event: BeforeAgentStartEvent): void {
		const prompt = event.prompt;
		if (typeof prompt !== "string") {
			// Non-text prompt (e.g. images). Fail-closed: do not mirror.
			this.activeMirror = undefined;
			return;
		}
		const idx = this.pendingMirrors.findIndex(
			(m) => m.promptText === prompt || prompt.includes(`mirror ${m.requestId}`),
		);
		if (idx >= 0) {
			const [mirror] = this.pendingMirrors.splice(idx, 1);
			this.activeMirror = { chatId: mirror.chatId, threadId: mirror.threadId, requestId: mirror.requestId };
		} else {
			// A different prompt (human-typed or otherwise) is starting. Fail
			// closed for mirror correlation this turn.
			this.activeMirror = undefined;
		}
	}

	async onAgentEnd(event: AgentEndEvent): Promise<void> {
		const mirror = this.activeMirror;
		this.activeMirror = undefined;
		if (!mirror) return;
		// Gather assistant text from this turn's messages only.
		const texts: string[] = [];
		for (const m of event.messages ?? []) {
			if (m && (m as any).role === "assistant") {
				const content = (m as any).content;
				if (Array.isArray(content)) {
					for (const part of content) {
						if (part && part.type === "text" && typeof part.text === "string") {
							texts.push(part.text);
						}
					}
				}
			}
		}
		const reply = texts.join("\n").trim();
		if (!reply) return; // tool-only turn: nothing to mirror
		const token = await resolveToken();
		if (!token) return;
		await this.sendText(token, mirror.chatId, reply, mirror.threadId).catch((e) => {
			void this.recordError(redact((e as Error).message, token));
		});
	}

	/** Send plaintext to a chat, split below the 4096 limit. No parse_mode. */
	private async sendText(token: string, chatId: number, text: string, threadId?: number): Promise<void> {
		const clean = String(text ?? "");
		const chunks = splitForTelegram(clean);
		const messageThreadId = positiveThreadId(threadId);
		for (const chunk of chunks) {
			const body: Record<string, unknown> = {
				chat_id: chatId,
				text: chunk,
				// No parse_mode: plaintext only.
			};
			if (messageThreadId != null) body.message_thread_id = messageThreadId;
			await this.botCallUnbounded(token, "sendMessage", body);
		}
	}

	/** Upload a local image to a chat via multipart/form-data sendPhoto.
	 *  Caller is responsible for validating the file (see resolveAndValidatePhoto).
	 *  Caption is plaintext (no parse_mode), capped at TELEGRAM_MAX_CAPTION. */
	private async sendPhoto(
		token: string,
		chatId: number,
		abs: string,
		mime: string,
		fileBasename: string,
		caption?: string,
		threadId?: number,
	): Promise<void> {
		const buf = await fsp.readFile(abs);
		const form = new FormData();
		form.append("chat_id", String(chatId));
		const messageThreadId = positiveThreadId(threadId);
		if (messageThreadId != null) form.append("message_thread_id", String(messageThreadId));
		form.append("photo", new Blob([buf], { type: mime }), fileBasename);
		if (caption && caption.trim()) {
			form.append("caption", caption.trim().slice(0, TELEGRAM_MAX_CAPTION));
			// No parse_mode: plaintext invariant honored.
		}
		await this.botCallMultipart(token, "sendPhoto", form);
	}

	/** Bot call without the long-poll abort signal (for sends).
	 *  Error messages never include the raw Bot API URL or token. */
	private async botCallUnbounded(
		token: string,
		method: string,
		body: Record<string, unknown>,
	): Promise<any> {
		try {
			const resp = await fetch(`${BOT_API_BASE}${token}/${method}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!resp.ok) {
				let detail = "";
				try {
					const j = (await resp.json()) as { description?: string };
					detail = j.description ?? "";
				} catch {
					/* ignore */
				}
				const err: Error & { status?: number } = new Error(
					`Telegram ${method} HTTP ${resp.status}${detail ? `: ${detail}` : ""}`,
				);
				err.status = resp.status;
				throw err;
			}
			return resp.json();
		} catch (e: any) {
			if (e && typeof e.status === "number") throw e;
			throw new Error(redact((e as Error).message ?? `fetch ${method} failed`, token));
		}
	}

	/** Make a Bot API call with multipart/form-data (for file uploads).
	 *  Does NOT set Content-Type so the boundary is auto-generated.
	 *  Has a finite upload timeout to avoid hangs. Errors never include the token. */
	private async botCallMultipart(
		token: string,
		method: string,
		form: FormData,
	): Promise<any> {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), PHOTO_UPLOAD_TIMEOUT_MS);
		try {
			const resp = await fetch(`${BOT_API_BASE}${token}/${method}`, {
				method: "POST",
				body: form, // no Content-Type header — boundary auto-set
				signal: ac.signal,
			});
			if (!resp.ok) {
				let detail = "";
				try {
					const j = (await resp.json()) as { description?: string };
					detail = j.description ?? "";
				} catch {
					/* ignore */
				}
				const err: Error & { status?: number } = new Error(
					`Telegram ${method} HTTP ${resp.status}${detail ? `: ${detail}` : ""}`,
				);
				err.status = resp.status;
				throw err;
			}
			return resp.json();
		} catch (e: any) {
			if (e && typeof e.status === "number") throw e;
			throw new Error(redact((e as Error).message ?? `fetch ${method} failed`, token));
		} finally {
			clearTimeout(timer);
		}
	}

	// -- agent-facing setup & pair ----------------------------------------

	/**
	 * One-shot setup from env vars only (agent-friendly, no interactive prompts).
	 * Reads TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_FROM, TELEGRAM_CHAT_ID.
	 * Validates the token, configures state, enables auto-start, and starts polling.
	 */
	async autoSetup(ctx?: ExtensionContext): Promise<{ ok: boolean; message: string }> {
		const envToken = process.env[ENV_TOKEN];
		if (!envToken || !envToken.trim()) {
			return { ok: false, message: `${ENV_TOKEN} env var not set. Set it and retry.` };
		}
		const token = envToken.trim();

		// Validate the token by calling getMe.
		try {
			const me = await this.botCallUnbounded(token, "getMe", {});
			if (!me?.ok) {
				return { ok: false, message: `Token validation failed. Check ${ENV_TOKEN}.` };
			}
		} catch (e: any) {
			return { ok: false, message: `Token validation error: ${redact(e.message, token)}` };
		}

		await mutateState((s) => {
			// Allowlist from env var (comma-separated Telegram from.id values).
			const envList = process.env[ENV_ALLOWLIST];
			if (envList && envList.trim()) {
				const ids = envList
					.split(",")
					.map((x) => Number.parseInt(x.trim(), 10))
					.filter((n) => Number.isFinite(n));
				if (ids.length > 0) s.allowlist = ids;
			}
			// Paired chat id from env var (also added to allowlist if not present).
			const envChat = process.env[ENV_CHAT_ID];
			const envN = envChat ? Number.parseInt(envChat.trim(), 10) : NaN;
			if (Number.isFinite(envN)) {
				s.pairedChatId = envN;
				s.pairedThreadId = null;
				if (!s.allowlist.includes(envN)) s.allowlist.push(envN);
			}
			// Auto-enable so it starts on next session boot.
			s.enabled = true;
		});

		const state = await readState();
		const missing: string[] = [];
		if (state.allowlist.length === 0) missing.push(`allowlist (set ${ENV_ALLOWLIST})`);
		if (state.pairedChatId == null) missing.push(`paired chat id (set ${ENV_CHAT_ID})`);

		if (missing.length > 0) {
			return {
				ok: true,
				message: `Setup partial: token OK, but missing ${missing.join(", ")}. Polling not started.`,
			};
		}

		// Auto-start polling now.
		const pollRes = await this.startPolling(ctx);
		if (pollRes.ok) {
			return { ok: true, message: "Setup complete. Token validated. Polling started. Auto-start enabled." };
		}
		return { ok: true, message: `Setup complete but polling: ${pollRes.message}` };
	}

	/** Pair the most recent Telegram sender — works headlessly (no interactive UI). */
	async autoPair(): Promise<{ ok: boolean; message: string }> {
		const state = await readState();
		if (state.lastSeenFromId == null) {
			return { ok: false, message: "No recent Telegram sender. Send a private or group/topic message to the bot first." };
		}
		await mutateState((s) => {
			if (!s.allowlist.includes(state.lastSeenFromId!)) s.allowlist.push(state.lastSeenFromId!);
			s.pairedFromId = state.lastSeenFromId;
			if (state.lastSeenChatId != null) s.pairedChatId = state.lastSeenChatId;
			s.pairedThreadId = state.lastSeenThreadId;
		});
		return {
			ok: true,
			message: `Paired ${state.lastSeenFromName || state.lastSeenFromId} → chat ${prefixId(state.lastSeenChatId)}${state.lastSeenThreadId ? ` topic ${state.lastSeenThreadId}` : ""}.`,
		};
	}

	// -- agent-facing send -------------------------------------------------

	/** Used by the telegram_pi tool / /telegram send. Plaintext only. */
	async sendToPaired(text: string, threadId?: number): Promise<{ ok: boolean; message: string }> {
		const token = await resolveToken();
		if (!token) return { ok: false, message: "No bot token configured." };
		const state = await readState();
		const preferLastSeenTarget = shouldPreferLastSeenTextTarget(state);
		const chatId = preferLastSeenTarget ? state.lastSeenChatId : state.pairedChatId ?? state.lastSeenChatId;
		const preferredThreadId = preferLastSeenTarget ? state.lastSeenThreadId : state.pairedThreadId;
		const fallbackThreadId = state.pairedChatId == null ? state.lastSeenThreadId : null;
		const resolvedThreadId = positiveThreadId(threadId) ?? preferredThreadId ?? fallbackThreadId ?? undefined;
		if (chatId == null) return { ok: false, message: "No paired chat id. Run /telegram pair." };
		try {
			await this.sendText(token, chatId, text, resolvedThreadId);
			return { ok: true, message: "Sent." };
		} catch (e) {
			const msg = redact((e as Error).message, token);
			await this.recordError(msg);
			return { ok: false, message: msg };
		}
	}

	/** Upload a local image file to the paired chat (action=send_photo).
	 *  Security: requires explicit pairedChatId (no lastSeen fallback),
	 *  validates the file is a supported image <=10MB, never logs file contents,
	 *  and only surfaces basename in error messages. */
	async sendPhotoToPaired(
		filePath: string,
		caption?: string,
		threadId?: number,
	): Promise<{ ok: boolean; message: string }> {
		const token = await resolveToken();
		if (!token) return { ok: false, message: "No bot token configured." };
		const state = await readState();
		// Photo upload is higher risk than text: require explicit paired chat.
		if (state.pairedChatId == null) {
			return { ok: false, message: "No paired chat id. Run /telegram pair." };
		}
		const chatId = state.pairedChatId;
		const resolvedThreadId = positiveThreadId(threadId) ?? state.pairedThreadId ?? undefined;
		const v = await resolveAndValidatePhoto(filePath, this.cwd);
		if (!v.ok) return { ok: false, message: v.message };
		try {
			await this.sendPhoto(token, chatId, v.abs, v.mime, v.basename, caption, resolvedThreadId);
			return { ok: true, message: "Photo sent." };
		} catch (e) {
			const msg = redact((e as Error).message, token);
			await this.recordError(msg);
			return { ok: false, message: msg };
		}
	}

	// -- status / errors ---------------------------------------------------

	private async recordError(message: string): Promise<void> {
		const capped = message.slice(0, 500);
		await mutateState((s) => {
			s.lastError = capped;
		});
	}

	async buildStatus(): Promise<Record<string, unknown>> {
		const state = await readState();
		const token = await resolveToken();
		const hb = await readHeartbeat();
		const claim = await readActiveSessionClaim();
		const hbTs = hb ? (hb.ts ?? hb.at ?? 0) : 0;
		const hbAge = hb ? Date.now() - hbTs : null;
		const hbStale = hb ? hbAge! > HEARTBEAT_STALE_MS : true;
		const claimAge = claim ? Date.now() - claim.ts : null;
		return {
			enabled: state.enabled,
			polling: this.polling,
			tokenConfigured: Boolean(token),
			tokenSource: process.env[ENV_TOKEN] ? "env" : (await hasStoredToken()) ? "file" : "none",
			allowlistCount: state.allowlist.length,
			allowlist: state.allowlist.slice(),
			pairedChatId: prefixId(state.pairedChatId) ?? null,
			pairedThreadId: state.pairedThreadId ?? null,
			pairedFromId: prefixId(state.pairedFromId) ?? null,
			lastSeenChatId: prefixId(state.lastSeenChatId) ?? null,
			lastSeenFromId: prefixId(state.lastSeenFromId) ?? null,
			lastSeenFromName: state.lastSeenFromName || null,
			lastSeenThreadId: state.lastSeenThreadId ?? null,
			lastSeenIsTopicMessage: state.lastSeenIsTopicMessage,
			offset: state.offset,
			heartbeat: hb
				? { pid: hb.pid, mode: hb.mode, ageMs: hbAge, stale: hbStale, cwd: hb.cwd }
				: null,
			heartbeatActive: hb ? !hbStale : false,
			activeSession: claim
				? {
						pid: claim.pid,
						mode: claim.mode,
						ageMs: claimAge,
						cwd: claim.cwd,
						reason: claim.reason,
						owner: claim.pid === process.pid,
						alive: isPidAlive(claim.pid),
					}
				: null,
			lastError: state.lastError || undefined,
			mode: this.mode || undefined,
		};
	}

	async listChats(): Promise<Record<string, unknown>[]> {
		const state = await readState();
		const chats: Record<string, unknown>[] = [];
		const seen = new Set<number>();
		if (state.pairedChatId != null && !seen.has(state.pairedChatId)) {
			seen.add(state.pairedChatId);
			chats.push({
				chatId: prefixId(state.pairedChatId),
				threadId: state.pairedThreadId ?? undefined,
				fromId: prefixId(state.pairedFromId),
				role: "paired",
			});
		}
		if (state.lastSeenChatId != null && !seen.has(state.lastSeenChatId)) {
			seen.add(state.lastSeenChatId);
			chats.push({
				chatId: prefixId(state.lastSeenChatId),
				threadId: state.lastSeenThreadId ?? undefined,
				isTopicMessage: state.lastSeenIsTopicMessage || undefined,
				fromId: prefixId(state.lastSeenFromId),
				name: state.lastSeenFromName || undefined,
				role: "lastSeen",
			});
		}
		return chats;
	}

	// -- ui helper ---------------------------------------------------------

	private notify(
		ctx: ExtensionContext | undefined,
		message: string,
		type: "info" | "warning" | "error",
	): void {
		if (!ctx) return;
		try {
			if (ctx.hasUI) ctx.ui.notify(message, type);
		} catch {
			/* ignore */
		}
	}

	// -- tool dispatch -----------------------------------------------------

	async executeTool(
		params: TelegramPiInput,
		ctx: ExtensionContext,
	): Promise<{ content: { type: "text"; text: string }[]; details: unknown }> {
		switch (params.action) {
			case "status": {
				const status = await this.buildStatus();
				return textResult(JSON.stringify(status, null, 2), status);
			}
			case "send": {
				const text = (params.text ?? "").trim();
				if (!text) return textResult("Error: text is required for send.");
				const res = await this.sendToPaired(text, params.thread_id);
				return textResult(res.ok ? `Sent to paired chat.` : `Error: ${res.message}`, res);
			}
			case "send_photo": {
				const file = (params.file ?? "").trim();
				if (!file) return textResult("Error: file is required for send_photo.");
				const caption = params.caption;
				const res = await this.sendPhotoToPaired(file, caption, params.thread_id);
				return textResult(res.ok ? `Photo sent to paired chat.` : `Error: ${res.message}`, res);
			}
			case "start": {
				const res = await this.startPolling(ctx);
				return textResult(res.message, res);
			}
			case "stop": {
				const res = await this.stopPolling("tool");
				return textResult(res.message, res);
			}
			case "takeover": {
				const res = await this.takeover(ctx);
				return textResult(res.message, res);
			}
			case "daemon_status": {
				const hb = await readHeartbeat();
				const active = await isActiveHeartbeat();
				return textResult(
					JSON.stringify(
						{
							heartbeat: hb
								? { pid: hb.pid, mode: hb.mode, ageMs: Date.now() - (hb.ts ?? hb.at ?? 0), cwd: hb.cwd }
								: null,
							heartbeatActive: active,
						},
						null,
						2,
					),
					{ heartbeatActive: active },
				);
			}
			case "list_chats": {
				const chats = await this.listChats();
				return textResult(JSON.stringify(chats, null, 2), { chats });
			}
			case "setup": {
				const res = await this.autoSetup(ctx);
				return textResult(res.message, res);
			}
			case "pair": {
				const res = await this.autoPair();
				return textResult(res.message, res);
			}
			default:
				return textResult(`Unknown action: ${(params as any).action}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render only a prefix of an id for status output (never the full token). */
function prefixId(id: number | null | undefined): string | undefined {
	if (id == null) return undefined;
	const s = String(id);
	if (s.length <= 6) return s;
	return `${s.slice(0, 6)}…`;
}

function positiveThreadId(id: unknown): number | undefined {
	return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : undefined;
}

/** Prefer the most recent allowed group/topic for plaintext sends when setup is
 *  still paired to the user's private chat (private chat id === from.id). */
function shouldPreferLastSeenTextTarget(state: TelegramState): boolean {
	return Boolean(
		state.pairedChatId != null &&
		state.lastSeenChatId != null &&
		state.lastSeenChatId !== state.pairedChatId &&
		state.lastSeenFromId != null &&
		state.pairedChatId === state.lastSeenFromId &&
		state.allowlist.includes(state.lastSeenFromId) &&
		(state.pairedFromId == null || state.pairedFromId === state.lastSeenFromId),
	);
}

/** Split text into chunks <= TELEGRAM_MAX_TEXT, preferring newline boundaries.
 *  Newlines at cut points are kept in the preceding chunk so the next chunk
 *  never starts with a leading newline. */
function splitForTelegram(text: string): string[] {
	const out: string[] = [];
	let remaining = text;
	while (remaining.length > TELEGRAM_MAX_TEXT) {
		let cut = remaining.lastIndexOf("\n", TELEGRAM_MAX_TEXT);
		if (cut <= 0) {
			cut = TELEGRAM_MAX_TEXT;
		} else {
			cut = cut + 1; // include the newline in this chunk
		}
		out.push(remaining.slice(0, cut));
		remaining = remaining.slice(cut);
	}
	if (remaining.length > 0) out.push(remaining);
	return out;
}

function textResult(
	text: string,
	details?: unknown,
): { content: { type: "text"; text: string }[]; details: unknown } {
	return { content: [{ type: "text", text }], details: details ?? {} };
}

/** Resolve a user-supplied photo path and validate it is a safe, supported image.
 *  Security: rejects symlinks, directories, >10MB files, and non-image formats.
 *  Never returns the full absolute path in error messages (only basename). */
async function resolveAndValidatePhoto(
	input: string,
	baseCwd: string,
): Promise<{ ok: true; abs: string; mime: string; basename: string } | { ok: false; message: string }> {
	const base = baseCwd || process.cwd();
	const abs = resolve(base, input);
	const name = basename(abs);
	let st: import("node:fs").Stats;
	try {
		st = await fsp.lstat(abs);
	} catch {
		return { ok: false, message: `File not found: ${name}` };
	}
	if (st.isSymbolicLink()) return { ok: false, message: "Symlinks are not allowed." };
	if (!st.isFile()) return { ok: false, message: "Path is not a regular file." };
	if (st.size === 0) return { ok: false, message: "File is empty." };
	if (st.size > MAX_PHOTO_BYTES) return { ok: false, message: "File too large (max 10MB)." };
	let handle: import("node:fs/promises").FileHandle;
	try {
		handle = await fsp.open(abs, "r");
	} catch {
		return { ok: false, message: "File not readable." };
	}
	try {
		const head = Buffer.alloc(12);
		await handle.read(head, 0, 12, 0);
		const match = IMAGE_MAGIC.find((m) =>
			m.bytes.every((c) => c.bytes.every((b, i) => head[c.off + i] === b)),
		);
		if (!match) return { ok: false, message: "Unsupported image format (JPEG/PNG/WebP only)." };
		return { ok: true, abs, mime: match.mime, basename: name };
	} finally {
		await handle.close();
	}
}

async function stopDaemonIfRunning(): Promise<{ ok: boolean; message: string }> {
	try {
		const dsRaw = await fsp.readFile(join(runtimeDir(), "daemon-state.json"), "utf8");
		const ds = JSON.parse(dsRaw);
		const daemonPid: number | null = ds.daemonPid ?? null;
		if (!daemonPid || typeof daemonPid !== "number") {
			return { ok: true, message: "No daemon pid found." };
		}
		try {
			process.kill(daemonPid, "SIGTERM");
			return { ok: true, message: `Sent SIGTERM to daemon pid ${daemonPid}.` };
		} catch (killErr: any) {
			if (killErr.code === "ESRCH") return { ok: true, message: `Daemon pid ${daemonPid} not running.` };
			return { ok: false, message: `Failed to stop daemon: ${redact(killErr.message, undefined)}` };
		}
	} catch {
		return { ok: true, message: "No daemon state found." };
	}
}

/** Run a PowerShell script (for daemon install/uninstall/start/stop). */
function runPowerShell(scriptPath: string): Promise<{ ok: boolean; message: string }> {
	return new Promise((resolvePwsh) => {
		const child = spawn(
			"powershell",
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
			{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
		);
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => (stdout += d.toString()));
		child.stderr?.on("data", (d) => (stderr += d.toString()));
		child.on("error", (e) =>
			resolvePwsh({ ok: false, message: `Failed to launch powershell: ${e.message}` }),
		);
		child.on("close", (code) => {
			const trimmed = (stdout + (stderr ? `\n${stderr}` : "")).trim();
			resolvePwsh({
				ok: code === 0,
				message: trimmed || (code === 0 ? "OK" : `exit ${code}`),
			});
		});
	});
}

// ---------------------------------------------------------------------------
// Command parsing helpers
// ---------------------------------------------------------------------------

/** Split "/telegram ..." args into [subcommand, rest]. */
function splitSubcommand(args: string): { sub: string; rest: string } {
	const trimmed = args.trim();
	const space = trimmed.search(/\s/);
	if (space === -1) return { sub: trimmed.toLowerCase(), rest: "" };
	return { sub: trimmed.slice(0, space).toLowerCase(), rest: trimmed.slice(space + 1).trim() };
}

/** Parse `/telegram send-photo <filepath> [--caption "..."]`.
 *  Handles double-quoted Windows paths/captions that contain spaces.
 *  Tokens before `--caption` form the filepath; everything after `--caption`
 *  (optionally quoted) is the caption. */
function parsePhotoCommand(
	input: string,
): { ok: true; file: string; caption: string | undefined } | { ok: false; message: string } {
	const tokens = splitQuotedTokens(input);
	if (tokens.length === 0) return { ok: false, message: "Usage: /telegram send-photo <filepath> [--caption \"...\"]" };
	let file = "";
	let caption: string | undefined;
	let i = 0;
	for (; i < tokens.length; i++) {
		if (tokens[i] === "--caption") {
			caption = tokens.slice(i + 1).join(" ");
			break;
		}
		file = file ? `${file} ${tokens[i]}` : tokens[i];
	}
	file = file.trim();
	if (!file) return { ok: false, message: "Usage: /telegram send-photo <filepath> [--caption \"...\"]" };
	return { ok: true, file, caption: caption || undefined };
}

/** Split a string into tokens, respecting double quotes. Backslash is NOT an
 *  escape — Windows paths work unquoted or double-quoted. */
function splitQuotedTokens(input: string): string[] {
	const out: string[] = [];
	let cur = "";
	let inQ = false;
	for (const ch of input) {
		if (ch === '"') {
			inQ = !inQ;
			continue;
		}
		if (ch === " " && !inQ) {
			if (cur) { out.push(cur); cur = ""; }
			continue;
		}
		cur += ch;
	}
	if (cur) out.push(cur);
	return out;
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function telegramPi(pi: ExtensionAPI): void {
	const runtime = new TelegramRuntime(pi);

	// -- session lifecycle -------------------------------------------------

	pi.on("session_start", async (event, ctx) => {
		runtime.onSessionStart(event, ctx);
	});

	pi.on("session_shutdown", async () => {
		await runtime.onSessionShutdown();
	});

	// -- reply correlation -------------------------------------------------

	pi.on("before_agent_start", async (event) => {
		runtime.onBeforeAgentStart(event);
	});

	pi.on("agent_end", async (event) => {
		await runtime.onAgentEnd(event);
	});

	// -- tool --------------------------------------------------------------

	pi.registerTool({
		name: "telegram_pi",
		label: "Telegram Pi",
		description:
			"Non-secret Telegram bridge actions: status, send (plaintext to paired chat), " +
			"send_photo (upload a local image JPEG/PNG/WebP <=10MB to paired chat), " +
			"start/stop polling, takeover current session, daemon_status (heartbeat), list_chats, " +
			"setup (one-shot from env vars), pair (pair last sender). Never accepts or returns the bot token.",
		promptSnippet: "Query Telegram bridge status, auto-setup from env vars, pair sender, take over active polling, send plaintext, or send a local photo to the paired Telegram chat",
		promptGuidelines: [
			"Use telegram_pi to check Telegram bridge status, auto-setup (action='setup') from TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_FROM + TELEGRAM_CHAT_ID env vars, pair the last sender (action='pair'), make the current Pi session the Telegram receiver (action='takeover'), send a short plaintext update (action='send'), or upload a local image file to the paired chat (action='send_photo', requires absolute or cwd-relative file path; optional caption up to 1024 chars). Never use it to leak local TUI conversation; only explicit send text/files are transmitted.",
		],
		parameters: TelegramPiParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return runtime.executeTool(params, ctx);
		},
	});

	// -- /telegram command -------------------------------------------------

	pi.registerCommand("telegram", {
		description:
			"Telegram ↔ Pi bridge. Subcommands: status, setup (interactive or headless via env vars), " +
			"pair, start, stop, takeover, enable, disable, send <text>, send-photo <file> [--caption \"...\"], daemon status|install|uninstall|start|stop|help.",
		handler: async (args, ctx) => {
			const { sub, rest } = splitSubcommand(args);

			switch (sub) {
				case "":
				case "status": {
					const status = await runtime.buildStatus();
					ctx.ui.notify(formatStatusForHuman(status), "info");
					return;
				}

				case "setup": {
					await cmdSetup(ctx);
					return;
				}

				case "pair": {
					await cmdPair(ctx);
					return;
				}

				case "start": {
					const res = await runtime.startPolling(ctx);
					ctx.ui.notify(res.message, res.ok ? "info" : "warning");
					return;
				}

				case "stop": {
					const res = await runtime.stopPolling("command");
					ctx.ui.notify(res.message, "info");
					return;
				}

				case "takeover": {
					const res = await runtime.takeover(ctx);
					ctx.ui.notify(res.message, res.ok ? "info" : "warning");
					return;
				}

				case "enable": {
					await mutateState((s) => {
						s.enabled = true;
					});
					ctx.ui.notify("Telegram auto-start enabled.", "info");
					return;
				}

				case "disable": {
					await mutateState((s) => {
						s.enabled = false;
					});
					ctx.ui.notify("Telegram auto-start disabled.", "info");
					return;
				}

				case "send": {
					const text = rest.trim();
					if (!text) {
						ctx.ui.notify("Usage: /telegram send <text>", "warning");
						return;
					}
					const res = await runtime.sendToPaired(text);
					ctx.ui.notify(res.message, res.ok ? "info" : "warning");
					return;
				}

				case "send-photo": {
					// Parse: /telegram send-photo <filepath> [--caption "..."]
					// Handles quoted Windows paths with spaces.
					const parsed = parsePhotoCommand(rest);
					if (!parsed.ok) {
						ctx.ui.notify(parsed.message, "warning");
						return;
					}
					const res = await runtime.sendPhotoToPaired(parsed.file, parsed.caption);
					ctx.ui.notify(res.message, res.ok ? "info" : "warning");
					return;
				}

				case "daemon": {
					await cmdDaemon(rest, ctx);
					return;
				}

				case "help": {
					ctx.ui.notify(TELEGRAM_HELP, "info");
					return;
				}

				default: {
					ctx.ui.notify(`Unknown subcommand: ${sub}\n${TELEGRAM_HELP}`, "warning");
				}
			}
		},
	});
}

// ---------------------------------------------------------------------------
// /telegram subcommand implementations
// ---------------------------------------------------------------------------

async function cmdSetup(ctx: ExtensionContext): Promise<void> {
	// Headless auto-setup when all env vars are set (agent-friendly).
	const envToken = process.env[ENV_TOKEN];
	const envList = process.env[ENV_ALLOWLIST];
	const envChat = process.env[ENV_CHAT_ID];
	if (envToken?.trim() && envList?.trim() && envChat?.trim()) {
		// Use the autoSetup path which validates, configures, enables, and starts.
		// Reuse TelegramRuntime via the running instance isn't easily accessible
		// from outside the class, so we replicate the logic here.
		const token = envToken.trim();
		try {
			const resp = await fetch(`${BOT_API_BASE}${token}/getMe`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
			if (!resp.ok) {
				ctx.ui.notify(`Token validation failed (HTTP ${resp.status}). Check ${ENV_TOKEN}.`, "warning");
				return;
			}
		const ids = envList
			.split(",")
			.map((s) => Number.parseInt(s.trim(), 10))
			.filter((n) => Number.isFinite(n));
		const envN = Number.parseInt(envChat.trim(), 10);
		const chatId = Number.isFinite(envN) ? envN : null;
		await mutateState((s) => {
			if (ids.length > 0) s.allowlist = ids;
			if (chatId != null) {
				s.pairedChatId = chatId;
				s.pairedThreadId = null;
				if (!s.allowlist.includes(chatId)) s.allowlist.push(chatId);
			}
			s.enabled = true;
		});
		ctx.ui.notify("Setup auto-complete from env vars. Token validated. Auto-start enabled.", "info");
		// Attempt to start polling via the runtime. Since TelegramRuntime isn't
		// directly accessible here, we invoke startPolling through the registered.
		// But we can just inform the user and they can /telegram start, or
		// the auto-start on next session boot will handle it.
		ctx.ui.notify("Run /telegram start to begin polling now, or it will auto-start on next session.", "info");
		return;
	} catch {
		ctx.ui.notify(`Token validation failed. Check ${ENV_TOKEN}.`, "warning");
		return;
	}
	}

	if (!ctx.hasUI) {
		ctx.ui.notify(
			"Setup requires interactive TUI mode, or set all three env vars (TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_FROM, TELEGRAM_CHAT_ID) for headless auto-setup.",
			"warning",
		);
		return;
	}
	// 1) Token
	let tokenOk: boolean;
	if (envToken && envToken.trim()) {
		ctx.ui.notify(`Token is set via ${ENV_TOKEN} env var (preferred).`, "info");
		tokenOk = true;
	} else if (await hasStoredToken()) {
		ctx.ui.notify("Token is stored in secret.token (0600).", "info");
		tokenOk = true;
	} else {
		const entered = await ctx.ui.input(
			"Telegram bot token",
			"123456:ABC-DEF... (from @BotFather)",
		);
		if (!entered || !entered.trim()) {
			ctx.ui.notify("No token entered. Set TELEGRAM_BOT_TOKEN env var and retry.", "warning");
			return;
		}
		await storeToken(entered.trim());
		ctx.ui.notify("Token stored in secret.token (0600). It will never be printed again.", "info");
		tokenOk = true;
	}

	// 2) Allowlist
	let state = await readState();
	if (state.allowlist.length === 0) {
		// Allow env-provided allowlist first.
		const envList = process.env[ENV_ALLOWLIST];
		if (envList && envList.trim()) {
			const ids = envList
				.split(",")
				.map((s) => Number.parseInt(s.trim(), 10))
				.filter((n) => Number.isFinite(n));
			if (ids.length > 0) {
				await mutateState((s) => {
					s.allowlist = ids;
				});
				ctx.ui.notify(`Loaded ${ids.length} allowlist id(s) from ${ENV_ALLOWLIST}.`, "info");
			}
		}
	}
	state = await readState();
	if (state.allowlist.length === 0) {
		if (state.lastSeenFromId != null) {
			const approve = await ctx.ui.confirm(
				"Pair sender?",
				`Allow Telegram from.id ${state.lastSeenFromId} (${state.lastSeenFromName || "unknown"})?`,
			);
			if (approve) {
				await mutateState((s) => {
					if (state.lastSeenFromId != null && !s.allowlist.includes(state.lastSeenFromId!)) {
						s.allowlist.push(state.lastSeenFromId!);
					}
					if (state.lastSeenChatId != null) {
						s.pairedChatId = state.lastSeenChatId;
					}
					s.pairedThreadId = state.lastSeenThreadId;
					s.pairedFromId = state.lastSeenFromId;
				});
				ctx.ui.notify("Sender paired.", "info");
			} else {
				ctx.ui.notify(
					"Send a message to the bot from Telegram, then run /telegram pair.",
					"info",
				);
			}
		} else {
			const manual = await ctx.ui.input(
				"Allowed Telegram from.id",
				"numeric user id (send a message to the bot first, or get it from @userinfobot)",
			);
			const n = manual ? Number.parseInt(manual.trim(), 10) : NaN;
			if (Number.isFinite(n)) {
				await mutateState((s) => {
					if (!s.allowlist.includes(n)) s.allowlist.push(n);
					s.pairedFromId = n;
				});
				ctx.ui.notify(`Added from.id ${n} to allowlist.`, "info");
			} else if (manual && manual.trim()) {
				ctx.ui.notify("Invalid numeric id. Send a message to the bot then /telegram pair.", "warning");
			} else {
				ctx.ui.notify("No allowlist set. Send a message to the bot then /telegram pair.", "info");
			}
		}
	}

	// 3) Paired chat id (optional, may come from env or lastSeen)
	state = await readState();
	if (state.pairedChatId == null) {
		const envChat = process.env[ENV_CHAT_ID];
		const envN = envChat ? Number.parseInt(envChat.trim(), 10) : NaN;
		if (Number.isFinite(envN)) {
			await mutateState((s) => {
				s.pairedChatId = envN;
				s.pairedThreadId = null;
			});
		} else if (state.lastSeenChatId != null) {
			await mutateState((s) => {
				s.pairedChatId = state.lastSeenChatId;
				s.pairedThreadId = state.lastSeenThreadId;
			});
		}
	}

	state = await readState();
	const missing: string[] = [];
	if (!tokenOk) missing.push("bot token");
	if (state.allowlist.length === 0) missing.push("allowed from.id");
	if (state.pairedChatId == null) missing.push("paired chat id");
	if (missing.length > 0) {
		ctx.ui.notify(`Setup incomplete: missing ${missing.join(", ")}.`, "warning");
	} else {
		ctx.ui.notify(
			"Setup complete. Run /telegram enable then /telegram start (or just /telegram start).",
			"info",
		);
	}
}

async function cmdPair(ctx: ExtensionContext): Promise<void> {
	const state = await readState();
	if (state.lastSeenFromId == null) {
		ctx.ui.notify(
			"No recent Telegram sender. Send a private or group/topic message to the bot, then run /telegram pair.",
			"warning",
		);
		return;
	}
	await mutateState((s) => {
		if (!s.allowlist.includes(state.lastSeenFromId!)) s.allowlist.push(state.lastSeenFromId!);
		s.pairedFromId = state.lastSeenFromId;
		if (state.lastSeenChatId != null) s.pairedChatId = state.lastSeenChatId;
		s.pairedThreadId = state.lastSeenThreadId;
	});
	ctx.ui.notify(
		`Paired from.id ${state.lastSeenFromId} (${state.lastSeenFromName || "unknown"}) → chat ${prefixId(state.lastSeenChatId)}${state.lastSeenThreadId ? ` topic ${state.lastSeenThreadId}` : ""}.`,
		"info",
	);
}

async function cmdDaemon(rest: string, ctx: ExtensionContext): Promise<void> {
	const { sub } = splitSubcommand(rest);
	const p = paths();
	switch (sub) {
		case "":
		case "status": {
			const hb = await readHeartbeat();
			const active = await isActiveHeartbeat();
			// Include daemon-state.json summary.
			let dsInfo = "";
			try {
				const dsRaw = await fsp.readFile(join(runtimeDir(), "daemon-state.json"), "utf8");
				const ds = JSON.parse(dsRaw);
				dsInfo = `\ndaemonPid=${ds.daemonPid ?? "-"} running=${ds.running ?? false} pid=${ds.pid ?? "-"} startedAt=${ds.startedAt ? new Date(ds.startedAt).toISOString() : "-"}`;
				if (ds.lastError) dsInfo += `\nlastError=${String(ds.lastError).slice(0, 200)}`;
				if (ds.consecutiveSpawnErrors != null) dsInfo += `\nconsecutiveSpawnErrors=${ds.consecutiveSpawnErrors}`;
			} catch { /* daemon-state.json may not exist */ }
			ctx.ui.notify(
				`Daemon heartbeat: ${active ? "ACTIVE" : "inactive/stale"}\n` +
					(hb
						? `pid=${hb.pid} mode=${hb.mode} age=${Date.now() - (hb.ts ?? hb.at ?? 0)}ms\ncwd=${hb.cwd}${dsInfo}`
						: `no heartbeat file${dsInfo}`),
				"info",
			);
			return;
		}
		case "install": {
			const res = await runPowerShell(p.installScript);
			ctx.ui.notify(
				res.ok ? `Daemon task installed.\n${res.message}` : `Install failed: ${res.message}`,
				res.ok ? "info" : "error",
			);
			return;
		}
		case "uninstall": {
			const res = await runPowerShell(p.uninstallScript);
			ctx.ui.notify(
				res.ok ? `Daemon task uninstalled.\n${res.message}` : `Uninstall failed: ${res.message}`,
				res.ok ? "info" : "error",
			);
			return;
		}
		case "start": {
			// Spawn detached node daemon.mjs with no token args.
			const daemonPath = p.daemon;
			try {
				await fsp.access(daemonPath);
			} catch {
				ctx.ui.notify(`Daemon script not found: ${daemonPath}`, "error");
				return;
			}
			const daemonCwd = typeof (ctx as any).cwd === "string" ? (ctx as any).cwd : process.cwd();
			const child = spawn(process.execPath, [daemonPath], {
				cwd: daemonCwd,
				detached: true,
				stdio: "ignore",
				windowsHide: true,
				env: { ...process.env, TELEGRAM_PI_CWD: daemonCwd },
			});
			child.unref();
			ctx.ui.notify(`Daemon started (pid ${child.pid}). Check /telegram daemon status.`, "info");
			return;
		}
		case "stop": {
			// Read daemon-state.json daemonPid and SIGTERM only that pid.
			// Do NOT kill arbitrary pi processes.
			try {
				const dsRaw = await fsp.readFile(join(runtimeDir(), "daemon-state.json"), "utf8");
				const ds = JSON.parse(dsRaw);
				const daemonPid: number | null = ds.daemonPid ?? null;
				if (!daemonPid || typeof daemonPid !== "number") {
					ctx.ui.notify("No daemon pid found in daemon-state.json.", "warning");
					return;
				}
				try {
					process.kill(daemonPid, "SIGTERM");
					ctx.ui.notify(`Sent SIGTERM to daemon pid ${daemonPid}.`, "info");
				} catch (killErr: any) {
					if (killErr.code === "ESRCH") {
						ctx.ui.notify(`Daemon pid ${daemonPid} not running.`, "info");
					} else {
						ctx.ui.notify(`Failed to kill daemon: ${redact(killErr.message, undefined)}`, "error");
					}
				}
			} catch {
				ctx.ui.notify("Could not read daemon-state.json. Is the daemon running?", "warning");
			}
			return;
		}
		case "help": {
			ctx.ui.notify(
				"Daemon subcommands: status, install, uninstall, start, stop, help. " +
					"The daemon hosts pi --mode rpc at Windows boot when no active TUI heartbeat exists.",
				"info",
			);
			return;
		}
		default: {
			ctx.ui.notify(`Unknown daemon subcommand: ${sub}`, "warning");
		}
	}
}

// ---------------------------------------------------------------------------
// Human-facing formatting
// ---------------------------------------------------------------------------

function formatStatusForHuman(status: Record<string, unknown>): string {
	const lines: string[] = [];
	lines.push("Telegram ↔ Pi bridge status");
	lines.push(`  enabled: ${status.enabled}`);
	lines.push(`  polling: ${status.polling}`);
	lines.push(`  token: ${status.tokenConfigured ? `configured (${status.tokenSource})` : "NOT configured"}`);
	lines.push(`  allowlist: ${status.allowlistCount} id(s)`);
	lines.push(`  paired chat: ${status.pairedChatId ?? "(none)"}`);
	lines.push(`  paired topic: ${status.pairedThreadId ?? "(none)"}`);
	lines.push(`  paired from: ${status.pairedFromId ?? "(none)"}`);
	lines.push(`  last seen chat: ${status.lastSeenChatId ?? "(none)"}`);
	lines.push(`  last seen from: ${status.lastSeenFromId ?? "(none)"}${status.lastSeenFromName ? ` (${status.lastSeenFromName})` : ""}`);
	lines.push(`  last seen topic: ${status.lastSeenThreadId ?? "(none)"}${status.lastSeenIsTopicMessage ? " (topic message)" : ""}`);
	lines.push(`  offset: ${status.offset}`);
	const hb = status.heartbeat as Record<string, unknown> | null;
	lines.push(`  heartbeat: ${status.heartbeatActive ? "ACTIVE" : "inactive/stale"}`);
	if (hb) lines.push(`    pid=${hb.pid} mode=${hb.mode} age=${hb.ageMs}ms`);
	const active = status.activeSession as Record<string, unknown> | null;
	lines.push(`  active session claim: ${active ? (active.owner ? "THIS SESSION" : "other session") : "(none)"}`);
	if (active) lines.push(`    pid=${active.pid} mode=${active.mode} age=${active.ageMs}ms reason=${active.reason}`);
	if (status.lastError) lines.push(`  lastError: ${status.lastError}`);
	if (status.mode) lines.push(`  mode: ${status.mode}`);
	return lines.join("\n");
}

const TELEGRAM_HELP = [
	"Telegram ↔ Pi bridge",
	"  /telegram status          - show non-secret runtime state",
	"  /telegram setup           - guided or env-var auto-setup (set TELEGRAM_BOT_TOKEN + ALLOWED_FROM + CHAT_ID)",
	"  /telegram pair            - pair the most recent Telegram sender",
	"  /telegram start           - start polling in this session",
	"  /telegram stop            - stop polling",
	"  /telegram takeover        - make this session the active Telegram receiver",
	"  /telegram enable          - auto-start polling on session start",
	"  /telegram disable         - disable auto-start",
	"  /telegram send <text>     - send plaintext to the paired chat",
	"  /telegram send-photo <file> [--caption \"...\"] - send a local image (JPEG/PNG/WebP, <=10MB)",
	"  /telegram daemon status   - show daemon/heartbeat state",
	"  /telegram daemon install  - install the Windows boot task",
	"  /telegram daemon uninstall- remove the Windows boot task",
	"  /telegram daemon help     - daemon help",
	"Token: TELEGRAM_BOT_TOKEN env var (preferred) or secret.token (0600).",
	"Agent tool: telegram_pi({ action: \"setup\" }) for headless auto-setup; telegram_pi({ action: \"takeover\" }) to reclaim this session.",
].join("\n");

// ---------------------------------------------------------------------------
// Re-exported helpers (for static review / future tests)
// ---------------------------------------------------------------------------

export { neutralize, splitForTelegram, redact, prefixId, buildTelegramUserMessage };
