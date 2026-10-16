#!/usr/bin/env node
/**
 * Conservatively retain runs-state phase logs.
 *
 * The command is always a dry run unless --apply is present. The default policy
 * compresses settled logs after seven days and caps settled logs at 20 MiB.
 * Checkpoints and *.result.json are never mutation targets. A terminal label is
 * not enough: supervision ownership, durable phase settlement, path identity,
 * and process absence must all be conclusive and are checked again immediately
 * before each mutation.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_PHASE_LOG_MAX_BYTES = 20 * 1024 * 1024;
const RUN_NAME = /^orc-[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PHASE_LOG_NAME = /^phase-.*\.log$/;
const PHASE_RESULT_NAME = /^phase-.*\.result\.json$/;
const SURVIVOR_NAME = /^survivor-.*\.json$/i;
const TERMINAL_STATUSES = new Set(["terminal", "cancelled"]);

function usage() {
  return [
    "Usage: node tools/prune-runs-state.cjs [--root PATH] [--retention-days DAYS|off] [--phase-log-max-bytes BYTES|off] [--apply]",
    "       node tools/prune-runs-state.cjs [--root PATH] --delete-orphans",
    "",
    `Dry-run is the default. Retention defaults: ${DEFAULT_RETENTION_DAYS} days and ${DEFAULT_PHASE_LOG_MAX_BYTES} bytes (20 MiB).`,
    "Use 'off' for either policy to disable it explicitly. Only immediate orc-* directories are inspected.",
    "Directory deletion is intentionally unavailable: missing supervision is inventory evidence, not deletion authority.",
  ].join("\n");
}

function parsePolicyNumber(value, option, integer) {
  if (value === "off") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isSafeInteger(parsed))) {
    throw new Error(`${option} must be ${integer ? "a non-negative safe integer" : "a non-negative number"} or off`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    root: path.resolve(__dirname, "..", "runs-state"),
    retentionDays: DEFAULT_RETENTION_DAYS,
    phaseLogMaxBytes: DEFAULT_PHASE_LOG_MAX_BYTES,
    deleteOrphans: false,
    orphanConfirmation: null,
    apply: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--delete-orphans") options.deleteOrphans = true;
    else if (argument === "--confirm-orphan-inventory") {
      const value = argv[++index];
      if (!value) throw new Error("--confirm-orphan-inventory requires a token");
      options.orphanConfirmation = value;
    } else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--root") {
      const value = argv[++index];
      if (!value) throw new Error("--root requires a path");
      options.root = path.resolve(value);
    } else if (argument === "--retention-days") {
      const value = argv[++index];
      if (value === undefined) throw new Error("--retention-days requires a number or off");
      options.retentionDays = parsePolicyNumber(value, "--retention-days", false);
    } else if (argument === "--phase-log-max-bytes") {
      const value = argv[++index];
      if (value === undefined) throw new Error("--phase-log-max-bytes requires a number or off");
      options.phaseLogMaxBytes = parsePolicyNumber(value, "--phase-log-max-bytes", true);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.orphanConfirmation !== null && !options.deleteOrphans) {
    throw new Error("--confirm-orphan-inventory requires --delete-orphans");
  }
  return options;
}

function observeProcess(pid) {
  try {
    process.kill(pid, 0);
    return { status: "alive" };
  } catch (error) {
    if (error && error.code === "ESRCH") return { status: "dead", evidence: "ESRCH" };
    return { status: "unknown", reason: error?.code || error?.message || String(error) };
  }
}

function identity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameIdentity(actual, expected, includeSize = true) {
  return actual.dev === expected.dev && actual.ino === expected.ino && actual.mode === expected.mode &&
    actual.ctimeMs === expected.ctimeMs && (!includeSize || (actual.size === expected.size && actual.mtimeMs === expected.mtimeMs));
}

// Directory timestamps legitimately change when an earlier candidate in the
// same run is retained. Device/inode/mode plus canonical realpath identify the
// directory object without mistaking our own prior mutation for replacement.
function sameDirectoryIdentity(actual, expected) {
  return actual.dev === expected.dev && actual.ino === expected.ino && actual.mode === expected.mode;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function snapshotRegularFile(file, label) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error(`${label} is a symlink`);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
  const bytes = fs.readFileSync(file);
  return { identity: identity(stat), sha256: sha256(bytes), bytes };
}

function parseJsonSnapshot(file, label) {
  const snapshot = snapshotRegularFile(file, label);
  let value;
  try {
    value = JSON.parse(snapshot.bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is malformed JSON`);
  }
  return { ...snapshot, value };
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function canonicalDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) throw new Error(`${label} is a symlink`);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory`);
  return { realPath: fs.realpathSync.native(directory), identity: identity(stat) };
}

function scanTree(directory) {
  let bytes = 0;
  let latestMtimeMs = fs.lstatSync(directory).mtimeMs;
  let symlink;
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const stat = fs.lstatSync(absolute);
    latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs);
    if (stat.isSymbolicLink()) {
      symlink ??= absolute;
      continue;
    }
    if (stat.isDirectory()) {
      const nested = scanTree(absolute);
      bytes += nested.bytes;
      latestMtimeMs = Math.max(latestMtimeMs, nested.latestMtimeMs);
      symlink ??= nested.symlink;
    } else if (stat.isFile()) bytes += stat.size;
  }
  return { bytes, latestMtimeMs, symlink };
}

function relativeForOutput(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function parseHostInstanceId(value) {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) return undefined;
  const pid = Number(match[1]);
  const startedAt = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff || !Number.isFinite(startedAt) || startedAt <= 0) return undefined;
  return { pid, startedAt };
}

function rejection(relativePath, code, reason) {
  return { type: "rejected", category: "run-retention", eligible: false, relativePath, code, reason };
}

function assessRun(runDirectory, runId, observe, root) {
  const relativePath = relativeForOutput(root, runDirectory);
  const names = fs.readdirSync(runDirectory).sort((a, b) => a.localeCompare(b));
  if (names.some((name) => SURVIVOR_NAME.test(name))) {
    return { rejection: rejection(relativePath, "survivor_present", "A survivor artifact is present.") };
  }
  const tree = scanTree(runDirectory);
  if (tree.symlink) {
    return { rejection: rejection(relativeForOutput(root, tree.symlink), "symlink_rejected", "Symlinks are never followed or retained.") };
  }

  let supervision;
  try {
    supervision = parseJsonSnapshot(path.join(runDirectory, "supervision.json"), "supervision.json");
  } catch (error) {
    const code = !fs.existsSync(path.join(runDirectory, "supervision.json")) ? "missing_supervision" : "supervision_inaccessible";
    return { tree, rejection: rejection(relativePath, code, error.message) };
  }
  const state = supervision.value;
  if (!state || typeof state !== "object" || state.runId !== runId) {
    return { tree, rejection: rejection(relativePath, "ownership_mismatch", "supervision.json does not own this exact run directory.") };
  }
  if (!TERMINAL_STATUSES.has(state.status)) {
    return { tree, rejection: rejection(relativePath, "run_not_terminal", `Run status ${String(state.status)} is not terminal.`) };
  }
  if (state.currentTaskId) {
    return { tree, rejection: rejection(relativePath, "worker_settlement_ambiguous", "A current task remains recorded.") };
  }
  if (!state.audit || !Array.isArray(state.audit.activeWorkers) || !Array.isArray(state.audit.detachedWorkers)) {
    return { tree, rejection: rejection(relativePath, "settlement_evidence_missing", "Supervision audit settlement evidence is missing.") };
  }
  if (state.audit.activeWorkers.length || state.audit.detachedWorkers.length) {
    return { tree, rejection: rejection(relativePath, "worker_or_survivor_present", "Supervision still records an active or detached worker.") };
  }

  const host = parseHostInstanceId(state.runtime?.hostInstanceId);
  if (!host) {
    return { tree, rejection: rejection(relativePath, "owning_host_identity_unknown", "Owning host generation identity is missing or invalid.") };
  }
  const hostObservation = observe(host.pid);
  if (hostObservation?.status === "alive") {
    return { tree, rejection: rejection(relativePath, "owning_host_live", `Owning host PID ${host.pid} is live.`) };
  }
  if (hostObservation?.status !== "dead" || hostObservation.evidence !== "ESRCH") {
    return { tree, rejection: rejection(relativePath, "owning_host_liveness_unknown", `Owning host PID ${host.pid} is not conclusively absent.`) };
  }

  let runState;
  try {
    runState = parseJsonSnapshot(path.join(runDirectory, "state.json"), "state.json");
  } catch (error) {
    return { tree, rejection: rejection(relativePath, "settlement_evidence_missing", error.message) };
  }
  if (!runState.value || typeof runState.value !== "object" || runState.value.runId !== runId) {
    return { tree, rejection: rejection(relativePath, "ownership_mismatch", "state.json does not own this exact run directory.") };
  }
  if (!Array.isArray(runState.value.phases) || runState.value.phases.length === 0 ||
      runState.value.phases.some((phase) => !phase || typeof phase !== "object" || phase.status !== "done")) {
    return { tree, rejection: rejection(relativePath, "settlement_evidence_missing", "Every recorded phase must have durable done status.") };
  }

  const workerPids = [];
  for (const name of names.filter((candidate) => PHASE_RESULT_NAME.test(candidate))) {
    let sidecar;
    try {
      sidecar = parseJsonSnapshot(path.join(runDirectory, name), name);
    } catch (error) {
      return { tree, rejection: rejection(relativeForOutput(root, path.join(runDirectory, name)), "settlement_evidence_missing", error.message) };
    }
    if (!sidecar.value || typeof sidecar.value !== "object" || sidecar.value.status !== "complete") {
      return { tree, rejection: rejection(relativeForOutput(root, path.join(runDirectory, name)), "worker_settlement_ambiguous", `${name} is not complete.`) };
    }
    if (sidecar.value.pid !== undefined) workerPids.push(sidecar.value.pid);
  }
  for (const pid of workerPids) {
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) {
      return { tree, rejection: rejection(relativePath, "worker_identity_unknown", "A phase result contains an invalid worker PID.") };
    }
    const observation = observe(pid);
    if (observation?.status === "alive") {
      return { tree, rejection: rejection(relativePath, "worker_live", `Worker PID ${pid} is live.`) };
    }
    if (observation?.status !== "dead" || observation.evidence !== "ESRCH") {
      return { tree, rejection: rejection(relativePath, "worker_liveness_unknown", `Worker PID ${pid} is not conclusively absent.`) };
    }
  }

  const updatedAtMs = Date.parse(state.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return { tree, rejection: rejection(relativePath, "run_age_unknown", "supervision.updatedAt is missing or invalid.") };
  }
  return { tree, supervision, runState, state, updatedAtMs };
}

function snapshotRunDirectory(root, runDirectory) {
  const rootSnapshot = canonicalDirectory(root, "runs root");
  const runSnapshot = canonicalDirectory(runDirectory, "run directory");
  if (!isInside(rootSnapshot.realPath, runSnapshot.realPath)) throw new Error("run path escapes the canonical runs root");
  return { rootSnapshot, runSnapshot };
}

function collectPlan(root, options, nowMs = Date.now(), dependencies = {}) {
  const observe = dependencies.observeProcess ?? observeProcess;
  const resolvedRoot = path.resolve(root);
  const rootSnapshot = canonicalDirectory(resolvedRoot, "runs root");
  const cutoffMs = options.retentionDays === null ? null : nowMs - options.retentionDays * DAY_MS;
  const orphanRuns = [];
  const expiredLogs = [];
  const oversizedLogs = [];
  const rejections = [];
  const entries = fs.readdirSync(resolvedRoot, { withFileTypes: true })
    .filter((entry) => RUN_NAME.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const runDirectory = path.join(resolvedRoot, entry.name);
    const entryStat = fs.lstatSync(runDirectory);
    if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) {
      rejections.push(rejection(entry.name, "symlink_rejected", "Run entries must be real immediate directories."));
      continue;
    }
    const pathSnapshot = snapshotRunDirectory(resolvedRoot, runDirectory);
    let assessment;
    try {
      assessment = assessRun(runDirectory, entry.name, observe, resolvedRoot);
    } catch (error) {
      rejections.push(rejection(entry.name, "run_inaccessible", error.message));
      continue;
    }
    if (assessment.rejection?.code === "missing_supervision") {
      const tree = assessment.tree ?? scanTree(runDirectory);
      orphanRuns.push({
        type: "candidate", category: "orphan-run-directory", operation: "inventory-only",
        eligible: false, bytes: tree.bytes, relativePath: entry.name, absolutePath: runDirectory,
        snapshotTreeBytes: tree.bytes, snapshotLatestMtimeMs: tree.latestMtimeMs,
      });
      rejections.push(assessment.rejection);
      continue;
    }
    if (assessment.rejection) {
      rejections.push(assessment.rejection);
      continue;
    }

    for (const child of fs.readdirSync(runDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!PHASE_LOG_NAME.test(child.name)) continue;
      const absolute = path.join(runDirectory, child.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        rejections.push(rejection(relativeForOutput(resolvedRoot, absolute), "symlink_rejected", "Phase-log candidates must be regular files."));
        continue;
      }
      const expired = cutoffMs !== null && Math.max(assessment.updatedAtMs, stat.mtimeMs) < cutoffMs;
      const overCap = options.phaseLogMaxBytes !== null && stat.size > options.phaseLogMaxBytes;
      if (!expired && !overCap) continue;
      const compressedPath = `${absolute}.gz`;
      if (expired && fs.existsSync(compressedPath)) {
        rejections.push(rejection(relativeForOutput(resolvedRoot, absolute), "existing_archive_collision", "The target .gz archive already exists."));
        continue;
      }
      const fileSnapshot = snapshotRegularFile(absolute, child.name);
      const common = {
        type: "candidate", eligible: true, bytes: stat.size,
        retainedBytes: overCap ? options.phaseLogMaxBytes : stat.size,
        relativePath: relativeForOutput(resolvedRoot, absolute), absolutePath: absolute,
        runDirectory, runId: entry.name, terminalStatus: assessment.state.status,
        snapshotRoot: rootSnapshot, snapshotRun: pathSnapshot.runSnapshot,
        snapshotSupervision: { identity: assessment.supervision.identity, sha256: assessment.supervision.sha256 },
        snapshotRunState: { identity: assessment.runState.identity, sha256: assessment.runState.sha256 },
        snapshotLog: { identity: fileSnapshot.identity, sha256: fileSnapshot.sha256 },
      };
      if (expired) expiredLogs.push({ ...common, category: "expired-phase-log", operation: overCap ? "compress-tail" : "compress", compressedPath });
      else oversizedLogs.push({ ...common, category: "oversized-phase-log", operation: "trim-tail" });
    }
  }

  const candidates = [...orphanRuns, ...expiredLogs, ...oversizedLogs];
  const summaries = [
    summary("orphan-run-directory", orphanRuns),
    summary("expired-phase-log", expiredLogs),
    summary("oversized-phase-log", oversizedLogs),
    summary("rejected", rejections),
    summary("total", candidates),
  ];
  return { root: resolvedRoot, rootSnapshot, cutoffMs, candidates, rejections, summaries, orphanConfirmationToken: buildOrphanConfirmationToken(resolvedRoot, orphanRuns) };
}

function buildOrphanConfirmationToken(root, candidates) {
  const inventory = {
    root: path.resolve(root),
    candidates: candidates.map((candidate) => ({
      relativePath: candidate.relativePath,
      bytes: candidate.bytes,
      latestMtimeMs: candidate.snapshotLatestMtimeMs,
    })),
  };
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(inventory)).digest("hex")}`;
}

function summary(category, items) {
  return { type: "summary", category, count: items.length, bytes: items.reduce((total, item) => total + (item.bytes ?? 0), 0) };
}

function publicEvent(item) {
  const printable = { ...item };
  for (const key of [
    "absolutePath", "compressedPath", "runDirectory", "snapshotTreeBytes", "snapshotLatestMtimeMs",
    "snapshotRoot", "snapshotRun", "snapshotSupervision", "snapshotRunState", "snapshotLog", "terminalStatus",
  ]) delete printable[key];
  return printable;
}

function encodeEvents(events) {
  return `${events.map((item) => JSON.stringify(publicEvent(item))).join("\n")}\n`;
}

function assertSnapshotFile(file, expected, label) {
  const current = snapshotRegularFile(file, label);
  if (!sameIdentity(current.identity, expected.identity) || current.sha256 !== expected.sha256) {
    throw new Error(`Refusing changed or replacement ${label}`);
  }
  return current;
}

function verifyUnchanged(candidate, cutoffMs, dependencies = {}) {
  const observe = dependencies.observeProcess ?? observeProcess;
  const currentRoot = canonicalDirectory(path.dirname(candidate.runDirectory), "runs root");
  if (currentRoot.realPath !== candidate.snapshotRoot.realPath || !sameDirectoryIdentity(currentRoot.identity, candidate.snapshotRoot.identity)) {
    throw new Error(`Refusing changed runs-root identity for ${candidate.relativePath}`);
  }
  const currentRun = canonicalDirectory(candidate.runDirectory, "run directory");
  if (currentRun.realPath !== candidate.snapshotRun.realPath || !sameDirectoryIdentity(currentRun.identity, candidate.snapshotRun.identity)) {
    throw new Error(`Refusing changed run-directory identity for ${candidate.relativePath}`);
  }
  if (!isInside(currentRoot.realPath, currentRun.realPath) || path.dirname(candidate.absolutePath) !== candidate.runDirectory) {
    throw new Error(`Refusing escaped candidate path ${candidate.relativePath}`);
  }
  assertSnapshotFile(path.join(candidate.runDirectory, "supervision.json"), candidate.snapshotSupervision, "supervision.json");
  assertSnapshotFile(path.join(candidate.runDirectory, "state.json"), candidate.snapshotRunState, "state.json");
  const log = assertSnapshotFile(candidate.absolutePath, candidate.snapshotLog, candidate.relativePath);
  const assessment = assessRun(candidate.runDirectory, candidate.runId, observe, path.dirname(candidate.runDirectory));
  if (assessment.rejection) throw new Error(`Refusing ${candidate.relativePath}: ${assessment.rejection.reason}`);
  if (assessment.state.status !== candidate.terminalStatus) throw new Error(`Refusing changed terminal state for ${candidate.relativePath}`);
  const expired = cutoffMs !== null && Math.max(assessment.updatedAtMs, log.identity.mtimeMs) < cutoffMs;
  const overCap = candidate.retainedBytes < log.identity.size;
  if ((candidate.category === "expired-phase-log" && !expired) || (candidate.category === "oversized-phase-log" && (expired || !overCap))) {
    throw new Error(`Refusing changed age or size eligibility for ${candidate.relativePath}`);
  }
  if (candidate.category === "expired-phase-log" && fs.existsSync(candidate.compressedPath)) {
    throw new Error(`Refusing existing archive collision for ${candidate.relativePath}.gz`);
  }
}

function tailBuffer(buffer, maxBytes) {
  if (buffer.length <= maxBytes) return buffer;
  if (maxBytes === 0) return Buffer.alloc(0);
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start);
}

function sameFdIdentity(descriptor, expected) {
  return sameIdentity(identity(fs.fstatSync(descriptor)), expected);
}

function writeArchiveExclusive(file, contents) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    const archiveIdentity = identity(fs.fstatSync(descriptor));
    fs.closeSync(descriptor);
    descriptor = undefined;
    return archiveIdentity;
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`Refusing existing archive collision: ${file}`);
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function applyCandidate(candidate, cutoffMs, dependencies = {}) {
  verifyUnchanged(candidate, cutoffMs, dependencies);
  let descriptor;
  try {
    descriptor = fs.openSync(candidate.absolutePath, candidate.category === "expired-phase-log" ? "r" : "r+");
    if (!sameFdIdentity(descriptor, candidate.snapshotLog.identity)) throw new Error(`Refusing replacement file identity for ${candidate.relativePath}`);
    const original = fs.readFileSync(descriptor);
    if (sha256(original) !== candidate.snapshotLog.sha256) throw new Error(`Refusing changed file content for ${candidate.relativePath}`);
    const retained = tailBuffer(original, candidate.retainedBytes);

    if (candidate.category === "expired-phase-log") {
      const compressed = zlib.gzipSync(retained, { level: zlib.constants.Z_BEST_COMPRESSION });
      const archiveIdentity = writeArchiveExclusive(candidate.compressedPath, compressed);
      try {
        // The state/liveness fence is repeated after archive creation and before
        // source removal. The just-created archive is the sole permitted change.
        if (!sameFdIdentity(descriptor, candidate.snapshotLog.identity)) throw new Error(`Refusing replacement file identity for ${candidate.relativePath}`);
        assertSnapshotFile(path.join(candidate.runDirectory, "supervision.json"), candidate.snapshotSupervision, "supervision.json");
        assertSnapshotFile(path.join(candidate.runDirectory, "state.json"), candidate.snapshotRunState, "state.json");
        const observe = dependencies.observeProcess ?? observeProcess;
        const assessment = assessRun(candidate.runDirectory, candidate.runId, observe, path.dirname(candidate.runDirectory));
        if (assessment.rejection) throw new Error(`Refusing ${candidate.relativePath}: ${assessment.rejection.reason}`);
        const archiveStat = fs.lstatSync(candidate.compressedPath);
        if (!sameIdentity(identity(archiveStat), archiveIdentity)) throw new Error(`Refusing archive replacement race for ${candidate.relativePath}.gz`);
        // Re-resolve the source path after every other fence so unlink can never
        // target a path swapped after the descriptor was opened.
        assertSnapshotFile(candidate.absolutePath, candidate.snapshotLog, candidate.relativePath);
        fs.unlinkSync(candidate.absolutePath);
      } catch (error) {
        try {
          const archiveStat = fs.lstatSync(candidate.compressedPath);
          if (sameIdentity(identity(archiveStat), archiveIdentity)) fs.unlinkSync(candidate.compressedPath);
        } catch {}
        throw error;
      }
      return { afterBytes: compressed.length };
    }

    fs.writeSync(descriptor, retained, 0, retained.length, 0);
    fs.ftruncateSync(descriptor, retained.length);
    fs.fsyncSync(descriptor);
    return { afterBytes: retained.length };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function selectMutationCandidates(plan, options) {
  if (options.deleteOrphans) return [];
  return plan.candidates.filter((candidate) => candidate.eligible && candidate.category !== "orphan-run-directory");
}

function authorizeOrphanDeletion(options) {
  if (options.deleteOrphans && options.apply) {
    throw new Error("Missing supervision cannot authorize deletion; orphan directories are inventory-only.");
  }
}

function applyPlan(plan, options, dependencies = {}, onMutation = () => {}) {
  authorizeOrphanDeletion(options);
  const selected = selectMutationCandidates(plan, options);
  let mutatedCount = 0;
  let reclaimedBytes = 0;
  for (const candidate of selected) {
    const { afterBytes } = applyCandidate(candidate, plan.cutoffMs, dependencies);
    mutatedCount += 1;
    reclaimedBytes += Math.max(0, candidate.bytes - afterBytes);
    onMutation({
      type: "mutated", category: candidate.category, operation: candidate.operation,
      bytesBefore: candidate.bytes, bytesAfter: afterBytes, relativePath: candidate.relativePath,
    });
  }
  return { mutatedCount, reclaimedBytes };
}

function writeEvent(item) {
  fs.writeSync(process.stdout.fd, encodeEvents([item]));
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const plan = collectPlan(options.root, options);
  const mutationCandidates = selectMutationCandidates(plan, options);
  const orphanSummary = plan.summaries.find((item) => item.category === "orphan-run-directory");
  const events = [
    {
      type: "configuration", mode: options.apply ? "apply" : "dry-run", root: options.root,
      retentionDays: options.retentionDays, phaseLogMaxBytes: options.phaseLogMaxBytes,
      cutoff: plan.cutoffMs === null ? null : new Date(plan.cutoffMs).toISOString(),
    },
    ...plan.candidates,
    ...plan.rejections,
    ...plan.summaries,
    {
      type: "orphan_inventory", count: orphanSummary.count, bytes: orphanSummary.bytes,
      confirmationToken: plan.orphanConfirmationToken, deletionEligible: false,
    },
    { type: "plan_complete", candidateCount: plan.candidates.length, mutationCandidateCount: mutationCandidates.length },
  ];
  fs.writeSync(process.stdout.fd, encodeEvents(events));
  if (!options.apply) {
    writeEvent({ type: "dry_run_complete", mutatedCount: 0, reclaimedBytes: 0 });
    return;
  }
  authorizeOrphanDeletion(options);
  writeEvent({ type: "mutation_start", candidateCount: mutationCandidates.length });
  const result = applyPlan(plan, options, {}, writeEvent);
  writeEvent({ type: "apply_complete", ...result });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`runs-state prune failed: ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  DEFAULT_PHASE_LOG_MAX_BYTES,
  parseArgs,
  collectPlan,
  applyPlan,
  verifyUnchanged,
  tailBuffer,
  main,
};
