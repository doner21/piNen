import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type Phase = "idle" | "polling" | "command-in-flight" | "verifying" | "done" | "failed";

export interface ExecuteEntry {
	ts: number;
	phase: Phase;
	requestId?: string;
	executeCommandAvailable: boolean;
	cwd: string;
	coalesced: boolean;
}

export interface TickEntry {
	ts: number;
	isIdle: boolean;
	hasPendingMessages: boolean;
	stableIdle: boolean;
	idleTicks: number;
}

export interface NewSessionDiagnostics {
	requestId?: string;
	phase: Phase;
	scheduled?: number;
	requested?: number;
	idleDetected?: number;
	newSessionInvoked?: number;
	executeCommandResolved?: number;
	executeCommandDurationMs?: number;
	confirmedAt?: number;
	lastUpdated?: string;
	newSessionConfirmed?: boolean;
	confirmedBy?: string;
	executeCommandRejected?: boolean;
	hardTimeout?: boolean;
	newSessionSilentlyFailed?: boolean;
	newSessionCancelled?: boolean;
	timeout?: boolean;
	error?: string;
	lateExecuteCommandRejectedAfterConfirmation?: boolean;
	lateHardTimeoutAfterConfirmation?: boolean;
	lateErrorAfterConfirmation?: string;
	executeCommandTimedOut?: boolean;
	retried?: boolean;
	retryCount?: number;
	attempts: number;
	cwd: string;
	executeCommandAvailable: boolean;
	executeEntries?: ExecuteEntry[];
	tickLog?: TickEntry[];
}

const NEW_SESSION_CONFIRMATION = "session_shutdown:new";
const DIAGNOSTICS_FILE = "agent-new-session-diagnostics.json";

export interface WriteDiagnosticsOptions {
	/** Start a new request generation instead of inheriting terminal state. */
	resetForRequest?: boolean;
}

/** Serialize writes from this extension instance so older async writes cannot
 * land after newer ones. The file remains shared across Pi processes, so the
 * request-generation checks below also reject stale cross-process updates. */
let diagnosticsWriteQueue: Promise<void> = Promise.resolve();

function requestEpoch(requestId: string | undefined): number | undefined {
	const match = /^new-(\d+)(?:-|$)/.exec(requestId ?? "");
	if (!match) return undefined;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : undefined;
}

/**
 * Resolve diagnostics independently of the active project cwd. Relative
 * PI_HOME values are anchored to the OS user home, never the working directory.
 */
export function resolveCanonicalNewSessionDiagnosticsPath(
	env: Readonly<Record<string, string | undefined>> = process.env,
	userHome: string = homedir(),
): string {
	const configuredPiHome = env.PI_HOME?.trim();
	const piHome = configuredPiHome
		? resolve(userHome, configuredPiHome)
		: resolve(userHome, ".pi");
	return resolve(piHome, "agent", DIAGNOSTICS_FILE);
}

function applyCanonicalDefaults(
	merged: NewSessionDiagnostics,
	confirmationObserved: boolean,
): void {
	merged.lastUpdated = new Date().toISOString();

	if (confirmationObserved) {
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

	if (merged.newSessionConfirmed === undefined) merged.newSessionConfirmed = false;
	if (merged.newSessionSilentlyFailed === undefined) merged.newSessionSilentlyFailed = false;
	if (merged.executeCommandRejected === undefined) merged.executeCommandRejected = false;
}

function rawTextContainsConfirmation(raw: string): boolean {
	return raw.includes('"confirmedBy"') && raw.includes('"session_shutdown:new"');
}

/**
 * Write to the canonical Pi-home document. `cwd` is provenance only and is
 * deliberately ignored when selecting the storage path.
 */
export function writeDiagnostics(
	patch: Partial<NewSessionDiagnostics> & { attempts?: number; cwd?: string; executeCommandAvailable?: boolean },
	cwd: string,
	options: WriteDiagnosticsOptions = {},
): Promise<void> {
	const operation = diagnosticsWriteQueue.then(() => writeDiagnosticsOnce(patch, cwd, options));
	diagnosticsWriteQueue = operation.catch(() => {});
	return operation;
}

async function writeDiagnosticsOnce(
	patch: Partial<NewSessionDiagnostics> & { attempts?: number; cwd?: string; executeCommandAvailable?: boolean },
	cwd: string,
	options: WriteDiagnosticsOptions,
): Promise<void> {
	let tmpPath: string | undefined;
	try {
		const diagPath = resolveCanonicalNewSessionDiagnosticsPath();
		const dir = dirname(diagPath);
		await fsp.mkdir(dir, { recursive: true });

		let raw: string | undefined;
		let existing: NewSessionDiagnostics;
		let recoveredConfirmation = false;

		try {
			raw = await fsp.readFile(diagPath, "utf8");
			existing = JSON.parse(raw as string);
		} catch {
			if (raw !== undefined && rawTextContainsConfirmation(raw)) recoveredConfirmation = true;
			existing = {
				phase: "idle",
				attempts: 0,
				cwd,
				executeCommandAvailable: false,
			};
		}

		const differentRequest = Boolean(
			patch.requestId && existing.requestId && patch.requestId !== existing.requestId,
		);
		const patchEpoch = requestEpoch(patch.requestId);
		const existingEpoch = requestEpoch(existing.requestId);
		const staleDifferentRequest =
			differentRequest &&
			!options.resetForRequest &&
			patchEpoch !== undefined &&
			existingEpoch !== undefined &&
			patchEpoch < existingEpoch;
		const newerDifferentRequest =
			differentRequest &&
			patchEpoch !== undefined &&
			existingEpoch !== undefined &&
			patchEpoch > existingEpoch;
		const resetForRequest = options.resetForRequest || newerDifferentRequest;

		let merged: NewSessionDiagnostics;
		if (staleDifferentRequest) {
			// An older Pi process finished after a newer request started. Keep only
			// its bounded audit entry; never let it confirm/fail the newer request.
			merged = { ...existing };
			if (patch.executeEntries) {
				merged.executeEntries = [
					...(existing.executeEntries ?? []),
					...patch.executeEntries,
				].slice(-20);
			}
		} else {
			const base: NewSessionDiagnostics = resetForRequest
				? {
					phase: "idle",
					attempts: 0,
					cwd,
					executeCommandAvailable: patch.executeCommandAvailable ?? false,
					executeEntries: existing.executeEntries,
				}
				: existing;
			merged = { ...base, ...patch };
			if (patch.executeEntries && base.executeEntries) {
				merged.executeEntries = [...base.executeEntries, ...patch.executeEntries].slice(-20);
			} else if (base.executeEntries && !patch.executeEntries) {
				merged.executeEntries = base.executeEntries;
			}
			if (!resetForRequest) {
				if (patch.tickLog && base.tickLog) {
					merged.tickLog = [...base.tickLog, ...patch.tickLog].slice(-80);
				} else if (base.tickLog && !patch.tickLog) {
					merged.tickLog = base.tickLog;
				}
			}
		}

		const confirmationObserved =
			!resetForRequest &&
			(recoveredConfirmation ||
				merged.newSessionConfirmed === true ||
				merged.confirmedBy === NEW_SESSION_CONFIRMATION);
		applyCanonicalDefaults(merged, confirmationObserved);

		tmpPath = resolve(dir, `.agent-new-session-diagnostics.tmp-${randomUUID().slice(0, 8)}`);
		await fsp.writeFile(tmpPath, JSON.stringify(merged, null, 2), "utf8");
		try {
			await fsp.rename(tmpPath, diagPath);
			tmpPath = undefined;
		} catch (renameError) {
			// Windows antivirus/indexing and competing Pi processes can briefly
			// reject replacement renames. copyFile still replaces the complete
			// destination and the finally block removes the source temp file.
			await fsp.copyFile(tmpPath, diagPath);
			await fsp.unlink(tmpPath);
			tmpPath = undefined;
			void renameError;
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[agent-new-session] writeDiagnostics FAILED: ${msg}\n`);
	} finally {
		if (tmpPath) await fsp.unlink(tmpPath).catch(() => {});
	}
}
