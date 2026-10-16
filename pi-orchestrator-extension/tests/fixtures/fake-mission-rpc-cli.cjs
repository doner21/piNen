#!/usr/bin/env node
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

const provider = arg("--provider", "fake");
const model = arg("--model", "fake-model");
const thinkingLevel = arg("--thinking", "off");
if (process.env.FAKE_RPC_ARGV_FILE) fs.writeFileSync(process.env.FAKE_RPC_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_RPC_ENV_FILE) fs.writeFileSync(process.env.FAKE_RPC_ENV_FILE, JSON.stringify(process.env));
const rejected = process.env.FAKE_RPC_REJECT_PROVIDER;
if (rejected && provider === rejected) process.exit(23);

const sessionDir = path.resolve(arg("--session-dir", process.cwd()));
fs.mkdirSync(sessionDir, { recursive: true });
const requestedSession = arg("--session", "");
let sessionFile;
let header;
if (requestedSession) {
  sessionFile = path.resolve(requestedSession);
  const existing = fs.readFileSync(sessionFile, "utf8");
  if (existing.length === 0) {
    header = { type: "session", version: 3, id: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd: process.cwd() };
    fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
  } else {
    header = JSON.parse(existing.split("\n", 1)[0]);
  }
} else {
  const sessionId = crypto.randomUUID();
  sessionFile = path.join(sessionDir, `fake-${Date.now()}-${process.pid}.jsonl`);
  header = { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() };
  fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
}

let tokens = readTokenTotal();
let streaming = false;
let activePromptTimer;
let entrySequence = readEntries().length;
let grandchild;
if (process.env.FAKE_RPC_GRANDCHILD_PID_FILE) {
  grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  fs.writeFileSync(process.env.FAKE_RPC_GRANDCHILD_PID_FILE, JSON.stringify({ root: process.pid, grandchild: grandchild.pid }));
}
if (process.env.FAKE_RPC_MALFORMED_IDLE_MS) {
  setTimeout(() => process.stdout.write("{malformed idle rpc frame\n"), Number(process.env.FAKE_RPC_MALFORMED_IDLE_MS));
}

function readEntries() {
  return fs.readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).slice(1).map(JSON.parse);
}

function readTokenTotal() {
  return readEntries().reduce((sum, entry) => {
    const usage = entry && entry.message && entry.message.usage;
    return sum + (usage && Number.isFinite(usage.totalTokens) ? usage.totalTokens : 0);
  }, 0);
}

function appendMessage(message) {
  const entries = readEntries();
  const id = crypto.createHash("sha256").update(`${process.pid}:${Date.now()}:${++entrySequence}`).digest("hex").slice(0, 8);
  const entry = { type: "message", id, parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), message };
  fs.appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
  return entry;
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function response(command, success, data, error) {
  send({ id: command.id, type: "response", command: command.type, success, ...(success ? { data } : { error }) });
}

function settlePrompt(command, aborted = false) {
  if (!streaming) return;
  streaming = false;
  activePromptTimer = undefined;
  const stopReason = aborted ? "aborted" : process.env.FAKE_RPC_ASSISTANT_ERROR ? "error" : "stop";
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: aborted ? "ABORTED" : "FAKE_RPC_OK" }],
    api: "fake",
    provider,
    model,
    usage: { input: 80, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    ...(stopReason === "error" ? { errorMessage: "fake provider failure" } : {}),
    timestamp: Date.now(),
  };
  tokens += 120;
  appendMessage(assistant);
  send({ type: "message_end", message: assistant });
  send({ type: "agent_end", messages: [assistant], willRetry: false });
  send({ type: "agent_settled" });
}

function handle(command) {
  if (!command || typeof command !== "object" || typeof command.type !== "string" || typeof command.id !== "string") {
    send({ type: "response", command: "parse", success: false, error: "invalid command" });
    return;
  }
  if (command.type === "get_state") {
    const reportedSessionFile = process.env.FAKE_RPC_REPORT_MISSING_SESSION
      ? path.join(sessionDir, "reported-but-missing.jsonl")
      : sessionFile;
    response(command, true, {
      model: { provider, id: model }, thinkingLevel, isStreaming: streaming, isCompacting: false,
      sessionFile: reportedSessionFile, sessionId: header.id, messageCount: readEntries().length, pendingMessageCount: 0,
    });
  } else if (command.type === "get_entries") {
    const entries = readEntries();
    let selected = entries;
    if (command.since) {
      const index = entries.findIndex((entry) => entry.id === command.since);
      if (index < 0) return response(command, false, undefined, "unknown cursor");
      selected = entries.slice(index + 1);
    }
    response(command, true, { entries: selected, leafId: entries.at(-1)?.id ?? null });
  } else if (command.type === "get_session_stats") {
    response(command, true, {
      sessionFile, sessionId: header.id, totalMessages: readEntries().length,
      tokens: { input: 0, output: tokens, cacheRead: 0, cacheWrite: 0, total: tokens }, cost: 0,
    });
  } else if (command.type === "prompt") {
    if (streaming) return response(command, false, undefined, "already streaming");
    streaming = true;
    appendMessage({ role: "user", content: command.message, timestamp: Date.now() });
    response(command, true, undefined);
    if (process.env.FAKE_RPC_MALFORMED_ON_PROMPT) {
      process.stdout.write("{malformed rpc frame\n");
      return;
    }
    if (process.env.FAKE_RPC_TORN_FRAME_ON_PROMPT) {
      process.stdout.write(JSON.stringify({ type: "agent_start" }), () => process.exit(31));
      return;
    }
    send({ type: "agent_start" });
    const toolName = process.env.FAKE_RPC_TOOL_NAME || "read";
    send({ type: "tool_execution_start", toolCallId: "fake-tool-1", toolName, args: { path: "fixture" } });
    send({ type: "tool_execution_end", toolCallId: "fake-tool-1", toolName, result: { content: [] }, isError: false });
    if (!process.env.FAKE_RPC_HANG_PROMPT) {
      activePromptTimer = setTimeout(() => settlePrompt(command), Number(process.env.FAKE_RPC_SETTLE_MS || 40));
    }
  } else if (command.type === "abort") {
    response(command, true, undefined);
    if (activePromptTimer) clearTimeout(activePromptTimer);
    if (streaming) settlePrompt(command, true);
  } else {
    response(command, false, undefined, `unsupported command ${command.type}`);
  }
}

const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    let line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    try { handle(JSON.parse(line)); }
    catch (error) { send({ type: "response", command: "parse", success: false, error: String(error.message || error) }); }
  }
});
process.stdin.on("end", () => {
  buffer += decoder.end();
  if (process.env.FAKE_RPC_IGNORE_EOF) return;
  if (grandchild) { try { grandchild.kill(); } catch {} }
  process.exit(0);
});

setInterval(() => {}, 1000).unref();
