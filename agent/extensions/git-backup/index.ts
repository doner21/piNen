import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { appendFile, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_CONFIG,
  type BackupRunResult,
  type GitBackupConfig,
  effectiveConfigForRepository,
  findRepository,
  normalizeConfig,
  readJson,
  repoKey,
  runGitBackup,
  runtimePaths,
  verifyRemoteRef,
  writeJsonAtomic,
} from "./core.ts";

interface RepositoryState {
  repoRoot: string;
  branch?: string;
  pending: boolean;
  pendingReasons: string[];
  lastAttemptAt?: string;
  lastOutcome?: string;
  lastError?: string;
  lastLocalSnapshotAt?: string;
  lastLocalCommit?: string;
  lastRemotePushAt?: string;
  lastRemoteCommit?: string;
  localRef?: string;
  remoteRef?: string;
  changedFiles?: number;
  securityScan?: string;
  blockedPaths?: string[];
}

interface GitBackupState {
  schemaVersion: number;
  repositories: Record<string, RepositoryState>;
}

const DEFAULT_STATE: GitBackupState = { schemaVersion: 1, repositories: {} };
const GitBackupParams = Type.Object({
  action: StringEnum(["status", "mark_needed", "run_now", "pause", "resume"] as const),
  reason: Type.Optional(Type.String({ description: "Reason for marking or running a backup." })),
  mode: Type.Optional(StringEnum(["local", "remote"] as const)),
});
type GitBackupParamsType = Static<typeof GitBackupParams>;

function paths() {
  return runtimePaths(getAgentDir());
}

async function ensureRuntimeFiles(): Promise<void> {
  const p = paths();
  await Promise.all([mkdir(p.dir, { recursive: true }), mkdir(p.locks, { recursive: true }), mkdir(p.temp, { recursive: true })]);
  if (!existsSync(p.config)) await writeJsonAtomic(p.config, DEFAULT_CONFIG);
  if (!existsSync(p.state)) await writeJsonAtomic(p.state, DEFAULT_STATE);
}

async function readConfig(): Promise<GitBackupConfig> {
  await ensureRuntimeFiles();
  return normalizeConfig(await readJson<Partial<GitBackupConfig>>(paths().config, DEFAULT_CONFIG));
}

async function updateConfig(mutator: (config: GitBackupConfig) => void): Promise<GitBackupConfig> {
  const config = await readConfig();
  mutator(config);
  const normalized = normalizeConfig(config);
  await writeJsonAtomic(paths().config, normalized);
  return normalized;
}

async function readState(): Promise<GitBackupState> {
  await ensureRuntimeFiles();
  const state = await readJson<GitBackupState>(paths().state, DEFAULT_STATE);
  if (!state.repositories || typeof state.repositories !== "object") state.repositories = {};
  state.schemaVersion = 1;
  return state;
}

let stateWriteQueue: Promise<void> = Promise.resolve();
async function updateState(mutator: (state: GitBackupState) => void): Promise<GitBackupState> {
  let output = DEFAULT_STATE;
  stateWriteQueue = stateWriteQueue.then(async () => {
    const state = await readState();
    mutator(state);
    output = state;
    await writeJsonAtomic(paths().state, state);
  });
  await stateWriteQueue;
  return output;
}

async function appendRunLog(result: BackupRunResult, reason: string): Promise<void> {
  const safe = {
    at: new Date().toISOString(),
    reason: reason.replace(/[\r\n]+/g, " ").slice(0, 200),
    ok: result.ok,
    outcome: result.outcome,
    repoRoot: result.repoRoot,
    branch: result.branch,
    localRef: result.localRef,
    remoteRef: result.remoteRef,
    commit: result.commit,
    remoteCommit: result.remoteCommit,
    changedFiles: result.changedFiles,
    securityScan: result.securityScan,
    remoteConfigured: result.remoteConfigured,
    remotePushed: result.remotePushed,
    blockedPaths: result.blockedPaths,
    message: result.message,
    error: result.error,
    durationMs: result.durationMs,
  };
  await appendFile(paths().log, `${JSON.stringify(safe)}\n`, "utf8");
}

async function acquireRepoLock(repoRoot: string): Promise<{ release: () => Promise<void> } | undefined> {
  const lockPath = join(paths().locks, `${repoKey(repoRoot)}.lock`);
  await mkdir(dirname(lockPath), { recursive: true });
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, repoRoot, acquiredAt: new Date().toISOString() }));
    await handle.close();
    return { release: () => rm(lockPath, { force: true }) };
  } catch {
    try {
      const info = await stat(lockPath);
      if (Date.now() - info.mtimeMs > 60 * 60 * 1000) {
        await rm(lockPath, { force: true });
        return acquireRepoLock(repoRoot);
      }
    } catch {
      return acquireRepoLock(repoRoot);
    }
    return undefined;
  }
}

function notify(ctx: ExtensionContext | undefined, text: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx?.hasUI) ctx.ui.notify(text, level);
}

function remoteDue(config: GitBackupConfig, repoState: RepositoryState | undefined, forceRemote: boolean): boolean {
  if (forceRemote) return true;
  if (!repoState?.lastRemotePushAt) return true;
  return Date.now() - Date.parse(repoState.lastRemotePushAt) >= config.remote.minIntervalMinutes * 60_000;
}

const activeRuns = new Map<string, Promise<BackupRunResult>>();
const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const remoteCatchupTimers = new Map<string, ReturnType<typeof setTimeout>>();
let lastKnownCwd: string | undefined;
const pendingReasonsByRepo = new Map<string, Set<string>>();

function reasonsForRepository(repoRoot: string): Set<string> {
  const key = repoKey(repoRoot);
  let reasons = pendingReasonsByRepo.get(key);
  if (!reasons) {
    reasons = new Set<string>();
    pendingReasonsByRepo.set(key, reasons);
  }
  return reasons;
}

async function performBackup(
  cwd: string,
  reason: string,
  options: { forceRemote?: boolean; localOnly?: boolean; ctx?: ExtensionContext } = {},
): Promise<BackupRunResult> {
  const repoRoot = await findRepository(cwd);
  if (!repoRoot) {
    return { ok: true, outcome: "not-a-repository", message: "Current directory is not inside a Git repository.", durationMs: 0 };
  }
  const existing = activeRuns.get(repoRoot);
  if (existing) return existing;
  const run: Promise<BackupRunResult> = (async (): Promise<BackupRunResult> => {
    const lock = await acquireRepoLock(repoRoot);
    if (!lock) {
      return { ok: false, outcome: "failed", repoRoot, message: "Another Git backup run already holds the repository lock.", error: "backup-lock-held", durationMs: 0 };
    }
    try {
      const [globalConfig, state] = await Promise.all([readConfig(), readState()]);
      const config = await effectiveConfigForRepository(repoRoot, globalConfig);
      const key = repoKey(repoRoot);
      const repoReasons = reasonsForRepository(repoRoot);
      const previous = state.repositories[key];
      const shouldPush = !options.localOnly && config.remote.enabled && remoteDue(config, previous, Boolean(options.forceRemote));
      const combinedReason = [...repoReasons, reason].filter(Boolean).join("; ").slice(0, 500);
      const result = await runGitBackup(repoRoot, {
        reason: combinedReason,
        runtimeDir: paths().temp,
        pushRemote: shouldPush,
        config: globalConfig,
      });
      await updateState((next) => {
        const key = repoKey(repoRoot);
        const current = next.repositories[key] ?? { repoRoot, pending: true, pendingReasons: [] };
        current.repoRoot = repoRoot;
        current.branch = result.branch ?? current.branch;
        current.lastAttemptAt = new Date().toISOString();
        current.lastOutcome = result.outcome;
        current.lastError = result.error;
        current.localRef = result.localRef ?? current.localRef;
        current.remoteRef = result.remoteRef ?? current.remoteRef;
        current.changedFiles = result.changedFiles;
        current.securityScan = result.securityScan;
        current.blockedPaths = result.blockedPaths;
        if (result.commit) {
          current.lastLocalCommit = result.commit;
          if (result.outcome === "local-snapshot" || result.outcome === "remote-verified") current.lastLocalSnapshotAt = new Date().toISOString();
        }
        if (result.outcome === "remote-verified" && result.remoteCommit === result.commit) {
          current.lastRemoteCommit = result.remoteCommit;
          current.lastRemotePushAt = new Date().toISOString();
          current.pending = false;
          current.pendingReasons = [];
        } else if (result.outcome === "no-change" && (!result.commit || result.commit === result.remoteCommit || !result.remoteConfigured)) {
          current.pending = false;
          current.pendingReasons = [];
        } else if (result.outcome === "not-a-repository" || result.outcome === "disabled") {
          current.pending = false;
          current.pendingReasons = [];
        } else {
          current.pending = true;
          current.pendingReasons = [...new Set([...current.pendingReasons, ...repoReasons, reason].filter(Boolean))].slice(-20);
        }
        next.repositories[key] = current;
      });
      await appendRunLog(result, combinedReason || reason).catch(() => undefined);
      if (result.outcome === "remote-verified") {
        repoReasons.clear();
        notify(options.ctx, `Git backup verified: ${result.remoteRef} @ ${result.commit?.slice(0, 12)}`, "info");
      } else if (result.outcome === "blocked" || result.outcome === "failed") {
        notify(options.ctx, `Git backup ${result.outcome}: ${result.message}${result.error ? ` (${result.error})` : ""}`, result.outcome === "blocked" ? "warning" : "error");
      }
      if (result.outcome === "local-snapshot" && result.remoteConfigured && !options.localOnly) {
        const intervalMs = config.remote.minIntervalMinutes * 60_000;
        const lastPushMs = previous?.lastRemotePushAt ? Date.parse(previous.lastRemotePushAt) : Date.now();
        const delay = Math.max(5_000, lastPushMs + intervalMs - Date.now());
        const key = repoKey(repoRoot);
        const existingCatchup = remoteCatchupTimers.get(key);
        if (existingCatchup) clearTimeout(existingCatchup);
        const catchup = setTimeout(() => {
          remoteCatchupTimers.delete(key);
          void performBackup(repoRoot, "remote catch-up after debounce", { forceRemote: true, ctx: options.ctx });
        }, delay);
        catchup.unref();
        remoteCatchupTimers.set(key, catchup);
      }
      return result;
    } finally {
      await lock.release().catch(() => undefined);
    }
  })();
  activeRuns.set(repoRoot, run);
  try {
    return await run;
  } finally {
    if (activeRuns.get(repoRoot) === run) activeRuns.delete(repoRoot);
  }
}

async function markPending(cwd: string, reason: string): Promise<string | undefined> {
  const repoRoot = await findRepository(cwd);
  if (!repoRoot) return undefined;
  reasonsForRepository(repoRoot).add(reason);
  await updateState((state) => {
    const key = repoKey(repoRoot);
    const current = state.repositories[key] ?? { repoRoot, pending: true, pendingReasons: [] };
    current.pending = true;
    current.pendingReasons = [...new Set([...current.pendingReasons, reason])].slice(-20);
    state.repositories[key] = current;
  });
  return repoRoot;
}

async function scheduleBackup(
  cwd: string,
  reason: string,
  ctx?: ExtensionContext,
  forceRemote = false,
  delaySeconds?: number,
): Promise<void> {
  lastKnownCwd = cwd;
  const repoRoot = await markPending(cwd, reason);
  if (!repoRoot) return;
  const globalConfig = await readConfig();
  const config = await effectiveConfigForRepository(repoRoot, globalConfig);
  if (!config.enabled || config.paused) return;
  const key = repoKey(repoRoot);
  const existing = settleTimers.get(key);
  if (existing) clearTimeout(existing);
  const delayMs = Math.max(0, (delaySeconds ?? (forceRemote ? 1 : config.settleDebounceSeconds)) * 1_000);
  const timer = setTimeout(() => {
    settleTimers.delete(key);
    void performBackup(repoRoot, reason, { forceRemote, ctx });
  }, delayMs);
  timer.unref();
  settleTimers.set(key, timer);
}

async function statusText(cwd: string): Promise<string> {
  const [globalConfig, state, repoRoot] = await Promise.all([readConfig(), readState(), findRepository(cwd)]);
  if (!repoRoot) {
    return [
      `enabled: ${globalConfig.enabled}`,
      `paused: ${globalConfig.paused}`,
      `remotePolicy: ${globalConfig.remote.policy}`,
      `repository: none`,
    ].join("\n");
  }
  const config = await effectiveConfigForRepository(repoRoot, globalConfig);
  const lines = [
    `enabled: ${config.enabled}`,
    `paused: ${config.paused}`,
    `remotePolicy: ${config.remote.policy}`,
    `remoteName: ${config.remote.name}`,
    `remoteMinIntervalMinutes: ${config.remote.minIntervalMinutes}`,
    `secretScannerRequired: ${config.security.requireGitleaks}`,
  ];
  const current = state.repositories[repoKey(repoRoot)];
  const liveRemote = current?.remoteRef
    ? await verifyRemoteRef(repoRoot, config.remote.name, current.remoteRef, current.lastRemoteCommit, config.remote.timeoutMs)
    : undefined;
  lines.push(`repository: ${repoRoot}`);
  lines.push(`pending: ${current?.pending ?? false}`);
  lines.push(`lastOutcome: ${current?.lastOutcome ?? "never"}`);
  lines.push(`lastLocalCommit: ${current?.lastLocalCommit ?? "none"}`);
  lines.push(`lastRecordedRemoteCommit: ${current?.lastRemoteCommit ?? "none"}`);
  lines.push(`lastRecordedRemotePushAt: ${current?.lastRemotePushAt ?? "never"}`);
  lines.push(`liveRemoteStatus: ${liveRemote?.status ?? "not-yet-configured"}`);
  lines.push(`liveRemoteCommit: ${liveRemote?.remoteCommit ?? "none"}`);
  lines.push(`localRef: ${current?.localRef ?? "not created"}`);
  lines.push(`remoteRef: ${current?.remoteRef ?? "not created"}`);
  lines.push(`securityScan: ${current?.securityScan ?? "never"}`);
  if (liveRemote?.error) lines.push(`liveRemoteError: ${liveRemote.error}`);
  if (current?.lastError) lines.push(`lastError: ${current.lastError}`);
  if (current?.blockedPaths?.length) lines.push(`blockedPaths: ${current.blockedPaths.join(", ")}`);
  return lines.join("\n");
}

export default function gitBackupExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    await ensureRuntimeFiles();
    lastKnownCwd = ctx.cwd;
    const [globalConfig, state] = await Promise.all([readConfig(), readState()]);
    notify(ctx, "Git backup automation loaded (isolated refs + secret scan + verified remote branches).", "info");
    if (globalConfig.enabled && !globalConfig.paused) {
      const pendingRoots = Object.values(state.repositories).filter((repo) => repo.pending).map((repo) => repo.repoRoot);
      const roots = [...new Set([ctx.cwd, ...pendingRoots])].slice(0, 20);
      for (let index = 0; index < roots.length; index += 1) {
        const repoRoot = await findRepository(roots[index]);
        if (!repoRoot) continue;
        const effective = await effectiveConfigForRepository(repoRoot, globalConfig);
        if (!effective.enabled || effective.paused) continue;
        await scheduleBackup(repoRoot, "startup catch-up", index === 0 ? ctx : undefined, false, effective.startupCatchUpSeconds + index * 5);
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    lastKnownCwd = ctx.cwd;
    if ((event as unknown as { isError?: boolean }).isError) return;
    const toolName = (event as unknown as { toolName?: string }).toolName;
    if (toolName === "write" || toolName === "edit" || toolName === "bash") {
      await markPending(ctx.cwd, `${toolName} completed successfully`);
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await scheduleBackup(ctx.cwd, "agent settled after project work", ctx);
  });

  pi.events.on("graphify:maintenance-complete", (data: unknown) => {
    const event = (data ?? {}) as { cwd?: string; ok?: boolean; mode?: string; reason?: string };
    const cwd = event.cwd ?? lastKnownCwd;
    if (!cwd) return;
    const reason = `Graphify ${event.mode ?? "maintenance"} completed${event.ok === false ? " with failure" : " successfully"}${event.reason ? `: ${event.reason}` : ""}`;
    void scheduleBackup(cwd, reason, undefined, event.ok !== false);
  });

  pi.on("before_agent_start", async (event) => {
    const cwd = event.systemPromptOptions?.cwd ?? lastKnownCwd ?? process.cwd();
    const [globalConfig, state, repoRoot] = await Promise.all([readConfig(), readState(), findRepository(cwd)]);
    if (!globalConfig.enabled) return;
    const config = repoRoot ? await effectiveConfigForRepository(repoRoot, globalConfig) : globalConfig;
    const current = repoRoot ? state.repositories[repoKey(repoRoot)] : undefined;
    const advisory = [
      "\n\n## Automated Git Backup Advisory",
      "Git safety uses isolated `refs/pi-backups/...` snapshots and dedicated remote `pi-backup/...` branches; it must not alter or push the working branch.",
      "A local snapshot is not a verified remote backup. Only report remote backup success when the recorded remote tip equals the local snapshot commit.",
      "Do not manually stage, commit, push, force-push, or create a remote for routine backup; use the git_backup tool and honor its secret/size/path gates.",
      `Backup automation: ${config.paused ? "paused" : "active"}; repository state: ${current?.lastOutcome ?? "not yet run"}${current?.pending ? "; backup pending" : ""}.`,
      current?.lastError ? `Last backup error: ${current.lastError}` : undefined,
    ].filter(Boolean).join("\n");
    return { systemPrompt: event.systemPrompt + advisory };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    for (const timer of settleTimers.values()) clearTimeout(timer);
    for (const timer of remoteCatchupTimers.values()) clearTimeout(timer);
    settleTimers.clear();
    remoteCatchupTimers.clear();
    const [globalConfig, state] = await Promise.all([readConfig(), readState()]);
    if (globalConfig.enabled && !globalConfig.paused) {
      const pendingRoots = Object.values(state.repositories).filter((repo) => repo.pending).map((repo) => repo.repoRoot);
      const roots = [...new Set([ctx.cwd, ...pendingRoots])].slice(0, 20);
      const currentRepoRoot = await findRepository(ctx.cwd);
      for (const root of roots) {
        if (!existsSync(root)) continue;
        const repoRoot = await findRepository(root);
        if (!repoRoot) continue;
        const effective = await effectiveConfigForRepository(repoRoot, globalConfig);
        if (!effective.enabled || effective.paused) continue;
        await performBackup(repoRoot, "session shutdown catch-up", { forceRemote: effective.pushOnShutdown, localOnly: !effective.pushOnShutdown, ctx: repoRoot === currentRepoRoot ? ctx : undefined });
      }
    }
  });

  pi.registerTool({
    name: "git_backup",
    label: "Git Backup",
    description: "Inspect or run safe Git backups using isolated refs, protected-path and size gates, gitleaks scanning, dedicated backup branches, and post-push remote verification.",
    promptSnippet: "Inspect, mark, or run isolated and verified Git backups",
    promptGuidelines: [
      "Use git_backup status before claiming project work is remotely backed up.",
      "Use git_backup mark_needed after meaningful project changes when an immediate run is not appropriate.",
      "Use git_backup run_now with mode remote only for the dedicated configured backup ref; never substitute a manual working-branch push.",
      "Treat git_backup local-snapshot as rollback protection, not as a verified off-machine backup.",
    ],
    parameters: GitBackupParams,
    async execute(_toolCallId, params: GitBackupParamsType, _signal, _onUpdate, ctx) {
      if (params.action === "status") return { content: [{ type: "text" as const, text: await statusText(ctx.cwd) }], details: {} };
      if (params.action === "pause") {
        await updateConfig((config) => { config.paused = true; });
        return { content: [{ type: "text" as const, text: "Git backup automation paused." }], details: {} };
      }
      if (params.action === "resume") {
        await updateConfig((config) => { config.paused = false; });
        await scheduleBackup(ctx.cwd, params.reason ?? "resume catch-up", ctx);
        return { content: [{ type: "text" as const, text: "Git backup automation resumed and catch-up scheduled." }], details: {} };
      }
      if (params.action === "mark_needed") {
        const reason = params.reason?.trim() || "Agent marked backup needed.";
        await scheduleBackup(ctx.cwd, reason, ctx);
        return { content: [{ type: "text" as const, text: `Backup marked needed and scheduled: ${reason}` }], details: {} };
      }
      const reason = params.reason?.trim() || "Manual git_backup run_now request.";
      const result = await performBackup(ctx.cwd, reason, { forceRemote: params.mode !== "local", localOnly: params.mode === "local", ctx });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
    },
  });

  pi.registerCommand("git-backup", {
    description: "Git backup controls: status, run, local, mark, pause, resume.",
    handler: async (args, ctx) => {
      const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const reason = rest.join(" ");
      if (command === "status") return notify(ctx, await statusText(ctx.cwd), "info");
      if (command === "pause") {
        await updateConfig((config) => { config.paused = true; });
        return notify(ctx, "Git backup automation paused.", "info");
      }
      if (command === "resume") {
        await updateConfig((config) => { config.paused = false; });
        await scheduleBackup(ctx.cwd, reason || "resume catch-up", ctx);
        return notify(ctx, "Git backup automation resumed and catch-up scheduled.", "info");
      }
      if (command === "mark") {
        await scheduleBackup(ctx.cwd, reason || "Human marked backup needed.", ctx);
        return notify(ctx, "Git backup marked needed and scheduled.", "info");
      }
      if (command === "run" || command === "local") {
        const result = await performBackup(ctx.cwd, reason || `/${command} request`, { forceRemote: command === "run", localOnly: command === "local", ctx });
        return notify(ctx, `${result.outcome}: ${result.message}`, result.ok ? "info" : "error");
      }
      notify(ctx, "Usage: /git-backup status|run|local|mark|pause|resume [reason]", "warning");
    },
  });
}

export { statusText };
