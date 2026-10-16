import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateConfig, childEnvironment } from './launch.mjs';

const { cfg } = validateConfig(process.argv[2]);
// Set isolated roots before importing SDK/extension modules which capture them.
Object.assign(process.env, childEnvironment(cfg));
delete process.env.PI_SESSION_FILE;
delete process.env.PI_SESSION_ID;
delete process.env.PI_CLI;
delete process.env.NODE_OPTIONS;
delete process.env.NODE_PATH;
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(cfg.sdkEntry).href);
const agentDir = process.env.PI_CODING_AGENT_DIR;
const put = (name, value) => fs.writeFileSync(path.join(cfg.runDir, name), JSON.stringify(value, null, 2));
const events = fs.openSync(path.join(cfg.runDir, 'events.jsonl'), 'wx');
// Private full JSONL, including opaque provider data. Never dump it to Telegram.
const record = value => fs.writeSync(events, JSON.stringify(value) + '\n');
let session;
try {
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false, authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'), modelsStorePath: path.join(agentDir, 'models-store.json'),
  });
  const model = modelRuntime.getModel(cfg.provider, cfg.model);
  if (!model || model.provider !== cfg.provider || model.id !== cfg.model) throw new Error('EXACT_ASTRA_MODEL_UNAVAILABLE');
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, cacheWarming: 'off' });
  const resourceLoader = new DefaultResourceLoader({
    cwd: cfg.cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [cfg.extension], systemPrompt: fs.readFileSync(cfg.systemFile, 'utf8'),
  });
  await resourceLoader.reload();
  if (resourceLoader.getExtensions().errors.length) throw new Error('EXTENSION_LOAD_FAILED');
  const made = await createAgentSession({
    cwd: cfg.cwd, agentDir, modelRuntime, model, thinkingLevel: 'high', resourceLoader, settingsManager,
    tools: ['orchestrate', 'read', 'grep', 'find', 'ls'],
    sessionManager: SessionManager.create(cfg.cwd, path.join(cfg.runDir, 'sessions')),
  });
  session = made.session;
  const assertRoute = () => {
    if (session.model?.provider !== cfg.provider || session.model?.id !== cfg.model) throw new Error('HOST_ROUTE_DRIFT');
  };
  assertRoute();
  if (!session.getActiveToolNames().includes('orchestrate')) throw new Error('ORCHESTRATE_NOT_LOADED');
  session.subscribe(event => {
    record(event);
    put('activity.json', { pid: process.pid, at: new Date().toISOString(), eventType: event.type, toolName: event.toolName });
    if (event.type === 'message_end' && event.message?.role === 'custom' && event.message?.customType === 'orchestrate-result') put('command-result.json', event.message.details);
    if (event.type === 'tool_execution_end' && event.toolName === 'orchestrate') put('latest-orchestrate-result.json', event.result);
  });
  await session.bindExtensions({
    mode: 'json', onError: error => record({ type: 'extension_error', at: new Date().toISOString(), ...error }),
    uiContext: {
      notify: (message, level) => record({ type: 'extension_notify', at: new Date().toISOString(), level, message }),
      input: async title => { record({ type: 'unexpected_ui_input', title }); return undefined; },
      confirm: async title => { record({ type: 'unexpected_ui_confirm', title }); return false; },
      setWidget() {}, setStatus() {}, setEditorText() {}, onTerminalInput: () => () => {},
    },
  });
  put('started.json', { pid: process.pid, at: new Date().toISOString(), sessionFile: session.sessionFile, provider: session.model.provider, model: session.model.id, tools: session.getActiveToolNames(), frozenExtension: cfg.extension, extensionsBound: true });
  await session.prompt(fs.readFileSync(cfg.commandFile, 'utf8'), { expandPromptTemplates: true });
  put('command-returned.json', { at: new Date().toISOString(), hasResult: fs.existsSync(path.join(cfg.runDir, 'command-result.json')) });
  await session.prompt(fs.readFileSync(cfg.supervisorFile, 'utf8'), { streamingBehavior: 'followUp' });
  await session.waitForIdle();
  assertRoute();
  const last = [...session.messages].reverse().find(message => message.role === 'assistant');
  fs.writeFileSync(path.join(cfg.runDir, 'report.md'), session.getLastAssistantText() || '');
  // This is SDK settlement only. Current orchestration inspection decides outcome.
  put('completion.json', { pid: process.pid, at: new Date().toISOString(), sdkSettled: true, stopReason: last?.stopReason, errorMessage: last?.errorMessage, sessionFile: session.sessionFile, orchestrationOutcome: 'inspect-required' });
} catch (error) {
  put('failed.json', { pid: process.pid, at: new Date().toISOString(), error: error.message, sessionFile: session?.sessionFile });
  console.error(error.message);
} finally {
  session?.dispose();
  fs.closeSync(events);
}
