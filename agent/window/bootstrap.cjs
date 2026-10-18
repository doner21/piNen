'use strict';
// Special immutable-project startup: compose the installed SDK and real TUI.
// CLI main runs migrations and reads project settings before resolving trust.
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const windows = require('./window.cjs');

async function createRuntime(request) {
 const dist = path.basename(path.dirname(request.piCli)) === 'bundle' ? path.dirname(path.dirname(request.piCli)) : path.dirname(request.piCli);
 const sdk = await import(pathToFileURL(path.join(dist, 'index.js')).href);
 let globalSettings = {};
 try { globalSettings = JSON.parse((await fs.readFile(path.join(request.agentDir, 'settings.json'), 'utf8')).replace(/^\uFEFF/, '')); }
 catch (e) { if (e.code !== 'ENOENT') throw e; }
 // Package resolution happens before noExtensions filtering. Never let global
 // packages auto-install, or let any configured state/resource path redirect
 // this startup into the project. Settings changes remain process-local.
 for (const key of ['packages', 'extensions', 'skills', 'prompts', 'promptTemplates', 'themes', 'sessionDir']) delete globalSettings[key];
 const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  if (await windows.checkedDirectory(cwd) !== request.folder) throw Error('Window runtime cannot change its project.');
  const settingsManager = sdk.SettingsManager.inMemory(globalSettings, { projectTrusted: false });
  const services = await sdk.createAgentSessionServices({ cwd, agentDir: request.agentDir, settingsManager,
   resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [request.telegramExtension, path.join(__dirname, '..', 'extensions', 'window', 'index.ts')] } });
  if (services.diagnostics.some(d => d.type === 'error') || services.resourceLoader.getExtensions().errors.length) throw Error('Window extensions could not load.');
  const provider = settingsManager.getDefaultProvider(), id = settingsManager.getDefaultModel();
  const model = provider && id ? services.modelRuntime.getModel(provider, id) : undefined;
  if (provider && id && (!model || !services.modelRuntime.hasConfiguredAuth(provider))) throw Error('Configured default model unavailable.');
  const created = await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model });
  if (!created.session.model || created.modelFallbackMessage) { created.session.dispose(); throw Error('Usual model unavailable.'); }
  return { ...created, services, diagnostics: services.diagnostics };
 };
 const sessionManager = sdk.SessionManager.create(request.folder, path.join(request.launchDir, 'sessions'));
 sessionManager.appendSessionInfo(request.label);
 const runtime = await sdk.createAgentSessionRuntime(factory, { cwd: request.folder, agentDir: request.agentDir, sessionManager });
 sdk.initTheme(runtime.services.settingsManager.getTheme(), true);
 return { runtime, sdk };
}

async function main(requestFile = process.argv[2], presentation = {}) {
 const request = JSON.parse(await fs.readFile(requestFile, 'utf8'));
 try {
  const env = windows.cleanEnv();
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = request.agentDir;
  process.env.PI_WINDOW_REQUEST = requestFile;
  process.env.TELEGRAM_PI_MODE = 'topics';
  if (request.telegramRuntime) process.env.TELEGRAM_PI_RUNTIME_DIR = request.telegramRuntime;
  process.env.TELEGRAM_PI_AUTO_LOGON = '1';
  process.env.AI_AGENT = 'pi'; process.env.PI_CODING_AGENT = 'true';
  process.env.JITI_FS_CACHE = '0'; process.env.NODE_DISABLE_COMPILE_CACHE = '1';
  // Use the existing model catalog, without background catalog/package updates.
  // This does not disable authenticated inference by the usual default model.
  process.env.PI_OFFLINE = '1'; process.env.PI_SKIP_VERSION_CHECK = '1';
  const folder = await windows.checkedDirectory(request.folder);
  const launchDir = await windows.checkedDirectory(request.launchDir);
  if (!windows.inside(await windows.checkedDirectory(windows.tempRoot()), launchDir)) throw Error('Window runtime must be external Temp.');
  const states = [launchDir, request.agentDir, request.telegramRuntime].filter(Boolean);
  if (states.some(state => windows.inside(folder, path.resolve(state)))) throw Error('Window state overlaps project.');
  const releases = [];
  const pinned = async index => {
   if (index < states.length) return windows.withPinned(states[index], (_, release) => { releases.push(release); return pinned(index + 1); });
   process.chdir(folder);
   const temp = await fs.mkdtemp(path.join(launchDir, 'tmp-'));
   process.env.TMP = temp; process.env.TEMP = temp; process.env.TMPDIR = temp;
   const { runtime, sdk } = await createRuntime(request);
   // InteractiveMode's normal shutdown disposes the runtime, then exits the
   // process; it does not unwind main's finally blocks. Drain our bounded cwd
   // holders through stdin EOF before returning from that normal lifecycle.
   const dispose = runtime.dispose.bind(runtime);
   runtime.dispose = async () => {
    try { return await dispose(); }
    finally { await Promise.all(releases.map(release => release())); }
   };
   // Only terminal presentation is replaceable for a headless startup regression;
   // settings, loader, models, session creation and lifecycle remain production.
   const unlisten = runtime.session.extensionRunner.onError(error => {
    // ExtensionAPI dispatch is void; the SDK reports asynchronous preflight
    // failures here. Never leave one looking like first-message acceptance.
    if (error.event === 'send_user_message') void windows.publishReady(request, { error: 'Window first instruction was not accepted.' }).catch(() => {});
   });
   try {
    if (presentation.present) return await presentation.present(runtime);
    return await new sdk.InteractiveMode(runtime).run();
   } finally { unlisten(); }
  };
  await windows.withPinned(folder, (_, release) => { releases.push(release); return pinned(0); });
 } catch {
  await windows.publishReady(request, { error: 'Pi TUI startup or Telegram logon failed.' }).catch(() => {});
  console.error('Pi window startup was not confirmed.');
 }
}
module.exports = { main, createRuntime };
if (require.main === module) void main();
