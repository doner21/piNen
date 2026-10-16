#!/usr/bin/env node
/** W/AK3: conservative default retention, settled-only compression, and tail-preserving phase-log caps. */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "tools", "prune-runs-state.cjs");
const DAY_MS = 24 * 60 * 60 * 1000;

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function setTreeMtime(target, date) {
  const entries = fs.readdirSync(target, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) setTreeMtime(child, date);
    fs.utimesSync(child, date, date);
  }
  fs.utimesSync(target, date, date);
}

function inventory(root) {
  const result = [];
  function walk(current, relative) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(absolute);
      if (entry.isDirectory()) {
        result.push({ path: `${name}/`, type: "directory", mtimeMs: Math.trunc(stat.mtimeMs) });
        walk(absolute, name);
      } else {
        result.push({
          path: name,
          type: entry.isSymbolicLink() ? "symlink" : "file",
          size: stat.size,
          mtimeMs: Math.trunc(stat.mtimeMs),
          sha256: entry.isFile() ? crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") : undefined,
        });
      }
    }
  }
  walk(root, "");
  return result;
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

function runFailure(root, expectedError, ...args) {
  const result = invoke(root, ...args);
  assert.notEqual(result.status, 0, "unsafe invocation must be rejected");
  assert.match(result.stderr, expectedError);
  return result;
}

function event(events, type, category) {
  return events.find((item) => item.type === type && (category === undefined || item.category === category));
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runs-state-prune-"));
assert.ok(path.resolve(fixtureRoot).startsWith(path.resolve(os.tmpdir())), "fixture must live under the OS temp directory");
try {
  const old = new Date(Date.now() - 8 * DAY_MS);
  const young = new Date(Date.now() - 1 * DAY_MS);
  const oldTail = "OLD-TERMINAL-TAIL!!!";
  const youngTail = "YOUNG-TERMINAL-TAIL!";
  assert.equal(Buffer.byteLength(oldTail), 20);
  assert.equal(Buffer.byteLength(youngTail), 20);

  // This whole directory is one candidate. Its phase log must not also be counted.
  write(path.join(fixtureRoot, "orc-orphan", "data.bin"), "12345");
  write(path.join(fixtureRoot, "orc-orphan", "nested", "note.txt"), "abc");
  write(path.join(fixtureRoot, "orc-orphan", "phase-overlap.log"), "1234567");
  setTreeMtime(path.join(fixtureRoot, "orc-orphan"), young);

  const deadHostRuntime = { hostInstanceId: "2147483646:1700000000000" };
  const settledAudit = { activeWorkers: [], detachedWorkers: [] };
  write(path.join(fixtureRoot, "orc-old-terminal", "supervision.json"), JSON.stringify({
    runId: "orc-old-terminal", status: "terminal", terminalOutcome: "pass", updatedAt: old.toISOString(),
    audit: settledAudit, runtime: deadHostRuntime,
  }));
  write(path.join(fixtureRoot, "orc-old-terminal", "state.json"), JSON.stringify({
    runId: "orc-old-terminal", phases: [{ status: "done" }],
  }));
  write(path.join(fixtureRoot, "orc-old-terminal", "phase-0-executor.log"), `discard-${"x".repeat(40)}${oldTail}`);
  write(path.join(fixtureRoot, "orc-old-terminal", "phase-0-executor.result.json"), "{\"status\":\"complete\"}");
  write(path.join(fixtureRoot, "orc-old-terminal", "checkpoint-0004-verifier.json"), "{\"outcome\":\"pass\"}");
  setTreeMtime(path.join(fixtureRoot, "orc-old-terminal"), old);

  // Old but nonterminal runs are never retained or capped.
  write(path.join(fixtureRoot, "orc-old-active", "supervision.json"), JSON.stringify({
    runId: "orc-old-active", status: "paused", updatedAt: old.toISOString(), audit: settledAudit, runtime: deadHostRuntime,
  }));
  write(path.join(fixtureRoot, "orc-old-active", "state.json"), JSON.stringify({
    runId: "orc-old-active", phases: [{ status: "done" }],
  }));
  write(path.join(fixtureRoot, "orc-old-active", "phase-0-executor.log"), `active-${"a".repeat(60)}`);
  setTreeMtime(path.join(fixtureRoot, "orc-old-active"), old);

  // The size cap applies as soon as a run is conclusively settled; it does not wait for age retention.
  write(path.join(fixtureRoot, "orc-young-terminal", "supervision.json"), JSON.stringify({
    runId: "orc-young-terminal", status: "cancelled", terminalOutcome: "cancelled", updatedAt: young.toISOString(),
    audit: settledAudit, runtime: deadHostRuntime,
  }));
  write(path.join(fixtureRoot, "orc-young-terminal", "state.json"), JSON.stringify({
    runId: "orc-young-terminal", phases: [{ status: "done" }],
  }));
  write(path.join(fixtureRoot, "orc-young-terminal", "phase-1-reviewer.log"), `discard-${"y".repeat(40)}${youngTail}`);
  write(path.join(fixtureRoot, "orc-young-terminal", "phase-1-reviewer.result.json"), "{\"status\":\"complete\"}");
  setTreeMtime(path.join(fixtureRoot, "orc-young-terminal"), young);

  write(path.join(fixtureRoot, "notes", "keep.txt"), "keep");
  setTreeMtime(path.join(fixtureRoot, "notes"), old);

  const before = inventory(fixtureRoot);
  const defaultDryRun = run(fixtureRoot);
  assert.deepEqual(inventory(fixtureRoot), before, "default mode must not mutate any directory, file, content, or mtime");
  const defaultConfiguration = event(defaultDryRun, "configuration");
  assert.equal(defaultConfiguration.type, "configuration");
  assert.equal(defaultConfiguration.mode, "dry-run");
  assert.equal(defaultConfiguration.root, path.resolve(fixtureRoot));
  assert.equal(defaultConfiguration.retentionDays, 7);
  assert.equal(defaultConfiguration.phaseLogMaxBytes, 20 * 1024 * 1024);
  assert.equal(typeof defaultConfiguration.cutoff, "string");
  assert.deepEqual(
    defaultDryRun.filter((item) => item.type === "candidate").map(({ category, bytes, relativePath }) => ({ category, bytes, relativePath })),
    [
      { category: "orphan-run-directory", bytes: 15, relativePath: "orc-orphan" },
      { category: "expired-phase-log", bytes: 68, relativePath: "orc-old-terminal/phase-0-executor.log" },
    ],
    "defaults inventory old settled logs but remain dry-run",
  );
  assert.deepEqual(event(defaultDryRun, "summary", "expired-phase-log"), {
    type: "summary", category: "expired-phase-log", count: 1, bytes: 68,
  });
  assert.deepEqual(event(defaultDryRun, "summary", "oversized-phase-log"), {
    type: "summary", category: "oversized-phase-log", count: 0, bytes: 0,
  });
  assert.equal(defaultDryRun.at(-1).type, "dry_run_complete");

  const retentionOnly = run(fixtureRoot, "--retention-days", "7", "--phase-log-max-bytes", "off");
  assert.deepEqual(
    retentionOnly.filter((item) => item.type === "candidate" && item.category !== "orphan-run-directory")
      .map(({ category, operation, relativePath }) => ({ category, operation, relativePath })),
    [{
      category: "expired-phase-log",
      operation: "compress",
      relativePath: "orc-old-terminal/phase-0-executor.log",
    }],
    "age retention can be enabled without a size cap",
  );

  const capOnly = run(fixtureRoot, "--retention-days", "off", "--phase-log-max-bytes", "20");
  assert.deepEqual(
    capOnly.filter((item) => item.type === "candidate" && item.category !== "orphan-run-directory")
      .map(({ category, operation, relativePath }) => ({ category, operation, relativePath })),
    [
      { category: "oversized-phase-log", operation: "trim-tail", relativePath: "orc-old-terminal/phase-0-executor.log" },
      { category: "oversized-phase-log", operation: "trim-tail", relativePath: "orc-young-terminal/phase-1-reviewer.log" },
    ],
    "the terminal log cap can be enabled without age retention",
  );
  assert.deepEqual(inventory(fixtureRoot), before, "all independently configured dry runs remain read-only");

  const configuredDryRun = run(fixtureRoot, "--retention-days", "7", "--phase-log-max-bytes", "20");
  assert.equal(event(configuredDryRun, "configuration").retentionDays, 7);
  assert.equal(event(configuredDryRun, "configuration").phaseLogMaxBytes, 20);
  const logCandidates = configuredDryRun.filter((item) => item.type === "candidate" && item.category !== "orphan-run-directory");
  assert.deepEqual(
    logCandidates.map(({ category, operation, retainedBytes, relativePath }) => ({ category, operation, retainedBytes, relativePath })),
    [
      {
        category: "expired-phase-log",
        operation: "compress-tail",
        retainedBytes: 20,
        relativePath: "orc-old-terminal/phase-0-executor.log",
      },
      {
        category: "oversized-phase-log",
        operation: "trim-tail",
        retainedBytes: 20,
        relativePath: "orc-young-terminal/phase-1-reviewer.log",
      },
    ],
  );
  assert.ok(!logCandidates.some((item) => item.relativePath.includes("orc-old-active")), "nonterminal runs must remain untouched");
  assert.deepEqual(inventory(fixtureRoot), before, "configured dry-run mode also makes no changes");

  const applied = run(fixtureRoot, "--retention-days", "7", "--phase-log-max-bytes", "20", "--apply");
  const mutationStart = applied.findIndex((item) => item.type === "mutation_start");
  assert.ok(mutationStart > 0);
  for (const item of applied) {
    if (item.type === "candidate" || item.type === "summary" || item.type === "orphan_inventory" || item.type === "plan_complete") {
      assert.ok(applied.indexOf(item) < mutationStart, `${item.type} must print before mutation starts`);
    }
  }

  assert.equal(
    fs.readFileSync(path.join(fixtureRoot, "orc-orphan", "nested", "note.txt"), "utf8"),
    "abc",
    "retention/capping apply must never delete or alter an orphan",
  );
  assert.ok(
    !applied.some((item) => item.type === "mutated" && item.category === "orphan-run-directory"),
    "ordinary apply must select only managed phase-log mutations",
  );
  const oldLog = path.join(fixtureRoot, "orc-old-terminal", "phase-0-executor.log");
  assert.equal(fs.existsSync(oldLog), false);
  assert.equal(
    zlib.gunzipSync(fs.readFileSync(`${oldLog}.gz`)).toString("utf8"),
    oldTail,
    "expired logs are compressed after retaining the configured byte tail",
  );
  assert.equal(
    fs.readFileSync(path.join(fixtureRoot, "orc-young-terminal", "phase-1-reviewer.log"), "utf8"),
    youngTail,
    "oversized terminal logs retain their byte tail",
  );
  assert.equal(fs.readFileSync(path.join(fixtureRoot, "orc-old-terminal", "phase-0-executor.result.json"), "utf8"), "{\"status\":\"complete\"}");
  assert.equal(fs.readFileSync(path.join(fixtureRoot, "orc-old-terminal", "checkpoint-0004-verifier.json"), "utf8"), "{\"outcome\":\"pass\"}");
  assert.equal(fs.readFileSync(path.join(fixtureRoot, "orc-old-active", "phase-0-executor.log"), "utf8"), `active-${"a".repeat(60)}`);
  assert.equal(fs.readFileSync(path.join(fixtureRoot, "notes", "keep.txt"), "utf8"), "keep");
  assert.equal(applied.at(-1).type, "apply_complete");

  // Missing supervision is inventory evidence only. No token can turn absence
  // of ownership and settlement evidence into deletion authority.
  const orphanPlan = run(fixtureRoot, "--delete-orphans");
  const orphanInventory = event(orphanPlan, "orphan_inventory");
  assert.equal(orphanInventory.count, 1);
  assert.equal(orphanInventory.deletionEligible, false);
  assert.equal(typeof orphanInventory.confirmationToken, "string");
  assert.match(orphanInventory.confirmationToken, /^sha256:[a-f0-9]{64}$/);
  assert.equal(orphanPlan.at(-1).type, "dry_run_complete");
  assert.ok(fs.existsSync(path.join(fixtureRoot, "orc-orphan")));

  runFailure(fixtureRoot, /missing supervision cannot authorize deletion/i, "--delete-orphans", "--apply");
  runFailure(
    fixtureRoot,
    /missing supervision cannot authorize deletion/i,
    "--delete-orphans",
    "--confirm-orphan-inventory",
    orphanInventory.confirmationToken,
    "--apply",
  );
  assert.ok(fs.existsSync(path.join(fixtureRoot, "orc-orphan")), "orphan inventory remains byte-preserved");
  assert.equal(fs.readFileSync(path.join(fixtureRoot, "orc-old-terminal", "phase-0-executor.result.json"), "utf8"), "{\"status\":\"complete\"}");
  assert.equal(fs.readFileSync(path.join(fixtureRoot, "orc-old-terminal", "checkpoint-0004-verifier.json"), "utf8"), "{\"outcome\":\"pass\"}");
  assert.equal(fs.readFileSync(path.join(fixtureRoot, "orc-old-active", "phase-0-executor.log"), "utf8"), `active-${"a".repeat(60)}`);
  assert.equal(fs.readFileSync(path.join(fixtureRoot, "notes", "keep.txt"), "utf8"), "keep");

  // Live stream capping is separately configurable and default-off.
  const piModules = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
  process.env.NODE_PATH = [piModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  Module._initPaths();
  const jiti = require(path.join(piModules, "jiti", "lib", "jiti.cjs"))(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
  const substrate = jiti(path.join(ROOT, "src", "substrate.ts"));
  const liveRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase-log-cap-"));
  try {
    const uncapped = path.join(liveRoot, "uncapped.log");
    delete process.env.PI_ORCHESTRATOR_PHASE_LOG_MAX_BYTES;
    substrate.appendSubagentPhaseLog(uncapped, "stdout", "u".repeat(80));
    assert.ok(fs.statSync(uncapped).size > 32, "stream cap stays off when not configured");

    const capped = path.join(liveRoot, "capped.log");
    process.env.PI_ORCHESTRATOR_PHASE_LOG_MAX_BYTES = "32";
    substrate.appendSubagentPhaseLog(capped, "stdout", "discard".repeat(12));
    substrate.appendSubagentPhaseLog(capped, "stderr", "LATEST-TAIL");
    const cappedBytes = fs.readFileSync(capped);
    assert.ok(cappedBytes.length <= 32, "configured stream cap bounds the file in bytes");
    assert.match(cappedBytes.toString("utf8"), /\[stderr\] LATEST-TAIL\n$/, "stream cap keeps the newest tail");
  } finally {
    delete process.env.PI_ORCHESTRATOR_PHASE_LOG_MAX_BYTES;
    fs.rmSync(liveRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }

  console.log("runs-state prune/retention regression: ok");
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
}
