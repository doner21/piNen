import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, writeSync } from "node:fs";
import path from "node:path";

import type { WorkspaceEffect, WorkspaceSnapshotRecord } from "./types";

// Safety defaults observe every workspace directory. Callers may opt into
// exclusions only when those paths are outside their effect/recovery contract.
const DEFAULT_IGNORED_DIRECTORIES = new Set<string>();

export class MissionWorkspaceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "MissionWorkspaceError";
    this.code = code;
  }
}

export interface CaptureWorkspaceOptions {
  maxEntries?: number;
  maxBytes?: number;
  ignoredDirectories?: Iterable<string>;
  clock?: () => Date;
}

export function captureWorkspaceSnapshot(root: string, options: CaptureWorkspaceOptions = {}): WorkspaceSnapshotRecord {
  const canonicalRoot = realpathSync(path.resolve(root));
  const maxEntries = positiveInteger(options.maxEntries ?? 50_000, "maxEntries");
  const maxBytes = positiveInteger(options.maxBytes ?? 1024 * 1024 * 1024, "maxBytes");
  const ignoredDirectories = new Set(options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES);
  const entries: Record<string, string> = {};
  let entryCount = 0;
  let bytes = 0;

  const visit = (directory: string): void => {
    for (const child of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.isDirectory() && ignoredDirectories.has(child.name)) continue;
      const absolute = path.join(directory, child.name);
      const relative = path.relative(canonicalRoot, absolute).replace(/\\/g, "/");
      entryCount += 1;
      if (entryCount > maxEntries) throw new MissionWorkspaceError("MISSION_SNAPSHOT_ENTRY_LIMIT", `${entryCount} > ${maxEntries}`);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new MissionWorkspaceError("MISSION_SNAPSHOT_SYMLINK", `${relative} -> ${readlinkSync(absolute)}`);
      }
      if (stat.isDirectory()) {
        entries[`${relative}/`] = "D";
        visit(absolute);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > maxBytes) throw new MissionWorkspaceError("MISSION_SNAPSHOT_BYTE_LIMIT", `${bytes} > ${maxBytes}`);
        const hash = createHash("sha256").update(readFileSync(absolute)).digest("hex");
        entries[relative] = `F:${stat.size}:${hash}`;
      } else {
        entries[relative] = `O:${stat.mode}:${stat.size}`;
      }
    }
  };
  visit(canonicalRoot);
  const digest = createHash("sha256").update(stableEntries(entries)).digest("hex");
  return {
    version: 1,
    root: canonicalRoot,
    digest,
    entries,
    capturedAt: (options.clock ?? (() => new Date()))().toISOString(),
  };
}

export function diffWorkspaceSnapshots(before: WorkspaceSnapshotRecord, after: WorkspaceSnapshotRecord): WorkspaceEffect[] {
  validateSnapshot(before);
  validateSnapshot(after);
  if (before.root !== after.root) throw new MissionWorkspaceError("MISSION_SNAPSHOT_ROOT_MISMATCH", `${before.root} != ${after.root}`);
  const effects: WorkspaceEffect[] = [];
  for (const item of [...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])].sort()) {
    if (!Object.hasOwn(before.entries, item)) effects.push({ path: item, kind: "created" });
    else if (!Object.hasOwn(after.entries, item)) effects.push({ path: item, kind: "deleted" });
    else if (before.entries[item] !== after.entries[item]) effects.push({ path: item, kind: "modified" });
  }
  return effects;
}

export function writeWorkspaceSnapshot(runDirectory: string, label: string, snapshot: WorkspaceSnapshotRecord): string {
  validateSnapshot(snapshot);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(label)) throw new MissionWorkspaceError("MISSION_SNAPSHOT_LABEL_INVALID", label);
  const directory = path.join(path.resolve(runDirectory), "snapshots");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${label}-${snapshot.digest}.json`);
  if (!safeExists(file)) writeJsonAtomic(file, snapshot);
  return file;
}

export function readWorkspaceSnapshot(file: string): WorkspaceSnapshotRecord {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new MissionWorkspaceError("MISSION_SNAPSHOT_MALFORMED", error instanceof Error ? error.message : String(error));
  }
  validateSnapshot(value);
  const recalculated = createHash("sha256").update(stableEntries(value.entries)).digest("hex");
  if (recalculated !== value.digest) throw new MissionWorkspaceError("MISSION_SNAPSHOT_DIGEST_MISMATCH", file);
  return value;
}

function validateSnapshot(value: unknown): asserts value is WorkspaceSnapshotRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MissionWorkspaceError("MISSION_SNAPSHOT_MALFORMED", "not object");
  const item = value as Partial<WorkspaceSnapshotRecord>;
  if (item.version !== 1 || typeof item.root !== "string" || !/^[a-f0-9]{64}$/.test(String(item.digest ?? ""))
    || !item.entries || typeof item.entries !== "object" || Array.isArray(item.entries)
    || typeof item.capturedAt !== "string" || Number.isNaN(Date.parse(item.capturedAt))) {
    throw new MissionWorkspaceError("MISSION_SNAPSHOT_MALFORMED", "invalid fields");
  }
  for (const [key, signature] of Object.entries(item.entries)) {
    if (!key || key.includes("\\") || path.posix.isAbsolute(key) || key.split("/").includes("..") || typeof signature !== "string") {
      throw new MissionWorkspaceError("MISSION_SNAPSHOT_MALFORMED", `entry ${key}`);
    }
  }
}

function stableEntries(entries: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new MissionWorkspaceError("MISSION_SNAPSHOT_LIMIT_INVALID", label);
  return value;
}

function safeExists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
}
