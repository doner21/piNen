import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

import type { EffectRecord } from "./types";

export type WorkspaceSnapshot =
  | { ok: true; root: string; entries: Map<string, string> }
  | { ok: false; root: string; error: string };

export interface WorkspaceObserver {
  capture(root: string): WorkspaceSnapshot;
  diff(before: WorkspaceSnapshot, after: WorkspaceSnapshot): EffectRecord[];
}

export interface HashWorkspaceObserverOptions {
  maxEntries?: number;
  maxBytes?: number;
  /** Symlinks are fail-closed by default because external target effects cannot be observed. */
  rejectSymlinks?: boolean;
}

/**
 * Direct SHA-256 workspace observer used by both command and Pi adapters.
 * It is deliberately conservative: bounded scans and symlinks fail closed.
 */
export class HashWorkspaceObserver implements WorkspaceObserver {
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #rejectSymlinks: boolean;

  constructor(options: HashWorkspaceObserverOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 20_000;
    this.#maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
    this.#rejectSymlinks = options.rejectSymlinks ?? true;
    if (!Number.isInteger(this.#maxEntries) || this.#maxEntries < 1) throw new Error("maxEntries must be a positive integer");
    if (!Number.isInteger(this.#maxBytes) || this.#maxBytes < 1) throw new Error("maxBytes must be a positive integer");
  }

  capture(root: string): WorkspaceSnapshot {
    const canonicalRoot = path.resolve(root);
    const entries = new Map<string, string>();
    let bytes = 0;
    try {
      const realRoot = realpathSync(canonicalRoot);
      const visit = (directory: string): void => {
        const children = readdirSync(directory, { withFileTypes: true })
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const child of children) {
          const absolute = path.join(directory, child.name);
          const relative = path.relative(realRoot, absolute).replace(/\\/g, "/");
          if (entries.size >= this.#maxEntries) throw new Error(`workspace snapshot exceeded ${this.#maxEntries} entries`);
          const stat = lstatSync(absolute);
          if (stat.isSymbolicLink()) {
            const target = readlinkSync(absolute);
            if (this.#rejectSymlinks) throw new Error(`workspace contains symlink ${relative} -> ${target}; external effects are unobservable`);
            entries.set(relative, `L:${target}`);
          } else if (stat.isDirectory()) {
            entries.set(`${relative}/`, "D");
            visit(absolute);
          } else if (stat.isFile()) {
            bytes += stat.size;
            if (bytes > this.#maxBytes) throw new Error(`workspace snapshot exceeded ${this.#maxBytes} bytes`);
            const hash = createHash("sha256").update(readFileSync(absolute)).digest("hex");
            entries.set(relative, `F:${stat.size}:${hash}`);
          } else {
            entries.set(relative, `O:${stat.mode}:${stat.size}`);
          }
        }
      };
      visit(realRoot);
      return { ok: true, root: realRoot, entries };
    } catch (error) {
      return { ok: false, root: canonicalRoot, error: error instanceof Error ? error.message : String(error) };
    }
  }

  diff(before: WorkspaceSnapshot, after: WorkspaceSnapshot): EffectRecord[] {
    if (!before.ok || !after.ok) return [];
    if (before.root !== after.root) throw new Error(`workspace snapshot root mismatch: ${before.root} vs ${after.root}`);
    const effects: EffectRecord[] = [];
    const paths = [...new Set([...before.entries.keys(), ...after.entries.keys()])].sort();
    for (const item of paths) {
      if (!before.entries.has(item)) effects.push({ path: item, kind: "created" });
      else if (!after.entries.has(item)) effects.push({ path: item, kind: "deleted" });
      else if (before.entries.get(item) !== after.entries.get(item)) effects.push({ path: item, kind: "modified" });
    }
    return effects;
  }
}
