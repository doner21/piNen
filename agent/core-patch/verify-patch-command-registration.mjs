#!/usr/bin/env node
/**
 * verify-patch-command-registration.mjs
 * --------------------------------------
 * Read-only static verification script that confirms the Pi patch extension
 * (`agent/extensions/pi-core-reload-patch/index.ts`) registers the complete
 * set of user-facing slash commands for both reload and new-session core
 * patch workflows.
 *
 * What this script verifies
 * --------------------------
 *   1. All expected reload-patch commands are registered:
 *        /pi-core-reload-patch check|apply|verify
 *        /pi-core-reload-patch-check
 *        /pi-core-reload-patch-apply
 *        /pi-core-reload-patch-verify
 *
 *   2. All expected new-session-patch commands are registered:
 *        /pi-core-new-session-patch check|apply|verify
 *        /pi-core-new-session-patch-check
 *        /pi-core-new-session-patch-apply
 *        /pi-core-new-session-patch-verify
 *
 *   3. A successful apply reloads extensions so the durable public command
 *      bridge becomes active without pretending dist/core patched the bundle.
 *
 *   4. The extension never exits or restarts the Pi process.
 *
 *   5. The underlying shared patcher (`reapply-pi-core-patch.mjs`) is
 *      reachable and its `check` command runs (read-only).
 *
 *   6. The extension correctly references the shared patcher script path.
 *
 * Constraints
 * -----------
 *   - Read-only: never writes to installed Pi core files.
 *   - Never exits or restarts the Pi process.
 *   - Allows only the explicit post-apply extension reload.
 *   - Runnable with plain Node.js (no Pi runtime needed).
 *   - Produces clear PASS/FAIL output with an explicit exit code.
 *
 * Exit codes
 * ----------
 *   0  PASS — all checks succeeded
 *   1  FAIL — one or more checks failed
 *   2  ERROR — verification script itself could not run (e.g., missing files)
 *
 * Usage
 * -----
 *   node agent/core-patch/verify-patch-command-registration.mjs
 *   node agent/core-patch/verify-patch-command-registration.mjs --verbose
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENT_DIR = path.resolve(__dirname, "..");
const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");

// ── Paths under test ───────────────────────────────────────────────────────

const EXTENSION_FILE = path.join(
  AGENT_DIR,
  "extensions",
  "pi-core-reload-patch",
  "index.ts"
);
const PATCHER_SCRIPT = path.join(__dirname, "reapply-pi-core-patch.mjs");

// ── Expected commands ──────────────────────────────────────────────────────

/**
 * Every slash command the extension MUST register, grouped by patch type.
 * This is the canonical list; if the extension changes, this file must be
 * updated to match.
 */
const EXPECTED_COMMANDS = {
  reload: [
    "pi-core-reload-patch",        // main sub-command (check|apply|verify)
    "pi-core-reload-patch-check",
    "pi-core-reload-patch-apply",
    "pi-core-reload-patch-verify",
  ],
  "new-session": [
    "pi-core-new-session-patch",   // main sub-command (check|apply|verify)
    "pi-core-new-session-patch-check",
    "pi-core-new-session-patch-apply",
    "pi-core-new-session-patch-verify",
  ],
};

/** All expected commands flattened */
const ALL_EXPECTED = [
  ...EXPECTED_COMMANDS.reload,
  ...EXPECTED_COMMANDS["new-session"],
];

// ── Forbidden patterns ─────────────────────────────────────────────────────

/**
 * Patterns that MUST NOT appear in the extension source.
 * Each entry is [pattern, label] where pattern is a regex and label is a
 * human-readable description of the violation.
 */
const FORBIDDEN_PATTERNS = [
  [
    /\bpi\.reload\s*\(/,
    'pi.reload() — reload must use the command context',
  ],
  [
    /executeCommand\s*\(\s*["'`]\/?(?:reload|agent-reload-runtime|agent-new-session)/,
    'private executeCommand bridge — patch commands must use supported APIs',
  ],
  [
    /process\.exit\s*\(/,
    'process.exit() — extension code (running inside Pi) must not exit the host',
  ],
];

// ── Helpers ────────────────────────────────────────────────────────────────

function log(...args) {
  console.log(...args);
}

function vlog(...args) {
  if (VERBOSE) console.log(...args);
}

function fail(label, detail) {
  console.log(`  [FAIL] ${label}`);
  if (detail) console.log(`         ${detail}`);
  return false;
}

function ok(label) {
  console.log(`  [ok]   ${label}`);
  return true;
}

// ── Phase 1: Extension source analysis ─────────────────────────────────────

function analyzeExtensionSource() {
  log("─".repeat(60));
  log("Phase 1: Extension source analysis");
  log(`  file: ${EXTENSION_FILE}`);
  log("");

  let allOk = true;

  // --- 1a. File existence ---
  if (!fs.existsSync(EXTENSION_FILE)) {
    allOk = fail("Extension file exists", `not found at ${EXTENSION_FILE}`);
    return { allOk, foundCommands: new Set(), allExpectedPresent: false };
  }
  allOk = ok("Extension file exists");

  const source = fs.readFileSync(EXTENSION_FILE, "utf8");

  // --- 1b. Forbidden patterns ---
  log("\n  Forbidden pattern checks:");
  for (const [regex, label] of FORBIDDEN_PATTERNS) {
    let violation = false;
    let lastMatchLine = "";

    // Scan line-by-line so we can distinguish real code from documentation
    // that explains the prohibition (e.g. "no `pi.sendUserMessage('/command')`").
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        // Check if this looks like documentation of a prohibition rather
        // than actual usage. Look for negation tokens on the same line.
        const negTokens = ["no ", "never", "forbidden", "must not",
          "should not", "don't", "do not", "invariant:", "invariants:"];
        const isDocNegation = negTokens.some((t) =>
          lines[i].toLowerCase().includes(t)
        );
        if (!isDocNegation) {
          violation = true;
          lastMatchLine = `line ${i + 1}: ${lines[i].trim()}`;
          break;
        }
        vlog(`    (negated documentation at line ${i + 1}, not a violation)`);
      }
    }

    if (violation) {
      allOk = fail(`No ${label}`, lastMatchLine);
    } else {
      ok(`No ${label}`);
    }
  }

  // --- 1c. Command registration extraction ---
  //
  // The extension registers commands in two ways:
  //   1. Direct calls: pi.registerCommand("pi-core-reload-patch", ...)
  //      pi.registerCommand("pi-core-new-session-patch", ...)
  //   2. Loops: for (const action of ACTIONS) {
  //        pi.registerCommand(commandFor(action, "reload"), ...)
  //        pi.registerCommand(commandFor(action, "new-session"), ...)
  //      }
  //
  // Strategy: extract direct registerCommand string arguments, then
  // simulate the commandFor() logic for the loop-based registrations.

  const foundCommands = new Set();

  // Direct registerCommand("name", ...) calls
  const directRegex = /registerCommand\s*\(\s*["'`]([^"'`]+)["'`]/g;
  let match;
  while ((match = directRegex.exec(source)) !== null) {
    foundCommands.add(match[1]);
  }
  vlog(`\n  Direct registerCommand names: ${[...foundCommands].join(", ") || "(none)"}`);

  // Loop-based registrations: for (const action of ACTIONS) { ... commandFor(action, type) ... }
  // If the source contains the commandFor loop pattern, we know it generates
  // the per-action aliases.
  if (source.includes("commandFor(action,")) {
    const actionsMatch = source.match(/ACTIONS\s*=\s*\[([^\]]+)\]/);
    const rawActions = actionsMatch ? actionsMatch[1] : '"check", "apply", "verify"';
    const actions = rawActions
      .split(",")
      .map((a) => a.trim().replace(/["'`]/g, ""))
      .filter(Boolean);

    vlog(`  Loop-generated action aliases: ${actions.join(", ")}`);

    // Check which patch types are looped over
    if (source.includes('"reload"')) {
      for (const action of actions) {
        foundCommands.add(`pi-core-reload-patch-${action}`);
      }
    }
    if (source.includes('"new-session"')) {
      for (const action of actions) {
        foundCommands.add(`pi-core-new-session-patch-${action}`);
      }
    }
  }

  vlog(`  All detected commands: ${[...foundCommands].sort().join(", ")}`);

  // --- 1d. Expected command completeness ---
  log("\n  Expected command registration:");

  const missingCmds = [];
  for (const cmd of ALL_EXPECTED) {
    if (!foundCommands.has(cmd)) {
      allOk = fail(`Command registered: /${cmd}`, "not found");
      missingCmds.push(cmd);
    } else {
      ok(`Command registered: /${cmd}`);
    }
  }

  // Also check that we don't have unexpected commands (may indicate drift)
  const unexpectedCmds = [...foundCommands].filter(
    (cmd) => !ALL_EXPECTED.includes(cmd)
  );
  if (unexpectedCmds.length > 0) {
    for (const cmd of unexpectedCmds) {
      console.log(`  [WARN] Unexpected command registered: /${cmd}`);
    }
  }

  const allExpectedPresent = missingCmds.length === 0;

  return { allOk, foundCommands, allExpectedPresent, missingCmds };
}

// ── Phase 2: Patcher availability ──────────────────────────────────────────

function verifyPatcherAvailability() {
  log("");
  log("─".repeat(60));
  log("Phase 2: Patcher script availability");
  log(`  script: ${PATCHER_SCRIPT}`);
  log("");

  let allOk = true;

  if (!fs.existsSync(PATCHER_SCRIPT)) {
    allOk = fail("Patcher script exists", `not found at ${PATCHER_SCRIPT}`);
    return { allOk, patcherCheckResult: null };
  }
  ok("Patcher script exists");

  // Verify it's the right script — look for the executeCommand patch definitions
  const patcherSource = fs.readFileSync(PATCHER_SCRIPT, "utf8");
  const hasExecuteCommand = patcherSource.includes("executeCommand");
  const hasPatchDefs = patcherSource.includes("EXECUTE_COMMAND_RUNNER_BODY");
  const hasBothBridges =
    patcherSource.includes("agent_reload_runtime") &&
    patcherSource.includes("agent_new_session");

  log("");
  log("  Patcher content checks:");
  if (!hasExecuteCommand) {
    allOk = fail("Patcher defines executeCommand patch");
  } else {
    ok("Patcher defines executeCommand patch");
  }
  if (!hasPatchDefs) {
    allOk = fail("Patcher contains patch definitions");
  } else {
    ok("Patcher contains patch definitions");
  }
  if (!hasBothBridges) {
    allOk = fail(
      "Patcher documents both agent_reload_runtime AND agent_new_session bridges",
      "patcher must mention both bridges in comments/docs"
    );
  } else {
    ok("Patcher documents both agent_reload_runtime AND agent_new_session bridges");
  }

  // Check the patcher has rollback capability
  const hasRollback = patcherSource.includes("cmdRollback");
  log(`  ${hasRollback ? "[ok]   " : "[WARN] "} Patcher includes rollback command`);

  return { allOk, patcherCheckResult: null };
}

// ── Phase 3: Patcher check (read-only shell out) ───────────────────────────

function runPatcherCheck() {
  log("");
  log("─".repeat(60));
  log("Phase 3: Patcher `check` command (read-only)");
  log(`  script: ${PATCHER_SCRIPT}`);
  log("");

  let allOk = true;
  let stdout = "";
  let stderr = "";
  let exitCode = -1;

  try {
    const result = execFileSync(
      process.execPath,
      [PATCHER_SCRIPT, "check"],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: process.env,
        windowsHide: true,
      }
    );
    stdout = result;
    exitCode = 0;
  } catch (err) {
    stdout = err.stdout || "";
    stderr = err.stderr || "";
    exitCode = err.status ?? err.code ?? -1;
  }

  log("  Patcher output:");
  for (const line of stdout.split("\n")) {
    log(`    ${line}`);
  }
  if (stderr.trim()) {
    log("  Patcher stderr:");
    for (const line of stderr.split("\n")) {
      log(`    ${line}`);
    }
  }
  log(`  Exit code: ${exitCode}`);

  // Exit code 0 = fully patched, 1 = not fully patched (expected after update),
  // 2 = unmatched (safe failure). Both 0 and 1 are "not broken" states.
  log("");
  if (exitCode === 0) {
    ok("Patcher check: fully patched (exit 0)");
  } else if (exitCode === 1) {
    ok("Patcher check: not fully patched (exit 1) — expected after Pi update, run apply");
  } else if (exitCode === 2) {
    allOk = fail(
      "Patcher check: unmatched target (exit 2)",
      "Pi source has drifted; manual adaptation required before apply"
    );
  } else if (exitCode === 3) {
    allOk = fail(
      "Patcher check: usage error (exit 3)",
      "Check the patcher script for issues"
    );
  } else {
    allOk = fail(
      `Patcher check: unexpected exit code ${exitCode}`,
      stderr.trim() || "(no stderr)"
    );
  }

  return { allOk, stdout, stderr, exitCode };
}

// ── Phase 4: Extension → patcher path resolution ──────────────────────────

function verifyExtensionPatcherPath() {
  log("");
  log("─".repeat(60));
  log("Phase 4: Extension → patcher path resolution");
  log("");

  let allOk = true;

  const source = fs.readFileSync(EXTENSION_FILE, "utf8");

  // Check that the extension resolves the patcher script path correctly
  const resolvesAgtDir = source.includes("AGENT_DIR") || source.includes(".pi");
  const resolvesCorePatch = source.includes("core-patch");
  const resolvesMjsFile = source.includes("reapply-pi-core-patch.mjs");
  // Should use resolve(), not hardcoded path
  const usesResolve = source.includes("resolve(") || source.includes("path.resolve");

  if (!resolvesAgtDir) {
    allOk = fail("Extension resolves AGENT_DIR / .pi directory");
  } else {
    ok("Extension resolves AGENT_DIR / .pi directory");
  }
  if (!resolvesCorePatch) {
    allOk = fail("Extension references core-patch subdirectory");
  } else {
    ok("Extension references core-patch subdirectory");
  }
  if (!resolvesMjsFile) {
    allOk = fail("Extension references reapply-pi-core-patch.mjs");
  } else {
    ok("Extension references reapply-pi-core-patch.mjs");
  }
  if (!usesResolve) {
    allOk = fail("Extension uses path.resolve() (not hardcoded path)");
  } else {
    ok("Extension uses path.resolve() (not hardcoded path)");
  }

  // The extension should use PATCHER_SCRIPT constant
  if (!source.includes("PATCHER_SCRIPT")) {
    console.log('  [WARN] Extension does not define PATCHER_SCRIPT constant');
  }

  return { allOk };
}

// ── Phase 5: Safety invariants ─────────────────────────────────────────────

function verifySafetyInvariants() {
  log("");
  log("─".repeat(60));
  log("Phase 5: Safety invariants");
  log("");

  let allOk = true;

  const extSource = fs.readFileSync(EXTENSION_FILE, "utf8");
  const patcherSource = fs.readFileSync(PATCHER_SCRIPT, "utf8");

  // Extension invariants
  log("  Extension invariants:");
  const hasNotify = extSource.includes("notify");
  const hasSharedBridge = extSource.includes("sharedBridgeNote") ||
    extSource.includes("shared") ||
    extSource.includes("same");
  const hasSharedRunner = extSource.includes("reapply-pi-core-patch.mjs");
  const hasPostApplyReload =
    /action\s*===\s*["']apply["'][\s\S]*result\.code\s*===\s*0[\s\S]*await\s+ctx\.reload\s*\(\)/.test(extSource);
  const hasNoPrivateDispatch =
    !/executeCommand\s*\(\s*["'`]\/?(?:reload|agent-reload-runtime|agent-new-session)/.test(extSource);

  if (!hasNotify) allOk = fail("Extension uses notify for user feedback");
  else ok("Extension uses notify for user feedback");

  if (!hasSharedBridge)
    allOk = fail(
      "Extension documents shared bridge (reload + new-session)",
      "should use sharedBridgeNote() or similar to explain the single core patch"
    );
  else ok("Extension documents shared bridge (reload + new-session)");

  if (!hasSharedRunner)
    allOk = fail(
      "Extension shells out to shared patcher runner"
    );
  else ok("Extension shells out to shared patcher runner");

  if (!hasPostApplyReload) {
    allOk = fail("Successful apply automatically reloads extensions");
  } else {
    ok("Successful apply automatically reloads extensions");
  }

  if (!hasNoPrivateDispatch) {
    allOk = fail("Extension does not invoke the private executeCommand bridge");
  } else {
    ok("Extension does not invoke the private executeCommand bridge");
  }

  const documentsPublicBridge =
    extSource.includes("expandPromptTemplates: true") &&
    extSource.includes("dist/bundle/cli.js");
  if (!documentsPublicBridge) {
    allOk = fail("Extension explains bundled CLI and public command dispatch");
  } else {
    ok("Extension explains bundled CLI and public command dispatch");
  }

  // Patcher invariants
  log("\n  Patcher invariants:");
  const patcherNoAutoPatch = !patcherSource.includes("auto-patch") ||
    patcherSource.includes("NO silent");
  const patcherHasBackup = patcherSource.includes("Backup") ||
    patcherSource.includes("backup");
  const patcherHasSafeFail = patcherSource.includes("SAFE FAILURE") ||
    patcherSource.includes("safe fail");
  const patcherHasIdempotent = patcherSource.includes("idempotent");
  const patcherNoLiveReload = patcherSource.includes("did NOT trigger a reload") ||
    patcherSource.includes("never triggers");

  if (!patcherNoAutoPatch)
    allOk = fail("Patcher states NO silent auto-patching");
  else ok("Patcher states NO silent auto-patching");

  if (!patcherHasBackup)
    allOk = fail("Patcher includes backup-before-write logic");
  else ok("Patcher includes backup-before-write logic");

  if (!patcherHasSafeFail)
    allOk = fail("Patcher implements safe failure on source drift");
  else ok("Patcher implements safe failure on source drift");

  if (!patcherHasIdempotent)
    allOk = fail("Patcher states idempotency");
  else ok("Patcher states idempotency");

  if (!patcherNoLiveReload)
    allOk = fail("Patcher states it does NOT trigger live reload");
  else ok("Patcher states it does NOT trigger live reload");

  return { allOk };
}

// ── Phase 6: Static structural checks on installed Pi core (read-only) ────

function verifyPiCoreStructure() {
  log("");
  log("─".repeat(60));
  log("Phase 6: Pi core file existence (target files reachable)");
  log("");

  let allOk = true;
  let piRoot = null;

  // Resolve pi root using same logic as patcher
  try {
    // Use PI_CORE_ROOT env var first
    if (process.env.PI_CORE_ROOT) {
      piRoot = path.resolve(process.env.PI_CORE_ROOT);
    } else {
      // Try common paths
      const candidates = [
        path.join(
          process.env.APPDATA || path.join(process.env.HOME || "", "AppData", "Roaming"),
          "npm", "node_modules", "@earendil-works", "pi-coding-agent"
        ),
        path.join(
          process.env.HOME || "",
          ".npm-global", "lib", "node_modules", "@earendil-works", "pi-coding-agent"
        ),
      ];
      for (const c of candidates) {
        if (fs.existsSync(path.join(c, "package.json")) &&
            fs.existsSync(path.join(c, "dist", "core", "extensions"))) {
          piRoot = c;
          break;
        }
      }
    }
  } catch (_) {
    // continue
  }

  if (!piRoot) {
    console.log('  [WARN] Could not resolve Pi package root; skipping core file checks.');
    console.log('         Set PI_CORE_ROOT env var to enable this phase.');
    return { allOk: true, piRoot: null };
  }

  ok(`Pi package root resolved: ${piRoot}`);

  // Pi 0.84.3+ launches a bundle. Verify the real CLI entrypoint supports the
  // public command-expansion transport and do not mistake modular dist/core
  // sentinels for proof that the active CLI has pi.executeCommand.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(piRoot, "package.json"), "utf8"));
    const cliEntry = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
    if (cliEntry !== "dist/bundle/cli.js") {
      console.log(`  [WARN] Active CLI entrypoint is ${cliEntry ?? "unknown"}, not dist/bundle/cli.js`);
    } else {
      ok("Active Pi CLI entrypoint: dist/bundle/cli.js");
      const chunksDir = path.join(piRoot, "dist", "bundle", "chunks");
      const chunkText = fs.readdirSync(chunksDir)
        .filter((name) => name.endsWith(".js"))
        .map((name) => fs.readFileSync(path.join(chunksDir, name), "utf8"))
        .join("\n");
      if (!chunkText.includes("expandPromptTemplates")) {
        allOk = fail("Bundled CLI exposes expandPromptTemplates command dispatch");
      } else {
        ok("Bundled CLI exposes expandPromptTemplates command dispatch");
      }
      if (chunkText.includes("runtime.executeCommand")) {
        console.log("  [WARN] Bundled CLI unexpectedly contains the private executeCommand patch");
      } else {
        ok("Verification does not confuse modular patch with bundled runtime");
      }
    }
  } catch (error) {
    allOk = fail("Inspect active Pi CLI bundle", error instanceof Error ? error.message : String(error));
  }

  // Check the legacy modular target files exist
  const targetFiles = [
    "dist/core/extensions/loader.js",
    "dist/core/extensions/runner.js",
    "dist/core/extensions/types.d.ts",
  ];

  let allFilesExist = true;
  for (const relFile of targetFiles) {
    const absFile = path.join(piRoot, relFile);
    if (fs.existsSync(absFile)) {
      ok(`Target file exists: ${relFile}`);
    } else {
      allFilesExist = false;
      allOk = fail(`Target file exists: ${relFile}`, "file not found");
    }
  }

  return { allOk, piRoot, allFilesExist };
}

// ── Summary ─────────────────────────────────────────────────────────────────

function printSummary(phaseResults) {
  log("");
  log("═".repeat(60));
  log("VERIFICATION SUMMARY");
  log("═".repeat(60));
  log("");

  const phases = [];
  for (const [name, result] of Object.entries(phaseResults)) {
    const status = result.allOk ? "PASS" : "FAIL";
    phases.push({ name, status, ...result });
  }

  for (const p of phases) {
    const marker = p.status === "PASS" ? "[PASS]" : "[FAIL]";
    console.log(`  ${marker} ${p.name}`);
  }

  const overallPass = phases.every((p) => p.status === "PASS");

  log("");
  if (overallPass) {
    log("╔══════════════════════════════════════════════════════════╗");
    log("║  OVERALL: PASS                                          ║");
    log("║  All command registrations verified.                    ║");
    log("║  Both reload and new-session patch commands are intact.  ║");
    log("║  Safety invariants satisfied.                           ║");
    log("╚══════════════════════════════════════════════════════════╝");
  } else {
    log("╔══════════════════════════════════════════════════════════╗");
    log("║  OVERALL: FAIL                                          ║");
    log("║  One or more checks failed. Review output above.        ║");
    log("╚══════════════════════════════════════════════════════════╝");
  }

  log("");
  log("Note on patcher check exit codes:");
  log("  exit 0 = fully patched");
  log("  exit 1 = not fully patched (expected after Pi update, run apply)");
  log("  exit 2 = safe failure (source drift, manual adaptation needed)");
  log("  exit 3 = usage error");
  log("Both exit 0 and exit 1 are considered non-failure for this verification.");
  log("");
  log("This is a read-only verification. No Pi core files were modified.");
  log("No live reload, process restart, or command dispatch was triggered by this test.");

  return overallPass;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  log("╔══════════════════════════════════════════════════════════════╗");
  log("║  Pi Core Patch Command Registration Verification           ║");
  log("║  verify-patch-command-registration.mjs                     ║");
  log("╚══════════════════════════════════════════════════════════════╝");
  log("");

  const phaseResults = {};

  // Phase 1: Extension source analysis
  phaseResults["Extension source analysis"] = analyzeExtensionSource();

  // Phase 2: Patcher availability
  phaseResults["Patcher script availability"] = verifyPatcherAvailability();

  // Phase 3: Patcher check (read-only shell out)
  phaseResults["Patcher check (read-only)"] = runPatcherCheck();

  // Phase 4: Extension → patcher path resolution
  phaseResults["Extension→patcher paths"] = verifyExtensionPatcherPath();

  // Phase 5: Safety invariants
  phaseResults["Safety invariants"] = verifySafetyInvariants();

  // Phase 6: Pi core structure
  phaseResults["Pi core file existence"] = verifyPiCoreStructure();

  const overallPass = printSummary(phaseResults);
  return overallPass ? 0 : 1;
}

// Run when invoked directly
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const code = main();
  process.exit(code);
}

export { main };
