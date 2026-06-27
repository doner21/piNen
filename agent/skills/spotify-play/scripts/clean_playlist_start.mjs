#!/usr/bin/env node
/**
 * Clean-start a Spotify playlist on an active device.
 *
 * Why this exists: Spotify's Web API has no "clear queue" endpoint. Manually
 * queued tracks can sit ahead of playlist continuation even after starting a
 * playlist context, so this script starts the playlist, inspects the queue, and
 * if stale queued tracks precede the expected second playlist item, it mutes,
 * skips through those stale queued tracks, restarts the playlist at offset 0,
 * then restores volume.
 */

import { SpotifyClient } from '../../../extensions/spotify-pi/api.ts';

const args = process.argv.slice(2);
const playlistArg = args.find((a) => !a.startsWith('--'));
const deviceArg = valueAfter('--device');
const maxSkip = Number(valueAfter('--max-skip') ?? '30');
const settleMs = Number(valueAfter('--settle-ms') ?? '800');

function valueAfter(flag) {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const prefix = `${flag}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function usage() {
  console.error('Usage: node clean_playlist_start.mjs <playlist-uri|playlist-url|playlist-id|playlist-name> [--device <name-or-id>] [--max-skip 30]');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function playlistIdFrom(input) {
  if (!input) return null;
  const uri = input.match(/^spotify:playlist:([A-Za-z0-9]+)$/);
  if (uri) return uri[1];
  const url = input.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]+)/);
  if (url) return url[1];
  if (/^[A-Za-z0-9]{16,32}$/.test(input)) return input;
  return null;
}

function trackSummary(t) {
  if (!t) return null;
  return {
    uri: t.uri,
    name: t.name,
    artists: (t.artists ?? []).map((a) => a.name).filter(Boolean).join(', '),
    album: t.album?.name ?? null,
  };
}

async function resolvePlaylist(client, input) {
  const id = playlistIdFrom(input);
  if (id) {
    const playlist = await client.request('GET', `/playlists/${id}`);
    return { id, uri: `spotify:playlist:${id}`, name: playlist?.name ?? id, url: playlist?.external_urls?.spotify };
  }
  const data = await client.search(input, 'playlist', 10);
  const item = data?.playlists?.items?.find(Boolean);
  if (!item?.id) throw new Error(`No Spotify playlist found for: ${input}`);
  return { id: item.id, uri: item.uri, name: item.name, url: item.external_urls?.spotify };
}

async function getPlaylistTracks(client, playlistId) {
  const tracks = [];
  let path = `/playlists/${playlistId}/items`;
  let query = { limit: 100, offset: 0 };
  while (path) {
    const data = await client.request('GET', path, { query });
    for (const row of data?.items ?? []) {
      const item = row.track ?? row.item;
      if (item?.type === 'track' && item.uri) tracks.push(item);
    }
    if (!data?.next) break;
    const next = new URL(data.next);
    path = next.pathname.replace('/v1', '');
    query = Object.fromEntries(next.searchParams.entries());
  }
  return tracks;
}

async function pickDevice(client, wanted) {
  const devices = await client.getDevices();
  if (!devices.length) throw new Error('No Spotify devices found. Launch Spotify and retry device discovery first.');
  if (wanted) {
    const w = wanted.toLowerCase();
    const hit = devices.find((d) => d.id === wanted || d.name?.toLowerCase().includes(w));
    if (!hit) throw new Error(`Requested Spotify device not found: ${wanted}`);
    return hit;
  }
  return devices.find((d) => d.is_active) || devices.find((d) => d.type === 'Computer') || devices[0];
}

function queueUris(queueData) {
  return (queueData?.queue ?? queueData?.Queue ?? [])
    .map((item) => item?.uri)
    .filter(Boolean);
}

async function main() {
  if (!playlistArg) {
    usage();
    process.exit(2);
  }

  const client = new SpotifyClient();
  const playlist = await resolvePlaylist(client, playlistArg);
  const tracks = await getPlaylistTracks(client, playlist.id);
  if (!tracks.length) throw new Error(`Playlist has no playable tracks: ${playlist.name}`);

  const device = await pickDevice(client, deviceArg);
  const originalVolume = typeof device.volume_percent === 'number' ? device.volume_percent : 50;

  await client.setShuffle(false, device.id).catch(() => {});
  await client.setRepeat('off', device.id).catch(() => {});
  await client.play({ context_uri: playlist.uri, offset: { position: 0 }, position_ms: 0, device_id: device.id });
  await sleep(settleMs);

  const expectedNext = tracks[1]?.uri ?? null;
  let q = await client.getQueue();
  let uris = queueUris(q);
  let staleCount = 0;
  let queueWasPolluted = false;

  if (expectedNext && uris[0] && uris[0] !== expectedNext) {
    queueWasPolluted = true;
    const expectedIndex = uris.indexOf(expectedNext);
    staleCount = expectedIndex >= 0 ? expectedIndex : Math.min(uris.length, maxSkip);
    staleCount = Math.max(0, Math.min(staleCount, maxSkip));
  }

  if (staleCount > 0) {
    await client.setVolume(0, device.id).catch(() => {});
    for (let i = 0; i < staleCount; i++) {
      await client.next(device.id);
      await sleep(350);
    }
    await sleep(settleMs);
    await client.play({ context_uri: playlist.uri, offset: { position: 0 }, position_ms: 0, device_id: device.id });
    await sleep(settleMs);
    await client.setVolume(originalVolume, device.id).catch(() => {});
  }

  const playback = await client.getPlayback();
  q = await client.getQueue();
  uris = queueUris(q);

  const result = {
    playlist,
    device: { id: device.id, name: device.name, type: device.type },
    startedAt: trackSummary(tracks[0]),
    expectedNext: trackSummary(tracks[1]),
    nowPlaying: trackSummary(playback?.item),
    queueFirstUri: uris[0] ?? null,
    queueFirstMatchesExpectedNext: expectedNext ? uris[0] === expectedNext : null,
    queueWasPolluted,
    staleQueuedTracksConsumed: staleCount,
    shuffle: playback?.shuffle_state,
    repeat: playback?.repeat_state,
    isPlaying: playback?.is_playing,
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
