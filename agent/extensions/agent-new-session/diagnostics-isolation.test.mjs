import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveCanonicalNewSessionDiagnosticsPath,
  writeDiagnostics,
} from "./diagnostics.ts";

const here = dirname(fileURLToPath(import.meta.url));
const piRoot = resolve(here, "../../..");
const originalPiHome = process.env.PI_HOME;
const originalCwd = process.cwd();
const root = await mkdtemp(join(tmpdir(), "agent-new-session-diag-isolation-"));
const isolatedPiHome = join(root, "pi-home");
const relativePiHome = relative(homedir(), isolatedPiHome);
const projectA = join(root, "projects", "alpha", "repo-a");
const projectB = join(root, "other-worktrees", "beta", "repo-b");
const canonicalPath = join(isolatedPiHome, "agent", "agent-new-session-diagnostics.json");

const executeEntries = (start, count, cwd) => Array.from({ length: count }, (_, i) => ({
  ts: start + i,
  phase: "polling",
  executeCommandAvailable: true,
  cwd,
  coalesced: false,
}));
const tickLog = (start, count) => Array.from({ length: count }, (_, i) => ({
  ts: start + i,
  isIdle: true,
  hasPendingMessages: false,
  stableIdle: true,
  idleTicks: i + 1,
}));

try {
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });
  assert.equal(isAbsolute(relativePiHome), false, "test PI_HOME must exercise relative-path handling");
  process.env.PI_HOME = relativePiHome;

  assert.equal(resolveCanonicalNewSessionDiagnosticsPath(), canonicalPath);
  assert.equal(
    resolveCanonicalNewSessionDiagnosticsPath({}, join(root, "fake-user-home")),
    join(root, "fake-user-home", ".pi", "agent", "agent-new-session-diagnostics.json"),
    "default resolution must be OS user home + .pi",
  );
  assert.equal(
    resolveCanonicalNewSessionDiagnosticsPath({ PI_HOME: "." }, join(root, "fake-user-home")),
    join(root, "fake-user-home", "agent", "agent-new-session-diagnostics.json"),
    "dot PI_HOME must be anchored to user home, not process cwd",
  );

  process.chdir(projectA);
  await writeDiagnostics({
    requestId: "cwd-a",
    phase: "polling",
    attempts: 1,
    cwd: projectA,
    executeCommandAvailable: true,
    executeEntries: executeEntries(100, 15, projectA),
    tickLog: tickLog(100, 70),
  }, projectA);

  let diagnostics = JSON.parse(await readFile(canonicalPath, "utf8"));
  assert.equal(diagnostics.cwd, projectA, "cwd provenance must be retained");
  await assert.rejects(stat(join(projectA, "agent")), { code: "ENOENT" });
  await assert.rejects(stat(join(projectB, "agent")), { code: "ENOENT" });

  process.chdir(projectB);
  await writeDiagnostics({
    requestId: "cwd-b",
    phase: "done",
    attempts: 2,
    cwd: projectB,
    executeCommandAvailable: true,
    newSessionConfirmed: true,
    confirmedBy: "session_shutdown:new",
    executeEntries: executeEntries(200, 10, projectB),
    tickLog: tickLog(200, 20),
  }, projectB);

  diagnostics = JSON.parse(await readFile(canonicalPath, "utf8"));
  assert.equal(diagnostics.requestId, "cwd-b", "second cwd must merge into the canonical document");
  assert.equal(diagnostics.cwd, projectB, "latest cwd provenance must be retained");
  assert.equal(diagnostics.executeEntries.length, 20, "executeEntries cap must remain 20");
  assert.equal(diagnostics.tickLog.length, 80, "tickLog cap must remain 80");

  await writeDiagnostics({
    phase: "failed",
    cwd: projectB,
    executeCommandRejected: true,
    hardTimeout: true,
    timeout: true,
    error: "late failure must not dominate",
  }, projectB);

  diagnostics = JSON.parse(await readFile(canonicalPath, "utf8"));
  assert.equal(diagnostics.cwd, projectB, "failure-race merge must retain supplied cwd provenance");
  assert.equal(diagnostics.phase, "done");
  assert.equal(diagnostics.newSessionConfirmed, true);
  assert.equal(diagnostics.confirmedBy, "session_shutdown:new");
  assert.equal(diagnostics.executeCommandRejected, false);
  assert.equal(diagnostics.newSessionSilentlyFailed, false);
  assert.equal("hardTimeout" in diagnostics, false);
  assert.equal("timeout" in diagnostics, false);
  assert.equal("error" in diagnostics, false);

  const canonicalDirEntries = await readdir(dirname(canonicalPath));
  assert.deepEqual(canonicalDirEntries, ["agent-new-session-diagnostics.json"], "atomic temp files must not remain");
  assert.deepEqual(await readdir(projectA), [], "project A must remain untouched");
  assert.deepEqual(await readdir(projectB), [], "project B must remain untouched");

  const indexSource = await readFile(join(here, "index.ts"), "utf8");
  const helperSource = await readFile(join(here, "diagnostics.ts"), "utf8");
  const skillSource = await readFile(join(piRoot, "agent", "skills", "agent-new-session", "SKILL.md"), "utf8");
  const globalSource = await readFile(join(piRoot, "agent", "AGENTS.md"), "utf8");
  const activeGuidance = `${indexSource}\n${skillSource}\n${globalSource}`;

  assert.match(indexSource, /writeDiagnostics as writeCanonicalDiagnostics/,
    "index.ts must use the tested production writer");
  assert.doesNotMatch(helperSource, /process\.cwd\s*\(/,
    "storage helper must never fall back to process.cwd()");
  assert.doesNotMatch(helperSource, /resolve\s*\(\s*cwd\s*,\s*["']agent["']\s*\)/,
    "storage helper must never derive its directory from cwd");
  assert.doesNotMatch(activeGuidance, /(?:read|Check|written to|Diagnostics:)\s+`?agent\/agent-new-session-diagnostics\.json/i,
    "active guidance must not direct agents to a cwd-relative diagnostics path");
  assert.match(activeGuidance, /~\/\.pi\/agent\/agent-new-session-diagnostics\.json/,
    "active guidance must name the canonical default path");

  console.log(JSON.stringify({
    gatePipelineRunId: process.env.GATE_PIPELINE_RUN_ID ?? null,
    isolatedPiHome,
    configuredRelativePiHome: relativePiHome,
    processCwdTransitions: [projectA, projectB],
    projectCwds: [projectA, projectB],
    canonicalPath,
    canonicalOnly: true,
    projectAgentDirectoriesCreated: false,
    tempFilesRemaining: false,
    recordedCwd: diagnostics.cwd,
    executeEntriesCount: diagnostics.executeEntries.length,
    tickLogCount: diagnostics.tickLog.length,
    confirmationDominance: true,
    defaultUserHomeResolution: true,
    relativePiHomeAnchoredToUserHome: true,
    staticGuidanceAssertions: true,
    cleanup: "performed in finally",
  }));
} finally {
  process.chdir(originalCwd);
  if (originalPiHome === undefined) delete process.env.PI_HOME;
  else process.env.PI_HOME = originalPiHome;
  await rm(root, { recursive: true, force: true });
}
