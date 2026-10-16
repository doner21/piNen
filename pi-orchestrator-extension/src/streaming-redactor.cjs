const { StringDecoder } = require("node:string_decoder");

const KEY = String.raw`(?:api[_-]?key|access[_-]?token|auth(?:orization)?[_-]?token|token|secret|password|passwd|credential|(?:[A-Z][A-Z0-9_]*_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|CREDENTIAL))`;
const PREFIX = new RegExp(String.raw`(?:(["'])${KEY}\1\s*:\s*(["']?)|\b(${KEY})\s*[:=]\s*(["']?)|--${KEY}(?:=|\s+)\s*(["']?)|\bAuthorization\s*:\s*(?:Basic|Bearer|Token)\s+(["']?)|\bBearer\s+(["']?))$`, "i");

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
  }
  push(value) {
    const text = Buffer.isBuffer(value) ? this.decoder.write(value) : String(value);
    if (this.mode === "normal") {
      const combined = this.pending + text;
      if (!/(?:bearer|authorization|token|secret|password|passwd|credential|api[_-]?key|:\/\/)/i.test(combined)) {
        const keep = Math.min(512, combined.length);
        this.pending = combined.slice(combined.length - keep);
        return combined.slice(0, combined.length - keep);
      }
    }
    let output = "";
    for (const character of text) output += this._character(character);
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
  _character(character) {
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

module.exports = { StreamingSecretRedactor, redactCompleteText };
