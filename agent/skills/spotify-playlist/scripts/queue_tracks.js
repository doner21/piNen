#!/usr/bin/env node
/**
 * Batch-queue Spotify tracks for playback.
 *
 * Reads the access token from the spotify-mcp config file and POSTs each track
 * to the Spotify /me/player/queue endpoint.
 *
 * Usage:
 *   node queue_tracks.js <trackId1> <trackId2> ...
 *
 * The track IDs can be plain Spotify IDs (e.g. 0hfdtb8oN7bWS0P5aqRbyZ) or
 * full URIs (spotify:track:0hfdtb8oN7bWS0P5aqRbyZ).
 *
 * Requires: Node.js (built-in fetch in v18+, or node-fetch).
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CONFIG_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "spotify-mcp",
  "spotify-config.json",
);

async function main() {
  const trackIds = process.argv.slice(2);
  if (trackIds.length === 0) {
    console.error("Usage: node queue_tracks.js <trackId1> <trackId2> ...");
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    console.error("Could not read Spotify config at", CONFIG_PATH);
    console.error("Run 'npm run auth' in ~/.pi/agent/spotify-mcp first.");
    process.exit(1);
  }

  if (!config.accessToken) {
    console.error("No access token in config. Run 'npm run auth' first.");
    process.exit(1);
  }

  let success = 0;
  let failed = 0;

  for (const raw of trackIds) {
    // Accept both plain IDs and spotify:track: URIs
    const id = raw.startsWith("spotify:track:") ? raw.slice(14) : raw;
    const uri = encodeURIComponent(`spotify:track:${id}`);

    try {
      const res = await fetch(
        `https://api.spotify.com/v1/me/player/queue?uri=${uri}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${config.accessToken}` },
        },
      );
      if (res.ok || res.status === 204) {
        success++;
        console.log(`OK  ${id}`);
      } else {
        failed++;
        const body = await res.text().catch(() => "(no body)");
        console.error(`FAIL ${id}  ${res.status}  ${body.slice(0, 120)}`);
      }
    } catch (err) {
      failed++;
      console.error(`ERR  ${id}  ${err.message}`);
    }
  }

  console.log(`\nDone: ${success} queued, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
