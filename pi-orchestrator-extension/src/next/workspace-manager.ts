import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type {
  EffectRecord,
  EffectStatus,
  JsonValue,
  WorkspaceBinding,
  WorkspaceIntegrationRequest,
  WorkspaceIntegrationResult,
  WorkspaceManager,
  WorkspacePrepareRequest,
} from "./types";

const SAFE_COMPONENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const METADATA_VERSION = 1;

type EntryKind = "file" | "directory";

interface ManifestEntry {
  kind: EntryKind;
  hash?: string;
  size?: number;
  mode: number;
}

interface CandidateMetadata {
  version: typeof METADATA_VERSION;
  runId: string;
  phaseId: string;
  attempt: number;
  productRoot: string;
  workspaceRoot: string;
  baseFingerprint: string;
  baseEntries: Record<string, ManifestEntry>;
  createdAt: string;
  preserved?: { at: string; reason: string };
}

export interface SnapshotWorkspaceManagerOptions {
  /** Durable run directory, always outside the product workspace. */
  runDirectory: string;
  maxEntries?: number;
  maxBytes?: number;
  /** Deterministic test-only fault injection after N applied effects. */
  faultAfterAppliedEffects?: number;
}

/**
 * Disposable-copy workspace manager.
 *
 * A copy (rather than a Git worktree) intentionally includes dirty tracked,
 * untracked, and ignored prerequisites. Git administration is excluded so an
 * isolated worker cannot mutate the product repository's shared .git state.
 * Symlinks and special files fail closed because their external effects cannot
 * be contained or integrated safely.
 */
export class SnapshotWorkspaceManager implements WorkspaceManager {
  readonly #runDirectory: string;
  readonly #workspaceRoot: string;
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #faultAfterAppliedEffects?: number;

  constructor(options: SnapshotWorkspaceManagerOptions) {
    const runDirectory = path.resolve(options.runDirectory);
    mkdirSync(runDirectory, { recursive: true });
    this.#runDirectory = realpathSync(runDirectory);
    this.#workspaceRoot = path.join(this.#runDirectory, "workspaces");
    mkdirSync(this.#workspaceRoot, { recursive: true });
    this.#maxEntries = options.maxEntries ?? 50_000;
    this.#maxBytes = options.maxBytes ?? 1024 * 1024 * 1024;
    this.#faultAfterAppliedEffects = options.faultAfterAppliedEffects;
    if (!Number.isInteger(this.#maxEntries) || this.#maxEntries < 1) throw new Error("workspace maxEntries must be a positive integer");
    if (!Number.isInteger(this.#maxBytes) || this.#maxBytes < 1) throw new Error("workspace maxBytes must be a positive integer");
    if (this.#faultAfterAppliedEffects !== undefined && (!Number.isInteger(this.#faultAfterAppliedEffects) || this.#faultAfterAppliedEffects < 1)) {
      throw new Error("faultAfterAppliedEffects must be a positive integer");
    }
  }

  async prepare(request: WorkspacePrepareRequest): Promise<WorkspaceBinding> {
    const productRoot = canonicalDirectory(request.productRoot);
    assertOutside(productRoot, this.#runDirectory, "workspace runtime directory");
    if (request.phase.workspace.mode === "shared") {
      return {
        mode: "shared",
        root: productRoot,
        productRoot,
        phaseId: request.phase.id,
        attempt: request.attempt,
      };
    }
    assertSafeComponent(request.runId, "runId");
    assertSafeComponent(request.phase.id, "phase id");
    const attemptRoot = path.join(this.#workspaceRoot, request.phase.id, `attempt-${request.attempt}`);
    const metadataFile = path.join(attemptRoot, "candidate.metadata.json");
    const candidateRoot = path.join(attemptRoot, "product");
    if (existsSync(metadataFile)) {
      const metadata = readMetadata(metadataFile);
      assertMetadataMatches(metadata, request, productRoot, candidateRoot);
      return bindingFromMetadata(metadata, metadataFile);
    }
    if (existsSync(attemptRoot)) {
      throw new Error(`ISOLATED_WORKSPACE_INCOMPLETE: ${attemptRoot} exists without durable metadata`);
    }

    const staging = `${attemptRoot}.staging-${process.pid}-${randomBytes(4).toString("hex")}`;
    mkdirSync(path.join(staging, "product"), { recursive: true });
    try {
      const baseEntries = copyAndManifest(productRoot, path.join(staging, "product"), this.#maxEntries, this.#maxBytes);
      const metadata: CandidateMetadata = {
        version: METADATA_VERSION,
        runId: request.runId,
        phaseId: request.phase.id,
        attempt: request.attempt,
        productRoot,
        workspaceRoot: path.join(attemptRoot, "product"),
        baseFingerprint: manifestFingerprint(baseEntries),
        baseEntries,
        createdAt: new Date().toISOString(),
      };
      writeJsonAtomic(path.join(staging, "candidate.metadata.json"), metadata);
      mkdirSync(path.dirname(attemptRoot), { recursive: true });
      renameSync(staging, attemptRoot);
      const persisted = readMetadata(metadataFile);
      return bindingFromMetadata(persisted, metadataFile);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async preserve(binding: WorkspaceBinding, reason: string): Promise<void> {
    if (binding.mode !== "isolated" || !binding.metadataFile) return;
    const metadata = readMetadata(binding.metadataFile);
    metadata.preserved = { at: new Date().toISOString(), reason: boundedReason(reason) };
    writeJsonAtomic(binding.metadataFile, metadata);
  }

  async integrate(request: WorkspaceIntegrationRequest): Promise<WorkspaceIntegrationResult> {
    if (request.phase.kind !== "integrate" || !request.phase.integrate) {
      throw new Error(`INTEGRATION_CONTRACT_MISSING: phase ${request.phase.id}`);
    }
    const productRoot = canonicalDirectory(request.productRoot);
    if (!request.sources.length) throw new Error("INTEGRATION_SOURCE_MISSING: no isolated candidate was supplied");
    const expectedSources = [...request.phase.integrate.sources].sort();
    const actualSources = request.sources.map((source) => source.phaseId).sort();
    if (JSON.stringify(expectedSources) !== JSON.stringify(actualSources)) {
      throw new Error(`INTEGRATION_SOURCE_MISMATCH: expected ${expectedSources.join(",")}, got ${actualSources.join(",")}`);
    }

    const merged = new Map<string, { effect: EffectRecord; entry?: ManifestEntry; sourceRoot: string }>();
    for (const binding of request.sources) {
      if (binding.mode !== "isolated" || !binding.metadataFile) throw new Error(`INTEGRATION_SOURCE_NOT_ISOLATED: ${binding.phaseId}`);
      const metadata = readMetadata(binding.metadataFile);
      if (metadata.productRoot !== productRoot || metadata.phaseId !== binding.phaseId || metadata.attempt !== binding.attempt) {
        throw new Error(`INTEGRATION_SOURCE_IDENTITY_MISMATCH: ${binding.phaseId}`);
      }
      const current = scanManifest(metadata.workspaceRoot, this.#maxEntries, this.#maxBytes);
      const changes = diffManifests(metadata.baseEntries, current);
      for (const effect of changes) {
        const candidate = { effect, entry: current[effect.path], sourceRoot: metadata.workspaceRoot };
        const previous = merged.get(effect.path);
        if (previous && !sameCandidate(previous, candidate)) {
          throw new Error(`INTEGRATION_CANDIDATE_CONFLICT: sources disagree at ${effect.path}`);
        }
        merged.set(effect.path, candidate);
      }
    }

    const changes = [...merged.values()].sort((a, b) => a.effect.path.localeCompare(b.effect.path));
    const sourceMetadata = request.sources.map((binding) => readMetadata(binding.metadataFile!));
    // All candidates must share the same base for every changed path. A source
    // prepared after product bytes changed cannot silently make an older
    // candidate appear clean.
    for (const candidate of changes) {
      const baseline = sourceMetadata[0].baseEntries[candidate.effect.path];
      if (sourceMetadata.some((metadata) => !sameEntry(metadata.baseEntries[candidate.effect.path], baseline))) {
        throw new Error(`INTEGRATION_BASE_DIVERGENCE: candidate bases disagree at ${candidate.effect.path}`);
      }
      // Verify the product still matches that exact base before applying
      // anything. An absent base therefore requires the target to remain
      // absent; user-created files are conflicts, never overwritten.
      const actual = entryAt(productRoot, candidate.effect.path);
      if (!sameEntry(actual, baseline)) {
        throw new Error(`INTEGRATION_PRODUCT_CONFLICT: product path changed since isolation: ${candidate.effect.path}`);
      }
    }

    const rollbackRoot = path.join(this.#runDirectory, "integration-rollbacks", `${request.phase.id}-attempt-${request.attempt}`);
    if (existsSync(rollbackRoot)) throw new Error(`INTEGRATION_ROLLBACK_EXISTS: ${rollbackRoot}`);
    mkdirSync(rollbackRoot, { recursive: true });
    const rollback: Array<{ path: string; existed: boolean; entry?: ManifestEntry }> = [];
    try {
      for (const change of changes) {
        const relative = normalizeRelative(change.effect.path);
        assertSafeProductAncestors(productRoot, relative);
        const target = containedLexical(productRoot, relative);
        const prior = entryAt(productRoot, relative);
        rollback.push({ path: relative, existed: Boolean(prior), ...(prior ? { entry: prior } : {}) });
        if (prior?.kind === "file") {
          const backup = containedLexical(rollbackRoot, relative);
          mkdirSync(path.dirname(backup), { recursive: true });
          copyFileSync(target, backup);
        }
      }
      applyChanges(productRoot, changes, (effect, appliedCount) => {
        if (this.#faultAfterAppliedEffects !== undefined && appliedCount >= this.#faultAfterAppliedEffects) {
          throw new Error(`INTEGRATION_INJECTED_FAILURE: after ${appliedCount} effect(s), last=${effect.path}`);
        }
      });
      const effects: EffectStatus = changes.length
        ? { status: "observed", mutations: changes.map((change) => change.effect) }
        : { status: "none", mutations: [] };
      const output: JsonValue = {
        status: "integrated",
        sources: actualSources,
        mutations: changes.map((change) => ({ path: change.effect.path, kind: change.effect.kind })),
      };
      writeJsonAtomic(path.join(rollbackRoot, "integration.result.json"), { output, rollback, completedAt: new Date().toISOString() });
      return { output, effects };
    } catch (error) {
      const rollbackErrors = rollbackChanges(productRoot, rollbackRoot, rollback);
      if (rollbackErrors.length) {
        throw new Error(`INTEGRATION_ROLLBACK_FAILED: ${rollbackErrors.join("; ")}; original=${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
  }
}

function copyAndManifest(sourceRoot: string, targetRoot: string, maxEntries: number, maxBytes: number): Record<string, ManifestEntry> {
  let count = 0;
  let bytes = 0;
  const entries: Record<string, ManifestEntry> = {};
  const visit = (sourceDirectory: string, targetDirectory: string, prefix: string): void => {
    for (const child of readdirSync(sourceDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.name === ".git") continue;
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      count += 1;
      if (count > maxEntries) throw new Error(`isolated workspace exceeded ${maxEntries} entries`);
      const source = path.join(sourceDirectory, child.name);
      const target = path.join(targetDirectory, child.name);
      const stat = lstatSync(source);
      if (stat.isSymbolicLink()) throw new Error(`isolated workspace rejects symlink ${relative}`);
      if (stat.isDirectory()) {
        entries[relative] = { kind: "directory", mode: stat.mode };
        mkdirSync(target, { recursive: false, mode: stat.mode });
        visit(source, target, relative);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > maxBytes) throw new Error(`isolated workspace exceeded ${maxBytes} bytes`);
        copyFileSync(source, target);
        chmodSync(target, stat.mode);
        entries[relative] = fileEntry(source, stat.mode, stat.size);
      } else {
        throw new Error(`isolated workspace rejects special file ${relative}`);
      }
    }
  };
  visit(sourceRoot, targetRoot, "");
  return entries;
}

function scanManifest(root: string, maxEntries: number, maxBytes: number): Record<string, ManifestEntry> {
  const canonical = canonicalDirectory(root);
  let count = 0;
  let bytes = 0;
  const entries: Record<string, ManifestEntry> = {};
  const visit = (directory: string, prefix: string): void => {
    for (const child of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.name === ".git") continue;
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      count += 1;
      if (count > maxEntries) throw new Error(`workspace manifest exceeded ${maxEntries} entries`);
      const absolute = path.join(directory, child.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`workspace manifest rejects symlink ${relative}`);
      if (stat.isDirectory()) {
        entries[relative] = { kind: "directory", mode: stat.mode };
        visit(absolute, relative);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > maxBytes) throw new Error(`workspace manifest exceeded ${maxBytes} bytes`);
        entries[relative] = fileEntry(absolute, stat.mode, stat.size);
      } else {
        throw new Error(`workspace manifest rejects special file ${relative}`);
      }
    }
  };
  visit(canonical, "");
  return entries;
}

function diffManifests(base: Record<string, ManifestEntry>, current: Record<string, ManifestEntry>): EffectRecord[] {
  const effects: EffectRecord[] = [];
  for (const item of [...new Set([...Object.keys(base), ...Object.keys(current)])].sort()) {
    if (!Object.hasOwn(base, item)) effects.push({ path: item, kind: "created" });
    else if (!Object.hasOwn(current, item)) effects.push({ path: item, kind: "deleted" });
    else if (!sameEntry(base[item], current[item])) effects.push({ path: item, kind: "modified" });
  }
  return effects;
}

function applyChanges(
  productRoot: string,
  changes: Array<{ effect: EffectRecord; entry?: ManifestEntry; sourceRoot: string }>,
  afterApply: (effect: EffectRecord, appliedCount: number) => void,
): void {
  let appliedCount = 0;
  const deletions = changes.filter((change) => change.effect.kind === "deleted").sort((a, b) => b.effect.path.length - a.effect.path.length);
  const directories = changes.filter((change) => change.entry?.kind === "directory" && change.effect.kind !== "deleted").sort((a, b) => a.effect.path.length - b.effect.path.length);
  const files = changes.filter((change) => change.entry?.kind === "file" && change.effect.kind !== "deleted");
  for (const change of deletions) {
    const relative = normalizeRelative(change.effect.path);
    assertSafeProductAncestors(productRoot, relative);
    const target = containedLexical(productRoot, relative);
    rmSync(target, { recursive: true, force: true });
    afterApply(change.effect, ++appliedCount);
  }
  for (const change of directories) {
    const relative = normalizeRelative(change.effect.path);
    assertSafeProductAncestors(productRoot, relative);
    const target = containedLexical(productRoot, relative);
    if (existsSync(target) && !lstatSync(target).isDirectory()) rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    chmodSync(target, change.entry!.mode);
    afterApply(change.effect, ++appliedCount);
  }
  for (const change of files) {
    const relative = normalizeRelative(change.effect.path);
    const source = containedExisting(change.sourceRoot, relative);
    assertSafeProductAncestors(productRoot, relative);
    const target = containedLexical(productRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    if (existsSync(target) && !lstatSync(target).isFile()) rmSync(target, { recursive: true, force: true });
    const temporary = `${target}.orcn-integrate-${process.pid}-${randomBytes(4).toString("hex")}`;
    copyFileSync(source, temporary);
    chmodSync(temporary, change.entry!.mode);
    renameSync(temporary, target);
    afterApply(change.effect, ++appliedCount);
  }
}

function rollbackChanges(
  productRoot: string,
  rollbackRoot: string,
  rollback: Array<{ path: string; existed: boolean; entry?: ManifestEntry }>,
): string[] {
  const errors: string[] = [];
  const depth = (item: { path: string }) => item.path.split(/[\\/]+/).length;
  // Remove every possibly wrong-type target first, deepest first. This avoids
  // a restored child being deleted when its prior parent directory is restored.
  for (const item of [...rollback].sort((a, b) => depth(b) - depth(a))) {
    try {
      assertSafeProductAncestors(productRoot, item.path);
      rmSync(containedLexical(productRoot, item.path), { recursive: true, force: true });
    } catch (error) {
      errors.push(`${item.path}: remove failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const item of rollback.filter((entry) => entry.existed && entry.entry?.kind === "directory").sort((a, b) => depth(a) - depth(b))) {
    try {
      assertSafeProductAncestors(productRoot, item.path);
      const target = containedLexical(productRoot, item.path);
      mkdirSync(target, { recursive: true });
      chmodSync(target, item.entry!.mode);
    } catch (error) {
      errors.push(`${item.path}: directory restore failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const item of rollback.filter((entry) => entry.existed && entry.entry?.kind === "file")) {
    try {
      assertSafeProductAncestors(productRoot, item.path);
      const target = containedLexical(productRoot, item.path);
      const backup = containedExisting(rollbackRoot, item.path);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(backup, target);
      chmodSync(target, item.entry!.mode);
    } catch (error) {
      errors.push(`${item.path}: file restore failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

function entryAt(root: string, relative: string): ManifestEntry | undefined {
  const normalized = normalizeRelative(relative);
  assertSafeProductAncestors(root, normalized);
  const absolute = containedLexical(root, normalized.replace(/\/$/, ""));
  if (!existsSync(absolute)) return undefined;
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`workspace path became a symlink: ${normalized}`);
  if (stat.isDirectory()) return { kind: "directory", mode: stat.mode };
  if (stat.isFile()) return fileEntry(absolute, stat.mode, stat.size);
  throw new Error(`workspace path is a special file: ${normalized}`);
}

function fileEntry(file: string, mode: number, size: number): ManifestEntry {
  return {
    kind: "file",
    size,
    mode,
    hash: createHash("sha256").update(readFileSync(file)).digest("hex"),
  };
}

function sameCandidate(
  left: { effect: EffectRecord; entry?: ManifestEntry },
  right: { effect: EffectRecord; entry?: ManifestEntry },
): boolean {
  return left.effect.kind === right.effect.kind && sameEntry(left.entry, right.entry);
}

function sameEntry(left: ManifestEntry | undefined, right: ManifestEntry | undefined): boolean {
  if (!left || !right) return left === right;
  return left.kind === right.kind && left.hash === right.hash && left.size === right.size && (left.mode & 0o777) === (right.mode & 0o777);
}

function manifestFingerprint(entries: Record<string, ManifestEntry>): string {
  return createHash("sha256").update(JSON.stringify(Object.keys(entries).sort().map((key) => [key, entries[key]]))).digest("hex");
}

function bindingFromMetadata(metadata: CandidateMetadata, metadataFile: string): WorkspaceBinding {
  return {
    mode: "isolated",
    root: canonicalDirectory(metadata.workspaceRoot),
    productRoot: canonicalDirectory(metadata.productRoot),
    phaseId: metadata.phaseId,
    attempt: metadata.attempt,
    metadataFile: path.resolve(metadataFile),
    baseFingerprint: metadata.baseFingerprint,
  };
}

function readMetadata(file: string): CandidateMetadata {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as CandidateMetadata;
  if (parsed.version !== METADATA_VERSION || !parsed.runId || !parsed.phaseId || !Number.isInteger(parsed.attempt)) {
    throw new Error(`INVALID_WORKSPACE_METADATA: ${file}`);
  }
  return parsed;
}

function assertMetadataMatches(
  metadata: CandidateMetadata,
  request: WorkspacePrepareRequest,
  productRoot: string,
  candidateRoot: string,
): void {
  if (metadata.runId !== request.runId
    || metadata.phaseId !== request.phase.id
    || metadata.attempt !== request.attempt
    || metadata.productRoot !== productRoot
    || path.resolve(metadata.workspaceRoot) !== path.resolve(candidateRoot)) {
    throw new Error(`ISOLATED_WORKSPACE_IDENTITY_MISMATCH: ${request.phase.id} attempt ${request.attempt}`);
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
}

function canonicalDirectory(directory: string): string {
  const absolute = path.resolve(directory);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new Error(`WORKSPACE_MISSING: ${absolute}`);
  return realpathSync(absolute);
}

function assertOutside(productRoot: string, candidate: string, label: string): void {
  const relative = path.relative(productRoot, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error(`${label} must stay outside the product workspace`);
  }
}

function assertSafeProductAncestors(root: string, relative: string): void {
  const canonicalRoot = realpathSync(root);
  const parts = normalizeRelative(relative).split("/");
  let cursor = canonicalRoot;
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    if (!existsSync(cursor)) return;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`INTEGRATION_PATH_ESCAPE: ancestor is a symlink or junction: ${relative}`);
    if (!stat.isDirectory()) throw new Error(`INTEGRATION_PATH_CONFLICT: ancestor is not a directory: ${relative}`);
    const canonical = realpathSync(cursor);
    const relation = path.relative(canonicalRoot, canonical);
    if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
      throw new Error(`INTEGRATION_PATH_ESCAPE: ancestor resolves outside product workspace: ${relative}`);
    }
  }
}

function containedLexical(root: string, relative: string): string {
  const normalized = normalizeRelative(relative);
  const candidate = path.resolve(root, normalized.replace(/\/$/, ""));
  const relation = path.relative(root, candidate);
  if (relation === "" || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`workspace path escapes root: ${relative}`);
  }
  return candidate;
}

function containedExisting(root: string, relative: string): string {
  const candidate = containedLexical(root, relative);
  const canonical = realpathSync(candidate);
  const relation = path.relative(realpathSync(root), canonical);
  if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`workspace path escapes through a link: ${relative}`);
  }
  return canonical;
}

function normalizeRelative(relative: string): string {
  const normalized = relative.replace(/\\/g, "/");
  const withoutDirectoryMarker = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  if (!withoutDirectoryMarker || path.posix.isAbsolute(withoutDirectoryMarker) || withoutDirectoryMarker.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`unsafe workspace-relative path: ${relative}`);
  }
  return withoutDirectoryMarker;
}

function assertSafeComponent(value: string, label: string): void {
  if (!SAFE_COMPONENT.test(value)) throw new Error(`unsafe ${label}: ${JSON.stringify(value)}`);
}

function boundedReason(reason: string): string {
  return reason.length <= 4_000 ? reason : `${reason.slice(0, 3_997)}...`;
}
