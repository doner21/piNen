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
const capabilities = JSON.parse(fs.readFileSync(path.join(ROOT, "keyboard-capabilities.json"), "utf8"));
const disabledCharacters = new Set(capabilities.disabledCharacters || []);
const QUEUE = process.env.MARKDOWN_KEYBOARD_QUEUE || path.join(ROOT, "markdown-stream.queue");
const STREAM_LOG = process.env.MARKDOWN_KEYBOARD_STREAM_LOG || path.join(ROOT, "model-stream.log");
const provider = process.env.MARKDOWN_KEYBOARD_PROVIDER || "openai-codex";
const modelId = process.env.MARKDOWN_KEYBOARD_MODEL || "gpt-5.6-sol";
const prompt = process.argv.slice(2).join(" ") || [
  "Write a compact Markdown field note demonstrating a heading, bold text, a task list, a link, a blockquote, and inline code.",
  "Keep the complete document under three hundred characters.",
].join(" ");

function isKeyboardCharacter(character) {
  const code = character.codePointAt(0);
  return !disabledCharacters.has(character) && (character === "\n" || character === "\t" || (code >= 32 && code <= 126));
}

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const model = modelRegistry.find(provider, modelId);
if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);

if (process.argv.includes("--check")) {
  const available = await modelRegistry.getAvailable();
  const usable = available.some(candidate => candidate.provider === provider && candidate.id === modelId);
  console.log(JSON.stringify({ model: `${provider}/${modelId}`, available: usable }));
  process.exit(usable ? 0 : 2);
}

const resourceLoader = new DefaultResourceLoader({
  cwd: ROOT,
  agentDir: "C:/Users/you/.pi/agent",
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  systemPromptOverride: () => [
    "You write concise Markdown documents.",
    "Return only raw Markdown source with no surrounding commentary or outer code fence.",
    "Use only printable ASCII characters, spaces, tabs, and line feeds.",
    "Never use Unicode punctuation, smart quotes, emoji, or non ASCII characters.",
    `The physical keyboard has no ${[...disabledCharacters].join(" or ")} key. Never emit either form anywhere in the document.`,
    "Treat the absent letter as an absolute lipogram rule. Check every word before emitting it.",
    "Follow the requested length limit.",
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

fs.writeFileSync(STREAM_LOG, "", "utf8");
let rawText = "";
let forwardedText = "";
let deltaEvents = 0;
let unsupported = [];
let blocked = false;

const unsubscribe = session.subscribe(event => {
  if (event.type !== "message_update" || event.assistantMessageEvent.type !== "text_delta") return;
  const delta = event.assistantMessageEvent.delta;
  rawText += delta;
  deltaEvents += 1;
  const invalid = [...delta].filter(character => !isKeyboardCharacter(character));
  if (invalid.length) {
    unsupported.push(...invalid);
    blocked = true;
    return;
  }
  if (blocked) return;
  fs.appendFileSync(QUEUE, JSON.stringify(delta) + "\n", "utf8");
  fs.appendFileSync(STREAM_LOG, JSON.stringify({ event: deltaEvents, delta }) + "\n", "utf8");
  forwardedText += delta;
  process.stdout.write(delta);
});

try {
  await session.prompt(prompt);
  process.stdout.write("\n");
  const summary = {
    model: `${provider}/${modelId}`,
    deltaEvents,
    rawCharacters: rawText.length,
    forwardedCharacters: forwardedText.length,
    exactForwarding: rawText === forwardedText,
    unsupported: [...new Set(unsupported)].map(character => `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`),
    disabledCharacters: [...disabledCharacters],
  };
  console.log(JSON.stringify(summary));
  if (!summary.exactForwarding) process.exitCode = 3;
} finally {
  unsubscribe();
  session.dispose();
}
