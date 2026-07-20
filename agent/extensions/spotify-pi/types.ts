/**
 * Shared types for the spotify-pi extension.
 *
 * IMPORTANT: TokenSet fields are secrets. Never log them or include them in
 * tool results / command output. Only opaque summaries (expiry, scope) may be
 * surfaced to the LLM or user.
 */

/** Persisted Spotify OAuth token set. */
export interface TokenSet {
	access_token: string;
	refresh_token: string;
	/** Epoch milliseconds when access_token expires. */
	expires_at: number;
	scope?: string;
	token_type?: string;
}

/** A Spotify player device. */
export interface SpotifyDevice {
	id: string | null;
	is_active: boolean;
	is_private_session: boolean;
	is_restricted: boolean;
	name: string;
	type: string;
	volume_percent: number | null;
	supports_volume: boolean;
}

/** Compact, non-secret device description for tool output. */
export interface DeviceSummary {
	id: string | null;
	name: string;
	type: string;
	is_active: boolean;
	volume_percent: number | null;
}

/** A minimal track representation used across tools. */
export interface TrackSummary {
	uri: string;
	id: string | null;
	name: string;
	artists: string[];
	album: string | null;
	duration_ms: number | null;
}

/** Result of the /me/player endpoint (subset). */
export interface PlaybackState {
	device?: SpotifyDevice;
	is_playing?: boolean;
	progress_ms?: number | null;
	shuffle_state?: boolean;
	repeat_state?: string;
	item?: {
		uri: string;
		id: string | null;
		name: string;
		duration_ms: number;
		artists?: Array<{ name: string }>;
		album?: { name: string };
	};
}
