#!/usr/bin/env node
/** Finite production-method probe for mutable artifact read admission and identity races. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..", "..");
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "orc-item3-read-race-"));
for (const [key, name] of Object.entries({
  PI_CODING_AGENT_DIR: "agent",
  PI_ORCHESTRATOR_RUNS_ROOT: "runs",
  PI_ORCHESTRATOR_NEXT_RUNS_ROOT: "next",
})) {
  process.env[key] = path.join(TEMP_ROOT, name);
  fs.mkdirSync(process.env[key], { recursive: true });
}
process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER = TEMP_ROOT;
process.env.PI_OFFLINE = "1";

const originalReadFileSync = fs.readFileSync;
const originalOpenSync = fs.openSync;
const originalReadSync = fs.readSync;
const originalCloseSync = fs.closeSync;
const originalFstatSync = fs.fstatSync;
const originalLstatSync = fs.lstatSync;
const trackedDescriptors = new Set();
let mode = "";
let target = "";
let actualReadBytes = 0;
let currentBudget;
let insideReadFile = false;
let mutated = false;
let replacementIdentityTrace;
let collidingReplacement = "";
let passed = false;
let unprovenReported = false;
// F5-EXACT-IDENTITY-LOGIC-NONNATIVE: constructed stat inputs for a labelled
// NON-NATIVE pure-logic witness. Only active in mode "identity-logic-nonnative"
// and only for bigint stats of the current target; every other call passes through.
let identityLogic;

function mutateTarget() {
  if (mutated) return;
  mutated = true;
  if (mode === "growth" || mode === "growth-after-reservation") fs.writeFileSync(target, Buffer.alloc(300 * 1024, 7));
  if (mode === "replacement" || mode === "replacement-numeric-collision") {
    const before = fs.lstatSync(target);
    const beforeExact = fs.lstatSync(target, { bigint: true });
    const replacement = mode === "replacement" ? `${target}.replacement` : collidingReplacement;
    if (mode === "replacement") fs.writeFileSync(replacement, Buffer.alloc(16, 9));
    const replacementStat = fs.lstatSync(replacement);
    const replacementExact = fs.lstatSync(replacement, { bigint: true });
    fs.renameSync(replacement, target);
    const after = fs.lstatSync(target);
    const afterExact = fs.lstatSync(target, { bigint: true });
    replacementIdentityTrace = {
      before: { dev: before.dev, ino: before.ino, exactDev: beforeExact.dev.toString(), exactIno: beforeExact.ino.toString() },
      replacement: { dev: replacementStat.dev, ino: replacementStat.ino, exactDev: replacementExact.dev.toString(), exactIno: replacementExact.ino.toString() },
      after: { dev: after.dev, ino: after.ino, exactDev: afterExact.dev.toString(), exactIno: afterExact.ino.toString() },
    };
  }
}

fs.readFileSync = function instrumentedReadFile(file, ...args) {
  if (path.resolve(String(file)) === target && (mode === "growth" || mode === "replacement")) mutateTarget();
  insideReadFile = true;
  try {
    const value = originalReadFileSync.call(this, file, ...args);
    if (path.resolve(String(file)) === target) actualReadBytes += Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value);
    return value;
  } finally { insideReadFile = false; }
};
fs.openSync = function instrumentedOpen(file, ...args) {
  const canonical = path.resolve(String(file));
  if (canonical === target && (mode === "growth" || mode === "replacement" || mode === "replacement-numeric-collision")) mutateTarget();
  const descriptor = originalOpenSync.call(this, file, ...args);
  if (canonical === target) trackedDescriptors.add(descriptor);
  return descriptor;
};
fs.fstatSync = function instrumentedFstat(descriptor, ...args) {
  const value = originalFstatSync.call(this, descriptor, ...args);
  if (trackedDescriptors.has(descriptor) && (mode === "replacement" || mode === "replacement-numeric-collision")) {
    const requestedExact = args.some((arg) => arg?.bigint === true);
    const exact = requestedExact ? value : originalFstatSync.call(this, descriptor, { bigint: true });
    const numeric = requestedExact ? originalFstatSync.call(this, descriptor) : value;
    replacementIdentityTrace.opened = {
      dev: numeric.dev, ino: numeric.ino, exactDev: exact.dev.toString(), exactIno: exact.ino.toString(),
    };
  }
  if (trackedDescriptors.has(descriptor) && mode === "identity-logic-nonnative" && identityLogic
    && args.some((arg) => arg?.bigint === true)) {
    identityLogic.fstatHits += 1;
    // Call 1 is the product's "opened" stat, call 2 its "afterHandle" stat.
    value.ino = identityLogic.leg === "opened-mismatch" && identityLogic.fstatHits === 1 ? identityLogic.y : identityLogic.x;
  }
  return value;
};
fs.lstatSync = function instrumentedLstat(file, ...args) {
  const value = originalLstatSync.call(this, file, ...args);
  if (mode === "identity-logic-nonnative" && identityLogic && path.resolve(String(file)) === target
    && args.some((arg) => arg?.bigint === true)) {
    identityLogic.lstatHits += 1;
    // Call 1 is the product's "before" stat, call 2 its "afterPath" stat.
    value.ino = identityLogic.leg === "after-path-mismatch" && identityLogic.lstatHits === 2 ? identityLogic.y : identityLogic.x;
  }
  return value;
};
fs.readSync = function instrumentedRead(descriptor, ...args) {
  if (trackedDescriptors.has(descriptor) && mode === "growth-after-reservation" && !mutated) {
    assert.equal(currentBudget.accounting().currentCycleBytes, 16);
    mutateTarget();
  }
  if (trackedDescriptors.has(descriptor) && mode === "short") {
    const requested = Number(args[2]) || 0;
    const shortened = Math.max(0, requested - 1);
    const forwarded = [...args];
    forwarded[2] = shortened;
    const read = originalReadSync.call(this, descriptor, ...forwarded);
    actualReadBytes += read;
    return read;
  }
  const read = originalReadSync.call(this, descriptor, ...args);
  if (trackedDescriptors.has(descriptor) && !insideReadFile) actualReadBytes += read;
  return read;
};
fs.closeSync = function instrumentedClose(descriptor, ...args) {
  const value = originalCloseSync.call(this, descriptor, ...args);
  trackedDescriptors.delete(descriptor);
  return value;
};

try {
  const PI_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
  process.env.NODE_PATH = [PI_MODULES, path.join(ROOT, "node_modules")].join(path.delimiter);
  Module._initPaths();
  const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));
  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
  const { EventReader, SharedReadBudget } = jiti(path.join(ROOT, "src", "worker-no-output-monitor.ts"));

  const run = (name, initial, raceMode) => {
    target = path.join(TEMP_ROOT, `${name}.bin`);
    fs.writeFileSync(target, initial);
    mode = raceMode; mutated = false; actualReadBytes = 0; trackedDescriptors.clear();
    const budget = new SharedReadBudget(256 * 1024);
    currentBudget = budget;
    const reader = new EventReader(TEMP_ROOT, budget);
    budget.beginCycle();
    const value = reader.readFileWithinCycle(target, 256 * 1024, `artifact-${name}`);
    return { value, actualReadBytes, accounting: budget.accounting() };
  };

  const growth = run("growth", Buffer.alloc(16, 1), "growth");
  assert.equal(growth.value, undefined);
  assert.ok(growth.actualReadBytes <= 256 * 1024,
    `actual bounded-handle reads exceeded shared credits: ${growth.actualReadBytes}`);
  assert.ok(growth.actualReadBytes <= growth.accounting.currentCycleBytes,
    `actual reads ${growth.actualReadBytes} exceeded reserved credits ${growth.accounting.currentCycleBytes}`);

  const afterReservationGrowth = run("growth-after-reservation", Buffer.alloc(16, 4), "growth-after-reservation");
  assert.equal(afterReservationGrowth.value, undefined);
  assert.equal(afterReservationGrowth.actualReadBytes, 16,
    "growth after the real 16-byte reservation must not expand the bounded handle read");
  assert.equal(afterReservationGrowth.accounting.currentCycleBytes, 16);
  assert.equal(fs.statSync(target).size, 300 * 1024);

  const replacement = run("replacement", Buffer.alloc(16, 2), "replacement");
  console.log(`MEASURE item3 replacement-identity ${JSON.stringify({
    ...replacementIdentityTrace,
    numericBeforeMatchesOpened: replacementIdentityTrace.before.dev === replacementIdentityTrace.opened.dev
      && replacementIdentityTrace.before.ino === replacementIdentityTrace.opened.ino,
    exactBeforeMatchesOpened: replacementIdentityTrace.before.exactDev === replacementIdentityTrace.opened.exactDev
      && replacementIdentityTrace.before.exactIno === replacementIdentityTrace.opened.exactIno,
    actualReadBytes: replacement.actualReadBytes,
    returnedBytes: replacement.value ? [...replacement.value] : null,
  })}`);
  assert.equal(replacement.value, undefined, "same-size pathname replacement must fail identity validation");

  // Windows exposes dev/ino as Numbers even when the exact native identity is
  // beyond Number.MAX_SAFE_INTEGER. Find a real finite pair whose distinct
  // exact identities map to the same numeric identity, then drive the same
  // pathname-replacement seam. This preserves the original scenario while
  // discriminating an identity-precision defect from fixture ordering or FD
  // reuse. No filesystem identity is synthesized.
  const identityRoot = path.join(TEMP_ROOT, "identity-survey");
  fs.mkdirSync(identityRoot);
  const numericIdentities = new Map();
  let collision;
  // F5-COLLISION-PREREQUISITE-UNPROVEN: the survey keeps its 8192 bound, one
  // pass and no retry; it only additionally records its largest exact ino and
  // how many exact inos are at or above 2^53 (the precision limit of Number).
  const exactPrecisionLimit = 2n ** 53n;
  let surveyMaxExactIno = -1n;
  let surveyExactInosAtOrAbove2p53 = 0;
  let surveyedCount = 0;
  let collisionUnproven;
  for (let index = 0; index < 8192 && !collision; index += 1) {
    const file = path.join(identityRoot, `identity-${index}.bin`);
    fs.writeFileSync(file, Buffer.from([index & 255]));
    const numeric = fs.lstatSync(file);
    const exact = fs.lstatSync(file, { bigint: true });
    const key = `${numeric.dev}:${numeric.ino}`;
    const record = {
      file, numericDev: numeric.dev, numericIno: numeric.ino,
      exactDev: exact.dev.toString(), exactIno: exact.ino.toString(),
    };
    surveyedCount += 1;
    if (exact.ino > surveyMaxExactIno) surveyMaxExactIno = exact.ino;
    if (exact.ino >= exactPrecisionLimit) surveyExactInosAtOrAbove2p53 += 1;
    const prior = numericIdentities.get(key);
    if (prior && (prior.exactDev !== record.exactDev || prior.exactIno !== record.exactIno)) collision = { prior, record };
    else numericIdentities.set(key, record);
  }
  // The collision is an environment PREREQUISITE, not a product property. When
  // the finite survey cannot find one, the leg is recorded UNPROVEN (reported
  // after the remaining legs as a non-zero, non-pass result) instead of an
  // AssertionError that reads as a product failure and skips the later legs.
  // When a collision exists, the leg and its product assertion run unchanged.
  if (!collision) {
    collisionUnproven = {
      status: "unproven",
      reason: surveyExactInosAtOrAbove2p53 === 0
        ? "prerequisite unavailable on this filesystem"
        : "prerequisite not located by the finite survey (exact identities at or above 2^53 were observed, but no numeric collision within the 8192-file bound)",
      observedReason: surveyExactInosAtOrAbove2p53 === 0
        ? `no surveyed exact ino is at or above 2^53 (${exactPrecisionLimit}); Number dev/ino cannot round two distinct identities together`
        : `${surveyExactInosAtOrAbove2p53} surveyed exact inos at or above 2^53 without a numeric collision`,
      surveyBound: 8192,
      surveyedFiles: surveyedCount,
      maxExactIno: surveyMaxExactIno.toString(),
      exactInosAtOrAbove2p53: surveyExactInosAtOrAbove2p53,
      precisionLimit: exactPrecisionLimit.toString(),
    };
    console.log(`MEASURE item3 replacement-numeric-collision-survey ${JSON.stringify(collisionUnproven)}`);
  }
  if (collision) {
  // Collision leg: lines below are byte-identical to the pre-correction fixture.
  target = collision.prior.file;
  collidingReplacement = collision.record.file;
  mode = "replacement-numeric-collision";
  mutated = false;
  actualReadBytes = 0;
  trackedDescriptors.clear();
  replacementIdentityTrace = undefined;
  const collisionBudget = new SharedReadBudget(256 * 1024);
  currentBudget = collisionBudget;
  const collisionReader = new EventReader(TEMP_ROOT, collisionBudget);
  collisionBudget.beginCycle();
  const collisionValue = collisionReader.readFileWithinCycle(target, 256 * 1024, "artifact-replacement-numeric-collision");
  console.log(`MEASURE item3 replacement-numeric-collision ${JSON.stringify({
    surveyedFiles: numericIdentities.size + 1,
    pair: collision,
    ...replacementIdentityTrace,
    actualReadBytes,
    returnedBytes: collisionValue ? [...collisionValue] : null,
  })}`);
  assert.equal(collisionValue, undefined,
    "different exact file identities must not compare equal through rounded numeric stat fields");
  }

  const shortRead = run("short", Buffer.alloc(64, 3), "short");
  assert.equal(shortRead.value, undefined, "a short/torn handle read must not return partial artifact bytes");

  const regular = run("regular", Buffer.from("bounded-regular-file"), "none");
  assert.equal(regular.value.toString("utf8"), "bounded-regular-file");
  assert.equal(regular.actualReadBytes, Buffer.byteLength("bounded-regular-file"));

  const directory = path.join(TEMP_ROOT, "nonregular");
  fs.mkdirSync(directory);
  const directoryBudget = new SharedReadBudget();
  const directoryReader = new EventReader(TEMP_ROOT, directoryBudget);
  directoryBudget.beginCycle();
  assert.equal(directoryReader.readFileWithinCycle(directory, 256 * 1024, "artifact-directory"), undefined);

  const symlinkTarget = path.join(TEMP_ROOT, "symlink-target.bin");
  const symlink = path.join(TEMP_ROOT, "artifact-link.bin");
  fs.writeFileSync(symlinkTarget, "outside-link-content");
  fs.symlinkSync(symlinkTarget, symlink, "file");
  const linkBudget = new SharedReadBudget();
  const linkReader = new EventReader(TEMP_ROOT, linkBudget);
  linkBudget.beginCycle();
  assert.equal(linkReader.readFileWithinCycle(symlink, 256 * 1024, "artifact-link"), undefined,
    "artifact reader must not follow symbolic links");

  // F5-EXACT-IDENTITY-LOGIC-NONNATIVE. NON-NATIVE pure-logic witness: no file
  // on this filesystem presents an identity above 2^53, so the native
  // replacement-numeric-collision leg above stays UNPROVEN. This leg does NOT
  // prove F5 natively. It drives the real EventReader.readFileWithinCycle with
  // constructed BigIntStats whose ino values X=2^54 and Y=X+1 are distinct
  // exactly but equal as Numbers, on one real regular file (real dev/size/mode).
  const logicX = 2n ** 54n;
  const logicY = logicX + 1n;
  assert.notEqual(logicX, logicY);
  assert.equal(Number(logicX), Number(logicY),
    "NON-NATIVE premise: the constructed identities must collide when rounded to Number");
  const logicContent = Buffer.from("exact-identity-logic");
  const identityLogicResults = {};
  for (const leg of ["opened-mismatch", "after-path-mismatch", "equal-positive-control"]) {
    identityLogic = { leg, x: logicX, y: logicY, lstatHits: 0, fstatHits: 0 };
    const outcome = run(`identity-logic-${leg}`, logicContent, "identity-logic-nonnative");
    identityLogicResults[leg] = {
      lstatHits: identityLogic.lstatHits, fstatHits: identityLogic.fstatHits,
      actualReadBytes: outcome.actualReadBytes, returnedBytes: outcome.value ? outcome.value.toString("utf8") : null,
    };
  }
  identityLogic = undefined;
  mode = "";
  console.log(`MEASURE item3 exact-identity-logic NON-NATIVE pure-logic witness ${JSON.stringify({
    label: "NON-NATIVE pure-logic witness (constructed stat inputs; not native F5 evidence)",
    x: logicX.toString(), y: logicY.toString(), numberX: Number(logicX), numberY: Number(logicY),
    legs: identityLogicResults,
  })}`);
  const openedLeg = identityLogicResults["opened-mismatch"];
  assert.deepEqual([openedLeg.lstatHits, openedLeg.fstatHits], [1, 1],
    "NON-NATIVE opened-mismatch: constructed before/opened stats must reach the real reader exactly once each");
  assert.equal(openedLeg.actualReadBytes, 0, "NON-NATIVE opened-mismatch must be rejected before any byte is read");
  assert.equal(openedLeg.returnedBytes, null,
    "NON-NATIVE opened-mismatch: exact ino X vs Y must be rejected although Number(X) === Number(Y)");
  const afterPathLeg = identityLogicResults["after-path-mismatch"];
  assert.deepEqual([afterPathLeg.lstatHits, afterPathLeg.fstatHits], [2, 2],
    "NON-NATIVE after-path-mismatch: constructed before/opened/afterHandle/afterPath stats must each reach the real reader");
  assert.equal(afterPathLeg.actualReadBytes, logicContent.length);
  assert.equal(afterPathLeg.returnedBytes, null,
    "NON-NATIVE after-path-mismatch: exact ino X vs Y must be rejected although Number(X) === Number(Y)");
  const controlLeg = identityLogicResults["equal-positive-control"];
  assert.deepEqual([controlLeg.lstatHits, controlLeg.fstatHits], [2, 2],
    "NON-NATIVE positive control: constructed equal stats must each reach the real reader");
  assert.equal(controlLeg.actualReadBytes, logicContent.length);
  assert.equal(controlLeg.returnedBytes, logicContent.toString("utf8"),
    "NON-NATIVE positive control: equal constructed exact identities must read the bytes");

  console.log(JSON.stringify({
    growthActualReadBytes: growth.actualReadBytes,
    growthReservedBytes: growth.accounting.currentCycleBytes,
    afterReservationGrowthActualReadBytes: afterReservationGrowth.actualReadBytes,
    replacementRejected: replacement.value === undefined,
    shortReadRejected: shortRead.value === undefined,
    symlinkRejected: true,
    replacementNumericCollision: collisionUnproven ? "unproven" : "rejected",
    exactIdentityLogicNonNative: "NON-NATIVE pure-logic witness: opened-mismatch rejected, after-path-mismatch rejected, equal control read",
  }));
  if (collisionUnproven) {
    console.log(`UNPROVEN item3 read-credit-race replacement-numeric-collision: ${collisionUnproven.reason} ${JSON.stringify(collisionUnproven)}`);
    unprovenReported = true;
    throw new Error(`ITEM3_PREREQUISITE_UNAVAILABLE replacement-numeric-collision: ${collisionUnproven.reason}; ${collisionUnproven.observedReason} (UNPROVEN, not a pass)`);
  }
  passed = true;
} finally {
  fs.readFileSync = originalReadFileSync;
  fs.openSync = originalOpenSync;
  fs.readSync = originalReadSync;
  fs.closeSync = originalCloseSync;
  fs.fstatSync = originalFstatSync;
  fs.lstatSync = originalLstatSync;
  if (passed) fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  else if (unprovenReported) console.log(`PRESERVED_UNPROVEN_ROOT ${TEMP_ROOT}`);
  else console.log(`PRESERVED_FAILURE_ROOT ${TEMP_ROOT}`);
}
