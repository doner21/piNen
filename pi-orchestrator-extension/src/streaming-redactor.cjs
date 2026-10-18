const { StringDecoder } = require("node:string_decoder");

const KEY = String.raw`(?:(?:x[_-])?api[_-]?key|x[_-]goog[_-]api[_-]key|client[_-]?(?:secret|assertion)|private[_-]?key|code[_-]?verifier|(?:session|security)[_-]?token|(?:proxy[_-])?authorization|(?:set[_-])?cookie|access(?:[_-]?token)?|refresh(?:[_-]?token)?|id[_-]?token|account[_-]?id|(?:reasoning|thinking|thought|text)[_-]?signature|signature|encrypted[_-]?(?:content|reasoning)|approval[_-]?token|auth(?:orization)?[_-]?token|token|secret|password|passwd|credentials?|(?:[A-Z][A-Z0-9_]*_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|SECRET_ACCESS_KEY|CREDENTIAL))`;
const PREFIX = new RegExp(String.raw`(?:(["'])${KEY}\1\s*:\s*(["']?)|\b(${KEY})\s*[:=]\s*(["']?)|--${KEY}(?:=|\s+)\s*(["']?)|\bAuthorization\s*:\s*(?:Basic|Bearer|Token)\s+(["']?)|\bBearer\s+(["']?))$`, "i");

const QUOTED_KEY = new RegExp(String.raw`(["'])${KEY}\1$`, "i");

class StreamingSecretRedactor {
  constructor() {
    this.decoder = new StringDecoder("utf8");
    this.pending = "";
    this.mode = "normal";
    this.quote = undefined;
    this.containerQuote = undefined;
    this.skipLeadingSpace = false;
    this.awaitingValueStart = false;
    this.lineValue = false;
    this.urlBuffer = "";
    this.urlHasColon = false;
    this.unicodeEscape = "";
  }
  push(value) {
    const text = Buffer.isBuffer(value) ? this.decoder.write(value) : String(value);
    if (this.mode === "normal" && !this.unicodeEscape && !text.includes("\\")) {
      const combined = this.pending + text;
      if (!/(?:bearer|authorization|access|refresh|signature|account|encrypted|token|secret|password|passwd|credential|key|cookie|assertion|verifier|:\/\/)/i.test(combined)) {
        const keep = Math.min(512, combined.length);
        this.pending = combined.slice(combined.length - keep);
        return combined.slice(0, combined.length - keep);
      }
    }
    let output = "";
    for (const character of text) output += this._decodedCharacter(character);
    return output;
  }
  finish() {
    let output = this.decoder.end();
    if (output) {
      let decoded = "";
      for (const character of output) decoded += this._character(character);
      output = decoded;
    }
    if (this.mode === "normal") output += this.pending;
    else if (this.mode === "url" && !this.urlHasColon) output += this.urlBuffer;
    this.pending = "";
    this.urlBuffer = "";
    return output;
  }
  _decodedCharacter(character) {
    // Decode JSON key unicode escapes BEFORE lexical matching. Carry incomplete
    // escapes across deltas; no prefix of a possible credential is published.
    if (this.mode !== "normal" && this.mode !== "key") return this._character(character);
    if (!this.unicodeEscape) {
      if (character === "\\") { this.unicodeEscape = character; return ""; }
      return this._character(character);
    }
    this.unicodeEscape += character;
    if (/^\\u[0-9a-f]{0,3}$/i.test(this.unicodeEscape)) return "";
    const buffered = this.unicodeEscape;
    this.unicodeEscape = "";
    if (/^\\u[0-9a-f]{4}$/i.test(buffered)) return this._character(String.fromCharCode(parseInt(buffered.slice(2), 16)));
    let output = "";
    for (const c of buffered) output += this._character(c);
    return output;
  }
  _character(character) {
    if (this.mode === "key") {
      if (/\s/.test(character)) return character;
      if (character === ":") {
        this.mode = "redact"; this.awaitingValueStart = true;
        this.skipLeadingSpace = true; this.lineValue = false; this.quote = undefined;
        return character + "[REDACTED]";
      }
      this.mode = "normal";
    }
    if (this.mode === "redactAfterQuote") {
      if (character === "'" || character === '"') { this.mode = "redact"; this.quote = character; return ""; }
      if (character === "\\") { this.mode = "redactEscape"; return ""; }
      if (/\s/.test(character) || ";,|&()<>}]".includes(character)) { this.mode = "normal"; return character; }
      this.mode = "redact";
      return "";
    }
    if (this.mode === "redact") {
      if (this.awaitingValueStart) {
        if (/[ \t]/.test(character)) { this.lineValue = true; return ""; }
        this.awaitingValueStart = false;
        if (character === "'" || character === '"') { this.quote = character; return ""; }
      }
      if (this.skipLeadingSpace && /[ \t]/.test(character)) return "";
      this.skipLeadingSpace = false;
      if (this.quote) {
        if (character === this.quote) {
          this.quote = undefined;
          if (this.containerQuote === character) { this.containerQuote = undefined; return character; }
          this.mode = "redactAfterQuote";
          return "";
        }
        if (character === "\\") { this.mode = "redactEscape"; return ""; }
        return "";
      }
      if (character === "'" || character === '"') { this.quote = character; return ""; }
      if (character === "\\") { this.mode = "redactEscape"; return ""; }
      if (this.lineValue) {
        if (character === "\n" || character === "\r" || character === ";") { this.mode = "normal"; this.lineValue = false; return character; }
        return "";
      }
      if (/\s/.test(character) || ";,|&()<>".includes(character)) { this.mode = "normal"; return character; }
      return "";
    }
    if (this.mode === "redactEscape") { this.mode = "redact"; return ""; }
    if (this.mode === "url") {
      if (character === "@" && this.urlHasColon) {
        this.mode = "normal"; this.urlBuffer = ""; this.urlHasColon = false;
        return "[REDACTED]@";
      }
      if (/\s/.test(character) || character === "/" || character === "?" || character === "#" || character === '"' || character === "'") {
        const buffered = this.urlHasColon ? "[REDACTED]" : this.urlBuffer;
        this.mode = "normal"; this.urlBuffer = ""; this.urlHasColon = false;
        return buffered + character;
      }
      if (character === ":") this.urlHasColon = true;
      if (this.urlBuffer.length < 1024) this.urlBuffer += character;
      else if (!this.urlHasColon) this.urlHasColon = true; // fail safe for an unbounded authority
      return "";
    }

    this.pending += character;
    if (this.pending.endsWith("://")) {
      const prefix = this.pending;
      this.pending = "";
      this.mode = "url";
      return prefix;
    }
    const match = PREFIX.exec(this.pending);
    if (match) {
      const matched = match[0];
      const before = this.pending.slice(0, match.index);
      this.pending = "";
      this.mode = "redact";
      const trailing = matched.at(-1);
      const containerQuote = before.endsWith("'") ? "'" : before.endsWith('"') ? '"' : undefined;
      this.containerQuote = containerQuote;
      this.quote = trailing === "'" || trailing === '"' ? trailing : containerQuote;
      this.awaitingValueStart = !this.quote;
      this.skipLeadingSpace = !this.quote;
      this.lineValue = false;
      return before + matched + "[REDACTED]";
    }
    if (QUOTED_KEY.test(this.pending)) {
      const prefix = this.pending; this.pending = ""; this.mode = "key";
      return prefix;
    }
    if (this.pending.length > 1024) {
      const emit = this.pending.slice(0, this.pending.length - 512);
      this.pending = this.pending.slice(-512);
      return emit;
    }
    return "";
  }
}

function redactCompleteText(value) {
  const redactor = new StreamingSecretRedactor();
  const text = String(value);
  let output = "";
  for (let offset = 0; offset < text.length; offset += 16 * 1024) {
    output += redactor.push(text.slice(offset, offset + 16 * 1024));
  }
  return output + redactor.finish();
}

const SENSITIVE_KEY = new RegExp(`^${KEY}$`, 'i');

// Objects remain objects: never run a text regex over serialized lifecycle JSON.
function sanitizeWorkerValue(value, seen = new WeakSet(), secrets) {
  if (!secrets) {
    secrets = new Set();
    const visited = new WeakSet();
    const collect = node => {
      if (!node || typeof node !== 'object' || visited.has(node)) return;
      visited.add(node);
      for (const [key, item] of Object.entries(node)) {
        if (SENSITIVE_KEY.test(key) && typeof item === 'string' && item) secrets.add(item);
        collect(item);
      }
    };
    collect(value);
  }
  if (typeof value === 'string') {
    for (const secret of [...secrets].sort((a,b) => b.length-a.length)) value = value.split(secret).join('[REDACTED]');
    return sanitizeWorkerText(value);
  }
  if (!value || typeof value !== 'object') return value;
  if (['thinking', 'reasoning', 'redacted_thinking'].includes(value.type)) return { type: value.type, content: '[WITHHELD]' };
  if (seen.has(value)) return '[WITHHELD_CYCLE]';
  seen.add(value);
  const out = Array.isArray(value) ? value.map(v => sanitizeWorkerValue(v, seen, secrets))
    : Object.fromEntries(Object.entries(value).map(([key, v]) => [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeWorkerValue(v, seen, secrets)]));
  seen.delete(value);
  return out;
}
function sanitizeWorkerText(text) {
  text = String(text);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return JSON.stringify(sanitizeWorkerValue(parsed));
  } catch {}
  // A malformed provider body can echo a labelled value elsewhere in its
  // error prose. Learn those labels BEFORE stripping them, then scrub echoes.
  const labelled = new RegExp(String.raw`["']?${KEY}["']?\s*[:=]\s*["']?([^"'\s,;}\]]+)`, 'gi');
  const secrets = [...text.matchAll(labelled)].map(match => match[1]).filter(Boolean);
  const assignment = new RegExp(String.raw`\b${KEY}\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')`, 'gi');
  for (const match of text.matchAll(assignment)) {
    secrets.push(match[1].slice(1,-1));
    try { if (match[1][0] === '"') secrets.push(JSON.parse(match[1])); } catch {}
  }
  // Malformed JSON still has JSON-escaped keys. Decode only key/value tokens
  // for association, not the surrounding useful prose or its framing.
  const quoted = /("(?:\\.|[^"\\])*")\s*:\s*("(?:\\.|[^"\\])*")/g;
  for (const match of text.matchAll(quoted)) {
    try { if (SENSITIVE_KEY.test(JSON.parse(match[1]))) secrets.push(JSON.parse(match[2])); } catch {}
  }
  const authorization = /(?:\bAuthorization\s*:\s*(?:Basic|Bearer|Token)|\bBearer)\s+["']?([^"'\s,;}\]]+)/gi;
  secrets.push(...[...text.matchAll(authorization)].map(match => match[1]));
  // Replace complete values first, and never relearn a marker as a partial
  // credential on a later persistence boundary.
  for (const secret of [...new Set(secrets)].filter(value => value && value !== '[REDACTED' && value !== '[REDACTED]').sort((a,b) => b.length-a.length)) text = text.split(secret).join('[REDACTED]');
  // Keep fenced JSON parseable. Only prose takes the lexical fallback; running
  // it over a serialized object would remove value quotes and useful fields.
  const fence = /(```(?:json)?[^\S\r\n]*\r?\n)([\s\S]*?)(\r?\n```)/gi;
  let output = '', offset = 0;
  for (const match of text.matchAll(fence)) {
    output += redactCompleteText(text.slice(offset, match.index));
    let body;
    try { body = JSON.stringify(sanitizeWorkerValue(JSON.parse(match[2]))); }
    catch { body = redactCompleteText(match[2]); }
    output += match[1] + body + match[3]; offset = match.index + match[0].length;
  }
  return output + redactCompleteText(text.slice(offset));
}
/** No finite look-behind can retract an unlabelled echo preceding its label.
 * Raw streaming diagnostics are not durable evidence. Keep only a safe marker;
 * authoritative complete results use sanitizeWorkerValue/Text instead. */
class WithheldOutputStream {
  constructor() { this.seen = false; }
  push(value) { this.seen ||= value.length > 0; return ""; }
  finish() { const marker = this.seen ? "[raw streaming output withheld]\\n" : ""; this.seen = false; return marker; }
}
/** Partial snapshots/reasoning/tool arguments/text are withheld. message_end
 * remains the authoritative complete, sanitized result with binding intact. */
class WorkerProtocolSanitizer {
  constructor() { this.streams = new Map(); }
  sanitize(event) {
    if (event?.type === 'message_start') this.streams.clear();
    if (event?.type !== 'message_update') return sanitizeWorkerValue(event);
    const inner = event.assistantMessageEvent;
    const type = typeof inner?.type === 'string' ? inner.type : 'unknown';
    const index = Number.isSafeInteger(inner?.contentIndex) ? inner.contentIndex : 0;
    let delta = '[partial worker payload withheld]';
    // Even apparently ordinary text may be an echo of a later labelled value.
    // Persist a fixed observation, never a fragment of this raw payload.
    return { type: 'message_update', assistantMessageEvent: { type: ['text_delta','text_start','text_end','thinking_delta','thinking_start','thinking_end','toolcall_delta','toolcall_start','toolcall_end','start','done','error'].includes(type) ? type : 'unknown', contentIndex: index, delta } };
  }
}
module.exports = { WithheldOutputStream, StreamingSecretRedactor, WorkerProtocolSanitizer, redactCompleteText, sanitizeWorkerValue, sanitizeWorkerText };
