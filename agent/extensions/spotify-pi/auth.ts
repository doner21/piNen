/**
 * Spotify OAuth Authorization Code + PKCE flow.
 *
 * Login starts a transient loopback HTTP server on 127.0.0.1:8888, opens the
 * browser to a local start URL, redirects the browser to the Spotify authorize
 * URL, captures the `code` callback, exchanges it for tokens, and persists them
 * via store.ts. The server is closed as soon as the code is captured or the
 * login times out.
 *
 * Token refresh keeps access tokens fresh; refresh proactively when within
 * REFRESH_MARGIN_MS of expiry, and reactively on a 401 (handled in api.ts).
 *
 * No token values are ever logged or returned to callers.
 */

import { randomBytes, createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import type { TokenSet } from "./types.ts";
import {
	ACCOUNTS_URL,
	CLIENT_ID,
	LOGIN_TIMEOUT_MS,
	REDIRECT_PORT,
	REDIRECT_URI,
	REFRESH_MARGIN_MS,
	SCOPES,
	MISSING_CLIENT_ID_MSG,
} from "./config.ts";
import { clearTokens, ensureStorageDir, loadTokens, saveTokens } from "./store.ts";

/** Local URL opened in the browser before redirecting to Spotify. */
const LOGIN_START_PATH = "/spotify-pi-login-start";

/** Base64url-encode a buffer without padding (RFC 7636). */
function base64url(buf: Buffer): string {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a high-entropy PKCE code_verifier and its S256 code_challenge. */
function generatePkce(): { verifier: string; challenge: string } {
	const verifier = base64url(randomBytes(64));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

/** Build the Spotify authorize URL for the PKCE flow. */
export function buildAuthorizeUrl(): { url: string; verifier: string; state: string } {
	if (!CLIENT_ID) throw new Error(MISSING_CLIENT_ID_MSG);
	const { verifier, challenge } = generatePkce();
	const state = randomUUID();
	const params = new URLSearchParams({
		response_type: "code",
		client_id: CLIENT_ID,
		scope: SCOPES.join(" "),
		redirect_uri: REDIRECT_URI,
		state,
		code_challenge_method: "S256",
		code_challenge: challenge,
	});
	return { url: `${ACCOUNTS_URL}/authorize?${params.toString()}`, verifier, state };
}

/** Best-effort cross-platform browser open. Never throws. */
function openBrowser(url: string): void {
	try {
		if (process.platform === "win32") {
			// Do not use `cmd /c start <url>` here: cmd treats `&` in the
			// OAuth query string as command separators, which can open a truncated
			// authorize URL and make Spotify report `client_id: Not present`.
			spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
				detached: true,
				windowsHide: true,
			}).unref();
		} else if (process.platform === "darwin") {
			spawn("open", [url], { detached: true }).unref();
		} else {
			spawn("xdg-open", [url], { detached: true }).unref();
		}
	} catch {
		/* Best effort only; login will time out if the browser cannot be opened. */
	}
}

/** Exchange an authorization code for a token set. */
async function exchangeCode(code: string, verifier: string): Promise<TokenSet> {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		redirect_uri: REDIRECT_URI,
		client_id: CLIENT_ID,
		code_verifier: verifier,
	});
	const res = await fetch(`${ACCOUNTS_URL}/api/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	const data = (await res.json()) as Record<string, unknown>;
	if (!res.ok || typeof data.access_token !== "string") {
		throw new Error(
			`Spotify token exchange failed: ${typeof data.error === "string" ? data.error : res.status}`,
		);
	}
	return {
		access_token: data.access_token as string,
		refresh_token: data.refresh_token as string,
		expires_at: Date.now() + (data.expires_in as number) * 1000,
		scope: data.scope as string | undefined,
		token_type: data.token_type as string | undefined,
	};
}

/** Refresh an expired access token using the refresh token. Returns a new TokenSet. */
export async function refreshTokens(current: TokenSet): Promise<TokenSet> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: current.refresh_token,
		client_id: CLIENT_ID,
	});
	const res = await fetch(`${ACCOUNTS_URL}/api/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	const data = (await res.json()) as Record<string, unknown>;
	if (!res.ok || typeof data.access_token !== "string") {
		throw new Error(
			`Spotify token refresh failed: ${typeof data.error === "string" ? data.error : res.status}`,
		);
	}
	const next: TokenSet = {
		access_token: data.access_token as string,
		// Spotify may or may not return a new refresh_token; keep the old one if absent.
		refresh_token: (data.refresh_token as string) || current.refresh_token,
		expires_at: Date.now() + (data.expires_in as number) * 1000,
		scope: (data.scope as string | undefined) ?? current.scope,
		token_type: (data.token_type as string | undefined) ?? current.token_type,
	};
	await saveTokens(next);
	return next;
}

/** True if the token set is missing or within REFRESH_MARGIN_MS of expiry. */
export function needsRefresh(tokens: TokenSet | null): boolean {
	if (!tokens) return true;
	return tokens.expires_at - Date.now() <= REFRESH_MARGIN_MS;
}

/**
 * Return valid, fresh tokens, refreshing (and persisting) if needed.
 * Throws a clear error if the user is not logged in.
 */
export async function ensureFreshTokens(): Promise<TokenSet> {
	if (!CLIENT_ID) throw new Error(MISSING_CLIENT_ID_MSG);
	const tokens = await loadTokens();
	if (!tokens) {
		throw new Error("Not logged in to Spotify. Run /spotify-login first.");
	}
	if (needsRefresh(tokens)) {
		try {
			return await refreshTokens(tokens);
		} catch (err) {
			// If the refresh token itself is dead, force re-login.
			throw new Error(
				`Spotify session expired and could not be refreshed: ${(err as Error).message}. Run /spotify-login again.`,
			);
		}
	}
	return tokens;
}

/** Returns the current access token (refreshing if necessary). For api.ts. */
export async function getAccessToken(): Promise<string> {
	const tokens = await ensureFreshTokens();
	return tokens.access_token;
}

/**
 * Run the interactive PKCE login flow.
 * Returns a short, non-secret summary string for display.
 */
export async function login(): Promise<string> {
	if (!CLIENT_ID) throw new Error(MISSING_CLIENT_ID_MSG);
	ensureStorageDir();

	const { url, verifier, state } = buildAuthorizeUrl();

	const code = await new Promise<string>((resolve, reject) => {
		let server: Server | undefined;
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			server?.close();
			reject(new Error(`Spotify login timed out after ${LOGIN_TIMEOUT_MS / 1000}s. Try /spotify-login again.`));
		}, LOGIN_TIMEOUT_MS);

		server = createServer((req, res) => {
			try {
				const reqUrl = new URL(req.url ?? "/", REDIRECT_URI);
				if (reqUrl.pathname === LOGIN_START_PATH) {
					// Do not hand the long Spotify URL (with many '&' query params) to
					// Windows shell/open handlers. Open this short local URL instead, then
					// issue an HTTP redirect from inside Node so the browser receives the
					// exact authorize URL including client_id.
					res.writeHead(302, {
						Location: url,
						"Cache-Control": "no-store",
					});
					res.end();
					return;
				}
				if (reqUrl.pathname !== "/callback") {
					res.writeHead(404);
					res.end("Not found");
					return;
				}
				const codeParam = reqUrl.searchParams.get("code");
				const stateParam = reqUrl.searchParams.get("state");
				const errorParam = reqUrl.searchParams.get("error");

				const finish = (status: number, title: string, body: string) => {
					res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
					res.end(
						`<!doctype html><html><body style="font-family:sans-serif;padding:2em"><h2>${title}</h2><p>${body}</p><p>You can close this tab and return to Pi.</p></body></html>`,
					);
				};

				if (errorParam) {
					finish(400, "Login failed", `Spotify reported: ${errorParam}`);
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					server?.close();
					reject(new Error(`Spotify login denied: ${errorParam}`));
					return;
				}
				if (!codeParam || stateParam !== state) {
					finish(400, "Login failed", "Missing or mismatched authorization code/state.");
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					server?.close();
					reject(new Error("Spotify login callback was invalid (missing code or state mismatch)."));
					return;
				}

				finish(200, "Logged in", "Spotify authorization received.");
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				server?.close();
				resolve(codeParam);
			} catch (err) {
				res.writeHead(500);
				res.end("Internal error");
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					server?.close();
					reject(err as Error);
				}
			}
		});

		server.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			server?.close();
			if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
				reject(
					new Error(
						`Port ${REDIRECT_PORT} is already in use. Close the other program using 127.0.0.1:${REDIRECT_PORT} (or a previous /spotify-login) and try again.`,
					),
				);
			} else {
				reject(new Error(`Could not start login callback server: ${err.message}`));
			}
		});

		server.listen(REDIRECT_PORT, "127.0.0.1", () => {
			openBrowser(`http://127.0.0.1:${REDIRECT_PORT}${LOGIN_START_PATH}`);
		});
	});

	const tokens = await exchangeCode(code, verifier);
	await saveTokens(tokens);
	return "Logged in to Spotify. Tokens stored encrypted with DPAPI.";
}

/** Clear any persisted Spotify tokens (logout). */
export async function logout(): Promise<boolean> {
	return clearTokens();
}
