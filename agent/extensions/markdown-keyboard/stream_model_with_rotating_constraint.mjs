#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "file:///C:/Users/you/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const QUEUE = path.join(ROOT, "markdown-stream.queue");
const ACK = path.join(ROOT, "markdown-physical-acks.jsonl");
const EVENT_LOG = path.join(ROOT, "rotating-constraint-events.jsonl");
const OUTPUT = path.join(ROOT, "output");
const API = process.env.MARKDOWN_KEYBOARD_API || "http://127.0.0.1:8766";
const provider = process.env.MARKDOWN_KEYBOARD_PROVIDER || "openai-codex";
const modelId = process.env.MARKDOWN_KEYBOARD_MODEL || "gpt-5.6-sol";
const minimumWords = Number(process.env.MARKDOWN_MIN_WORDS || 140);
const maximumWords = Number(process.env.MARKDOWN_MAX_WORDS || 170);
const maxCorrections = Number(process.env.MARKDOWN_MAX_CORRECTIONS || 80);
const initialPrompt = process.argv.slice(2).join(" ") ||
  "Write a Markdown expose of 140 to 170 words about AI world models, tool use, generative friction, affordances, and behavioral orientation.";

let physicalId = 0;
let deltaEvents = 0;
let correctionCount = 0;
let documentText = "";
let pinnedRunId = "";
let activeQueue = null;
let mode = "idle";
const physicalAttempts = [];
const physicalEditAttempts = [];
const violations = [];

function appendQueue(entry) {
  fs.appendFileSync(QUEUE, JSON.stringify(entry) + "\n", "utf8");
}

function logEvent(event) {
  fs.appendFileSync(EVENT_LOG, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8");
}

async function apiRequest(route, options) {
  const response = await fetch(`${API}${route}`, { cache: "no-store", ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${route} returned ${response.status}: ${payload.error || "unknown error"}`);
  return payload;
}

async function documentState() {
  const state = await apiRequest("/api/document");
  if (pinnedRunId && state.constraint?.runId !== pinnedRunId) {
    throw new Error(`constraint run changed during generation: expected ${pinnedRunId}, observed ${state.constraint?.runId}`);
  }
  return state;
}

async function waitForContent(expected, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let state = await documentState();
  while (Date.now() < deadline) {
    if (state.content === expected) return state;
    await new Promise(resolve => setTimeout(resolve, 30));
    state = await documentState();
  }
  throw new Error(`physical document did not converge: expected ${expected.length}, observed ${state.content.length}`);
}

let ackOffset = 0;
let ackRemainder = "";
const acknowledgements = new Map();

function ingestAcks() {
  if (!fs.existsSync(ACK)) return;
  const size = fs.statSync(ACK).size;
  if (size < ackOffset) {
    ackOffset = 0;
    ackRemainder = "";
    acknowledgements.clear();
  }
  if (size === ackOffset) return;
  const length = size - ackOffset;
  const buffer = Buffer.allocUnsafe(length);
  const descriptor = fs.openSync(ACK, "r");
  try {
    fs.readSync(descriptor, buffer, 0, length, ackOffset);
  } finally {
    fs.closeSync(descriptor);
  }
  ackOffset = size;
  const parts = (ackRemainder + buffer.toString("utf8")).split(/\r?\n/);
  ackRemainder = parts.pop() || "";
  for (const line of parts) {
    if (!line) continue;
    const value = JSON.parse(line);
    acknowledgements.set(value.id, value);
  }
}

async function waitForAck(id, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    ingestAcks();
    const ack = acknowledgements.get(id);
    if (ack) {
      acknowledgements.delete(id);
      return ack;
    }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error(`physical keyboard did not acknowledge ${id}`);
}

async function physicalText(character) {
  const id = `key-${++physicalId}`;
  appendQueue({ id, text: character });
  const ack = await waitForAck(id);
  if (pinnedRunId && ack.constraint?.runId !== pinnedRunId) {
    throw new Error(`physical acknowledgement crossed constraint runs: expected ${pinnedRunId}, observed ${ack.constraint?.runId}`);
  }
  physicalAttempts.push({
    id,
    character,
    accepted: ack.accepted,
    attempt: ack.attempt,
    constraint: ack.constraint,
  });
  logEvent({
    type: "physical-key-attempt",
    id,
    character,
    accepted: ack.accepted,
    blockedLetter: ack.constraint?.blockedLetter,
    rotationIndex: ack.constraint?.rotationIndex,
    runId: ack.constraint?.runId,
  });
  return ack;
}

async function physicalCommand(command, count = 1) {
  const id = `edit-${++physicalId}`;
  appendQueue({ id, command, count });
  const ack = await waitForAck(id);
  if (!ack.accepted) throw new Error(`physical edit command was rejected: ${command}`);
  physicalEditAttempts.push({ id, command, count, attempt: ack.attempt, constraint: ack.constraint });
  logEvent({ type: "physical-edit-attempt", id, command, count, attempt: ack.attempt });
  return ack;
}

class AsyncCharacterQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }
  push(value) {
    if (this.closed) return;
    if (this.waiters.length) this.waiters.shift()({ value, done: false });
    else this.items.push(value);
  }
  close() {
    this.closed = true;
    while (this.waiters.length && !this.items.length) this.waiters.shift()({ done: true });
  }
  discard() {
    this.items = [];
    this.close();
  }
  next() {
    if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
    if (this.closed) return Promise.resolve({ done: true });
    return new Promise(resolve => this.waiters.push(resolve));
  }
}

function isPhysicalCharacter(character) {
  const code = character.codePointAt(0);
  return character === "\n" || character === "\t" || (code >= 32 && code <= 126);
}

function currentFragment(text) {
  return text.match(/[A-Za-z][A-Za-z'-]*$/)?.[0] || "";
}

function wordCount(markdown) {
  return (markdown.match(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g) || []).length;
}

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const model = modelRegistry.find(provider, modelId);
if (!model) throw new Error(`model not found: ${provider}/${modelId}`);

const resourceLoader = new DefaultResourceLoader({
  cwd: ROOT,
  agentDir: "C:/Users/you/.pi/agent",
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  systemPromptOverride: () => [
    "You write coherent compact raw Markdown with no surrounding commentary.",
    "Use printable ASCII, line feeds, and ordinary Markdown only.",
    "Text is admitted through a physical keyboard whose affordances may change while you write.",
    "When a physical-input warning arrives, trust the supplied authoritative document and continue it without discussing the warning.",
  ].join(" "),
  skillsOverride: () => ({ skills: [], diagnostics: [] }),
  agentsFilesOverride: () => ({ agentsFiles: [] }),
  promptsOverride: () => ({ prompts: [], diagnostics: [] }),
  extensionFactories: [],
});
await resourceLoader.reload();

const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 2 },
});
const { session } = await createAgentSession({
  cwd: ROOT,
  agentDir: "C:/Users/you/.pi/agent",
  model,
  thinkingLevel: "off",
  noTools: "all",
  authStorage,
  modelRegistry,
  resourceLoader,
  sessionManager: SessionManager.inMemory(),
  settingsManager,
});

const unsubscribe = session.subscribe(event => {
  if (mode !== "draft" || !activeQueue) return;
  if (event.type !== "message_update" || event.assistantMessageEvent.type !== "text_delta") return;
  deltaEvents += 1;
  for (const character of event.assistantMessageEvent.delta) activeQueue.push(character);
});

async function runDraft(prompt) {
  const queue = new AsyncCharacterQueue();
  activeQueue = queue;
  mode = "draft";
  let promptError = null;
  const promptPromise = session.prompt(prompt)
    .catch(error => { promptError = error; })
    .finally(() => queue.close());
  let violation = null;

  while (true) {
    const next = await queue.next();
    if (next.done) break;
    const character = next.value;
    if (!isPhysicalCharacter(character)) {
      queue.discard();
      await session.abort();
      throw new Error(`model emitted unsupported character U+${character.codePointAt(0).toString(16).toUpperCase()}`);
    }
    const ack = await physicalText(character);
    if (!ack.accepted) {
      const attempt = ack.attempt || {};
      violation = {
        character,
        fragment: currentFragment(documentText),
        position: documentText.length,
        blockedLetter: attempt.blockedLetter || ack.constraint?.blockedLetter,
        rotationIndex: attempt.rotationIndex ?? ack.constraint?.rotationIndex,
        runId: attempt.runId || ack.constraint?.runId,
      };
      correctionCount += 1;
      violations.push({ number: correctionCount, ...violation });
      logEvent({ type: "violation", number: correctionCount, ...violation });
      process.stdout.write(`\n[PHYSICAL KEY FAILURE ${correctionCount}: ${character.toUpperCase()} missing at rotation ${Number(violation.rotationIndex) + 1}]\n`);
      queue.discard();
      await session.abort();
      break;
    }
    documentText += character;
    process.stdout.write(character);
  }

  await promptPromise;
  await session.agent.waitForIdle();
  mode = "idle";
  activeQueue = null;
  if (promptError && !violation) throw promptError;
  return violation;
}

async function removeInterruptedFragment(fragment) {
  if (!fragment) return;
  let remaining = fragment.length;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 1000);
    await physicalCommand("SELECT_LEFT", chunk);
    await physicalCommand("BACKSPACE");
    documentText = documentText.slice(0, -chunk);
    remaining -= chunk;
    await waitForContent(documentText);
  }
  logEvent({ type: "physical-fragment-removal", fragment, characters: fragment.length });
  process.stdout.write(`[PHYSICAL REPAIR: removed interrupted fragment ${JSON.stringify(fragment)}]\n`);
}

function continuationPrompt(problem = null) {
  const count = wordCount(documentText);
  const maximumToAdd = Math.max(0, maximumWords - count);
  const targetToAdd = Math.min(maximumToAdd, Math.max(20, minimumWords - count));
  const warning = problem ? [
    "PHYSICAL INPUT WARNING.",
    `The visible keyboard rejected letter ${JSON.stringify(problem.character)} because that key was missing at the moment of the click.`,
    `The interrupted fragment ${JSON.stringify(problem.fragment)} was then selected and removed through physical edit keys.`,
    "Any unadmitted suffix from your prior turn was discarded.",
    "This reports only the failed physical moment; do not assume that any earlier unavailable key remains unavailable.",
  ] : ["The prior turn ended before the requested document length was reached."];
  return [
    ...warning,
    "Continue the same raw Markdown document immediately after the final character of the authoritative text below.",
    "Do not repeat existing text. Do not mention the keyboard, warnings, constraints, or editing process.",
    "Begin with any punctuation, spacing, or line feeds needed for a grammatical and structurally valid join.",
    `The complete document must contain ${minimumWords} to ${maximumWords} words; it currently contains ${count}.`,
    `Add about ${targetToAdd} words, never exceed ${maximumToAdd} additional words, and end with a complete sentence when the target is met.`,
    "AUTHORITATIVE DOCUMENT:",
    documentText,
  ].join("\n");
}

function countLetters(text) {
  const counts = Object.fromEntries("abcdefghijklmnopqrstuvwxyz".split("").map(letter => [letter, 0]));
  for (const character of text.toLowerCase()) if (Object.hasOwn(counts, character)) counts[character] += 1;
  return counts;
}

function metricCounts(items, field) {
  const counts = Object.fromEntries("abcdefghijklmnopqrstuvwxyz".split("").map(letter => [letter, 0]));
  for (const item of items) {
    const letter = String(item[field] || "").toLowerCase();
    if (Object.hasOwn(counts, letter)) counts[letter] += 1;
  }
  return counts;
}

function atomicWrite(target, content, { exclusive = false } = {}) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
  try {
    if (exclusive) {
      fs.linkSync(temporary, target);
      fs.unlinkSync(temporary);
    } else {
      fs.renameSync(temporary, target);
    }
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function statisticsSvg(summary) {
  const letters = "abcdefghijklmnopqrstuvwxyz".split("");
  const width = 1120;
  const panelHeight = 150;
  const panels = [
    ["Random five-second blocks", summary.blockedRotations, "#efb04b"],
    ["Rejected physical clicks", summary.rejectedClicks, "#f07178"],
    ["Admitted document letters", summary.admittedLetters, "#8bd49c"],
  ];
  let body = `<rect width="100%" height="100%" fill="#0d1110"/><text x="36" y="36" fill="#f4efe2" font-family="Consolas" font-size="22">Markdown Type Foundry - rotating affordance profile</text><text x="36" y="58" fill="#9fa89b" font-family="Consolas" font-size="12">run ${summary.runId} | 5.0 second rotation | ${summary.corrections} rejected clicks | ${summary.words} words</text>`;
  panels.forEach(([title, values, color], panelIndex) => {
    const y = 90 + panelIndex * panelHeight;
    const max = Math.max(1, ...Object.values(values));
    body += `<text x="36" y="${y}" fill="#dce8df" font-family="Consolas" font-size="14">${title} (max ${max})</text>`;
    letters.forEach((letter, index) => {
      const x = 38 + index * 40;
      const height = Math.round((values[letter] / max) * 92);
      body += `<rect x="${x}" y="${y + 108 - height}" width="24" height="${height}" fill="${color}" opacity="0.88"/><text x="${x + 12}" y="${y + 126}" text-anchor="middle" fill="#9fa89b" font-family="Consolas" font-size="10">${letter.toUpperCase()}</text>`;
    });
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="560" viewBox="0 0 ${width} 560">${body}</svg>\n`;
}

fs.mkdirSync(OUTPUT, { recursive: true });
fs.writeFileSync(EVENT_LOG, "", "utf8");
const initialState = await documentState();
const initialAttemptSequence = initialState.attemptSequence;
if (initialState.content.length !== 0 || initialState.cursor !== 0 || initialState.selectedCount !== 0) {
  throw new Error("rotating-constraint run requires an empty document with cursor at zero");
}
documentText = "";
pinnedRunId = initialState.constraint.runId;
logEvent({ type: "run-start", model: `${provider}/${modelId}`, prompt: initialPrompt, constraint: initialState.constraint });

try {
  let prompt = initialPrompt;
  while (true) {
    if (correctionCount >= maxCorrections) throw new Error(`correction limit reached: ${maxCorrections}`);
    const violation = await runDraft(prompt);
    await waitForContent(documentText);
    if (violation) {
      await removeInterruptedFragment(violation.fragment);
      prompt = continuationPrompt(violation);
      continue;
    }
    const count = wordCount(documentText);
    if (count < minimumWords) {
      logEvent({ type: "under-minimum", words: count });
      prompt = continuationPrompt();
      continue;
    }
    if (count > maximumWords) throw new Error(`completed document exceeds maximum word count: ${count} > ${maximumWords}`);

    const finalState = await waitForContent(documentText);
    const history = await apiRequest("/api/constraint/history");
    const runId = pinnedRunId;
    if (history.runId !== runId) throw new Error(`constraint history crossed runs: expected ${runId}, observed ${history.runId}`);
    const rotations = history.rotations.filter(item => item.runId === runId);
    const rejected = physicalAttempts.filter(item => !item.accepted);
    const acknowledgedOperationAttempts = physicalAttempts.length
      + physicalEditAttempts.reduce((total, item) => total + item.count, 0);
    const authoritativeAttemptDelta = finalState.attemptSequence - initialAttemptSequence;
    if (authoritativeAttemptDelta !== acknowledgedOperationAttempts) {
      throw new Error(
        `authoritative attempt mismatch: server observed ${authoritativeAttemptDelta}, bridge acknowledged ${acknowledgedOperationAttempts}`,
      );
    }
    let summary = {
      runId,
      model: `${provider}/${modelId}`,
      prompt: initialPrompt,
      intervalMs: finalState.constraint.intervalMs,
      rotations: rotations.length,
      deltaEvents,
      physicalKeyAttempts: physicalAttempts.length,
      physicalEditCommands: physicalEditAttempts.length,
      acknowledgedOperationAttempts,
      authoritativeAttemptDelta,
      admittedKeyAttempts: physicalAttempts.length - rejected.length,
      corrections: correctionCount,
      violations,
      words: count,
      characters: documentText.length,
      sha256: finalState.sha256,
      documentArchiveSha256: finalState.sha256,
      exactFileMatch: finalState.content === documentText,
      blockedRotations: metricCounts(rotations, "blockedLetter"),
      rejectedClicks: metricCounts(rejected.map(item => ({ letter: item.character })), "letter"),
      admittedLetters: countLetters(documentText),
      generatedAt: new Date().toISOString(),
    };
    const runDir = path.join(OUTPUT, "rotating-runs");
    const svg = statisticsSvg(summary);
    summary = {
      ...summary,
      statisticsSvgSha256: crypto.createHash("sha256").update(svg, "utf8").digest("hex"),
    };
    const json = JSON.stringify(summary, null, 2) + "\n";
    atomicWrite(path.join(runDir, `${runId}.md`), documentText, { exclusive: true });
    atomicWrite(path.join(runDir, `${runId}.svg`), svg, { exclusive: true });
    atomicWrite(path.join(runDir, `${runId}.json`), json, { exclusive: true });
    atomicWrite(path.join(OUTPUT, "rotating-letter-statistics.svg"), svg);
    atomicWrite(path.join(OUTPUT, "rotating-letter-statistics.json"), json);
    logEvent({ type: "complete", ...summary });
    process.stdout.write(`\n${JSON.stringify(summary)}\n`);
    break;
  }
} finally {
  mode = "idle";
  if (activeQueue) activeQueue.discard();
  unsubscribe();
  session.dispose();
}
