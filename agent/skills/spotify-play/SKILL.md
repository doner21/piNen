---
name: spotify-play
description: 'Complete Spotify "open and play" workflow — search, device recovery, play. Triggers on: play music, play X on Spotify, play a song, play some music, open Spotify and play X, Spotify no-device recovery, resume Spotify, /spotify_play, or any request to play music or control Spotify playback. This skill MUST be loaded and consulted before calling any Spotify MCP playback tools (spotify_playMusic, spotify_getAvailableDevices, spotify_searchSpotify, etc.).'
---

# Spotify Play — Agent Skill

> ⚠️ **NON-NEGOTIABLE INVARIANT**: If `spotify_getAvailableDevices` returns "No available devices found" or `spotify_playMusic` fails with a no-device error, you MUST launch Spotify (`powershell -Command "Start-Process 'spotify:'"` on Windows, equivalent on other platforms), wait 5 seconds, and retry `spotify_getAvailableDevices`. If still none, wait 5 more seconds and retry once more. ONLY after two retries (10s total) may you ask the user to open Spotify manually. Never stop after the first no-device result.

> **All Spotify tools come from the MCP server.** Connect first with `mcp({ connect: "spotify" })`. Do not use built-in `spotify_*` Pi tools.

## Purpose

This skill provides a reliable end-to-end workflow for searching and playing music on Spotify, including the common failure case where Spotify is not running and no playback devices are available. Instead of failing with "no devices found," it launches Spotify and retries.

## When to Use

Trigger this skill when the user:
- Asks to play a track, album, artist, or playlist on Spotify
- Asks to "play music" or "play some music" or "play a song"
- Uses the `/spotify_play` command
- Says "open Spotify and play ..."
- Asks to resume or start Spotify playback and devices might not be active
- Makes any request that involves Spotify playback (play, resume, skip, queue, etc.)

## Workflow

### Step 1: Parse the Request

Identify what the user wants to play:
- **Track**: Search with `spotify_searchSpotify` (type: `track`)
- **Artist**: Search with `spotify_searchSpotify` (type: `artist`), then present top tracks or albums
- **Album**: Search with `spotify_searchSpotify` (type: `album`)
- **Playlist**: Search with `spotify_searchSpotify` (type: `playlist`)
- **Resume only**: Skip search, go directly to device check and `spotify_playMusic` with no URI

If the query yields no direct match, try alternative spellings, partial matches, or separate artist/track searches.

### Step 2: Check for Devices

Call `spotify_getAvailableDevices` to enumerate available playback devices.

If devices are found, skip to Step 4.

### Step 3: Launch Spotify (if no devices)

When `spotify_getAvailableDevices` returns no devices, launch the Spotify application:

**Windows** (primary):
```bash
powershell -Command "Start-Process 'spotify:'"
```

**Linux**:
```bash
spotify &
```
or, as fallback:
```bash
xdg-open spotify:
```

**macOS**:
```bash
open -a Spotify
```

After launching, wait 5 seconds to allow Spotify to initialize:
```bash
sleep 5
```

Then retry `spotify_getAvailableDevices`. If still no devices, wait an additional 5 seconds and retry once more. If after two retries (10 seconds total) no devices appear, inform the user that Spotify could not be detected and suggest they open it manually.

### Step 4: Select a Device

When multiple devices are available, prefer the active device (shown in `spotify_getAvailableDevices` output). If none is active, prefer a `Computer` type device. If the user specifies a device name, match it by substring against the device list. The MCP `spotify_playMusic` tool will auto-select an active device if none is specified, but passing an explicit `deviceId` or `device_id` is recommended for reliability.

### Step 5: Play

Call `spotify_playMusic` with:
- `uri`: The Spotify URI from search results (e.g., `spotify:track:...`)
- `deviceId` or `device_id`: The selected device ID (optional; auto-selected if omitted)

If `spotify_playMusic` succeeds, confirm to the user what is now playing by calling `spotify_getNowPlaying`.

### Step 5A: Clean-start playlists when order matters

Use the clean-start workflow whenever the user asks to play a playlist **from the beginning**, complains that a playlist is not advancing in order, or says it is playing the first song but then not the next playlist song.

Spotify has no Web API endpoint to clear the user queue. Manually queued tracks can remain ahead of playlist continuation even after starting a playlist context. Therefore, do not assume `spotify_playMusic({ uri: playlistUri })` cleared the queue.

Procedure:
1. Start with normal device recovery from Steps 2–4.
2. Turn shuffle off and repeat off.
3. Run the bundled clean-start script with the playlist URI, URL, ID, or name and the selected device:

```bash
node ~/.pi/agent/skills/spotify-play/scripts/clean_playlist_start.mjs "<playlist>" --device "<device-name-or-id>"
```

4. Inspect the script JSON result:
   - `queueFirstMatchesExpectedNext: true` means the next queued item matches the playlist's second track.
   - `staleQueuedTracksConsumed > 0` means stale manually queued tracks were found and consumed while muted before restarting the playlist.
5. Confirm the active track and the next track with `spotify_getNowPlaying` and `spotify_getQueue` when the user reported ordering problems.

Important notes:
- The script temporarily mutes the selected Spotify device only while consuming stale queued tracks, then restores the prior volume.
- If the script reports no devices, follow Step 3's launch/wait/retry workflow, then run the script again.
- For arbitrary playlists, prefer the script over raw `spotify_play` when the requested behavior is “play this playlist in order from the beginning.”

### Step 6: Handle Failures Gracefully

- If the search returns wrong results, try more specific queries or separate artist/track searches
- If playback fails with a device error, retry device detection and selection
- If a playlist starts correctly but advances to the wrong next track, run Step 5A; stale user queue entries likely override the playlist continuation
- Never give up after the first "no devices" response — always attempt the launch sequence first

## Tools Used

| Tool | Purpose |
|------|---------|
| `spotify_searchSpotify` | Find tracks, artists, albums, playlists, episodes, shows by query |
| `spotify_getAvailableDevices` | List available playback devices with status and volume |
| `spotify_playMusic` | Start/resume playback with URI and optional device (auto-selects device) |
| `spotify_getNowPlaying` | Get current track, device, volume, shuffle, and repeat state |
| `spotify_getQueue` | View upcoming queue items |
| `spotify_pausePlayback` | Pause playback |
| `spotify_resumePlayback` | Resume playback |
| `spotify_skipToNext` / `spotify_skipToPrevious` | Skip tracks |
| `spotify_setVolume` / `spotify_adjustVolume` | Volume control |
| `spotify_addToQueue` | Add items to playback queue |
| `bash` | Launch Spotify process and sleep/wait |

## Example Interaction

User: "Play low-level high stakes by Alan Holzworth"

Agent follows this skill and:
1. Connects MCP: `mcp({ connect: "spotify" })`
2. Searches `Alan Holzworth low-level high stakes` via `spotify_searchSpotify` (type: track) → no direct match
3. Searches `Alan Holzworth` (artist) via `spotify_searchSpotify` → finds **Allan Holdsworth**
4. Searches `low-level high stakes` (track) via `spotify_searchSpotify` → finds **Low Levels, High Stakes - Remastered**
5. Calls `spotify_getAvailableDevices` → no devices
6. Launches Spotify via `powershell -Command "Start-Process 'spotify:'"`
7. Waits 5 seconds, rechecks devices via `spotify_getAvailableDevices` → **CORSAIRAI** appears
8. Plays via `spotify_playMusic({ uri: "spotify:track:7btF9WArR3GNPXc8B0ZuuI", deviceId: "6c742aa6..." })`
