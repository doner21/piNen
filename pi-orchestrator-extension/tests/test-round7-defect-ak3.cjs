#!/usr/bin/env node
/** AK3: conservative runs-state retention proves age, settlement, identity, and liveness before mutation. */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "tools", "prune-runs-state.cjs");
const DAY_MS = 24 * 60 * 60 * 1000;
const DEAD_PID = 0x7ffffffe;

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function setTreeMtime(target, date) {
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) setTreeMtime(child, date);
    fs.utimesSync(child, date, date);
  }
  fs.utimesSync(target, date, date);
}

function makeRun(root, runId, options = {}) {
  const run = path.join(root, runId);
  const oldIso = new Date(Date.now() - 10 * DAY_MS).toISOString();
  fs.mkdirSync(run, { recursive: true });
  if (!options.missingSupervision) {
    write(path.join(run, "supervision.json"), {
      schemaVersion: 1,
      runId,
      status: options.status ?? "terminal",
      terminalOutcome: options.terminalOutcome ?? "pass",
      createdAt: oldIso,
      updatedAt: oldIso,
      currentTaskId: options.currentTaskId,
      audit: {
        activeWorkers: options.activeWorkers ?? [],
        detachedWorkers: options.detachedWorkers ?? [],
      },
      runtime: options.noHost ? {} : { hostInstanceId: `${options.hostPid ?? DEAD_PID}:1700000000000` },
      ...(options.retirement ? { retirement: { code: "conclusively_orphaned_paused_run", reason: "fixture", retiredAt: oldIso, owningHostInstanceId: `${DEAD_PID}:1700000000000` } } : {}),
    });
  }
  if (!options.missingRunState) {
    write(path.join(run, "state.json"), {
      runId,
      phases: options.phases ?? [{ index: 0, name: "worker", status: "done" }],
    });
  }
  write(path.join(run, "phase-0-worker.log"), options.log ?? `old-log-${runId}`);
  write(path.join(run, "phase-0-worker.result.json"), { status: "complete", evidence: runId });
  write(path.join(run, "checkpoint-0002-executor.json"), { outcome: "settled", runId });
  setTreeMtime(run, options.mtime ?? new Date(Date.now() - 10 * DAY_MS));
  return run;
}

function invoke(root, ...args) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
}

function run(root, ...args) {
  const result = invoke(root, ...args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function hash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "round7-ak3-"));
assert.ok(path.resolve(fixtureRoot).startsWith(path.resolve(os.tmpdir())), "all AK3 mutation fixtures must use OS temp");
try {
  const eligible = makeRun(fixtureRoot, "orc-eligible");
  const terminalLabelOnly = makeRun(fixtureRoot, "orc-terminal-label-only", { missingRunState: true });
  const active = makeRun(fixtureRoot, "orc-age-only-active", { status: "paused", terminalOutcome: undefined });
  const live = makeRun(fixtureRoot, "orc-live", { hostPid: process.pid });
  const unknownOwner = makeRun(fixtureRoot, "orc-unknown-owner", { noHost: true });
  const ownershipMismatch = makeRun(fixtureRoot, "orc-ownership-mismatch");
  const mismatchedStateFile = path.join(ownershipMismatch, "state.json");
  const mismatchedStateMtime = fs.statSync(mismatchedStateFile).mtime;
  write(mismatchedStateFile, { runId: "orc-someone-else", phases: [{ status: "done" }] });
  fs.utimesSync(mismatchedStateFile, mismatchedStateMtime, mismatchedStateMtime);
  const retiredOnly = makeRun(fixtureRoot, "orc-retired-label-only", { retirement: true, missingRunState: true });
  const orphan = makeRun(fixtureRoot, "orc-missing-supervision", { missingSupervision: true });
  const collision = makeRun(fixtureRoot, "orc-archive-collision");
  write(path.join(collision, "phase-0-worker.log.gz"), "pre-existing-archive");
  setTreeMtime(collision, new Date(Date.now() - 10 * DAY_MS));

  // Ambiguous liveness is exercised with an injected read-only observation;
  // the CLI path above separately uses the current process for a conclusive live case.
  const pruneModule = require(SCRIPT);
  const ambiguousRoot = fs.mkdtempSync(path.join(os.tmpdir(), "round7-ak3-ambiguous-"));
  try {
    makeRun(ambiguousRoot, "orc-ambiguous");
    const ambiguousPlan = pruneModule.collectPlan(
      ambiguousRoot,
      pruneModule.parseArgs(["--root", ambiguousRoot]),
      Date.now(),
      { observeProcess: () => ({ status: "unknown", reason: "EPERM" }) },
    );
    assert.ok(ambiguousPlan.rejections.some((item) => item.code === "owning_host_liveness_unknown"));
    assert.equal(ambiguousPlan.candidates.some((item) => item.eligible), false);
  } finally {
    fs.rmSync(ambiguousRoot, { recursive: true, force: true });
  }

  const beforeEligibleResult = hash(path.join(eligible, "phase-0-worker.result.json"));
  const beforeEligibleCheckpoint = hash(path.join(eligible, "checkpoint-0002-executor.json"));
  const dry = run(fixtureRoot);
  const config = dry.find((item) => item.type === "configuration");
  assert.equal(config.mode, "dry-run", "ordinary invocation remains dry-run");
  assert.equal(config.retentionDays, 7, "the conservative age default is explicit");
  assert.equal(config.phaseLogMaxBytes, 20 * 1024 * 1024, "the conservative phase-log cap default is explicit");
  assert.equal(dry.at(-1).type, "dry_run_complete");
  assert.deepEqual(
    dry.filter((item) => item.type === "candidate" && item.eligible).map((item) => item.relativePath),
    ["orc-eligible/phase-0-worker.log"],
    "only old, terminal, settled, conclusively non-live evidence is eligible",
  );
  const rejectionCodes = new Set(dry.filter((item) => item.type === "rejected").map((item) => item.code));
  for (const code of [
    "missing_supervision", "settlement_evidence_missing", "run_not_terminal", "owning_host_live",
    "owning_host_identity_unknown", "ownership_mismatch", "existing_archive_collision",
  ]) assert.ok(rejectionCodes.has(code), `dry run exposes conservative rejection ${code}`);
  assert.ok(dry.some((item) => item.type === "rejected" && item.relativePath.startsWith("orc-retired-label-only")),
    "AK2 retirement metadata alone is not deletion or retention authority");

  const orphanApply = invoke(fixtureRoot, "--delete-orphans", "--apply");
  assert.notEqual(orphanApply.status, 0, "missing supervision can never authorize directory deletion");
  assert.match(orphanApply.stderr, /missing supervision.*cannot authorize deletion/i);
  assert.ok(fs.existsSync(orphan));

  const applied = run(fixtureRoot, "--apply");
  assert.equal(fs.existsSync(path.join(eligible, "phase-0-worker.log")), false);
  assert.equal(fs.existsSync(path.join(eligible, "phase-0-worker.log.gz")), true);
  assert.equal(hash(path.join(eligible, "phase-0-worker.result.json")), beforeEligibleResult, "result JSON is retained byte-identically");
  assert.equal(hash(path.join(eligible, "checkpoint-0002-executor.json")), beforeEligibleCheckpoint, "checkpoint JSON is retained byte-identically");
  assert.equal(fs.existsSync(path.join(terminalLabelOnly, "phase-0-worker.log")), true);
  assert.equal(fs.existsSync(path.join(active, "phase-0-worker.log")), true);
  assert.equal(fs.existsSync(path.join(live, "phase-0-worker.log")), true);
  assert.equal(fs.existsSync(path.join(unknownOwner, "phase-0-worker.log")), true);
  assert.equal(fs.existsSync(path.join(retiredOnly, "phase-0-worker.log")), true);
  assert.equal(fs.readFileSync(path.join(collision, "phase-0-worker.log.gz"), "utf8"), "pre-existing-archive");
  assert.ok(applied.some((item) => item.type === "mutated" && item.relativePath === "orc-eligible/phase-0-worker.log"));

  // Importable planning/apply seams permit deterministic race and liveness tests
  // without probing or mutating production state.
  const prune = pruneModule;
  assert.equal(prune.DEFAULT_RETENTION_DAYS, 7);
  assert.equal(prune.DEFAULT_PHASE_LOG_MAX_BYTES, 20 * 1024 * 1024);

  const raceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "round7-ak3-races-"));
  try {
    const racedRun = makeRun(raceRoot, "orc-file-race");
    const deadObserver = () => ({ status: "dead", evidence: "ESRCH" });
    const options = prune.parseArgs(["--root", raceRoot, "--apply"]);
    const plan = prune.collectPlan(raceRoot, options, Date.now(), { observeProcess: deadObserver });
    const racedLog = path.join(racedRun, "phase-0-worker.log");
    const snapshotMtime = fs.statSync(racedLog).mtime;
    fs.rmSync(racedLog);
    write(racedLog, "replacement-with-a-new-file-identity");
    fs.utimesSync(racedLog, snapshotMtime, snapshotMtime);
    assert.throws(
      () => prune.applyPlan(plan, options, { observeProcess: deadObserver }),
      /identity|changed|replacement/i,
      "replacement races are rejected immediately before mutation",
    );
    assert.equal(fs.existsSync(`${racedLog}.gz`), false);

    const stateRaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "round7-ak3-state-race-"));
    try {
      const stateRaceRun = makeRun(stateRaceRoot, "orc-state-race");
      const stateOptions = prune.parseArgs(["--root", stateRaceRoot, "--apply"]);
      const statePlan = prune.collectPlan(stateRaceRoot, stateOptions, Date.now(), { observeProcess: deadObserver });
      const supervisionFile = path.join(stateRaceRun, "supervision.json");
      const changed = JSON.parse(fs.readFileSync(supervisionFile, "utf8"));
      changed.audit.note = "changed after planning";
      write(supervisionFile, changed);
      assert.throws(
        () => prune.applyPlan(statePlan, stateOptions, { observeProcess: deadObserver }),
        /changed or replacement supervision/i,
        "supervision state is revalidated immediately before mutation",
      );
      assert.equal(fs.existsSync(path.join(stateRaceRun, "phase-0-worker.log.gz")), false);
    } finally {
      fs.rmSync(stateRaceRoot, { recursive: true, force: true });
    }

    const liveRaceRun = makeRun(raceRoot, "orc-liveness-race");
    const livePlan = prune.collectPlan(raceRoot, options, Date.now(), { observeProcess: deadObserver });
    assert.throws(
      () => prune.applyPlan(livePlan, options, { observeProcess: () => ({ status: "alive" }) }),
      /owning host.*live|liveness/i,
      "liveness is rechecked immediately before mutation",
    );
    assert.equal(fs.existsSync(path.join(liveRaceRun, "phase-0-worker.log")), true);

    const collisionRaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "round7-ak3-collision-"));
    try {
      const collisionRaceRun = makeRun(collisionRaceRoot, "orc-collision-race");
      const collisionOptions = prune.parseArgs(["--root", collisionRaceRoot, "--apply"]);
      const collisionPlan = prune.collectPlan(collisionRaceRoot, collisionOptions, Date.now(), { observeProcess: deadObserver });
      write(path.join(collisionRaceRun, "phase-0-worker.log.gz"), "racing archive");
      assert.throws(
        () => prune.applyPlan(collisionPlan, collisionOptions, { observeProcess: deadObserver }),
        /existing archive|collision/i,
      );
      assert.equal(fs.readFileSync(path.join(collisionRaceRun, "phase-0-worker.log.gz"), "utf8"), "racing archive");
      assert.equal(fs.existsSync(path.join(collisionRaceRun, "phase-0-worker.log")), true);
    } finally {
      fs.rmSync(collisionRaceRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(raceRoot, { recursive: true, force: true });
  }

  // Exercise the observed store order of magnitude using only empty OS-temp
  // directories. Inventory remains bounded to summary/rejection data and never mutates.
  const scaleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "round7-ak3-scale-"));
  try {
    for (let index = 0; index < 9_074; index += 1) {
      fs.mkdirSync(path.join(scaleRoot, `orc-scale-${String(index).padStart(4, "0")}`));
    }
    const scalePlan = require(SCRIPT).collectPlan(
      scaleRoot,
      require(SCRIPT).parseArgs(["--root", scaleRoot]),
      Date.now(),
      { observeProcess: () => { throw new Error("missing-supervision inventory must not probe processes"); } },
    );
    assert.equal(scalePlan.summaries.find((item) => item.category === "orphan-run-directory").count, 9_074);
    assert.equal(scalePlan.candidates.filter((item) => item.eligible).length, 0);
    assert.equal(fs.readdirSync(scaleRoot).length, 9_074);
  } finally {
    fs.rmSync(scaleRoot, { recursive: true, force: true });
  }

  // A symlink at a candidate path is never followed or retained. Some Windows
  // installations disallow unprivileged symlinks, in which case other identity
  // and replacement-race controls above remain mandatory.
  const symlinkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "round7-ak3-symlink-"));
  try {
    const symlinkRun = makeRun(symlinkRoot, "orc-symlink");
    const external = path.join(symlinkRoot, "outside.log");
    write(external, "outside");
    fs.rmSync(path.join(symlinkRun, "phase-0-worker.log"));
    try {
      fs.symlinkSync(external, path.join(symlinkRun, "phase-0-worker.log"), "file");
      const events = run(symlinkRoot);
      assert.ok(events.some((item) => item.type === "rejected" && item.code === "symlink_rejected"));
      assert.equal(fs.readFileSync(external, "utf8"), "outside");
    } catch (error) {
      if (!new Set(["EPERM", "EACCES", "ENOTSUP"]).has(error.code)) throw error;
    }
  } finally {
    fs.rmSync(symlinkRoot, { recursive: true, force: true });
  }

  console.log("test-round7-defect-ak3: 9,074-entry dry-run and conservative temp-only apply/race/liveness controls pass");
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
