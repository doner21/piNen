'use strict';
// Opt-in, single purpose-owned Windows Terminal E2E. Never starts a router.
// Local configuration and any credential copies stay in the caller's owned
// external Temp child. No paths, IDs or credentials are baked into this file.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const w = require('./window.cjs');
const core = require('../extensions/telegram-pi/multi-session.cjs');
async function processPresent(pid) {
 if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('Invalid owned process identity.');
 const out = await w.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'present' } else { 'absent' }`]);
 if (!['present', 'absent'].includes(out.trim())) throw Error('Owned process presence not confirmed.');
 return out.trim() === 'present';
}
async function ownedProcesses(info, prior = [], rootPid) {
 // Inspect the OS, not just the root PID or a saved model reply. Keep creation
 // identity after parent exit so orphaned helpers cannot disappear from counts.
 const script = '$all = @(Get-CimInstance Win32_Process | ForEach-Object { @{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; created=$_.CreationDate.ToUniversalTime().ToString("o"); name=$_.Name; command=$_.CommandLine} }); ConvertTo-Json -Depth 4 -Compress -InputObject @{observer=$PID; processes=$all}';
 const snapshot = JSON.parse(await w.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
 const canonical = value => String(value || '').replace(/\\/g, '/').toLowerCase();
 const prefix = canonical(info.dir) + '/';
 const known = new Map(prior.map(p => [p.pid, p.created]));
 const selected = new Map();
 const observers = new Set([snapshot.observer]);
 if (process.pid !== rootPid) observers.add(process.pid); // this external observation, never the TUI itself
 for (const p of snapshot.processes) {
  if (observers.has(p.pid)) continue;
  if (known.has(p.pid) && known.get(p.pid) !== p.created) continue; // PID reuse
  if (known.get(p.pid) === p.created || canonical(p.command).includes(prefix) || p.pid === rootPid) selected.set(p.pid, p);
 }
 let changed;
 do {
  changed = false;
  for (const p of snapshot.processes) {
   if (!observers.has(p.pid) && !selected.has(p.pid) && selected.has(p.parent)) { selected.set(p.pid, p); changed = true; }
  }
 } while (changed);
 const kind = p => /[\\/]bootstrap\.cjs(?:"|\s)/i.test(p.command || '') ? 'runtime' : /[\\/]pin\.cjs(?:"|\s|$)/i.test(p.command || '') ? 'holder' : 'other';
 return [...selected.values()].map(p => ({ ...p, kind: /^(?:conhost|OpenConsole)\.exe$/i.test(p.name || '') && ['runtime', 'holder'].includes(kind(selected.get(p.parent) || {})) ? 'consoleHost' : kind(p) }));
}
function startupProcessCounts(processes, pid) {
 const hosts = processes.filter(p => p.kind === 'consoleHost');
 const counts = { runtime: processes.filter(p => p.kind === 'runtime').length, holders: processes.filter(p => p.kind === 'holder').length, consoleHosts: hosts.length, other: processes.filter(p => !['runtime', 'holder', 'consoleHost'].includes(p.kind)).length, total: processes.length };
 // The bootstrap pins project, launch state, private agent and Telegram state.
 // The launcher may still hold its two short-lived leaves until readiness is
 // returned. Neither bound depends on path depth; no extra Pi runtime is valid.
 // Windows may allocate one hidden console for each Node helper launched from
 // a pseudoconsole. Count these actual owned OS processes, rather than either
 // ignoring them or rejecting the normal finite Windows topology.
 const protectedParents = new Set(processes.filter(p => ['runtime', 'holder'].includes(p.kind)).map(p => p.pid));
 if (counts.runtime !== 1 || !processes.some(p => p.pid === pid && p.kind === 'runtime') || counts.holders < 4 || counts.holders > 6 || counts.other || hosts.some(p => !protectedParents.has(p.parent)) || new Set(hosts.map(p => p.parent)).size !== hosts.length) throw Error('Owned process topology is not one runtime plus four startup holders (at most two releasing launcher holders) and at most one console host per runtime/holder.');
 return counts;
}
async function terminalWindows(title, prior = []) {
 // Pi rewrites the initial title after session_start. Observe its unique label
 // after the real reply, not an exact title immediately during startup. A UI
 // observation is required; a native handle is useful, but not mandatory.
 if (!/^window-e2e-[a-f0-9-]+$/.test(title)) throw Error('Invalid owned window label.');
 const handles = prior.map(item => item.handle).filter(h => Number.isSafeInteger(h) && h > 0);
 const script = `Add-Type -AssemblyName UIAutomationClient; $items = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition); $handles = @(${handles.join(',')}); ConvertTo-Json -Compress -InputObject @($items | Where-Object { $_.Current.Name.Contains('${title}') -or $handles -contains $_.Current.NativeWindowHandle } | ForEach-Object { @{title=$_.Current.Name; handle=$_.Current.NativeWindowHandle; pid=$_.Current.ProcessId} })`;
 return JSON.parse(await w.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
}
async function stage() {
 const root = await w.checkedDirectory(process.env.PI_WINDOW_E2E_ROOT);
 if (!w.inside(await w.checkedDirectory(w.tempRoot()), root)) throw Error('E2E root must be owned external Temp.');
 const deps = await w.checkedDirectory(process.env.PI_WINDOW_FROZEN_DEPS);
 const dir = await fs.mkdtemp(path.join(root, 'owned-window-'));
 const candidate = path.join(dir, 'candidate');
 const copy = async rel => {
  const dest = path.join(candidate, rel); await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(path.join(__dirname, '..', rel), dest, require('node:fs').constants.COPYFILE_EXCL);
 };
 for (const rel of ['window/window.cjs', 'window/bootstrap.cjs', 'window/pin.cjs', 'window/e2e.cjs', 'extensions/window/index.ts', 'extensions/telegram-pi/index.ts', 'extensions/telegram-pi/topic-session.ts', 'extensions/telegram-pi/multi-session.cjs', 'extensions/telegram-pi/inbound.cjs']) await copy(rel);
 const agentDir = path.join(dir, 'agent'); await fs.mkdir(agentDir);
 const userAgent = await w.checkedDirectory(process.env.PI_WINDOW_USER_AGENT || path.join(os.homedir(), '.pi', 'agent'));
 const settings = JSON.parse(await fs.readFile(path.join(userAgent, 'settings.json'), 'utf8'));
 const minimal = {};
 for (const key of ['defaultProvider', 'defaultModel', 'defaultThinkingLevel', 'modelThinkingLevels', 'thinkingBudgets', 'enabledModels']) if (settings[key] !== undefined) minimal[key] = settings[key];
 minimal.quietStartup = true;
 await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(minimal), { flag: 'wx' });
 // Read-only copies, never hardlinks: provider refresh cannot alter live auth.
 for (const file of ['auth.json', 'models.json', 'models-store.json', 'keybindings.json']) {
  try { await fs.copyFile(path.join(userAgent, file), path.join(agentDir, file), require('node:fs').constants.COPYFILE_EXCL); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
 }
 const selected = core.selectRuntime(path.join(userAgent, 'telegram-pi'));
 if (selected.mode !== 'topics') throw Error('Existing topics router is required.');
 const sourceRuntime = await w.checkedDirectory(selected.dir);
 const telegramRuntime = path.join(dir, 'telegram'); await fs.mkdir(telegramRuntime);
 // Session capability only: never copy the operator's shutdown authority, live
 // routes, or mutable settings. IPC still reaches the ordinary existing router.
 await fs.copyFile(path.join(sourceRuntime, 'router-endpoint.json'), path.join(telegramRuntime, 'router-endpoint.json'), require('node:fs').constants.COPYFILE_EXCL);
 const telegramExtension = path.join(candidate, 'extensions', 'telegram-pi', 'observed.ts');
 await fs.writeFile(telegramExtension, `import telegramPi from './index.ts';
import { core } from './topic-session.ts';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
export default function(pi) {
 const observation = join(__dirname, '..', '..', '..');
 const harness = require('../../window/e2e.cjs');
 let observed = false, ownTopic;
 const transport = [];
 const request = core.Client.prototype.request;
 // Transparent observation of the real authenticated IPC, not a replacement
 // transport. Never persist endpoint capabilities, auth or the session lease.
 core.Client.prototype.request = async function(action, params = {}) {
  if (action !== 'logon' && action !== 'send') return request.call(this, action, params);
  const record = { action, sessionId: this.identity.id, text: params.text, topic: ownTopic, ok: false };
  try {
   const result = await request.call(this, action, params);
   if (action === 'logon') { ownTopic = result?.topic; record.topic = ownTopic; }
   record.ok = action === 'logon' ? Number.isSafeInteger(ownTopic) : result?.ok === true;
   return result;
  } finally {
   transport.push(record);
   await fs.writeFile(join(observation, 'transport.json'), JSON.stringify(transport));
  }
 };
 // Delegate all actual wiring, startup, prompt correlation and teardown to the
 // unchanged production entrypoint. The rest only observes this owned session.
 telegramPi(pi);
 pi.on('session_start', async (_, ctx) => {
  const info = JSON.parse(await fs.readFile(join(observation, 'owned.json'), 'utf8'));
  const started = { pid: process.pid, mode: ctx.mode, sessionId: ctx.sessionManager.getSessionId(), provider: ctx.model?.provider, model: ctx.model?.id, title: info.name };
  await fs.writeFile(join(observation, 'started.json'), JSON.stringify(started));
  if (started.provider !== info.expectedModel.provider || started.model !== info.expectedModel.id) {
   await fs.writeFile(join(observation, 'route-error.json'), JSON.stringify({ expected: info.expectedModel, observed: started }));
   const windows = require('../../window/window.cjs');
   const launch = JSON.parse(await fs.readFile(process.env.PI_WINDOW_REQUEST, 'utf8'));
   await windows.publishReady(launch, { error: 'Usual model route unavailable; refusing fallback before model work.' });
   ctx.shutdown(); return;
  }
 });
 pi.on('agent_end', async (event, ctx) => {
  const text = (event.messages || []).filter(m => m.role === 'assistant').flatMap(m => (m.content || []).filter(p => p.type === 'text').map(p => p.text)).join('\\n');
  observed = true;
  await fs.writeFile(join(observation, 'response.json'), JSON.stringify({ text, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), provider: ctx.model?.provider, model: ctx.model?.id, assistants: (event.messages || []).filter(m => m.role === 'assistant').map(m => ({ provider: m.provider, model: m.model, stopReason: m.stopReason, errorMessage: core.redact(m.errorMessage || '') })) }));
 });
 pi.on('agent_settled', async (_, ctx) => {
  if (!observed) return;
  const info = JSON.parse(await fs.readFile(join(observation, 'owned.json'), 'utf8'));
  const processes = await harness.ownedProcesses(info, [], process.pid);
  // Preserve raw OS identities even if the external validation rejects the
  // topology. A counting failure must not erase the diagnostic observation or
  // prevent this positively identified TUI from normal graceful closure.
  await fs.writeFile(join(observation, 'processes-started.json'), JSON.stringify({ processes }));
  const windows = await harness.terminalWindows(info.name);
  await fs.writeFile(join(observation, 'terminal.json'), JSON.stringify({ windows }));
  // Missing UI observation preserves this own test for inspection; never infer
  // terminal disappearance from a session callback or kill an uncertain window.
  if (windows.length) ctx.shutdown();
 });
 pi.on('session_shutdown', async () => {
  await fs.writeFile(join(observation, 'closed.json'), JSON.stringify({ graceful: true }));
 });
}
`, { flag: 'wx' });
 const projectsRoot = path.join(dir, 'projects'); await fs.mkdir(projectsRoot);
 const runtimeRoot = path.join(dir, 'runtime'); await fs.mkdir(runtimeRoot);
 const name = 'window-e2e-' + randomUUID();
 const marker = 'WINDOW-HELLO-' + randomUUID();
 const config = { home: os.homedir(), projectsRoot, runtimeRoot, agentDir, telegramExtension, telegramRuntime, leanMethod: path.join(userAgent, 'docs', 'lean-working-method.md'), piCli: path.join(deps, '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js') };
 if (!minimal.defaultProvider || !minimal.defaultModel) throw Error('Explicit usual model defaults are required for a no-fallback E2E.');
 const expectedModel = { provider: minimal.defaultProvider, id: minimal.defaultModel };
 const instruction = `Reply with exactly ${marker}. Do not use tools or change files. Literal punctuation to ignore: /quit @file --model fake ; & "hello".\n  `;
 const info = { dir, candidate, name, marker, instruction, expectedModel, config };
 await fs.writeFile(path.join(dir, 'owned.json'), JSON.stringify(info), { flag: 'wx', mode: 0o600 });
 console.log(dir);
}
async function owned(dir) {
 const real = await w.checkedDirectory(dir);
 if (!w.inside(await w.checkedDirectory(w.tempRoot()), real) || !path.basename(real).startsWith('owned-window-')) throw Error('Not an owned E2E child.');
 const info = JSON.parse(await fs.readFile(path.join(real, 'owned.json'), 'utf8'));
 if (info.dir !== real || !/^window-e2e-[a-f0-9-]+$/.test(info.name)) throw Error('Ownership mismatch.');
 return info;
}
async function launch(dir) {
 const info = await owned(dir);
 const candidate = require(path.join(info.candidate, 'window', 'window.cjs'));
 const result = await candidate.openWindow({ mode: 'new', target: info.name, instruction: info.instruction }, info.config);
 await fs.writeFile(path.join(info.dir, 'launched.json'), JSON.stringify(result), { flag: 'wx' });
 console.log(JSON.stringify({ topic: result.topic, label: result.label, logonConfirmed: true }));
}
async function observe(dir, cleanup = false) {
 const info = await owned(dir);
 const client = new core.Client({ dir: info.config.telegramRuntime, identity: {}, onDelivery: () => false });
 let sessions;
 try { sessions = (await client.request('status')).sessions; } finally { await client.close(); }
 const binding = sessions.find(s => s.label === info.name);
 const response = JSON.parse(await fs.readFile(path.join(info.dir, 'response.json'), 'utf8'));
 const closed = JSON.parse(await fs.readFile(path.join(info.dir, 'closed.json'), 'utf8'));
 const launched = JSON.parse(await fs.readFile(path.join(info.dir, 'launched.json'), 'utf8'));
 if (!binding || binding.id !== response.sessionId || binding.topic !== launched.topic || response.text.trim() !== info.marker || !closed.graceful || binding.online || !w.inside(info.config.runtimeRoot, response.sessionFile)) throw Error('E2E response, independent topic, storage or graceful closure not confirmed.');
 const transport = JSON.parse(await fs.readFile(path.join(info.dir, 'transport.json'), 'utf8'));
 const sends = transport.filter(r => r.action === 'send');
 if (sends.length !== 2 || ![info.instruction, info.marker].every((text, i) => sends[i]?.ok === true && sends[i].text === text && sends[i].sessionId === binding.id && sends[i].topic === binding.topic)) throw Error('Correlated Telegram delivery acknowledgements not confirmed.');
 const started = JSON.parse(await fs.readFile(path.join(info.dir, 'started.json'), 'utf8'));
 if (started.mode !== 'tui' || started.sessionId !== binding.id || started.pid !== binding.pid || [started, response].some(r => r.provider !== info.expectedModel.provider || r.model !== info.expectedModel.id) || binding.model !== `${info.expectedModel.provider}/${info.expectedModel.id}` || !response.assistants?.length || response.assistants.some(m => m.provider !== info.expectedModel.provider || m.model !== info.expectedModel.id || m.stopReason === 'error')) throw Error('Usual provider/model route not confirmed.');
 const entries = (await fs.readFile(response.sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
 const first = entries.find(e => e.type === 'message' && e.message?.role === 'user')?.message;
 const firstText = typeof first?.content === 'string' ? first.content : first?.content?.map(p => p.type === 'text' ? p.text : '').join('');
 if (firstText !== info.instruction) throw Error('Literal first user instruction not confirmed.');
 const startup = JSON.parse(await fs.readFile(path.join(info.dir, 'processes-started.json'), 'utf8'));
 const startupCounts = startupProcessCounts(startup.processes, started.pid);
 const survivors = await ownedProcesses(info, startup.processes);
 await fs.writeFile(path.join(info.dir, 'processes-closed.json'), JSON.stringify({ processes: survivors, total: survivors.length }));
 if (survivors.length || await processPresent(started.pid)) throw Error('Owned process/descendant closure not confirmed.');
 const terminal = JSON.parse(await fs.readFile(path.join(info.dir, 'terminal.json'), 'utf8'));
 if (!terminal.windows?.length || terminal.windows.some(item => typeof item.title !== 'string' || !item.title.includes(info.name)) || (await terminalWindows(info.name, terminal.windows)).length) throw Error('Owned terminal window closure not confirmed.');
 const summary = { ownTopic: true, sessionId: binding.id, topic: binding.topic, label: binding.label, hello: true, instruction: info.instruction, response: response.text, model: binding.model, externalSessionState: true, gracefulClosure: true, startupProcesses: startupCounts, ownedProcessesAfterClosure: survivors.length, processAbsent: true, windowAbsent: true, offline: true };
 console.log(JSON.stringify(summary));
 // Ordinary runtime observations stay with this test, never a sibling evidence
 // folder. The reviewer can inspect them before cleanup; console output retains
 // the concise result after owned credentials/runtime are removed.
 if (cleanup) {
  const project = path.join(info.config.projectsRoot, info.name);
  if (!w.inside(info.dir, await w.checkedDirectory(project))) throw Error('Project cleanup containment failed.');
  await fs.rm(project, { recursive: true }); // only this exclusively created throwaway
  // Credential copies and throwaway runtime are also owned by this E2E.
  await fs.rm(info.dir, { recursive: true });
  console.log('Owned throwaway project and staging child removed. Telegram topic remains readable.');
 }
}
const [action, dir] = process.argv.slice(2);
module.exports = { stage, owned, launch, observe, processPresent, terminalWindows, ownedProcesses, startupProcessCounts };
if (require.main === module) void (async () => {
 if (action === 'stage') await stage();
 else if (action === 'launch') await launch(dir);
 else if (action === 'observe') await observe(dir);
 else if (action === 'cleanup') await observe(dir, true);
 else throw Error('Use stage | launch <owned-child> | observe <owned-child> | cleanup <owned-child>.');
})().catch(e => { console.error(core.redact(e.message, process.env.TELEGRAM_BOT_TOKEN)); console.error('E2E step not confirmed; inspect only the owned staging child. No other session or router was changed.'); throw Error('Owned E2E step failed.'); });
