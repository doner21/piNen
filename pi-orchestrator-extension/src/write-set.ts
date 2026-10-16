import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Predicted-write-set enforcement (predict-then-write) ──────────────
//
// Implements the deterministic side of the AGENTS.md "Discovery before
// mutation" policy: a contract- or planner-declared write set becomes the
// executors' entire write scope, and observed worktree deltas are checked
// against it mechanically — an out-of-set mutation is a deterministic FAIL
// naming the file, with no model judgment involved.
//
// Entry syntax (repo-relative or absolute, case-insensitive, "/" separators):
//   exact file .... "src/index.ts", "C:/external/root/file.txt"
//   dir prefix .... "docs/", "C:/external/root/replicas/" (trailing slash)
//   glob .......... "tools/*.mjs", "runs/**" ("*" stays within one segment,
//                                             "**" crosses segments)

export interface WriteSetEvaluation {
  /** Normalized union of per-task worktree deltas (baseline-aware). */
  observed: string[];
  /** Observed mutations not covered by any write-set entry. */
  violations: string[];
  /** Task ids whose worktree delta was unavailable (enforcement degraded). */
  unobservableTasks: string[];
}

export interface FileSignature {
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface WriteSetSnapshot {
  cwd: string;
  /** `git status --short --untracked-files=all` lines for cwd, or undefined when cwd is not observable through git. */
  cwdStatus?: string[];
  /** Content signatures for status-listed cwd files at this baseline. */
  cwdFiles: Record<string, FileSignature>;
  /** Absolute external observation roots and their file signatures. */
  externalFiles: Record<string, FileSignature>;
  /** Absolute roots that could not be observed and therefore must fail closed. */
  unobservableScopes: string[];
}

export interface WriteSetObservationEvaluation extends WriteSetEvaluation {
  /** Absolute observation scopes that could not be captured before/after. */
  unobservableScopes: string[];
}

export interface ExternalEvidenceSnapshot {
  /** Canonical absolute roots whose contents are evidence-only authority. */
  roots: string[];
  /** Absolute file signatures. Evidence roots are never mutation grants. */
  files: Record<string, FileSignature>;
  /** Roots that could not be exhaustively observed, including symlink contents. */
  unobservableRoots: string[];
}

export interface ExternalEvidenceRootValidationInput {
  cwd: string;
  worktreeRoot: string;
  worktreeRealRoot: string;
  roots: string[];
  protectedRoots?: string[];
}

interface CwdObservation {
  statusLines: string[];
  files: Record<string, FileSignature>;
}

export function normalizeWriteSetEntry(entry: string): string {
  let normalized = String(entry ?? "").trim().replace(/\\/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized.replace(/\/{2,}/g, "/");
}

const WINDOWS_RESERVED_DEVICE_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * Windows resolves these basenames as devices even when an extension is
 * present. Ignore any path containing such a segment before touching the
 * filesystem or treating it as an orchestration effect. Other hosts retain
 * ordinary files with the same spelling.
 */
export function isWindowsReservedDevicePath(
  entry: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  return normalizeWriteSetEntry(entry)
    .split("/")
    .filter(Boolean)
    .some((segment) => WINDOWS_RESERVED_DEVICE_BASENAME.test(segment));
}

/**
 * Parse a write-set input into normalized entries. Accepts a string
 * (comma- and/or newline-separated) or an array of strings. Returns
 * undefined when no usable entries remain.
 */
export function parseWriteSetInput(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const items = Array.isArray(raw)
    ? raw.map((item) => String(item))
    : String(raw).split(/[\n,]/);
  const normalized = items
    .map(normalizeWriteSetEntry)
    .filter((entry) => Boolean(entry) && !isWindowsReservedDevicePath(entry));
  return normalized.length ? [...new Set(normalized)] : undefined;
}

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function isAbsoluteEntry(entry: string): boolean {
  const normalized = normalizeWriteSetEntry(entry);
  return path.isAbsolute(normalized) || /^[a-zA-Z]:\//.test(normalized);
}

function toNativePath(entry: string): string {
  return normalizeWriteSetEntry(entry).replace(/\//g, path.sep);
}

function normalizeAbsoluteFsPath(entry: string): string {
  return normalizeWriteSetEntry(path.resolve(toNativePath(entry)));
}

function pathInsideOrEqual(childAbs: string, parentAbs: string): boolean {
  const rel = path.relative(toNativePath(parentAbs), toNativePath(childAbs));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function comparableAbsolute(entry: string): string {
  const normalized = normalizeAbsoluteFsPath(entry);
  return process.platform === "win32" || /^[a-zA-Z]:\//.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

function hasParentTraversal(entry: string): boolean {
  return normalizeWriteSetEntry(entry).split("/").includes("..");
}

/**
 * Validate and canonicalize explicit external evidence roots. These roots are
 * read/evaluation authority only. They are deliberately separate from the
 * predicted write set and can never authorize an external mutation.
 */
export function canonicalizeExternalEvidenceRoots(input: ExternalEvidenceRootValidationInput): string[] {
  if (input.roots.length === 0) return [];
  const cwd = normalizeAbsoluteFsPath(input.cwd);
  const worktreeRoot = normalizeAbsoluteFsPath(input.worktreeRoot);
  const worktreeRealRoot = normalizeAbsoluteFsPath(input.worktreeRealRoot);
  if (comparableAbsolute(worktreeRoot) !== comparableAbsolute(worktreeRealRoot)) {
    throw new Error("External evidence roots require a valid canonical worktree binding.");
  }
  const protectedRoots = (input.protectedRoots ?? []).map(normalizeAbsoluteFsPath);
  const canonical: string[] = [];
  for (const raw of input.roots) {
    const candidate = normalizeWriteSetEntry(raw);
    if (!candidate) throw new Error("External evidence root must be nonempty.");
    if (!isAbsoluteEntry(candidate)) throw new Error(`External evidence root must be absolute: ${candidate}`);
    if (hasParentTraversal(candidate)) throw new Error(`External evidence root contains forbidden parent traversal: ${candidate}`);
    if (/[*?\[\]]/.test(candidate)) throw new Error(`External evidence root cannot contain a glob: ${candidate}`);
    const lexical = normalizeAbsoluteFsPath(candidate.replace(/\/$/, ""));
    let stat: fs.Stats;
    let real: string;
    try {
      stat = fs.lstatSync(toNativePath(lexical));
      if (stat.isSymbolicLink()) throw new Error("root is a symlink or junction");
      if (!stat.isDirectory()) throw new Error("root is not a directory");
      real = normalizeWriteSetEntry(fs.realpathSync.native(toNativePath(lexical)));
    } catch (error) {
      throw new Error(`External evidence root is not a canonical readable directory: ${candidate} (${error instanceof Error ? error.message : String(error)})`);
    }
    if (comparableAbsolute(lexical) !== comparableAbsolute(real)) {
      throw new Error(`External evidence root uses a symlink, junction, or non-canonical alias: ${candidate}`);
    }
    if (pathInsideOrEqual(comparableAbsolute(lexical), comparableAbsolute(worktreeRoot)) ||
        pathInsideOrEqual(comparableAbsolute(cwd), comparableAbsolute(lexical))) {
      throw new Error(`External evidence root must be outside the frozen worktree: ${candidate}`);
    }
    if (protectedRoots.some((root) =>
      pathInsideOrEqual(comparableAbsolute(lexical), comparableAbsolute(root)) ||
      pathInsideOrEqual(comparableAbsolute(root), comparableAbsolute(lexical)))) {
      throw new Error(`External evidence root overlaps a protected path: ${candidate}`);
    }
    if (!canonical.some((root) => comparableAbsolute(root) === comparableAbsolute(real))) canonical.push(real);
  }
  return canonical.sort((left, right) => left.localeCompare(right));
}

/** Resolve an existing evidence file and prove its canonical identity remains under a declared root. */
export function resolveDeclaredExternalEvidencePath(candidate: string, roots: string[]): string {
  const normalized = normalizeWriteSetEntry(candidate);
  if (!isAbsoluteEntry(normalized)) throw new Error("External evidence path must be absolute.");
  if (hasParentTraversal(normalized)) throw new Error("External evidence path contains forbidden parent traversal.");
  const lexical = normalizeAbsoluteFsPath(normalized);
  let stat: fs.Stats;
  let real: string;
  try {
    stat = fs.lstatSync(toNativePath(lexical));
    if (stat.isSymbolicLink()) throw new Error("evidence path is a symlink");
    real = normalizeWriteSetEntry(fs.realpathSync.native(toNativePath(lexical)));
  } catch (error) {
    throw new Error(`External evidence path is not canonically readable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stat.isFile() && !stat.isDirectory()) throw new Error("External evidence path is not a regular file or directory.");
  const declared = roots.some((root) => pathInsideOrEqual(comparableAbsolute(real), comparableAbsolute(root)));
  if (!declared) throw new Error(`External evidence path is not beneath a declared external evidence root: ${candidate}`);
  // A lexical path beneath a root that resolves through an internal symlink is
  // an escape even when its final target happens to be beneath another root.
  if (!roots.some((root) =>
    pathInsideOrEqual(comparableAbsolute(lexical), comparableAbsolute(root)) &&
    pathInsideOrEqual(comparableAbsolute(real), comparableAbsolute(root)))) {
    throw new Error(`External evidence path escapes its declared root through a symlink or junction: ${candidate}`);
  }
  return real;
}

function relativeVariantForCwd(entry: string, cwd: string): string | undefined {
  const normalized = normalizeWriteSetEntry(entry);
  if (!isAbsoluteEntry(normalized)) return undefined;
  const trailingSlash = normalized.endsWith("/");
  const abs = normalizeAbsoluteFsPath(trailingSlash ? normalized.slice(0, -1) : normalized);
  const cwdAbs = normalizeAbsoluteFsPath(cwd);
  if (!pathInsideOrEqual(abs, cwdAbs)) return undefined;
  const rel = normalizeWriteSetEntry(path.relative(toNativePath(cwdAbs), toNativePath(abs)));
  if (!rel || rel === ".") return trailingSlash ? "" : undefined;
  return trailingSlash ? `${rel}/` : rel;
}

function allowedEntryVariants(entry: string, cwd?: string): string[] {
  const normalized = normalizeWriteSetEntry(entry);
  const variants = [normalized];
  if (cwd) {
    const rel = relativeVariantForCwd(normalized, cwd);
    if (rel && !variants.includes(rel)) variants.push(rel);
  }
  return variants;
}

function entryToMatcher(entry: string): (file: string) => boolean {
  const normalized = normalizeWriteSetEntry(entry).toLowerCase();
  if (!normalized) return () => false;
  if (normalized.includes("*")) {
    const pattern = normalized
      .split(/(\*\*|\*)/)
      .map((part) => (part === "**" ? ".*" : part === "*" ? "[^/]*" : escapeRegex(part)))
      .join("");
    const regex = new RegExp(`^${pattern}$`);
    return (file) => regex.test(file);
  }
  if (normalized.endsWith("/")) {
    return (file) => file.startsWith(normalized);
  }
  return (file) => file === normalized;
}

export function fileMatchesWriteSet(file: string, allowed: string[], cwd?: string): boolean {
  const normalizedFile = normalizeWriteSetEntry(file).toLowerCase();
  if (!normalizedFile || isWindowsReservedDevicePath(normalizedFile)) return true;
  return allowed.some((entry) => allowedEntryVariants(entry, cwd).some((variant) => entryToMatcher(variant)(normalizedFile)));
}

/**
 * Compare per-task observed worktree deltas against the allowed write set.
 * Tasks whose delta could not be captured (filesChanged undefined — e.g. git
 * unavailable) are reported as unobservable rather than silently passed.
 */
export function evaluateWriteSet(
  outputs: Array<{ taskId: string; filesChanged?: number; changedFiles?: string[] }>,
  allowed: string[],
  cwd?: string,
): WriteSetEvaluation {
  const observed: string[] = [];
  const violations: string[] = [];
  const unobservableTasks: string[] = [];
  for (const output of outputs) {
    if (output.filesChanged === undefined) {
      if (!unobservableTasks.includes(output.taskId)) unobservableTasks.push(output.taskId);
      continue;
    }
    for (const file of output.changedFiles ?? []) {
      const normalized = normalizeWriteSetEntry(file);
      if (!normalized || isWindowsReservedDevicePath(normalized)) continue;
      if (!observed.includes(normalized)) observed.push(normalized);
      if (!fileMatchesWriteSet(normalized, allowed, cwd) && !violations.includes(normalized)) {
        violations.push(normalized);
      }
    }
  }
  return { observed, violations, unobservableTasks };
}

/**
 * Pre-execution satisfiability check: planner-predicted entries that the
 * contract-granted set does not cover. Non-empty means the plan already
 * declares out-of-scope mutations — fail BEFORE any executor spawns.
 */
export function planEntriesOutsideContract(planSet: string[], contractSet: string[]): string[] {
  const contractNormalized = contractSet.map((entry) => normalizeWriteSetEntry(entry).toLowerCase());
  return planSet
    .map(normalizeWriteSetEntry)
    .filter((entry) => Boolean(entry) && !isWindowsReservedDevicePath(entry))
    .filter((entry) => {
      if (fileMatchesWriteSet(entry, contractSet)) return false;
      // A plan entry that is textually identical to a contract entry (e.g. a
      // dir prefix or glob granted verbatim) is in scope even though it does
      // not match as a plain file path.
      return !contractNormalized.includes(entry.toLowerCase());
    });
}

/** Snapshot cwd (always, via git) plus absolute write/evidence observation roots. */
export function captureWriteSetSnapshot(cwd: string, allowed: string[], evidenceRoots: string[] = []): WriteSetSnapshot {
  const cwdAbs = normalizeAbsoluteFsPath(cwd);
  const cwdObservation = captureCwdObservation(cwdAbs);
  const unobservableScopes: string[] = [];
  if (!cwdObservation) {
    unobservableScopes.push(`cwd:${cwdAbs}`);
  }

  const externalFiles: Record<string, FileSignature> = {};
  const canonicalEvidenceRoots = evidenceRoots.map(normalizeAbsoluteFsPath);
  const evidenceRootKeys = new Set(canonicalEvidenceRoots.map(comparableAbsolute));
  for (const root of [...new Set([...externalObservationRoots(cwdAbs, allowed), ...canonicalEvidenceRoots])]) {
    try {
      const stat = fs.statSync(toNativePath(root));
      if (!stat.isDirectory()) {
        unobservableScopes.push(root);
        continue;
      }
      for (const [file, signature] of Object.entries(scanFileSignatures(root, evidenceRootKeys.has(comparableAbsolute(root))))) {
        externalFiles[file] = signature;
      }
    } catch {
      unobservableScopes.push(root);
    }
  }

  return {
    cwd: cwdAbs,
    ...(cwdObservation ? { cwdStatus: cwdObservation.statusLines } : {}),
    cwdFiles: cwdObservation?.files ?? {},
    externalFiles,
    unobservableScopes: [...new Set(unobservableScopes)],
  };
}

export function diffWriteSetSnapshots(before: WriteSetSnapshot, after: WriteSetSnapshot): string[] {
  const changed: string[] = [];
  const add = (file: string) => {
    const normalized = normalizeWriteSetEntry(file);
    if (normalized && !isWindowsReservedDevicePath(normalized) && !changed.includes(normalized)) changed.push(normalized);
  };

  for (const file of diffCwdObservation(before.cwdStatus, before.cwdFiles, after.cwdStatus, after.cwdFiles)) add(file);

  const allExternal = new Set([...Object.keys(before.externalFiles), ...Object.keys(after.externalFiles)]);
  for (const file of allExternal) {
    const pre = before.externalFiles[file];
    const post = after.externalFiles[file];
    if (!sameSignature(pre, post)) add(file);
  }
  return changed;
}

export function evaluateWriteSetObservation(
  before: WriteSetSnapshot,
  after: WriteSetSnapshot,
  allowed: string[],
): WriteSetObservationEvaluation {
  const observed = diffWriteSetSnapshots(before, after);
  const violations = observed.filter((file) => !fileMatchesWriteSet(file, allowed, before.cwd));
  const unobservableScopes = [...new Set([...before.unobservableScopes, ...after.unobservableScopes])];
  return { observed, violations, unobservableTasks: [], unobservableScopes };
}

/** Capture declared evidence roots independently of write-set authorization. */
export function captureExternalEvidenceSnapshot(roots: string[]): ExternalEvidenceSnapshot {
  const files: Record<string, FileSignature> = {};
  const unobservableRoots: string[] = [];
  for (const root of roots.map(normalizeAbsoluteFsPath)) {
    try {
      const stat = fs.lstatSync(toNativePath(root));
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("not a real directory");
      for (const [file, signature] of Object.entries(scanFileSignatures(root, true))) files[file] = signature;
    } catch {
      unobservableRoots.push(root);
    }
  }
  return { roots: roots.map(normalizeAbsoluteFsPath), files, unobservableRoots: [...new Set(unobservableRoots)] };
}

/** Absolute byte changes beneath read-only evidence roots. */
export function diffExternalEvidenceSnapshots(
  before: ExternalEvidenceSnapshot,
  after: ExternalEvidenceSnapshot,
): ContentSignatureChange[] {
  const changes: ContentSignatureChange[] = [];
  for (const file of [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()) {
    const previous = before.files[file];
    const current = after.files[file];
    if (!previous && current) changes.push({ path: file, kind: "added", after: current });
    else if (previous && !current) changes.push({ path: file, kind: "deleted", before: previous });
    else if (!sameSignature(previous, current)) changes.push({ path: file, kind: "modified", before: previous, after: current });
  }
  return changes;
}

function externalObservationRoots(cwdAbs: string, allowed: string[]): string[] {
  const roots: string[] = [];
  for (const raw of allowed) {
    const normalized = normalizeWriteSetEntry(raw);
    if (isWindowsReservedDevicePath(normalized) || !isAbsoluteEntry(normalized)) continue;
    const firstGlob = normalized.search(/[\*]/);
    const concrete = firstGlob >= 0 ? normalized.slice(0, firstGlob) : normalized;
    const trailingSlash = concrete.endsWith("/");
    const target = normalizeAbsoluteFsPath(trailingSlash ? concrete.slice(0, -1) : concrete);
    if (pathInsideOrEqual(target, cwdAbs)) continue;
    // Observe the parent of an external exact/prefix grant. That intentionally
    // catches lookalike siblings such as replicas$DIR/ when only replicas/ was
    // granted, instead of treating the granted prefix as the whole observable universe.
    const root = normalizeWriteSetEntry(path.dirname(toNativePath(target)));
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

function captureCwdObservation(cwd: string): CwdObservation | undefined {
  const rawStatusLines = captureGitStatus(cwd);
  if (!rawStatusLines) return undefined;
  // RunStateStore writes checkpoints while the orchestration is running. Those
  // are transport bookkeeping, not executor/product mutations, and must not
  // poison predicted-write-set enforcement. Filtering before signatures also
  // avoids hashing thousands of historical checkpoint files in dirty repos.
  const statusLines = rawStatusLines.filter((line) => {
    const paths = pathsFromGitStatusLine(line);
    return paths.length === 0 || !paths.every((file) =>
      isManagedRunStatePath(cwd, file) || isWindowsReservedDevicePath(file));
  });
  const files = captureCwdStatusFileSignatures(cwd, statusLines);
  if (!files) return undefined;
  return { statusLines, files };
}

function managedRunsRoot(): string {
  const override = process.env.PI_ORCHESTRATOR_RUNS_ROOT?.trim();
  return normalizeAbsoluteFsPath(
    override || path.join(os.homedir(), ".pi", "pi-orchestrator-extension", "runs-state"),
  );
}

function isManagedRunStatePath(cwd: string, relativeFile: string): boolean {
  const absolute = normalizeAbsoluteFsPath(path.resolve(toNativePath(cwd), toNativePath(relativeFile)));
  return pathInsideOrEqual(absolute, managedRunsRoot());
}

function captureGitStatus(cwd: string): string[] | undefined {
  try {
    const result = spawnSync(
      "git",
      ["-C", toNativePath(cwd), "status", "--short", "--untracked-files=all", "--", "."],
      {
        timeout: 5000,
        encoding: "utf8",
        windowsHide: true,
        // Dirty orchestration worktrees can legitimately contain thousands of
        // generated/run-state files. Node's 1 MiB spawnSync default otherwise
        // returns ENOBUFS and incorrectly classifies an observable Git cwd as
        // WRITE_SET_UNOBSERVABLE before any executor can start.
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    if (result.status !== 0) return undefined;
    return (result.stdout ?? "")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

function diffCwdObservation(
  beforeStatus: string[] | undefined,
  beforeFiles: Record<string, FileSignature>,
  afterStatus: string[] | undefined,
  afterFiles: Record<string, FileSignature>,
): string[] {
  if (!beforeStatus || !afterStatus) return [];
  const changed: string[] = [];
  const add = (file: string) => {
    const normalized = normalizeWriteSetEntry(file);
    if (normalized && !isWindowsReservedDevicePath(normalized) && !changed.includes(normalized)) changed.push(normalized);
  };

  const beforeLineSet = new Set(beforeStatus);
  const afterLineSet = new Set(afterStatus);
  for (const line of afterStatus) {
    if (!beforeLineSet.has(line)) {
      for (const file of pathsFromGitStatusLine(line)) add(file);
    }
  }
  for (const line of beforeStatus) {
    if (!afterLineSet.has(line)) {
      for (const file of pathsFromGitStatusLine(line)) add(file);
    }
  }

  const allFiles = new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)]);
  for (const file of allFiles) {
    if (!sameSignature(beforeFiles[file], afterFiles[file])) add(file);
  }
  return changed;
}

function pathsFromGitStatusLine(line: string): string[] {
  const payload = line.length >= 3 ? line.slice(3).trim() : line.trim();
  if (!payload) return [];
  return payload
    .split(" -> ")
    .map(unquoteGitPath)
    .map(normalizeWriteSetEntry)
    .filter(Boolean);
}

function unquoteGitPath(value: string): string {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed;
  try {
    return String(JSON.parse(trimmed));
  } catch {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

function captureCwdStatusFileSignatures(cwd: string, statusLines: string[]): Record<string, FileSignature> | undefined {
  const out: Record<string, FileSignature> = {};
  try {
    for (const line of statusLines) {
      for (const rel of pathsFromGitStatusLine(line)) {
        const relNormalized = normalizeWriteSetEntry(rel);
        if (!relNormalized || isWindowsReservedDevicePath(relNormalized)) continue;
        const absNative = path.resolve(toNativePath(cwd), toNativePath(relNormalized));
        const absNormalized = normalizeWriteSetEntry(absNative);
        if (!pathInsideOrEqual(absNormalized, cwd)) continue;
        captureCwdPathSignatures(cwd, absNative, out);
      }
    }
    return out;
  } catch {
    return undefined;
  }
}

function captureCwdPathSignatures(cwd: string, nativePath: string, out: Record<string, FileSignature>): void {
  const rel = normalizeWriteSetEntry(path.relative(toNativePath(cwd), nativePath));
  if (isWindowsReservedDevicePath(rel)) return;
  if (!fs.existsSync(nativePath)) return;
  const stat = fs.statSync(nativePath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(nativePath, { withFileTypes: true })) {
      captureCwdPathSignatures(cwd, path.join(nativePath, entry.name), out);
    }
    return;
  }
  if (!stat.isFile()) return;
  if (!rel || rel.startsWith("..")) return;
  out[rel] = fileSignature(nativePath, stat);
}

function sameSignature(left: FileSignature | undefined, right: FileSignature | undefined): boolean {
  return Boolean(left && right && left.size === right.size && left.sha256 === right.sha256);
}

function fileSignature(nativePath: string, stat = fs.statSync(nativePath)): FileSignature {
  const bytes = fs.readFileSync(nativePath);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

function scanFileSignatures(root: string, rejectSymlinks = false): Record<string, FileSignature> {
  const out: Record<string, FileSignature> = {};
  const rootNative = toNativePath(root);
  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const file = normalizeWriteSetEntry(path.resolve(full));
      if (isWindowsReservedDevicePath(file)) continue;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        if (rejectSymlinks) throw new Error(`symlink evidence entry is not observable: ${file}`);
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!stat.isFile()) continue;
      out[file] = fileSignature(full, stat);
    }
  };
  walk(rootNative);
  return out;
}

// ── Bounded content-level effect snapshots ────────────────────────────────

export interface ContentSnapshotLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  excludeDirectories: string[];
  /** Literal approved paths only; observation remains rooted in the workspace. */
  scope?: string[];
}

export interface ContentSignatureSnapshot {
  root: string;
  files: Record<string, FileSignature>;
  limits: ContentSnapshotLimits;
  fileCount: number;
  totalBytes: number;
  truncated: boolean;
  /** Paths skipped because of a symlink, exclusion, or enforced bound. */
  omitted: Array<{ path: string; reason: "excluded" | "symlink" | "file-limit" | "file-byte-limit" | "total-byte-limit" }>;
}

export interface ContentSignatureChange {
  path: string;
  kind: "added" | "modified" | "deleted";
  before?: FileSignature;
  after?: FileSignature;
}

const DEFAULT_CONTENT_EXCLUSIONS = [
  ".git",
  ".cache",
  ".next",
  "node_modules",
  "runs-state",
  "runtime-data",
  "coverage",
  "dist",
  "build",
  "out",
];

function positiveBound(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return resolved;
}

/**
 * Hash regular files beneath a root with deterministic ordering and hard
 * traversal limits. Symlinks are never followed, so a workspace link cannot
 * expand observation into a protected or unbounded tree. Tracked, untracked,
 * clean, and already-dirty files are treated identically at the byte level.
 */
export function captureContentSignatureSnapshot(
  root: string,
  options: Partial<ContentSnapshotLimits> = {},
): ContentSignatureSnapshot {
  const rootNative = path.resolve(root);
  const rootStat = fs.lstatSync(rootNative);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Content snapshot root must be a real directory: ${root}`);
  }
  const canonicalRoot = fs.realpathSync.native(rootNative);
  const limits: ContentSnapshotLimits = {
    maxFiles: positiveBound(options.maxFiles, 2_000, "maxFiles"),
    maxTotalBytes: positiveBound(options.maxTotalBytes, 64 * 1024 * 1024, "maxTotalBytes"),
    maxFileBytes: positiveBound(options.maxFileBytes, 8 * 1024 * 1024, "maxFileBytes"),
    excludeDirectories: [...new Set((options.excludeDirectories ?? DEFAULT_CONTENT_EXCLUSIONS).map((entry) => entry.toLowerCase()))].sort(),
  };
  if (options.scope) {
    limits.scope = options.scope.map(normalizeWriteSetEntry);
    if (limits.scope.some(entry => !entry || path.isAbsolute(entry) || /^[a-z]:/i.test(entry) || entry.split('/').includes('..') || /[*?\[\]{}]/.test(entry))) {
      throw new Error('Content scope requires literal workspace-relative paths.');
    }
  }
  const files: Record<string, FileSignature> = {};
  const omitted: ContentSignatureSnapshot["omitted"] = [];
  let fileCount = 0;
  let visitedFileCount = 0;
  let totalBytes = 0;
  let truncated = false;
  let hardLimitReached = false;

  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (hardLimitReached) return;
      const full = path.join(directory, entry.name);
      const relative = normalizeWriteSetEntry(path.relative(canonicalRoot, full));
      if (!relative || relative.startsWith("../") || isWindowsReservedDevicePath(relative)) continue;
      if (limits.scope && !limits.scope.some(scope => {
        const target = scope.replace(/\/$/, '');
        return relative === target || relative.startsWith(target + '/') || target.startsWith(relative + '/');
      })) continue;
      if (entry.isSymbolicLink()) {
        omitted.push({ path: relative, reason: "symlink" });
        continue;
      }
      if (entry.isDirectory()) {
        if (limits.excludeDirectories.includes(entry.name.toLowerCase())) {
          omitted.push({ path: `${relative}/`, reason: "excluded" });
        } else {
          walk(full);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (visitedFileCount >= limits.maxFiles) {
        truncated = true;
        hardLimitReached = true;
        omitted.push({ path: relative, reason: "file-limit" });
        return;
      }
      visitedFileCount += 1;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        omitted.push({ path: relative, reason: "symlink" });
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > limits.maxFileBytes) {
        truncated = true;
        omitted.push({ path: relative, reason: "file-byte-limit" });
        continue;
      }
      if (totalBytes + stat.size > limits.maxTotalBytes) {
        truncated = true;
        hardLimitReached = true;
        omitted.push({ path: relative, reason: "total-byte-limit" });
        return;
      }
      files[relative] = fileSignature(full, stat);
      fileCount += 1;
      totalBytes += stat.size;
    }
  };
  walk(canonicalRoot);
  return {
    root: normalizeWriteSetEntry(canonicalRoot),
    files,
    limits,
    fileCount,
    totalBytes,
    truncated,
    omitted,
  };
}

/** Byte-level changes, including mutations to paths dirty before both snapshots. */
export function diffContentSignatureSnapshots(
  before: ContentSignatureSnapshot,
  after: ContentSignatureSnapshot,
): ContentSignatureChange[] {
  if (normalizeAbsoluteFsPath(before.root).toLowerCase() !== normalizeAbsoluteFsPath(after.root).toLowerCase()) {
    throw new Error("Cannot diff content snapshots from different roots.");
  }
  const changes: ContentSignatureChange[] = [];
  const paths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort();
  for (const file of paths) {
    if (isWindowsReservedDevicePath(file)) continue;
    const previous = before.files[file];
    const current = after.files[file];
    const covered = (snapshot: ContentSignatureSnapshot) => !snapshot.truncated && !snapshot.omitted.some(item => file === item.path || file.startsWith(item.path.replace(/\/$/, '') + '/'));
    if (!previous && current && covered(before)) changes.push({ path: file, kind: "added", after: current });
    else if (previous && !current && covered(after)) changes.push({ path: file, kind: "deleted", before: previous });
    else if (previous && current && !sameSignature(previous, current)) changes.push({ path: file, kind: "modified", before: previous, after: current });
  }
  return changes;
}
