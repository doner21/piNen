/**
 * spotify-pi — Pi global extension for Spotify playback control.
 *
 * Registers:
 *   /spotify-login   — run the PKCE browser flow, store DPAPI-encrypted tokens
 *   /spotify-logout  — clear stored tokens
 *
 * Tools (LLM-callable):
 *   spotify_status, spotify_devices, spotify_transfer, spotify_play,
 *   spotify_pause, spotify_next, spotify_previous, spotify_seek,
 *   spotify_volume, spotify_repeat, spotify_shuffle, spotify_queue_add,
 *   spotify_queue_show, spotify_search, spotify_like, spotify_unlike,
 *   spotify_liked_random
 *
 * Security: tokens are never logged or returned to the LLM. Only non-secret
 * summaries (track names, device names, expiry) are surfaced in tool output.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { SpotifyClient, summarizeDevices, summarizeTrack } from "./api.ts";
import { requireDeviceId, resolveDeviceId } from "./devices.ts";
import { login, logout } from "./auth.ts";
import { CLIENT_ID, MISSING_CLIENT_ID_MSG } from "./config.ts";
import type { TrackSummary } from "./types.ts";

/** Build a text tool result. `isError` records the failure in `details` (the
 * runtime conveys errors via content text + details, not an isError field). */
function text(t: string, isError = false) {
	return {
		content: [{ type: "text" as const, text: t }],
		details: isError ? { error: true } : {},
	};
}

/** Format a track summary for display. */
function fmtTrack(t: TrackSummary | null): string {
	if (!t) return "(nothing playing)";
	const artists = t.artists.length ? t.artists.join(", ") : "unknown artist";
	const album = t.album ? ` — ${t.album}` : "";
	return `${t.name} by ${artists}${album}`;
}

/** Pull the first track URI out of a /search response. */
function firstTrackUri(searchData: Record<string, unknown>): { uri: string; name: string } | null {
	const tracks = searchData?.tracks as { items?: Array<Record<string, unknown>> } | undefined;
	const item = tracks?.items?.[0];
	const uri = item?.uri;
	if (typeof uri !== "string") return null;
	const name = typeof item?.name === "string" ? item.name : "(unknown)";
	return { uri, name };
}

/** Extract track ids from raw Liked Songs items. */
function likedTrackIds(items: Array<{ track?: Record<string, unknown> }>): string[] {
	const ids: string[] = [];
	for (const it of items) {
		const id = it.track?.id;
		if (typeof id === "string") ids.push(id);
	}
	return ids;
}

export default function spotifyPi(pi: ExtensionAPI) {
	// Shared client instance (stateless; tokens fetched fresh per request).
	const client = new SpotifyClient();
	let loginInProgress = false;

	// ---------------------------------------------------------------- commands

	pi.registerCommand("spotify-login", {
		description: "Log in to Spotify via OAuth (PKCE). Opens a browser to authorize Pi.",
		handler: async (_args, ctx) => {
			if (!CLIENT_ID) {
				ctx.ui.notify(MISSING_CLIENT_ID_MSG, "error");
				return;
			}
			if (loginInProgress) {
				ctx.ui.notify("Spotify login is already in progress. Finish it in the browser, or wait for it to time out.", "info");
				return;
			}

			loginInProgress = true;
			ctx.ui.notify("Opening browser for Spotify login… Pi remains usable while the browser flow completes.", "info");
			void login()
				.then((summary) => ctx.ui.notify(summary, "info"))
				.catch((err) => ctx.ui.notify(`Spotify login failed: ${(err as Error).message}`, "error"))
				.finally(() => {
					loginInProgress = false;
				});
		},
	});

	pi.registerCommand("spotify-logout", {
		description: "Log out of Spotify and delete stored tokens.",
		handler: async (_args, ctx) => {
			const removed = await logout();
			ctx.ui.notify(removed ? "Logged out of Spotify." : "Was not logged in.", "info");
		},
	});

	// ------------------------------------------------------------------- tools

	pi.registerTool({
		name: "spotify_status",
		label: "Spotify Status",
		description:
			"Get the current Spotify playback state: track, artists, album, progress, playing/paused, device, shuffle, and repeat mode. Returns 'nothing playing' if idle.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			try {
				const state = await client.getPlayback(signal ?? undefined);
				if (!state || !state.item) {
					return text("Nothing is currently playing on Spotify.");
				}
				const track = summarizeTrack(state.item as Record<string, unknown>);
				const progress = state.progress_ms ?? 0;
				const dur = track?.duration_ms ?? 0;
				const pct = dur ? Math.round((progress / dur) * 100) : 0;
				const device = state.device?.name ?? "unknown device";
				const playing = state.is_playing ? "playing" : "paused";
				const lines = [
					`${playing}: ${fmtTrack(track)}`,
					`progress: ${progress}ms / ${dur}ms (${pct}%)`,
					`device: ${device}`,
					`shuffle: ${state.shuffle_state ? "on" : "off"}`,
					`repeat: ${state.repeat_state ?? "off"}`,
				];
				return text(lines.join("\n"));
			} catch (err) {
				return text(`spotify_status failed: ${(err as Error).message}`, true);
			}
		},
	});

	pi.registerTool({
		name: "spotify_devices",
		label: "Spotify Devices",
		description: "List available Spotify playback devices (name, type, id, active state, volume).",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			try {
				const devices = await client.getDevices(signal ?? undefined);
				if (devices.length === 0) return text("No Spotify devices found. Launch the Spotify app so a device can register, then retry.");
				const rows = summarizeDevices(devices).map(
					(d) =>
						`${d.is_active ? "* " : "  "}${d.name} [${d.type}] id=${d.id ?? "?"} vol=${d.volume_percent ?? "-"}`,
				);
				return text(`Spotify devices:\n${rows.join("\n")}`);
			} catch (err) {
				return text(`spotify_devices failed: ${(err as Error).message}`, true);
			}
		},
	});

	pi.registerTool({
		name: "spotify_transfer",
		label: "Spotify Transfer",
		description:
			"Transfer Spotify playback to a device. `device` is a device id or name (substring match). `play` controls whether playback resumes immediately (default false).",
		parameters: Type.Object({
			device: Type.String({ description: "Target device id or name." }),
			play: Type.Optional(Type.Boolean({ description: "Resume playback after transfer. Default false." })),
		}),
		async execute(_id, params, signal) {
			try {
				const deviceId = await requireDeviceId(client, params.device, signal ?? undefined);
				await client.transferPlayback(deviceId, params.play, signal ?? undefined);
				return text(`Transferred playback to device (id ${deviceId}).`);
			} catch (err) {
				return text(`spotify_transfer failed: ${(err as Error).message}`, true);
			}
		},
	});

	pi.registerTool({
		name: "spotify_play",
		label: "Spotify Play",
		description:
			"Resume playback, or play a track/album/playlist. Provide `uri` (a Spotify URI) to play it directly, or `query` to search and play the top track. With neither, resumes current playback on the active (or specified) device.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Search query; plays the top result track." })),
			uri: Type.Optional(Type.String({ description: "Spotify URI to play (track/album/artist/playlist)." })),
			device: Type.Optional(Type.String({ description: "Device id or name. Defaults to active device." })),
		}),
		async execute(_id, params, signal) {
			try {
				const deviceId = await resolveDeviceId(client, params.device, {
					requireActive: true,
					signal: signal ?? undefined,
				});

				let playUri = params.uri;
				if (!playUri && params.query) {
					const search = await client.search(params.query, "track", 1, signal ?? undefined);
					const hit = firstTrackUri(search);
					if (!hit) return text(`No tracks found for "${params.query}".`, true);
					playUri = hit.uri;
					// Surface what will play for the user/LLM.
				}

				if (playUri) {
					// Collection URIs (album/playlist/artist) use context_uri; tracks use uris[].
					const isCollection = /:(album|playlist|artist|show):/.test(playUri);
					await client.play(
						isCollection ? { context_uri: playUri, device_id: deviceId ?? undefined } : { uris: [playUri], device_id: deviceId ?? undefined },
						signal ?? undefined,
					);
					return text(`Playing ${playUri}.`);
				}
				await client.play({ device_id: deviceId ?? undefined }, signal ?? undefined);
				return text("Resumed playback.");
			} catch (err) {
				return text(`spotify_play failed: ${(err as Error).message}`, true);
			}
		},
	});

	pi.registerTool({
		name: "spotify_pause",
		label: "Spotify Pause",
		description: "Pause Spotify playback on the active or specified device.",
		parameters: Type.Object({
			device: Type.Optional(Type.String({ description: "Device id or name. Defaults to active device." })),
		}),
		async execute(_id, params, signal) {
			try {
				const deviceId = await resolveDeviceId(client, params.device, {
					requireActive: true,
					signal: signal ?? undefined,
				});
				await client.pause(deviceId ?? undefined, signal ?? undefined);
				return text("Paused playback.");
			} catch (err) {
				return text(`spotify_pause failed: ${(err as Error).message}`, true);
			}
		},
	});

	pi.registerTool({
		name: "spotify_next",
		label: "Spotify Next",
		description: "Skip to the next track on the active or specified device.",
		parameters: Type.Object({
			device: Type.Optional(Type.String({ description: "Device id or name. Defaults to active device." })),
		}),
		async execute(_id, params, signal) {
			try {
				const deviceId = await requireDeviceId(client, params.device, signal ?? undefined);
				await client.next(deviceId, signal ?? undefined);
				return text("Skipped to next track.");
			} catch (err) {
				return text(`spotify_next failed: ${(err as Error).message}`, true);
			}
		},
	});

	pi.registerTool({
		name: "spotify_previous",
		label: "Spotify Previous",
		description: "Skip to the previous track on the active or specified device.",
		parameters: Type.Object({
			device: Type.Optional(Type.String({ description: "Device id or name. Defaults to active device." })),
		}),
		async execute(_id, params, signal) {
			try {
				const deviceId = await requireDeviceId(client, params.device, signal ?? undefined);
				await client.previous(deviceId, signal ?? undefined);
				return text("Skipped to previous track.");
			} catch (err) {
				return text(`spotify_previous failed: ${(err as Error).message}`, true);
			}
		},
	});

	pi.registerTool({
		name: "spotify_seek",
		label: "Spotify Seek",
		description: "Seek to an absolute position (in milliseconds) in the current track.",
		parameters: Type.Object({
			position_ms: Type.Integer({ description: "Target position in milliseconds." }),
			device: Type.Optional(Type.String({ description: "Device id or name. Defaults to active device." })),
		}),
		async execute(_id, params, signal) {
			try {
				const deviceId = await requireDeviceId(client, params.device, signal ?? undefined);
				await client.seek(params.position_ms, deviceId, signal ?? undefined);
				return text(`Seeked to ${params.position_ms}ms.`);
			} catch (err) {
				return text(`spotify_seek failed: ${(err as Error).message}`, true);
			}
		},
	});

	pi.registerTool({
		name: "spotify_volume",
		label: "Spotify Volume",
		description: "Set playback volume (0-100 percent) on the active or specified device.",
		parameters: Type.Object({
			volume_percent: Type.Integer({ minimum: 0, maximum: 100, description: "Volume 0-100." }),
			device: Type.Optional(Type.String({ description: "Device id or name. Defaults to active device." })),
		}),
		async execute(_id, params, signal) {
			try {
				const deviceId = await requireDeviceId(client, params.device, signal ?? undefined);
				const v = Math.max(0, Math.min(100, params.volume_percent));
				await client.setVolume(v, deviceId, signal ?? undefined);
				return text(`Set volume to ${v}%.`);
			} catch (err) {
				return text(`spotify_volume failed: ${(err as Error).message}`, true);
			}
		},
	});

	pi.registerTool({
		name: "spotify_repeat",
		label: "Spotify Repeat",
		description: "Set Spotify repeat mode: track, context, or off.",
		parameters: Type.Object({
			state: StringEnum(["track", "context", "off"] as const, { description: "Repeat mode." }),
			device: Type.Optional(Type.String({ description: "Device id or name. Defaults to active device." })),
		}),
		async execute(_id, params, signal) {
			try {
				const deviceId = await requireDeviceId(client, params.device, signal ?? undefined);
				await client.setRepeat(params.state, deviceId, signal ?? undefined);
				return text(`Repeat set to ${params.state}.`);
			} catch (err) {
				return text(`spotify_repeat failed: ${(err as Error).message}`, true);
			}
		},
	});

	pi.registerTool({
		name: "spotify_shuffle",
		label: "Spotify Shuffle",
		description: "Turn Spotify shuffle on or off.",
		parameters: Type.Object({
			state: StringEnum(["on", "off"] as const, { description: "Shuffle state." }),
			device: Type.Optional(Type.String({ description: "Device id or name. Defaults to active device." })),
		}),
		async execute(_id, params, signal) {
			try {
				const deviceId = await requireDeviceId(client, params.device, signal ?? undefined);
				const on = params.state === "on";
				await client.setShuffle(on, deviceId, signal ?? undefined);
				return text(`Shuffle ${on ? "on" : "off"}.`);
			} catch (err) {
				return text(`spotify_shuffle failed: ${(err as Error).message}`, true);
			}
		},
	});

	pi.registerTool({
		name: "spotify_queue_add",
		label: "Spotify Queue Add",
		description:
			"Add a track to the Spotify queue. Provide `uri` (a track Spotify URI) or `query` to search and queue the top result.",
		parameters: Type.Object({
			uri: Type.Optional(Type.String({ description: "Track Spotify URI to queue." })),
			query: Type.Optional(Type.String({ description: "Search query; queues the top result track." })),
			device: Type.Optional(Type.String({ description: "Device id or name. Defaults to active device." })),
		}),
		async execute(_id, params, signal) {
			try {
				let uri = params.uri;
				if (!uri && params.query) {
					const search = await client.search(params.query, "track", 1, signal ?? undefined);
					const hit = firstTrackUri(search);
					if (!hit) return text(`No tracks found for "${params.query}".`, true);
					uri = hit.uri;
				}
				if (!uri) return text("Provide a track `uri` or a `query` to queue.", true);

				// Queue endpoints accept a device but work on the active device by default.
				const deviceId = await resolveDeviceId(client, params.device, {
					requireActive: true,
					signal: signal ?? undefined,
				});
				await client.addToQueue(uri, deviceId ?? undefined, signal ?? undefined);
				return text(`Queued ${uri}.`);
			} catch (err) {
				return text(`spotify_queue_add failed: ${(err as Error).message}`, true);
			}
		},
	});

	pi.registerTool({
		name: "spotify_queue_show",
		label: "Spotify Queue Show",
		description: "Show the current Spotify queue (upcoming tracks).",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			try {
				const data = await client.getQueue(signal ?? undefined);
				if (!data) return text("Could not read the Spotify queue.");
				const queue = (data.queue as Array<Record<string, unknown>> | undefined) ?? [];
				const current = (data.currently_playing as Record<string, unknown> | undefined) ?? null;
				if (queue.length === 0 && !current) return text("The queue is empty.");
				const lines: string[] = [];
				const cur = summarizeTrack(current);
				if (cur) lines.push(`now: ${fmtTrack(cur)}`);
				queue.slice(0, 20).forEach((raw, i) => {
					const t = summarizeTrack(raw);
					if (t) lines.push(`${i + 1}. ${fmtTrack(t)}`);
				});
				if (queue.length > 20) lines.push(`…and ${queue.length - 20} more`);
				return text(`Spotify queue:\n${lines.join("\n")}`);
			} catch (err) {
				return text(`spotify_queue_show failed: ${(err as Error).message}`, true);
			}
		},
	});

	pi.registerTool({
		name: "spotify_search",
		label: "Spotify Search",
		description: "Search Spotify for tracks, artists, albums, playlists, shows, or episodes. Defaults to tracks.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query." }),
			type: StringEnum(["track", "artist", "album", "playlist", "show", "episode"] as const, {
				description: "Result type. Default track.",
			}),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Max results (1-50). Default 10." })),
		}),
		async execute(_id, params, signal) {
			try {
				const limit = params.limit ?? 10;
				const data = await client.search(params.query, params.type, limit, signal ?? undefined);
				const bucket = (data[`${params.type}s`] as { items?: Array<Record<string, unknown>> } | undefined)
					?.items ?? [];
				if (bucket.length === 0) return text(`No ${params.type} results for "${params.query}".`);
				const rows = bucket.map((item, i) => {
					if (params.type === "track") {
						const t = summarizeTrack(item);
						return `${i + 1}. ${fmtTrack(t)} [${t?.uri ?? "?"}]`;
					}
					const name = typeof item.name === "string" ? item.name : "(unknown)";
					const uri = typeof item.uri === "string" ? item.uri : "?";
					return `${i + 1}. ${name} [${uri}]`;
				});
				return text(`Spotify ${params.type} search:\n${rows.join("\n")}`);
			} catch (err) {
				return text(`spotify_search failed: ${(err as Error).message}`, true);
			}
		},
	});

	pi.registerTool({
		name: "spotify_like",
		label: "Spotify Like",
		description:
			"Save tracks to Liked Songs. Pass `ids` (one or more Spotify track ids) or omit to like the currently playing track.",
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Type.String(), { description: "Spotify track ids to like." })),
		}),
		async execute(_id, params, signal) {
			try {
				let ids = params.ids ?? [];
				if (ids.length === 0) {
					const state = await client.getPlayback(signal ?? undefined);
					const id = state?.item?.id;
					if (typeof id !== "string") {
						return text("No track is currently playing; pass `ids` to like specific tracks.", true);
					}
					ids = [id];
				}
				await client.saveTracks(ids, signal ?? undefined);
				return text(`Saved ${ids.length} track(s) to Liked Songs.`);
			} catch (err) {
				return text(`spotify_like failed: ${(err as Error).message}`, true);
			}
		},
	});

	pi.registerTool({
		name: "spotify_unlike",
		label: "Spotify Unlike",
		description:
			"Remove tracks from Liked Songs. Pass `ids` (one or more Spotify track ids) or omit to unlike the currently playing track.",
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Type.String(), { description: "Spotify track ids to remove from Liked Songs." })),
		}),
		async execute(_id, params, signal) {
			try {
				let ids = params.ids ?? [];
				if (ids.length === 0) {
					const state = await client.getPlayback(signal ?? undefined);
					const id = state?.item?.id;
					if (typeof id !== "string") {
						return text("No track is currently playing; pass `ids` to unlike specific tracks.", true);
					}
					ids = [id];
				}
				await client.removeTracks(ids, signal ?? undefined);
				return text(`Removed ${ids.length} track(s) from Liked Songs.`);
			} catch (err) {
				return text(`spotify_unlike failed: ${(err as Error).message}`, true);
			}
		},
	});

	pi.registerTool({
		name: "spotify_liked_random",
		label: "Spotify Liked Random",
		description:
			"Pick a random track from your Liked Songs and start playing it on the active or specified device. Requires Spotify Premium.",
		parameters: Type.Object({
			device: Type.Optional(Type.String({ description: "Device id or name. Defaults to active device." })),
		}),
		async execute(_id, params, signal) {
			try {
				const deviceId = await resolveDeviceId(client, params.device, {
					requireActive: true,
					signal: signal ?? undefined,
				});

				// Gather a sample of liked tracks (up to 50) and pick one at random.
				const liked = await client.getLiked(50, 0, signal ?? undefined);
				const items = liked.items ?? [];
				if (items.length === 0) return text("Your Liked Songs is empty.", true);

				const pick = items[Math.floor(Math.random() * items.length)];
				const track = summarizeTrack(pick.track);
				if (!track?.uri) return text("Could not read a liked track.", true);

				await client.play({ uris: [track.uri], device_id: deviceId ?? undefined }, signal ?? undefined);
				return text(`Playing a random liked track: ${fmtTrack(track)}`);
			} catch (err) {
				return text(`spotify_liked_random failed: ${(err as Error).message}`, true);
			}
		},
	});

	// Surface a helpful note at startup if the client id is not configured.
	pi.on("session_start", async (_event, ctx) => {
		if (!CLIENT_ID) {
			ctx.ui.notify(
				"spotify-pi: SPOTIFY_PI_CLIENT_ID is not set. Run /spotify-login after configuring it.",
				"info",
			);
		}
	});
}
