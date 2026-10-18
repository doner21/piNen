'use strict';
// Establish the legacy launcher's offline configuration and authentic global SDK
// layout before any product import. All packages are physical copies, not shims.
const fs = require('node:fs');
const path = require('node:path');
module.exports = function prepareLegacyOffline() {
  const home = require('./round8-owned-temp.cjs')('legacy-offline');
  const packageModules = path.resolve(__dirname, '../../node_modules');
  const siblingModules = path.resolve(__dirname, '../../../node_modules');
  const source = fs.existsSync(path.join(siblingModules, '@earendil-works/pi-coding-agent/package.json')) ? siblingModules : packageModules;
  const modules = path.join(home, 'AppData/Roaming/npm/node_modules');
  fs.cpSync(source, modules, { recursive: true, filter(file) {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('SDK fixture must be physically owned: ' + file);
    return true;
  } });
  const agent = path.join(home, 'agent');
  fs.mkdirSync(agent);
  fs.writeFileSync(path.join(agent, 'auth.json'), '{}\n');
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'offline-worker' }));
  fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: 'https://invalid.example', api: 'openai-completions', apiKey: 'offline',
    models: [{ id: 'offline-worker', name: 'offline-worker', reasoning: false, input: ['text'], contextWindow: 1000000, maxTokens: 8192 }],
  } } }));
  Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', JITI_FS_CACHE: '0',
    XDG_CACHE_HOME: path.join(home, 'cache'), XDG_CONFIG_HOME: path.join(home, 'config'),
    npm_config_cache: path.join(home, 'npm-cache'), NODE_COMPILE_CACHE: path.join(home, 'node-compile-cache') });
  return { home, modules };
};
