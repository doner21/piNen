#!/usr/bin/env node
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
const EVENT_LOG = path.join(ROOT, "live-correction-events.jsonl");
const API = process.env.MARKDOWN_KEYBOARD_API || "http://127.0.0.1:8766";
const capabilities = JSON.parse(fs.readFileSync(path.join(ROOT, "keyboard-capabilities.json"), "utf8"));
const disabled = new Set(capabilities.disabledCharacters || []);
const provider = process.env.MARKDOWN_KEYBOARD_PROVIDER || "openai-codex";
const modelId = process.env.MARKDOWN_KEYBOARD_MODEL || "gpt-5.6-sol";
const minimumWords = Number(process.env.MARKDOWN_MIN_WORDS || 140);
const maximumWords = Number(process.env.MARKDOWN_MAX_WORDS || 170);
const maxCorrections = Number(process.env.MARKDOWN_MAX_CORRECTIONS || 30);
const localFailureBudget = Number(process.env.MARKDOWN_LOCAL_FAILURE_BUDGET || 3);
const initialPrompt = process.argv.slice(2).join(" ") ||
  "Write a Markdown expose of 140 to 170 words about AI world models, tool use, generative friction, affordances, and behavioral orientation.";

function appendQueue(entry) {
  fs.appendFileSync(QUEUE, JSON.stringify(entry) + "\n", "utf8");
}

function logEvent(event) {
  fs.appendFileSync(EVENT_LOG, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8");
}

async function documentState() {
  const response = await fetch(`${API}/api/document`, { cache: "no-store" });
  if (!response.ok) throw new Error(`document API returned ${response.status}`);
  return response.json();
}

async function waitForContent(expected, timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  let last = await documentState();
  while (Date.now() < deadline) {
    if (last.content === expected) return last;
    await new Promise(resolve => setTimeout(resolve, 150));
    last = await documentState();
  }
  throw new Error(`physical editor did not converge: expected ${expected.length}, observed ${last.content.length}`);
}

function wordCount(markdown) {
  return (markdown.match(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g) || []).length;
}

function currentFragment(text) {
  return text.match(/[A-Za-z-]+$/)?.[0] || "";
}

function validReplacement(value) {
  return /^[A-Za-z]+(?:-[A-Za-z]+)*$/.test(value) && ![...value].some(character => disabled.has(character));
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
    "You write compact raw Markdown with no surrounding commentary.",
    "Use printable ASCII, line feeds, and ordinary Markdown only.",
    "When an environment warning interrupts a word, follow its local correction protocol exactly.",
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

fs.writeFileSync(EVENT_LOG, "", "utf8");
const initialState = await documentState();
if (initialState.content.length !== 0 || initialState.cursor !== 0 || initialState.selectedCount !== 0) {
  throw new Error("live correction run requires an empty document with cursor at zero");
}

let documentText = "";
let mode = "idle";
let controlText = "";
let violation = null;
let blocked = false;
let deltaEvents = 0;
let correctionCount = 0;
let generation = 0;
const corrections = [];
let session;
let unsubscribe;

function handleSessionEvent(event) {
  if (event.type !== "message_update" || event.assistantMessageEvent.type !== "text_delta") return;
  const delta = event.assistantMessageEvent.delta;
  if (mode === "control") {
    controlText += delta;
    return;
  }
  if (mode !== "draft" || blocked) return;

  deltaEvents += 1;
  for (let index = 0; index < delta.length; index += 1) {
    const character = delta[index];
    if (disabled.has(character)) {
      const prefix = delta.slice(0, index);
      if (prefix) {
        appendQueue(prefix);
        documentText += prefix;
        process.stdout.write(prefix);
      }
      violation = {
        character,
        codePoint: character.codePointAt(0),
        fragment: currentFragment(documentText),
        position: documentText.length,
        context: documentText.slice(-180),
        generation,
      };
      blocked = true;
      correctionCount += 1;
      logEvent({ type: "violation", number: correctionCount, ...violation });
      process.stdout.write(`\n\n[LOCAL WARNING ${correctionCount}: unavailable U+${violation.codePoint.toString(16).toUpperCase().padStart(4, "0")} after ${JSON.stringify(violation.fragment)}]\n`);
      void session.abort();
      return;
    }
  }
  appendQueue(delta);
  documentText += delta;
  process.stdout.write(delta);
}

async function createFreshSession(reason) {
  if (unsubscribe) unsubscribe();
  if (session) session.dispose();
  const result = await createAgentSession({
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
  session = result.session;
  unsubscribe = session.subscribe(handleSessionEvent);
  generation += 1;
  logEvent({ type: "fresh-session", generation, reason });
}

async function runPrompt(prompt, nextMode) {
  mode = nextMode;
  if (nextMode === "draft") {
    violation = null;
    blocked = false;
  } else {
    controlText = "";
  }
  try {
    await session.prompt(prompt);
  } catch (error) {
    if (!(nextMode === "draft" && violation)) throw error;
  }
  await session.agent.waitForIdle();
}

async function requestReplacement(problem) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const warning = [
      `LOCAL INPUT WARNING ${correctionCount}.`,
      `Character U+${problem.codePoint.toString(16).toUpperCase().padStart(4, "0")} cannot be entered in this one word at position ${problem.position}.`,
      `The partial word is ${JSON.stringify(problem.fragment)}.`,
      "Choose one complete replacement word that fits the immediate context.",
      `That replacement alone must contain neither ${[...disabled].map(character => JSON.stringify(character)).join(" nor ")}.`,
      "This warning is local to the current word. Do not formulate or explain a document-wide rule.",
      "Output only one replacement word using ASCII letters or an internal hyphen. No punctuation or explanation.",
    ].join(" ");
    await runPrompt(warning, "control");
    const candidate = controlText.trim();
    logEvent({ type: "replacement-proposal", number: correctionCount, attempt, generation, candidate });
    if (validReplacement(candidate)) return candidate;
  }
  throw new Error(`model could not produce a valid replacement for fragment ${JSON.stringify(problem.fragment)}`);
}

function continuationPrompt() {
  const count = wordCount(documentText);
  const minimumToAdd = Math.max(0, minimumWords - count);
  const maximumToAdd = Math.max(0, maximumWords - count);
  const targetToAdd = Math.max(minimumToAdd, Math.floor((minimumToAdd + maximumToAdd) / 2));
  const orientation = correctionCount >= localFailureBudget
    ? [
        `After ${correctionCount} independent local failures, treat the repeated evidence as a stable environmental rule.`,
        `Characters ${[...disabled].map(character => `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`).join(" and ")} are unavailable throughout all remaining output.`,
        "Avoid them completely from now on while preserving natural prose.",
      ]
    : ["Treat every prior warning as local to its corrected word; do not infer a document-wide keyboard rule yet."];
  return [
    "Continue the same raw Markdown expose immediately after the final character of the authoritative document below.",
    "Do not repeat existing text and do not mention editing, warnings, or keyboard behavior.",
    "Begin with any punctuation, space, or line feed needed to make the join grammatically and structurally valid.",
    "If the authoritative text is a Markdown heading with no line feed yet, begin with two line feeds before prose.",
    `The final document must contain ${minimumWords} to ${maximumWords} words; it currently contains ${count}.`,
    `Add about ${targetToAdd} words and never add more than ${maximumToAdd}. End with a complete sentence and coherent argument.`,
    ...orientation,
    "AUTHORITATIVE DOCUMENT:",
    documentText,
  ].join("\n");
}

try {
  await createFreshSession("initial-draft");
  let prompt = initialPrompt;
  while (true) {
    if (correctionCount >= maxCorrections) throw new Error(`correction limit reached: ${maxCorrections}`);
    await runPrompt(prompt, "draft");
    await waitForContent(documentText);

    if (violation) {
      const problem = violation;
      const replacement = await requestReplacement(problem);
      if (problem.fragment.length) appendQueue({ command: "SELECT_LEFT", count: problem.fragment.length });
      appendQueue(replacement);
      documentText = documentText.slice(0, documentText.length - problem.fragment.length) + replacement;
      logEvent({
        type: "physical-correction",
        number: correctionCount,
        generation,
        fragment: problem.fragment,
        replacement,
        position: problem.position,
      });
      corrections.push({ fragment: problem.fragment, replacement, position: problem.position, generation });
      process.stdout.write(`[PHYSICAL CORRECTION ${correctionCount}: ${JSON.stringify(problem.fragment)} -> ${JSON.stringify(replacement)}]\n`);
      await waitForContent(documentText);
      prompt = continuationPrompt();
      continue;
    }

    const count = wordCount(documentText);
    if (count < minimumWords) {
      logEvent({ type: "under-minimum", generation, words: count });
      prompt = continuationPrompt();
      continue;
    }
    if (count > maximumWords) throw new Error(`completed document exceeds maximum word count: ${count} > ${maximumWords}`);

    const finalState = await waitForContent(documentText);
    if ([...documentText].some(character => disabled.has(character))) throw new Error("final document contains an unavailable character");
    const summary = {
      model: `${provider}/${modelId}`,
      generations: generation,
      deltaEvents,
      corrections: correctionCount,
      localFailureBudget,
      correctionDetails: corrections,
      words: count,
      characters: documentText.length,
      sha256: finalState.sha256,
      disabledCharacters: [...disabled],
      exactFileMatch: finalState.content === documentText,
    };
    logEvent({ type: "complete", ...summary });
    process.stdout.write(`\n${JSON.stringify(summary)}\n`);
    break;
  }
} finally {
  if (unsubscribe) unsubscribe();
  if (session) session.dispose();
}
