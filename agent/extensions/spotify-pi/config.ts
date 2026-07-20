/**
 * Static configuration for the spotify-pi extension.
 *
 * The Spotify Client ID is read from the SPOTIFY_PI_CLIENT_ID environment
 * variable. Register an app at https://developer.spotify.com/dashboard and add
 * the exact redirect URI below to its allowed redirect URIs.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Spotify OAuth client id (from env). Empty string when not configured. */
export const CLIENT_ID: string = process.env.SPOTIFY_PI_CLIENT_ID?.trim() ?? "";

/** Loopback redirect URI. Must match the URI registered in the Spotify dashboard. */
export const REDIRECT_URI = "http://127.0.0.1:8888/callback";

/** TCP port the login callback server binds on 127.0.0.1. */
export const REDIRECT_PORT = 8888;

/** OAuth scopes requested at login. Playback mutation requires Premium. */
export const SCOPES = [
	"user-read-playback-state",
	"user-read-currently-playing",
	"user-modify-playback-state",
	"app-remote-control",
	"streaming",
	"user-library-read",
	"user-library-modify",
	"user-top-read",
	"playlist-modify-public",
	"playlist-modify-private",
	"playlist-read-private",
	"playlist-read-collaborative",
];

/** Directory holding the encrypted token file. */
export const STORAGE_DIR = join(homedir(), ".pi", "spotify-pi");

/** Path to the DPAPI-encrypted token blob (base64 of ProtectedData output). */
export const TOKEN_PATH = join(STORAGE_DIR, "token.bin");

/** Spotify account + API base URLs. */
export const ACCOUNTS_URL = "https://accounts.spotify.com";
export const API_BASE = "https://api.spotify.com/v1";

/** How long before token expiry we proactively refresh (ms). */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Login callback server timeout (ms). */
export const LOGIN_TIMEOUT_MS = 120_000;

/** Human-readable error raised when CLIENT_ID is missing. */
export const MISSING_CLIENT_ID_MSG =
	"SPOTIFY_PI_CLIENT_ID is not set. Create an app at https://developer.spotify.com/dashboard, " +
	"register the redirect URI http://127.0.0.1:8888/callback, and set the SPOTIFY_PI_CLIENT_ID " +
	"environment variable to your Spotify Client ID.";
