/**
 * Encrypted token persistence using Windows DPAPI via PowerShell.
 *
 * Tokens are never written to disk in plaintext. The TokenSet JSON is UTF-8
 * encoded, encrypted with ProtectedData.Protect (CurrentUser scope), and the
 * resulting ciphertext is base64-encoded into a single file. Decryption uses
 * ProtectedData.Unprotect.
 *
 * Secrets are passed to PowerShell over stdin only — never on the command line
 * or in process args — to avoid leaking them in process listings or logs.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { TokenSet } from "./types.ts";
import { STORAGE_DIR, TOKEN_PATH } from "./config.ts";

const ENCRYPT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($enc))
`.trim();

const DECRYPT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$b64 = [Console]::In.ReadToEnd().Trim()
$enc = [Convert]::FromBase64String($b64)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser')
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`.trim();

/** Run a PowerShell script, feeding stdin and returning trimmed stdout. */
function runPowerShell(script: string, stdin: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ windowsHide: true },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));
		child.on("error", (err) => reject(new Error(`Failed to start PowerShell: ${err.message}`)));
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`PowerShell exited ${code}: ${stderr.trim()}`));
				return;
			}
			resolve(stdout);
		});
		// Write the secret payload to stdin, then end.
		child.stdin.on("error", () => {
			/* ignore broken pipe; close handler will reject */
		});
		child.stdin.end(stdin, "utf8");
	});
}

/** Encrypt and persist a TokenSet to disk. Overwrites any existing token. */
export async function saveTokens(tokens: TokenSet): Promise<void> {
	const json = JSON.stringify(tokens);
	const base64 = await runPowerShell(ENCRYPT_SCRIPT, json);
	mkdirSync(dirname(TOKEN_PATH), { recursive: true });
	// Direct overwrite is fine here; the file is already DPAPI-encrypted and the
	// plaintext never touches disk, so a crash mid-write only risks an unreadable
	// (decrypt-failing) file, which loadTokens handles gracefully.
	writeFileSync(TOKEN_PATH, base64, "utf8");
}

/** Load and decrypt the persisted TokenSet, or null if none / unreadable. */
export async function loadTokens(): Promise<TokenSet | null> {
	if (!existsSync(TOKEN_PATH)) return null;
	let base64: string;
	try {
		base64 = readFileSync(TOKEN_PATH, "utf8").trim();
	} catch {
		return null;
	}
	if (!base64) return null;
	try {
		const json = await runPowerShell(DECRYPT_SCRIPT, base64);
		const parsed = JSON.parse(json) as TokenSet;
		if (
			typeof parsed?.access_token !== "string" ||
			typeof parsed?.refresh_token !== "string" ||
			typeof parsed?.expires_at !== "number"
		) {
			return null;
		}
		return parsed;
	} catch {
		// Corrupt or non-DPAPI file (e.g. migrated/plaintext). Treat as logged out.
		return null;
	}
}

/** Delete the persisted token file if it exists. */
export function clearTokens(): boolean {
	if (!existsSync(TOKEN_PATH)) return false;
	try {
		unlinkSync(TOKEN_PATH);
		return true;
	} catch {
		return false;
	}
}

/** Ensure the storage directory exists (used at login time). */
export function ensureStorageDir(): void {
	mkdirSync(STORAGE_DIR, { recursive: true });
}
