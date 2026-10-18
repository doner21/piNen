'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const deps = process.env.PI_WINDOW_FROZEN_DEPS;
if (!deps) throw Error('Set PI_WINDOW_FROZEN_DEPS to the read-only node_modules directory.');
const packageDir = path.join(deps, '@earendil-works', 'pi-coding-agent');
const { createJiti } = require(require.resolve('jiti', { paths: [packageDir] }));
const jiti = createJiti(__filename, { moduleCache: false, fsCache: false, alias: {
 '@earendil-works/pi-ai': path.join(packageDir, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'index.js'),
 '@earendil-works/pi-coding-agent': path.join(packageDir, 'dist', 'index.js')
} });
for (const stagedNew of [false, true]) test(stagedNew ? 'fresh staged new-project launch reaches production TUI and Telegram with bounded helpers and zero owned survivors' : 'production TUI launch has one runtime, at most one holder per protected leaf, and zero surviving descendants', async () => {
 let w = require('./window.cjs');
 const core = require('../extensions/telegram-pi/multi-session.cjs');
 const base = await fs.mkdtemp(path.join(await w.checkedDirectory(os.tmpdir()), 'pi-window-topology-'));
 let folder = path.join(base, 'home', 'parent', 'existing'), agentDir = path.join(base, 'agent'), runtimeRoot = path.join(base, 'runtime'), telegramRuntime = path.join(base, 'telegram');
 const log = path.join(base, 'processes.jsonl'), observer = path.join(base, 'observer.cjs'), extension = path.join(base, 'observed.ts');
 const instruction = '/quit @file --model fake ; & "hello" \n  ', sent = [], launcherChildren = [];
 const cp = require('node:child_process'), originalSpawn = cp.ChildProcess.prototype.spawn, originalSpawnFunction = cp.spawn;
 let service, request, staged;
 try {
  for (const dir of [folder, agentDir, runtimeRoot, telegramRuntime]) await fs.mkdir(dir, { recursive: true });
  const router = new core.Router({ dir: telegramRuntime, chatId: -100, allowlist: [101], api: { call: async (method, body) => { sent.push({ method, body }); return method === 'createForumTopic' ? { message_thread_id: 42 } : {}; } } });
  service = await core.serve({ router, token: 'fixture-' + require('node:crypto').randomUUID(), poll: false });
  if (stagedNew) {
   // Exercise the actual E2E source copier and its private session capability.
   // Only user configuration and the authenticated router/Bot API are fixtures.
   const userAgent = path.join(base, 'usual-agent'), root = path.join(base, 'staging');
   await fs.mkdir(path.join(userAgent, 'telegram-pi'), { recursive: true }); await fs.mkdir(root);
   await fs.writeFile(path.join(userAgent, 'settings.json'), JSON.stringify({ defaultProvider: 'window-fixture', defaultModel: 'usual' }));
   await fs.writeFile(path.join(userAgent, 'telegram-pi', 'deployment.json'), JSON.stringify({ version: 1, mode: 'topics', runtimeDir: telegramRuntime, chatId: -100, allowlist: [101], botUsername: 'fixture_bot' }));
   const source = (await fs.readFile(path.join(__dirname, 'e2e.cjs'), 'utf8')).split('const [action, dir] = process.argv.slice(2);')[0], output = [];
   const sandbox = { module: { exports: {} }, __dirname, process: { ...process, env: { ...process.env, PI_WINDOW_USER_AGENT: userAgent, PI_WINDOW_E2E_ROOT: root, PI_WINDOW_FROZEN_DEPS: deps } }, console: { log: value => output.push(value) }, require: id => id === '../extensions/telegram-pi/multi-session.cjs' ? { ...core, selectRuntime: dir => core.selectRuntime(dir, {}) } : require(id) };
   require('node:vm').runInNewContext(source + '\nmodule.exports = { stage };', sandbox);
   await sandbox.module.exports.stage();
   staged = JSON.parse(await fs.readFile(path.join(output[0], 'owned.json'), 'utf8'));
   // Replace only the Terminal boundary, not openWindow's production run path.
   // A hidden wt.exe forwards its hidden startup state to the new window.
   cp.spawn = (exe, args, options) => {
    if (exe !== 'wt.exe') return originalSpawnFunction(exe, args, options);
    assert.equal(options.windowsHide, false, 'the requested real Terminal WINDOW must not be hidden');
    request = JSON.parse(require('node:fs').readFileSync(args.at(-1), 'utf8'));
    const command = args.slice(args.indexOf('--inheritEnvironment') + 1);
    return originalSpawnFunction(command[0], command.slice(1), { ...options, env: { ...options.env, NODE_OPTIONS: '--require ' + JSON.stringify(observer) } });
   };
   w = require(path.join(staged.candidate, 'window', 'window.cjs'));
   ({ agentDir, runtimeRoot, telegramRuntime } = staged.config);
   folder = path.join(staged.config.projectsRoot, staged.name);
  }
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'window-fixture', defaultModel: 'usual', quietStartup: true, retry: { enabled: false } }));
  // Observe real process creation before SDK imports. Reject another bootstrap
  // BEFORE execution, so even a recursive production edge cannot run away.
  // EOF/exit observations apply to holders too; no timers or forced termination.
  await fs.writeFile(observer, `const fs = require('node:fs'), cp = require('node:child_process');
const log = value => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid,parent:process.ppid,...value})+'\\n');
log({event:'start',argv:process.argv}); process.on('exit',()=>log({event:'closed'}));
const spawn = cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn = function(options) {
 log({event:'spawn',file:options.file,args:options.args,cwd:options.cwd});
 if (options.args.some(arg => /[\\\\/]bootstrap\\.cjs$/.test(arg))) throw Error('Second bootstrap prevented');
 return spawn.call(this,options);
};`);
  await fs.writeFile(extension, `import telegramPi from ${JSON.stringify(path.join(staged ? staged.candidate : path.join(__dirname, '..'), 'extensions', 'telegram-pi', 'index.ts'))};
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { appendFileSync, readFileSync } from 'node:fs';
export default function(pi) {
 const log = value => appendFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid,parent:process.ppid,...value})+'\\n');
 pi.registerProvider('window-fixture', { baseUrl:'http://unused.invalid', api:'window-fixture', apiKey:'fixture-not-a-credential', models:[{id:'usual',name:'Fixture',reasoning:false,input:['text'],contextWindow:100000,maxTokens:100,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}], streamSimple(model) {
  const stream = createAssistantMessageEventStream(); queueMicrotask(()=> {
   const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[{type:'text',text:'hello'}],stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:1,cacheRead:0,cacheWrite:0,totalTokens:1,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
   stream.push({type:'start',partial:message}); stream.push({type:'done',reason:'stop',message}); stream.end();
  }); return stream;
 } });
 telegramPi(pi);
 pi.on('session_start',(_,ctx)=>log({event:'runtime',mode:ctx.mode,session:ctx.sessionManager.getSessionId()}));
 pi.on('agent_settled',(_,ctx)=> { log({event:'hello',sessionFile:ctx.sessionManager.getSessionFile()}); ctx.shutdown(); });
 pi.on('session_shutdown',()=>log({event:'shutdown'}));
}`);
  // The launcher still builds the real request/argv. Only wt.exe is replaced
  // by a piped terminal; bootstrap runs the installed InteractiveMode itself.
  const config = { ...(staged?.config || { home: path.join(base, 'home'), projectsRoot: path.join(base, 'home', 'projects'), runtimeRoot, agentDir, telegramRuntime, piCli: path.join(packageDir, 'dist', 'cli.js') }), telegramExtension: extension };
  cp.ChildProcess.prototype.spawn = function(options) {
   const result = originalSpawn.call(this, options);
   const record = { pid: this.pid, parent: process.pid, args: options.args, closed: false };
   launcherChildren.push(record); this.once('close', () => { record.closed = true; });
   if (options.args.some(a => /[\\/]pin\.cjs$/.test(a))) {
    let frame = ''; this.stdout.on('data', b => { frame += b; if (frame.includes('\n')) record.ready = JSON.parse(frame.split('\n')[0]); });
    this.stderr.on('data', b => { record.error = (record.error || '') + b; });
   }
   return result;
  };
  await w.openWindow({ mode: stagedNew ? 'new' : 'open', target: staged?.name || folder, instruction }, config, stagedNew ? {} : { launch: async spec => {
   request = JSON.parse(await fs.readFile(spec.requestFile, 'utf8'));
   const args = spec.args.slice(spec.args.indexOf('--inheritEnvironment') + 1);
   await w.run(args[0], args.slice(1), { env: { ...spec.env, NODE_OPTIONS: '--require ' + JSON.stringify(observer) } });
  } });
  cp.ChildProcess.prototype.spawn = originalSpawn;
  const records = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  const starts = records.filter(r => r.event === 'start'), runtimes = records.filter(r => r.event === 'runtime');
  assert.equal(starts.filter(r => r.argv.some(a => /[\\/]bootstrap\.cjs$/.test(a))).length, 1, 'one bootstrap only');
  assert.equal(runtimes.length, 1); assert.equal(runtimes[0].mode, 'tui');
  assert.equal(records.filter(r => r.event === 'shutdown').length, 1);
  assert.deepEqual(sent.filter(s => s.method === 'sendMessage').map(s => s.body.text), [instruction, 'hello']);
  const hello = records.find(r => r.event === 'hello'); assert.ok(hello);
  const entries = (await fs.readFile(hello.sessionFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(entries.find(e => e.type === 'message' && e.message?.role === 'user').message.content.map(p => p.text || '').join(''), instruction);
  // A cwd handle on a leaf prevents ancestor substitution on Windows. Verify
  // that actual guarantee separately below, rather than multiply Node holders
  // by path depth. Four independent project/state leaves need four holders.
  const holders = records.filter(r => r.event === 'spawn' && r.args.some(a => /[\\/]pin\.cjs$/.test(a)));
  const launcherHolders = launcherChildren.filter(r => r.args.some(a => /[\\/]pin\.cjs$/.test(a)));
  assert.ok(launcherChildren.every(r => r.closed), 'all launcher-owned children closed');
  const closed = new Set(records.filter(r => r.event === 'closed').map(r => r.pid));
  const all = JSON.parse(await w.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine)']));
  const ownedPids = new Set([...starts, ...launcherChildren].map(r => r.pid));
  assert.deepEqual(all.filter(p => ownedPids.has(p.ProcessId) || p.CommandLine?.includes(base)), [], 'no owned descendants, including children whose parent has exited');
  console.log('Owned production topology:', JSON.stringify({ runtimes: runtimes.length, lifetimeHolders: holders.length, launcherHolders: launcherHolders.length, survivors: 0 }));
  assert.equal(holders.length, 4, 'one holder per project/launch/agent/Telegram leaf, not per ancestor');
  assert.ok(starts.every(r => closed.has(r.pid)), 'every owned runtime/helper reached natural closure');
  const runtimeClosed = records.findIndex(r => r.event === 'closed' && r.pid === runtimes[0].pid);
  assert.ok(starts.filter(r => r.pid !== runtimes[0].pid).every(r => records.findIndex(e => e.event === 'closed' && e.pid === r.pid) < runtimeClosed), 'runtime disposal drains all holders before TUI process closure');
  assert.deepEqual(new Set(holders.map(r => r.cwd.toLowerCase())), new Set([folder, request.launchDir, agentDir, telegramRuntime].map(p => p.toLowerCase())));
  assert.ok(launcherHolders.every(r => r.ready && !r.error), 'every actual preparation/launcher helper published readiness');
  if (stagedNew) {
   assert.equal(await w.run('git', ['-C', folder, 'rev-parse', '--is-inside-work-tree']), 'true\n');
   assert.match(await fs.readFile(path.join(folder, 'AGENTS.md'), 'utf8'), /lean-working-method/);
   assert.equal(launcherHolders.length, 14, 'eleven finite project-preparation holders, then three launcher holders');
  } else assert.equal(launcherHolders.length, 3, 'one runtime-parent preparation holder, then two launcher leaves; none accumulate');
 } finally { cp.spawn = originalSpawnFunction; cp.ChildProcess.prototype.spawn = originalSpawn; await service?.close(); await fs.rm(base, { recursive: true, force: true }); }
});
test('one real cwd holder prevents replacement of the leaf and every owned ancestor', async () => {
 const w = require('./window.cjs'), { spawn } = require('node:child_process');
 const base = await fs.mkdtemp(path.join(await w.checkedDirectory(os.tmpdir()), 'pi-window-ancestors-'));
 const parent = path.join(base, 'parent'), leaf = path.join(parent, 'leaf'); let child;
 try {
  await fs.mkdir(leaf, { recursive: true });
  child = spawn(process.execPath, [path.join(__dirname, 'pin.cjs')], { cwd: leaf, stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  for (const dir of [base, parent, leaf]) await assert.rejects(fs.rename(dir, dir + '-moved'), /EPERM|EBUSY|EACCES/);
 } finally {
  if (child) await new Promise(resolve => { child.once('close', resolve); child.stdin.end(); });
  await fs.rm(base, { recursive: true, force: true });
 }
});
test('full bootstrap uses production Telegram factory, real IPC and persisted first message without startup mutations', async () => {
 const w = require('./window.cjs'), core = require('../extensions/telegram-pi/multi-session.cjs');
 const base = await fs.mkdtemp(path.join(await w.checkedDirectory(os.tmpdir()), 'pi-window-production-'));
 const folder = path.join(base, 'home', 'existing'), agentDir = path.join(base, 'agent'), runtimeRoot = path.join(base, 'runtime'), telegramRuntime = path.join(base, 'telegram');
 const instruction = '/quit @file --model fake ; & "hello" \n  ';
 const sent = []; let watcher, service, nextTopic = 41; const events = [];
 const snapshot = async dir => {
  const result = {};
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
   const file = path.join(dir, entry.name), st = await fs.stat(file);
   result[entry.name] = entry.isDirectory() ? await snapshot(file) : { text: await fs.readFile(file, 'utf8'), mtime: st.mtimeMs, ctime: st.ctimeMs };
  }
  return result;
 };
 try {
  await fs.mkdir(path.join(folder, '.pi', 'commands'), { recursive: true }); await fs.mkdir(agentDir); await fs.mkdir(runtimeRoot); await fs.mkdir(telegramRuntime);
  await fs.writeFile(path.join(folder, '.pi', 'settings.json'), JSON.stringify({ sessionDir: './forbidden', packages: ['npm:must-not-install'] }));
  await fs.writeFile(path.join(folder, '.pi', 'commands', 'sentinel.md'), 'Never migrate.');
  await fs.writeFile(path.join(folder, 'AGENTS.md'), 'Startup fixture.');
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'window-fixture', defaultModel: 'usual', packages: ['npm:must-not-install'], sessionDir: path.join(folder, 'forbidden'), retry: { enabled: false } }));
  const extension = path.join(base, 'observed.ts'), runner = path.join(base, 'runner.cjs');
  // The real factory owns all topic lifecycle, first-turn and privacy behavior.
  // Only model and Bot API boundaries are local fixtures. Observations add no
  // readiness, persistence, dispatch or replacement Telegram implementation.
  await fs.writeFile(extension, `import telegramPi from ${JSON.stringify(path.join(__dirname, '..', 'extensions', 'telegram-pi', 'index.ts'))};
import { core } from ${JSON.stringify(path.join(__dirname, '..', 'extensions', 'telegram-pi', 'topic-session.ts'))};
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { readFileSync, existsSync } from 'node:fs';
export default function(pi) {
 const launch = JSON.parse(readFileSync(process.env.PI_WINDOW_REQUEST, 'utf8'));
 pi.registerProvider('window-fixture', { baseUrl: 'http://unused.invalid', api: 'window-fixture', apiKey: 'fixture-not-a-credential', models: [{ id: 'usual', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], streamSimple(model) {
  if (!existsSync(launch.readyFile)) throw Error('Acceptance must not await the model reply.');
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
   const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [{type:'text',text:'hello'}], stopReason: 'stop', timestamp: Date.now(), usage: {input:0,output:1,cacheRead:0,cacheWrite:0,totalTokens:1,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}} };
   stream.push({type:'start',partial:message}); stream.push({type:'done',reason:'stop',message}); stream.end();
  }); return stream;
 } });
 const request = core.Client.prototype.request;
 core.Client.prototype.request = async function(action, params) {
  if (action === 'logon') {
   // Race a genuine runtime submission across an asynchronous logon boundary.
   pi.sendUserMessage('private startup input', {expandPromptTemplates:false});
  }
  return request.call(this, action, params);
 };
 telegramPi(pi);
}`);
  await fs.writeFile(runner, `const fs = require('node:fs/promises');
require(${JSON.stringify(path.join(__dirname, 'bootstrap.cjs'))}).main(process.argv[2], { present: async runtime => {
 const session = runtime.session;
 const failed = process.argv[3] === 'auth-failure';
 const finished = new Promise(resolve => {
  const off = failed ? session.extensionRunner.onError(e => { if (e.event === 'send_user_message') { off(); resolve(); } }) : session.subscribe(e => { if (e.type === 'agent_settled') { off(); resolve(); } });
 });
 if (failed) {
  runtime.services.modelRuntime.hasConfiguredAuth = () => false;
  runtime.services.modelRuntime.checkAuth = async () => undefined;
 }
 await session.bindExtensions({mode:'tui'});
 if (failed) { await finished; await runtime.dispose(); return; }
 if (process.argv[3] === 'empty') { await runtime.dispose(); return; }
 await finished; await session.waitForIdle();
 await session.sendUserMessage('later private input', {expandPromptTemplates:false});
 const r = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
 await session.sendUserMessage(r.instruction, {expandPromptTemplates:false});
 await fs.writeFile(r.launchDir + '/observed.json', JSON.stringify({ cwd: runtime.cwd, sessionFile: session.sessionManager.getSessionFile(), model: session.model.id, parent: session.sessionManager.getHeader().parentSession }));
 await runtime.dispose();
} });`);
  const router = new core.Router({ dir: telegramRuntime, chatId: -100, allowlist: [101], api: { call: async (method, body) => { sent.push({ method, body }); return method === 'createForumTopic' ? { message_thread_id: ++nextTopic } : {}; } } });
  service = await core.serve({ router, token: 'fixture-' + require('node:crypto').randomUUID(), poll: false });
  const before = await snapshot(folder);
  watcher = require('node:fs').watch(folder, { recursive: true }, (_, file) => events.push(String(file)));
  const config = { home: path.join(base, 'home'), projectsRoot: path.join(base, 'home', 'projects'), runtimeRoot, agentDir, telegramRuntime, telegramExtension: extension, piCli: path.join(packageDir, 'dist', 'cli.js') };
  let request;
  const result = await w.openWindow({ mode: 'open', target: folder, instruction }, config, { launch: async spec => {
   request = JSON.parse(await fs.readFile(spec.requestFile, 'utf8'));
   await w.run(process.execPath, [runner, spec.requestFile], { env: { ...spec.env, PI_OFFLINE: '1', JITI_FS_CACHE: '0', NODE_DISABLE_COMPILE_CACHE: '1' } });
  } });
  assert.equal(result.topic, 42);
  const observation = JSON.parse(await fs.readFile(path.join(request.launchDir, 'observed.json'), 'utf8'));
  assert.equal(observation.cwd, folder); assert.equal(observation.model, 'usual'); assert.equal(observation.parent, undefined);
  assert.equal(w.inside(request.launchDir, observation.sessionFile), true);
  const entries = (await fs.readFile(observation.sessionFile, 'utf8')).trim().split('\n').map(JSON.parse);
  const users = entries.filter(e => e.type === 'message' && e.message?.role === 'user').map(e => e.message.content.map(p => p.text || '').join(''));
  assert.deepEqual(users, [instruction, 'later private input', instruction]);
  assert.deepEqual(sent.filter(s => s.method === 'sendMessage').map(s => s.body.text), [instruction, 'hello']);
  assert.equal(router.status().sessions.length, 1); assert.equal(router.status().sessions[0].online, false);
  assert.deepEqual(await snapshot(folder), before); assert.deepEqual(events, []);
  await assert.rejects(w.openWindow({ mode: 'open', target: folder, instruction }, config, { launch: spec => w.run(process.execPath, [runner, spec.requestFile, 'auth-failure'], { env: spec.env }) }), /not accepted/i);
  assert.deepEqual(sent.filter(s => s.method === 'sendMessage').map(s => s.body.text), [instruction, 'hello', instruction], 'failed preflight has no successful reply or acceptance');
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'window-fixture', defaultModel: 'missing' }));
  await assert.rejects(w.openWindow({ mode: 'open', target: folder, instruction }, config, { launch: spec => w.run(process.execPath, [runner, spec.requestFile], { env: spec.env }) }), /startup/i);
  assert.equal(router.status().sessions.length, 2, 'unavailable configured default must not start another topic');
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'window-fixture', defaultModel: 'usual' }));
  assert.equal((await w.openWindow({ mode: 'open', target: folder }, config, { launch: spec => w.run(process.execPath, [runner, spec.requestFile, 'empty'], { env: spec.env }) })).topic, 44);
  assert.equal(router.status().sessions.length, 3, 'instruction-free startup still logs on its own topic');
  assert.equal(new Set(router.status().sessions.map(s => s.id)).size, 3);
  assert.equal(new Set(router.status().sessions.map(s => s.topic)).size, 3);
  assert.deepEqual(sent.filter(s => s.method === 'sendMessage').map(s => s.body.text), [instruction, 'hello', instruction]);
  assert.deepEqual(await snapshot(folder), before); assert.deepEqual(events, []);
 } finally { watcher?.close(); await service?.close(); await fs.rm(base, { recursive: true, force: true }); }
});
test('launch confirmation waits for the actual accepted first user event', async () => {
 const base = await fs.mkdtemp(path.join(await require('./window.cjs').checkedDirectory(os.tmpdir()), 'pi-window-acceptance-'));
 const { TopicSession, core } = await jiti.import('../extensions/telegram-pi/topic-session.ts');
 const prior = process.env.PI_WINDOW_REQUEST, OldClient = core.Client; const handlers = {};
 core.Client = class { async request() { return { topic: 42, label: 'demo' }; } async close() {} };
 const request = { nonce: 'fixture', folder: base, label: 'demo', instruction: '@literal  ', readyFile: path.join(base, 'ready.json') };
 try {
  const file = path.join(base, 'request.json'); await fs.writeFile(file, JSON.stringify(request)); process.env.PI_WINDOW_REQUEST = file;
  const topic = new TopicSession({ on: (name, fn) => { handlers[name] = fn; }, sendUserMessage() {} }, base, '', () => '', async () => {});
  try {
   await topic.start({ mode: 'tui', cwd: base, sessionManager: { getSessionId: () => 'fresh', getHeader: () => ({}), getSessionFile: () => undefined, getSessionName: () => '' } });
   await assert.rejects(fs.access(request.readyFile), /ENOENT/, 'void dispatch alone is not accepted first-message confirmation');
   assert.equal(typeof handlers.message_end, 'function');
   await handlers.message_end({ message: { role: 'user', content: [{ type: 'text', text: request.instruction }] } });
   assert.equal(JSON.parse(await fs.readFile(request.readyFile, 'utf8')).topic, 42);
  } finally { await topic.shutdown(); }
 } finally { core.Client = OldClient; if (prior === undefined) delete process.env.PI_WINDOW_REQUEST; else process.env.PI_WINDOW_REQUEST = prior; await fs.rm(base, { recursive: true, force: true }); }
});
test('real TopicSession launch first-turn only, literal prompt and privacy', async () => {
 const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pi-window-adapter-'));
 const prior = process.env.PI_WINDOW_REQUEST;
 const { TopicSession, core } = await jiti.import('../extensions/telegram-pi/topic-session.ts');
 const OldClient = core.Client; const calls = [], prompts = []; let inboundOnLogon = false;
 core.Client = class {
  constructor(options) { this.onDelivery = options.onDelivery; }
  async request(action, params) {
   calls.push({ action, params });
   if (action === 'logon') {
    if (inboundOnLogon) await this.onDelivery({ session: 'fresh', ticket: 'tg-fixture', text: 'Telegram work' });
    return { label: 'demo', topic: 42 };
   }
   if (action === 'send' && inboundOnLogon && params.text.startsWith('/quit')) await this.onDelivery({ session: 'fresh', ticket: 'tg-fixture', text: 'Telegram work' });
   return null;
  }
  async close() {}
 };
 const request = { nonce: 'fixture', folder: base, label: 'demo', instruction: '/quit @file --model fake ; & "hello"', readyFile: path.join(base, 'ready.json') };
 try {
  const requestFile = path.join(base, 'request.json'); await fs.writeFile(requestFile, JSON.stringify(request)); process.env.PI_WINDOW_REQUEST = requestFile;
  const handlers = {};
  const topic = new TopicSession({ on: (name, handler) => { handlers[name] = handler; }, sendUserMessage: (text, opts) => prompts.push({ text, opts }) }, base, '', () => 'Telegram work', async () => {});
  const ctx = { mode: 'tui', cwd: base, model: { provider: 'generic', id: 'default' }, isIdle: () => true, sessionManager: { getSessionId: () => 'fresh', getSessionFile: () => undefined, getHeader: () => ({}), getSessionName: () => '' } };
  await topic.start(ctx);
  assert.equal(calls.some(c => c.action === 'inherit'), false);
  assert.deepEqual(prompts, [{ text: request.instruction, opts: { deliverAs: 'followUp', expandPromptTemplates: false } }]);
  await handlers.message_end({ message: { role: 'user', content: [{ type: 'text', text: request.instruction }] } });
  assert.equal(JSON.parse(await fs.readFile(request.readyFile, 'utf8')).topic, 42);
  const end = text => ({ messages: [{ role: 'assistant', content: [{ type: 'text', text }] }] });
  topic.before(request.instruction); await topic.end(end('requested hello'));
  topic.before('private local turn'); await topic.end(end('private reply'));
  assert.equal(calls.filter(c => c.action === 'send' && c.params.text === 'requested hello').length, 1);
  assert.equal(calls.some(c => c.params?.text === 'private reply'), false);
  topic.before(request.instruction); await topic.end(end('repeated private turn'));
  assert.equal(calls.some(c => c.params?.text === 'repeated private turn'), false);
  await topic.shutdown();
  await fs.unlink(request.readyFile); process.env.PI_WINDOW_REQUEST = requestFile;
  await topic.start(ctx);
  await handlers.message_end({ message: { role: 'user', content: [{ type: 'text', text: request.instruction }] } });
  topic.before(request.instruction);
  assert.equal(typeof handlers.input, 'function');
  handlers.input({ text: 'private steering', source: 'interactive' });
  await topic.end(end('mixed private answer'));
  assert.equal(calls.some(c => c.params?.text === 'mixed private answer'), false);
  await topic.shutdown();
  await fs.unlink(request.readyFile); process.env.PI_WINDOW_REQUEST = requestFile;
  inboundOnLogon = true; const count = prompts.length;
  await topic.start(ctx);
  assert.deepEqual(prompts.slice(count).map(p => p.text), [request.instruction]);
  await topic.shutdown();
 } finally { core.Client = OldClient; if (prior === undefined) delete process.env.PI_WINDOW_REQUEST; else process.env.PI_WINDOW_REQUEST = prior; await fs.rm(base, { recursive: true, force: true }); }
});
test('real extension tool and quoted command both call shared launcher', async () => {
 const w = require('./window.cjs'), original = w.openWindow;
 const called = [], commands = {}, tools = [];
 w.openWindow = async input => { called.push(input); return { label: 'demo', topic: 42 }; };
 try {
  const mod = await jiti.import('../extensions/window/index.ts');
  mod.default({ on() {}, registerTool: tool => tools.push(tool), registerCommand: (name, spec) => { commands[name] = spec; } });
  await commands.window.handler('open "folder with spaces" hello', { ui: { notify() {} } });
  await tools[0].execute('id', { mode: 'new', target: 'demo', instruction: '@literal \n  ' });
  assert.deepEqual(called, [{ mode: 'open', target: 'folder with spaces', instruction: 'hello' }, { mode: 'new', target: 'demo', instruction: '@literal \n  ' }]);
 } finally { w.openWindow = original; }
});
test('installed TUI editor submission preserves only the window command literal suffix', async () => {
 const { pathToFileURL } = require('node:url');
 const sdk = await import(pathToFileURL(path.join(packageDir, 'dist', 'index.js')).href);
 const w = require('./window.cjs'), original = w.openWindow;
 const calls = [], commands = {}, handlers = {}; let factory;
 w.openWindow = async input => { calls.push(input); return { label: 'demo', topic: 42 }; };
 const prior = process.env.PI_WINDOW_REQUEST; delete process.env.PI_WINDOW_REQUEST;
 try {
  const mod = await jiti.import('../extensions/window/index.ts');
  mod.default({ on: (name, handler) => { handlers[name] = handler; }, registerTool() {}, registerCommand: (name, spec) => { commands[name] = spec; } });
  const ctx = { mode: 'tui', hasUI: true, ui: { notify() {}, setEditorComponent: f => { factory = f; } } };
  await handlers.session_start({}, ctx);
  const tui = { requestRender() {}, terminal: { columns: 100, rows: 40 } };
  const theme = { borderColor: s => s, selectList: { selectedPrefix: s => s, selectedText: s => s, description: s => s, scrollInfo: s => s, noMatch: s => s } };
  const { KeybindingsManager } = await import(pathToFileURL(path.join(packageDir, 'dist', 'core', 'keybindings.js')).href);
  const kb = new KeybindingsManager({ 'app.message.followUp': 'alt+enter' });
  const editor = factory ? factory(tui, theme, kb) : new sdk.CustomEditor(tui, theme, kb);
  const ordinary = [];
  // Real InteractiveMode installs the second trim boundary, not a hand-written
  // approximation. Normal submission is observed at its onInputCallback.
  const mode = { defaultEditor: editor, editor, session: {}, flushPendingBashComponents() {}, onInputCallback: text => {
   if (text.startsWith('/window ')) void commands.window.handler(text.slice(8), ctx);
   else ordinary.push(text);
  } };
  sdk.InteractiveMode.prototype.setupEditorSubmitHandler.call(mode);
  const instruction = '@literal /quit --model fake ; & "hello" \n  ';
  editor.setText('/window open "folder with spaces" ' + instruction); editor.handleInput('\r');
  assert.deepEqual(calls, [{ mode: 'open', target: 'folder with spaces', instruction }]);
  editor.setText('unrelated private conversation  '); editor.handleInput('\r');
  editor.setText('/window new demo second  '); editor.handleInput('\r');
  assert.deepEqual(ordinary, ['unrelated private conversation']);
  assert.equal(calls[1].instruction, 'second  ');
  editor.setText('/window new demo follow-up  '); editor.handleInput('\x1b\r');
  assert.equal(calls[2].instruction, 'follow-up  ');
  assert.equal(calls.length, 3);
 } finally { w.openWindow = original; if (prior === undefined) delete process.env.PI_WINDOW_REQUEST; else process.env.PI_WINDOW_REQUEST = prior; }
});
test('E2E staging privately copies only the existing-router session capability', async () => {
 const vm = require('node:vm'), w = require('./window.cjs'), core = require('../extensions/telegram-pi/multi-session.cjs');
 const base = await fs.mkdtemp(path.join(await w.checkedDirectory(os.tmpdir()), 'pi-window-stage-'));
 const userAgent = path.join(base, 'user-agent'), router = path.join(base, 'router'), root = path.join(base, 'staging'); const output = [];
 try {
  await fs.mkdir(path.join(userAgent, 'telegram-pi'), { recursive: true }); await fs.mkdir(router); await fs.mkdir(root);
  await fs.writeFile(path.join(userAgent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'usual' }));
  await fs.writeFile(path.join(userAgent, 'auth.json'), '{"fixture":{"type":"api_key","key":"fixture-not-a-credential"}}');
  await fs.writeFile(path.join(userAgent, 'telegram-pi', 'deployment.json'), JSON.stringify({ version: 1, mode: 'topics', runtimeDir: router, chatId: -100, allowlist: [101], botUsername: 'fixture_bot' }));
  const capability = JSON.stringify({ endpoint: 'fixture-not-a-listener', key: 'a'.repeat(64), pid: process.pid });
  await fs.writeFile(path.join(router, 'router-endpoint.json'), capability);
  await fs.writeFile(path.join(router, 'router-control.json'), 'operator capability must not be copied');
  const source = (await fs.readFile(path.join(__dirname, 'e2e.cjs'), 'utf8')).split('const [action, dir] = process.argv.slice(2);')[0];
  const sandbox = { module: { exports: {} }, __dirname, process: { ...process, env: { ...process.env, PI_WINDOW_USER_AGENT: userAgent, PI_WINDOW_E2E_ROOT: root, PI_WINDOW_FROZEN_DEPS: deps } }, console: { log: value => output.push(value) }, require: id => id === '../extensions/telegram-pi/multi-session.cjs' ? { ...core, selectRuntime: dir => core.selectRuntime(dir, {}) } : require(id) };
  vm.runInNewContext(source + '\nmodule.exports = { stage };', sandbox);
  await sandbox.module.exports.stage();
  const info = JSON.parse(await fs.readFile(path.join(output[0], 'owned.json'), 'utf8'));
  assert.equal(w.inside(info.dir, info.config.telegramRuntime), true, 'session uses a private descriptor copy, not live configuration');
  assert.equal(await fs.readFile(path.join(info.config.telegramRuntime, 'router-endpoint.json'), 'utf8'), capability);
  assert.deepEqual(await fs.readdir(info.config.telegramRuntime), ['router-endpoint.json']);
  assert.equal(await fs.readFile(path.join(router, 'router-endpoint.json'), 'utf8'), capability);
 } finally { await fs.rm(base, { recursive: true, force: true }); }
});
test('E2E rejects a local hello without correlated successful Telegram acknowledgements', async () => {
 const vm = require('node:vm');
 const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'owned-window-'));
 const sessionFile = path.join(base, 'runtime', 'session.jsonl');
 const info = { dir: base, name: 'window-e2e-abcd', marker: 'WINDOW-HELLO-fixture', instruction: 'Literal /quit @file ; & "hello"', expectedModel: { provider: 'generic', id: 'usual' }, config: { runtimeRoot: path.join(base, 'runtime'), telegramRuntime: base } };
 const binding = { id: 'owned-session', label: info.name, topic: 42, pid: 2147483646, online: false, model: 'generic/usual' };
 const response = { text: info.marker, sessionId: binding.id, sessionFile, provider: 'generic', model: 'usual', assistants: [{ provider: 'generic', model: 'usual', stopReason: 'stop' }] };
 const sends = [info.instruction, info.marker].map(text => ({ action: 'send', text, sessionId: binding.id, topic: 42, ok: true }));
 const started = { pid: binding.pid, mode: 'tui', sessionId: binding.id, provider: 'generic', model: 'usual', title: info.name };
 const terminal = { windows: [{ title: 'Pi - ' + info.name, handle: 123, pid: binding.pid }] };
 const processes = [{ pid: binding.pid, parent: 1, created: 'fixture-root', name: 'node.exe', kind: 'runtime', command: path.join(base, 'candidate', 'window', 'bootstrap.cjs') + ' request.json' }, ...[1, 2, 3, 4].map(n => ({ pid: binding.pid - n, parent: binding.pid, created: 'fixture-holder-' + n, name: 'node.exe', kind: 'holder', command: path.join(base, 'candidate', 'window', 'pin.cjs') })), ...[1, 2, 3, 4].map(n => ({ pid: binding.pid - 10 - n, parent: binding.pid - n, created: 'fixture-console-' + n, name: 'conhost.exe', kind: 'consoleHost', command: 'conhost.exe 0xffffffff -ForceV1' }))];
 let visibleOwnedHandle = false, survivors = [];
 const write = (file, value) => fs.writeFile(path.join(base, file), JSON.stringify(value));
 try {
  await fs.mkdir(info.config.runtimeRoot);
  await write('owned.json', info); await write('response.json', response); await write('closed.json', { graceful: true });
  await write('started.json', started); await write('terminal.json', terminal); await write('processes-started.json', { processes });
  await write('launched.json', { topic: 42 });
  await fs.writeFile(sessionFile, JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: info.instruction }] } }) + '\n');
  const source = (await fs.readFile(path.join(__dirname, 'e2e.cjs'), 'utf8')).split('const [action, dir] = process.argv.slice(2);')[0];
  const realWindow = require('./window.cjs');
  const sandbox = { module: { exports: {} }, __dirname, process, console: { log() {} }, require: id => id === '../extensions/telegram-pi/multi-session.cjs' ? { ...require(id), Client: class { async request() { return { sessions: [binding] }; } async close() {} } } : id === './window.cjs' ? { ...realWindow, run: (exe, args) => args.at(-1).includes('UIAutomationClient') ? Promise.resolve(visibleOwnedHandle ? JSON.stringify(terminal.windows) : '[]') : args.at(-1).includes('Get-CimInstance') ? Promise.resolve(JSON.stringify({ observer: 999, processes: survivors })) : realWindow.run(exe, args) } : require(id) };
  vm.runInNewContext(source + '\nmodule.exports = { observe, ownedProcesses, startupProcessCounts };', sandbox);
  const { observe, ownedProcesses, startupProcessCounts } = sandbox.module.exports;
  assert.equal(startupProcessCounts(processes, binding.pid).consoleHosts, 4, 'the real Terminal topology includes one owned Windows console host per holder');
  assert.throws(() => startupProcessCounts([...processes, { pid: 99, kind: 'other' }], binding.pid), /topology/);
  assert.throws(() => startupProcessCounts([...processes, { ...processes.at(-1), pid: 99 }], binding.pid), /topology/, 'no extra console host for the same holder');
  survivors = [...processes, { pid: process.pid, parent: 1, created: 'observer', name: 'node.exe', command: path.join(base, 'candidate', 'window', 'e2e.cjs') + ' observe ' + base + '/' }];
  const observed = await ownedProcesses(info, [], binding.pid);
  assert.equal(observed.filter(p => p.kind === 'consoleHost').length, 4, 'console hosts are classified only through positively owned runtime/helper parents');
  assert.equal(observed.some(p => p.pid === process.pid), false, 'the external observation is not an owned survivor');
  survivors = [{ ...processes[1], created: 'reused-pid' }];
  assert.equal((await ownedProcesses(info, processes)).length, 0, 'remembered PID with another creation identity is not owned');
  survivors = [...processes, { pid: 98, parent: binding.pid, created: 'unexpected-console-parent', name: 'other.exe', command: 'other.exe' }, { pid: 99, parent: 98, created: 'unexpected-console', name: 'conhost.exe', command: 'conhost.exe' }];
  assert.equal((await ownedProcesses(info, [], binding.pid)).find(p => p.pid === 99).kind, 'other', 'unknown console topology is not broadly exempted');
  survivors = [];
  await write('transport.json', []);
  await assert.rejects(() => observe(base), /acknowledg|delivery|transport/i);
  await write('transport.json', [sends[0], { ...sends[1], ok: false }]);
  await assert.rejects(() => observe(base), /acknowledg|delivery|transport/i);
  await write('transport.json', [sends[0], { ...sends[1], sessionId: 'other-session' }]);
  await assert.rejects(() => observe(base), /acknowledg|delivery|transport/i);
  await write('transport.json', [sends[0], { ...sends[1], topic: 99 }]);
  await assert.rejects(() => observe(base), /acknowledg|delivery|transport/i);
  await write('transport.json', sends);
  await observe(base);
  survivors = [{ ...processes[1], parent: 1 }];
  await assert.rejects(() => observe(base), /descendant closure/i, 'orphan helper is still owned after root exit');
  survivors = [];
  visibleOwnedHandle = true;
  await assert.rejects(() => observe(base), /window closure/i);
  visibleOwnedHandle = false;
  await write('terminal.json', { windows: [] });
  await assert.rejects(() => observe(base), /window closure/i);
  await write('terminal.json', { windows: [{ ...terminal.windows[0], handle: 0 }] });
  await observe(base); // an actual unique-title observation suffices without a native handle
  await write('terminal.json', terminal);
  await fs.writeFile(sessionFile, JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'not literal' }] } }) + '\n');
  await assert.rejects(() => observe(base), /first.*user|literal/i);
  await fs.writeFile(sessionFile, JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: info.instruction }] } }) + '\n');
  await write('response.json', { ...response, provider: 'unexpected' });
  await assert.rejects(() => observe(base), /model|provider|route/i);
  await write('response.json', response);
  binding.pid = process.pid;
  await write('started.json', { pid: process.pid, mode: 'tui', sessionId: binding.id, provider: 'generic', model: 'usual' });
  await assert.rejects(() => observe(base), /process|closure/i);
 } finally { await fs.rm(base, { recursive: true, force: true }); }
});
test('window entrypoint refuses confirmation if Telegram adapter did not start', async () => {
 const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pi-window-missing-adapter-'));
 const prior = process.env.PI_WINDOW_REQUEST; const handlers = {};
 try {
  const request = { nonce: 'fixture', readyFile: path.join(base, 'ready.json') };
  const file = path.join(base, 'request.json'); await fs.writeFile(file, JSON.stringify(request)); process.env.PI_WINDOW_REQUEST = file;
  const mod = await jiti.import('../extensions/window/index.ts');
  mod.default({ on: (name, handler) => { handlers[name] = handler; }, registerTool() {}, registerCommand() {} });
  assert.equal(typeof handlers.session_start, 'function');
  await handlers.session_start({}, {});
  assert.match(JSON.parse(await fs.readFile(request.readyFile, 'utf8')).error, /Telegram/);
 } finally { if (prior === undefined) delete process.env.PI_WINDOW_REQUEST; else process.env.PI_WINDOW_REQUEST = prior; await fs.rm(base, { recursive: true, force: true }); }
});
