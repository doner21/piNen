const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const home = require('./fixtures/round8-owned-temp.cjs')('historical-omission');
for (const [key, name] of Object.entries({ PI_ORCHESTRATOR_RUNS_ROOT: 'runs', PI_ORCHESTRATOR_NEXT_RUNS_ROOT: 'next', PI_CODING_AGENT_DIR: 'agent', TEMP: 'tmp', TMP: 'tmp', TMPDIR: 'tmp' })) {
  process.env[key] = path.join(home, name); fs.mkdirSync(process.env[key], { recursive: true });
}
process.env.JITI_FS_CACHE = '0'; process.env.PI_OFFLINE = '1';
require('./fixtures/round8-models.cjs')(process.env.PI_CODING_AGENT_DIR);
process.env.PI_CLI_PATH = path.join(root, 'tests/fake-pi.cjs');
process.env.FAKE_PI_PLAN_STYLE = 'impl-1-ws';
const jiti = require(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs'))(__filename, { interopDefault: true, fsCache: false });
const { SupervisionStateStore } = jiti(path.join(root, 'src/supervision.ts'));
const { captureContentSignatureSnapshot: capture } = jiti(path.join(root, 'src/write-set.ts'));
let tool;
jiti(path.join(root, 'src/index.ts')).default({ registerTool(t) { if (t.name === 'orchestrate') tool = t; }, registerCommand() {} });
async function scenario(label, limits, mutate, expected) {
  const cwd = path.join(home, label); fs.mkdirSync(cwd);
  for (const [name, text] of Object.entries({ 'existing.txt': 'small', 'modified.txt': 'before', 'removed.txt': 'remove', 'z.txt': 'cutoff' })) fs.writeFileSync(path.join(cwd, name), text);
  const call = params => tool.execute('regression', params, undefined, () => {}, { cwd });
  const planned = await call({ task: 'CREATE file out-1.txt', cwd, predictedWriteSet: 'out-1.txt', preflight: false, maxRetries: 0, plannerProvider: 'openai-codex', plannerModel: 'gpt-6-astra', executorProvider: 'openai-codex', executorModel: 'gpt-6.1-sol', verifierProvider: 'openai-codex', verifierModel: 'gpt-6.1-sol' });
  assert.ok(planned.details.runId, 'real plan must persist');
  const store = new SupervisionStateStore(planned.details.runId);
  let state = JSON.parse(fs.readFileSync(store.stateFile));
  if (label === 'baseline-byte-omission') fs.writeFileSync(path.join(cwd, 'existing.txt'), Buffer.alloc(17, 120));
  const baseline = limits ? capture(cwd, limits) : state.runtime.contentBaseline;
  state.runtime.contentBaseline = baseline;
  mutate(cwd, baseline);
  const after = capture(cwd, baseline.limits);
  // Original Round7 absence-based algorithm, including the independently reproduced
  // file-byte-limit false deletion with baseline.truncated === false.
  const effects = [...new Set([...Object.keys(baseline.files), ...Object.keys(after.files)])].sort().flatMap(name => {
    const before = baseline.files[name], now = after.files[name];
    const kind = !before ? 'added' : !now ? 'deleted' : before.sha256 !== now.sha256 ? 'modified' : undefined;
    return kind ? [{ path: name, kind, before, after: now }] : [];
  });
  if (label === 'byte-omission') {
    assert.equal(baseline.truncated, false);
    assert.ok(after.omitted.some(x => x.path === 'existing.txt' && x.reason === 'file-byte-limit'));
    assert.ok(effects.some(x => x.path === 'existing.txt' && x.kind === 'deleted'));
    assert.ok(fs.existsSync(path.join(cwd, 'existing.txt')));
  } else if (label === 'cutoff') assert.equal(baseline.truncated, true);
  else if (label === 'baseline-byte-omission') {
    assert.equal(baseline.truncated, true);
    assert.ok(baseline.omitted.some(x => x.path === 'existing.txt' && x.reason === 'file-byte-limit'));
    assert.ok(effects.some(x => x.path === 'existing.txt' && x.kind === 'added'));
  }
  state = store.appendCheckpoint(state, { kind: 'executor', createdAt: new Date().toISOString(), missionHash: state.mission.missionHash, criteria: [], effectChanges: effects, outcome: 'completed' }, { output: { text: 'Historical Round7 observation' } });
  if (label === 'saved-modification') fs.writeFileSync(path.join(cwd, 'modified.txt'), 'before');
  const saved = new Map();
  // live-status.json is the existing derived inspection projection, not durable
  // checkpoint/state authority. Every durable saved artifact must stay byte-identical.
  function bytes(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, e.name); if (e.isDirectory()) bytes(file); else if (e.name !== 'live-status.json') saved.set(file, fs.readFileSync(file)); } }
  bytes(path.dirname(store.stateFile));
  for (let i = 0; i < 2; i++) {
    const inspected = await call({ action: 'inspect', runId: state.runId });
    const changes = inspected.details.contentChanges.map(x => [x.path, x.kind]).sort();
    assert.deepEqual(changes, expected, label + ': only trustworthy changes may be displayed');
    for (const [file, data] of saved) assert.deepEqual(fs.readFileSync(file), data, 'inspect must not rewrite ' + file);
    const persisted = JSON.parse(fs.readFileSync(store.stateFile));
    assert.deepEqual(persisted.checkpoints.at(-1).effectChanges, JSON.parse(JSON.stringify(effects)), 'legacy effects stay saved verbatim');
  }
}
(async () => {
  await scenario('byte-omission', undefined, (cwd, baseline) => {
    fs.writeFileSync(path.join(cwd, 'existing.txt'), Buffer.alloc(baseline.limits.maxFileBytes + 1, 120));
    fs.writeFileSync(path.join(cwd, 'modified.txt'), 'after');
    fs.unlinkSync(path.join(cwd, 'removed.txt'));
    fs.writeFileSync(path.join(cwd, 'added.txt'), 'new');
  }, [['added.txt', 'added'], ['modified.txt', 'modified'], ['removed.txt', 'deleted']]);
  await scenario('cutoff', { maxFiles: 2 }, cwd => {
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'shift cutoff');
    fs.writeFileSync(path.join(cwd, 'existing.txt'), 'observed modification');
  }, [['existing.txt', 'modified']]);
  await scenario('baseline-byte-omission', { maxFileBytes: 16 }, cwd => {
    fs.writeFileSync(path.join(cwd, 'existing.txt'), 'small again');
    fs.writeFileSync(path.join(cwd, 'modified.txt'), 'after');
    fs.unlinkSync(path.join(cwd, 'removed.txt'));
    fs.writeFileSync(path.join(cwd, 'added.txt'), 'new');
  }, [['added.txt', 'added'], ['modified.txt', 'modified'], ['removed.txt', 'deleted']]);
  await scenario('saved-modification', undefined, cwd => {
    fs.writeFileSync(path.join(cwd, 'modified.txt'), 'after');
  }, [['modified.txt', 'modified']]);
  await scenario('complete', undefined, cwd => {
    fs.writeFileSync(path.join(cwd, 'modified.txt'), 'after');
    fs.unlinkSync(path.join(cwd, 'removed.txt'));
    fs.writeFileSync(path.join(cwd, 'added.txt'), 'new');
  }, [['added.txt', 'added'], ['modified.txt', 'modified'], ['removed.txt', 'deleted']]);
  console.log('PASS historical saved omission, cutoff, true changes and inspection immutability');
})().finally(() => fs.rmSync(home, { recursive: true, force: true }));
