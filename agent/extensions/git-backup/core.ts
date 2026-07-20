import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";

export type RemotePolicy = "existing-origin-only" | "disabled";

export interface GitBackupConfig {
  schemaVersion: number;
  enabled: boolean;
  paused: boolean;
  settleDebounceSeconds: number;
  startupCatchUpSeconds: number;
  pushOnShutdown: boolean;
  includeUntracked: boolean;
  remote: {
    enabled: boolean;
    policy: RemotePolicy;
    name: string;
    branchPrefix: string;
    minIntervalMinutes: number;
    timeoutMs: number;
  };
  security: {
    requireGitleaks: boolean;
    gitleaksCommand: string;
    denyGlobs: string[];
    maxChangedFiles: number;
    maxNewBlobBytes: number;
    maxNewDataBytes: number;
    maxObjectScanCount: number;
  };
  repositoryOverrides: Record<string, Partial<GitBackupConfig>>;
}

export interface BackupRunOptions {
  reason: string;
  runtimeDir: string;
  pushRemote: boolean;
  config: GitBackupConfig;
}

export type BackupOutcome =
  | "not-a-repository"
  | "disabled"
  | "no-change"
  | "local-snapshot"
  | "remote-verified"
  | "blocked"
  | "failed";

export interface BackupRunResult {
  ok: boolean;
  outcome: BackupOutcome;
  repoRoot?: string;
  branch?: string;
  localRef?: string;
  remoteRef?: string;
  commit?: string;
  remoteCommit?: string;
  changedFiles?: number;
  changedPaths?: string[];
  blockedPaths?: string[];
  remoteConfigured?: boolean;
  remotePushed?: boolean;
  securityScan?: "passed" | "blocked" | "unavailable" | "skipped";
  message: string;
  error?: string;
  durationMs: number;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut: boolean;
}

interface ObjectBudget {
  objectCount: number;
  blobCount: number;
  totalBlobBytes: number;
  maxBlobBytes: number;
}

export const DEFAULT_CONFIG: GitBackupConfig = {
  schemaVersion: 1,
  enabled: true,
  paused: false,
  settleDebounceSeconds: 45,
  startupCatchUpSeconds: 90,
  pushOnShutdown: true,
  includeUntracked: true,
  remote: {
    enabled: true,
    policy: "existing-origin-only",
    name: "origin",
    branchPrefix: "pi-backup",
    minIntervalMinutes: 15,
    timeoutMs: 45_000,
  },
  security: {
    requireGitleaks: true,
    gitleaksCommand: "gitleaks",
    denyGlobs: [
      "**/.env",
      "**/.env.*",
      "**/.npmrc",
      "**/.pypirc",
      "**/auth.json",
      "**/gmail-config.json",
      "**/gmail-config.json.bak",
      "**/railway-token.json",
      "**/credentials.json",
      "**/*-credentials.json",
      "**/secrets.json",
      "**/*-secrets.json",
      "**/*.pem",
      "**/*.key",
      "**/*.pfx",
      "**/*.p12",
      "**/id_rsa",
      "**/id_rsa.*",
      "**/id_ed25519",
      "**/id_ed25519.*",
      "**/agent/sessions/**",
      "**/.git/**",
    ],
    maxChangedFiles: 5_000,
    maxNewBlobBytes: 50 * 1024 * 1024,
    maxNewDataBytes: 250 * 1024 * 1024,
    maxObjectScanCount: 50_000,
  },
  repositoryOverrides: {},
};

function mergeObject<T extends Record<string, unknown>>(base: T, override?: Partial<T>): T {
  if (!override) return { ...base };
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = output[key];
    if (
      value &&
      current &&
      typeof value === "object" &&
      typeof current === "object" &&
      !Array.isArray(value) &&
      !Array.isArray(current)
    ) {
      output[key] = mergeObject(current as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      output[key] = value;
    }
  }
  return output as T;
}

export function normalizeConfig(raw?: Partial<GitBackupConfig>): GitBackupConfig {
  const merged = mergeObject(DEFAULT_CONFIG as unknown as Record<string, unknown>, raw as unknown as Record<string, unknown>) as unknown as GitBackupConfig;
  merged.schemaVersion = 1;
  merged.settleDebounceSeconds = Math.max(5, Number(merged.settleDebounceSeconds) || DEFAULT_CONFIG.settleDebounceSeconds);
  merged.startupCatchUpSeconds = Math.max(0, Number(merged.startupCatchUpSeconds) || 0);
  merged.remote.minIntervalMinutes = Math.max(0, Number(merged.remote.minIntervalMinutes) || 0);
  merged.remote.timeoutMs = Math.max(5_000, Number(merged.remote.timeoutMs) || DEFAULT_CONFIG.remote.timeoutMs);
  merged.security.maxChangedFiles = Math.max(1, Number(merged.security.maxChangedFiles) || DEFAULT_CONFIG.security.maxChangedFiles);
  merged.security.maxNewBlobBytes = Math.max(1, Number(merged.security.maxNewBlobBytes) || DEFAULT_CONFIG.security.maxNewBlobBytes);
  merged.security.maxNewDataBytes = Math.max(1, Number(merged.security.maxNewDataBytes) || DEFAULT_CONFIG.security.maxNewDataBytes);
  merged.security.maxObjectScanCount = Math.max(100, Number(merged.security.maxObjectScanCount) || DEFAULT_CONFIG.security.maxObjectScanCount);
  return merged;
}

function applyMonotonicProjectOverride(base: GitBackupConfig, local?: Partial<GitBackupConfig>): GitBackupConfig {
  if (!local) return base;
  const next = normalizeConfig(base);
  if (local.enabled === false) next.enabled = false;
  if (local.paused === true) next.paused = true;
  if (Number.isFinite(local.settleDebounceSeconds)) next.settleDebounceSeconds = Math.max(next.settleDebounceSeconds, Number(local.settleDebounceSeconds));
  if (Number.isFinite(local.startupCatchUpSeconds)) next.startupCatchUpSeconds = Math.max(next.startupCatchUpSeconds, Number(local.startupCatchUpSeconds));
  if (local.pushOnShutdown === false) next.pushOnShutdown = false;
  if (local.remote?.enabled === false || local.remote?.policy === "disabled") {
    next.remote.enabled = false;
    next.remote.policy = "disabled";
  }
  if (Number.isFinite(local.remote?.minIntervalMinutes)) {
    next.remote.minIntervalMinutes = Math.max(next.remote.minIntervalMinutes, Number(local.remote?.minIntervalMinutes));
  }
  next.security.requireGitleaks = base.security.requireGitleaks;
  next.security.gitleaksCommand = base.security.gitleaksCommand;
  next.security.denyGlobs = [...new Set([...base.security.denyGlobs, ...(local.security?.denyGlobs ?? [])])];
  if (Number.isFinite(local.security?.maxChangedFiles)) next.security.maxChangedFiles = Math.min(base.security.maxChangedFiles, Math.max(1, Number(local.security?.maxChangedFiles)));
  if (Number.isFinite(local.security?.maxNewBlobBytes)) next.security.maxNewBlobBytes = Math.min(base.security.maxNewBlobBytes, Math.max(1, Number(local.security?.maxNewBlobBytes)));
  if (Number.isFinite(local.security?.maxNewDataBytes)) next.security.maxNewDataBytes = Math.min(base.security.maxNewDataBytes, Math.max(1, Number(local.security?.maxNewDataBytes)));
  if (Number.isFinite(local.security?.maxObjectScanCount)) next.security.maxObjectScanCount = Math.min(base.security.maxObjectScanCount, Math.max(100, Number(local.security?.maxObjectScanCount)));
  next.includeUntracked = base.includeUntracked;
  next.remote.name = base.remote.name;
  next.remote.branchPrefix = base.remote.branchPrefix;
  next.remote.timeoutMs = base.remote.timeoutMs;
  return next;
}

export function configForRepository(config: GitBackupConfig, repoRoot: string, localOverride?: Partial<GitBackupConfig>): GitBackupConfig {
  const normalizedRoot = normalizeRepoPath(repoRoot);
  const central = Object.entries(config.repositoryOverrides ?? {}).find(([path]) => normalizeRepoPath(path) === normalizedRoot)?.[1];
  const centrallyConfigured = normalizeConfig(mergeObject(config as unknown as Record<string, unknown>, central as unknown as Record<string, unknown>) as unknown as Partial<GitBackupConfig>);
  return applyMonotonicProjectOverride(centrallyConfigured, localOverride);
}

export function normalizeRepoPath(path: string): string {
  return resolve(path).replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

export function repoKey(repoRoot: string): string {
  return createHash("sha256").update(normalizeRepoPath(repoRoot)).digest("hex").slice(0, 16);
}

export function slugRefPart(value: string, fallback = "unknown"): string {
  const slug = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/\/{2,}/g, "/")
    .replace(/^[-./]+|[-./]+$/g, "")
    .slice(0, 120);
  return slug || fallback;
}

function globToRegex(pattern: string): RegExp {
  let normalized = pattern.replace(/\\/g, "/").toLowerCase();
  let prefix = "^";
  if (normalized.startsWith("**/")) {
    prefix = "^(?:.*/)?";
    normalized = normalized.slice(3);
  }
  let body = "";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === "*" && normalized[i + 1] === "*") {
      body += ".*";
      i += 1;
    } else if (char === "*") {
      body += "[^/]*";
    } else if (char === "?") {
      body += "[^/]";
    } else {
      body += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${prefix}${body}$`, "i");
}

export function pathMatchesDeny(path: string, patterns: string[]): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  return patterns.some((pattern) => globToRegex(pattern).test(normalized));
}

function resolveGitBinary(): string {
  if (platform() !== "win32") return "git";
  const candidates = [
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Git", "mingw64", "bin", "git.exe") : "",
    process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"]!, "Git", "mingw64", "bin", "git.exe") : "",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? "git";
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; maxBytes?: number },
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finish = (result: Omit<CommandResult, "stdout" | "stderr" | "timedOut">) => {
      if (settled) return;
      settled = true;
      resolveResult({ ...result, stdout, stderr, timedOut });
    };
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < maxBytes) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < maxBytes) stderr += chunk.toString();
    });
    child.on("error", (error) => finish({ code: null, error: error.message }));
    child.on("close", (code) => finish({ code }));
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, options.timeoutMs ?? 30_000);
    timeout.unref();
    child.on("close", () => clearTimeout(timeout));
    child.on("error", () => clearTimeout(timeout));
  });
}

const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
  GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
};

async function git(repoRoot: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<CommandResult> {
  return runCommand(resolveGitBinary(), args, { cwd: repoRoot, env: { ...GIT_ENV, ...env }, timeoutMs });
}

async function mustGit(repoRoot: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<string> {
  const result = await git(repoRoot, args, env, timeoutMs);
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.error || `git ${args[0]} exited ${result.code}`);
  return result.stdout.trim();
}

async function optionalRev(repoRoot: string, ref: string): Promise<string | undefined> {
  const result = await git(repoRoot, ["rev-parse", "--verify", ref]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

async function listRemoteHead(repoRoot: string, remote: string, remoteRef: string, timeoutMs: number): Promise<string | undefined> {
  const result = await git(repoRoot, ["ls-remote", "--heads", remote, remoteRef], undefined, timeoutMs);
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.error || `git ls-remote exited ${result.code}`);
  const line = result.stdout.trim().split(/\r?\n/).find(Boolean);
  return line?.split(/\s+/)[0];
}

async function isAncestor(repoRoot: string, older: string, newer: string): Promise<boolean> {
  const result = await git(repoRoot, ["merge-base", "--is-ancestor", older, newer]);
  return result.code === 0;
}

async function safeUntrackedPaths(repoRoot: string, includeUntracked: boolean): Promise<string[]> {
  if (!includeUntracked) return [];
  return (await mustGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
}

async function snapshotPathAllowlist(repoRoot: string, includeUntracked: boolean): Promise<string[]> {
  const tracked = (await mustGit(repoRoot, ["ls-files", "-z"])).split("\0").filter(Boolean);
  const untracked = await safeUntrackedPaths(repoRoot, includeUntracked);
  return [...new Set([...tracked, ...untracked])].sort();
}

async function preflightCandidatePaths(repoRoot: string, parent: string | undefined, includeUntracked: boolean): Promise<string[]> {
  const trackedArgs = parent
    ? ["diff", "--name-only", "-z", "--no-renames", parent, "--"]
    : ["ls-files", "-z"];
  const tracked = (await mustGit(repoRoot, trackedArgs)).split("\0").filter(Boolean);
  const untracked = await safeUntrackedPaths(repoRoot, includeUntracked);
  return [...new Set([...tracked, ...untracked])].sort();
}

async function stageAllowedPaths(repoRoot: string, candidateEnv: NodeJS.ProcessEnv, allowedPaths: string[]): Promise<void> {
  if (allowedPaths.length === 0) return;
  const result = await runCommand(
    resolveGitBinary(),
    ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
    {
      cwd: repoRoot,
      env: { ...GIT_ENV, ...candidateEnv, GIT_LITERAL_PATHSPECS: "1" },
      input: `${allowedPaths.join("\0")}\0`,
      timeoutMs: 120_000,
    },
  );
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.error || `git add exited ${result.code}`);
}

async function changedPathsAgainst(repoRoot: string, indexEnv: NodeJS.ProcessEnv, parent?: string): Promise<string[]> {
  const args = parent
    ? ["diff", "--cached", "--name-only", "-z", "--no-renames", parent]
    : ["ls-files", "-z"];
  const output = await mustGit(repoRoot, args, indexEnv);
  return output.split("\0").map((item) => item.trim()).filter(Boolean);
}

async function embeddedRepoPaths(repoRoot: string, indexEnv: NodeJS.ProcessEnv, changed: Set<string>): Promise<string[]> {
  const output = await mustGit(repoRoot, ["ls-files", "--stage", "-z"], indexEnv);
  const blocked: string[] = [];
  for (const record of output.split("\0")) {
    if (!record) continue;
    const match = record.match(/^(\d+)\s+[0-9a-f]+\s+\d+\t(.+)$/);
    if (match?.[1] === "160000" && changed.has(match[2])) blocked.push(match[2]);
  }
  return blocked;
}

async function inspectObjectBudget(repoRoot: string, commit: string, parent: string | undefined, maxObjects: number): Promise<ObjectBudget> {
  const args = ["rev-list", "--objects", commit];
  if (parent) args.push(`^${parent}`);
  const result = await git(repoRoot, args, undefined, 60_000);
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.error || "Could not enumerate snapshot objects");
  const hashes = result.stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/, 1)[0]).filter(Boolean);
  if (hashes.length > maxObjects) throw new Error(`Snapshot introduces ${hashes.length} objects; limit is ${maxObjects}`);
  if (hashes.length === 0) return { objectCount: 0, blobCount: 0, totalBlobBytes: 0, maxBlobBytes: 0 };
  const check = await runCommand(resolveGitBinary(), ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    cwd: repoRoot,
    env: GIT_ENV,
    input: `${hashes.join("\n")}\n`,
    timeoutMs: 60_000,
  });
  if (check.code !== 0) throw new Error(check.stderr.trim() || check.error || "Could not inspect snapshot object sizes");
  let blobCount = 0;
  let totalBlobBytes = 0;
  let maxBlobBytes = 0;
  for (const line of check.stdout.split(/\r?\n/)) {
    const [, type, sizeText] = line.trim().split(/\s+/);
    if (type !== "blob") continue;
    const size = Number(sizeText) || 0;
    blobCount += 1;
    totalBlobBytes += size;
    maxBlobBytes = Math.max(maxBlobBytes, size);
  }
  return { objectCount: hashes.length, blobCount, totalBlobBytes, maxBlobBytes };
}

async function runGitleaks(repoRoot: string, commit: string, parent: string | undefined, config: GitBackupConfig, reportPath: string): Promise<{ ok: boolean; unavailable: boolean; error?: string }> {
  if (!config.security.requireGitleaks) return { ok: true, unavailable: false };
  const logOpts = parent ? `${parent}..${commit}` : commit;
  const result = await runCommand(
    config.security.gitleaksCommand,
    [
      "git",
      "--no-banner",
      "--redact=100",
      "--report-format", "json",
      "--report-path", reportPath,
      "--log-opts", logOpts,
      repoRoot,
    ],
    { cwd: repoRoot, env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 120_000 },
  );
  if (result.code === 0) return { ok: true, unavailable: false };
  if (result.code === 1) return { ok: false, unavailable: false, error: "Gitleaks detected one or more potential secrets (details redacted)." };
  return { ok: false, unavailable: true, error: result.stderr.trim().split(/\r?\n/)[0] || result.error || `gitleaks exited ${result.code}` };
}

async function readProjectOverride(repoRoot: string): Promise<Partial<GitBackupConfig> | undefined> {
  const path = join(repoRoot, ".pi", "git-backup.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8")) as Partial<GitBackupConfig>;
  } catch (error) {
    throw new Error(`Invalid project backup config at ${path}: ${(error as Error).message}`);
  }
}

export async function effectiveConfigForRepository(repoRoot: string, globalConfig: GitBackupConfig): Promise<GitBackupConfig> {
  return configForRepository(globalConfig, repoRoot, await readProjectOverride(repoRoot));
}

export async function findRepository(cwd: string): Promise<string | undefined> {
  const result = await git(resolve(cwd), ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) return undefined;
  return resolve(result.stdout.trim());
}

export async function verifyRemoteRef(
  repoRoot: string,
  remoteName: string,
  remoteRef: string,
  expectedCommit: string | undefined,
  timeoutMs = 45_000,
): Promise<{ status: "verified" | "missing" | "mismatch" | "unavailable"; remoteCommit?: string; error?: string }> {
  try {
    const remoteExists = await git(repoRoot, ["remote", "get-url", remoteName]);
    if (remoteExists.code !== 0) return { status: "unavailable", error: "approved remote is not configured" };
    const remoteCommit = await listRemoteHead(repoRoot, remoteName, remoteRef, timeoutMs);
    if (!remoteCommit) return { status: "missing" };
    if (expectedCommit && remoteCommit === expectedCommit) return { status: "verified", remoteCommit };
    return { status: "mismatch", remoteCommit };
  } catch (error) {
    return { status: "unavailable", error: (error as Error).message.split(/\r?\n/)[0] };
  }
}

export async function runGitBackup(cwd: string, options: BackupRunOptions): Promise<BackupRunResult> {
  const started = Date.now();
  let tempRoot: string | undefined;
  const finish = (result: Omit<BackupRunResult, "durationMs">): BackupRunResult => ({ ...result, durationMs: Date.now() - started });
  try {
    const repoRoot = await findRepository(cwd);
    if (!repoRoot) return finish({ ok: true, outcome: "not-a-repository", message: "Current directory is not inside a Git repository." });
    const config = await effectiveConfigForRepository(repoRoot, options.config);
    if (!config.enabled || config.paused) return finish({ ok: true, outcome: "disabled", repoRoot, message: "Git backup automation is disabled or paused for this repository." });

    await mkdir(options.runtimeDir, { recursive: true });
    tempRoot = await mkdtemp(join(options.runtimeDir, "tmp-"));
    const indexPath = join(tempRoot, "index");
    const reportPath = join(tempRoot, "gitleaks-report.json");
    const candidateRepo = join(tempRoot, "candidate.git");

    const head = await optionalRev(repoRoot, "HEAD");
    const branchRaw = (await git(repoRoot, ["branch", "--show-current"])).stdout.trim();
    const branch = slugRefPart(branchRaw || `detached-${(head ?? "unborn").slice(0, 12)}`, "detached");
    const machine = slugRefPart(hostname().toLowerCase(), "machine");
    const localRef = `refs/pi-backups/${machine}/${branch}`;
    const remoteRef = `refs/heads/${slugRefPart(config.remote.branchPrefix, "pi-backup")}/${machine}/${branch}`;

    const remoteConfigured = config.remote.enabled && config.remote.policy === "existing-origin-only"
      ? (await git(repoRoot, ["remote", "get-url", config.remote.name])).code === 0
      : false;
    let remoteTip: string | undefined;
    let localTip = await optionalRev(repoRoot, localRef);

    if (remoteConfigured) {
      remoteTip = await listRemoteHead(repoRoot, config.remote.name, remoteRef, config.remote.timeoutMs);
      if (remoteTip && !localTip) {
        await mustGit(repoRoot, ["fetch", "--no-tags", config.remote.name, `${remoteRef}:${localRef}`], undefined, config.remote.timeoutMs);
        localTip = await optionalRev(repoRoot, localRef);
      } else if (remoteTip && localTip && remoteTip !== localTip) {
        const remoteTrackingRef = `refs/pi-backup-remotes/${machine}/${branch}`;
        await mustGit(repoRoot, ["fetch", "--no-tags", config.remote.name, `${remoteRef}:${remoteTrackingRef}`], undefined, config.remote.timeoutMs);
        if (await isAncestor(repoRoot, localTip, remoteTip)) {
          await mustGit(repoRoot, ["update-ref", localRef, remoteTip, localTip]);
          localTip = remoteTip;
        } else if (!(await isAncestor(repoRoot, remoteTip, localTip))) {
          return finish({
            ok: false,
            outcome: "blocked",
            repoRoot,
            branch,
            localRef,
            remoteRef,
            remoteConfigured,
            securityScan: "skipped",
            message: "Local and remote backup refs diverged; refusing to force-push.",
            error: "backup-ref-divergence",
          });
        }
      }
    }

    let parent = localTip;
    if (!parent && remoteConfigured && branchRaw) {
      const sourceRef = `refs/heads/${branchRaw}`;
      const sourceTip = await listRemoteHead(repoRoot, config.remote.name, sourceRef, config.remote.timeoutMs);
      if (sourceTip) {
        const baselineRef = `refs/pi-backup-baselines/${machine}/${branch}-${sourceTip.slice(0, 12)}`;
        await mustGit(repoRoot, ["fetch", "--no-tags", config.remote.name, `${sourceRef}:${baselineRef}`], undefined, config.remote.timeoutMs);
        parent = sourceTip;
      }
    }
    if (!parent && !remoteConfigured) parent = head;

    const preflightPaths = await preflightCandidatePaths(repoRoot, parent, config.includeUntracked);
    const preflightDenied = preflightPaths.filter((path) => pathMatchesDeny(path, config.security.denyGlobs));
    if (preflightDenied.length > 0) {
      return finish({
        ok: false,
        outcome: "blocked",
        repoRoot,
        branch,
        localRef,
        remoteRef,
        changedFiles: preflightPaths.length,
        changedPaths: preflightPaths.slice(0, 100),
        blockedPaths: preflightDenied.slice(0, 100),
        remoteConfigured,
        securityScan: "skipped",
        message: `Backup blocked by protected paths (${preflightDenied.length}) before candidate objects were created.`,
        error: "protected-paths",
      });
    }
    if (preflightPaths.length > config.security.maxChangedFiles) {
      return finish({
        ok: false,
        outcome: "blocked",
        repoRoot,
        branch,
        localRef,
        remoteRef,
        changedFiles: preflightPaths.length,
        remoteConfigured,
        securityScan: "skipped",
        message: `Backup changes ${preflightPaths.length} files; safety limit is ${config.security.maxChangedFiles}.`,
        error: "changed-file-limit",
      });
    }

    const allowedPaths = await snapshotPathAllowlist(repoRoot, config.includeUntracked);
    await mustGit(repoRoot, ["init", "--bare", candidateRepo]);
    const objectPathRaw = await mustGit(repoRoot, ["rev-parse", "--git-path", "objects"]);
    const realObjectPath = (isAbsolute(objectPathRaw) ? objectPathRaw : resolve(repoRoot, objectPathRaw)).replace(/\\/g, "/");
    await mkdir(join(candidateRepo, "objects", "info"), { recursive: true });
    await writeFile(join(candidateRepo, "objects", "info", "alternates"), `${realObjectPath}\n`, "utf8");
    const candidateEnv: NodeJS.ProcessEnv = {
      GIT_DIR: candidateRepo,
      GIT_WORK_TREE: repoRoot,
      GIT_INDEX_FILE: indexPath,
    };
    if (head) await mustGit(repoRoot, ["read-tree", head], candidateEnv);
    else await mustGit(repoRoot, ["read-tree", "--empty"], candidateEnv);
    await stageAllowedPaths(repoRoot, candidateEnv, allowedPaths);
    const tree = await mustGit(repoRoot, ["write-tree"], candidateEnv);

    const changedPaths = await changedPathsAgainst(repoRoot, candidateEnv, parent);
    const changedSet = new Set(changedPaths);
    const denied = changedPaths.filter((path) => pathMatchesDeny(path, config.security.denyGlobs));
    const embedded = await embeddedRepoPaths(repoRoot, candidateEnv, changedSet);
    const blockedPaths = [...new Set([...denied, ...embedded])].sort();
    if (blockedPaths.length > 0) {
      return finish({
        ok: false,
        outcome: "blocked",
        repoRoot,
        branch,
        localRef,
        remoteRef,
        changedFiles: changedPaths.length,
        changedPaths: changedPaths.slice(0, 100),
        blockedPaths: blockedPaths.slice(0, 100),
        remoteConfigured,
        securityScan: "skipped",
        message: `Backup blocked by protected paths or embedded repositories (${blockedPaths.length}); candidate objects remained isolated in temporary storage.`,
        error: "protected-paths",
      });
    }
    if (changedPaths.length > config.security.maxChangedFiles) {
      return finish({
        ok: false,
        outcome: "blocked",
        repoRoot,
        branch,
        localRef,
        remoteRef,
        changedFiles: changedPaths.length,
        remoteConfigured,
        securityScan: "skipped",
        message: `Backup changes ${changedPaths.length} files; safety limit is ${config.security.maxChangedFiles}.`,
        error: "changed-file-limit",
      });
    }

    const parentTree = parent ? await optionalRev(repoRoot, `${parent}^{tree}`) : undefined;
    const needsInitialBackupRef = !localTip;
    if (parentTree === tree && !needsInitialBackupRef) {
      if (options.pushRemote && remoteConfigured && localTip && remoteTip !== localTip) {
        const push = await git(repoRoot, ["push", "--porcelain", config.remote.name, `${localRef}:${remoteRef}`], undefined, config.remote.timeoutMs);
        if (push.code !== 0) return finish({ ok: false, outcome: "failed", repoRoot, branch, localRef, remoteRef, commit: localTip, remoteConfigured, message: "Local snapshot exists, but remote push failed.", error: push.stderr.trim().split(/\r?\n/)[0] || push.error });
        const verified = await listRemoteHead(repoRoot, config.remote.name, remoteRef, config.remote.timeoutMs);
        if (verified !== localTip) return finish({ ok: false, outcome: "failed", repoRoot, branch, localRef, remoteRef, commit: localTip, remoteCommit: verified, remoteConfigured, message: "Remote push returned success but verification did not match.", error: "remote-verification-mismatch" });
        return finish({ ok: true, outcome: "remote-verified", repoRoot, branch, localRef, remoteRef, commit: localTip, remoteCommit: verified, remoteConfigured, remotePushed: true, securityScan: "passed", message: "Existing local snapshot was pushed and independently verified on the remote." });
      }
      return finish({ ok: true, outcome: "no-change", repoRoot, branch, localRef, remoteRef, commit: localTip, remoteCommit: remoteTip, remoteConfigured, remotePushed: false, securityScan: "skipped", message: "Snapshot tree is unchanged from the latest local backup." });
    }

    const timestamp = new Date().toISOString();
    const safeReason = options.reason.replace(/[\r\n]+/g, " ").trim().slice(0, 180) || "automated project checkpoint";
    const message = [
      `pi-backup: ${branch} ${timestamp}`,
      "",
      `Reason: ${safeReason}`,
      `Source-branch: ${branchRaw || "detached"}`,
      `Machine: ${machine}`,
      "Policy: isolated backup ref; working branch and index untouched",
    ].join("\n");
    const commitArgs = ["commit-tree", tree];
    if (parent) commitArgs.push("-p", parent);
    commitArgs.push("-F", "-");
    const identityEnv: NodeJS.ProcessEnv = {
      GIT_AUTHOR_NAME: "Pi Backup Automation",
      GIT_AUTHOR_EMAIL: "pi-backup@localhost",
      GIT_COMMITTER_NAME: "Pi Backup Automation",
      GIT_COMMITTER_EMAIL: "pi-backup@localhost",
    };
    const commitResult = await runCommand(resolveGitBinary(), commitArgs, {
      cwd: repoRoot,
      env: { ...GIT_ENV, ...candidateEnv, ...identityEnv },
      input: message,
      timeoutMs: 30_000,
    });
    if (commitResult.code !== 0) throw new Error(commitResult.stderr.trim() || commitResult.error || "git commit-tree failed");
    const commit = commitResult.stdout.trim();

    await mustGit(candidateRepo, ["update-ref", "refs/heads/candidate", commit]);
    const budget = await inspectObjectBudget(candidateRepo, commit, parent, config.security.maxObjectScanCount);
    if (budget.maxBlobBytes > config.security.maxNewBlobBytes || budget.totalBlobBytes > config.security.maxNewDataBytes) {
      return finish({
        ok: false,
        outcome: "blocked",
        repoRoot,
        branch,
        localRef,
        remoteRef,
        commit,
        changedFiles: changedPaths.length,
        remoteConfigured,
        securityScan: "skipped",
        message: `Backup exceeds object budget (${budget.totalBlobBytes} new blob bytes; largest ${budget.maxBlobBytes}).`,
        error: "object-size-limit",
      });
    }

    const scan = await runGitleaks(candidateRepo, commit, parent, config, reportPath);
    if (!scan.ok) {
      return finish({
        ok: false,
        outcome: "blocked",
        repoRoot,
        branch,
        localRef,
        remoteRef,
        commit,
        changedFiles: changedPaths.length,
        remoteConfigured,
        securityScan: scan.unavailable ? "unavailable" : "blocked",
        message: scan.unavailable ? "Backup blocked because the required secret scanner was unavailable." : "Backup blocked because the secret scanner detected potential credentials.",
        error: scan.error,
      });
    }

    const importResult = await git(repoRoot, ["fetch", "--no-tags", candidateRepo, `refs/heads/candidate:${localRef}`], undefined, 60_000);
    if (importResult.code !== 0) {
      return finish({
        ok: false,
        outcome: "failed",
        repoRoot,
        branch,
        localRef,
        remoteRef,
        commit,
        changedFiles: changedPaths.length,
        remoteConfigured,
        securityScan: config.security.requireGitleaks ? "passed" : "skipped",
        message: "Candidate passed all gates, but importing the isolated snapshot into the real repository failed.",
        error: importResult.stderr.trim().split(/\r?\n/)[0] || importResult.error || "candidate-import-failed",
      });
    }
    const importedTip = await optionalRev(repoRoot, localRef);
    if (importedTip !== commit) throw new Error("Imported local backup ref did not match the approved candidate commit");

    if (!options.pushRemote || !remoteConfigured) {
      return finish({
        ok: true,
        outcome: "local-snapshot",
        repoRoot,
        branch,
        localRef,
        remoteRef,
        commit,
        changedFiles: changedPaths.length,
        changedPaths: changedPaths.slice(0, 100),
        remoteConfigured,
        remotePushed: false,
        securityScan: config.security.requireGitleaks ? "passed" : "skipped",
        message: remoteConfigured ? "Created an isolated local snapshot; remote push is deferred." : "Created an isolated local snapshot; no approved existing remote is configured.",
      });
    }

    const push = await git(repoRoot, ["push", "--porcelain", config.remote.name, `${localRef}:${remoteRef}`], undefined, config.remote.timeoutMs);
    if (push.code !== 0) {
      return finish({
        ok: false,
        outcome: "failed",
        repoRoot,
        branch,
        localRef,
        remoteRef,
        commit,
        changedFiles: changedPaths.length,
        remoteConfigured,
        remotePushed: false,
        securityScan: config.security.requireGitleaks ? "passed" : "skipped",
        message: "Local snapshot succeeded, but remote push failed.",
        error: push.stderr.trim().split(/\r?\n/)[0] || push.error || `git push exited ${push.code}`,
      });
    }
    const verified = await listRemoteHead(repoRoot, config.remote.name, remoteRef, config.remote.timeoutMs);
    if (verified !== commit) {
      return finish({
        ok: false,
        outcome: "failed",
        repoRoot,
        branch,
        localRef,
        remoteRef,
        commit,
        remoteCommit: verified,
        changedFiles: changedPaths.length,
        remoteConfigured,
        remotePushed: true,
        securityScan: config.security.requireGitleaks ? "passed" : "skipped",
        message: "Remote push returned success but independent verification did not match.",
        error: "remote-verification-mismatch",
      });
    }
    return finish({
      ok: true,
      outcome: "remote-verified",
      repoRoot,
      branch,
      localRef,
      remoteRef,
      commit,
      remoteCommit: verified,
      changedFiles: changedPaths.length,
      changedPaths: changedPaths.slice(0, 100),
      remoteConfigured,
      remotePushed: true,
      securityScan: config.security.requireGitleaks ? "passed" : "skipped",
      message: "Created an isolated snapshot, pushed its backup branch, and independently verified the remote tip.",
    });
  } catch (error) {
    return finish({ ok: false, outcome: "failed", message: "Git backup failed before completion.", error: (error as Error).message.split(/\r?\n/)[0] });
  } finally {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  const { rename } = await import("node:fs/promises");
  try {
    await rename(temp, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM") throw error;
    await rm(path, { force: true });
    await rename(temp, path);
  }
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function runtimePaths(agentDir: string): { dir: string; config: string; state: string; log: string; locks: string; temp: string } {
  const dir = join(agentDir, "git-backup");
  return {
    dir,
    config: join(dir, "config.json"),
    state: join(dir, "state.json"),
    log: join(dir, "run-log.jsonl"),
    locks: join(dir, "locks"),
    temp: join(dir, "tmp"),
  };
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}
