import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ContentSignatureSnapshot, FileSignature } from "./write-set";

type Signature = Pick<FileSignature, "size" | "sha256"> | null;
interface PublicationChain { before: Signature; after: Signature; invalid: boolean }
const observationContext = new AsyncLocalStorage<HostPublicationObservation>();
const same = (left: Signature, right: Signature): boolean => left === null || right === null
  ? left === right : left.size === right.size && left.sha256 === right.sha256;

/** Batch-local attribution, not a directory/filename exemption. Every admitted
 * byte transition must have happened inside a synchronous host writer. A
 * reviewer edit before, between, or after writes invalidates the whole chain.
 * Raw exhaustive manifests and external-evidence enforcement stay untouched. */
export class HostPublicationObservation {
  private readonly root: string;
  private readonly chains = new Map<string, PublicationChain>();
  private active = false;
  private used = false;
  private family?: Set<HostPublicationObservation>;

  constructor(root: string) { this.root = fs.realpathSync.native(path.resolve(root)); }

  /** An enclosing operation is the ownership token, not the workspace path.
   * Only active nested observations of that operation share publications. A
   * separately entered run with the same cwd gets a separate family. Joining
   * never replays history: each gate keeps its own starting byte boundary. */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.used) throw new Error("Host publication observation is single-use.");
    this.used = true;
    const parent = observationContext.getStore();
    this.family = parent?.active && parent.root === this.root ? parent.family : new Set();
    this.active = true;
    this.family!.add(this);
    try { return await observationContext.run(this, operation); }
    finally {
      this.active = false;
      this.family!.delete(this);
      this.family = undefined;
    }
  }

  private relative(file: string): string | undefined {
    const absolute = path.resolve(file), relative = path.relative(this.root, absolute);
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return undefined;
    // Reject symlinks/junctions at every existing ancestor, including the leaf.
    let current = this.root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      try { if (fs.lstatSync(current).isSymbolicLink()) return undefined; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined; }
    }
    return relative.replaceAll("\\", "/");
  }

  private signature(file: string): Signature {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Host publication is not a regular file");
      const bytes = fs.readFileSync(file);
      return { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  begin(files: string[]): () => void {
    // Stale async contexts cannot publish into an otherwise still-live parent.
    // Fan out only this actual synchronous host write, to currently overlapping
    // gates in this operation; never broadcast to ambient/global observations.
    if (!this.active || !this.family) return () => {};
    const finishes = [...this.family].map(observation => observation.beginLocal(files));
    return () => { for (const finish of finishes) finish(); };
  }

  private beginLocal(files: string[]): () => void {
    const starts = files.map(file => {
      const relative = this.relative(file);
      if (!relative) return undefined;
      try { return { file, relative, before: this.signature(file) }; } catch { return undefined; }
    });
    return () => {
      for (const start of starts) {
        if (!start) continue;
        const previous = this.chains.get(start.relative);
        try {
          const after = this.signature(start.file);
          this.chains.set(start.relative, {
            before: previous ? previous.before : start.before, after,
            invalid: previous?.invalid === true || (previous !== undefined && !same(previous.after, start.before))
              || this.relative(start.file) !== start.relative,
          });
        } catch {
          this.chains.set(start.relative, { before: previous ? previous.before : start.before, after: null, invalid: true });
        }
      }
    };
  }

  observe<T>(files: string[], operation: () => T): T {
    const finish = this.begin(files);
    try { return operation(); } finally { finish(); }
  }

  admittedPaths(before: ContentSignatureSnapshot, after: ContentSignatureSnapshot): Set<string> {
    const admitted = new Set<string>();
    if (path.resolve(before.root).toLowerCase() !== this.root.toLowerCase() || path.resolve(after.root).toLowerCase() !== this.root.toLowerCase()) return admitted;
    for (const [file, chain] of this.chains) {
      if (!chain.invalid && this.relative(path.join(this.root, file)) === file
        && same(chain.before, before.files[file] ?? null) && same(chain.after, after.files[file] ?? null)) admitted.add(file);
    }
    return admitted;
  }
}

export function withHostPublicationObservation<T>(observation: HostPublicationObservation, operation: () => Promise<T>): Promise<T> {
  return observation.run(operation);
}

/** A split synchronous boundary is needed for derived constructors: JavaScript
 * requires the super call itself to remain in the constructor body. */
export function beginHostPublication(files: Array<string | undefined>): () => void {
  const observation = observationContext.getStore();
  return observation ? observation.begin(files.filter((file): file is string => file !== undefined)) : () => {};
}

/** Call only around actual host publication, never around worker execution. */
export function observeHostPublication<T>(files: Array<string | undefined>, operation: () => T): T {
  const observation = observationContext.getStore();
  return observation ? observation.observe(files.filter((file): file is string => file !== undefined), operation) : operation();
}
