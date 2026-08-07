# Intake: Spotify/music request context engineering

## User request

Ensure that when a user asks any Pi agent to play music, open Spotify, or handle a Spotify-related request, the agent consults and follows the `spotify-play` skill instead of stopping after the first `No Spotify devices found` failure.

## Triggering example

User asked: `Please open Spotify and play Alan Holdsworth's Low Levels High Stakes.`

The agent searched Spotify successfully and found:

- `Low Levels, High Stakes - Remastered` by Allan Holdsworth
- URI: `spotify:track:7btF9WArR3GNPXc8B0ZuuI`

Then `spotify_play` failed because no Spotify devices were available. The agent initially stopped and asked the user to open Spotify manually, instead of following the intended workflow that launches Spotify and retries device discovery.

## Problem

Opening Spotify does not immediately make a playback device available. The agent needs context that pushes it toward the `spotify-play` workflow whenever the request mentions Spotify, music playback, or opening Spotify to play something.

The desired behavior is not just "search Spotify". It is an end-to-end recovery workflow:

1. Recognize Spotify/music playback intent.
2. Consult the `spotify-play` skill.
3. Search for the requested content.
4. Check devices.
5. If no devices are available, launch Spotify.
6. Wait and retry device detection.
7. Only after retry attempts fail should the agent ask the user to open Spotify manually.
8. If a device appears, play the requested content on that device.

## Desired invariant

For any future request involving Spotify or playing music, the agent should not give up after the first `No Spotify devices found` response. It should first attempt to open Spotify and retry device discovery according to the `spotify-play` skill.

## Scope

Recommended implementation targets:

- Strengthen the `spotify-play` skill metadata and workflow wording so it is selected for broad music/Spotify requests.
- Add a concise global agent policy note, if appropriate, so all agents know that Spotify/music requests must route through `spotify-play`.
- Preserve existing Spotify tool usage and workflow details.
- Avoid exposing secrets or adding brittle assumptions about a specific device.

## Acceptance criteria

- A future request like `play X on Spotify`, `open Spotify and play X`, or `play some music` clearly triggers the `spotify-play` skill.
- The skill explicitly says to launch Spotify and retry when no devices are found.
- The global agent context, if updated, points agents toward the skill for Spotify/music playback requests.
- No workflow says to stop immediately after `No Spotify devices found`.
- The change is documented in this intake and the affected files are clear.

## Relevant files

- `~\.pi\agent\skills\spotify-play\SKILL.md`
- `~\.pi\agent\skills\spotify-play\intake.md`
- `~\.pi\agent\AGENTS.md` (optional global policy hook)

---

## Implementation record — 2026-06-23

### Files changed

1. **`agent/skills/spotify-play/SKILL.md`** — Strengthened frontmatter description with broader trigger phrases ("play music", "play some music", "play a song", "Spotify no-device recovery", etc.) and explicit instruction that this skill MUST be loaded before calling any `spotify_*` playback tools. Added a non-negotiable invariant block immediately below the title specifying the exact launch/wait/retry workflow: never stop after first no-device result; launch Spotify, wait 5s, retry; if still none, wait 5s more and retry once more; only after two retries (10s) may the agent ask the user manually.

2. **`agent/AGENTS.md`** — Added new "Spotify / Music Playback Requests" section before "Practical default". Instructs all agents to load `spotify-play` for any Spotify/music playback request, forbids asking the user to open Spotify manually after first no-device result, and reiterates the launch/wait/retry workflow.

3. **`agent/extensions/spotify-pi/devices.ts`** — Changed `NoDevicesError` message from "Open the Spotify app on a phone, desktop, or web player (and start playback once) so a device appears, then retry." to "Launch the Spotify app, wait a few seconds for devices to register, then retry." — this aligns the tool output wording with the skill workflow without changing logic.

4. **`agent/extensions/spotify-pi/index.ts`** — Changed `spotify_devices` no-device message from "No Spotify devices found. Open Spotify on a device first." to "No Spotify devices found. Launch the Spotify app so a device can register, then retry." — same alignment rationale.

5. **`agent/skills/spotify-play/intake.md`** — This implementation record appended.

### Invariant enforced

For any future request involving Spotify/music playback, the agent MUST:
1. Load and follow the `spotify-play` skill.
2. Never stop after the first "No Spotify devices found" result.
3. Launch Spotify and retry device discovery (5s wait, then retry; if still none, 5s more, retry again).
4. Only ask the user to open Spotify manually after two retries (10 seconds total) fail.

### Verification

- Confirmed `spotify_devices` no-device message now says "Launch the Spotify app" instead of "Open Spotify on a device first."
- Confirmed `NoDevicesError` message now says "Launch the Spotify app" instead of the longer manual-instruction variant.
- Confirmed SKILL.md frontmatter description triggers on "play music", "play some music", "play a song", "Spotify no-device recovery", and other broad music/playback phrases.
- Confirmed SKILL.md invariant says explicit launch/wait/retry and forbids first-failure bailout.
- Confirmed AGENTS.md has a global policy hook directing all agents to `spotify-play` for Spotify/music playback.
