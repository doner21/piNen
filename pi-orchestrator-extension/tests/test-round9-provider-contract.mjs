import runtime from '../tools/round9-runtime.cjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { safeHostFailure } from '../../agent/skills/headless-orchestration/scripts/launch.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(runtime.modules, '@earendil-works/pi-ai');
for (let p = packageRoot; ; p = path.dirname(p)) { assert.equal(fs.lstatSync(p).isSymbolicLink(), false); if (path.dirname(p) === p) break; }
const { openaiCodexOAuth } = await import(pathToFileURL(path.join(packageRoot, 'dist/auth/oauth/openai-codex.js')));
const { resolveProviderAuth } = await import(pathToFileURL(path.join(packageRoot, 'dist/auth/resolve.js')));
const secret = () => randomBytes(24).toString('hex');
const first = secret(), rotated = secret(), access = 'e30.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-only' } })).toString('base64') + '.fixture';
let requests = 0, current = { type: 'oauth', access: secret(), refresh: first, expires: 0 }, chain = Promise.resolve();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, options) => {
  requests++;
  assert.equal(options.body.get('grant_type'), 'refresh_token');
  assert.equal(options.body.get('refresh_token'), first, 'no stale refresh-token reuse');
  return { ok: true, json: async () => ({ access_token: access, refresh_token: rotated, expires_in: 3600 }) };
};
// The real provider resolver's single-owner contract; this does NOT integrate
// the owner's main store or prove independently copied stores are safe.
const store = {
  read: async () => structuredClone(current),
  modify: async (_provider, fn) => {
    const operation = chain.then(async () => { const next = await fn(structuredClone(current)); if (next) current = next; return structuredClone(current); });
    chain = operation.then(() => undefined); return operation;
  },
};
try {
  const provider = { id: 'openai-codex', auth: { oauth: openaiCodexOAuth } };
  const consumers = await Promise.all([0, 1, 2].map(() => resolveProviderAuth(provider, store, {})));
  assert.equal(requests, 1, 'two runtime consumers and simulated main share one renewal owner');
  assert.equal(current.refresh, rotated);
  for (const consumer of consumers) assert.equal(consumer.auth.apiKey, access);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ access_token: first }) });
  let failure;
  try { await openaiCodexOAuth.refresh(current, new AbortController().signal); } catch (error) { failure = error; }
  assert.ok(failure, 'actual adapter rejects malformed provider response');
  assert.ok(!safeHostFailure(failure).includes(first), 'host does not echo malformed credential-bearing errors');
  console.log('PASS installed rotating provider contract with single shared owner, malformed-error boundary');
  console.log('LIMITATION automatic integration with main and two isolated runtimes is deferred; no owner login was read or renewed');
} finally { globalThis.fetch = originalFetch; }
