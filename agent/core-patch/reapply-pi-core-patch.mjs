#!/usr/bin/env node
/**
 * reapply-pi-core-patch.mjs
 * -------------------------
 * Durable, USER-INVOKED patcher that reapplies the local `pi.executeCommand`
 * core patch to the installed Pi package's `dist/` files after a Pi npm update
 * overwrites them.
 *
 * Why this exists
 * ---------------
 * Pi extensions have no public API for a tool/event-handler to dispatch a
 * registered slash command (see agent/extensions/agent-reload/UPSTREAM_REQUEST.md,
 * https://github.com/earendil-works/pi/issues/6010). As an interim workaround,
 * three installed Pi `dist/` files are patched to expose
 * `pi.executeCommand(name, args?)` on the ExtensionAPI. This SINGLE core
 * patch enables BOTH of the following autonomous agent bridges:
 *
 *   - agent_reload_runtime  (agent/extensions/agent-reload)
 *   - agent_new_session     (agent/extensions/agent-new-session)
 *
 * Each extension probes for `pi.executeCommand` at init. If the patch is
 * present, the deferred idle-poll bridge activates; if absent, the tool
 * returns a clear error about the missing API (no silent failure):
 *
 *   - dist/core/extensions/loader.js  (runtime stub + api delegate)
 *   - dist/core/extensions/runner.js  (runtime binding / command dispatch)
 *   - dist/core/extensions/types.d.ts (type declarations)
 *
 * Those edits live inside the npm install tree, so every
 * `npm update -g @earendil-works/pi-coding-agent` silently reverts them. This
 * script lives OUTSIDE the npm tree (under agent/) so it survives updates and
 * can reapply the patch on demand.
 *
 * Design rules (from intake RUN_20260623-173339)
 * ----------------------------------------------
 *   - User-invoked ONLY. Importing this module never patches anything.
 *   - Idempotent: check/apply/verify are safe to run repeatedly.
 *   - Backups before write + rollback guidance.
 *   - Safe failure: if an expected anchor is missing (Pi source drifted),
 *     the patcher STOPS and reports instead of corrupting files.
 *   - NO silent auto-patching, NO live reload, NO restart.
 *   - NEVER uses `pi.sendUserMessage('/command')` as a command bridge
 *     (that path does not dispatch commands — see UPSTREAM_REQUEST.md §2).
 *
 * Prior patch evidence
 * --------------------
 *   - agent/nenflow-v3/runs/RUN_20260620-194054/CORE_PATCH.diff
 *   - agent/nenflow-v3/runs/RUN_20260623-160406/RELOAD_FIX_NOTES.md
 *   - agent/extensions/agent-reload/UPSTREAM_REQUEST.md
 *   - agent/skills/agent-new-session/SKILL.md
 *   - agent/extensions/agent-new-session/index.ts
 *   - agent/nenflow-v3/runs/RUN_20260623-192852/ATT_0_INTAKE.md
 *
 * Usage
 * -----
 *   node agent/core-patch/reapply-pi-core-patch.mjs check
 *   node agent/core-patch/reapply-pi-core-patch.mjs apply
 *   node agent/core-patch/reapply-pi-core-patch.mjs verify
 *   node agent/core-patch/reapply-pi-core-patch.mjs status
 *   node agent/core-patch/reapply-pi-core-patch.mjs rollback            # latest backup
 *   node agent/core-patch/reapply-pi-core-patch.mjs rollback <backupDir>
 *   node agent/core-patch/reapply-pi-core-patch.mjs list-backups
 *
 * Exit codes
 * ----------
 *   0  command succeeded (check reports fully-patched, apply/verify ok, rollback ok)
 *   1  check reports NOT fully patched (action needed) — expected after a Pi update
 *   2  unmatched target / safe failure (anchor drift) — manual adaptation required
 *   3  bad usage / arguments
 *
 * After a successful `apply`, the RUNNING Pi process will NOT pick up the new
 * API until the user manually runs `/reload` (or `/agent-reload-runtime`) or
 * restarts Pi. This script deliberately does NOT trigger a reload.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Layout -----------------------------------------------------------------

// Backups live next to this script so they survive Pi npm updates too.
const BACKUP_ROOT = path.join(__dirname, "backups");
const PATCH_MARKER_FILE = path.join(__dirname, "patch-manifest.json");

// --- Patch definitions ------------------------------------------------------
//
// Each patch targets one installed Pi dist file. Each patch has one or more
// EDITS. An EDIT is:
//   - find:     EXACT, uniquely-occurring anchor text in the unpatched file.
//   - replace:  text that replaces `find` (normally `find` + inserted code).
//   - sentinel: a substring of `replace` (the inserted code) used to detect
//               whether this edit is already applied (idempotency).
//   - desc:     human-readable description.
//
// Safe-failure rule: if `sentinel` is absent AND `find` is absent, the target
// has drifted from the expected pattern -> STOP (unmatched), do not write.

const EXECUTE_COMMAND_RUNNER_BODY = [
  "        this.runtime.executeCommand = async (name, args = \"\") => {",
  "            this.assertActive();",
  "            const commandName = name.startsWith(\"/\") ? name.slice(1) : name;",
  "            if (!commandName) throw new Error(\"Command name is required\");",
  "            const command = this.getCommand(commandName);",
  "            if (!command) throw new Error(\"Unknown command: /\" + commandName);",
  "            const ctx = this.createCommandContext();",
  "            try {",
  "                await command.handler(args ?? \"\", ctx);",
  "            }",
  "            catch (err) {",
  "                this.emitError({",
  "                    extensionPath: `command:${commandName}`,",
  "                    event: \"command\",",
  "                    error: err instanceof Error ? err.message : String(err),",
  "                    stack: err instanceof Error ? err.stack : undefined,",
  "                });",
  "                throw err;",
  "            }",
  "        };",
].join("\n");

const PATCHES = [
  {
    file: "dist/core/extensions/loader.js",
    edits: [
      {
        desc: "loader.js: add executeCommand runtime stub",
        find: [
          "        getCommands: notInitialized,",
          "        setModel: () => Promise.reject(new Error(\"Extension runtime not initialized\")),",
        ].join("\n"),
        replace: [
          "        getCommands: notInitialized,",
          "        executeCommand: notInitialized,",
          "        setModel: () => Promise.reject(new Error(\"Extension runtime not initialized\")),",
        ].join("\n"),
        sentinel: "        executeCommand: notInitialized,",
      },
      {
        desc: "loader.js: add pi.executeCommand API delegate",
        find: [
          "        getCommands() {",
          "            runtime.assertActive();",
          "            return runtime.getCommands();",
          "        },",
          "        setModel(model) {",
        ].join("\n"),
        replace: [
          "        getCommands() {",
          "            runtime.assertActive();",
          "            return runtime.getCommands();",
          "        },",
          "        executeCommand(name, args) {",
          "            runtime.assertActive();",
          "            return runtime.executeCommand(name, args);",
          "        },",
          "        setModel(model) {",
        ].join("\n"),
        sentinel:
          "        executeCommand(name, args) {\n            runtime.assertActive();\n            return runtime.executeCommand(name, args);",
      },
    ],
  },
  {
    file: "dist/core/extensions/runner.js",
    edits: [
      {
        desc: "runner.js: bind runtime.executeCommand command dispatch",
        find: [
          "        this.runtime.getCommands = actions.getCommands;",
          "        this.runtime.setModel = actions.setModel;",
        ].join("\n"),
        replace: [
          "        this.runtime.getCommands = actions.getCommands;",
          EXECUTE_COMMAND_RUNNER_BODY,
          "        this.runtime.setModel = actions.setModel;",
        ].join("\n"),
        sentinel: "this.runtime.executeCommand = async (name, args = \"\") => {",
      },
    ],
  },
  {
    file: "dist/core/extensions/types.d.ts",
    edits: [
      {
        desc: "types.d.ts: add executeCommand to ExtensionAPI",
        find: [
          "    getCommands(): SlashCommandInfo[];",
          "    /** Set the current model. Returns false if no API key available. */",
          "    setModel(model: Model<any>): Promise<boolean>;",
        ].join("\n"),
        replace: [
          "    getCommands(): SlashCommandInfo[];",
          "    /** Execute a registered extension command by name using command-handler context. */",
          "    executeCommand(name: string, args?: string): Promise<void>;",
          "    /** Set the current model. Returns false if no API key available. */",
          "    setModel(model: Model<any>): Promise<boolean>;",
        ].join("\n"),
        sentinel: "    executeCommand(name: string, args?: string): Promise<void>;",
      },
      {
        desc: "types.d.ts: export ExecuteCommandHandler type",
        find: [
          "export type SendUserMessageHandler = (content: string | (TextContent | ImageContent)[], options?: {",
          "    deliverAs?: \"steer\" | \"followUp\";",
          "}) => void;",
        ].join("\n"),
        replace: [
          "export type SendUserMessageHandler = (content: string | (TextContent | ImageContent)[], options?: {",
          "    deliverAs?: \"steer\" | \"followUp\";",
          "}) => void;",
          "export type ExecuteCommandHandler = (name: string, args?: string) => Promise<void>;",
        ].join("\n"),
        sentinel:
          "export type ExecuteCommandHandler = (name: string, args?: string) => Promise<void>;",
      },
      {
        desc: "types.d.ts: add executeCommand to ExtensionRuntime",
        find: "export interface ExtensionRuntime extends ExtensionRuntimeState, ExtensionActions {\n}",
        replace:
          "export interface ExtensionRuntime extends ExtensionRuntimeState, ExtensionActions {\n    executeCommand: ExecuteCommandHandler;\n}",
        sentinel: "    executeCommand: ExecuteCommandHandler;",
      },
    ],
  },

  // --- Windows terminal flash remediation patches (Opus 4.8 plan) ----------
  // These add windowsHide: true to Node.js child_process calls that trigger
  // a flash/shimmer on Windows when the console window appears briefly.
  // Applied to installed Pi dist/ files that don't already set windowsHide.
  // bash.js already has windowsHide:true (createLocalBashOperations), so it
  // is intentionally NOT patched here.
  {
    file: "dist/core/footer-data-provider.js",
    edits: [
      {
        desc: "footer-data-provider.js: add windowsHide:true to git spawnSync",
        find: [
          "        cwd: repoDir,",
          '        encoding: "utf8",',
          '        stdio: ["ignore", "pipe", "ignore"],',
        ].join("\n"),
        replace: [
          "        cwd: repoDir,",
          '        encoding: "utf8",',
          '        stdio: ["ignore", "pipe", "ignore"],',
          "        windowsHide: true,",
        ].join("\n"),
        sentinel: '        stdio: ["ignore", "pipe", "ignore"],\n        windowsHide: true,',
      },
      {
        desc: "footer-data-provider.js: add windowsHide:true to git execFile",
        find: [
          "            cwd: repoDir,",
          '            encoding: "utf8",',
        ].join("\n"),
        replace: [
          "            cwd: repoDir,",
          '            encoding: "utf8",',
          "            windowsHide: true,",
        ].join("\n"),
        sentinel: '            encoding: "utf8",\n            windowsHide: true,',
      },
    ],
  },
  {
    file: "dist/core/tools/find.js",
    edits: [
      {
        desc: "find.js: add windowsHide:true to fd spawn",
        find: '                        const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });',
        replace: '                        const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });',
        sentinel: 'spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })',
      },
    ],
  },
  {
    file: "dist/core/tools/grep.js",
    edits: [
      {
        desc: "grep.js: add windowsHide:true to rg spawn",
        find: '                        const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });',
        replace: '                        const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });',
        sentinel: 'spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })',
      },
    ],
  },
  {
    file: "dist/core/exec.js",
    edits: [
      {
        desc: "exec.js: add windowsHide:true to spawn options",
        find: [
          "            cwd,",
          "            shell: false,",
          '            stdio: ["ignore", "pipe", "pipe"],',
        ].join("\n"),
        replace: [
          "            cwd,",
          "            shell: false,",
          '            stdio: ["ignore", "pipe", "pipe"],',
          "            windowsHide: true,",
        ].join("\n"),
        sentinel: '            windowsHide: true,',
      },
    ],
  },
];

// --- Pi install resolution --------------------------------------------------

/**
 * Resolve the installed Pi package root directory robustly.
 * Tries, in order:
 *   1. PI_CORE_ROOT env var (user override; must point at package root)
 *   2. require.resolve of the package's package.json (works for global + local)
 *   3. Well-known Windows global npm path
 *   4. npm root -g based lookup
 * Returns the absolute package root, or throws if not found.
 */
function resolvePiRoot() {
  // 1. explicit override
  if (process.env.PI_CORE_ROOT) {
    const p = path.resolve(process.env.PI_CORE_ROOT);
    if (fs.existsSync(path.join(p, "package.json")) &&
        fs.existsSync(path.join(p, "dist", "core", "extensions"))) {
      return p;
    }
    throw new Error(`PI_CORE_ROOT set to "${p}" but does not look like the Pi package root.`);
  }

  // 2. require.resolve (covers both global and local installs)
  try {
    const pkgJsonPath = require.resolve(
      "@earendil-works/pi-coding-agent/package.json"
    );
    const root = path.dirname(pkgJsonPath);
    if (fs.existsSync(path.join(root, "dist", "core", "extensions"))) {
      return root;
    }
  } catch (_) {
    // fall through (package not resolvable from here)
  }

  // 3. well-known Windows global npm path
  const candidates = [
    path.join(
      process.env.APPDATA || path.join(process.env.HOME || "", "AppData", "Roaming"),
      "npm", "node_modules", "@earendil-works", "pi-coding-agent"
    ),
    path.join(
      process.env.HOME || "",
      ".npm-global", "lib", "node_modules", "@earendil-works", "pi-coding-agent"
    ),
    path.join("/usr/local/lib/node_modules/@earendil-works/pi-coding-agent"),
    path.join("/usr/lib/node_modules/@earendil-works/pi-coding-agent"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "package.json")) &&
        fs.existsSync(path.join(c, "dist", "core", "extensions"))) {
      return c;
    }
  }

  // 4. npm root -g
  try {
    const globalRoot = execFileSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["root", "-g"],
      { encoding: "utf8" }
    ).trim();
    const p = path.join(globalRoot, "@earendil-works", "pi-coding-agent");
    if (fs.existsSync(path.join(p, "package.json")) &&
        fs.existsSync(path.join(p, "dist", "core", "extensions"))) {
      return p;
    }
  } catch (_) {
    // fall through
  }

  throw new Error(
    "Could not locate the installed @earendil-works/pi-coding-agent package. " +
    "Set PI_CORE_ROOT to its package root directory and retry."
  );
}

function readPiVersion(piRoot) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(piRoot, "package.json"), "utf8")
    );
    return pkg.version || "unknown";
  } catch (_) {
    return "unknown";
  }
}

// --- Patch state inspection -------------------------------------------------

/**
 * Evaluate the state of every edit across every patch.
 * Returns an array of result objects:
 *   { file, relFile, desc, state, detail }
 *   state ∈ "applied" | "needed" | "unmatched"
 *
 *   applied   -> sentinel already present (edit done)
 *   needed    -> sentinel absent but anchor present (can apply safely)
 *   unmatched -> sentinel absent AND anchor absent (drift; safe failure)
 */
function evaluate(piRoot) {
  const results = [];
  for (const patch of PATCHES) {
    const absFile = path.join(piRoot, patch.file);
    let content = null;
    let fileExists = false;
    try {
      content = fs.readFileSync(absFile, "utf8");
      fileExists = true;
    } catch (_) {
      fileExists = false;
    }
    for (const edit of patch.edits) {
      if (!fileExists) {
        results.push({
          file: absFile, relFile: patch.file, desc: edit.desc,
          state: "unmatched", detail: "target file missing",
        });
        continue;
      }
      const hasSentinel = content.includes(edit.sentinel);
      const hasAnchor = content.includes(edit.find);
      let state, detail;
      if (hasSentinel) {
        state = "applied";
        detail = "sentinel present";
      } else if (hasAnchor) {
        state = "needed";
        detail = "anchor present, sentinel absent";
      } else {
        state = "unmatched";
        detail = "anchor AND sentinel both absent (Pi source drifted)";
      }
      results.push({
        file: absFile, relFile: patch.file, desc: edit.desc,
        state, detail,
      });
    }
  }
  return results;
}

function summarize(results) {
  const applied = results.filter((r) => r.state === "applied").length;
  const needed = results.filter((r) => r.state === "needed").length;
  const unmatched = results.filter((r) => r.state === "unmatched").length;
  const total = results.length;
  return { applied, needed, unmatched, total };
}

// --- Backups ----------------------------------------------------------------

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function listBackups() {
  if (!fs.existsSync(BACKUP_ROOT)) return [];
  return fs
    .readdirSync(BACKUP_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function latestBackup() {
  const all = listBackups();
  return all.length ? all[all.length - 1] : null;
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(PATCH_MARKER_FILE, "utf8"));
  } catch (_) {
    return { appliedTo: [], backups: [] };
  }
}

function writeManifest(manifest) {
  manifest.backups = listBackups();
  fs.writeFileSync(PATCH_MARKER_FILE, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

// --- Commands ---------------------------------------------------------------

function cmdCheck() {
  const piRoot = resolvePiRoot();
  const version = readPiVersion(piRoot);
  const results = evaluate(piRoot);
  const s = summarize(results);

  console.log(`Pi core patch check`);
  console.log(`  pi root:    ${piRoot}`);
  console.log(`  pi version: ${version}`);
  console.log(`  edits:      ${s.applied}/${s.total} applied, ${s.needed} needed, ${s.unmatched} unmatched\n`);
  for (const r of results) {
    const tag =
      r.state === "applied" ? "[applied]  " :
      r.state === "needed"  ? "[needed]   " :
                              "[UNMATCHED]";
    console.log(`  ${tag} ${r.relFile} :: ${r.desc}  (${r.detail})`);
  }

  if (s.unmatched > 0) {
    console.log("\nSAFE FAILURE: one or more patch anchors were not found. The Pi");
    console.log("source has drifted from the known patch shape. Do NOT apply.");
    console.log("Re-derive the patch against the new source (see CORE_PATCH.diff).");
    return 2;
  }
  if (s.needed > 0) {
    console.log("\nResult: NOT fully patched. Run `apply` to reapply the patch.");
    return 1;
  }
  console.log("\nResult: fully patched. No action needed.");
  return 0;
}

function cmdApply() {
  const piRoot = resolvePiRoot();
  const version = readPiVersion(piRoot);
  const results = evaluate(piRoot);
  const s = summarize(results);

  console.log(`Pi core patch apply`);
  console.log(`  pi root:    ${piRoot}`);
  console.log(`  pi version: ${version}\n`);

  if (s.unmatched > 0) {
    for (const r of results.filter((x) => x.state === "unmatched")) {
      console.log(`  [UNMATCHED] ${r.relFile} :: ${r.desc}  (${r.detail})`);
    }
    console.log("\nSAFE FAILURE: refusing to apply because at least one anchor is missing.");
    console.log("No files were modified. Adapt the patch to the new Pi source first.");
    return 2;
  }

  if (s.needed === 0) {
    console.log("All edits already applied. Nothing to do (idempotent).");
    writeManifest({ ...readManifest(), appliedTo: [{ piRoot, version, at: new Date().toISOString() }] });
    return 0;
  }

  // --- Backup before write ---
  // We back up the full current content of every target file (even edits that
  // are already applied) so rollback restores the exact pre-apply state.
  const ts = timestamp();
  const backupDir = path.join(BACKUP_ROOT, ts);
  fs.mkdirSync(backupDir, { recursive: true });
  const backedFiles = [];
  for (const patch of PATCHES) {
    const absFile = path.join(piRoot, patch.file);
    const dest = path.join(backupDir, patch.file.replace(/[\\/]/g, "__"));
    fs.copyFileSync(absFile, dest);
    backedFiles.push({ rel: patch.file, backup: dest });
  }
  // also snapshot the version
  fs.writeFileSync(
    path.join(backupDir, "VERSION.txt"),
    `pi-coding-agent ${version}\nroot: ${piRoot}\nbackup created: ${new Date().toISOString()}\n`,
    "utf8"
  );
  console.log(`Backed up ${backedFiles.length} target file(s) to:\n  ${backupDir}\n`);

  // --- Apply edits ---
  let appliedNow = 0;
  let skippedAlready = 0;
  for (const patch of PATCHES) {
    const absFile = path.join(piRoot, patch.file);
    let content = fs.readFileSync(absFile, "utf8");
    for (const edit of patch.edits) {
      if (content.includes(edit.sentinel)) {
        skippedAlready++;
        continue; // idempotent: already applied
      }
      if (!content.includes(edit.find)) {
        // Should not happen (evaluate would have flagged unmatched), but guard anyway.
        console.log(`  [UNMATCHED] ${patch.file} :: ${edit.desc}`);
        console.log("\nSAFE FAILURE: anchor vanished mid-apply. No further writes.");
        console.log(`Restore from backup: ${backupDir}`);
        return 2;
      }
      const count = content.split(edit.find).length - 1;
      if (count !== 1) {
        console.log(`  [UNMATCHED] ${patch.file} :: ${edit.desc} (anchor not unique: ${count} occurrences)`);
        console.log("\nSAFE FAILURE: anchor is not unique. Aborting before write.");
        console.log(`Restore from backup: ${backupDir}`);
        return 2;
      }
      content = content.replace(edit.find, edit.replace);
      appliedNow++;
      console.log(`  [applied]  ${patch.file} :: ${edit.desc}`);
    }
    fs.writeFileSync(absFile, content, "utf8");
  }

  console.log(`\nApplied ${appliedNow} edit(s); ${skippedAlready} already applied (skipped).`);
  writeManifest({ appliedTo: [{ piRoot, version, at: new Date().toISOString() }] });

  // --- Post-apply verify ---
  const post = evaluate(piRoot);
  const ps = summarize(post);
  console.log(`\nPost-apply verify: ${ps.applied}/${ps.total} applied, ${ps.needed} needed, ${ps.unmatched} unmatched.`);
  if (ps.needed > 0 || ps.unmatched > 0) {
    console.log("WARNING: post-apply state is not fully patched. Inspect manually.");
    console.log(`Backup for rollback: ${backupDir}`);
    return 2;
  }
  console.log("\nPatch applied successfully and verified statically.");
  console.log("IMPORTANT: the running Pi process still uses the OLD (unpatched) code.");
  console.log("To load the patched core, the user must manually run:");
  console.log("    /reload");
  console.log("  (or /agent-reload-runtime, or restart Pi).");
  console.log("After reload, both agent_reload_runtime AND agent_new_session work");
  console.log("through the same pi.executeCommand core bridge.");
  console.log("This script did NOT trigger a reload.");
  return 0;
}

function cmdVerify() {
  const piRoot = resolvePiRoot();
  const version = readPiVersion(piRoot);
  const results = evaluate(piRoot);
  const s = summarize(results);

  console.log(`Pi core patch verify (static only)`);
  console.log(`  pi root:    ${piRoot}`);
  console.log(`  pi version: ${version}\n`);
  for (const r of results) {
    const tag = r.state === "applied" ? "[ok]       " :
                r.state === "needed"  ? "[MISSING]  " :
                                        "[UNMATCHED]";
    console.log(`  ${tag} ${r.relFile} :: ${r.desc}  (${r.detail})`);
  }

  // Additional static structural checks: confirm the patched executeCommand
  // code references exist where we expect them.
  const structural = [];
  const loader = safeRead(path.join(piRoot, "dist/core/extensions/loader.js"));
  const runner = safeRead(path.join(piRoot, "dist/core/extensions/runner.js"));
  const types = safeRead(path.join(piRoot, "dist/core/extensions/types.d.ts"));
  structural.push(["loader.js  has pi.executeCommand delegate", loader && loader.includes("return runtime.executeCommand(name, args);")]);
  structural.push(["runner.js  has command dispatch body", runner && runner.includes("this.runtime.executeCommand = async (name, args = \"\") => {")]);
  structural.push(["runner.js  resolves command via getCommand", runner && runner.includes("this.getCommand(commandName)")]);
  structural.push(["types.d.ts declares ExtensionAPI.executeCommand", types && types.includes("executeCommand(name: string, args?: string): Promise<void>;")]);
  structural.push(["types.d.ts exports ExecuteCommandHandler", types && types.includes("export type ExecuteCommandHandler = (name: string, args?: string) => Promise<void>;")]);
  structural.push(["types.d.ts ExtensionRuntime member", types && types.includes("executeCommand: ExecuteCommandHandler;")]);

  console.log("\nStructural checks:");
  let structOk = true;
  for (const [name, ok] of structural) {
    console.log(`  ${ok ? "[ok]   " : "[FAIL] "} ${name}`);
    if (!ok) structOk = false;
  }

  if (s.unmatched > 0) return 2;
  if (s.needed > 0 || !structOk) {
    console.log("\nVerify result: NOT fully patched / structural checks failed.");
    return 1;
  }
  console.log("\nVerify result: PASS — patch is present and structurally consistent.");
  console.log("NOTE: this is a static check only. No live reload was performed.");
  return 0;
}

function cmdStatus() {
  const piRoot = resolvePiRoot();
  const version = readPiVersion(piRoot);
  const results = evaluate(piRoot);
  const s = summarize(results);
  const manifest = readManifest();
  const backups = listBackups();

  console.log(`Pi core patch status`);
  console.log(`  pi root:    ${piRoot}`);
  console.log(`  pi version: ${version}`);
  console.log(`  edits:      ${s.applied}/${s.total} applied, ${s.needed} needed, ${s.unmatched} unmatched`);
  console.log(`  manifest:   ${PATCH_MARKER_FILE}`);
  if (manifest.appliedTo && manifest.appliedTo.length) {
    const last = manifest.appliedTo[manifest.appliedTo.length - 1];
    console.log(`  last apply: ${last.at} (pi ${last.version})`);
  } else {
    console.log(`  last apply: (none recorded)`);
  }
  console.log(`  backups:    ${backups.length} (${backups.length ? backups.join(", ") : "none"})`);
  console.log(`  backup root:${BACKUP_ROOT}`);
  return 0;
}

function cmdListBackups() {
  const backups = listBackups();
  if (!backups.length) {
    console.log("No backups found at " + BACKUP_ROOT);
    return 0;
  }
  console.log("Available backups (newest last):");
  for (const b of backups) {
    const dir = path.join(BACKUP_ROOT, b);
    let v = "?";
    try { v = fs.readFileSync(path.join(dir, "VERSION.txt"), "utf8").split("\n")[0]; } catch (_) {}
    console.log(`  ${b}  (${v})  -> ${dir}`);
  }
  return 0;
}

function cmdRollback(argBackup) {
  const piRoot = resolvePiRoot();
  const version = readPiVersion(piRoot);

  let backupName = argBackup || latestBackup();
  if (!backupName) {
    console.log("No backups available to roll back to.");
    return 2;
  }
  const backupDir = path.join(BACKUP_ROOT, backupName);
  if (!fs.existsSync(backupDir)) {
    console.log(`Backup not found: ${backupDir}`);
    return 3;
  }

  console.log(`Pi core patch rollback`);
  console.log(`  pi root:    ${piRoot}`);
  console.log(`  pi version: ${version}`);
  console.log(`  restoring from backup: ${backupDir}\n`);

  // To make rollback safe and reversible, back up the CURRENT (post-apply)
  // state of each target file BEFORE overwriting it with the older backup.
  const preRollbackDir = path.join(BACKUP_ROOT, "prerollback-" + timestamp());
  fs.mkdirSync(preRollbackDir, { recursive: true });

  let restored = 0;
  for (const patch of PATCHES) {
    const absFile = path.join(piRoot, patch.file);
    const backupFile = path.join(backupDir, patch.file.replace(/[\\/]/g, "__"));
    if (!fs.existsSync(backupFile)) {
      console.log(`  [skip] no backup entry for ${patch.file}`);
      continue;
    }
    // snapshot current
    if (fs.existsSync(absFile)) {
      fs.copyFileSync(absFile, path.join(preRollbackDir, patch.file.replace(/[\\/]/g, "__")));
    }
    fs.copyFileSync(backupFile, absFile);
    restored++;
    console.log(`  [restored] ${patch.file}`);
  }
  console.log(`\nRestored ${restored} file(s) from ${backupName}.`);
  console.log(`Current (pre-rollback) state was snapshotted to:\n  ${preRollbackDir}`);
  console.log("\nTo re-apply the patch later, run: `apply`.");
  console.log("IMPORTANT: run `/reload` (or restart Pi) to load the rolled-back core.");
  console.log("  After reload/restart, both agent_reload_runtime and agent_new_session");
  console.log("  reflect the rolled-back state (they share the pi.executeCommand bridge).");
  return 0;
}

// --- helpers ----------------------------------------------------------------

function safeRead(p) {
  try { return fs.readFileSync(p, "utf8"); } catch (_) { return null; }
}

function usage() {
  console.log(`Usage: node ${path.relative(process.cwd(), __filename)} <command>

Commands:
  check          Show patch state. Exit 0=patched, 1=not patched, 2=unmatched.
  apply          Back up targets, apply missing edits, static-verify. Idempotent.
  verify         Static-only verification (no writes, no reload).
  status         Show pi root, version, edit state, manifest, and backups.
  list-backups   List available backup snapshots.
  rollback [id]  Restore target files from a backup (default: newest).

Environment:
  PI_CORE_ROOT   Override the resolved Pi package root directory.

This script is USER-INVOKED ONLY. Importing it does nothing. It never triggers
a live reload and never uses pi.sendUserMessage('/command') as a bridge.`);
}

function main(argv) {
  const cmd = argv[0];
  if (!cmd) { usage(); return 3; }
  switch (cmd) {
    case "check":        return cmdCheck();
    case "apply":        return cmdApply();
    case "verify":       return cmdVerify();
    case "status":       return cmdStatus();
    case "list-backups": return cmdListBackups();
    case "rollback":     return cmdRollback(argv[1]);
    case "-h":
    case "--help":
    case "help":         usage(); return 0;
    default:
      console.log(`Unknown command: ${cmd}\n`);
      usage();
      return 3;
  }
}

// Only run when invoked directly. Importing this module is side-effect free.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const code = main(process.argv.slice(2));
  process.exit(typeof code === "number" ? code : 0);
}

export { PATCHES, resolvePiRoot, evaluate, main };
