'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { watch } = require('node:fs');

function validateName(name) {
 if (typeof name !== 'string' || !/^[A-Za-z0-9-]+$/.test(name) || name.length > 80 || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) throw Error('Project name must be ASCII letters, numbers or hyphens, not a Windows device name (max 80).');
 return name;
}
// Only the first argument is quoted syntax. The remaining instruction is data.
function firstArg(text) {
 text = text.trimStart();
 if (!text) throw Error('A name or existing folder is required.');
 if (text[0] === '"' || text[0] === "'") {
  const end = text.indexOf(text[0], 1);
  if (end < 0 || (text[end + 1] && !/\s/.test(text[end + 1]))) throw Error('Unclosed or invalid folder quotes.');
  return [text.slice(1, end), text.slice(end + 1).trimStart()];
 }
 const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/); return [match[1], match[2] || ''];
}
function parseCommand(text) {
 const [mode, rest] = firstArg(text);
 if (!['new', 'open'].includes(mode)) throw Error('Use /window new <name> [instruction] or /window open "<folder>" [instruction].');
 const [target, instruction] = firstArg(rest); return { mode, target, instruction };
}
function inside(root, target) {
 const rel = path.relative(root, target);
 return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}
function samePath(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
function localPath(input) {
 if (typeof input !== 'string' || !input || /[\x00-\x1f]/.test(input) || /^[/\\]{2}/.test(input) || input.includes(':') && !/^[A-Za-z]:[/\\][^:]*$/.test(input)) throw Error('Use a regular local folder path.');
}
async function checkedDirectory(input) {
 localPath(input); const abs = path.resolve(input); let current = abs;
 for (;;) {
  const st = await fs.lstat(current);
  if (!st.isDirectory() || st.isSymbolicLink()) throw Error('Folder aliases, symlinks and junctions are refused.');
  const parent = path.dirname(current); if (parent === current) break; current = parent;
 }
 const real = await fs.realpath(abs);
 if (!samePath(real, abs)) throw Error('Folder aliases are refused.');
 return real;
}
async function resolveFolder(target, config) {
 localPath(target);
 const home = await checkedDirectory(config.home);
 const candidates = path.isAbsolute(target) ? [target] : [path.join(config.projectsRoot, target), path.join(home, target)];
 for (const candidate of candidates) {
  if (!inside(home, path.resolve(candidate))) continue;
  try { const real = await checkedDirectory(candidate); if (!inside(home, real)) throw Error('Folder must be under configured home.'); return real; }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
 }
 const error = Error('Existing folder not found under configured home/projects. Nothing was created.');
 error.code = 'ENOENT'; throw error;
}
function cleanEnv(source = process.env) {
 const env = { ...source };
 for (const key of Object.keys(env)) {
  if (key.toUpperCase() === 'PI_WINDOW_CONFIG') continue;
  if (/^PI_(?:SESSION.*|PARENT.*|MODEL|PROVIDER|REASONING_LEVEL|WORKER.*|SUBAGENT.*|ORCHESTRAT.*|WINDOW_.*|CODING_AGENT_SESSION_DIR)$/i.test(key) || /^(?:WT_SESSION|WT_PROFILE_ID|NODE_COMPILE_CACHE|PI_TUI_WRITE_LOG|PI_TIMING_FILE|JITI_CACHE_DIR)$/i.test(key)) delete env[key];
 }
 env.NODE_DISABLE_COMPILE_CACHE = '1'; env.JITI_FS_CACHE = '0';
 return env;
}
function run(exe, args, options = {}) {
 return new Promise((resolve, reject) => {
  const child = spawn(exe, args, { shell: false, windowsHide: true, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', b => { out += b; }); child.stderr.resume();
  child.once('error', reject); child.once('close', code => code === 0 ? resolve(out) : reject(Error('Local command failed.')));
 });
}
async function pinOne(dir) {
 const child = spawn(process.execPath, [path.join(__dirname, 'pin.cjs')], { cwd: dir, env: cleanEnv(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
 child.stderr.resume(); let buffer = '';
 try {
  const info = await new Promise((resolve, reject) => {
   child.once('error', reject); child.once('close', () => reject(Error('Directory holder unavailable.')));
   child.stdout.on('data', b => { buffer += b; if (buffer.includes('\n')) { try { resolve(JSON.parse(buffer.split('\n')[0])); } catch { reject(Error('Invalid directory holder.')); } } });
  });
  const st = await fs.stat(dir, { bigint: true });
  if (!samePath(info.cwd, dir) || String(st.ino) !== info.ino) throw Error('Directory changed while pinning.');
  return child;
 } catch (e) { child.stdin.end(); throw e; }
}
async function withPinned(dir, fn, expected) {
 if (process.platform !== 'win32') throw Error('Safe directory creation is supported only on Windows.');
 const canonical = await checkedDirectory(dir);
 expected ||= await fs.stat(canonical, { bigint: true });
 // Windows refuses renaming an ancestor containing an open cwd directory,
 // too. One leaf holder protects the entire checked path; spawning a Node
 // process for every ancestor multiplied the persistent runtime helpers by
 // path depth (and repeated the same ancestors for each state directory).
 let holder, released;
 const release = () => released ||= holder ? new Promise(resolve => { holder.once('close', resolve); holder.stdin.end(); }) : Promise.resolve();
 try {
  holder = await pinOne(canonical);
  const pinned = await fs.stat(dir, { bigint: true });
  if (!samePath(await checkedDirectory(dir), canonical) || pinned.ino !== expected.ino || pinned.dev !== expected.dev) throw Error('Folder changed during pinning.');
  return await fn(canonical, release);
 } finally {
  await release();
 }
}
async function ensureProjects(config) {
 const home = await checkedDirectory(config.home), root = path.resolve(config.projectsRoot);
 if (!inside(home, root) || samePath(home, root)) throw Error('projectsRoot must be a subdirectory of configured home.');
 // Custom roots must exist; only the conventional immediate child is created.
 try { return await checkedDirectory(root); }
 catch (e) {
  if (e.code !== 'ENOENT' || !samePath(path.dirname(root), home)) throw e;
  return withPinned(home, async () => { await fs.mkdir(root); return checkedDirectory(root); });
 }
}
function tempRoot() { return process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : os.tmpdir(); }
async function ownedRuntime(config) {
 // Runtime contains requests and sessions, never under an opened project.
 const temp = await checkedDirectory(tempRoot());
 const root = path.resolve(config.runtimeRoot);
 if (!inside(temp, root) || samePath(temp, root)) throw Error('runtimeRoot must be a dedicated directory under system Temp.');
 // The parent must already exist and must not be an alias.
 await withPinned(path.dirname(root), async () => { try { await fs.mkdir(root); } catch (e) { if (e.code !== 'EEXIST') throw e; } });
 return checkedDirectory(root);
}
async function prepareProject(name, config, hooks = {}) {
 validateName(name); const root = await ensureProjects(config);
 return withPinned(root, async () => {
  const dir = path.join(root, name); await fs.mkdir(dir); // exclusive, never recursive
  const created = await fs.lstat(dir, { bigint: true });
  await hooks.afterCreate?.(dir);
  return withPinned(dir, async () => {
   const pinned = await fs.lstat(dir, { bigint: true });
   if (pinned.ino !== created.ino || pinned.dev !== created.dev) throw Error('New directory was replaced.');
   const runtime = await ownedRuntime(config), runtimeIdentity = await fs.stat(runtime, { bigint: true });
   await hooks.afterRuntime?.(runtime);
   return withPinned(runtime, async () => {
    const seed = await fs.mkdtemp(path.join(runtime, 'git-seed-'));
    try {
     const empty = path.join(seed, 'empty'); await fs.mkdir(empty);
     const gitEnv = cleanEnv();
     for (const key of Object.keys(gitEnv)) if (/^GIT_/i.test(key)) delete gitEnv[key];
     await run('git', ['init', '--template=' + empty, path.join(seed, 'repo')], { env: gitEnv });
     // Copy git's initialized metadata exclusively; do not let git follow an
     // adversarial pre-existing .git/config, hook or junction in the project.
     const copy = async (source, dest) => {
      await fs.mkdir(dest);
      await withPinned(dest, async () => {
       for (const entry of await fs.readdir(source, { withFileTypes: true })) {
        const from = path.join(source, entry.name), to = path.join(dest, entry.name);
        if (entry.isDirectory()) await copy(from, to);
        else if (entry.isFile()) await fs.writeFile(to, await fs.readFile(from), { flag: 'wx' });
        else throw Error('Unexpected git metadata.');
       }
      });
     };
     await copy(path.join(seed, 'repo', '.git'), path.join(dir, '.git'));
     await fs.writeFile(path.join(dir, 'AGENTS.md'), '# Working method\n\nRead the lean working method before work: ' + config.leanMethod.replace(/\\/g, '/') + '\n', { flag: 'wx' });
    } finally { await fs.rm(seed, { recursive: true, force: true }); }
    return dir;
   }, runtimeIdentity);
  });
 });
}
async function loadConfig(env = process.env) {
 const agentDir = env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
 let local = {};
 try { local = JSON.parse(await fs.readFile(env.PI_WINDOW_CONFIG || path.join(agentDir, 'window.json'), 'utf8')); }
 catch (e) { if (e.code !== 'ENOENT' || env.PI_WINDOW_CONFIG) throw Error('Window configuration unreadable.'); }
 const allowed = ['home', 'projectsRoot', 'runtimeRoot', 'piCli', 'telegramExtension', 'telegramRuntime', 'leanMethod', 'agentDir'];
 if (Object.keys(local).some(k => !allowed.includes(k))) throw Error('Unknown window configuration field.');
 const home = local.home || os.homedir(), childAgentDir = local.agentDir || agentDir;
 let piCli = local.piCli;
 if (!piCli) {
  const candidates = [process.argv[1], env.APPDATA && path.join(env.APPDATA, 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')];
  for (const candidate of candidates) {
   if (!candidate || path.basename(candidate) !== 'cli.js') continue;
   try { await fs.access(candidate); piCli = path.resolve(candidate); break; } catch {}
  }
  if (!piCli) throw Error('Configure piCli with the installed Pi dist/cli.js path.');
 }
 return { home, projectsRoot: path.join(home, 'projects'), runtimeRoot: path.join(tempRoot(), 'pi-window-runtime'), leanMethod: path.join(childAgentDir, 'docs', 'lean-working-method.md'), telegramExtension: path.join(childAgentDir, 'extensions', 'telegram-pi', 'index.ts'), agentDir: childAgentDir, ...local, piCli };
}
async function publishReady(request, result) {
 const temp = request.readyFile + '.' + randomUUID() + '.tmp';
 try {
  await fs.writeFile(temp, JSON.stringify({ nonce: request.nonce, ...result }), { flag: 'wx', mode: 0o600 });
  await fs.link(temp, request.readyFile); // atomic and exclusive publication
 } finally { await fs.unlink(temp).catch(() => {}); }
}
async function openWindow(input, config, deps = {}) {
 config ||= await loadConfig();
 if (!['new', 'open', 'auto'].includes(input.mode) || typeof input.target !== 'string' || input.instruction != null && typeof input.instruction !== 'string') throw Error('Invalid window request.');
 let mode = input.mode;
 if (mode === 'auto') {
  try { await resolveFolder(input.target, config); mode = 'open'; }
  catch (e) { if (e.code !== 'ENOENT') throw e; validateName(input.target); mode = 'new'; }
 }
 // wt has its own semicolon command grammar, independent of shell:false.
 // Refuse ambiguous transport paths rather than guess at shell escaping.
 const proposed = mode === 'new' ? path.join(config.projectsRoot, validateName(input.target)) : await resolveFolder(input.target, config);
 if ([proposed, process.execPath, __dirname, config.runtimeRoot].some(p => p.includes(';'))) throw Error('Windows Terminal command delimiters in paths are refused.');
 // Resolve the same topics runtime the real Telegram entrypoint will select,
 // including deployment.json and environment overrides, before project effects.
 const telegramRuntime = config.telegramRuntime || (config.agentDir && require('../extensions/telegram-pi/multi-session.cjs').selectRuntime(path.join(config.agentDir, 'telegram-pi'), { ...process.env, TELEGRAM_PI_MODE: 'topics' }).dir);
 for (const state of [config.runtimeRoot, config.agentDir, telegramRuntime].filter(Boolean)) {
  if (inside(proposed, path.resolve(state))) throw Error('Window state/config must not be stored inside the opened folder.');
 }
 const folder = mode === 'new' ? await prepareProject(input.target, config) : proposed;
 const folderIdentity = await fs.stat(folder, { bigint: true });
 const runtime = await ownedRuntime(config), runtimeIdentity = await fs.stat(runtime, { bigint: true });
 await deps.afterResolve?.();
 return withPinned(runtime, () => withPinned(folder, async () => {
  const launchDir = await fs.mkdtemp(path.join(runtime, 'launch-'));
  const requestFile = path.join(launchDir, 'request.json'), readyFile = path.join(launchDir, 'ready.json');
  const request = { nonce: randomUUID(), folder, label: path.basename(folder), instruction: input.instruction || '', readyFile, launchDir, piCli: config.piCli, agentDir: config.agentDir, telegramExtension: config.telegramExtension, telegramRuntime };
  await fs.writeFile(requestFile, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  // Watch BEFORE launch. No polling, sleeps or startup deadline. A failed
  // launch rejects; a child reports actual TUI+topic readiness or refusal.
  let watcher, rejectReady;
  const ready = new Promise((resolve, reject) => {
   rejectReady = reject;
   const check = async () => {
    try {
     const value = JSON.parse(await fs.readFile(readyFile, 'utf8'));
     if (value.nonce !== request.nonce) throw Error('Invalid startup confirmation.');
     if (value.error) throw Error(value.error);
     if (!Number.isSafeInteger(value.topic) || value.topic <= 1 || value.label !== request.label) throw Error('Invalid topic confirmation.');
     resolve({ label: value.label, topic: value.topic, folder });
    } catch (e) { if (e.code !== 'ENOENT') reject(e); }
   };
   watcher = watch(launchDir, () => { void check(); }); watcher.on('error', reject);
  });
  // Attach rejection handler before an injected launch can publish failure.
  ready.catch(() => {});
  try {
   const spec = { args: ['-w', 'new', '-d', folder, '--title', request.label, '--suppressApplicationTitle', '--inheritEnvironment', process.execPath, path.join(__dirname, 'bootstrap.cjs'), requestFile], shell: false, requestFile, env: cleanEnv() };
   if (deps.launch) await deps.launch(spec);
   // wt forwards its startup visibility to the new Terminal window. Hiding
   // ordinary helper commands must not hide the user-requested TUI window.
   else await run('wt.exe', spec.args, { env: spec.env, windowsHide: false });
   return await ready;
  } catch (e) { rejectReady(e); throw e; }
  finally { watcher?.close(); }
 }, folderIdentity), runtimeIdentity);
}
async function telegramNew(text, config, deps) { const [target, instruction] = firstArg(text); return openWindow({ mode: 'auto', target, instruction }, config, deps); }
module.exports = { validateName, firstArg, parseCommand, inside, cleanEnv, run, checkedDirectory, tempRoot, withPinned, resolveFolder, prepareProject, loadConfig, publishReady, openWindow, telegramNew };
