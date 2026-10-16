#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SOURCE, isolated, api, declarations } = require('./test-2026-10-06-round7-test-isolation.cjs');
const directory = isolated('round7-cleanup-');
const nativeRm = fs.rmSync, nativeLstat = fs.lstatSync;
const failures = [];
function check(name, body) { try { body(); console.log('PASS ' + name); } catch (error) { failures.push(name + ': ' + error.message); console.log('RED ' + name + ': ' + error.message); } }
try {
  const monitor = api('src/worker-no-output-monitor.ts', ['EventReader', 'retireSettledEvidence', 'cleanupCommandRoot'], {
    SharedReadBudget: class {}, rmSync: (...args) => fs.rmSync(...args), lstatSync: (...args) => fs.lstatSync(...args), statSync: fs.statSync,
  });
  const { CommandTelemetryOwner } = require(path.join(SOURCE, 'src/command-telemetry-owner.cjs'));
  for (const mode of ['noop', 'throw', 'unknown', 'live', 'success']) check('evidence retirement/' + mode, () => {
    const root = path.join(directory, 'evidence-' + mode); fs.mkdirSync(root);
    const events = path.join(root, 'events'); fs.mkdirSync(events);
    const owner = new CommandTelemetryOwner({ commandRoot: path.join(root, 'command'), evidenceDirectory: path.join(root, 'evidence'), commandId: 'round7-owned' });
    const id = '9b'.repeat(12);
    assert.equal(owner.commitHostEvidence(id, { type: 'invocation_terminal', marker: 'PRIVATE_FIXTURE' }), true);
    const current = owner.generations.get(id).file;
    let lease;
    if (mode === 'live') lease = owner.retainCommittedDelivery(id, owner.generations.get(id).generation);
    const reader = new monitor.EventReader(events);
    fs.rmSync = (candidate, ...args) => {
      if (path.resolve(candidate) === path.resolve(current) && (mode === 'noop' || mode === 'throw')) {
        if (mode === 'throw') throw Error('SECRET_PASSWORD=hidden');
        return;
      }
      return nativeRm(candidate, ...args);
    };
    fs.lstatSync = (candidate, ...args) => {
      if (mode === 'unknown' && path.dirname(candidate) === events) throw Object.assign(Error('SECRET_UNKNOWN_PATH'), { code: 'EACCES' });
      return nativeLstat(candidate, ...args);
    };
    try {
      const result = monitor.retireSettledEvidence(reader, owner, id);
      assert.equal(result?.settled, mode === 'success', 'retirement must be conclusive, not merely attempted');
      if (mode !== 'success') { assert.ok(result.reason); assert.equal(owner.generations.has(id), true, 'failed/unknown/live obligations retained'); }
      assert.equal(JSON.stringify(result).includes('SECRET'), false);
      assert.equal(JSON.stringify(result).includes(directory), false, 'no raw paths in diagnostic');
    } finally {
      fs.rmSync = nativeRm; fs.lstatSync = nativeLstat;
      if (lease) owner.releaseReader(lease.leaseId);
      monitor.retireSettledEvidence(reader, owner, id);
    }
  });
  check('reader failure and owner throw', () => {
    let retired = 0;
    const result = monitor.retireSettledEvidence({ retire: () => undefined }, { retireCommitted: () => { retired++; return true; } }, 'owned');
    assert.equal(result?.settled, false, 'unknown reader disposition is not success'); assert.equal(retired, 0, 'unknown reader cannot authorize owner retirement');
    const thrown = monitor.retireSettledEvidence({ retire: () => true }, { retireCommitted: () => { throw Error('SECRET_RETIREMENT'); } }, 'owned');
    assert.equal(thrown?.settled, false); assert.equal(JSON.stringify(thrown).includes('SECRET'), false);
  });
  for (const mode of ['noop', 'throw', 'unknown', 'success']) check('command root cleanup/' + mode, () => {
    const root = path.join(directory, 'root-' + mode); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'authoritative.json'), 'PRIVATE_FIXTURE');
    fs.rmSync = (candidate, ...args) => {
      if (candidate === root && mode !== 'success') { if (mode === 'throw') throw Error('SECRET_REMOVAL'); return; }
      return nativeRm(candidate, ...args);
    };
    fs.lstatSync = (candidate, ...args) => { if (mode === 'unknown' && candidate === root) throw Object.assign(Error('SECRET_UNKNOWN'), { code: 'EACCES' }); return nativeLstat(candidate, ...args); };
    try {
      const result = monitor.cleanupCommandRoot(root);
      assert.equal(result?.settled, mode === 'success', 'no-op/throw/unknown root removal must be visible');
      if (mode !== 'success') { assert.ok(result.reason); assert.equal(fs.readFileSync(path.join(root, 'authoritative.json'), 'utf8'), 'PRIVATE_FIXTURE'); }
      assert.equal(JSON.stringify(result).includes('SECRET'), false);
    } finally { fs.rmSync = nativeRm; fs.lstatSync = nativeLstat; }
  });
  check('production callers expose retirement and root diagnostics', () => {
    const text = declarations('src/worker-no-output-monitor.ts', ['workerNoOutputMonitor']);
    assert.match(text, /recordCleanupOutcome\(retireSettledEvidence\(/, 'terminal and artifact callers consume retirement result');
    assert.equal((text.match(/recordCleanupOutcome\(retireSettledEvidence\(/g) || []).length, 2);
    const records = [];
    const report = api('src/worker-no-output-monitor.ts', ['recordCleanupOutcome']).recordCleanupOutcome;
    report({ settled: false, reason: 'EVIDENCE_RETIREMENT_UNESTABLISHED' }, 'evidence-retirement-caller', records);
    assert.equal(records.length, 1); assert.equal(records[0].step, 'evidence-retirement-caller');
    let callback;
    const hooks = { registerTool() {}, on(name, handler) { if (name === 'tool_result') callback = handler; }, events: { emit() {} } };
    // Inject a patch at the existing patch-map seam, without executing bash or any watcher.
    const ts = require(path.join(require('./test-2026-10-06-round7-test-isolation.cjs').ROOT, 'node_modules/typescript'));
    const patched = text.replace('const finalPatches = new Map<string, { details: NoOutputDetails; text: string; cleanup: string[] }>();', 'const finalPatches = new Map([["owned", { details: { monitorIo: {} }, text: "", cleanup: ["owned-root"] }], ["retained", { details: { monitorIo: { telemetrySettlementFailures: [{step: "evidence-retirement-caller"}] } }, text: "", cleanup: ["protected-root"] }], ["success", { details: { monitorIo: {} }, text: "", cleanup: ["success-root"] }]]);');
    assert.notEqual(patched, text, 'existing patch-map seam');
    const vm = require('node:vm');
    const removed = [];
    const context = vm.createContext({ process: { env: {}, cwd: () => directory }, createBashToolDefinition: () => ({}), redactActionText: value => value, cleanupCommandRoot: root => { removed.push(root); return root === 'success-root' ? { settled: true } : { settled: false, reason: 'COMMAND_ROOT_REMOVAL_FAILED' }; }, recordCleanupOutcome: report });
    vm.runInContext(ts.transpileModule(patched + '\nglobalThis.monitor = workerNoOutputMonitor;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    context.monitor(hooks);
    const result = callback({ toolName: 'bash', toolCallId: 'owned', content: [] });
    assert.ok(result.details.monitorIo.telemetrySettlementFailures.some(item => item.step === 'command-root-cleanup'), 'root failure reaches actual tool_result details');
    assert.equal(result.isError, undefined, 'cleanup diagnostic does not rewrite command outcome');
    const retained = callback({ toolName: 'bash', toolCallId: 'retained', content: [] });
    assert.equal(removed.includes('protected-root'), false, 'unknown/live evidence must not be removed through its root');
    assert.ok(retained.details.monitorIo.telemetrySettlementFailures.some(item => item.message === 'COMMAND_ROOT_RETAINED_FOR_UNSETTLED_EVIDENCE'));
    const success = callback({ toolName: 'bash', toolCallId: 'success', content: [] });
    assert.equal(success.details.monitorIo.telemetrySettlementFailures, undefined, 'successful root cleanup adds no failure');
    assert.deepEqual(removed, ['owned-root', 'success-root']);
    assert.equal(JSON.stringify([result, retained, success]).includes('SECRET'), false);
  });
} finally { fs.rmSync = nativeRm; fs.lstatSync = nativeLstat; nativeRm(directory, { recursive: true, force: true }); }
assert.deepEqual(failures, [], 'all cleanup semantic assertions');
console.log('PASS round7 cleanup diagnostics');
