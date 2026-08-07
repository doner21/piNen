---
name: spotify-playlist
description: Comprehensive Spotify playlist creation, track loading, playback, and management workflow. This skill should be used when asked to create a Spotify playlist, find and add tracks to a playlist, play a playlist on a device, manage playback across Spotify Free and Premium accounts, or troubleshoot Spotify OAuth/playback issues.
---

# Spotify Playlist Management

Procedural knowledge for managing Spotify playlists, loading tracks, controlling playback,
and working around common OAuth scope limitations.

## Tool landscape

Two tool sets are available, and choosing the right one is critical:

| Tool set | Scope | Reliable for |
|----------|-------|-------------|
| `spotify_*` (Pi extension) | Playback, status, device control | Single-track play, pause, skip, status, device transfer |
| `spotify_*` (MCP server) | Search, playlist CRUD, queue | Search, playlist read, add/remove tracks, queue |

### Key differences

- **Pi extension** (`spotify_play`, `spotify_status`, `spotify_devices`, `spotify_transfer`, `spotify_next`, `spotify_previous`, `spotify_pause`): uses its own auth; reliably controls playback on active device for single tracks. Use for play/pause/skip/status/device switching.
- **MCP server** (`spotify_searchSpotify`, `spotify_addTracksToPlaylist`, `spotify_removeTracksFromPlaylist`, `spotify_updatePlaylist`, `spotify_getMyPlaylists`, `spotify_getPlaylistTracks`): uses a separate OAuth token stored in `~/.pi/agent/spotify-mcp/spotify-config.json`. Works for playlist read/modify and search. May fail for `spotify_createPlaylist` if token lacks write scopes.

## Finding tracks

Use the MCP tool `spotify_searchSpotify` with `type: "track"` and a `limit` (max 50):

```text
mcp({ tool: "spotify_searchSpotify", args: '{"query": "Caterina Barbieri", "type": "track", "limit": 5}' })
```

Each result includes the track `ID`, name, artist, and duration. Collect these IDs for playlist building.

## Creating a playlist (with scope workaround)

The MCP `spotify_createPlaylist` tool may fail with a 403 Forbidden error when the OAuth token
lacks `playlist-modify-private` or `playlist-modify-public` scopes. The error message includes:
"Bad OAuth request (wrong consumer key, bad nonce, expired timestamp...)"

### Workaround: recycle an existing empty playlist

1. List existing playlists to find an empty one:

```text
mcp({ tool: "spotify_getMyPlaylists", args: '{"limit": 20}' })
```

2. Rename the empty playlist and update its description:

```text
mcp({ tool: "spotify_updatePlaylist", args: '{"playlistId": "<ID>", "name": "desired name", "description": "description"}' })
```

3. Proceed to add tracks (see below).

If no empty playlists exist, OAuth re-authentication is required (see OAuth section).

## Adding tracks to a playlist

Use the MCP tool `spotify_addTracksToPlaylist`. **Critical:** the parameter is `trackIds` (an array
of plain Spotify track IDs), NOT `trackUris`. Do not prefix with `spotify:track:`.

```text
mcp({
  tool: "spotify_addTracksToPlaylist",
  args: '{"playlistId": "<PLAYLIST_ID>", "trackIds": ["id1", "id2", "id3", ...]}'
})
```

Up to 100 tracks per call. The `trackIds` parameter accepts plain IDs; the tool auto-prepends
`spotify:track:` internally.

### Verifying tracks were added

```text
mcp({ tool: "spotify_getPlaylistTracks", args: '{"playlistId": "<ID>", "limit": 50}' })
```

Note: `spotify_getPlaylist` may show a stale track count (0) due to caching.
Use `spotify_getPlaylistTracks` for the authoritative list.

## Playing a playlist

### The playlist-context problem

The MCP `spotify_playMusic` tool with a playlist URI (`spotify:playlist:ID`) may silently fail
to change the playback context -- the Spotify client stays on whatever was previously playing.
This occurs across both Pi and MCP tool sets for playlist/album context URIs.

### Queue clash with previous sessions (CRITICAL)

**The most common cause of playlist playback divergence is a stale queue from a previous session.**

Spotify's queue model:
- Manually queued items (via `addToQueue`) persist across playback sessions until consumed or skipped.
- Manually queued items **always take priority** over playlist context tracks.
- `spotify_getQueue` only shows manually queued items, NOT the playlist's upcoming context tracks.
- A playlist that appears to be playing the right first track may diverge into old queue items on track 2.

**Always run this check before playing a playlist:**

```text
mcp({ tool: "spotify_getQueue", args: '{}' })
```

If the queue contains tracks that do NOT belong to the target playlist, clear them:

1. Add all playlist tracks to the queue using `spotify_addToQueue`:

```text
mcp({ tool: "spotify_addToQueue", args: '{"uri": "spotify:track:<ID>"}' })
// Repeat for each playlist track
```

2. Skip through all stale queue items until a playlist track starts playing:

```text
mcp({ tool: "spotify_skipToNext", args: '{}' })
// Repeat until the currently playing track and queue show only playlist items
```

3. **Verify** after each batch of skips:

```text
mcp({ tool: "spotify_getNowPlaying", args: '{}' })
mcp({ tool: "spotify_getQueue", args: '{}' })
```

**Important**: Do NOT assume the queue is empty just because the first track is correct.
The old queue may be many items deep (20+), hiding behind the visible 10. If skips reveal
more stale tracks, keep skipping until only playlist tracks remain.

### Reliable workaround: queue-based playback

1. **Play the first track directly** using the Pi extension:

```text
spotify_play({ query: "Artist Name Track Name" })
```

Or by URI:

```text
spotify_play({ uri: "spotify:track:<ID>" })
```

2. **Queue all remaining tracks** using a batch script. See `scripts/queue_tracks.js` or call
the Spotify Web API directly with the access token from `~/.pi/agent/spotify-mcp/spotify-config.json`:

```javascript
// POST https://api.spotify.com/v1/me/player/queue?uri=spotify:track:ID
// Authorization: Bearer <accessToken>
```

Alternatively, queue tracks one-by-one with the MCP tool (slower but no script needed):

```text
mcp({ tool: "spotify_addToQueue", args: '{"uri": "spotify:track:<ID>"}' })
```

3. **Clear stale queue** (see "Queue clash with previous sessions" above) if the queue contains
non-playlist items.

4. **Verify playback** with:

```text
spotify_status()
```

5. **Skip through** with `spotify_next()` / `spotify_previous()`.

### Cached broken tracks

If a track was removed from a playlist but the Spotify desktop client cached its position,
playback gets stuck with a 404 error on that removed track.

**Detection:** `spotify_status` returns: `Spotify API error 404: Non existing id: 'spotify:track:XXXXX'`

**Fix:** Kill and restart the Spotify desktop app to clear the cache:

```powershell
powershell -Command "Stop-Process -Name 'Spotify' -Force -ErrorAction SilentlyContinue; Start-Sleep 2; Start-Process 'spotify:'"
```

Then confirm devices reappear with `spotify_devices()` and rebuild playback.

## Device management

```text
spotify_devices()                     # List devices
spotify_transfer({ device: "name" })  # Transfer to device (substring match)
spotify_transfer({ device: "name", play: false })  # Transfer without auto-play
```

Device IDs are stable per session. Use the human-readable name for `spotify_transfer`; it does
substring matching.

## Playback control (Pi extension)

| Tool | Action |
|------|--------|
| `spotify_play()` | Resume / play by query or URI |
| `spotify_pause()` | Pause |
| `spotify_next()` | Skip forward |
| `spotify_previous()` | Skip back |
| `spotify_status()` | Current track, progress, device |
| `spotify_volume({ volume_percent: N })` | Set volume 0-100 |

### Premium vs Free

Playback control (pause, skip, transfer, queue) requires Spotify Premium.
The error `Spotify returned 403 Forbidden. Playback control requires a Spotify Premium account`
indicates a Free account. On Free accounts, only `spotify_play` with a track URI and `spotify_status`
are reliable.

## Removing broken tracks

```text
mcp({ tool: "spotify_removeTracksFromPlaylist", args: '{"playlistId": "<ID>", "trackIds": ["<TRACK_ID>"]}' })
```

After removal, the playlist server-side is immediately updated. The desktop client may cache
the old state; restart Spotify if needed.

## OAuth and token issues

### Symptom: 403 Forbidden on write operations

The MCP token may have been obtained without playlist-modify or playback-modify scopes.
Read operations (search, get playlists) work; write operations fail.

### Re-authentication

```bash
cd ~/.pi/agent/spotify-mcp
npm run auth
```

This starts a local HTTP server on port 8888 and opens a browser for Spotify OAuth.
If the browser doesn't open automatically, the URL is printed to stdout.

**Agent workflow for auth:**

1. Run `npm run auth` in background
2. Open the printed URL in a browser (use `powershell -Command "Start-Process '<URL>'"` on Windows)
3. The user must log into Spotify in that browser
4. Spotify redirects to `http://127.0.0.1:8888/callback` which the local server catches
5. New tokens are written to `spotify-config.json`

If the agent's Playwright browser is broken, open the URL with the OS shell:

```powershell
powershell -Command "Start-Process '<AUTH_URL>'"
```

### Token validity check

```bash
python3 -c "import sys,json,time; c=json.load(open('$HOME/.pi/agent/spotify-mcp/spotify-config.json'));
print('expiresAt:', c['expiresAt'], 'now:', time.time()*1000, 'valid:', c['expiresAt'] > time.time()*1000)"
```

## Complete workflow example

For "create a playlist called X with these tracks and play it":

1. **Search** for tracks with MCP `spotify_searchSpotify`
2. **Collect** track IDs
3. **Find or create** an empty playlist:
   - `spotify_getMyPlaylists` to list
   - Use existing empty one (rename with `spotify_updatePlaylist`) or create with `spotify_createPlaylist`
4. **Add tracks** with `spotify_addTracksToPlaylist` (all in one call, max 100)
5. **Check devices** with `spotify_devices`
6. **Check queue for stale items** with `mcp({ tool: "spotify_getQueue", args: '{}' })`
7. **Play first track** with `spotify_play({ query: "..." })` or `spotify_play({ uri: "spotify:track:ID" })`
8. **Queue remaining tracks** (see `scripts/queue_tracks.js`)
9. **Clear stale queue items** by skipping through any non-playlist tracks (see "Queue clash with previous sessions")
10. **Verify** with `spotify_status`
11. If playlist context is needed for the user to browse in-app, open the URL:
   `https://open.spotify.com/playlist/<PLAYLIST_ID>`

## Common pitfalls

1. **Queue clash with previous sessions**: The #1 cause of playlist divergence. Old queue items persist
device-side and override playlist context. Always check `spotify_getQueue` before playing a playlist;
skip through stale items until only playlist tracks remain. See "Queue clash with previous sessions."
2. **Playlist context URIs don't change playback**: Use the queue-based approach.
3. **`trackUris` vs `trackIds`**: The MCP tool uses `trackIds` with plain IDs.
4. **Stale track count**: `getPlaylist` may show 0; use `getPlaylistTracks`.
5. **Cached removed tracks**: Restart Spotify desktop app.
6. **403 on createPlaylist**: Token lacks write scopes; recycle an empty playlist or re-auth.
7. **Free vs Premium**: Premium required for skip/pause/queue/transfer API control.
8. **Broken browser for OAuth**: Use OS shell to open the auth URL.
