'use strict';
// One bot owner. Only this module's service polls; Pi sessions use local IPC.
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const inbound = require('./inbound.cjs');
const MAX_FRAME = 16 * 1024 * 1024; // accommodates one validated <=10 MB image/document
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // local IPC budget, not Telegram's limit
const DOCUMENT_UNCONFIRMED = 'Document upload not confirmed. Delivery may have occurred; do not retry automatically.';
class DocumentValidationError extends Error {}

function protectedDocumentName(name) {
 return /^(?:\.env(?:[._-].*)?|secret\.token|router-(?:control|endpoint)\.json|\.?(?:auth|oauth|credentials?|secrets?|tokens?|config|mcp)(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|\.npmrc|\.netrc|\.git-credentials|\.ssh|\.aws|\.azure)$/i.test(name) || /\.(?:pem|key|p12|pfx|keystore)$/i.test(name);
}
function hasDocumentSecret(text, token) {
 return !!(token && text.includes(token)) || /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/.test(text) ||
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(text) ||
  /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/.test(text) ||
  // Router endpoint/control JSON uses a 64-hex bearer capability under "key".
  // Match that credential value, not ordinary prose or benign key fields.
  /"key"\s*:\s*"[a-f0-9]{64}"/i.test(text) ||
  // Names in prose (e.g. AGENTS.md) are fine; credential assignments are not.
  /["']?\b(?:[A-Z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD)|access_token|refresh_token|private_key)["']?\s*[:=]\s*["']?[A-Za-z0-9_+\/-]{16,}/i.test(text);
}
function documentCaption(caption = '', token) {
 if (typeof caption !== 'string' || caption.length > 1024) throw new DocumentValidationError('Document caption must be plaintext, at most 1024 characters.');
 if (hasDocumentSecret(caption, token)) throw new DocumentValidationError('Document caption contains credential data.');
 return caption;
}
function validateDocument(data, name, caption, token) {
 if (typeof name !== 'string' || !name || name.length > 255 || /[\\/:\x00-\x1f\x7f]/.test(name) || name === '.' || name === '..') throw new DocumentValidationError('Document filename must be a basename.');
 if (protectedDocumentName(name) || hasDocumentSecret(name, token)) throw new DocumentValidationError('Protected credential files cannot be sent.');
 if (!Buffer.isBuffer(data) || !data.length) throw new DocumentValidationError('Document is empty.');
 if (data.length > MAX_DOCUMENT_BYTES) throw new DocumentValidationError('Document too large (max 10MB).');
 // Scan binary too, including UTF-16 credential exports. Never return scanned data.
 if (['utf8', 'latin1', 'utf16le'].some(encoding => hasDocumentSecret(data.toString(encoding), token))) throw new DocumentValidationError('Document contains credential data.');
 // Decode BE on a copy of complete code units; swap16 must not mutate upload bytes.
 const utf16be = Buffer.from(data.subarray(0, data.length - data.length % 2)).swap16().toString('utf16le');
 if (hasDocumentSecret(utf16be, token)) throw new DocumentValidationError('Document contains credential data.');
 documentCaption(caption, token);
}
async function documentPathStats(abs) {
 const stats = [];
 for (let current = abs; ; current = path.dirname(current)) {
  const st = await fs.lstat(current);
  if (st.isSymbolicLink()) throw new DocumentValidationError('Document symlinks (including parents) are not allowed.');
  if (protectedDocumentName(path.basename(current))) throw new DocumentValidationError('Protected credential files cannot be sent.');
  stats.push({ path: current, st });
  if (path.dirname(current) === current) break;
 }
 return stats;
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
/** Read once through a checked handle; upload only these bounded, validated bytes. */
async function readDocument(input, cwd, token, caption) {
 let handle;
 try {
  documentCaption(caption, token);
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new DocumentValidationError('A local document file is required.');
  const abs = path.resolve(cwd || process.cwd(), input), name = path.basename(abs);
  if (/^[/\\]{2}/.test(input) || /^[/\\]{2}/.test(abs)) throw new DocumentValidationError('Document must be a local path, not a network share.');
  const before = await documentPathStats(abs), st = before[0].st;
  if (!st.isFile()) throw new DocumentValidationError('Document must be a regular local file.');
  if (!st.size) throw new DocumentValidationError('Document is empty.');
  if (st.size > MAX_DOCUMENT_BYTES) throw new DocumentValidationError('Document too large (max 10MB).');
  const constants = require('node:fs').constants;
  handle = await fs.open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  const opened = await handle.stat();
  if (!opened.isFile() || !sameFile(st, opened) || opened.size !== st.size) throw new DocumentValidationError('Document changed while reading.');
  const buffer = Buffer.alloc(st.size + 1); let length = 0;
  while (length < buffer.length) {
   const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
   if (!bytesRead) break;
   length += bytesRead;
  }
  const final = await handle.stat(), after = await documentPathStats(abs);
  if (length !== st.size || final.size !== st.size || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs ||
   before.length !== after.length || before.some((entry, i) => !sameFile(entry.st, after[i].st)) || !sameFile(final, after[0].st)) throw new DocumentValidationError('Document changed while reading.');
  const data = buffer.subarray(0, length);
  validateDocument(data, name, caption, token);
  return { ok: true, data, name };
 } catch (e) {
  // Only our static errors are safe; OS errors can include absolute paths.
  return { ok: false, message: e instanceof DocumentValidationError ? e.message : 'Document cannot be read safely.' };
 } finally { await handle?.close().catch(() => {}); }
}
function decodeDocument(document, token) {
 if (!document || typeof document.data !== 'string' || document.data.length > 4 * Math.ceil(MAX_DOCUMENT_BYTES / 3) ||
  document.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(document.data)) throw Error('Invalid document data.');
 const data = Buffer.from(document.data, 'base64');
 if (data.toString('base64') !== document.data) throw Error('Invalid document data.');
 validateDocument(data, document.name, document.caption, token);
 return data;
}
const clean = s => String(s ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/g, '').slice(0, 4000);
function redact(s, token) {
 let out = String(s ?? '');
 if (token) out = out.split(token).join('[token-redacted]');
 return out.replace(/https?:\/\/api\.telegram\.org\/bot[^\s"']+/gi, '[bot-api-redacted]').replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[token-redacted]');
}
function chunks(s) {
 const result = []; let left = String(s);
 while (left.length) {
  let cut = Math.min(4096, left.length);
  if (cut < left.length && /[\uD800-\uDBFF]/.test(left[cut - 1])) cut--;
  result.push(left.slice(0, cut)); left = left.slice(cut);
 }
 return result;
}
async function atomic(file, value) {
 await fs.mkdir(path.dirname(file), { recursive: true });
 const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
 try { await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600 }); await fs.rename(tmp, file); }
 finally { await fs.unlink(tmp).catch(() => {}); }
}
// This file contains IDs and mode selection only. Tokens remain environment-only.
function selectRuntime(baseDir, env = process.env) {
 if (env.TELEGRAM_PI_MODE === 'legacy') return { mode: 'legacy', dir: baseDir, config: null };
 let config = null;
 try {
  const raw = require('node:fs').readFileSync(path.join(baseDir, 'deployment.json'), 'utf8');
  config = JSON.parse(raw);
  const fields = ['version', 'mode', 'runtimeDir', 'chatId', 'allowlist', 'botUsername'];
  if (!config || config.version !== 1 || !['legacy', 'topics'].includes(config.mode) || Object.keys(config).some(k => !fields.includes(k))) throw Error();
  if (config.mode === 'topics' && (typeof config.runtimeDir !== 'string' || !path.isAbsolute(config.runtimeDir) || !Number.isSafeInteger(config.chatId) || config.chatId >= 0 || !Array.isArray(config.allowlist) || !config.allowlist.length || config.allowlist.some(x => !Number.isSafeInteger(x) || x <= 0) || typeof config.botUsername !== 'string' || !/^[A-Za-z0-9_]+$/.test(config.botUsername))) throw Error();
 } catch (e) { if (e.code !== 'ENOENT') throw Error('Invalid Telegram deployment configuration; refusing to fall back to legacy polling'); }
 const mode = env.TELEGRAM_PI_MODE || config?.mode || 'legacy';
 if (!['legacy', 'topics'].includes(mode)) throw Error('Invalid Telegram deployment mode');
 return { mode, dir: env.TELEGRAM_PI_RUNTIME_DIR || config?.runtimeDir || baseDir, config };
}
async function legacyTransaction(dir, fn) {
 const lock = path.join(dir, 'state.lock');
 await fs.mkdir(dir, { recursive: true });
 const handle = await fs.open(lock, 'wx').catch(() => { throw Error('Legacy bridge state is busy; retry without deleting its lock'); });
 try { await handle.writeFile(`${process.pid}\n${Date.now()}\n`); return await fn(); }
 finally { await handle.close(); await fs.unlink(lock); }
}
async function disableLegacyAuto(dir) {
 return legacyTransaction(dir, async () => {
  let state;
  try { state = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw Error('Legacy state unreadable; no configuration changed'); }
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw Error('Legacy state invalid');
  await atomic(path.join(dir, 'state.json'), { ...state, enabled: false }); return state;
 });
}
function alive(pid) { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
// Reserve the OLD cooperative ownership mechanism only after its operator has stopped it.
// A living legacy claim is never treated as drained merely because shared polling=false.
async function legacyFence({ dir, onConflict = () => {} }) {
 const file = path.join(dir, 'active-session.json');
 async function check() {
  let claim;
  try { claim = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return; throw Error('Legacy ownership unreadable; refusing to poll'); }
  if (!Number.isSafeInteger(claim?.pid) || claim.pid <= 0) throw Error('Legacy ownership invalid');
  if (alive(claim.pid) && !(claim.mode === 'topics-router' && claim.pid === process.pid)) throw Error('Old Telegram legacy owner is still alive; stop ONLY its Telegram polling before activation');
 }
 await check();
 const previous = await disableLegacyAuto(dir);
 await check();
 const reserve = () => atomic(file, { pid: process.pid, mode: 'topics-router', cwd: dir, ts: Date.now(), reason: 'topics-router' });
 await reserve();
 let closing = false, tail = Promise.resolve();
 const timer = setInterval(() => {
  if (closing) return;
  tail = tail.then(async () => { await check(); await reserve(); }).catch(e => { clearInterval(timer); onConflict(e); });
 }, 20000); timer.unref();
 return { previous, async close() { closing = true; clearInterval(timer); await tail; } };
}
function canonical(s) { return s ? path.resolve(s).replace(/\\/g, '/').toLowerCase() : ''; }
function endpointFor(token) {
 const hash = createHash('sha256').update(token).digest('hex').slice(0, 32);
 return process.platform === 'win32' ? `\\\\.\\pipe\\pi-telegram-${hash}` : path.join(os.tmpdir(), `pi-telegram-${process.getuid?.() ?? 'user'}-${hash}.sock`);
}
class BotApi {
 #token; #fetch;
 constructor(token, fetchImpl = fetch, signal) { if (!token) throw Error('TELEGRAM_BOT_TOKEN environment variable required'); this.#token = token; this.#fetch = fetchImpl; this.signal = signal; }
 safe(text) { return redact(text, this.#token); }
 async call(method, body = {}, signal = this.signal) {
  try {
   // Defend every user-visible Bot API text surface, not merely logs.
   body = { ...body }; for (const field of ['text', 'caption', 'name']) if (typeof body[field] === 'string') body[field] = this.safe(body[field]);
   const response = await this.#fetch(`https://api.telegram.org/bot${this.#token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal });
   const json = await response.json();
   if (!response.ok || !json.ok) {
    const e = Error(this.safe(`Telegram ${method}: ${response.status ?? json.error_code} ${json.description ?? 'request refused'}`)); e.status = json.error_code ?? response.status; throw e;
   }
   return json.result;
  } catch (e) { const err = Error(this.safe(e.message ?? 'Telegram request failed')); err.status = e.status; throw err; }
 }
 async download(message, owns = () => true) {
  try {
   const meta = inbound.metadata(message);
   validateDocument(Buffer.from('metadata'), meta.name, meta.caption, this.#token);
   const info = await this.call('getFile', { file_id: meta.fileId });
   if (info?.file_size !== meta.size) throw Error();
   if (!(await owns())) throw Error();
   const file = inbound.filePath(info.file_path);
   const response = await this.#fetch(`https://api.telegram.org/file/bot${this.#token}/${file}`, { redirect: 'error', signal: this.signal });
   const data = await inbound.bounded(response);
   validateDocument(data, meta.name, meta.caption, this.#token);
   const mime = inbound.content(data, meta);
   return { data: data.toString('base64'), mime, image: meta.image };
  } catch { throw Error(inbound.REFUSAL); }
 }
 async document(chatId, topic, base64, name, caption) {
  const data = decodeDocument({ data: base64, name, caption }, this.#token);
  try {
   const form = new FormData(); form.set('chat_id', String(chatId));
   if (topic != null) form.set('message_thread_id', String(topic));
   form.set('document', new Blob([data], { type: 'application/octet-stream' }), name);
   if (caption) form.set('caption', caption); // plaintext, no parse_mode
   const response = await this.#fetch(`https://api.telegram.org/bot${this.#token}/sendDocument`, { method: 'POST', body: form });
   const json = await response.json();
   if (!response.ok || json.ok !== true || !Number.isSafeInteger(json.result?.message_id) || json.result.message_id <= 0) throw Error();
   return { ok: true, message: `Document sent: ${name} (${data.length} bytes), message_id ${json.result.message_id}.`, message_id: json.result.message_id, filename: name, size: data.length };
  } catch { throw Error(DOCUMENT_UNCONFIRMED); } // no descriptions, URLs, file data or retries
 }
 async photo(chatId, topic, base64, mime, name, caption) {
  const data = Buffer.from(base64, 'base64');
  const jpeg = data[0] === 255 && data[1] === 216 && data[2] === 255;
  const png = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const webp = data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  const actual = jpeg ? 'image/jpeg' : png ? 'image/png' : webp ? 'image/webp' : '';
  if (!actual || mime !== actual || !data.length || data.length > 10 * 1024 * 1024) throw Error('Invalid image (JPEG/PNG/WebP, <=10MB)');
  const form = new FormData(); form.set('chat_id', String(chatId)); form.set('message_thread_id', String(topic));
  form.set('photo', new Blob([data], { type: actual }), this.safe(path.basename(name || 'image')));
  if (caption) form.set('caption', this.safe(caption).slice(0, 1024));
  try {
   const response = await this.#fetch(`https://api.telegram.org/bot${this.#token}/sendPhoto`, { method: 'POST', body: form, signal: this.signal });
   const json = await response.json(); if (!response.ok || !json.ok) throw Error(`Telegram sendPhoto: ${json.error_code ?? response.status} ${json.description ?? ''}`);
  } catch (e) { throw Error(this.safe(e.message)); }
 }
}
class Router {
 constructor({ dir, api, chatId, allowlist, now = Date.now, staleMs = 60000, launchWindow }) {
  if (!Number.isSafeInteger(chatId) || chatId >= 0 || !allowlist?.length || allowlist.some(x => !Number.isSafeInteger(x) || x <= 0)) throw Error('Private forum group ID and positive allowed user IDs required');
  this.dir = path.resolve(dir); this.api = api; this.chatId = chatId; this.allowlist = [...allowlist]; this.now = now; this.staleMs = staleMs;
  this.connections = new Map(); this.live = new Map(); this.tail = Promise.resolve(); this.lastError = '';
  this.launchWindow = launchWindow; this.windowJobs = Promise.resolve();
  this.state = { version: 1, chatId, offset: 0, bindings: [], tickets: {} };
 }
 safe(s) { return this.api.safe ? this.api.safe(s) : redact(s); }
 async load() {
  try {
   const parsed = JSON.parse(await fs.readFile(path.join(this.dir, 'routes.json'), 'utf8'));
   if (parsed.version !== 1 || parsed.chatId !== this.chatId || !Array.isArray(parsed.bindings) || !parsed.tickets || !Number.isSafeInteger(parsed.offset)) throw Error('invalid');
   const topics = new Set();
   for (const b of parsed.bindings) {
    if (!b.id || !Number.isSafeInteger(b.topic) || b.topic <= 1 || topics.has(b.topic) || !Array.isArray(b.files)) throw Error('invalid'); topics.add(b.topic);
   }
   this.state = parsed;
  } catch (e) { if (e.code !== 'ENOENT') throw Error('Routing state unreadable or mismatched; refusing to recreate topics'); }
 }
 save() { return atomic(path.join(this.dir, 'routes.json'), this.state); }
 serial(fn) { const op = this.tail.then(fn); this.tail = op.catch(() => {}); return op; }
 attach(connection, send) { this.connections.set(connection, send); }
 online(b) { const live = this.live.get(b.topic); return !!(b.loggedOn && live && this.connections.has(live.connection) && this.now() - live.heartbeat <= this.staleMs); }
 own(connection, request) {
  const b = this.state.bindings.find(b => b.id === request.id), live = b && this.live.get(b.topic);
  if (!b || !b.loggedOn || !live || live.connection !== connection || live.lease !== request.lease || !this.online(b)) throw Error('Session does not own a live topic binding');
  return b;
 }
 async title(b) {
  const name = this.safe(`${this.online(b) ? '' : '[offline] '}${b.label} · ${b.id.slice(0, 8)}`).slice(0, 128);
  if (name === b.title) return;
  await this.api.call('editForumTopic', { chat_id: this.chatId, message_thread_id: b.topic, name }); b.title = name; await this.save();
 }
 register(connection, identity, inheritedOnly = false) { return this.serial(async () => {
  if (!this.connections.has(connection)) throw Error('Local connection closed');
  if (typeof identity.id !== 'string' || !identity.id || identity.id.length > 200 || typeof identity.lease !== 'string' || !identity.lease || !Number.isSafeInteger(identity.pid) || identity.pid <= 0) throw Error('Invalid session identity');
  const file = canonical(identity.sessionFile), parent = canonical(identity.parentSession);
  let b = this.state.bindings.find(b => b.id === identity.id || (file && b.files.includes(file)));
  if (!b && parent) b = this.state.bindings.find(b => b.files.includes(parent) && b.loggedOn);
  if (inheritedOnly && (!b || !b.loggedOn)) return null;
  if (b && this.online(b)) {
   const live = this.live.get(b.topic);
   if (b.id !== identity.id || live.lease !== identity.lease || live.connection !== connection) throw Error('Parent/session topic is still live; log it off before rebinding');
  }
  if (!b) {
   const result = await this.api.call('createForumTopic', { chat_id: this.chatId, name: this.safe(clean(identity.label || identity.id)).slice(0, 128) });
   if (!Number.isSafeInteger(result?.message_thread_id) || result.message_thread_id <= 1) throw Error('Telegram did not return a forum topic');
   b = { topic: result.message_thread_id, id: identity.id, label: this.safe(clean(identity.label || identity.id)), cwd: this.safe(clean(identity.cwd)), model: this.safe(clean(identity.model)), pid: identity.pid, sessionFile: this.safe(identity.sessionFile || ''), files: file ? [file] : [], loggedOn: true, activity: this.now() }; this.state.bindings.push(b);
   // Publish the topic immediately, before further API operations can fail.
   await this.save();
  } else if (!b.loggedOn) await this.api.call('reopenForumTopic', { chat_id: this.chatId, message_thread_id: b.topic });
  const oldId = b.id;
  Object.assign(b, { id: identity.id, label: this.safe(clean((identity.explicitLabel ? identity.label : b.label) || identity.label || identity.id)).replace(/\n/g, ' ').slice(0, 100), cwd: this.safe(clean(identity.cwd)), pid: identity.pid, model: this.safe(clean(identity.model)), sessionFile: this.safe(identity.sessionFile || ''), loggedOn: true, activity: this.now() });
  if (file && !b.files.includes(file)) b.files.push(file);
  this.live.set(b.topic, { connection, lease: identity.lease, heartbeat: this.now(), capabilities: Array.isArray(identity.capabilities) ? identity.capabilities : [], images: identity.images === true });
  await this.save(); await this.title(b);
  if (oldId && oldId !== b.id) {
   await this.settleUncertain(b.topic);
   for (const ticket of Object.values(this.state.tickets)) if (ticket.topic === b.topic && ticket.session !== b.id && ticket.status === 'accepted') {
    ticket.status = 'interrupted'; await this.save();
    await this.text(b.topic, 'The previous session accepted a message but did not confirm its reply before rotation. It will not be replayed into the new session.');
   }
  }
  return { topic: b.topic, chatId: this.chatId, label: b.label };
 }); }
 heartbeat(connection, request) {
  const b = this.state.bindings.find(b => b.id === request.id), live = b && this.live.get(b.topic);
  if (!live || live.connection !== connection || live.lease !== request.lease || !b.loggedOn) throw Error('Session binding not registered');
  live.heartbeat = this.now(); if (request.model) b.model = clean(request.model);
  if (typeof request.images === 'boolean') live.images = request.images;
  return { ok: true };
 }
 disconnect(connection) {
  this.connections.delete(connection); // liveness changes immediately, before any queued API work
  return this.serial(async () => {
   for (const b of this.state.bindings) if (this.live.get(b.topic)?.connection === connection) {
    const lease = this.live.get(b.topic).lease;
    this.live.delete(b.topic);
    const interrupted = Object.values(this.state.tickets).filter(t => t.topic === b.topic && t.session === b.id && t.lease === lease && t.status === 'accepted');
    for (const ticket of interrupted) ticket.status = 'interrupted';
    if (interrupted.length) {
     await this.save();
     // The bot may already be shutting down; settling tickets must not depend
     // on a network notification, and never retries or replays their contents.
     try { await this.text(b.topic, 'Pi disconnected before confirming queued replies. These messages will not be replayed; please resend after reconnecting.'); } catch {}
    }
    await this.title(b); await this.settleUncertain(b.topic);
   }
  });
 }
 logoff(connection, request) { return this.serial(async () => {
  const b = this.own(connection, request); b.loggedOn = false; this.live.delete(b.topic); await this.save();
  await this.title(b); await this.settleUncertain(b.topic);
  for (const ticket of Object.values(this.state.tickets)) if (ticket.topic === b.topic && ticket.status === 'accepted') ticket.status = 'interrupted';
  await this.save();
  await this.api.call('closeForumTopic', { chat_id: this.chatId, message_thread_id: b.topic }); return { ok: true, message: 'Logged off; topic stays readable.' };
 }); }
 status() {
  return { mode: 'topics', capabilities: ['send_document', 'receive_attachments'], polling: !!this.polling, chatId: this.chatId, lastError: this.safe(this.lastError), sessions: this.state.bindings.map(b => ({ id: b.id, label: b.label, cwd: b.cwd, model: b.model, pid: b.pid, topic: b.topic, loggedOn: b.loggedOn, online: this.online(b), lastActivity: b.activity })) };
 }
 async text(topic, text) { for (const part of chunks(this.safe(text))) await this.api.call('sendMessage', { chat_id: this.chatId, ...(topic && topic !== 1 ? { message_thread_id: topic } : {}), text: part }); }
 async settleUncertain(topic) {
  for (const ticket of Object.values(this.state.tickets)) if (ticket.topic === topic && ticket.status === 'offered') {
   ticket.status = 'uncertain'; await this.save();
   await this.text(topic, 'Session went offline before delivery was confirmed. Delivery is uncertain; this message will not be replayed into another session.');
  }
 }
 sweep() { return this.serial(async () => {
  for (const b of this.state.bindings) { await this.title(b); if (!this.online(b)) await this.settleUncertain(b.topic); }
 }); }
 update(update) { return this.serial(async () => {
  const id = update?.update_id;
  if (!Number.isSafeInteger(id) || id < 0 || id < this.state.offset) return;
  // A crash can persist the offered ticket before its update offset. Never offer it again.
  if (this.state.tickets[`tg-${id}`]) { this.state.offset = id + 1; await this.save(); return; }
  const m = update.message;
  if (m && (typeof m.text === 'string' || inbound.isAttachment(m)) && m.chat?.id === this.chatId && m.chat.type === 'supergroup' && this.allowlist.includes(m.from?.id) && !m.from?.is_bot) {
   const topic = Number.isSafeInteger(m.message_thread_id) && m.message_thread_id > 1 ? m.message_thread_id : 1;
   const attachmentMessage = inbound.isAttachment(m);
   const command = attachmentMessage ? '' : m.text.trim().split(/\s/)[0].split('@')[0].toLowerCase();
   const b = this.state.bindings.find(b => b.topic === topic);
   if (command === '/new') {
    // Consume in every project topic without forwarding to its Pi session.
    // Persist deduplication before effects, and never hold the registration
    // queue while a new window logs on through this same router.
    this.state.offset = id + 1; await this.save();
    if (topic === 1) {
     const text = m.text.trimStart().replace(/^\S+\s*/, '');
     this.windowJobs = this.windowJobs.then(async () => {
      try {
       if (!this.launchWindow) throw Error('Window launcher is not configured.');
       const result = await this.launchWindow(text);
       if (!Number.isSafeInteger(result?.topic) || result.topic <= 1 || !result.label) throw Error('Topic logon not confirmed.');
       await this.text(1, `New window topic: ${result.label}`);
      } catch { await this.text(1, 'New window refused or startup/logon not confirmed. No successful launch is claimed.'); }
     }).catch(() => { this.lastError = 'Window result could not be delivered.'; });
    }
    return;
   } else if (command === '/sessions' && topic === 1) {
    const list = this.status().sessions.map(b => `${b.label} · ${b.online ? 'online' : 'offline'} · topic ${b.topic}\n${b.cwd}\n${b.model || '(model unknown)'} · last activity ${new Date(b.lastActivity).toISOString()}`);
    await this.text(topic, list.join('\n\n') || 'No logged-on sessions.');
   } else if (command === '/where') {
    await this.text(topic, b ? `${b.label} → ${b.id}\n${b.cwd}\n${b.model}\n${this.online(b) ? 'online' : 'offline'}` : 'General/unbound topic: no session is bound here.');
   } else if (!b) await this.text(topic, 'This topic is unbound. Message not delivered. Use /sessions in General.');
   else if (!this.online(b)) await this.text(topic, `${b.label} is offline. Message not delivered.`);
   else {
    const outstanding = Object.values(this.state.tickets).filter(t => t.topic === topic && ['offered', 'accepted'].includes(t.status));
    if (outstanding.length >= 50) await this.text(topic, 'Session queue is full. Message not delivered; please try again later.');
    else {
     const live = this.live.get(topic), ticket = `tg-${id}`;
     let attachment;
     if (attachmentMessage) {
      try {
       const meta = inbound.metadata(m);
       if (!live.capabilities?.includes('receive_attachments') || (meta.image && !live.images)) throw Error();
       attachment = await this.api.download(m, () => this.online(b) && this.live.get(topic) === live);
      } catch { await this.text(topic, inbound.REFUSAL + ' Session attachment/image support is required.'); this.state.offset = id + 1; await this.save(); return; }
      if (!this.online(b) || this.live.get(topic) !== live) { this.state.offset = id + 1; await this.save(); await this.text(topic, 'Session went offline during attachment download. Not delivered; never replayed.'); return; }
     }
     this.state.tickets[ticket] = { topic, session: b.id, lease: live.lease, status: 'offered' }; b.activity = this.now();
     await this.save(); // never inject an unrecorded delivery
     // Recheck after the disk await; do not fall through to another connection.
     if (this.online(b) && this.live.get(topic) === live) this.connections.get(live.connection)({ type: 'delivery', ticket, text: this.safe(clean(attachmentMessage ? m.caption ?? '' : m.text)), ...(attachment ? { attachment } : {}), fromName: this.safe(clean(m.from.username || m.from.first_name || String(m.from.id))).replace(/\n/g, ' '), fromId: m.from.id, session: b.id });
     else await this.settleUncertain(topic);
    }
   }
  }
  this.state.offset = id + 1;
  // Bound completed ticket retention, but retain every still-pending delivery.
  const finished = Object.keys(this.state.tickets).filter(k => !['offered', 'accepted'].includes(this.state.tickets[k].status));
  for (const k of finished.slice(0, Math.max(0, finished.length - 1000))) delete this.state.tickets[k];
  await this.save();
 }); }
 ack(connection, request) { return this.serial(async () => {
  const b = this.own(connection, request), ticket = this.state.tickets[request.ticket];
  if (!ticket || ticket.topic !== b.topic || ticket.session !== b.id || ticket.lease !== request.lease || ticket.status !== 'offered') throw Error('Delivery binding no longer owned');
  ticket.status = request.accepted ? 'accepted' : 'refused'; await this.save();
  if (!request.accepted) await this.text(b.topic, 'Pi could not accept this message. Message not delivered.');
  return { ok: true };
 }); }
 reply(connection, request) { return this.serial(async () => {
  const b = this.own(connection, request), ticket = this.state.tickets[request.ticket];
  if (!ticket || ticket.topic !== b.topic || ticket.session !== b.id || ticket.lease !== request.lease || ticket.status !== 'accepted') throw Error('Reply is not for an owned delivery binding');
  await this.text(b.topic, request.text); ticket.status = 'replied'; b.activity = this.now(); await this.save(); return { ok: true };
 }); }
 send(connection, request) { return this.serial(async () => {
  const b = this.own(connection, request);
  if (request.thread_id != null && request.thread_id !== b.topic) throw Error('Cannot send to another session topic');
  let result;
  if (request.document) {
   if (request.photo != null || request.text != null) throw Error('Document sends cannot include text or photos.');
   decodeDocument(request.document); // revalidate untrusted IPC before the API call
   const d = request.document;
   result = await this.api.document(this.chatId, b.topic, d.data, d.name, d.caption);
  } else if (request.photo) await this.api.photo(this.chatId, b.topic, request.photo.data, request.photo.mime, request.photo.name, request.photo.caption);
  else await this.text(b.topic, request.text);
  b.activity = this.now();
  // An upload is already confirmed; a local persistence failure must not invite a resend.
  if (result) { try { await this.save(); } catch { this.lastError = 'Document sent; topic activity could not be saved.'; } return result; }
  await this.save(); return { ok: true, message: 'Sent to this session topic.' };
 }); }
}
function frames(socket, onFrame) {
 let buffer = ''; const decoder = new StringDecoder('utf8');
 socket.on('data', data => {
  buffer += decoder.write(data);
  if (Buffer.byteLength(buffer) > MAX_FRAME) { socket.destroy(); return; }
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
   const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
   try { onFrame(JSON.parse(line)); } catch { socket.destroy(); return; }
  }
 });
}
function write(socket, data) { if (!socket.destroyed) socket.write(JSON.stringify(data) + '\n'); }
async function serve({ router, token, poll = true, expectedUsername, beforePoll, beforeRelease }) {
 const endpoint = endpointFor(token), key = randomBytes(32).toString('hex'), controlKey = randomBytes(32).toString('hex');
 const controlFile = path.join(router.dir, 'router-control.json');
 const abort = new AbortController(); const sockets = new Set(), owners = new Map(), controllers = new Map(); let stopping = false, closePromise;
 let resolveClosed, rejectClosed; const closedPromise = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; }); closedPromise.catch(() => {});
 const server = net.createServer(socket => {
  if (stopping) { socket.destroy(); return; }
  const connection = randomBytes(12).toString('hex'); sockets.add(socket); owners.set(socket, connection);
  router.attach(connection, d => write(socket, d));
  frames(socket, request => {
   if (!request) { socket.destroy(); return; }
   if (request.action === 'shutdown') {
    if (request.key === key) { write(socket, { id: request.id, ok: false, error: 'Operator control capability required; sessions cannot stop the router' }); return; }
    if (request.key !== controlKey) { socket.destroy(); return; }
    // Keep the operator socket through draining, then send a separate completion frame.
    controllers.set(socket, request.id);
    socket.write(JSON.stringify({ id: request.id, ok: true, result: { accepted: true, completed: false, pid: process.pid } }) + '\n', () => { void close().catch(e => { router.lastError = router.safe(e.message); }); });
    return;
   }
   if (request.key !== key) { socket.destroy(); return; }
   const run = async () => {
    const params = request.params ?? {};
    switch (request.action) {
     case 'logon': return router.register(connection, params);
     case 'inherit': return router.register(connection, params, true);
     case 'heartbeat': return router.heartbeat(connection, params);
     case 'logoff': return router.logoff(connection, params);
     case 'ack': return router.ack(connection, params);
     case 'reply': return router.reply(connection, params);
     case 'send': return router.send(connection, params);
     case 'status': return router.status();
     default: throw Error('Unsupported router action');
    }
   };
   run().then(result => write(socket, { id: request.id, ok: true, result }), e => write(socket, { id: request.id, ok: false, error: router.safe(e.message) }));
  });
  socket.on('error', () => {});
  socket.on('close', () => { sockets.delete(socket); owners.delete(socket); controllers.delete(socket); void router.disconnect(connection).catch(e => { router.lastError = router.safe(e.message); }); });
 });
 await new Promise((resolve, reject) => {
  server.once('error', e => reject(Error(e.code === 'EADDRINUSE' ? 'Another router owns this bot; no second poller started' : 'Could not bind local router endpoint')));
  server.listen(endpoint, resolve);
 });
 if (process.platform !== 'win32') await fs.chmod(endpoint, 0o600);
 let timer, pollPromise = Promise.resolve();
 function close() {
  if (closePromise) return closePromise;
  stopping = true; clearInterval(timer); abort.abort();
  closePromise = (async () => {
   // Remove controller ownership now, while retaining its socket for the final acknowledgement.
   for (const socket of controllers.keys()) void router.disconnect(owners.get(socket)).catch(e => { router.lastError = router.safe(e.message); });
   const closed = [...sockets].filter(socket => !controllers.has(socket)).map(socket => new Promise(resolve => { socket.once('close', resolve); socket.destroy(); }));
   await Promise.all(closed);
   await pollPromise;
   await router.tail; // drain BEFORE releasing the bot lease, so no old write can touch a replacement
   // Capability files are references, not liveness markers. No cleanup write may fail
   // here or clobber a replacement after the lease is released.
   if (beforeRelease) await beforeRelease(); // stop/drain legacy ownership refresh BEFORE lease release
   const serverClosed = new Promise(resolve => server.close(resolve)); // release only after draining
   for (const [socket, id] of controllers) {
    if (!socket.destroyed) socket.end(JSON.stringify({ id, ok: true, result: { accepted: true, completed: true, pid: process.pid } }) + '\n', () => socket.destroy());
   }
   await serverClosed;
   // session descriptor deliberately stays: clients reconnect to the same pipe on restart.
  })();
  closePromise.then(resolveClosed, rejectClosed); return closePromise;
 }
 try {
  await router.load();
  if (router.api instanceof BotApi) router.api.signal = abort.signal;
  if (poll) {
   const me = await router.api.call('getMe'), group = await router.api.call('getChat', { chat_id: router.chatId });
   if (expectedUsername && String(me?.username).toLowerCase() !== expectedUsername.toLowerCase()) throw Error('Router bot identity does not match the approved deployment');
   const member = await router.api.call('getChatMember', { chat_id: router.chatId, user_id: me.id });
   if (group?.type !== 'supergroup' || group.is_forum !== true || !(member?.status === 'creator' || (member?.status === 'administrator' && member.can_manage_topics))) throw Error('Bot must be administrator with Manage Topics in a private forum supergroup');
   if (group.username) throw Error('Use a private forum group (no public username)');
   if (beforePoll) await beforePoll(router, abort);
   if (abort.signal.aborted) throw Error('Router startup cancelled');
   await router.api.call('deleteWebhook', { drop_pending_updates: false });
  }
  await atomic(path.join(router.dir, 'router-endpoint.json'), { endpoint, key, pid: process.pid });
  await atomic(controlFile, { version: 1, endpoint, key: controlKey, pid: process.pid });
  await router.sweep();
  let sweeping = false;
  timer = setInterval(() => {
   if (sweeping || stopping) return; sweeping = true;
   void router.sweep().catch(e => { router.lastError = router.safe(e.message); }).finally(() => { sweeping = false; });
  }, 20000); timer.unref();
  if (poll) pollPromise = (async () => {
   router.polling = true; let backoff = 1000;
   try {
    while (!abort.signal.aborted) {
     try {
      const updates = await router.api.call('getUpdates', { offset: router.state.offset, timeout: 30, allowed_updates: ['message'] }, abort.signal);
      for (const update of updates || []) { if (abort.signal.aborted) break; await router.update(update); }
      backoff = 1000; router.lastError = '';
     } catch (e) {
      if (abort.signal.aborted) break; router.lastError = router.safe(e.message);
      // A foreign/old poller is a deployment error, not permission to fight it.
      if ([401, 404, 409].includes(e.status)) break;
      await new Promise(resolve => { const done = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, backoff); abort.signal.addEventListener('abort', done, { once: true }); });
      backoff = Math.min(backoff * 2, 60000);
     }
    }
   } finally { router.polling = false; }
  })();
  return { close, closed: closedPromise, endpoint, router };
 } catch (e) { await close(); throw Error(router.safe(e.message)); }
}
class Client {
 constructor({ dir, identity, onDelivery }) { this.dir = dir; this.identity = identity; this.onDelivery = onDelivery; this.pending = new Map(); this.next = 0; this.socket = null; this.connecting = null; this.closed = false; }
 connect() {
  if (this.closed) return Promise.reject(Error('Session client is closed')); 
  if (this.socket && !this.socket.destroyed) return Promise.resolve();
  if (this.connecting) return this.connecting;
  this.connecting = (async () => {
   const info = JSON.parse(await fs.readFile(path.join(this.dir, 'router-endpoint.json'), 'utf8')); this.key = info.key;
   if (this.closed) throw Error('Session client is closed');
   const socket = net.createConnection(info.endpoint); this.socket = socket;
   frames(socket, frame => {
    if (frame.type === 'delivery') {
     if (frame.session !== this.identity.id) return;
     Promise.resolve().then(() => this.onDelivery(frame)).then(accepted => this.request('ack', { ticket: frame.ticket, accepted: !!accepted })).catch(() => {});
    } else {
     const pending = this.pending.get(frame.id); if (!pending) return; this.pending.delete(frame.id);
     frame.ok ? pending.resolve(frame.result) : pending.reject(Error(redact(frame.error)));
    }
   });
   socket.on('error', () => {});
   socket.on('close', () => {
    if (this.socket !== socket) return;
    this.socket = null;
    for (const p of this.pending.values()) p.reject(Error('Router disconnected; delivery/send may be uncertain'));
    this.pending.clear();
   });
   await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', () => reject(Error('Router unavailable; start the forum router'))); });
  })().finally(() => { this.connecting = null; }); return this.connecting;
 }
 async request(action, params = {}) {
  await this.connect(); const id = String(++this.next);
  return new Promise((resolve, reject) => {
   this.pending.set(id, { resolve, reject });
   write(this.socket, { key: this.key, id, action, params: { ...this.identity, ...params } });
  });
 }
 async close() { this.closed = true; const socket = this.socket; if (!socket) return; await new Promise(resolve => { socket.once('close', resolve); socket.destroy(); }); }
}
async function stopRouter({ dir }) {
 let info;
 try { info = JSON.parse(await fs.readFile(path.join(dir, 'router-control.json'), 'utf8')); }
 catch { throw Error('Router operator control unavailable; start the upgraded router'); }
 if (info.version !== 1) throw Error('Invalid router control descriptor');
 if (typeof info.endpoint !== 'string' || !/^[a-f0-9]{64}$/.test(info.key) || !Number.isSafeInteger(info.pid) || info.pid <= 0) throw Error('Invalid router control descriptor');
 const socket = net.createConnection(info.endpoint);
 try {
  return await new Promise((resolve, reject) => {
   let result, unavailable = false;
   frames(socket, frame => {
    if (frame.id !== 'operator-stop') return;
    if (!frame.ok) { reject(Error(redact(frame.error))); return; }
    result = frame.result;
   });
   socket.once('error', e => {
    unavailable = true;
    if (!['ENOENT', 'ECONNREFUSED'].includes(e.code)) { reject(Error('Router unavailable; no process was killed')); return; }
    // Confirm an unavailable listener and an unchanged reference; never trust a stopped marker.
    fs.readFile(path.join(dir, 'router-control.json'), 'utf8').then(raw => {
     const current = JSON.parse(raw);
     if (current.key !== info.key || current.endpoint !== info.endpoint || current.pid !== info.pid) throw Error('Router reference changed');
     resolve({ accepted: false, alreadyStopped: true, completed: true, pid: info.pid });
    }).catch(() => reject(Error('Router reference changed or unreadable; request stop again')));
   });
   socket.once('close', () => { if (!unavailable) result?.completed ? resolve(result) : reject(Error('Router disconnected before shutdown completion')); });
   socket.once('connect', () => write(socket, { id: 'operator-stop', key: info.key, action: 'shutdown' }));
  });
 } finally { socket.destroy(); }
}
module.exports = { Router, BotApi, serve, stopRouter, Client, redact, clean, chunks, atomic, endpointFor, selectRuntime, disableLegacyAuto, legacyFence, inbound, validateDocument, readDocument, documentCaption, decodeDocument, DOCUMENT_UNCONFIRMED };
