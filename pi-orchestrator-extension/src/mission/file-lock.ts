import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import type { ProcessInspector, ProcessObservation } from "./types";

export interface ProcessClaimLock {
  file: string;
  releaseFile: string;
  fd: number;
  token: string;
  generation: number;
}

interface ProcessClaimRecord {
  version: 2;
  generation: number;
  pid: number;
  processStartedAt: string;
  token: string;
  acquiredAt: string;
}

interface ProcessReleaseRecord {
  version: 1;
  generation: number;
  token: string;
  releasedAt: string;
}

export interface AcquireProcessClaimLockOptions {
  directory: string;
  processInspector: ProcessInspector;
  processStartedAt: string;
  prefix: string;
  busy: () => Error;
}

export interface ProcessClaimInspection {
  state: "absent" | "active" | "released";
  generation?: number;
  pid?: number;
  processStartedAt?: string;
  acquiredAt?: string;
}

/** Read the latest immutable claim without creating, cleaning, or releasing anything. */
export function inspectProcessClaimLock(directoryInput: string, prefix: string): ProcessClaimInspection {
  const directory = path.resolve(directoryInput);
  if (!existsSync(directory)) return { state: "absent" };
  if (lstatSync(directory).isSymbolicLink() || !statSync(directory).isDirectory()) {
    throw new Error(`claim lock directory is invalid: ${directory}`);
  }
  const generation = latestWinnerGeneration(directory, prefix);
  if (!generation) return { state: "absent" };
  const winner = readWinner(winnerFile(directory, prefix, generation), generation);
  return {
    state: isReleased(directory, prefix, winner) ? "released" : "active",
    generation,
    pid: winner.pid,
    processStartedAt: winner.processStartedAt,
    acquiredAt: winner.acquiredAt,
  };
}

/**
 * Race-safe process claim lock built from immutable generations.
 *
 * A stale winner pathname is never deleted and reused. Contenders derive the
 * next generation and race on one O_EXCL pathname, so exactly one can win.
 * Release is a separate immutable marker bound to the winner's random token.
 */
export function acquireProcessClaimLock(options: AcquireProcessClaimLockOptions): ProcessClaimLock {
  const directory = ensureClaimDirectory(options.directory);
  for (let attempt = 0; attempt < 4; attempt++) {
    const latestGeneration = latestWinnerGeneration(directory, options.prefix);
    if (latestGeneration > 0) {
      const latestFile = winnerFile(directory, options.prefix, latestGeneration);
      const latest = readWinner(latestFile, latestGeneration);
      if (!isReleased(directory, options.prefix, latest)) {
        const observation = options.processInspector.inspect(latest.pid);
        if (sameProcessStillAlive(observation, latest.processStartedAt)) throw options.busy();
      }
    }

    const generation = latestGeneration + 1;
    if (!Number.isSafeInteger(generation)) throw options.busy();
    const token = randomBytes(24).toString("hex");
    const file = winnerFile(directory, options.prefix, generation);
    const temporary = path.join(directory, `.claim-${options.prefix}-${generation}-${process.pid}-${token}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      const record: ProcessClaimRecord = {
        version: 2,
        generation,
        pid: process.pid,
        processStartedAt: normalizeTimestamp(options.processStartedAt),
        token,
        acquiredAt: new Date().toISOString(),
      };
      writeSync(fd, `${JSON.stringify(record)}\n`, undefined, "utf8");
      fsyncSync(fd);
      linkSync(temporary, file);
      try { fsyncDirectoryBestEffort(directory); } catch {}
      try { unlinkSync(temporary); } catch {}
      const releaseFile = releaseMarkerFile(directory, options.prefix, generation, token);
      cleanupOlderGenerations(directory, options.prefix, generation);
      return { file, releaseFile, fd, token, generation };
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
      }
      try { unlinkSync(temporary); } catch {}
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw options.busy();
}

export function releaseProcessClaimLock(lock: ProcessClaimLock): void {
  const record: ProcessReleaseRecord = {
    version: 1,
    generation: lock.generation,
    token: lock.token,
    releasedAt: new Date().toISOString(),
  };
  publishReleaseMarker(lock.releaseFile, record);
  try { closeSync(lock.fd); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
  }
}

function publishReleaseMarker(file: string, record: ProcessReleaseRecord): void {
  if (existsSync(file)) {
    if (releaseMarkerMatches(file, record)) return;
    throw new Error(`process release marker conflicts at ${file}`);
  }
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.release-${record.generation}-${process.pid}-${randomBytes(12).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeSync(fd, `${JSON.stringify(record)}\n`, undefined, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try { linkSync(temporary, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !releaseMarkerMatches(file, record)) throw error;
    }
    fsyncDirectoryBestEffort(directory);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(temporary); } catch {}
  }
}

function latestWinnerGeneration(directory: string, prefix: string): number {
  const expression = new RegExp(`^${escapeRegExp(prefix)}-(\\d{16})\\.json$`);
  let latest = 0;
  for (const name of readdirSync(directory)) {
    const match = expression.exec(name);
    if (!match) continue;
    const generation = Number(match[1]);
    if (Number.isSafeInteger(generation)) latest = Math.max(latest, generation);
  }
  return latest;
}

function readWinner(file: string, expectedGeneration: number): ProcessClaimRecord {
  try {
    if (lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) throw new Error("not a regular file");
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<ProcessClaimRecord>;
    if (value.version !== 2 || value.generation !== expectedGeneration
      || !Number.isInteger(value.pid) || (value.pid as number) < 1
      || typeof value.processStartedAt !== "string" || Number.isNaN(Date.parse(value.processStartedAt))
      || typeof value.token !== "string" || !/^[a-f0-9]{48}$/.test(value.token)
      || typeof value.acquiredAt !== "string" || Number.isNaN(Date.parse(value.acquiredAt))) {
      throw new Error("invalid winner fields");
    }
    return value as ProcessClaimRecord;
  } catch (error) {
    throw new Error(`process claim is malformed at ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isReleased(directory: string, prefix: string, winner: ProcessClaimRecord): boolean {
  const file = releaseMarkerFile(directory, prefix, winner.generation, winner.token);
  if (!existsSync(file)) return false;
  return releaseMarkerMatches(file, {
    version: 1,
    generation: winner.generation,
    token: winner.token,
    releasedAt: "1970-01-01T00:00:00.000Z",
  });
}

function releaseMarkerMatches(file: string, expected: ProcessReleaseRecord): boolean {
  try {
    if (lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) return false;
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<ProcessReleaseRecord>;
    return value.version === 1 && value.generation === expected.generation && value.token === expected.token
      && typeof value.releasedAt === "string" && !Number.isNaN(Date.parse(value.releasedAt));
  } catch {
    return false;
  }
}

function cleanupOlderGenerations(directory: string, prefix: string, keepGeneration: number): void {
  const expression = new RegExp(`^(?:${escapeRegExp(prefix)}|release-${escapeRegExp(prefix)})-(\\d{16})(?:-[a-f0-9]{48})?\\.json$`);
  for (const name of readdirSync(directory)) {
    const match = expression.exec(name);
    if (!match || Number(match[1]) >= keepGeneration) continue;
    try { unlinkSync(path.join(directory, name)); } catch {}
  }
}

function winnerFile(directory: string, prefix: string, generation: number): string {
  return path.join(directory, `${prefix}-${String(generation).padStart(16, "0")}.json`);
}

function releaseMarkerFile(directory: string, prefix: string, generation: number, token: string): string {
  return path.join(directory, `release-${prefix}-${String(generation).padStart(16, "0")}-${token}.json`);
}

function sameProcessStillAlive(observation: ProcessObservation, expectedStartedAt: string): boolean {
  if (!observation.alive) return false;
  if (!observation.startedAt) return true;
  try { return normalizeTimestamp(observation.startedAt) === normalizeTimestamp(expectedStartedAt); }
  catch { return true; }
}

function ensureClaimDirectory(directory: string): string {
  const absolute = path.resolve(directory);
  mkdirSync(absolute, { recursive: true });
  if (lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isDirectory()) throw new Error(`claim lock directory is invalid: ${absolute}`);
  return absolute;
}

function fsyncDirectoryBestEffort(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!(code === "EACCES" || code === "EPERM" || code === "EINVAL" || code === "EISDIR")) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function normalizeTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error("invalid process start timestamp");
  return new Date(parsed).toISOString();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
