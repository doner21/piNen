#!/usr/bin/env node
/** Item 3: real worker dispatch must cancel only its authenticated silent test child. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { assertItem3InvocationBudget, assertEveryItem3InvocationBudget } = require("./fixtures/item3-budget-assertions.cjs");

const ROOT = path.resolve(__dirname, "..");
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "orc-item3-no-output-"));
const WORKSPACE = path.join(TEMP_ROOT, "workspace");
const TEST_DIR = path.join(WORKSPACE, "tests");
const AGENT_DIR = path.join(TEMP_ROOT, "agent");
const RUNS_ROOT = path.join(TEMP_ROOT, "runs");
const NEXT_RUNS_ROOT = path.join(TEMP_ROOT, "next-runs");
const PHASE_ROOT = path.join(TEMP_ROOT, "phase-evidence");
for (const directory of [WORKSPACE, TEST_DIR, AGENT_DIR, RUNS_ROOT, NEXT_RUNS_ROOT, PHASE_ROOT]) {
  fs.mkdirSync(directory, { recursive: true });
}
fs.writeFileSync(path.join(AGENT_DIR, "settings.json"), JSON.stringify({
  defaultProvider: "fixture",
  defaultModel: "no-output-model",
}, null, 2));
fs.writeFileSync(path.join(AGENT_DIR, "auth.json"), "{}\n");
fs.writeFileSync(path.join(AGENT_DIR, "models.json"), JSON.stringify({
  providers: {
    fixture: {
      baseUrl: "http://127.0.0.1:9/v1",
      api: "openai-completions",
      apiKey: "fixture",
      models: [{
        id: "no-output-model",
        name: "No-output fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 2_000,
      }],
    },
  },
}, null, 2));
fs.mkdirSync(path.join(AGENT_DIR, "agents"), { recursive: true });
fs.writeFileSync(path.join(AGENT_DIR, "agents", "item3-roles.json"), JSON.stringify([
  { name: "planner", provider: "fixture", model: "no-output-model", tools: ["read", "bash"] },
  { name: "coder", provider: "fixture", model: "no-output-model", tools: ["read", "bash", "edit", "write"] },
  { name: "reviewer", provider: "fixture", model: "no-output-model", tools: ["read", "grep", "find", "ls", "bash"] },
], null, 2));
fs.mkdirSync(path.join(WORKSPACE, "logs"), { recursive: true });
fs.writeFileSync(path.join(TEST_DIR, "item3-silent.cjs"), [
  "process.stdout.write('API_TO');",
  "setTimeout(() => process.stdout.write('KEN=split-secret\\nHANGING_TEST_MARKER\\n'), 5);",
  "setTimeout(() => { console.log('NATURAL_FALLBACK_COMPLETION'); }, 900);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-busy-silent.cjs"), [
  "console.log('BUSY_HANG_MARKER');",
  "const end = Date.now() + 900;",
  "while (Date.now() < end) Math.sqrt(123456.789);",
  "console.log('BUSY_NATURAL_COMPLETION');",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-post-summary.cjs"), [
  "console.log('POST_SUMMARY_MARKER tests=1 pass=1 fail=0');",
  "setTimeout(() => console.log('POST_SUMMARY_NATURAL_COMPLETION'), 900);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-active-stdout.cjs"), [
  "let count = 0;",
  "const timer = setInterval(() => {",
  "  console.log(`STDOUT_ACTIVITY_${++count}`);",
  "  if (count === 8) clearInterval(timer);",
  "}, 80);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-active-stderr.cjs"), [
  "let count = 0;",
  "const timer = setInterval(() => {",
  "  console.error(`STDERR_ACTIVITY_${++count}`);",
  "  if (count === 8) clearInterval(timer);",
  "}, 80);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-file-active.cjs"), [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const flag = process.argv.indexOf('--outputFile');",
  "const output = path.resolve(process.argv[flag + 1]);",
  "let count = 0;",
  "const timer = setInterval(() => {",
  "  fs.appendFileSync(output, `FILE_ACTIVITY_${++count}\\n`);",
  "  if (count === 8) clearInterval(timer);",
  "}, 80);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-nested-capture-child.cjs"), [
  "const fs = require('node:fs');",
  "const flag = process.argv.indexOf('--outputFile');",
  "const index = process.argv[flag + 2];",
  "const head = Buffer.from(`NESTED_CAPTURE_HEAD_${index}\\n`);",
  "const tail = Buffer.from(`\\nNESTED_CAPTURE_TAIL_${index}\\n`);",
  "fs.writeFileSync(process.argv[flag + 1], Buffer.concat([head, Buffer.alloc(192 * 1024 - head.length - tail.length, 65), tail]));",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-nested-capture-middle.cjs"), [
  "const { spawn } = require('node:child_process');",
  "const path = require('node:path');",
  "const child = spawn(process.execPath, [path.join(__dirname, 'item3-nested-capture-child.cjs'), '--outputFile', path.join(__dirname, '..', 'logs', 'nested-1.log'), '1'], { stdio: 'inherit' });",
  "child.once('error', (error) => { console.error(error); process.exitCode = 1; });",
  "child.once('close', (code) => { if (code !== 0) process.exitCode = 1; else console.log('NESTED_CAPTURE_MIDDLE_COMPLETE'); });",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-nested-capture-wrapper.cjs"), [
  "const { spawn } = require('node:child_process');",
  "const path = require('node:path');",
  "const run = (file, args = []) => new Promise((resolve, reject) => {",
  "  const child = spawn(process.execPath, [path.join(__dirname, file), ...args], { stdio: 'inherit' });",
  "  child.once('error', reject);",
  "  child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`nested ${file} code=${code}`)));",
  "});",
  "Promise.all([",
  "  run('item3-nested-capture-child.cjs', ['--outputFile', path.join(__dirname, '..', 'logs', 'nested-0.log'), '0']),",
  "  run('item3-nested-capture-middle.cjs'),",
  "  run('helper.cjs'),",
  "]).then(() => console.log('NESTED_CAPTURE_WRAPPER_COMPLETE')).catch((error) => { console.error(error); process.exitCode = 1; });",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-capture-secret.cjs"), [
  "const fs = require('node:fs');",
  "const flag = process.argv.indexOf('--outputFile');",
  "fs.writeFileSync(process.argv[flag + 1], 'PASSWORD=synthetic_host_capture_secret_789\\nHOST_CAPTURE_SAFE_MARKER\\n');",
  "console.log('HOST_CAPTURE_NATURAL_COMPLETION');",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-capture-boundary.cjs"), [
  "const fs = require('node:fs');",
  "const flag = process.argv.indexOf('--outputFile');",
  "const suffix = 'FIRST_TOOL_SECRET_LINE\\r\\nLEAK_TOOL_ALPHA LEAK_TOOL_BETA\\\"\\r\\nSAFE_TOOL_OUTPUT\\r\\n' + 'B'.repeat(30000) + '\\nUSEFUL_TOOL_FINAL_MARKER\\n';",
  "const tail = 'X'.repeat(32768 - Buffer.byteLength(suffix)) + suffix;",
  "fs.writeFileSync(process.argv[flag + 1], 'PASSWORD=\\\"' + 'M'.repeat(100000) + tail);",
  "console.log('CAPTURE_BOUNDARY_WRITE_COMPLETE');",
  "setTimeout(() => console.log('CAPTURE_BOUNDARY_NATURAL_FALLBACK'), 900);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-file-replace.cjs"), [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const flag = process.argv.indexOf('--outputFile');",
  "const output = path.resolve(process.argv[flag + 1]);",
  "let count = 0;",
  "const replaceNext = () => {",
  "  const next = count + 1;",
  "  const temporary = `${output}.${next}.tmp`;",
  "  try {",
  "    fs.writeFileSync(temporary, `REPLACED_FILE_ACTIVITY_${next}\\n`);",
  "    fs.renameSync(temporary, output);",
  "    count = next;",
  "    if (count === 8) { console.log('REPLACEMENT_SEQUENCE_COMPLETE_8'); return; }",
  "    setImmediate(replaceNext);",
  "  } catch (error) {",
  "    try { fs.rmSync(temporary, { force: true }); } catch {}",
  "    console.error(`REPLACEMENT_SEQUENCE_FAILED_${next}:${error.code || error.message}`);",
  "    process.exitCode = 1;",
  "  }",
  "};",
  "setImmediate(replaceNext);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-undeclared-log.cjs"), [
  "const fs = require('node:fs');",
  "let count = 0;",
  "const timer = setInterval(() => {",
  "  fs.appendFileSync('logs/undeclared.log', `UNDECLARED_ACTIVITY_${++count}\\n`);",
  "  if (count === 8) { clearInterval(timer); console.log('UNDECLARED_NATURAL_COMPLETION'); }",
  "}, 80);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-giant-secret.cjs"), [
  "process.stdout.write('API_TOKEN=' + 'x'.repeat(70000) + '\\nGIANT_SECRET_MARKER\\n');",
  "setTimeout(() => console.log('GIANT_NATURAL_COMPLETION'), 900);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-noisy.cjs"), "console.log('N'.repeat(100000));\n");
fs.writeFileSync(path.join(TEST_DIR, "item3-tamper-artifact.cjs"), [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const root = path.resolve(process.argv[2]);",
  "for (const name of fs.readdirSync(root).filter((value) => value.endsWith('.json'))) fs.writeFileSync(path.join(root, name), '{\"tampered\":true}\\n');",
  "console.log('ARTIFACT_TAMPER_ATTEMPT_COMPLETE');",
  "",
].join("\n"));
const OUTSIDE_DIR = path.join(TEMP_ROOT, "outside-approved-root");
fs.mkdirSync(OUTSIDE_DIR, { recursive: true });
const OUTSIDE_LEAF = path.join(OUTSIDE_DIR, "leaf-target.log");
const CONTRACTED_LEAF_LINK = path.join(WORKSPACE, "logs", "leaf-link.log");
fs.writeFileSync(OUTSIDE_LEAF, "OUTSIDE_LEAF_INITIAL\n");
fs.symlinkSync(OUTSIDE_LEAF, CONTRACTED_LEAF_LINK, "file");
fs.mkdirSync(path.join(WORKSPACE, "logs", "junction"), { recursive: true });
fs.writeFileSync(path.join(TEST_DIR, "item3-junction-switch.cjs"), [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const outside = path.resolve(process.argv[2]);",
  "const link = path.resolve(process.argv[3]);",
  "fs.rmSync(link, { recursive: true, force: true });",
  "fs.symlinkSync(outside, link, 'junction');",
  "fs.writeFileSync(path.join(outside, 'log.txt'), 'OUTSIDE_APPROVED_ROOT_MARKER\\n');",
  "console.log('JUNCTION_SWITCH_COMPLETE');",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-writev-busy.cjs"), [
  "const fs = require('node:fs');",
  "const fd = fs.openSync(process.argv[2], 'w');",
  "const started = Date.now(); let next = started; let count = 0;",
  "while (Date.now() - started < 1300) { if (Date.now() >= next) { fs.writevSync(fd, [Buffer.from('WRITEV_'), Buffer.from(String(++count) + '\\n')]); next += 20; } }",
  "fs.closeSync(fd); console.log(`WRITEV_CJS_NATURAL_COMPLETION_${count}`);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-writev-busy.mjs"), [
  "import fs from 'node:fs';",
  "const fd = fs.openSync(process.argv[2], 'w');",
  "const started = Date.now(); let next = started; let count = 0;",
  "while (Date.now() - started < 1300) { if (Date.now() >= next) { fs.writevSync(fd, [Buffer.from('ESM_'), Buffer.from(String(++count) + '\\n')]); next += 20; } }",
  "fs.closeSync(fd); console.log(`WRITEV_ESM_NATURAL_COMPLETION_${count}`);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-counter-operations.cjs"), [
  "const fs = require('node:fs');",
  "const base = process.argv[2]; const copy = `${base}.copy`; const moved = `${base}.moved`;",
  "fs.writeFileSync(base, 'abcdefgh');",
  "const started = Date.now(); let next = started; let count = 0;",
  "while (Date.now() - started < 1300) { if (Date.now() >= next) { fs.copyFileSync(base, copy); fs.truncateSync(copy, (++count % 8) + 1); fs.renameSync(copy, moved); fs.renameSync(moved, copy); next += 20; } }",
  "console.log(`COUNTER_OPERATIONS_NATURAL_COMPLETION_${count}`);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-worker-thread-writer.cjs"), [
  "const { Worker } = require('node:worker_threads');",
  "const source = `const { parentPort, workerData } = require('node:worker_threads'); const fs = require('node:fs'); let n=0; const i=setInterval(()=>{ fs.appendFileSync(workerData, 'WORKER_'+(++n)+'\\\\n'); if(n===8){clearInterval(i);parentPort.postMessage('done')} },80);`;",
  "const worker = new Worker(source, { eval: true, workerData: process.argv[2] });",
  "worker.on('message', () => console.log('WORKER_THREAD_NATURAL_COMPLETION'));",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-sync-busy-writer.cjs"), [
  "const fs = require('node:fs');",
  "const output = process.argv[2];",
  "const started = Date.now();",
  "let next = started; let count = 0;",
  "while (Date.now() - started < 1300) { if (Date.now() >= next) { fs.appendFileSync(output, `SYNC_BUSY_${++count}\\n`); next += 20; } }",
  "console.log(`SYNC_BUSY_NATURAL_COMPLETION_${count}`);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-closed-observer-writer.cjs"), [
  "const fs = require('node:fs');",
  "try { fs.closeSync(3); } catch {}",
  "let count = 0;",
  "const timer = setInterval(() => { fs.appendFileSync(process.argv[2], `CLOSED_FD_ACTIVITY_${++count}\\n`); if (count === 8) { clearInterval(timer); console.log('CLOSED_FD_NATURAL_COMPLETION'); } }, 80);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-same-size-writer.cjs"), [
  "const fs = require('node:fs');",
  "const output = process.argv[2];",
  "fs.writeFileSync(output, 'AAAA');",
  "let count = 0;",
  "const timer = setInterval(() => { fs.writeFileSync(output, (++count % 2) ? 'BBBB' : 'CCCC'); if (count === 8) { clearInterval(timer); console.log('SAME_SIZE_NATURAL_COMPLETION'); } }, 80);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-renamed-handle-writer.cjs"), [
  "const fs = require('node:fs');",
  "const output = process.argv[2];",
  "const renamed = `${output}.renamed`;",
  "fs.writeFileSync(output, '0000');",
  "const fd = fs.openSync(output, 'r+');",
  "fs.renameSync(output, renamed);",
  "let count = 0;",
  "const timer = setInterval(() => { const value = Buffer.from(String(++count).padStart(4, '0')); fs.writeSync(fd, value, 0, 4, 0); if (count === 8) { clearInterval(timer); fs.closeSync(fd); console.log('RENAMED_HANDLE_NATURAL_COMPLETION'); } }, 80);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-argument-writer.cjs"), [
  "const fs = require('node:fs');",
  "const output = process.argv[2];",
  "let count = 0;",
  "const timer = setInterval(() => { fs.appendFileSync(output, `ARGUMENT_ACTIVITY_${++count}\\n`); if (count === 8) { clearInterval(timer); console.log('ARGUMENT_WRITER_NATURAL_COMPLETION'); } }, 80);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-package-wrapper.cjs"), [
  "const { spawn } = require('node:child_process');",
  "const path = require('node:path');",
  "function run(file) { return new Promise((resolve, reject) => { const child = spawn(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' }); child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }); }",
  "(async () => { const first = await run('item3-silent.cjs'); console.log(`PACKAGE_CHILD_ONE=${first.code}`); const second = await run('item3-success.cjs'); console.log(`PACKAGE_CHILD_TWO=${second.code}`); console.log('PACKAGE_WRAPPER_CONTINUED'); })().catch((error) => { console.error(error); process.exitCode = 1; });",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-descendant-child.cjs"), [
  "const fs = require('node:fs');",
  "let count = 0;",
  "const timer = setInterval(() => { fs.appendFileSync(process.argv[2], `DESCENDANT_ACTIVITY_${++count}\\n`); if (count === 8) { clearInterval(timer); console.log('DESCENDANT_CHILD_COMPLETE'); } }, 80);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-descendant-parent.cjs"), [
  "const { spawn } = require('node:child_process');",
  "const path = require('node:path');",
  "const child = spawn(process.execPath, [path.join(__dirname, 'item3-descendant-child.cjs'), process.argv[2]], { stdio: 'inherit' });",
  "child.on('close', () => console.log('DESCENDANT_PARENT_NATURAL_COMPLETION'));",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-path.cjs"), "console.log(`PATH_VALUE=${process.env.PATH}`);\n");
fs.writeFileSync(path.join(TEST_DIR, "item3-preload.cjs"), [
  "const fs = require('node:fs');",
  "const file = process.env.ITEM3_PRELOAD_COUNT_FILE;",
  "const count = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;",
  "fs.writeFileSync(file, String(count + 1));",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-preload-target.cjs"), "console.log('PRELOAD_TARGET_COMPLETE');\n");
fs.writeFileSync(path.join(TEST_DIR, "item3-escaped-output.cjs"), [
  "process.stdout.write('ESCAPED_OUTPUT_MARKER\\n' + '\\\\'.repeat(70000));",
  "setTimeout(() => console.log('ESCAPED_NATURAL_COMPLETION'), 900);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-oversize-artifact.cjs"), [
  "process.stdout.write(String.fromCharCode(1).repeat(70000) + '\\nOVERSIZE_ARTIFACT_TAIL_MARKER\\n');",
  "setTimeout(() => console.log('OVERSIZE_NATURAL_COMPLETION'), 900);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-multibyte.cjs"), [
  "const value = Buffer.from('MULTIBYTE_🙂_認証_MARKER\\n');",
  "process.stdout.write(value.subarray(0, 12));",
  "setTimeout(() => process.stdout.write(value.subarray(12)), 5);",
  "setTimeout(() => console.log('MULTIBYTE_NATURAL_COMPLETION'), 900);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-leaf-link-writer.cjs"), [
  "const fs = require('node:fs');",
  "let count = 0;",
  "const timer = setInterval(() => { fs.writeFileSync(process.argv[2], `OUTSIDE_LEAF_MARKER_${++count}`); if (count === 8) { clearInterval(timer); console.log('LEAF_LINK_NATURAL_COMPLETION'); } }, 80);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-unsupported.cjs"), [
  "setTimeout(() => console.log('UNSUPPORTED_NATURAL_COMPLETION'), 400);",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-success.cjs"), "console.log('ORDINARY_SUCCESS');\n");
fs.writeFileSync(path.join(TEST_DIR, "item3-cwd.cjs"), "console.log('ROOT_CWD_SCRIPT');\n");
fs.mkdirSync(path.join(WORKSPACE, "sub", "tests"), { recursive: true });
fs.writeFileSync(path.join(WORKSPACE, "sub", "tests", "item3-cwd.cjs"), "console.log('SUB_CWD_SCRIPT');\n");
fs.writeFileSync(path.join(TEST_DIR, "item3-stdin.cjs"), [
  "let value = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { value += chunk; });",
  "process.stdin.on('end', () => console.log(`STDIN=${value}`));",
  "",
].join("\n"));
fs.writeFileSync(path.join(TEST_DIR, "item3-session.cjs"), "console.log(`SESSION_CTX=${process.env.PI_SESSION_ID || 'MISSING'}`);\n");
fs.writeFileSync(path.join(TEST_DIR, "item3-fail.cjs"), "console.error('ORDINARY_FAILURE'); process.exitCode = 3;\n");
fs.writeFileSync(path.join(TEST_DIR, "main.js"), "setTimeout(() => {}, 1);\n");
for (const excluded of ["agent.cjs", "worker.cjs", "helper.cjs", "native-host.cjs", "audio-app.cjs", "electron-app.cjs"]) {
  fs.writeFileSync(path.join(TEST_DIR, excluded), "setTimeout(() => {}, 1);\n");
}
fs.mkdirSync(path.join(WORKSPACE, "src"), { recursive: true });
fs.writeFileSync(path.join(WORKSPACE, "src", "utility.js"), "setTimeout(() => {}, 1);\n");
const contractedTests = [
  "item3-silent.cjs", "item3-busy-silent.cjs", "item3-post-summary.cjs", "item3-active-stdout.cjs",
  "item3-active-stderr.cjs", "item3-success.cjs", "item3-fail.cjs", "item3-cwd.cjs", "item3-stdin.cjs",
  "item3-session.cjs", "item3-giant-secret.cjs", "item3-noisy.cjs", "item3-tamper-artifact.cjs", "item3-junction-switch.cjs",
  "item3-writev-busy.cjs", "item3-writev-busy.mjs", "item3-counter-operations.cjs", "item3-worker-thread-writer.cjs",
  "item3-sync-busy-writer.cjs", "item3-closed-observer-writer.cjs", "item3-same-size-writer.cjs", "item3-renamed-handle-writer.cjs", "item3-argument-writer.cjs",
  "item3-package-wrapper.cjs", "item3-descendant-child.cjs", "item3-descendant-parent.cjs", "item3-path.cjs", "item3-preload.cjs",
  "item3-preload-target.cjs", "item3-escaped-output.cjs", "item3-oversize-artifact.cjs", "item3-multibyte.cjs", "item3-leaf-link-writer.cjs", "item3-capture-secret.cjs", "item3-capture-boundary.cjs", "item3-nested-capture-child.cjs", "item3-nested-capture-middle.cjs", "item3-nested-capture-wrapper.cjs",
].map((name) => ({ path: `tests/${name}`, stdioComplete: true, outputFiles: [] }));
contractedTests.push(
  { path: "tests/item3-file-active.cjs", stdioComplete: true, outputFiles: ["logs/activity.log"] },
  { path: "tests/item3-file-replace.cjs", stdioComplete: true, outputFiles: ["logs/replace.log"] },
  { path: "tests/item3-capture-secret.cjs", stdioComplete: true, outputFiles: ["logs/capture-secret.log"] },
  { path: "tests/item3-capture-boundary.cjs", stdioComplete: true, outputFiles: ["logs/capture-boundary.log"] },
  { path: "tests/item3-nested-capture-child.cjs", stdioComplete: true, outputFiles: ["logs/nested-0.log", "logs/nested-1.log"] },
  { path: "sub/tests/item3-cwd.cjs", stdioComplete: true, outputFiles: [] },
);
const packageScripts = Object.fromEntries(contractedTests.map((entry, index) => [`test:item3-${index}`, `node ${entry.path}`]));
packageScripts["test:wrapper"] = "node tests/item3-package-wrapper.cjs";
fs.writeFileSync(path.join(WORKSPACE, "package.json"), JSON.stringify({
  name: "item3-isolated-workspace", private: true,
  scripts: packageScripts,
}, null, 2));

// Every mutable/configuration/run root exists before product or Pi imports.
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.PI_ORCHESTRATOR_RUNS_ROOT = RUNS_ROOT;
process.env.PI_ORCHESTRATOR_NEXT_RUNS_ROOT = NEXT_RUNS_ROOT;
process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER = TEMP_ROOT;
process.env.PI_OFFLINE = "1";
process.env.PI_CLI_PATH = path.join(__dirname, "fixtures", "no-output-agent-session-worker.cjs");
process.env.ITEM3_LAUNCH_RECORDS = path.join(TEMP_ROOT, "launch-records.jsonl");
process.env.ITEM3_PROGRESS_RECORDS = path.join(TEMP_ROOT, "progress-records.jsonl");
process.env.ITEM3_OUTSIDE_DIR = OUTSIDE_DIR;
process.env.ITEM3_PRELOAD_COUNT_FILE = path.join(WORKSPACE, "logs", "preload-count.txt");
process.env.PI_ORCHESTRATOR_NO_OUTPUT_POLICY = JSON.stringify({
  minimumObservationMs: 100,
  alarmAfterMs: 150,
  cancelAfterMs: 300,
  minimumAlarmLeadMs: 100,
  pollMs: 10,
});

const PI_MODULES = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");
process.env.NODE_PATH = [PI_MODULES, path.join(ROOT, "node_modules"), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter);
Module._initPaths();

function fixtureIntake() {
  return {
    originalTask: "item3 cancellation evidence must reach an independent verifier",
    taskSummary: "item3 fixture",
    taskType: "implementation",
    userIntent: "prove no-output cancellation evidence",
    goalAttractor: "safe unattended test execution",
    taskScope: "fixture only",
    constraints: ["cancel only an authenticated run-owned test child"],
    invariants: ["no command deadline"],
    successCriteria: ["HANGING_TEST_MARKER reaches the verifier"],
    deliverables: [], failureCriteria: [], nonGoals: [], ambiguities: [],
    routingDecision: "fixture", routingRequirements: [], orchestrationControls: {},
    inferredAdvisoryCriteria: [], criteriaProvenance: [],
    ownerCriteria: { success: ["HANGING_TEST_MARKER reaches the verifier"], failure: [] },
    supervisorAddedConstraints: [], plannerInferredPresentationRules: [],
  };
}

function readRecords() {
  return fs.readFileSync(process.env.ITEM3_LAUNCH_RECORDS, "utf8")
    .trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

async function main() {
  if (process.argv.includes("--failure-root-preservation-probe")) {
    fs.writeFileSync(path.join(TEMP_ROOT, "failure-root-probe.json"), JSON.stringify({
      outcome: "failed",
      marker: "ITEM3_FAILURE_ROOT_EVIDENCE",
    }));
    console.error(`ITEM3_FAILURE_ROOT=${TEMP_ROOT}`);
    throw new Error("finite injected item3 suite failure for root-preservation coverage");
  }
  const createJiti = require(path.join(PI_MODULES, "jiti", "lib", "jiti.cjs"));
  const jiti = createJiti(__filename, { interopDefault: true, moduleCache: false, fsCache: false });
  const substrate = jiti(path.join(ROOT, "src", "substrate.ts"));
  const orchestrator = jiti(path.join(ROOT, "src", "index.ts"));
  const monitor = jiti(path.join(ROOT, "src", "worker-no-output-monitor.ts"));
  const helper = require(path.join(ROOT, "src", "no-output-test-supervisor.cjs"));

  // Deterministic policy boundaries: early judgment is impossible, delayed
  // ticks publish first, fresh output disarms, and later silence is a new episode.
  const machine = new helper.SilencePolicyMachine({
    minimumObservationMs: 20, alarmAfterMs: 45, cancelAfterMs: 90, minimumAlarmLeadMs: 20, pollMs: 5,
  }, 0);
  assert.equal(machine.tick(19), undefined);
  assert.equal(machine.tick(44), undefined);
  assert.equal(machine.tick(100).kind, "alarm", "a late first tick must alarm rather than cancel");
  assert.equal(machine.tick(119), undefined, "alarm/cancel must retain a positive lead even after a delayed tick");
  machine.observeOutput(120);
  assert.equal(machine.tick(200).kind, "alarm", "fresh output must create a new silence episode");
  assert.equal(machine.acknowledgeAlarm(200), true);
  assert.equal(machine.tick(220).kind, "cancel");

  const frozenAuthorization = substrate.freezeRunTestAuthorizationPolicy({
    cwd: WORKSPACE,
    ownerTask: "Run item3 tests and verification",
    approvedTestScopes: [TEST_DIR, path.join(WORKSPACE, "sub", "tests")],
  });
  const eligible = helper.classifyTest([path.join(TEST_DIR, "item3-silent.cjs")], WORKSPACE, frozenAuthorization);
  assert.equal(eligible.eligible, true);
  const replaceEligibility = helper.classifyTest([path.join(TEST_DIR, "item3-file-replace.cjs")], WORKSPACE, frozenAuthorization);
  assert.equal(replaceEligibility.eligible, true);
  assert.equal(helper.classifyTest([path.join(TEST_DIR, "main.js")], WORKSPACE, frozenAuthorization).eligible, false,
    "unlisted application identities remain outside frozen package-test authority");
  for (const excluded of ["agent.cjs", "worker.cjs", "helper.cjs", "native-host.cjs", "audio-app.cjs", "electron-app.cjs"]) {
    assert.equal(helper.classifyTest([path.join(TEST_DIR, excluded)], WORKSPACE, frozenAuthorization).eligible, false,
      `${excluded} must not inherit authority from a general directory scope`);
  }
  assert.equal(helper.classifyTest([path.join(WORKSPACE, "src", "utility.js")], WORKSPACE, frozenAuthorization).eligible, false,
    "arbitrary workspace Node programs remain observe-only");
  const monitorSource = fs.readFileSync(path.join(ROOT, "src", "worker-no-output-monitor.ts"), "utf8");
  assert.doesNotMatch(monitorSource, /rewriteCommand|findBareNodeCommandTokens/,
    "the monitor must preserve shell language and use a command-scoped PATH shim");
  const helperSource = fs.readFileSync(path.join(ROOT, "src", "no-output-test-supervisor.cjs"), "utf8");
  assert.match(helperSource, /cancellationAccepted = child\.kill\(\)/,
    "the one cancellation boundary must use the retained ChildProcess handle");
  assert.doesNotMatch(helperSource, /taskkill|killProcessTree|process\.kill|\/T\b|detached:\s*true/i,
    "the test supervisor must not target PIDs, trees, groups, or detached processes");

  const agents = new Map([
    ["planner", { name: "planner", provider: "fixture", model: "no-output-model", tools: ["read", "bash"] }],
    ["coder", { name: "coder", provider: "fixture", model: "no-output-model", tools: ["read", "bash", "edit", "write"] }],
    ["reviewer", { name: "reviewer", provider: "fixture", model: "no-output-model", tools: [...substrate.VERIFIER_EVIDENCE_TOOLS] }],
  ]);
  const roles = [
    { role: "planner", agentName: "planner", verifier: false },
    { role: "executor", agentName: "coder", verifier: false },
    { role: "verifier", agentName: "reviewer", verifier: true },
  ];
  const alarms = [];
  const results = [];
  let sequence = 0;
  const launch = async (launcher, spec, scenario, mutation = {}) => {
    sequence += 1;
    process.env.ITEM3_LAUNCHER_KIND = launcher;
    process.env.ITEM3_ROLE = spec.role;
    process.env.ITEM3_SCENARIO = typeof scenario === "string" ? scenario : scenario ? "comprehensive" : "basic";
    if (process.argv.includes("--mutation-wiring") || mutation.suppressMonitor) process.env.ITEM3_SUPPRESS_MONITOR = "1";
    else delete process.env.ITEM3_SUPPRESS_MONITOR;
    if (process.argv.includes("--mutation-drop-evidence")) process.env.ITEM3_MUTATION_DROP_EVIDENCE = "1";
    else delete process.env.ITEM3_MUTATION_DROP_EVIDENCE;
    if (process.argv.includes("--mutation-drop-partial")) process.env.ITEM3_MUTATION_DROP_PARTIAL = "1";
    else delete process.env.ITEM3_MUTATION_DROP_PARTIAL;
    if (mutation.samplerLoss) process.env.PI_ORCHESTRATOR_TEST_COUNTER_SAMPLER_EXIT_AFTER_READY = "1";
    else delete process.env.PI_ORCHESTRATOR_TEST_COUNTER_SAMPLER_EXIT_AFTER_READY;
    if (mutation.samplerExitAfterSamples) process.env.PI_ORCHESTRATOR_TEST_COUNTER_SAMPLER_EXIT_AFTER_SAMPLES = String(mutation.samplerExitAfterSamples);
    else delete process.env.PI_ORCHESTRATOR_TEST_COUNTER_SAMPLER_EXIT_AFTER_SAMPLES;
    if (mutation.samplerLossAfterAck) process.env.PI_ORCHESTRATOR_TEST_COUNTER_SAMPLER_LOSS_AFTER_ACK = "1";
    else delete process.env.PI_ORCHESTRATOR_TEST_COUNTER_SAMPLER_LOSS_AFTER_ACK;
    if (mutation.suppressAck) process.env.PI_ORCHESTRATOR_TEST_SUPPRESS_ALARM_ACK = "1";
    else delete process.env.PI_ORCHESTRATOR_TEST_SUPPRESS_ALARM_ACK;
    const base = path.join(PHASE_ROOT, `${launcher}-${spec.role}-${sequence}`);
    const options = {
      agents, cwd: WORKSPACE, allowLocalModel: true,
      phaseLogFile: `${base}.log`, phaseResultFile: `${base}.result.json`,
      verifier: spec.verifier, readOnly: spec.verifier,
      workerExecutionConstraints: { noForceKill: true, testAuthorization: frozenAuthorization },
      onProgress(text) { if (text.startsWith("COMMAND_NO_OUTPUT_ALARM")) alarms.push(text); },
    };
    return launcher === "substrate"
      ? substrate.spawnSubagent(spec.agentName, `item3 ${launcher} ${spec.role}`, options)
      : orchestrator.runLegacySubagentForTest(spec.agentName, `item3 ${launcher} ${spec.role}`, options);
  };

  if (process.argv.includes("--artifact-tamper-focused")) {
    const focusedResult = await launch("substrate", { role: "artifact-tamper-focused", agentName: "coder", verifier: false }, "artifact-tamper-focused");
    assert.equal(focusedResult.exitCode, 0, "the cancelled test child must not cancel its worker");
    const focusedRecord = readRecords().find((record) => record.role === "artifact-tamper-focused");
    const tool = focusedRecord?.toolResults?.find((entry) => entry.toolCallId === "artifact-tamper");
    assert.equal(tool?.details?.noOutput?.outcome, "cancelled_no_output",
      `the original oversize artifact scenario must retain its confirmed cancellation: ${JSON.stringify(tool?.details?.invocationTelemetry)}`);
    assert.match(tool?.details?.noOutput?.partialLog ?? "", /OVERSIZE_ARTIFACT_TAIL_MARKER/,
      "the useful partial-log tail must reach the actual host result");
    assert.match(tool?.text ?? "", /ARTIFACT_TAMPER_ATTEMPT_COMPLETE/,
      "the original command must naturally continue through its tamper attempt");
    assert.doesNotMatch(tool?.text ?? "", /NO_OUTPUT_SUPERVISOR_ERROR/,
      "the repaired transport must not surface the prior terminal refusal");
    assert.equal(tool?.details?.commandOwnerAccounting?.pendingRequests, 0);
    assert.equal(tool?.details?.commandOwnerAccounting?.currentOutstandingBytes, 0);
    assert.equal(tool?.details?.commandOwnerAccounting?.activeRegistrations, 0);
    assertEveryItem3InvocationBudget(tool?.details, "artifact-tamper-focused");
    console.log("PASS item3 focused actual artifact-tamper oversize scenario settles with authenticated partial evidence");
    return;
  }

  if (process.argv.includes("--gate-capture-boundary")) {
    const captureResult = await launch("substrate", { role: "gate-capture-boundary", agentName: "coder", verifier: false }, "gate-capture-boundary");
    assert.equal(captureResult.exitCode, 0, "an owned cancelled test must not cancel its worker");
    const captureRecord = readRecords().find((record) => record.role === "gate-capture-boundary");
    const tool = captureRecord?.toolResults?.find((entry) => entry.toolCallId === "gate-capture-boundary");
    assert.equal(tool?.details?.noOutput?.outcome, "cancelled_no_output");
    const retained = JSON.stringify({ tool, evidence: captureResult.actionEvidence });
    assert.doesNotMatch(retained, /FIRST_TOOL_SECRET_LINE|LEAK_TOOL_ALPHA|LEAK_TOOL_BETA/);
    assert.match(retained, /SAFE_TOOL_OUTPUT/);
    assert.match(retained, /USEFUL_TOOL_FINAL_MARKER/);
    assert.doesNotMatch(retained, /CAPTURE_BOUNDARY_NATURAL_FALLBACK/);
    assertEveryItem3InvocationBudget(tool?.details, "gate-capture-boundary");
    console.log("PASS item3 focused host-managed discontinuous capture redaction");
    return;
  }

  if (process.argv.includes("--gate-owner-followup")) {
    const followupResult = await launch("substrate", { role: "gate-owner-followup", agentName: "coder", verifier: false }, "gate-owner-followup");
    assert.equal(followupResult.exitCode, 0, "owner contention must not change the naturally successful command result");
    const followupRecord = readRecords().find((record) => record.role === "gate-owner-followup");
    const tool = followupRecord?.toolResults?.find((entry) => entry.toolCallId === "gate-owner-followup");
    assert.match(tool?.text ?? "", /NESTED_CAPTURE_WRAPPER_COMPLETE/);
    assert.match(tool?.text ?? "", /REPLACEMENT_SEQUENCE_COMPLETE_8/,
      "ordinary direct Node rename must remain successful while observation is active");
    assert.equal(tool?.details?.noOutput, undefined);
    const adapter = tool?.details?.item3OwnerFollowup;
    assert.equal(adapter?.scenarioError, "", `the concurrent owner scenario must settle cleanly: ${adapter?.scenarioError}`);
    assert.equal(adapter?.scenarioStarted, true);
    assert.equal(adapter?.scenarioCompleted, true,
      "the failure/contention adapter must overlap and settle during the actual monitored command");
    assert.equal(adapter?.actualPartialWriteBytes, 48 * 1024,
      "the integrated path must execute an actual partial staging write");
    assert.equal(adapter?.partialFailureCharged, true,
      "failed staging work must remain charged until cleanup is conclusive");
    assert.equal(adapter?.cleanupReclaimed, true,
      "a later finite owner cycle must reclaim only the conclusively deleted partial stage");
    assert.equal(adapter?.zeroFailureCharged, true,
      "an existing zero-byte stage must retain its file allocation and permission");
    assert.equal(adapter?.zeroCleanupReclaimed, true,
      "a later finite owner cycle must conclusively reclaim the zero-byte stage");
    assert.equal(adapter?.priorSurvived, true,
      "the prior committed generation must remain readable through partial and zero-byte successor failures");
    assert.equal(adapter?.deferredObserved, true,
      "real monitor traffic must be retained as one bounded pending request during contention");
    assert.equal(adapter?.unadmittedPayloadStarted, false,
      "the real supervisor must not send payload before the deferred grant");
    assert.ok(adapter?.actualOwnerRequestsDuringScenario > 0,
      "the actual supervisor and nested preload must publish while the same owner scenario is active");
    assert.ok(adapter?.nativeCounterDeliveriesDuringScenario > 0,
      "real PowerShell counter responses must share the owner while failed work and contention are active");
    assert.deepEqual(adapter?.terminalDrainCases?.map((entry) => entry.mode),
      ["growth", "same-size-corruption", "open-read-failure"],
      "the real monitor must consume all bounded terminal-drain failure modes");
    assert.ok(adapter.terminalDrainCases.every((entry) => entry.threw === ""),
      "one corrupt terminal generation must remain record-local on the actual monitor drain");
    assert.ok(adapter.terminalDrainCases.every((entry) => entry.healthyDelivered && !entry.corruptDelivered),
      "the actual monitor drain must preserve each subsequent healthy terminal without accepting corrupt evidence");
    assert.ok(adapter.terminalDrainCases.every((entry) => entry.bounded),
      "the actual monitor drain must never read beyond the admitted committed generation length");
    assert.ok(adapter.terminalDrainCases.every((entry) => entry.handlesClosed),
      "the actual monitor drain must close every opened generation descriptor in finally");
    assert.ok(adapter.terminalDrainCases.every((entry) => entry.relatedLeases === 0 && entry.queuedRelated === 0),
      "the actual monitor drain must settle every affected delivery lease and queue record");
    assert.ok(adapter.terminalDrainCases.every((entry) => entry.failedOperationRecorded),
      "terminal read/corruption failures must remain explicit in owner failure accounting");
    assert.ok((tool?.details?.observationMetrics?.queryOnlyBindings ?? 0) >= 4,
      "the monitor/supervisor/nested-preload path must use real query-only PowerShell bindings");
    assert.ok(tool?.details?.invocationTelemetry?.length >= 6,
      "direct, middle, grandchild, unauthorized nested, wrapper, and rename invocations must reach the real monitor");
    assert.ok(tool.details.invocationTelemetry.some((entry) => Number(entry.hostSharedReadAccounting?.currentActualBytes || 0) > 0),
      "actual post-settlement capture must consume the command owner's shared read path");
    const retainedCapture = JSON.stringify(tool.details.declaredFileCapture);
    assert.match(retainedCapture, /NESTED_CAPTURE_HEAD_0/);
    assert.match(retainedCapture, /NESTED_CAPTURE_TAIL_0/);
    const durable = adapter.durableTerminalTexts.join("\n");
    assert.match(durable, /NESTED_CAPTURE_HEAD_0/,
      "production capture must be committed durably before terminal retirement, not substituted after drain");
    assert.match(durable, /NESTED_CAPTURE_TAIL_0/);
    assert.ok(Number(tool.details.commandOwnerAccounting?.maxCombinedActualBytes) <= 256 * 1024,
      "actual transport, failed staging, capture, delivery, and final drain must share the fixed ceiling");
    assert.equal(Number(tool.details.commandOwnerAccounting?.failedRetainedBytes), 0);
    assert.equal(Number(tool.details.commandOwnerAccounting?.retainedFailedStages), 0);
    assert.equal(Number(tool.details.commandOwnerAccounting?.activeStages), 0);
    assert.equal(Number(tool.details.commandOwnerAccounting?.reservedEventQueueBytes), 0);
    assert.equal(Number(tool.details.commandOwnerAccounting?.currentOutstandingBytes), 0);
    assert.ok(Number(tool.details.commandOwnerAccounting?.maxCombinedQueueBytes) <= 64 * 1024);
    assert.equal(Number(tool.details.commandOwnerAccounting?.pendingRequests), 0);
    assertEveryItem3InvocationBudget(tool.details, "gate-owner-followup");
    console.log("PASS item3 integrated owner failure/contention monitor-supervisor-nested-preload capture");
    return;
  }

  if (process.argv.includes("--gate-nested-capture")) {
    const nestedResult = await launch("substrate", { role: "gate-nested-capture", agentName: "coder", verifier: false }, "gate-nested-capture");
    assert.equal(nestedResult.exitCode, 0);
    const nestedRecord = readRecords().find((record) => record.role === "gate-nested-capture");
    const tool = nestedRecord?.toolResults?.find((entry) => entry.toolCallId === "gate-nested-capture");
    assert.match(tool?.text ?? "", /NESTED_CAPTURE_WRAPPER_COMPLETE/);
    assert.equal(tool?.details?.invocationTelemetry?.length, 5,
      "wrapper, direct child, nested middle/grandchild, and unauthorized observe-only child must reach the host");
    assert.ok(tool.details.invocationTelemetry.every((entry) => Number(entry.sharedReadAccounting?.currentCycleBytes || 0) === 0),
      "nested supervisors must not create independent local capture/read budgets");
    const retained = JSON.stringify(tool.details.declaredFileCapture);
    assert.match(retained, /NESTED_CAPTURE_HEAD_0/);
    assert.match(retained, /NESTED_CAPTURE_TAIL_0/);
    assert.match(retained, /NESTED_CAPTURE_HEAD_1/);
    assert.match(retained, /NESTED_CAPTURE_TAIL_1/);
    assertEveryItem3InvocationBudget(tool.details, "gate-nested-capture");
    console.log("PASS item3 focused nested host-managed capture ownership");
    return;
  }

  if (process.argv.includes("--gate-startup-loss")) {
    const startupResult = await launch("substrate", { role: "gate-startup-loss", agentName: "coder", verifier: false }, false, { samplerLoss: true });
    assert.equal(startupResult.actionEvidence.entries[0]?.outcome, "succeeded");
    const startupRecord = readRecords().find((record) => record.role === "gate-startup-loss");
    assert.match(startupRecord?.toolResults[0]?.details?.noOutputObservation?.reason ?? "", /counter sampler|counter observation/i);
    assertItem3InvocationBudget(startupRecord?.toolResults[0]?.details?.telemetryAccounting, "gate-startup-loss");
    console.log("PASS item3 focused startup sensor loss");
    return;
  }

  if (process.argv.includes("--gate-sensor-loss")) {
    const lossResult = await launch("substrate", { role: "gate-sensor-loss", agentName: "coder", verifier: false }, false, { samplerLossAfterAck: true });
    assert.equal(lossResult.actionEvidence.entries[0]?.outcome, "succeeded");
    const lossRecord = readRecords().find((record) => record.role === "gate-sensor-loss");
    assert.ok(lossRecord?.alarms?.some((alarm) => alarm.eligibility?.eligible === true),
      "active sensor-loss fixture must first reach an eligible delivered alarm");
    assert.match(lossRecord?.toolResults[0]?.details?.noOutputObservation?.reason ?? "", /counter sampler|counter observation/i);
    assertItem3InvocationBudget(lossRecord?.toolResults[0]?.details?.telemetryAccounting, "gate-sensor-loss");
    console.log("PASS item3 focused active registered sensor loss");
    return;
  }

  if (process.argv.includes("--gate-counter-only")) {
    const gateResult = await launch("substrate", roles[1], "gate-counter-only");
    assert.equal(gateResult.exitCode, 0);
    const gateRecord = readRecords().find((record) => record.role === "executor");
    const gateById = new Map(gateRecord.toolResults.map((entry) => [entry.toolCallId, entry]));
    for (const id of ["gate-busy-silent", "gate-idle-silent"]) {
      assert.equal(gateById.get(id)?.details?.noOutput?.outcome, "cancelled_no_output", `${id} must actually cancel: ${JSON.stringify(gateById.get(id)?.details)}`);
      assert.match(gateById.get(id)?.details?.noOutput?.partialLog ?? "", /BUSY_HANG_MARKER|HANGING_TEST_MARKER/);
      assertItem3InvocationBudget(gateById.get(id)?.details?.telemetryAccounting, id);
    }
    for (const [id, marker] of [
      ["gate-undeclared-writer", "UNDECLARED_NATURAL_COMPLETION"],
      ["gate-writev-cjs", "WRITEV_CJS_NATURAL_COMPLETION"],
      ["gate-writev-esm", "WRITEV_ESM_NATURAL_COMPLETION"],
      ["gate-worker-thread", "WORKER_THREAD_NATURAL_COMPLETION"],
      ["gate-same-size", "SAME_SIZE_NATURAL_COMPLETION"],
      ["gate-renamed-handle", "RENAMED_HANDLE_NATURAL_COMPLETION"],
      ["gate-argument-selected", "ARGUMENT_WRITER_NATURAL_COMPLETION"],
    ]) {
      assert.equal(gateById.get(id)?.details?.noOutput, undefined, `${id} must survive active process-counter writes`);
      assert.match(gateById.get(id)?.text ?? "", new RegExp(marker));
      assert.ok((gateById.get(id)?.details?.observationMetrics?.processCounterActivity ?? 0) > 0);
      assertItem3InvocationBudget(gateById.get(id)?.details?.telemetryAccounting, id);
    }
    console.log("PASS item3 focused gate counter activity and true silence");
    return;
  }

  // One comprehensive executor plus both production launchers across all three
  // role fences. Every child is offline and naturally settles unless the one
  // narrow cancellation path under test confirms its owned test handle.
  let comprehensiveResult;
  try { comprehensiveResult = await launch("substrate", roles[1], true); }
  catch (error) {
    const progress = fs.existsSync(process.env.ITEM3_PROGRESS_RECORDS)
      ? fs.readFileSync(process.env.ITEM3_PROGRESS_RECORDS, "utf8").trim().split(/\r?\n/).slice(-10).join("\n")
      : "(no tool-result progress)";
    console.error(`ITEM3_COMPREHENSIVE_PROGRESS\n${progress}`);
    throw error;
  }
  results.push({ launcher: "substrate", role: "executor", result: comprehensiveResult });
  fs.writeFileSync(path.join(WORKSPACE, "src", "late-package-test.cjs"), "console.log('LATE_PACKAGE_TEST');\n");
  const mutatedPackage = JSON.parse(fs.readFileSync(path.join(WORKSPACE, "package.json"), "utf8"));
  mutatedPackage.scripts["test:late-mutation"] = "node src/late-package-test.cjs";
  fs.writeFileSync(path.join(WORKSPACE, "package.json"), JSON.stringify(mutatedPackage, null, 2));
  assert.equal(helper.classifyTest([path.join(WORKSPACE, "src", "late-package-test.cjs")], WORKSPACE, frozenAuthorization).eligible, false,
    "package mutation after the first worker must not enlarge frozen test authority");
  for (const spec of [roles[0], roles[2]]) results.push({ launcher: "substrate", role: spec.role, result: await launch("substrate", spec, false) });
  for (const spec of roles) results.push({ launcher: "legacy", role: spec.role, result: await launch("legacy", spec, false) });

  const noAckResult = await launch("substrate", { role: "eligible-no-ack", agentName: "coder", verifier: false }, false, { suppressAck: true });
  assert.equal(noAckResult.actionEvidence.entries[0]?.outcome, "succeeded",
    "genuinely eligible child must complete naturally when the host withholds alarm acknowledgment");
  delete process.env.PI_ORCHESTRATOR_TEST_SUPPRESS_ALARM_ACK;

  const samplerLossResult = await launch("substrate", { role: "sampler-loss", agentName: "coder", verifier: false }, false, { samplerLoss: true });
  assert.equal(samplerLossResult.actionEvidence.entries[0]?.outcome, "succeeded",
    "eligible child must complete naturally when the real external counter transport is lost after readiness");
  delete process.env.PI_ORCHESTRATOR_TEST_COUNTER_SAMPLER_EXIT_AFTER_READY;

  await assert.rejects(
    () => launch("substrate", { role: "missing-ready", agentName: "coder", verifier: false }, false, { suppressMonitor: true }),
    /NO_OUTPUT_MONITOR_NOT_LOADED/,
    "missing monitor attestation must be an explicit production refusal",
  );
  delete process.env.ITEM3_SUPPRESS_MONITOR;

  for (const launched of results) {
    const cancellation = launched.result.actionEvidence?.entries.find((entry) => entry.outcome === "cancelled_no_output");
    const cancellationDiagnostic = !cancellation && fs.existsSync(process.env.ITEM3_LAUNCH_RECORDS)
      ? readRecords().find((record) => record.launcher === launched.launcher && record.role === launched.role)?.toolResults?.map((item) => ({ id: item.toolCallId, observation: item.details?.noOutputObservation }))
      : undefined;
    assert.ok(cancellation, `${launched.launcher}/${launched.role} real dispatch must retain cancelled_no_output: ${JSON.stringify(cancellationDiagnostic)}`);
    assert.match(cancellation.noOutput?.partialLog ?? "", /HANGING_TEST_MARKER|BUSY_HANG_MARKER|POST_SUMMARY_MARKER/);
    assert.match(cancellation.noOutput?.summary ?? "", /Cancelled after .* minutes with no output/);
    assert.ok(cancellation.noOutput.alarmMonotonicMs < cancellation.noOutput.cancelledMonotonicMs);
    assert.ok(cancellation.noOutput.alarmAcknowledgedMonotonicMs >= cancellation.noOutput.alarmMonotonicMs);
    assert.ok(cancellation.noOutput.cancelledMonotonicMs - cancellation.noOutput.alarmAcknowledgedMonotonicMs >= 100,
      "positive lead must start only after supervisor acknowledgement");
    assert.equal(cancellation.noOutput.confirmationBasis, "terminal_signal_after_owned_handle_action",
      "kill acceptance alone must never be promoted to confirmed cancellation");
    assert.equal(cancellation.noOutput.terminalSignal, "SIGTERM");
    assert.equal(cancellation.noOutput.terminalExitCode, null);
    assert.doesNotMatch(cancellation.noOutput.partialLog, /NATURAL_FALLBACK_COMPLETION|split-secret/);
    assert.equal(launched.result.exitCode, 0, "one cancelled test command must not cancel its worker or run");
  }
  assert.ok(alarms.length >= results.length, "the real progress seam must surface an alarm before each cancellation");

  const records = readRecords();
  const productionRecords = records.filter((record) => !["missing-ready", "sampler-loss", "eligible-no-ack"].includes(record.role));
  const noAckRecord = records.find((record) => record.role === "eligible-no-ack");
  assert.ok(noAckRecord?.alarms?.some((alarm) => alarm.eligibility?.eligible === true),
    "no-ACK control must reach a real eligible alarm before natural completion");
  assert.match(noAckRecord?.toolResults[0]?.details?.noOutputObservation?.reason ?? "", /terminal outcome=succeeded/);
  const samplerLossRecord = records.find((record) => record.role === "sampler-loss");
  assertItem3InvocationBudget(noAckRecord?.toolResults[0]?.details?.telemetryAccounting, "eligible-no-ack");
  assertItem3InvocationBudget(samplerLossRecord?.toolResults[0]?.details?.telemetryAccounting, "sampler-loss");
  assert.match(samplerLossRecord?.toolResults[0]?.details?.noOutputObservation?.reason ?? "", /counter sampler|counter observation/i);
  const missingReadyRecord = records.find((record) => record.role === "missing-ready");
  assert.ok(missingReadyRecord, "missing-monitor mutation must settle through the bootstrap guard");
  assert.match(missingReadyRecord.toolResults[0]?.text ?? "", /NO_OUTPUT_MONITOR_NOT_READY/);
  assert.doesNotMatch(missingReadyRecord.toolResults[0]?.text ?? "", /HANGING_TEST_MARKER|NATURAL_FALLBACK_COMPLETION/,
    "no command may dispatch before mandatory monitor construction");
  assert.equal(productionRecords.length, 6);
  assert.equal(new Set(productionRecords.map((record) => record.testAuthorizationSha256)).size, 1,
    "both launchers and every role must reuse one frozen authorization snapshot after package mutation");
  for (const record of productionRecords) {
    assert.deepEqual(record.extensions, ["worker-monitor-bootstrap.ts", "worker-no-output-monitor.ts", "worker-execution-constraints.ts"]);
    assert.ok(record.toolResults.every((entry) => entry.details?.monitorIo || entry.details?.noOutput),
      `${record.launcher}/${record.role} every bash result must be produced by the constructed monitor`);
    for (const entry of record.toolResults) {
      assertItem3InvocationBudget(entry.details?.telemetryAccounting, `${record.launcher}/${record.role}/${entry.toolCallId}`);
      assertEveryItem3InvocationBudget(entry.details, `${record.launcher}/${record.role}/${entry.toolCallId}`);
    }
    const cancelledTool = record.toolResults.find((entry) => entry.details?.noOutput);
    if (cancelledTool) {
      assert.equal(cancelledTool.isError, true);
      assert.match(cancelledTool.text, /Cancelled after .* minutes with no output/);
      assert.match(cancelledTool.text, /HANGING_TEST_MARKER|BUSY_HANG_MARKER|POST_SUMMARY_MARKER/);
    }
  }

  const comprehensive = productionRecords.find((record) => record.launcher === "substrate" && record.role === "executor");
  const byId = new Map(comprehensive.toolResults.map((entry) => [entry.toolCallId, entry]));
  for (const toolResult of comprehensive.toolResults) {
    const io = toolResult.details?.monitorIo;
    assert.ok(io, `${toolResult.toolCallId} must expose bounded monitor-I/O diagnostics`);
    assert.ok(io.eventBytesRead <= io.eventFileBytes,
      `${toolResult.toolCallId} reread event bytes (${io.eventBytesRead} > ${io.eventFileBytes})`);
    assert.ok(io.maxBufferedEventBytes <= 256 * 1024,
      "event-line buffering is byte-bounded while admitting the reviewed escaped-output terminal frame");
    assert.ok(io.maxActualReadAndDeliveryBytesPerCycle <= 256 * 1024,
      `actual all-source read/delivery work exceeded the shared cycle: ${io.maxActualReadAndDeliveryBytesPerCycle}`);
    assertItem3InvocationBudget(toolResult.details?.telemetryAccounting, toolResult.toolCallId);
    assertEveryItem3InvocationBudget(toolResult.details, toolResult.toolCallId);
  }
  for (const id of ["silent-loop", "busy-silent", "post-summary", "trailing-noise", "artifact-tamper", "two-cancellations", "giant-secret", "junction-seal", "escaped-output", "oversize-artifact", "multibyte-output", "package-wrapper"]) {
    assert.equal(byId.get(id)?.details?.noOutput?.outcome, "cancelled_no_output",
      `${id}: ${JSON.stringify({ observation: byId.get(id)?.details?.noOutputObservation, io: byId.get(id)?.details?.monitorIo, metrics: byId.get(id)?.details?.observationMetrics, invocations: byId.get(id)?.details?.invocationTelemetry, owner: byId.get(id)?.details?.commandOwnerAccounting })}`);
  }
  assert.equal(byId.get("silent-loop")?.details?.noOutput?.invocationDescriptor?.counterBinding?.desiredAccess, 4096,
    "production cancellation evidence must bind the query-only retained Windows process handle");
  assert.match(byId.get("package-wrapper")?.text ?? "", /PACKAGE_WRAPPER_CONTINUED/,
    "actual npm wrapper must continue after its independently authorized absolute-Node child cancellation");
  assert.match(byId.get("package-wrapper")?.details?.noOutput?.partialLog ?? "", /HANGING_TEST_MARKER/);
  assert.match(byId.get("silent-loop")?.text ?? "", /LOOP_CONTINUED/,
    "a shell loop may eventually exit zero without erasing the earlier cancellation");
  assert.match(byId.get("silent-loop")?.details?.noOutput?.partialLog ?? "", /API_TOKEN=\[REDACTED\]/,
    "a credential split across output chunks must be redacted after reassembly");
  assert.doesNotMatch(byId.get("silent-loop")?.details?.noOutput?.partialLog ?? "", /split-secret/);
  for (const id of ["active-stderr", "ordinary-success"]) {
    assert.equal(byId.get(id)?.details?.noOutput, undefined, `${id} activity/success must not be cancelled`);
  }
  assert.equal(byId.get("ordinary-failure")?.isError, true, "ordinary nonzero bash behavior remains unchanged");
  assert.match(byId.get("capture-secret-success")?.text ?? "", /HOST_CAPTURE_NATURAL_COMPLETION/);
  assert.doesNotMatch(JSON.stringify(byId.get("capture-secret-success")?.details), /synthetic_host_capture_secret_789/,
    "host-managed post-settlement capture must redact before retaining successful terminal details");
  assert.match(JSON.stringify(byId.get("capture-secret-success")?.details?.declaredFileCapture), /HOST_CAPTURE_SAFE_MARKER/);
  for (const [id, marker] of [
    ["writev-cjs", "WRITEV_CJS_NATURAL_COMPLETION"],
    ["writev-esm", "WRITEV_ESM_NATURAL_COMPLETION"],
    ["counter-operations", "COUNTER_OPERATIONS_NATURAL_COMPLETION"],
    ["worker-thread-writer", "WORKER_THREAD_NATURAL_COMPLETION"],
    ["sync-busy-writer", "SYNC_BUSY_NATURAL_COMPLETION"],
    ["closed-observer-writer", "CLOSED_FD_NATURAL_COMPLETION"],
    ["same-size-writer", "SAME_SIZE_NATURAL_COMPLETION"],
    ["renamed-handle-writer", "RENAMED_HANDLE_NATURAL_COMPLETION"],
    ["argument-selected-writer", "ARGUMENT_WRITER_NATURAL_COMPLETION"],
    ["descendant-writer", "DESCENDANT_PARENT_NATURAL_COMPLETION"],
  ]) {
    assert.equal(byId.get(id)?.details?.noOutput, undefined, `${id} must not be cancelled while attributable writes/descendants remain active`);
    assert.match(byId.get(id)?.text ?? "", new RegExp(marker));
    if (!["descendant-writer", "closed-observer-writer"].includes(id)) assert.ok((byId.get(id)?.details?.observationMetrics?.processCounterActivity ?? 0) > 0,
      `${id} must demonstrate positive external process-counter activity`);
    if (!["descendant-writer", "closed-observer-writer"].includes(id)) assert.ok((byId.get(id)?.details?.observationMetrics?.queryOnlyBindings ?? 0) > 0,
      `${id} must prove production query-only counter binding`);
  }
  assert.ok(fs.readFileSync(path.join(WORKSPACE, "logs", "sync-busy.log"), "utf8").trim().split(/\r?\n/).length >= 20,
    "busy synchronous writer must complete with continuing attributed writes rather than cancellation");
  assert.match(fs.readFileSync(path.join(WORKSPACE, "logs", "closed-observer.log"), "utf8"), /CLOSED_FD_ACTIVITY_8/);
  assert.ok((byId.get("counter-operations")?.details?.observationMetrics?.counterUncertainty ?? 0) > 0,
    "truncate/rename other-I/O counter growth must veto cancellation without being reported as known output");
  assert.match(byId.get("closed-observer-writer")?.details?.noOutputObservation?.reason ?? "", /channel closed/i,
    "lost observation channel must visibly and permanently downgrade cancellation");
  const descendantReason = byId.get("descendant-writer")?.details?.noOutputObservation?.reason ?? "";
  assert.match(descendantReason, /descendant/i,
    `parent counters must visibly downgrade when an output-producing descendant is possible: ${descendantReason}`);
  assert.match(byId.get("path-edit")?.text ?? "", /item3-path-suffix/,
    "shell PATH edits must survive the command-scoped shim");
  assert.match(byId.get("node-options-once")?.text ?? "", /PRELOAD_TARGET_COMPLETE/);
  assert.equal(fs.readFileSync(process.env.ITEM3_PRELOAD_COUNT_FILE, "utf8"), "1",
    "user NODE_OPTIONS preload must execute exactly once in the test and never in the helper");
  assert.match(byId.get("cwd-semantics")?.text ?? "", /SUB_CWD_SCRIPT/);
  assert.doesNotMatch(byId.get("cwd-semantics")?.text ?? "", /ROOT_CWD_SCRIPT/);
  assert.match(byId.get("command-prefix")?.text ?? "", /ORDINARY_SUCCESS/);
  assert.match(byId.get("exec-prefix")?.text ?? "", /ORDINARY_SUCCESS/);
  assert.match(byId.get("stdin-pipe")?.text ?? "", /STDIN=PIPE_INPUT/);
  assert.match(byId.get("heredoc-stdin")?.text ?? "", /HEREDOC_INPUT_OK/);
  assert.doesNotMatch(byId.get("heredoc-stdin")?.text ?? "", /not-a-command/);
  assert.match(byId.get("session-context")?.text ?? "", /SESSION_CTX=(?!MISSING)/,
    "monitored bash must retain Pi's synthetic session environment");
  assert.equal(byId.get("ordinary-failure")?.details?.noOutput, undefined);
  assert.equal(byId.get("unsupported-absolute")?.details?.noOutputObservation?.mode, "observe_only");
  assert.equal(byId.get("undeclared-file-writer")?.details?.noOutput, undefined,
    "a child with incomplete output attribution must never be cancelled");
  assert.match(byId.get("undeclared-file-writer")?.text ?? "", /UNDECLARED_NATURAL_COMPLETION/);
  assert.ok((byId.get("undeclared-file-writer")?.details?.observationMetrics?.processCounterActivity ?? 0) > 0,
    "undeclared-file-only activity must be observed by process-wide counters without inventing a filename");
  assert.match(fs.readFileSync(path.join(WORKSPACE, "logs", "undeclared.log"), "utf8"), /UNDECLARED_ACTIVITY_8/);
  assert.match(byId.get("trailing-noise")?.details?.noOutput?.cancellations?.[0]?.partialLog ?? byId.get("trailing-noise")?.details?.noOutput?.partialLog ?? "", /HANGING_TEST_MARKER/,
    "later shell output must not erase the cancelled invocation's sealed marker");
  assert.equal(byId.get("artifact-tamper")?.details?.noOutput?.outcome, "cancelled_no_output");
  assert.match(byId.get("artifact-tamper")?.details?.noOutput?.partialLog ?? "", /OVERSIZE_ARTIFACT_TAIL_MARKER/,
    "later artifact tampering must not alter the authenticated terminal classification/log");
  assert.equal(byId.get("two-cancellations")?.details?.noOutput?.cancellations?.length, 2,
    "one bash invocation must retain both cancellation records");
  assert.doesNotMatch(JSON.stringify(byId.get("giant-secret")?.details?.noOutput), /x{256}/,
    "redaction must happen before bounded retention of a giant credential");
  assert.equal(byId.get("escaped-output")?.details?.noOutput?.outcome, "cancelled_no_output");
  assert.ok(byId.get("escaped-output")?.details?.noOutput?.artifactBytes > 96 * 1024,
    "escaped artifact repro must exceed the old loader ceiling");
  assert.equal(byId.get("oversize-artifact")?.details?.noOutput?.outcome, "cancelled_no_output",
    "artifact oversize/read failure must not erase confirmed cancellation classification");
  assert.equal(byId.get("oversize-artifact")?.details?.noOutput?.artifactIntegrity, "verified",
    "serialized-byte fitting must keep the canonical cancellation artifact loadable instead of relying on the old oversize failure");
  const oversizePartial = byId.get("oversize-artifact")?.details?.noOutput?.partialLog ?? "";
  assert.match(oversizePartial, /OVERSIZE_ARTIFACT_TAIL_MARKER/,
    `authenticated fitted evidence must retain a useful tail: bytes=${Buffer.byteLength(oversizePartial, "utf8")} tail=${JSON.stringify(oversizePartial.slice(-200))}`);
  assert.match(JSON.stringify(byId.get("multibyte-output")?.details?.noOutput), /MULTIBYTE_.*認証_MARKER/,
    "streaming UTF-8 decoding must preserve authenticated split-multibyte cancellation evidence");
  assert.equal(byId.get("leaf-link-output")?.details?.noOutput, undefined,
    "counter-observed leaf-link writer must remain active without unsafe content capture");
  assert.match(byId.get("leaf-link-output")?.text ?? "", /LEAF_LINK_NATURAL_COMPLETION/);
  assert.doesNotMatch(JSON.stringify(byId.get("leaf-link-output")?.details), /OUTSIDE_LEAF_MARKER/);
  const leafCapture = byId.get("leaf-link-output")?.details?.declaredFileCapture?.find((entry) => String(entry.path).endsWith("leaf-link.log"));
  assert.equal(leafCapture?.status, "unavailable");
  assert.equal(leafCapture?.historicalContent, "not_retained_during_execution");
  assert.doesNotMatch(JSON.stringify(byId.get("junction-seal")?.details?.noOutput), /OUTSIDE_APPROVED_ROOT_MARKER/,
    "sealed cancellation evidence must never follow a later junction outside the approved root");
  assert.match(byId.get("unsupported-absolute")?.text ?? "", /UNSUPPORTED_NATURAL_COMPLETION/,
    "unsupported identity is observed and allowed to settle naturally");
  assert.equal(byId.get("unexecuted-branch-observe-only")?.details?.noOutputObservation?.mode, "observe_only");
  assert.ok(alarms.some((entry) => entry.includes("unexecuted-branch-observe-only")),
    "an unexecuted node branch must not disable the fallback observe-only alarm");
  assert.match(fs.readFileSync(path.join(WORKSPACE, "logs", "activity.log"), "utf8"), /FILE_ACTIVITY_8/,
    "exact declared output-file activity must keep the eligible test alive");
  const replacementLog = fs.readFileSync(path.join(WORKSPACE, "logs", "replace.log"), "utf8");
  const replacementDiagnostics = (byId.get("silent-loop")?.details?.noOutput?.cancellations ?? [])
    .map((entry) => ({ sources: entry.observedSources, errors: entry.observationErrors, summary: entry.summary }));
  assert.match(replacementLog, /REPLACED_FILE_ACTIVITY_8/,
    `validated regular-file replacement must count as activity rather than size-growth only: ${replacementLog.trim()} ${JSON.stringify(replacementDiagnostics)}`);
  const replacementCapture = byId.get("silent-loop")?.details?.declaredFileCapture?.find((entry) => String(entry.path).endsWith("replace.log"));
  assert.ok(["captured", "truncated"].includes(replacementCapture?.status));
  assert.match(`${replacementCapture?.head ?? ""}${replacementCapture?.tail ?? ""}`, /REPLACED_FILE_ACTIVITY_8/);
  assert.equal(replacementCapture?.historicalContent, "not_retained_during_execution");
  const renamedCapture = byId.get("renamed-handle-writer")?.details?.declaredFileCapture?.find((entry) => String(entry.path).endsWith("open-handle.log"));
  assert.equal(renamedCapture?.status, "missing", "renamed old-object bytes must be reported unavailable rather than inferred from another pathname");

  assert.ok(comprehensiveResult.actionEvidence.cancellationJournals.length >= 1);
  const hostJournal = comprehensiveResult.actionEvidence.cancellationJournals[0];
  assert.ok(hostJournal.count >= 10, "host must journal every confirmed cancellation update before later worker turns");
  const hostJournalText = fs.readFileSync(hostJournal.path, "utf8");
  assert.match(hostJournalText, /HANGING_TEST_MARKER|MULTIBYTE/);
  assert.doesNotMatch(hostJournalText, /split-secret|x{256}/);

  const output = {
    taskId: "task-1", description: "item3 fixture", agentName: "coder",
    output: comprehensiveResult.text, exitCode: 0, durationMs: comprehensiveResult.durationMs,
    actionEvidence: comprehensiveResult.actionEvidence, filesChanged: 0, changedFiles: [],
  };
  const intake = fixtureIntake();
  const plan = { tasks: [{ id: "task-1", description: "item3 fixture", dependsOn: [] }], notes: "fixture" };
  const classic = orchestrator.buildVerificationPrompt(intake, plan, [output], "fixture routes");
  const visible = orchestrator.buildVisibleMainVerificationPrompt(intake, {
    originalTask: intake.originalTask,
    acceptanceCriteria: [{ id: "AC-01", text: intake.successCriteria[0], required: true }],
  }, plan, [output]);
  for (const prompt of [classic, visible]) {
    assert.match(prompt, /cancelled_no_output/);
    assert.match(prompt, /"partialLog"\s*:\s*"[^"]*(?:HANGING_TEST_MARKER|BUSY_HANG_MARKER|POST_SUMMARY_MARKER)/,
      "the verifier prompt must carry the marker inside authoritative partial-log evidence");
    assert.match(prompt, /Cancelled after .* minutes with no output/);
    assert.doesNotMatch(prompt, /split-secret/);
    assert.match(prompt, /The command completed normally and no cancellation occurred/,
      "contradictory worker prose remains visible but cannot overwrite host authority");
  }

  console.log("PASS item3 no-output policy + actual planner/executor/verifier dispatch + evidence propagation");
}

let mainSucceeded = false;
main().then(() => {
  mainSucceeded = true;
}).catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
}).finally(() => {
  if (mainSucceeded && (process.exitCode === undefined || process.exitCode === 0)) {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  } else {
    console.error(`ITEM3_FAILURE_ROOT=${TEMP_ROOT}`);
  }
});
