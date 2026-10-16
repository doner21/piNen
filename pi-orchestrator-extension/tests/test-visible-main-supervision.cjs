#!/usr/bin/env node
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PI_NODE_MODULES = path.join(
  os.homedir(), "AppData", "Roaming", "npm", "node_modules",
  "@earendil-works", "pi-coding-agent", "node_modules",
);
process.env.NODE_PATH = [PI_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const createJiti = require(path.join(PI_NODE_MODULES, "jiti", "lib", "jiti.cjs"));
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false });
const supervision = jiti(path.join(PROJECT_ROOT, "src", "supervision.ts"));
const writeSet = jiti(path.join(PROJECT_ROOT, "src", "write-set.ts"));

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
}

function missionInput(root, overrides = {}) {
  const base = {
    originalTask: "Implement only the approved product behavior.",
    cwd: root,
    worktree: { root, realRoot: fs.realpathSync.native(root), branch: "main", baseline: "abc123" },
    paradigm: "plan-execute-verify",
    lane: "product",
    routes: [
      { role: "verifier", agentName: "reviewer", provider: "openai-codex", model: "gpt-5.5" },
      { role: "executor", agentName: "coder", provider: "openai-codex", model: "gpt-5.6-sol" },
    ],
    constraints: ["Do not expand scope."],
    nonGoals: ["Do not repair the orchestrator."],
    acceptanceCriteria: [
      { id: "AC-01", text: "Produce the product artifact.", required: true },
      { id: "AC-02", text: "Run its machine test.", required: true },
    ],
  };
  return { ...base, ...overrides };
}

function validTasks() {
  return [
    { id: "task-1", description: "Build", dependsOn: [], criteria: ["AC-01"], predictedWriteSet: ["src/a.ts"] },
    { id: "task-2", description: "Test", dependsOn: ["task-1"], criteria: ["AC-02"], predictedWriteSet: ["tests/a.cjs"] },
  ];
}

function testCanonicalMission() {
  const root = tempDir("supervision-mission");
  try {
    const first = supervision.createFrozenMission(missionInput(root));
    const reordered = supervision.createFrozenMission({
      ...missionInput(root),
      routes: [...missionInput(root).routes].reverse(),
    });
    assert.equal(first.missionHash, reordered.missionHash, "route input order is canonicalized");
    assert.equal(first.missionHash.length, 64);
    assert.ok(supervision.verifyFrozenMission(first));
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.acceptanceCriteria));

    for (const patch of [
      { originalTask: "changed task" },
      { paradigm: "other" },
      { lane: "orchestrator-maintenance" },
      { constraints: ["different"] },
      { nonGoals: ["different"] },
      { acceptanceCriteria: [{ id: "AC-01", text: "different", required: true }] },
      { worktree: { ...missionInput(root).worktree, branch: "other" } },
      { routes: [{ role: "executor", agentName: "coder", provider: "openai-codex", model: "gpt-5.5" }] },
    ]) {
      const changed = supervision.createFrozenMission(missionInput(root, patch));
      assert.notEqual(changed.missionHash, first.missionHash, `mission drift must affect hash: ${JSON.stringify(patch)}`);
    }
    const tampered = structuredClone(first);
    tampered.originalTask = "tampered";
    assert.equal(supervision.verifyFrozenMission(tampered), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCriterionPlanValidation() {
  const root = tempDir("supervision-plan");
  try {
    const mission = supervision.createFrozenMission(missionInput(root));
    assert.deepEqual(supervision.validateCriterionTaskPlan(validTasks(), mission, {
      allowedWriteSet: ["src/", "tests/"], cwd: root, approvedTaskIds: ["task-1", "task-2"],
    }), []);

    const hostile = [
      { id: "task-1", description: "Build", dependsOn: ["task-2"], criteria: [], predictedWriteSet: ["../escape.ts"] },
      { id: "task-2", description: "Invent", dependsOn: ["task-1"], criteria: ["AC-99"], predictedWriteSet: ["orchestrator.ts"] },
    ];
    const issues = supervision.validateCriterionTaskPlan(hostile, mission, {
      allowedWriteSet: ["src/"], cwd: root, approvedTaskIds: ["task-1"],
    });
    const codes = new Set(issues.map((issue) => issue.code));
    for (const code of ["criteria_less_task", "orphan_criterion", "uncovered_required_criterion", "unapproved_task", "scope_expansion", "dependency_cycle"]) {
      assert.ok(codes.has(code), `expected ${code}`);
    }

    const duplicated = validTasks();
    duplicated[1].dependsOn = ["task-1", "task-1"];
    assert.deepEqual(
      supervision.validateCriterionTaskPlan(duplicated, mission).filter((issue) => issue.code === "duplicate_dependency"),
      [{ code: "duplicate_dependency", message: "Task task-2 repeats dependency task-1.", taskId: "task-2" }],
      "a repeated dependency is rejected exactly once with a stable finding",
    );

    const longId = `task-${"x".repeat(10_000)}`;
    const reservedPlan = validTasks();
    reservedPlan[0].predictedWriteSet = ["NUL", "nested/cOm9.trace", "src/a.ts"];
    const reservedPlanIssues = supervision.validateCriterionTaskPlan(reservedPlan, mission, {
      allowedWriteSet: ["src/", "tests/"], cwd: root, approvedTaskIds: ["task-1", "task-2"],
    });
    if (process.platform === "win32") {
      assert.deepEqual(reservedPlanIssues, [], "planner-created device pseudo-paths cannot poison a Windows plan checkpoint");
    } else {
      assert.equal(reservedPlanIssues.filter((issue) => issue.code === "scope_expansion").length, 2,
        "the same spellings remain ordinary gated files off Windows");
    }

    const boundedHostile = [
      { id: "anchor", description: "Anchor", dependsOn: [], criteria: ["AC-01"] },
      { id: longId, description: "Hostile", dependsOn: ["anchor", "anchor", "anchor"], criteria: ["AC-02"] },
    ];
    const firstDuplicate = supervision.validateCriterionTaskPlan(boundedHostile, mission).find((issue) => issue.code === "duplicate_dependency");
    const secondDuplicate = supervision.validateCriterionTaskPlan(boundedHostile, mission).find((issue) => issue.code === "duplicate_dependency");
    assert.deepEqual(firstDuplicate, secondDuplicate, "duplicate finding is deterministic");
    assert.ok(JSON.stringify(firstDuplicate).length <= 300, "duplicate finding remains bounded under hostile identifiers");
    assert.equal(supervision.validateCriterionTaskPlan(boundedHostile, mission).filter((issue) => issue.code === "duplicate_dependency").length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testApprovalTokensAndTransitions() {
  const binding = { runId: "orc-test", missionHash: "a".repeat(64), checkpointId: "checkpoint-0001", action: "continue" };
  const issued = supervision.issueApprovalToken(binding, new Date("2026-08-29T00:00:00Z"), () => Buffer.alloc(32, 7));
  assert.ok(!issued.record.tokenHash.includes(issued.token), "only token hash is persisted");
  const consumed = supervision.consumeApprovalToken(issued.record, issued.token, binding, new Date("2026-08-29T00:01:00Z"));
  assert.ok(consumed.consumedAt);
  assert.throws(() => supervision.consumeApprovalToken(consumed, issued.token, binding), /stale|consumed/);
  assert.throws(() => supervision.consumeApprovalToken(issued.record, "wrong", binding), /invalid/);
  for (const patch of [
    { runId: "other" }, { missionHash: "b".repeat(64) }, { checkpointId: "checkpoint-0002" }, { action: "cancel" },
  ]) {
    assert.throws(() => supervision.consumeApprovalToken(issued.record, issued.token, { ...binding, ...patch }), /wrong .* binding/);
  }
  for (const action of ["run", "inspect", "continue", "pause", "cancel"]) {
    assert.equal(supervision.issueApprovalToken({ ...binding, action }).record.action, action, `${action} is a public token-binding action`);
  }
  assert.throws(() => supervision.issueApprovalToken({ ...binding, action: "verify" }), /public supervision action/);
  assert.throws(
    () => supervision.consumeApprovalToken({ ...issued.record, action: "verify" }, issued.token, { ...binding, action: "verify" }),
    /public supervision action/,
    "internal verification cannot be smuggled through a public approval token",
  );

  const root = tempDir("supervision-transition");
  try {
    const mission = supervision.createFrozenMission(missionInput(root));
    let state = supervision.createInitialSupervisionState({ runId: "orc-transition", mission, tasks: validTasks(), now: new Date("2026-08-29T00:00:00Z") });
    const actionsByStatus = {
      plan_checkpoint: ["inspect", "continue", "pause", "cancel"],
      awaiting_supervisor: ["inspect", "continue", "pause", "cancel"],
      executing: ["inspect", "pause", "cancel"],
      paused: ["inspect", "continue", "cancel"],
      blocked_infrastructure: ["inspect", "pause", "cancel"],
      cancelled: ["inspect"],
      verifying: ["inspect", "pause", "cancel"],
      terminal: ["inspect"],
    };
    for (const [status, expected] of Object.entries(actionsByStatus)) {
      assert.deepEqual(supervision.buildInspectionSnapshot({ ...state, status }).allowedNextActions, expected, `exact legal actions for ${status}`);
    }
    assert.equal(Object.values(actionsByStatus).flat().includes("verify"), false);

    state = supervision.transitionSupervisionState(state, "awaiting_supervisor");
    state = supervision.transitionSupervisionState(state, "executing");
    state = supervision.transitionSupervisionState(state, "awaiting_supervisor");
    state = supervision.transitionSupervisionState(state, "verifying");
    state = supervision.transitionSupervisionState(state, "terminal");
    assert.throws(() => supervision.transitionSupervisionState(state, "paused"), /Illegal supervision transition/);
    assert.equal(supervision.executorBoundaryDecision({ settled: false, elapsedMs: 24 * 60 * 60 * 1000 }), "continue_executor", "clock never terminates a coherent active executor");
    assert.equal(supervision.executorBoundaryDecision({ settled: true, elapsedMs: 1 }), "awaiting_supervisor");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testAtomicStoreRestartAndReadOnlyInspect() {
  const root = tempDir("supervision-store");
  const workspace = tempDir("supervision-store-workspace");
  try {
    const mission = supervision.createFrozenMission(missionInput(workspace));
    const initial = supervision.createInitialSupervisionState({ runId: "orc-store", mission, tasks: validTasks(), now: new Date("2026-08-29T01:00:00Z") });
    const store = new supervision.SupervisionStateStore("orc-store", root);
    store.create(initial);
    let state = store.appendCheckpoint(initial, {
      kind: "plan", createdAt: "2026-08-29T01:01:00.000Z", missionHash: mission.missionHash,
      criteria: ["AC-01", "AC-02"], effectChanges: [], outcome: "plan_ready",
    }, { fullPlan: validTasks() });
    const issued = supervision.issueApprovalToken({ runId: state.runId, missionHash: mission.missionHash, checkpointId: state.checkpoints[0].id, action: "continue" });
    state = { ...state, status: "awaiting_supervisor", currentApproval: issued.record };
    store.save(state);

    const beforeBytes = fs.readFileSync(store.stateFile);
    const beforeStat = fs.statSync(store.stateFile);
    const loaded = store.loadReadOnly();
    const snapshot = supervision.buildInspectionSnapshot(loaded, { now: new Date("2026-08-29T01:02:00Z") });
    snapshot.tests.push({ command: "mutate detached snapshot", outcome: "ignored" });
    assert.deepEqual(fs.readFileSync(store.stateFile), beforeBytes, "read-only load/inspection cannot rewrite state");
    assert.equal(fs.statSync(store.stateFile).mtimeMs, beforeStat.mtimeMs);
    assert.equal(store.loadReadOnly().audit.tests.length, 0, "inspection projection is detached");

    const paused = store.loadAfterRestart(new Date("2026-08-29T01:03:00Z"));
    assert.equal(paused.status, "paused");
    assert.ok(paused.currentApproval.invalidatedAt, "restart invalidates the pre-restart token");
    assert.match(paused.pauseReason, /fresh_visible_main_approval/);
    assert.equal(store.loadReadOnly().status, "paused");
    assert.equal(fs.readdirSync(path.dirname(store.stateFile)).some((name) => name.includes(".tmp-")), false, "atomic writes clean temporary siblings");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function testLanePolicy() {
  const root = tempDir("supervision-lane");
  const workspace = path.join(root, "workspace");
  const protectedRoot = path.join(workspace, "host-owned");
  fs.mkdirSync(protectedRoot, { recursive: true });
  const worktree = { root: workspace, realRoot: fs.realpathSync.native(workspace) };
  try {
    let violations = supervision.checkLanePaths({
      lane: "product", cwd: workspace, worktree,
      paths: ["host-owned/repair.ts", "../escape.txt", "src/unapproved.ts"],
      allowedWriteSet: ["src/approved.ts"], protectedRoots: [protectedRoot],
    });
    assert.deepEqual(new Set(violations.map((item) => item.code)), new Set(["protected_path", "path_escape", "out_of_scope_path"]));
    assert.deepEqual(supervision.checkLanePaths({
      lane: "orchestrator-maintenance", cwd: workspace, worktree, paths: ["host-owned/repair.ts"],
      allowedWriteSet: ["host-owned/"], protectedRoots: [protectedRoot],
    }), [], "explicit maintenance lane may enter the protected root when write scope grants it");
    const reservedEffects = [
      "CON", "prn.txt", "nested/AuX.log", "NUL",
      ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}${index % 2 ? ".log" : ""}`),
      ...Array.from({ length: 9 }, (_, index) => `ports/LpT${index + 1}.trace`),
    ];
    const reservedViolations = supervision.checkLanePaths({
      lane: "product", cwd: workspace, worktree, paths: reservedEffects,
      allowedWriteSet: ["src/approved.ts"], protectedRoots: [],
    });
    if (process.platform === "win32") {
      assert.deepEqual(reservedViolations, [], "Windows device pseudo-effects are ignored before lane and out-of-scope enforcement");
    } else {
      assert.equal(reservedViolations.length, reservedEffects.length,
        "reserved Windows spellings remain ordinary gated paths off Windows");
    }
    for (const nearMiss of ["CONSOLE", "PRNTER.txt", "AUXILIARY", "NULL", "COM0", "COM10.log", "LPT0", "LPT10.txt"]) {
      assert.equal(supervision.checkLanePaths({
        lane: "product", cwd: workspace, worktree, paths: [nearMiss],
        allowedWriteSet: ["src/approved.ts"], protectedRoots: [],
      })[0]?.code, "out_of_scope_path", `${nearMiss} remains an ordinary gated path`);
    }
    assert.equal(supervision.checkLanePaths({
      lane: "product", cwd: workspace, worktree, paths: ["ordinary.txt"],
      allowedWriteSet: ["src/approved.ts"], protectedRoots: [],
    })[0]?.code, "out_of_scope_path", "ordinary out-of-scope effects still gate");

    const outside = path.join(root, "outside");
    fs.mkdirSync(outside, { recursive: true });
    for (const candidate of ["../outside/owned.txt", "src/../approved.ts", path.join(outside, "owned.txt")]) {
      violations = supervision.checkLanePaths({
        lane: "product", cwd: workspace, worktree, paths: [candidate],
        allowedWriteSet: [candidate], protectedRoots: [],
      });
      assert.equal(violations[0]?.code, "path_escape", `explicit spelling cannot grant traversal/outside path: ${candidate}`);
    }
    assert.deepEqual(supervision.checkLanePaths({
      lane: "orchestrator-maintenance", cwd: workspace, worktree, paths: [path.join(outside, "maintenance.txt")],
      allowedWriteSet: [path.join(outside, "maintenance.txt")], protectedRoots: [],
    }), [], "maintenance may use an explicit canonical absolute grant");
    assert.equal(supervision.checkLanePaths({
      lane: "orchestrator-maintenance", cwd: workspace, worktree, paths: ["../outside/maintenance.txt"],
      allowedWriteSet: ["../outside/maintenance.txt"], protectedRoots: [],
    })[0]?.code, "path_escape", "maintenance also rejects lexical parent traversal");

    const link = path.join(workspace, "linked");
    let linkCreated = false;
    try {
      fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      linkCreated = true;
    } catch (error) {
      const unavailableOnWindows = process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP", "ENOSYS"].includes(error.code);
      if (!unavailableOnWindows) throw error;
      console.log(`skip - real junction fixture unavailable on Windows (${error.code})`);
    }
    if (linkCreated) {
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true, "hostile fixture is a real symlink or junction");
      violations = supervision.checkLanePaths({
        lane: "product", cwd: workspace, worktree, paths: ["linked/repair.ts"],
        allowedWriteSet: ["linked/"], protectedRoots: [],
      });
      assert.equal(violations[0]?.code, "path_escape", "a granted link prefix cannot escape the pinned real worktree");
      const escapedRelative = path.relative(path.resolve(outside), path.resolve(violations[0].resolvedPath));
      assert.ok(escapedRelative && !escapedRelative.startsWith("..") && !path.isAbsolute(escapedRelative), "violation records the real escaped target");
      assert.equal(supervision.checkLanePaths({
        lane: "product", cwd: workspace, worktree, paths: ["linked/repair.ts"],
        allowedWriteSet: ["linked/"], protectedRoots: [outside],
      })[0]?.code, "protected_path", "a real link cannot conceal a protected-root destination");

      violations = supervision.checkLanePaths({
        lane: "orchestrator-maintenance", cwd: workspace, worktree, paths: ["linked/repair.ts"],
        allowedWriteSet: ["linked/"], protectedRoots: [],
      });
      assert.equal(violations[0]?.code, "path_escape", "maintenance canonicalizes a link escape instead of trusting its alias spelling");
      assert.deepEqual(supervision.checkLanePaths({
        lane: "orchestrator-maintenance", cwd: workspace, worktree, paths: ["linked/repair.ts"],
        allowedWriteSet: ["linked/", `${outside.replace(/\\/g, "/")}/`], protectedRoots: [],
      }), [], "maintenance link crossing requires an explicit canonical destination grant");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testInfrastructureClassification() {
  const cases = [
    ["provider", { code: "HTTP_429", message: "provider rate limit" }],
    ["transport", new Error("websocket transport ECONNRESET")],
    ["checkpoint", new Error("checkpoint atomic write failed")],
    ["parser", new Error("invalid JSON parser result")],
    ["write_set", new Error("WRITE_SET_UNOBSERVABLE")],
    ["orchestrator", new Error("orchestrator spawn budget exhausted")],
  ];
  for (const [code, error] of cases) {
    const result = supervision.classifyInfrastructureFailure(error);
    assert.equal(result.infrastructure, true);
    assert.equal(result.code, code);
  }
  assert.equal(supervision.classifyInfrastructureFailure(new Error("Product assertion failed")).infrastructure, false);
}

function testBoundedContentEffects() {
  const root = tempDir("supervision-content");
  try {
    fs.writeFileSync(path.join(root, "already-dirty.txt"), "AAAA");
    fs.writeFileSync(path.join(root, "delete-me.txt"), "delete");
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "ignored.js"), "ignored");
    const before = writeSet.captureContentSignatureSnapshot(root);
    fs.writeFileSync(path.join(root, "already-dirty.txt"), "BBBB"); // same path, same size, different bytes
    fs.rmSync(path.join(root, "delete-me.txt"));
    fs.writeFileSync(path.join(root, "untracked-new.txt"), "new");
    const after = writeSet.captureContentSignatureSnapshot(root);
    const changes = writeSet.diffContentSignatureSnapshots(before, after);
    assert.deepEqual(changes.map((item) => [item.path, item.kind]), [
      ["already-dirty.txt", "modified"], ["delete-me.txt", "deleted"], ["untracked-new.txt", "added"],
    ]);
    assert.notEqual(changes[0].before.sha256, changes[0].after.sha256, "byte hashes detect pre-dirty same-status changes");
    assert.ok(after.omitted.some((item) => item.path === "node_modules/" && item.reason === "excluded"));

    fs.writeFileSync(path.join(root, "large.bin"), Buffer.alloc(20));
    const limited = writeSet.captureContentSignatureSnapshot(root, { maxFiles: 1, maxTotalBytes: 10, maxFileBytes: 5 });
    assert.equal(limited.truncated, true);
    assert.ok(limited.omitted.some((item) => ["file-limit", "file-byte-limit", "total-byte-limit"].includes(item.reason)));
    assert.ok(limited.fileCount <= 1);
    assert.ok(limited.totalBytes <= 10);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testDriftInspectionAndVerificationBounds() {
  const root = tempDir("supervision-drift");
  try {
    const mission = supervision.createFrozenMission(missionInput(root));
    const flags = supervision.detectBoundaryDrift({
      mission,
      currentMissionHash: "0".repeat(64),
      currentCwd: path.join(root, "other"),
      currentWorktreeRoot: path.join(root, "other-worktree"),
      currentWorktreeRealRoot: path.join(root, "other-real-worktree"),
      currentBranch: "drifted",
      currentBaseline: "different",
      planIssues: [{ code: "criteria_less_task", message: "bad" }],
      pathViolations: [{ path: "x", resolvedPath: "x", code: "protected_path", message: "protected" }],
      approvedTaskIds: ["task-1"],
      observedTaskIds: ["task-2"],
      repeatedIdenticalFailures: 2,
      ambiguousCompletion: true,
      settledImplementationTask: true,
      contentChanges: [],
    });
    const codes = new Set(flags.map((flag) => flag.code));
    for (const code of ["mission_hash_changed", "cwd_changed", "worktree_root_changed", "worktree_real_root_changed", "branch_changed", "baseline_changed", "invalid_plan", "protected_path", "unapproved_task", "repeated_identical_failure", "ambiguous_completion", "no_content_progress"]) assert.ok(codes.has(code), code);

    const zeroDeltaAnalysisFlags = supervision.detectBoundaryDrift({
      mission,
      currentMissionHash: mission.missionHash,
      currentCwd: mission.cwd,
      currentWorktreeRoot: mission.worktree.root,
      currentWorktreeRealRoot: mission.worktree.realRoot,
      currentBranch: mission.worktree.branch,
      currentBaseline: mission.worktree.baseline,
      settledImplementationTask: false,
      contentChanges: [],
    });
    assert.equal(zeroDeltaAnalysisFlags.some((flag) => flag.code === "no_content_progress"), false,
      "zero delta is not itself a defect when the host has classified the settled contract as analysis");
    assert.equal(flags.some((flag) => flag.code === "no_content_progress"), true,
      "the same zero delta remains blocking for a contract that requires implementation");

    const digest = crypto.createHash("sha256").update("x").digest("hex");
    assert.deepEqual(supervision.validateFinalVerification(mission, [
      {
        criterionId: "AC-01", status: "pass", evidence: [
          { kind: "test", observed: "negative-path rejection test passed", exitCode: 0 },
          { kind: "command", observed: "validator completed", exitCode: 0 },
          { kind: "file", observed: "artifact.json exists" },
        ],
      },
      { criterionId: "AC-02", status: "pass", evidence: [{ kind: "hash", observed: `artifact.json sha256=${digest}` }] },
    ]), [], "all declared evidence kinds accept valid machine observations");

    const codesFor = (value, limits) => new Set(
      supervision.validateFinalVerification(mission, value, limits).map((issue) => issue.code),
    );
    const assertRejected = (value, expectedCodes, label, limits) => {
      let codes;
      assert.doesNotThrow(() => { codes = codesFor(value, limits); }, `${label} must fail closed without throwing`);
      for (const code of expectedCodes) assert.ok(codes.has(code), `${label}: expected ${code}`);
    };

    // Semantic evidence vocabularies are normalized into advisory notes rather
    // than used to replace the reviewer's verdict. Missing required criterion
    // AC-02 remains independently visible in these intentionally partial inputs.
    assertRejected(
      [{ criterionId: "AC-01", status: "pass", evidence: [{ kind: "prose", observed: "looks right" }] }],
      ["unsupported_evidence_kind", "missing_verification_finding"],
      "normalized prose evidence",
    );
    assertRejected(
      [{ criterionId: "AC-01", status: "pass", evidence: [{ kind: 7, observed: "looks right" }] }],
      ["unsupported_evidence_kind", "missing_verification_finding"],
      "normalized non-string evidence kind",
    );

    for (const [value, expectedCodes, label] of [
      [null, ["invalid_verification_findings"], "null findings"],
      [{}, ["invalid_verification_findings"], "non-array findings"],
      [[null, [], "bad"], ["invalid_verification_finding", "missing_verification_finding"], "malformed finding values"],
      [[{ criterionId: "", status: "pass", evidence: [] }], ["invalid_verification_criterion"], "empty criterionId"],
      [[{ criterionId: "x".repeat(257), status: "pass", evidence: [] }], ["invalid_verification_criterion"], "oversized criterionId"],
      [[{ criterionId: "AC-01", status: "PASS", evidence: [] }], ["invalid_verification_status"], "invalid status"],
      [[{ criterionId: "AC-01", status: "pass", evidence: null }], ["invalid_verification_evidence", "missing_machine_evidence"], "null evidence collection"],
      [[{ criterionId: "AC-01", status: "pass", evidence: [null] }], ["invalid_machine_evidence", "missing_machine_evidence"], "null evidence entry"],
      [[{ criterionId: "AC-01", status: "pass", evidence: [{}] }], ["unsupported_evidence_kind", "invalid_machine_evidence", "missing_machine_evidence"], "malformed evidence object"],
      [[{ criterionId: "AC-01", status: "pass", evidence: [{ kind: "file", observed: "x".repeat(16_385) }] }], ["invalid_machine_evidence", "missing_machine_evidence"], "oversized observation"],
      [[{ criterionId: "AC-01", status: "pass", evidence: [{ kind: "hash", observed: "not-a-sha256" }] }], ["invalid_hash_evidence", "missing_machine_evidence"], "invalid hash"],
    ]) assertRejected(value, expectedCodes, label);

    for (const [evidence, expectedCodes, label] of [
      [{ kind: "test", observed: "ran" }, ["invalid_machine_evidence", "missing_machine_evidence"], "missing test exit code"],
      [{ kind: "command", observed: "ran", exitCode: "0" }, ["invalid_machine_evidence", "missing_machine_evidence"], "noninteger command exit code"],
      [{ kind: "test", observed: "expected rejection", exitCode: 1 }, ["nonzero_pass_evidence"], "nonzero test is retained as advisory evidence"],
      [{ kind: "command", observed: "expected rejection", exitCode: -1 }, ["nonzero_pass_evidence"], "nonzero command is retained as advisory evidence"],
    ]) {
      assertRejected(
        [{ criterionId: "AC-01", status: "pass", evidence: [evidence] }],
        expectedCodes,
        label,
      );
    }

    assertRejected(
      [{ criterionId: "AC-01", status: "fail", evidence: [{ kind: "test", observed: "product test failed", exitCode: 1 }] }],
      ["criterion_verification_failed"],
      "an explicit fail finding prevents terminal PASS",
    );
    assertRejected(
      Array.from({ length: 101 }, () => null),
      ["verification_finding_limit"],
      "oversized findings collection",
    );
    assertRejected(
      [{ criterionId: "AC-01", status: "pass", evidence: Array.from({ length: 21 }, () => ({ kind: "file", observed: "artifact" })) }],
      ["verification_evidence_limit"],
      "oversized evidence collection",
    );
    assertRejected([], ["invalid_verification_bounds"], "hostile verification bounds", { maxFindings: Number.MAX_SAFE_INTEGER });

    const bad = supervision.validateFinalVerification(mission, [
      { criterionId: "AC-01", status: "pass", evidence: [] },
      { criterionId: "AC-01", status: "fail", evidence: [] },
    ], { maxFindings: 1, maxEvidencePerCriterion: 1 });
    const badCodes = new Set(bad.map((issue) => issue.code));
    for (const code of ["verification_finding_limit", "missing_machine_evidence", "missing_verification_finding"]) assert.ok(badCodes.has(code), code);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async function main() {
  const tests = [
    ["canonical mission hash stability and drift", testCanonicalMission],
    ["criterion/task traceability validation", testCriterionPlanValidation],
    ["one-use bound approvals, legal transitions, and task-boundary clock policy", testApprovalTokensAndTransitions],
    ["atomic durable store, read-only inspect, and restart pause", testAtomicStoreRestartAndReadOnlyInspect],
    ["product/maintenance lane and protected-root checks", testLanePolicy],
    ["deterministic infrastructure classification", testInfrastructureClassification],
    ["already-dirty content hashes, untracked effects, exclusions, and limits", testBoundedContentEffects],
    ["drift flags and bounded criterion verification", testDriftInspectionAndVerificationBounds],
  ];
  for (const [name, test] of tests) {
    await test();
    console.log(`ok - ${name}`);
  }
  console.log("test-visible-main-supervision: all scenarios passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
