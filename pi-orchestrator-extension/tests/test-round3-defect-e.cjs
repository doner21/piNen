#!/usr/bin/env node
/** E only: real startup + create/continue seams; every fixture/child stays in owned TEMP. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const childMode = process.argv[2];
const originalHome = childMode ? process.env.E_TEST_ORIGINAL_HOME : os.homedir();
assert.ok(originalHome && path.isAbsolute(originalHome), 'the forbidden home root is inherited, not replaced by the scrubbed home');
const temp = fs.realpathSync(os.tmpdir());
const home = childMode ? process.env.E_TEST_HOME : path.join(temp, 'round3-defect-e-' + randomUUID());
// Validate a new, canonical external root BEFORE the first fixture write.
assert.ok(home && path.isAbsolute(home) && path.resolve(home) === home);
assert.ok(path.dirname(home) === temp && path.basename(home).startsWith('round3-defect-e-'));
assert.ok(!home.startsWith(fs.realpathSync(ROOT) + path.sep), 'fixtures are outside the execution copy');
for (let dir = temp; ; dir = path.dirname(dir)) {
  assert.ok(!fs.lstatSync(dir).isSymbolicLink(), 'fixture ancestors must not be links');
  if (path.dirname(dir) === dir) break;
}
if (!childMode) {
  assert.ok(!fs.existsSync(home), 'fixture root must be new');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.owned-e-test'), 'E');
}
assert.ok(!fs.lstatSync(home).isSymbolicLink());
assert.equal(fs.realpathSync(home), home);
assert.equal(fs.readFileSync(path.join(home, '.owned-e-test'), 'utf8'), 'E');
const runs = path.join(home, 'runs');
const isolated = {
  PI_ORCHESTRATOR_RUNS_ROOT: runs,
  PI_ORCHESTRATOR_NEXT_RUNS_ROOT: path.join(home, 'next-runs'),
  PI_ORCHESTRATOR_TEST_RUNS_OWNER: home,
  PI_CODING_AGENT_DIR: path.join(home, 'agents'),
  HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
  HOMEDRIVE: path.parse(home).root.slice(0, 2), HOMEPATH: home.slice(2),
};
if (childMode) for (const [key, value] of Object.entries(isolated)) {
  assert.equal(process.env[key], value, 'children inherit the exact isolated ' + key);
}
// These are deliberately set BEFORE jiti or ANY production module is imported.
Object.assign(process.env, isolated, { E_TEST_HOME: home, E_TEST_ORIGINAL_HOME: originalHome, PI_CLI_PATH: path.join(home, 'worker.cjs'), PI_NODE_PATH: process.execPath });
delete process.env.NODE_PATH;
fs.mkdirSync(runs, { recursive: true });
const sentinel = path.join(home, 'forbidden-shared-stand-in');
const forbidden = [path.join(ROOT, 'runs-state'), path.join(originalHome, '.pi', 'pi-orchestrator-extension', 'runs-state'), sentinel];
const denied = [];
function guard(value) {
  if (typeof value !== 'string' && !Buffer.isBuffer(value) && !(value instanceof URL)) return;
  const name = path.resolve(value instanceof URL ? require('node:url').fileURLToPath(value) : String(value)).toLowerCase();
  for (const root of forbidden) {
    const normalized = path.resolve(root).toLowerCase();
    if (name === normalized || name.startsWith(normalized + path.sep)) {
      denied.push(name);
      throw new Error('E test refused shared-state access');
    }
  }
}
function installGuard() {
  const restores = [];
  for (const [object, names] of [
    [fs, ['existsSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'realpathSync', 'openSync', 'writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync', 'copyFileSync']],
    [fs.promises, ['access', 'readFile', 'readdir', 'stat', 'lstat', 'realpath', 'open', 'writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'copyFile']],
  ]) {
    for (const name of names) {
      const original = object[name];
      const wrapped = function (...args) {
        guard(args[0]);
        if (/rename|copyFile/.test(name)) guard(args[1]);
        return original.apply(this, args);
      };
      if (original.native) wrapped.native = (...args) => { guard(args[0]); return original.native(...args); };
      object[name] = wrapped;
      restores.push(() => { object[name] = original; });
    }
  }
  return () => restores.reverse().forEach((restore) => restore());
}
function snapshot(dir) {
  // Null prototypes retain EVERY filesystem key, including __proto__. Nested
  // objects also preserve directories (including empty ones), distinct from files.
  const result = Object.create(null);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    assert.ok(!fs.lstatSync(file).isSymbolicLink(), 'fixture artifacts must not be links');
    assert.ok(entry.isDirectory() || entry.isFile(), 'fixture artifacts must be directories or regular files');
    result[entry.name] = entry.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('base64');
  }
  return result;
}
// Store reads intentionally republish this exact derived file. Everything else
// (including approvals, worker evidence and nested live-status names) is strict.
function assertNonDerivedUnchanged(before, after, message) {
  for (const value of [before, after]) assert.equal(typeof value['live-status.json'], 'string', 'derived publication remains a regular file');
  const protectedFiles = value => Object.fromEntries(Object.entries(value).filter(([name]) => name !== 'live-status.json'));
  assert.deepEqual(protectedFiles(after), protectedFiles(before), message);
}
function assertUnchangedRun(dir, before, message, options) {
  assertRunSnapshot(before, snapshot(dir), message, options);
}
function assertRunSnapshot(before, after, message, { hostGoing = false, workerPids, observationErrors, manifestState = 'unavailable' } = {}) {
  assertNonDerivedUnchanged(before, after, message);
  const state = JSON.parse(Buffer.from(after['supervision.json'], 'base64').toString());
  const live = JSON.parse(Buffer.from(after['live-status.json'], 'base64').toString());
  assert.ok(typeof live.observedAt === 'string' && Number.isFinite(Date.parse(live.observedAt)), 'derived observation time is valid');
  assert.equal(new Date(live.observedAt).toISOString(), live.observedAt);
  const oldObservation = JSON.parse(Buffer.from(before['live-status.json'], 'base64').toString()).observedAt;
  assert.ok(Date.parse(live.observedAt) >= Date.parse(oldObservation) && Date.parse(live.observedAt) <= Date.now());
  // These startup-only fixtures intentionally lack a phase manifest/heartbeat.
  // Real probes in the second host can prove a recorded worker dead or retain
  // it as unknown, but cannot manufacture a healthy worker from an audit PID.
  const recorded = [...state.audit.activeWorkers, ...state.audit.detachedWorkers];
  assert.ok(Array.isArray(live.activeWorkers));
  const pids = live.activeWorkers.map(worker => worker.pid);
  assert.equal(new Set(pids).size, pids.length);
  const oldLive = JSON.parse(Buffer.from(before['live-status.json'], 'base64').toString());
  assert.deepEqual(pids, workerPids ?? oldLive.activeWorkers.map(worker => worker.pid), 'derived status cannot hide a protected worker observation');
  for (const worker of live.activeWorkers) {
    const original = recorded.find(item => item.pid === worker.pid);
    assert.ok(original, 'published worker must belong to the protected audit');
    assert.deepEqual(worker, { pid: original.pid, phase: original.phase, liveness: 'unknown' });
  }
  const errors = live.observationErrors;
  assert.ok(Array.isArray(errors));
  if (manifestState === 'unavailable') assert.ok(errors.includes('state.json: phase manifest unavailable'));
  else assert.ok(!errors.includes('state.json: phase manifest unavailable'), 'the known pre-executor fixture has no missing-manifest error');
  if (observationErrors) assert.deepEqual(errors, observationErrors, 'known observation errors remain truthful');
  const hostId = state.runtime?.hostInstanceId;
  const observedPids = new Set([...recorded.map(worker => worker.pid), typeof hostId === 'string' ? Number(hostId.split(':')[0]) : undefined]);
  for (const error of errors) {
    const pidError = /^PID (\d+): (.+)$/.exec(error);
    assert.ok(error === 'state.json: phase manifest unavailable' || (pidError && observedPids.has(Number(pidError[1]))
      && ['EPERM', 'EACCES', 'EIO', 'process_probe_failed', 'ERR_ASSERTION'].includes(pidError[2])), 'only actual fixture observation errors');
  }
  assert.deepEqual(live, {
    schemaVersion: 1, runId: state.runId, observedAt: live.observedAt,
    manifestState, phases: [],
    going: hostGoing ? 'going' : 'unknown',
    phase: live.activeWorkers.length ? [...new Set(live.activeWorkers.map(worker => worker.phase))].join(', ') : hostGoing ? state.status : null,
    activeWorkers: live.activeWorkers, heartbeatAt: hostGoing ? state.updatedAt : null,
    activeSilenceAlarms: [], lastError: state.pauseReason ?? errors.at(-1), observationErrors: errors,
  }, 'live status reflects current host, stale workers, uncertainty and errors');
}
function modules() {
  // The execution copy owns its dependencies; a scrubbed home has no global install.
  const piModules = path.join(ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules');
  process.env.NODE_PATH = [piModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  Module._initPaths();
  const jiti = require(path.join(piModules, 'jiti', 'lib', 'jiti.cjs'))(__filename, { interopDefault: true, moduleCache: true, fsCache: false });
  // Transitive state dependencies: supervision -> run-state/write-set (no import-time recovery).
  // index imports shapes/substrate/next/adaptive; their stateful entrypoints are NOT invoked
  // except the captured orchestrate tool. The guard is installed before this graph loads.
  return { supervision: jiti(path.join(ROOT, 'src/supervision.ts')), extension: jiti(path.join(ROOT, 'src/index.ts')).default };
}
function toolFrom(extension) {
  let tool;
  extension({ registerTool(value) { if (value.name === 'orchestrate') tool = value; }, registerCommand() {} });
  assert.ok(tool);
  return tool;
}
function fresh(mode, extra = {}) {
  const result = cp.spawnSync(process.execPath, [__filename, mode], {
    cwd: home, env: { ...process.env, ...extra }, encoding: 'utf8', windowsHide: true, timeout: 90000,
  });
  assert.equal(result.status, 0, `${mode}: ${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}
async function child() {
  const restore = installGuard();
  try {
    const { supervision, extension } = modules();
    const create = supervision.SupervisionStateStore.prototype.create;
    supervision.SupervisionStateStore.prototype.create = function (state) {
      assert.equal(Number(state.runtime?.hostInstanceId?.split(':')[0]), process.pid, 'first atomic create persists owning host');
      return create.call(this, state);
    };
    const tool = toolFrom(extension);
    const workspace = path.join(home, 'workspace');
    const call = (params) => tool.execute('E-test', params, undefined, () => {}, { cwd: workspace });
    if (childMode === 'startup') {
      console.log(JSON.stringify({ pid: process.pid }));
      return;
    }
    if (childMode === 'create') {
      const planned = await call({ task: 'CREATE out.txt with fixture content.', cwd: workspace, predictedWriteSet: 'out.txt', preflight: false, maxRetries: 0, noForceKill: true });
      assert.equal(planned.details.status, 'awaiting_supervisor', JSON.stringify(planned.details));
      console.log(JSON.stringify({ pid: process.pid, runId: planned.details.runId, token: planned.details.approvalToken }));
      return;
    }
    assert.equal(childMode, 'resume');
    const runId = process.env.E_RUN_ID;
    const stateFile = path.join(runs, runId, 'supervision.json');
    const paused = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(paused.status, 'paused');
    const before = fs.readFileSync(stateFile);
    await assert.rejects(() => call({ action: 'continue', runId, approvalToken: process.env.E_OLD_TOKEN }), /stale|invalid|consumed/);
    assert.deepEqual(fs.readFileSync(stateFile), before, 'rejected approval cannot claim host ownership');
    const freshApproval = await call({ action: 'continue', runId });
    const executed = await call({ action: 'continue', runId, approvalToken: freshApproval.details.approvalToken });
    assert.equal(executed.details.status, 'awaiting_supervisor', JSON.stringify(executed.details));
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(Number(state.runtime.hostInstanceId.split(':')[0]), process.pid, 'actual resume persists the new owning host');
    assert.equal(fs.readFileSync(path.join(workspace, 'out.txt'), 'utf8'), 'E fixture\n');
    console.log(JSON.stringify({ pid: process.pid, runId }));
  } finally {
    restore();
    assert.deepEqual(denied, [], 'no shared state access (even swallowed errors)');
  }
}
async function parent() {
  fs.mkdirSync(sentinel);
  fs.writeFileSync(path.join(sentinel, 'supervision.json'), '{"status":"executing","token":"sentinel","worker":17}\n');
  const sentinelBefore = snapshot(sentinel);
  fs.mkdirSync(path.join(home, 'workspace'));
  // Complete offline launcher configuration: real Pi model resolution and prompt
  // capacity admission use these isolated settings, not the owner's catalogue.
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, 'auth.json'), '{}\n');
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'e-fixture', defaultModel: 'offline-worker' }));
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: {
    'e-fixture': { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'not-a-credential', models: [
      { id: 'offline-worker', name: 'E offline fixture', reasoning: false, input: ['text'], contextWindow: 272000, maxTokens: 8192 },
    ] },
  } }));
  // A no-network CLI fixture, but NOT a fabricated guard-ready marker or API.
  // Pi's real resource loader constructs the explicitly requested production
  // extensions; their own bootstrap, registration and attestation run unchanged.
  // The deterministic response replaces only model inference, not create/resume.
  fs.writeFileSync(path.join(home, 'worker.cjs'), `
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
(async()=>{
const ROOT=${JSON.stringify(ROOT)};
for(const [key,value] of Object.entries(${JSON.stringify(isolated)})) assert.equal(process.env[key],value,'worker inherits '+key);
// Check disk ownership as the FIRST worker operation, before SDK/bootstrap work.
const root=process.env.PI_ORCHESTRATOR_RUNS_ROOT;
const states=fs.readdirSync(root).map(id=>path.join(root,id,'supervision.json')).filter(p=>fs.existsSync(p)).map(p=>JSON.parse(fs.readFileSync(p,'utf8')));
const state=states.find(s=>path.resolve(s.mission.cwd)===process.cwd());
assert.ok(state && state.runtime,'ownership exists before first worker');
assert.equal(Number(state.runtime.hostInstanceId.split(':')[0]),process.ppid,'worker launch must have persisted its owning host');
const sdk=await import(require('url').pathToFileURL(path.join(ROOT,'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
globalThis.fetch=()=>{throw Error('E fixture forbids model network access');};
const args=process.argv.slice(2),extensions=[];
for(let i=0;i<args.length;i++) if(args[i]==='--extension') extensions.push(args[++i]);
assert.ok(args.includes('--no-extensions'));
assert.deepEqual(extensions,['worker-monitor-bootstrap.ts','worker-no-output-monitor.ts','worker-execution-constraints.ts'].map(name=>path.join(ROOT,'src',name)));
assert.equal(args[args.indexOf('--provider')+1],'e-fixture');
assert.equal(args[args.indexOf('--model')+1],'offline-worker');
const agentDir=process.env.PI_CODING_AGENT_DIR;
const settingsManager=sdk.SettingsManager.create(process.cwd(),agentDir);
const modelRuntime=await sdk.ModelRuntime.create({authPath:path.join(agentDir,'auth.json'),modelsPath:path.join(agentDir,'models.json'),allowModelNetwork:false});
const model=modelRuntime.getModel('e-fixture','offline-worker');
assert.equal(model.contextWindow,272000);assert.equal(model.maxTokens,8192);
const promptFile=args[args.indexOf('--append-system-prompt')+1];
assert.ok(path.isAbsolute(promptFile));
const resourceLoader=new sdk.DefaultResourceLoader({cwd:process.cwd(),agentDir,settingsManager,noExtensions:true,additionalExtensionPaths:extensions,appendSystemPrompt:[fs.readFileSync(promptFile,'utf8')]});
await resourceLoader.reload();
assert.deepEqual(resourceLoader.getExtensions().errors,[],'every requested safety extension loads successfully');
assert.deepEqual(resourceLoader.getExtensions().extensions.map(extension=>extension.resolvedPath),extensions);
const tools=args.includes('--tools')?args[args.indexOf('--tools')+1].split(','):undefined;
const {session}=await sdk.createAgentSession({cwd:process.cwd(),agentDir,settingsManager,modelRuntime,model,resourceLoader,sessionManager:sdk.SessionManager.inMemory(process.cwd()),...(tools?{tools}:args.includes('--no-tools')?{noTools:'all'}:{})});
try {
await session.bindExtensions({mode:'print',onError:error=>{throw Error(JSON.stringify(error));}});
assert.ok(resourceLoader.getExtensions().extensions[1].tools.has('bash'),'the real monitor registers its bash definition');
if(args.includes('--no-tools')) assert.deepEqual(session.getActiveToolNames(),[],'honor the tool-free planner');
else if(tools) assert.deepEqual([...session.getActiveToolNames()].sort(),[...tools].sort(),'honor the launcher tool fence');
else assert.ok(session.getActiveToolNames().includes('bash'));
assert.equal(await session.extensionRunner.emitToolCall({type:'tool_call',toolCallId:'E-bootstrap-check',toolName:'bash',input:{command:'true',timeout:null}}),undefined,'bootstrap allows dispatch only after the production monitor constructs');
let prompt='';for await(const chunk of process.stdin) prompt+=chunk;
assert.ok(prompt.includes('CREATE out.txt with fixture content.'),'consume the actual guarded launcher prompt');
fs.appendFileSync(path.join(process.env.E_TEST_HOME,'worker-log.jsonl'),JSON.stringify({status:state.status,owner:state.runtime.hostInstanceId,ppid:process.ppid,root,nextRoot:process.env.PI_ORCHESTRATOR_NEXT_RUNS_ROOT,agentDir,extensions})+'\\n');
let text;
if(state.status==='plan_checkpoint') text=JSON.stringify({tasks:[{id:'task-1',description:'CREATE out.txt with fixture content.',dependsOn:[],expects_file_change:true}],notes:'E fixture',predicted_write_set:['out.txt']});
else {assert.equal(state.status,'executing');fs.writeFileSync('out.txt','E fixture\\n');text='PASS: Created out.txt with fixture content.';}
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason:'stop'}}));
} finally {session.dispose();}
})();
`);
  const restore = installGuard();
  const failures = [];
  async function scenario(name, fn) {
    try { await fn(); console.log('PASS ' + name); }
    catch (error) { failures.push(name); console.error('FAIL ' + name + '\n' + error.stack); }
  }
  try {
    const { supervision: s, extension } = modules();
    const mission = s.createFrozenMission({ originalTask: 'E fixture', cwd: home, worktree: { root: home, realRoot: fs.realpathSync(home), branch: null, baseline: null }, paradigm: 'plan-execute-verify', lane: 'orchestrator-maintenance', routes: [], constraints: [], nonGoals: [], acceptanceCriteria: [{ id: 'AC-01', text: 'E fixture remains safe.', required: true }] });
    let counter = 0;
    function fixture(host, status = 'executing', omitRuntime = false) {
      const id = 'orc-e-' + (++counter);
      const store = new s.SupervisionStateStore(id);
      const state = s.createInitialSupervisionState({ runId: id, mission, tasks: [] });
      state.status = status;
      if (!omitRuntime) state.runtime = { params: {}, intake: {}, plan: { tasks: [], notes: '' }, completedTaskIds: [], executorOutputs: [], contentBaseline: { root: home, files: {} }, repairCount: 0, ...(host === undefined ? {} : { hostInstanceId: host }) };
      state.audit.activeWorkers = [{ pid: 123, phase: 'executor' }];
      state.audit.detachedWorkers = [{ pid: 456, phase: 'old-worker' }];
      state.currentApproval = s.issueApprovalToken({ runId: id, missionHash: mission.missionHash, checkpointId: 'checkpoint-0001', action: 'continue' }).record;
      store.create(state);
      fs.writeFileSync(path.join(store.runDir, 'worker-result.bin'), Buffer.from([0, 255, 3, 10]));
      fs.writeFileSync(path.join(store.runDir, 'checkpoint-0001-plan.json'), ' { "evidence": "immutable" }\n');
      return store;
    }
    const current = `${process.pid}:${Math.round(performance.timeOrigin)}`;
    const cases = [
      ['current instance', current, 'ESRCH'], ['current PID different instance', `${process.pid}:1`, 'ESRCH'],
      ['live other PID', '2100000001:1', null], ['permission denied', '2100000002:1', 'EPERM'],
      ['access denied', '2100000003:1', 'EACCES'], ['unknown error', '2100000004:1', 'EIO'],
      ['untyped error', '2100000005:1', 'UNTYPED'], ['missing legacy ownership', undefined, 'ESRCH'],
      ...[null, '', 17, {}, 'dead-host', '123', '-1:1', '0:1', '1.5:1', '12junk:1', '12:NaN', '12:0', '12:1:2', '01:1', '2147483648:1', '9007199254740993:1', '12:9007199254740993'].map((host, i) => ['malformed ' + i, host, 'ESRCH']),
    ];
    for (const [name, host, code] of cases) await scenario(name, () => {
      const store = fixture(host);
      const before = snapshot(store.runDir);
      const kill = process.kill;
      process.kill = (_pid, signal) => { assert.equal(signal, 0, 'never signal a worker'); if (code) throw code === 'UNTYPED' ? Error('unknown') : Object.assign(Error(code), { code }); return true; };
      try { toolFrom(extension); } finally { process.kill = kill; }
      assertUnchangedRun(store.runDir, before, name + ': non-derived bytes, approval, active/detached ownership unchanged', {
        hostGoing: name === 'current instance', workerPids: code === 'ESRCH' ? [] : [123, 456],
      });
      fs.rmSync(store.runDir, { recursive: true });
    });
    await scenario('missing runtime', () => {
      const store = fixture(undefined, 'executing', true), before = snapshot(store.runDir);
      toolFrom(extension);
      assertUnchangedRun(store.runDir, before, 'missing runtime preserves all authoritative data');
      fs.rmSync(store.runDir, { recursive: true });
    });
    await scenario('conclusively dead PID, precise reason, idempotent recovery', () => {
      const store = fixture('2100000006:1'), original = store.loadReadOnly();
      const kill = process.kill;
      process.kill = (pid, signal) => { assert.equal(pid, 2100000006); assert.equal(signal, 0); throw Object.assign(Error('gone'), { code: 'ESRCH' }); };
      try {
        toolFrom(extension);
        const paused = store.loadReadOnly();
        assert.equal(paused.status, 'paused');
        assert.match(paused.pauseReason, /owning_host_pid_dead.*pid=2100000006.*ESRCH/);
        assert.ok(paused.currentApproval.invalidatedAt);
        assert.equal(paused.runtime.hostInstanceId, original.runtime.hostInstanceId, 'observer must not claim ownership');
        assert.deepEqual(paused.audit, original.audit, 'startup does not detach/kill/reassign workers');
        const before = snapshot(store.runDir);
        toolFrom(extension);
        assertUnchangedRun(store.runDir, before, 'repeat startup does not rewrite an already recovered run', { workerPids: [123, 456], manifestState: 'not started yet', observationErrors: ['PID 123: ERR_ASSERTION', 'PID 456: ERR_ASSERTION'] });
      } finally { process.kill = kill; fs.rmSync(store.runDir, { recursive: true }); }
    });
    for (const status of ['terminal', 'cancelled']) await scenario(status + ' immutable', () => {
      const store = fixture('2100000006:1', status), before = snapshot(store.runDir);
      toolFrom(extension);
      assertUnchangedRun(store.runDir, before, status + ' preserves all authoritative data');
      fs.rmSync(store.runDir, { recursive: true });
    });
    await scenario('real second host leaves live owning parent authoritative bytes identical', () => {
      const store = fixture(current), before = snapshot(store.runDir);
      fresh('startup');
      assertUnchangedRun(store.runDir, before, 'second host cannot change owning parent state/approval/workers');
      fs.rmSync(store.runDir, { recursive: true });
    });
    await scenario('filesystem and derived-status adversaries', () => {
      const store = fixture(current);
      const dir = store.runDir;
      // Seed tricky names so additions, edits AND deletions are filesystem tests,
      // not object literals that can share the snapshot's own key-handling bug.
      const authoritative = ['supervision.json', 'worker-result.bin', 'checkpoint-0001-plan.json',
        'survivor-evidence.json', 'unrelated.bin', '__proto__', 'constructor', 'prototype', 'nested/live-status.json'];
      fs.mkdirSync(path.join(dir, 'nested'));
      fs.mkdirSync(path.join(dir, 'empty-existing'));
      for (const name of authoritative.slice(3)) fs.writeFileSync(path.join(dir, name), 'protected ' + name);
      fs.writeFileSync(path.join(dir, 'survivor-evidence.json'), JSON.stringify({ pid: 456, phaseName: 'old-worker' }));
      const before = snapshot(dir);
      const baselineLive = JSON.parse(fs.readFileSync(path.join(dir, 'live-status.json'), 'utf8'));
      const options = { hostGoing: true, workerPids: baselineLive.activeWorkers.map(worker => worker.pid), observationErrors: baselineLive.observationErrors };
      const check = () => assertUnchangedRun(dir, before, 'all authoritative entries and meaningful derived fields remain protected', options);
      check();
      for (const name of authoritative) {
        const file = path.join(dir, name), bytes = fs.readFileSync(file);
        fs.writeFileSync(file, 'corrupted');
        assert.throws(check, assert.AssertionError, 'edit rejected: ' + name);
        fs.unlinkSync(file);
        assert.throws(check, assert.AssertionError, 'deletion rejected: ' + name);
        fs.writeFileSync(file, bytes);
        check();
      }
      for (const name of ['unexpected.bin', 'nested/__proto__', 'nested/constructor', 'nested/prototype']) {
        const file = path.join(dir, name);
        fs.writeFileSync(file, 'unexpected');
        assert.throws(check, assert.AssertionError, 'addition rejected: ' + name);
        fs.unlinkSync(file);
      }
      // Prove special TOP-LEVEL additions too, not only changed existing keys.
      for (const name of ['__proto__', 'constructor', 'prototype']) {
        const file = path.join(dir, name), bytes = fs.readFileSync(file);
        fs.unlinkSync(file);
        const without = snapshot(dir);
        fs.writeFileSync(file, bytes);
        assert.throws(() => assertUnchangedRun(dir, without, 'special addition: ' + name, options), assert.AssertionError);
      }
      for (const name of ['empty-new', 'nested/empty-new']) {
        const added = path.join(dir, name);
        fs.mkdirSync(added);
        assert.throws(check, assert.AssertionError, 'empty directory addition rejected: ' + name);
        fs.rmdirSync(added);
      }
      fs.rmdirSync(path.join(dir, 'empty-existing'));
      assert.throws(check, assert.AssertionError, 'empty directory deletion rejected');
      fs.mkdirSync(path.join(dir, 'empty-existing'));
      const liveFile = path.join(dir, 'live-status.json'), bytes = fs.readFileSync(liveFile), live = JSON.parse(bytes);
      const corruptions = {
        schemaVersion: 2, runId: 'wrong-run', observedAt: 'invalid-date', going: 'not going', phase: 'invented',
        activeWorkers: [{ pid: 999, phase: 'unowned', liveness: 'alive' }], heartbeatAt: null,
        activeSilenceAlarms: [{ commandId: 'invented', phase: 'executor' }], lastError: 'hidden failure',
        observationErrors: ['state.json: phase manifest unavailable', 'PID 999: invented'], extra: true,
      };
      for (const [key, value] of Object.entries(corruptions)) {
        fs.writeFileSync(liveFile, JSON.stringify({ ...live, [key]: value }));
        assert.throws(check, assert.AssertionError, 'derived corruption rejected: ' + key);
        fs.writeFileSync(liveFile, bytes);
      }
      fs.unlinkSync(liveFile);
      assert.throws(check, assert.AssertionError, 'derived publication deletion rejected');
      fs.mkdirSync(liveFile);
      assert.throws(check, assert.AssertionError, 'derived publication must not become a directory');
      fs.rmdirSync(liveFile);
      fs.writeFileSync(liveFile, bytes);
      check();
      fs.rmSync(dir, { recursive: true });
    });
    await scenario('real create, exited host recovery, approved resume ownership before worker', () => {
      const created = fresh('create');
      const state = JSON.parse(fs.readFileSync(path.join(runs, created.runId, 'supervision.json'), 'utf8'));
      assert.equal(Number(state.runtime.hostInstanceId.split(':')[0]), created.pid);
      const resumed = fresh('resume', { E_RUN_ID: created.runId, E_OLD_TOKEN: created.token });
      const log = fs.readFileSync(path.join(home, 'worker-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepEqual(log.map(item => item.ppid), [created.pid, resumed.pid]);
      assert.ok(log.every(item => item.root === runs && item.nextRoot === isolated.PI_ORCHESTRATOR_NEXT_RUNS_ROOT && item.agentDir === agentDir));
      assert.deepEqual(log.map(item => item.status), ['plan_checkpoint', 'executing']);
      assert.ok(log.every(item => item.extensions.length === 3), 'each real launch bootstraps monitor and frozen no-force-kill guard');
    });
  } finally {
    restore();
    assert.deepEqual(denied, [], 'no production/stand-in state accesses, including swallowed errors');
    assert.deepEqual(snapshot(sentinel), sentinelBefore, 'isolated shared-root sentinel untouched');
    fs.rmSync(home, { recursive: true, force: true });
  }
  assert.deepEqual(failures, [], 'E regression failures');
  console.log('test-round3-defect-e: all scenarios passed; TEMP fixtures cleaned; no shared-state access');
}
(childMode ? child() : parent()).catch(error => { console.error(error); process.exitCode = 1; });
