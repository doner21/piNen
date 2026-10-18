'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const w = require('./window.cjs');
const { Router, Client, serve } = require('../extensions/telegram-pi/multi-session.cjs');
async function fixture(fn) {
 const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pi-window-test-'));
 try {
  const home = path.join(base, 'home'); await fs.mkdir(home);
  const projectsRoot = path.join(home, 'projects'); await fs.mkdir(projectsRoot);
  const runtimeRoot = path.join(base, 'runtime'); await fs.mkdir(runtimeRoot);
  await fn({ base, home, projectsRoot, runtimeRoot, leanMethod: path.join(home, 'lean.md') });
 } finally { await fs.rm(base, { recursive: true, force: true }); }
}
test('local roots/defaults follow configuration without hardcoded user paths', async () => fixture(async c => {
 const agentDir = path.join(c.base, 'agent'); const file = path.join(c.base, 'window.json');
 await fs.writeFile(file, JSON.stringify({ home: c.home, agentDir, piCli: path.join(c.base, 'cli.js') }));
 const config = await w.loadConfig({ PI_WINDOW_CONFIG: file });
 assert.equal(config.projectsRoot, path.join(c.home, 'projects'));
 assert.equal(config.telegramExtension, path.join(agentDir, 'extensions', 'telegram-pi', 'index.ts'));
 assert.equal(config.leanMethod, path.join(agentDir, 'docs', 'lean-working-method.md'));
}));
test('bad names and reserved devices refused before effects', () => {
 for (const name of ['', '.', '..', '../escape', 'a/b', 'a\\b', 'a b', 'é', 'a.', 'a:', 'CON', 'nul', 'COM1', 'LPT9', 'CONIN$', 'A\0B']) assert.throws(() => w.validateName(name));
 for (const name of ['demo', 'A-12', 'com10']) assert.equal(w.validateName(name), name);
});
test('quoted command keeps instruction literal, no shell or option parsing', () => {
 const instruction = '@file --model fake ; & "hello" /quit';
 assert.deepEqual(w.parseCommand('open "project with spaces" ' + instruction), { mode: 'open', target: 'project with spaces', instruction });
 assert.deepEqual(w.parseCommand('new demo --flag'), { mode: 'new', target: 'demo', instruction: '--flag' });
 assert.throws(() => w.parseCommand('open "unterminated'));
});
test('existing folder resolves by bare name; contents and project settings unchanged', async () => fixture(async c => {
 const dir = path.join(c.projectsRoot, 'existing folder'); await fs.mkdir(dir); await fs.mkdir(path.join(dir, '.pi'));
 await fs.writeFile(path.join(dir, '.pi', 'settings.json'), '{"sessionDir":"./forbidden"}');
 const before = await fs.readFile(path.join(dir, '.pi', 'settings.json'), 'utf8');
 assert.equal(await w.resolveFolder('existing folder', c), await fs.realpath(dir));
 await assert.rejects(w.prepareProject('existing folder', c));
 assert.equal(await fs.readFile(path.join(dir, '.pi', 'settings.json'), 'utf8'), before);
 assert.deepEqual(await fs.readdir(dir), ['.pi']);
 await assert.rejects(w.resolveFolder(c.base, c));
 await assert.rejects(w.resolveFolder('missing', c));
}));
test('opening a folder containing the configured runtime refuses before any writes', async () => fixture(async c => {
 const folder = path.join(c.home, 'opened'); await fs.mkdir(folder);
 await assert.rejects(w.openWindow({ mode: 'open', target: folder }, { ...c, runtimeRoot: path.join(folder, 'state') }, { launch: async () => { throw Error('must not launch'); } }));
 assert.deepEqual(await fs.readdir(folder), []);
}));
test('exclusive git project creation and duplicate refusal', async () => fixture(async c => {
 const dir = await w.prepareProject('demo', c);
 assert.equal(dir, path.join(c.projectsRoot, 'demo'));
 assert.match(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8'), /lean/);
 assert.equal((await w.run('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'])).trim(), 'true');
 await assert.rejects(w.prepareProject('demo', c));
}));
test('junction/symlink/traversal and ancestor replacement cannot escape', async () => fixture(async c => {
 const outside = path.join(c.base, 'outside'); await fs.mkdir(outside);
 await fs.symlink(outside, path.join(c.projectsRoot, 'alias'), 'junction');
 await assert.rejects(w.prepareProject('alias', c));
 await assert.rejects(w.prepareProject('../escape', c));
 await assert.rejects(w.resolveFolder('alias', c));
 const original = c.projectsRoot; const moved = original + '-moved';
 await w.withPinned(original, async () => {
  await assert.rejects(fs.rename(original, moved));
 });
 await fs.rename(original, moved); await fs.symlink(outside, original, 'junction');
 await assert.rejects(w.prepareProject('escape', c));
 assert.deepEqual(await fs.readdir(outside), []);
}));
test('racing substitution at exclusive creation refuses without outside writes', async () => fixture(async c => {
 const outside = path.join(c.base, 'outside'); await fs.mkdir(outside);
 await assert.rejects(w.prepareProject('race', c, { afterCreate: async dir => {
  await fs.rename(dir, dir + '-moved'); await fs.symlink(outside, dir, 'junction');
 }}));
 assert.deepEqual(await fs.readdir(outside), []);
}));
test('git seed runtime replacement refuses before any transient outside writes', async () => fixture(async c => {
 const outside = path.join(c.base, 'outside'); await fs.mkdir(outside); const events = [];
 const watcher = require('node:fs').watch(outside, { recursive: true }, (_, file) => events.push(String(file)));
 try {
  await assert.rejects(w.prepareProject('state-race', c, { afterRuntime: async runtime => {
   await fs.rename(runtime, runtime + '-moved'); await fs.symlink(outside, runtime, 'junction');
  }}), /aliases|junction|changed/i);
  assert.deepEqual(events, []); assert.deepEqual(await fs.readdir(outside), []);
 } finally { watcher.close(); }
}));
test('preplaced git and starter-file junction/symlink targets never receive writes', async () => fixture(async c => {
 for (const [name, leaf] of [['git-alias', '.git'], ['starter-alias', 'AGENTS.md']]) {
  const outside = path.join(c.base, name); await fs.mkdir(outside);
  await assert.rejects(w.prepareProject(name, c, { afterCreate: async dir => {
   if (leaf === '.git') await fs.symlink(outside, path.join(dir, leaf), 'junction');
   else { const target = path.join(outside, 'untouched'); await fs.writeFile(target, 'original'); await fs.symlink(target, path.join(dir, leaf)); }
  }}));
  if (leaf === '.git') assert.deepEqual(await fs.readdir(outside), []);
  else assert.equal(await fs.readFile(path.join(outside, 'untouched'), 'utf8'), 'original');
 }
}));
test('auto refuses an existing home alias instead of creating another project', async () => fixture(async c => {
 const outside = path.join(c.base, 'outside'); await fs.mkdir(outside);
 await fs.symlink(outside, path.join(c.home, 'alias'), 'junction');
 await assert.rejects(w.openWindow({ mode: 'auto', target: 'alias' }, c, { launch: async () => { throw Error('must not launch'); } }), /aliases|junction/);
 assert.deepEqual(await fs.readdir(c.projectsRoot), []); assert.deepEqual(await fs.readdir(outside), []);
}));
test('selected Telegram state overlapping a project refuses before effects', async () => fixture(async c => {
 const folder = path.join(c.home, 'existing'); await fs.mkdir(folder);
 await assert.rejects(w.openWindow({ mode: 'open', target: folder }, { ...c, telegramRuntime: path.join(folder, 'telegram') }, { launch: async () => { throw Error('must not launch'); } }), /state|config/i);
 assert.deepEqual(await fs.readdir(folder), []); assert.deepEqual(await fs.readdir(c.runtimeRoot), []);
}));
test('Telegram runtime chosen by environment is checked before project effects', async () => fixture(async c => {
 const folder = path.join(c.home, 'existing'), agentDir = path.join(c.base, 'agent'); await fs.mkdir(folder); await fs.mkdir(agentDir);
 const prior = process.env.TELEGRAM_PI_RUNTIME_DIR;
 try {
  process.env.TELEGRAM_PI_RUNTIME_DIR = path.join(folder, 'telegram');
  await assert.rejects(w.openWindow({ mode: 'open', target: folder }, { ...c, agentDir }, { launch: async () => { throw Error('must not launch'); } }), /state|config/i);
  assert.deepEqual(await fs.readdir(folder), []); assert.deepEqual(await fs.readdir(c.runtimeRoot), []);
 } finally { if (prior === undefined) delete process.env.TELEGRAM_PI_RUNTIME_DIR; else process.env.TELEGRAM_PI_RUNTIME_DIR = prior; }
}));
test('runtime replacement between validation and use refuses without outside writes', async () => fixture(async c => {
 const folder = path.join(c.home, 'existing'), outside = path.join(c.base, 'outside'); await fs.mkdir(folder); await fs.mkdir(outside);
 await assert.rejects(w.openWindow({ mode: 'open', target: folder }, c, { afterResolve: async () => {
  await fs.rename(c.runtimeRoot, c.runtimeRoot + '-moved'); await fs.symlink(outside, c.runtimeRoot, 'junction');
 }, launch: async () => { throw Error('must not launch'); } }), /aliases|junction|changed/i);
 assert.deepEqual(await fs.readdir(outside), []);
}));
test('folder replacement between resolution and pinning refuses', async () => fixture(async c => {
 const folder = path.join(c.home, 'existing'); await fs.mkdir(folder);
 await assert.rejects(w.openWindow({ mode: 'open', target: folder }, c, { afterResolve: async () => {
  await fs.rename(folder, folder + '-moved'); await fs.mkdir(folder);
 }, launch: async () => { throw Error('must not launch'); } }), /changed/i);
 assert.deepEqual(await fs.readdir(folder), []);
}));
test('literal instruction retains trailing whitespace through command parsing', () => {
 assert.equal(w.parseCommand('open "folder" @literal \n  ').instruction, '@literal \n  ');
});
test('environment removes worker/session inheritance, preserves normal config', () => {
 const env = w.cleanEnv({ PATH: 'safe', PI_MODEL: 'worker', PI_PROVIDER: 'worker', PI_REASONING_LEVEL: 'high', PI_SESSION_ID: 'parent', PI_SESSION_FILE: 'parent', PI_CODING_AGENT_SESSION_DIR: 'parent', PI_CODING_AGENT_DIR: 'normal', TELEGRAM_PI_AUTO_LOGON: '0', WT_SESSION: 'parent', PI_WINDOW_REQUEST: 'old', PI_WINDOW_CONFIG: 'local-config', PI_PARENT_SESSION: 'parent' });
 assert.equal(env.PI_CODING_AGENT_DIR, 'normal');
 assert.equal(env.PI_WINDOW_CONFIG, 'local-config');
 for (const key of ['PI_MODEL', 'PI_PROVIDER', 'PI_REASONING_LEVEL', 'PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_CODING_AGENT_SESSION_DIR', 'WT_SESSION', 'PI_WINDOW_REQUEST', 'PI_PARENT_SESSION']) assert.equal(env[key], undefined);
});
test('Windows Terminal command delimiters in paths refuse before effects', async () => fixture(async c => {
 const folder = path.join(c.home, 'folder;new-tab'); await fs.mkdir(folder); let launched = false;
 await assert.rejects(w.openWindow({ mode: 'open', target: folder }, c, { launch: async () => { launched = true; throw Error('unsafe transport'); } }), /delimiter/);
 assert.equal(launched, false); assert.deepEqual(await fs.readdir(folder), []);
}));
test('launch transport contains paths as argv, instruction only in data; readiness required', async () => fixture(async c => {
 const folder = path.join(c.home, 'existing'); await fs.mkdir(folder);
 const instruction = '--model injected @file ; & "hello" /quit'; let launch;
 const config = { ...c, piCli: path.join(c.base, 'cli.js'), telegramExtension: path.join(c.base, 'telegram.ts') };
 const result = await w.openWindow({ mode: 'open', target: folder, instruction }, config, { launch: async spec => {
  launch = spec; const request = JSON.parse(await fs.readFile(spec.requestFile, 'utf8'));
  assert.equal(request.instruction, instruction);
  await w.publishReady(request, { topic: 42, label: 'existing' });
 }});
 assert.equal(result.label, 'existing'); assert.equal(result.topic, 42);
 assert.deepEqual(launch.args.slice(0, 4), ['-w', 'new', '-d', folder]);
 assert.equal(launch.args[launch.args.indexOf('--title') + 1], 'existing', 'owned terminal has the project label');
 assert.equal(launch.args.includes('--suppressApplicationTitle'), true, 'application title updates must not erase the explicit label');
 assert.equal(launch.args.includes(instruction), false); assert.equal(launch.shell, false);
 assert.deepEqual(await fs.readdir(folder), []);
 await assert.rejects(w.openWindow({ mode: 'open', target: folder }, config, { launch: async spec => {
  const request = JSON.parse(await fs.readFile(spec.requestFile, 'utf8')); await w.publishReady(request, { error: 'logon failed' });
 }}), /logon failed/);
 await assert.rejects(w.openWindow({ mode: 'open', target: folder }, config, { launch: async () => { throw Error('launch failed'); } }), /launch failed/);
}));
test('Telegram /new authorizes General only, consumes project topic, deduplicates, releases registration queue', async () => fixture(async c => {
 let calls = 0; const sent = [];
 const router = new Router({ dir: c.runtimeRoot, chatId: -100, allowlist: [101], api: { call: async (method, body) => { sent.push({ method, body }); return {}; } }, launchWindow: async text => {
  calls++; assert.equal(text, 'demo hello'); await router.serial(async () => {}); return { label: 'demo', topic: 42 };
 }});
 const update = (id, from = 101, topic = 1, chat = -100) => ({ update_id: id, message: { text: '/new demo hello', from: { id: from }, chat: { id: chat, type: 'supergroup' }, message_thread_id: topic } });
 await router.update(update(1, 999)); await router.update(update(2, 101, 9)); await router.update(update(3, 101, 1, -999));
 assert.equal(calls, 0); assert.equal(sent.length, 0);
 await router.update(update(4)); await router.update(update(4)); await router.windowJobs;
 assert.equal(calls, 1); assert.match(sent.at(-1).body.text, /demo/);
 assert.equal(Object.keys(router.state.tickets).length, 0);
}));
test('production Router.update to forum launcher to helper preserves literal instruction suffix', async () => fixture(async c => {
 const { windowLauncher } = await import('../telegram-pi/forum-router.mjs');
 const folder = path.join(c.projectsRoot, 'existing folder'); await fs.mkdir(folder);
 const instruction = '/quit @file --model fake ; & "hello" \n  ';
 const received = [], sent = [];
 const router = new Router({ dir: c.runtimeRoot, chatId: -100, allowlist: [101], api: { call: async (method, body) => { sent.push({ method, body }); return {}; } },
  launchWindow: windowLauncher(c.runtimeRoot, c, { launch: async spec => {
   const request = JSON.parse(await fs.readFile(spec.requestFile, 'utf8')); received.push(request);
   await w.publishReady(request, { topic: 42, label: request.label });
  } }) });
 const update = (id, target, from = 101, topic = 1, chat = -100) => ({ update_id: id, message: { text: '/new ' + target + ' ' + instruction, from: { id: from }, chat: { id: chat, type: 'supergroup' }, message_thread_id: topic } });
 await router.update(update(1, 'blocked', 999)); await router.update(update(2, 'blocked', 101, 9)); await router.update(update(3, 'blocked', 101, 1, -999)); await router.windowJobs;
 assert.equal(received.length, 0); assert.equal(sent.length, 0);
 await router.update(update(4, '"existing folder"')); await router.update(update(4, '"existing folder"')); await router.windowJobs;
 await router.update(update(5, 'new-demo')); await router.windowJobs;
 assert.equal(received.length, 2);
 assert.deepEqual(received.map(r => r.instruction), [instruction, instruction]);
 assert.deepEqual(await fs.readdir(folder), []);
 assert.equal((await w.run('git', ['-C', path.join(c.projectsRoot, 'new-demo'), 'rev-parse', '--is-inside-work-tree'])).trim(), 'true');
 assert.equal(Object.keys(router.state.tickets).length, 0);
}));
test('Telegram launch refusal is truthful and never forwarded', async () => fixture(async c => {
 const sent = []; const router = new Router({ dir: c.runtimeRoot, chatId: -100, allowlist: [101], api: { call: async (_, body) => { sent.push(body.text); } }, launchWindow: async () => { throw Error('unavailable'); } });
 await router.update({ update_id: 1, message: { text: '/new demo', from: { id: 101 }, chat: { id: -100, type: 'supergroup' } } }); await router.windowJobs;
 assert.match(sent[0], /not confirmed|refused/i); assert.doesNotMatch(sent[0], /opened/i);
}));

test("real router IPC registration works while General launch is pending", async () => fixture(async c => {
 const sent = []; let client;
 const router = new Router({ dir: c.runtimeRoot, chatId: -100, allowlist: [101], api: { call: async (method, body) => { sent.push({ method, body }); return method === "createForumTopic" ? { message_thread_id: 42 } : {}; } }, launchWindow: async () => {
  client = new Client({ dir: c.runtimeRoot, identity: { id: "fresh", lease: randomUUID(), pid: process.pid, label: "demo" }, onDelivery: () => false });
  return client.request("logon");
 }});
 const service = await serve({ router, token: "fixture-" + randomUUID(), poll: false });
 try {
  await router.update({ update_id: 1, message: { text: "/new demo", from: { id: 101 }, chat: { id: -100, type: "supergroup" } } });
  await router.windowJobs;
  assert.equal(router.status().sessions[0].online, true);
  assert.equal(sent.filter(s => s.method === "createForumTopic").length, 1);
  assert.equal(sent.some(s => s.body.text === "New window topic: demo"), true);
 } finally { await client?.close(); await service.close(); }
}));
