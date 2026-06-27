#!/usr/bin/env node
/**
 * Telegram-Pi headless fallback daemon
 * =====================================
 *
 * Supervises a headless `pi --mode rpc` process that loads the global
 * `telegram-pi` extension, so Telegram can still reach Pi when no active TUI
 * session is running. It never competes with an active TUI session.
 *
 * Security & correctness invariants (see ../extensions/telegram-pi/intake.md):
 *
 * - NO TOKEN IN ARGS / XML. The bot token is read by the extension from the
 *   `TELEGRAM_BOT_TOKEN` env var (or its 0600 secret file). This daemon never
 *   reads, logs, or passes the token. The spawned `pi` process inherits the
 *   daemon's environment, so the token reaches it via `process.env` only —
 *   never via a CLI argument and never via Task Scheduler XML.
 * - HEARTBEAT GATING. Before starting the fallback, the daemon checks the TUI
 *   heartbeat file. If a TUI session is fresh (heartbeat within
 *   `heartbeatFreshSecs`), the daemon yields and stops any running fallback so
 *   the two never compete. When the heartbeat goes stale, the daemon (re)starts
 *   the fallback.
 * - CWD PRESERVED. The fallback runs with the configured cwd so Pi scheduling
 *   services (agent-scheduler) still drain the right cwd-scoped wake-ups.
 *   This daemon does NOT touch any agent-scheduler file or behavior.
 * - STRICT LF RPC FRAMING. stdout from `pi --mode rpc` is split on `\n` only
 *   (Node `readline` is NOT protocol-compliant; it also splits on U+2028 /
 *   U+2029, which are valid inside JSON strings). The daemon only tees
 *   redacted lines to the log; it does not interpret RPC.
 * - STDIN KEPT OPEN. The daemon keeps the child's stdin open so `pi --mode rpc`
 *   stays alive. It sends no prompts — the extension auto-starts Telegram
 *   polling on `session_start` when enabled.
 * - REDACTED, ROTATED LOGS. All stdout/stderr is run through a redactor
 *   (token patterns and Bot API URLs) before being appended to rotated logs.
 *
 * This file is plain ESM (.mjs) so it runs with `node` directly, no build step.
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, promises as fsp, renameSync, statSync, unlinkSync } from "node:fs";
import { EOL } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths & defaults
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Config loading: defaults < config.json < env vars
// Never reads token from config.
// ---------------------------------------------------------------------------

const HARD_DEFAULTS = {
	cwd: process.cwd(),
	piBinary: null, // null = auto-detect
	heartbeatFreshSecs: 60,
	superviseIntervalSecs: 10,
	respawnCooldownSecs: 15,
	maxLogBytes: 1_000_000,
	maxLogFiles: 5,
};

function resolvePiBinary() {
	// Prefer env override.
	if (process.env.PI_BIN) return process.env.PI_BIN;
	// Windows auto-detect: try APPDATA/npm/pi.cmd, then APPDATA/npm/pi, else fallback 'pi'.
	if (process.platform === "win32") {
		const appData = process.env.APPDATA;
		if (appData) {
			const piCmd = join(appData, "npm", "pi.cmd");
			if (existsSync(piCmd)) return piCmd;
			const piExe = join(appData, "npm", "pi");
			if (existsSync(piExe)) return piExe;
		}
	}
	return "pi";
}

async function loadConfig() {
	const cfgPath = join(__dirname, "config.json");
	let fileCfg = {};
	try {
		const raw = await fsp.readFile(cfgPath, "utf8");
		fileCfg = JSON.parse(raw);
	} catch {
		// config.json is optional
	}
	// Only allow the known safe fields (never token).
	const allowed = ["cwd", "piBinary", "heartbeatFreshSecs", "superviseIntervalSecs", "respawnCooldownSecs", "logMaxBytes", "logMaxFiles"];
	const safe = {};
	for (const k of allowed) {
		if (k in fileCfg && fileCfg[k] != null) safe[k] = fileCfg[k];
	}
	// Public config keys are logMax*, while internal runtime keys are maxLog*.
	if (safe.logMaxBytes != null) {
		safe.maxLogBytes = safe.logMaxBytes;
		delete safe.logMaxBytes;
	}
	if (safe.logMaxFiles != null) {
		safe.maxLogFiles = safe.logMaxFiles;
		delete safe.logMaxFiles;
	}
	// Env overrides config overrides defaults.
	const envMap = {
		cwd: process.env.TELEGRAM_PI_CWD,
		piBinary: process.env.PI_BIN,
		heartbeatFreshSecs: process.env.TELEGRAM_PI_HEARTBEAT_FRESH_SECS,
		superviseIntervalSecs: process.env.TELEGRAM_PI_SUPERVISE_SECS,
		respawnCooldownSecs: process.env.TELEGRAM_PI_RESPAWN_COOLDOWN_SECS,
		maxLogBytes: process.env.TELEGRAM_PI_LOG_MAX_BYTES,
		maxLogFiles: process.env.TELEGRAM_PI_LOG_MAX_FILES,
	};
	cfg = { ...HARD_DEFAULTS, ...safe };
	for (const [k, v] of Object.entries(envMap)) {
		if (v !== undefined && v !== null && v !== "") {
			if (k === "cwd" || k === "piBinary") {
				cfg[k] = v;
			} else {
				cfg[k] = Number(v);
			}
		}
	}
	// Resolve piBinary if still null.
	if (!cfg.piBinary) cfg.piBinary = resolvePiBinary();
}

// Module-level mutable config, initialized by loadConfig() in main().
let cfg = { ...HARD_DEFAULTS, piBinary: resolvePiBinary() };

const DAEMON_DIR = __dirname;
const STATE_DIR = DAEMON_DIR; // state lives beside the daemon
const HEARTBEAT_FILE = join(STATE_DIR, "heartbeat.json");
const DAEMON_STATE_FILE = join(STATE_DIR, "daemon-state.json");
const LOG_DIR = join(DAEMON_DIR, "logs");
const LOG_FILE = join(LOG_DIR, "daemon.log");

// ---------------------------------------------------------------------------
// Logging: redacted + rotated
// ---------------------------------------------------------------------------

// Telegram bot tokens look like "123456789:AAH...". Redact aggressively.
const TOKEN_RE = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g;
// Bot API URLs expose the token in the path: https://api.telegram.org/bot<TOKEN>/method
const TG_API_URL_RE = /https?:\/\/api\.telegram\.org\/bot[^\s"']+/gi;

function redact(line) {
	if (!line) return line;
	return String(line)
		.replace(TG_API_URL_RE, "[tg-api-redacted]")
		.replace(TOKEN_RE, "[token-redacted]");
}

function ensureLogDir() {
	if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

function rotateLogsIfNeeded() {
	try {
		const st = statSync(LOG_FILE);
		if (st.size < cfg.maxLogBytes) return;
		// Rotate: daemon.log.N-1 <- daemon.log.N, ..., daemon.log.0 <- daemon.log
		for (let i = cfg.maxLogFiles - 1; i > 0; i--) {
			const cur = `${LOG_FILE}.${i}`;
			const prev = `${LOG_FILE}.${i - 1}`;
			if (existsSync(prev)) {
				if (existsSync(cur)) unlinkSync(cur);
				renameSync(prev, cur);
			}
		}
		if (existsSync(LOG_FILE)) renameSync(LOG_FILE, `${LOG_FILE}.0`);
	} catch {
		// rotation is best-effort
	}
}

function logLine(level, msg) {
	ensureLogDir();
	rotateLogsIfNeeded();
	const ts = new Date().toISOString();
	const line = redact(`${ts} [${level}] ${msg}`) + EOL;
	try {
		createWriteStream(LOG_FILE, { flags: "a" }).write(line);
	} catch {
		// never let logging crash the supervisor
	}
}

// ---------------------------------------------------------------------------
// Heartbeat & daemon state
// ---------------------------------------------------------------------------

async function readJson(file, fallback) {
	try {
		const raw = await fsp.readFile(file, "utf8");
		return JSON.parse(raw);
	} catch {
		return fallback;
	}
}

async function writeJsonAtomic(file, obj) {
	const tmp = `${file}.tmp-${process.pid}`;
	await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
	await fsp.rename(tmp, file);
}

/** Returns true if a TUI session heartbeat is fresh (active TUI session).
 *  Reads `hb.ts` with `hb.at` fallback for legacy heartbeat files. */
async function tuiHeartbeatActive() {
	const hb = await readJson(HEARTBEAT_FILE, null);
	if (!hb) return false;
	const ts = hb.ts ?? hb.at;
	if (typeof ts !== "number") return false;
	// Only a TUI-mode heartbeat blocks the fallback. RPC/daemon heartbeats do
	// not (otherwise the daemon would block its own fallback).
	if (hb.mode && hb.mode !== "tui") return false;
	const ageMs = Date.now() - ts;
	return ageMs >= 0 && ageMs <= cfg.heartbeatFreshSecs * 1000;
}

async function readDaemonState() {
	return readJson(DAEMON_STATE_FILE, {
		running: false, pid: null, startedAt: null,
		lastExit: null, lastExitAt: null,
		lastError: null, lastErrorAt: null,
		consecutiveSpawnErrors: 0,
	});
}

async function writeDaemonState(patch) {
	const cur = await readDaemonState();
	const next = { ...cur, ...patch };
	await writeJsonAtomic(DAEMON_STATE_FILE, next);
	return next;
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

/** Strict LF line splitter. Splits on "\n" only and strips a trailing "\r".
 *  Does NOT use Node readline (which would also split on U+2028 / U+2029). */
function makeLfSplitter(onLine) {
	let buf = "";
	return {
	feed(chunk) {
		buf += chunk;
		let idx;
		while ((idx = buf.indexOf("\n")) >= 0) {
			let line = buf.slice(0, idx);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			buf = buf.slice(idx + 1);
			onLine(line);
		}
	},
	end() {
		if (buf.length) {
			let line = buf;
			if (line.endsWith("\r")) line = line.slice(0, -1);
			onLine(line);
			buf = "";
		}
	},
	};
}

class Fallback {
	constructor() {
		this.child = null;
		this.stdin = null; // keep a reference so stdin stays open
		this.stopping = false;
	}

	start() {
		if (this.child) return;
		this.stopping = false;

		const args = ["--mode", "rpc"];
		// NOTE: deliberately no token argument. The extension reads
		// TELEGRAM_BOT_TOKEN from process.env (inherited) or its secret file.
		logLine("info", `starting fallback: ${cfg.piBinary} ${args.join(" ")} (cwd=${cfg.cwd})`);

		let child;
		try {
			child = spawn(cfg.piBinary, args, {
				cwd: cfg.cwd,
				env: process.env, // inherit; token flows via env, not args
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (spawnErr) {
			logLine("error", `fallback spawn failed: ${redact(spawnErr && spawnErr.message ? spawnErr.message : String(spawnErr))}`);
			return { ok: false, error: spawnErr };
		}

		this.child = child;

		// Keep stdin open so pi --mode rpc does not exit waiting for input.
		this.stdin = child.stdin;

		const stdoutSplitter = makeLfSplitter((line) => logLine("rpc-out", line));
		child.stdout.on("data", (chunk) => {
			try {
				stdoutSplitter.feed(chunk.toString("utf8"));
			} catch {
				/* ignore */
			}
		});
		child.stderr.on("data", (chunk) => {
			// stderr is also redacted line-by-line
			const text = chunk.toString("utf8");
			let buf = "";
			let idx;
			buf += text;
			while ((idx = buf.indexOf("\n")) >= 0) {
				let line = buf.slice(0, idx);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				logLine("rpc-err", line);
				buf = buf.slice(idx + 1);
			}
			if (buf.length) logLine("rpc-err", buf);
		});

		child.on("spawn", () => {
			lastSpawnErrorState.consecutiveSpawnErrors = 0;
			lastSpawnErrorState.lastErrorCode = null;
			void writeDaemonState({
				running: true,
				pid: child.pid,
				startedAt: Date.now(),
				consecutiveSpawnErrors: 0,
			});
		});

		child.on("error", (err) => {
			const redactedMsg = redact(err && err.message ? err.message : String(err));
			logLine("error", `fallback child error: ${redactedMsg}`);
			const code = (err).code;
			writeDaemonState({
				running: false, pid: null,
				lastError: redactedMsg, lastErrorAt: Date.now(),
				consecutiveSpawnErrors: (lastSpawnErrorState.consecutiveSpawnErrors || 0) + 1,
				lastExitCode: code || "ERROR",
			});
			lastSpawnErrorState.consecutiveSpawnErrors = (lastSpawnErrorState.consecutiveSpawnErrors || 0) + 1;
			lastSpawnErrorState.lastErrorCode = code || "ERROR";
			this.child = null;
			this.stdin = null;
		});

		child.on("exit", (code, signal) => {
			logLine("info", `fallback exited code=${code} signal=${signal || ""}`);
			writeDaemonState({ running: false, pid: null, lastExit: code, lastExitAt: Date.now() });
			this.child = null;
			this.stdin = null;
		});

		return { ok: true, pid: child.pid };
	}

	async stop() {
		if (!this.child) return;
		this.stopping = true;
		logLine("info", "stopping fallback (yielding to active TUI session)");
		try {
			// Graceful: close stdin first so pi can flush session_shutdown, then
			// SIGTERM. On Windows there is no SIGTERM; use taskkill /PID /T as
			// a fallback after a short grace period.
			this.stdin && this.stdin.end();
		} catch {
			/* ignore */
		}
		const child = this.child;
		const pid = child.pid;
		const killed = await new Promise((resolveKill) => {
			let done = false;
			const fin = (v) => {
				if (done) return;
				done = true;
				resolveKill(v);
			};
			child.once("exit", () => fin(true));
			try {
				child.kill("SIGTERM");
			} catch {
				/* ignore */
			}
			// Windows grace fallback after 3s
			setTimeout(() => {
				if (!done && pid) {
					try {
						spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
					} catch {
						/* ignore */
					}
				}
				// Give taskkill a moment then resolve regardless
				setTimeout(() => fin(true), 1500);
			}, 3000).unref();
		});
		this.child = null;
		this.stdin = null;
		logLine("info", `fallback stop complete (killed=${killed})`);
	}

	get isRunning() {
		return !!this.child;
	}
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// Track consecutive spawn errors for ENOENT fatal-stop logic.
const lastSpawnErrorState = { consecutiveSpawnErrors: 0, lastErrorCode: null };
const MAX_CONSECUTIVE_ENOENT = 3;

async function main() {
	ensureLogDir();
	// Load config (defaults < config.json < env).
	await loadConfig();
	logLine("info", `telegram-pi daemon started (pid=${process.pid}) cwd=${cfg.cwd} pi=${cfg.piBinary}`);
	await writeDaemonState({ daemonPid: process.pid, startedAt: Date.now(), running: false, pid: null, consecutiveSpawnErrors: 0 });

	const fallback = new Fallback();
	let lastSpawnAt = 0;
	let stopping = false;
	let enoentFatal = false;

	const stopAll = async () => {
		if (stopping) return;
		stopping = true;
		logLine("info", "daemon shutting down");
		await fallback.stop();
		await writeDaemonState({ running: false, pid: null, daemonPid: null });
		process.exit(0);
	};
	process.on("SIGINT", stopAll);
	process.on("SIGTERM", stopAll);
	process.on("SIGHUP", stopAll);

	// Keep the daemon itself alive even if stdin is closed by a parent.
	process.stdin && process.stdin.resume && process.stdin.resume();

	while (!stopping) {
		try {
			const tuiActive = await tuiHeartbeatActive();
			if (tuiActive) {
				if (fallback.isRunning) {
					logLine("info", "active TUI heartbeat detected; yielding fallback");
					await fallback.stop();
				}
			} else {
				if (!fallback.isRunning) {
					// Check for repeated ENOENT fatal stop.
					if (lastSpawnErrorState.lastErrorCode === "ENOENT" &&
						lastSpawnErrorState.consecutiveSpawnErrors >= MAX_CONSECUTIVE_ENOENT) {
						if (!enoentFatal) {
							enoentFatal = true;
							logLine("error", `pi binary not found after ${lastSpawnErrorState.consecutiveSpawnErrors} attempts (ENOENT). Fatal: no more respawns until restart or config change.`);
							await writeDaemonState({
								running: false, pid: null,
								lastError: `ENOENT repeated ${lastSpawnErrorState.consecutiveSpawnErrors}x — fatal stop`,
								lastErrorAt: Date.now(),
							});
						}
					} else {
						const since = Date.now() - lastSpawnAt;
						const cooldownMs = cfg.respawnCooldownSecs * 1000;
						if (since >= cooldownMs) {
							const result = fallback.start();
							lastSpawnAt = Date.now();
							if (result && result.ok) {
								// running:true is written only from the child's "spawn" event.
							} else {
								// Spawn failed. Error handling is in the child.on("error") handler.
								const err = result && result.error;
								const code = err && err.code ? err.code : null;
								const redactedMsg = err ? redact(err.message || String(err)) : "unknown spawn error";
								lastSpawnErrorState.consecutiveSpawnErrors = (lastSpawnErrorState.consecutiveSpawnErrors || 0) + 1;
								lastSpawnErrorState.lastErrorCode = code;
								await writeDaemonState({
									running: false, pid: null,
									lastError: redactedMsg,
									lastErrorAt: Date.now(),
									consecutiveSpawnErrors: lastSpawnErrorState.consecutiveSpawnErrors,
									lastExitCode: code || "SPAWN_FAIL",
								});
								logLine("error", `fallback spawn error: ${redactedMsg} (consecutive=${lastSpawnErrorState.consecutiveSpawnErrors})`);
							}
						}
					}
				}
			}
		} catch (err) {
			logLine("error", `supervise loop error: ${err && err.message ? err.message : String(err)}`);
		}
		await sleep(cfg.superviseIntervalSecs * 1000);
	}
}

main().catch((err) => {
	logLine("error", `fatal: ${err && err.stack ? err.stack : String(err)}`);
	process.exit(1);
});
