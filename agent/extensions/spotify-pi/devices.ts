/**
 * Device name/id resolution.
 *
 * Spotify playback mutation endpoints need a concrete device id (or an active
 * device when none is supplied). This module resolves a free-form `device`
 * argument (which may be an id or a human name/substring) to a device id, and
 * produces clear errors when no devices exist or no match is found.
 */

import type { SpotifyClient } from "./api.ts";
import type { SpotifyDevice } from "./types.ts";

/** Error thrown when Spotify reports no devices at all. */
export class NoDevicesError extends Error {
	constructor() {
		super(
			"No Spotify devices found. Launch the Spotify app, wait a few seconds for devices to register, then retry.",
		);
		this.name = "NoDevicesError";
	}
}

/** Error thrown when a specific device name/id does not match anything. */
export class DeviceNotFoundError extends Error {
	constructor(device: string, names: string[]) {
		super(
			`No Spotify device matched "${device}". Available devices: ${
				names.length ? names.join(", ") : "(none)"
			}`,
		);
		this.name = "DeviceNotFoundError";
	}
}

/** Error thrown when no device was specified and none is currently active. */
export class NoActiveDeviceError extends Error {
	constructor(names: string[]) {
		super(
			`No active Spotify device. Specify a device name/id, or start playback on one of: ${
				names.length ? names.join(", ") : "(no devices available)"
			}.`,
		);
		this.name = "NoActiveDeviceError";
	}
}

/** True if `device` could be a Spotify device id (22 hex/base62 chars). */
function looksLikeId(device: string): boolean {
	return /^[A-Za-z0-9]{16,}$/.test(device);
}

/**
 * Resolve a device argument to a concrete device id.
 *
 * Resolution order when `device` is provided:
 *   1. exact id match
 *   2. case-insensitive exact name match
 *   3. case-insensitive name substring match
 *
 * When `device` is omitted, the currently active device is used; if none is
 * active, NoActiveDeviceError is thrown (listing available devices).
 *
 * @param requireActive  When false and no device is given, returns null instead
 *   of throwing — useful for read-only calls that don't strictly need a device.
 */
export async function resolveDeviceId(
	client: SpotifyClient,
	device: string | undefined,
	opts: { requireActive?: boolean; signal?: AbortSignal } = {},
): Promise<string | null> {
	const devices = await client.getDevices(opts.signal);
	if (devices.length === 0) throw new NoDevicesError();

	if (device) {
		// 1. exact id
		if (looksLikeId(device)) {
			const byId = devices.find((d) => d.id === device);
			if (byId?.id) return byId.id;
		}
		const lower = device.toLowerCase();
		// 2. exact name
		const byName = devices.find((d) => d.name.toLowerCase() === lower);
		if (byName?.id) return byName.id;
		// 3. substring name
		const bySub = devices.find((d) => d.name.toLowerCase().includes(lower));
		if (bySub?.id) return bySub.id;
		throw new DeviceNotFoundError(device, devices.map((d) => d.name));
	}

	// No device specified: prefer the active device.
	const active = devices.find((d) => d.is_active);
	if (active?.id) return active.id;

	if (opts.requireActive === false) return null;
	throw new NoActiveDeviceError(devices.map((d) => d.name));
}

/** Convenience: resolve and require a non-null device id for mutations. */
export async function requireDeviceId(
	client: SpotifyClient,
	device: string | undefined,
	signal?: AbortSignal,
): Promise<string> {
	const id = await resolveDeviceId(client, device, { requireActive: true, signal });
	if (!id) throw new NoActiveDeviceError((await client.getDevices(signal)).map((d) => d.name));
	return id;
}

/** Return the active device object, if any (without throwing on no-devices). */
export async function getActiveDevice(client: SpotifyClient, signal?: AbortSignal): Promise<SpotifyDevice | null> {
	const devices = await client.getDevices(signal);
	return devices.find((d) => d.is_active) ?? null;
}
