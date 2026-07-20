/**
 * SpotifyClient — thin fetch wrapper around the Spotify Web API.
 *
 * Responsibilities:
 *  - Attach the current bearer token (refreshing transparently when needed).
 *  - Retry once on 401 after a token refresh.
 *  - Honor 429 Retry-After with a bounded backoff.
 *  - Translate 204 No Content to null.
 *  - Produce clear errors for 403 (Premium required) and other failures.
 *
 * No token values are surfaced in errors or returned to callers.
 */

import { API_BASE } from "./config.ts";
import { getAccessToken, refreshTokens, ensureFreshTokens } from "./auth.ts";
import { loadTokens, saveTokens } from "./store.ts";
import type { TokenSet } from "./types.ts";
import type {
	DeviceSummary,
	PlaybackState,
	SpotifyDevice,
	TrackSummary,
} from "./types.ts";

/** Bounded retry budget for 429 Retry-After. */
const MAX_RETRY_AFTER_MS = 30_000;

/** Sleep helper that respects an abort signal. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(new Error("Aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Format a Spotify error response into a human-readable message. */
async function formatError(status: number, res: Response): Promise<string> {
	if (status === 403) {
		// Playback mutation endpoints require Spotify Premium.
		return "Spotify returned 403 Forbidden. Playback control (play/pause/transfer/queue/etc.) requires a Spotify Premium account.";
	}
	let detail = "";
	try {
		const data = (await res.json()) as { error?: { message?: string } };
		detail = data?.error?.message ?? "";
	} catch {
		/* ignore */
	}
	return `Spotify API error ${status}: ${detail || res.statusText}`.trim();
}

export class SpotifyClient {
	/** Perform an authenticated request, with 401-refresh and 429-retry handling. */
	async request<T>(
		method: string,
		path: string,
		opts: { body?: unknown; query?: Record<string, string | number | boolean | undefined>; signal?: AbortSignal } = {},
	): Promise<T | null> {
		const url = new URL(
			path.startsWith("http") ? path : `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}`,
		);
		if (opts.query) {
			for (const [k, v] of Object.entries(opts.query)) {
				if (v !== undefined) url.searchParams.set(k, String(v));
			}
		}

		let refreshed = false;
		for (let attempt = 0; attempt < 3; attempt++) {
			const token = await getAccessToken();
			const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
			let body: BodyInit | undefined;
			if (opts.body !== undefined) {
				headers["Content-Type"] = "application/json";
				body = JSON.stringify(opts.body);
			}

			const res = await fetch(url, { method, headers, body, signal: opts.signal });

			if (res.status === 204) return null;

			if (res.status === 401 && !refreshed) {
				// Force a refresh and retry once.
				refreshed = true;
				await this.forceRefresh();
				continue;
			}

			if (res.status === 429) {
				const retryAfter = Number(res.headers.get("Retry-After") ?? "1");
				const ms = Math.min(Math.max(isNaN(retryAfter) ? 1000 : retryAfter * 1000, 500), MAX_RETRY_AFTER_MS);
				await sleep(ms, opts.signal);
				continue;
			}

			if (!res.ok) {
				throw new Error(await formatError(res.status, res));
			}

			if (method === "GET" || method === "PUT" || method === "POST" || method === "DELETE") {
				const text = await res.text();
				if (!text) return null;
				try {
					return JSON.parse(text) as T;
				} catch {
					return null;
				}
			}
			return null;
		}
		throw new Error("Spotify API request exhausted retries (rate limited or unauthorized).");
	}

	/** Force a token refresh and persist the new set. */
	private async forceRefresh(): Promise<void> {
		const current = await loadTokens();
		if (!current) {
			// Force ensureFreshTokens to throw the "not logged in" error.
			await ensureFreshTokens();
			return;
		}
		const next: TokenSet = await refreshTokens(current);
		await saveTokens(next);
	}

	// ---- Player state -----------------------------------------------------

	/** GET /me/player — current playback state (null if nothing playing). */
	async getPlayback(signal?: AbortSignal): Promise<PlaybackState | null> {
		return this.request<PlaybackState>("GET", "/me/player", { signal });
	}

	/** GET /me/player/devices — available devices. */
	async getDevices(signal?: AbortSignal): Promise<SpotifyDevice[]> {
		const data = await this.request<{ devices?: SpotifyDevice[] }>("GET", "/me/player/devices", { signal });
		return data?.devices ?? [];
	}

	// ---- Playback control -------------------------------------------------

	/** Transfer playback to a device. */
	async transferPlayback(deviceId: string, play?: boolean, signal?: AbortSignal): Promise<void> {
		await this.request("PUT", "/me/player", {
			body: { device_ids: [deviceId], play: play ?? false },
			signal,
		});
	}

	/** Resume / start playback. */
	async play(params: { context_uri?: string; uris?: string[]; offset?: unknown; position_ms?: number; device_id?: string }, signal?: AbortSignal): Promise<void> {
		const query = params.device_id ? { device_id: params.device_id } : undefined;
		// Only context_uri/uris/offset/position_ms belong in the body; device_id is a query param.
		const body: Record<string, unknown> = {};
		if (params.context_uri !== undefined) body.context_uri = params.context_uri;
		if (params.uris !== undefined) body.uris = params.uris;
		if (params.offset !== undefined) body.offset = params.offset;
		if (params.position_ms !== undefined) body.position_ms = params.position_ms;
		await this.request("PUT", "/me/player/play", { body, query, signal });
	}

	/** Pause playback. */
	async pause(deviceId?: string, signal?: AbortSignal): Promise<void> {
		const query = deviceId ? { device_id: deviceId } : undefined;
		await this.request("PUT", "/me/player/pause", { query, signal });
	}

	/** Skip to next track. */
	async next(deviceId?: string, signal?: AbortSignal): Promise<void> {
		const query = deviceId ? { device_id: deviceId } : undefined;
		await this.request("POST", "/me/player/next", { query, signal });
	}

	/** Skip to previous track. */
	async previous(deviceId?: string, signal?: AbortSignal): Promise<void> {
		const query = deviceId ? { device_id: deviceId } : undefined;
		await this.request("POST", "/me/player/previous", { query, signal });
	}

	/** Seek to a position (ms). */
	async seek(positionMs: number, deviceId?: string, signal?: AbortSignal): Promise<void> {
		const query: Record<string, string | number> = { position_ms: positionMs };
		if (deviceId) query.device_id = deviceId;
		await this.request("PUT", "/me/player/seek", { query, signal });
	}

	/** Set volume (0-100). */
	async setVolume(volumePercent: number, deviceId?: string, signal?: AbortSignal): Promise<void> {
		const query: Record<string, string | number> = { volume_percent: volumePercent };
		if (deviceId) query.device_id = deviceId;
		await this.request("PUT", "/me/player/volume", { query, signal });
	}

	/** Set repeat mode: track | context | off. */
	async setRepeat(state: "track" | "context" | "off", deviceId?: string, signal?: AbortSignal): Promise<void> {
		const query: Record<string, string> = { state };
		if (deviceId) query.device_id = deviceId;
		await this.request("PUT", "/me/player/repeat", { query, signal });
	}

	/** Set shuffle on/off. */
	async setShuffle(state: boolean, deviceId?: string, signal?: AbortSignal): Promise<void> {
		const query: Record<string, string | boolean> = { state };
		if (deviceId) query.device_id = deviceId;
		await this.request("PUT", "/me/player/shuffle", { query, signal });
	}

	/** Add a track to the queue by URI. */
	async addToQueue(uri: string, deviceId?: string, signal?: AbortSignal): Promise<void> {
		const query: Record<string, string> = { uri };
		if (deviceId) query.device_id = deviceId;
		await this.request("POST", "/me/player/queue", { query, signal });
	}

	/** GET /me/player/queue — current queue (recently played + queue). */
	async getQueue(signal?: AbortSignal): Promise<{
		currently_playing?: unknown;
		Queue?: unknown;
		queue?: unknown;
	} | null> {
		// Spotify returns { currently_playing, queue } (lowercase). Keep tolerant.
		return this.request("GET", "/me/player/queue", { signal });
	}

	// ---- Search & library -------------------------------------------------

	/** Search Spotify. */
	async search(query: string, type: "track" | "artist" | "album" | "playlist" | "show" | "episode" = "track", limit = 10, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const data = await this.request<Record<string, unknown>>("GET", "/search", {
			query: { q: query, type, limit },
			signal,
		});
		return data ?? {};
	}

	/** Save tracks to Liked Songs. */
	async saveTracks(ids: string[], signal?: AbortSignal): Promise<void> {
		await this.request("PUT", "/me/tracks", { query: { ids: ids.join(",") }, signal });
	}

	/** Remove tracks from Liked Songs. */
	async removeTracks(ids: string[], signal?: AbortSignal): Promise<void> {
		await this.request("DELETE", "/me/tracks", { query: { ids: ids.join(",") }, signal });
	}

	/** GET /me/tracks — Liked Songs (paginated). */
	async getLiked(limit = 50, offset = 0, signal?: AbortSignal): Promise<{
		href: string;
		total: number;
		items: Array<{ track?: Record<string, unknown> }>;
	}> {
		const data = await this.request<{ href: string; total: number; items: Array<{ track?: Record<string, unknown> }> }>(
			"GET",
			"/me/tracks",
			{ query: { limit, offset }, signal },
		);
		return data ?? { href: "", total: 0, items: [] };
	}
}

// ---- Shared formatting helpers ------------------------------------------

/** Normalize a raw Spotify track object into a compact, non-secret summary. */
export function summarizeTrack(raw: Record<string, unknown> | undefined | null): TrackSummary | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as {
		uri?: string;
		id?: string | null;
		name?: string;
		duration_ms?: number;
		artists?: Array<{ name?: string }>;
		album?: { name?: string };
	};
	if (typeof r.uri !== "string") return null;
	return {
		uri: r.uri,
		id: r.id ?? null,
		name: r.name ?? "(unknown)",
		artists: (r.artists ?? []).map((a) => a.name ?? "").filter(Boolean),
		album: r.album?.name ?? null,
		duration_ms: typeof r.duration_ms === "number" ? r.duration_ms : null,
	};
}

/** Summarize a device list for tool output. */
export function summarizeDevices(devices: SpotifyDevice[]): DeviceSummary[] {
	return devices.map((d) => ({
		id: d.id,
		name: d.name,
		type: d.type,
		is_active: d.is_active,
		volume_percent: d.volume_percent,
	}));
}
