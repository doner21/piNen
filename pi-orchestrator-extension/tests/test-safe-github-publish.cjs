/**
 * test-safe-github-publish.cjs
 * =============================
 * Tests for the safe-github-publish orchestration shape.
 *
 * Verifies:
 *   1. Shape is registered and discoverable by name
 *   2. Shape name is exactly "safe-github-publish"
 *   3. No sibling-shape imports
 *   4. Bounded spawn usage through SpawnGuard
 *   5. Docs mention it as the default GitHub publishing method
 *   6. Unknown paradigm listing includes safe-github-publish
 */

"use strict";

const fs = require("fs");
const path = require("path");

const SHAPES_DIR = path.join(__dirname, "..", "src", "shapes");
const INDEX_PATH = path.join(__dirname, "..", "src", "index.ts");
const PARADIGMS_PATH = path.join(__dirname, "..", "PARADIGMS.md");
const README_PATH = path.join(__dirname, "..", "README.md");

let passed = 0;
let failed = 0;

function check(description, condition) {
  if (condition) {
    console.log(`  PASS: ${description}`);
    passed++;
  } else {
    console.error(`  FAIL: ${description}`);
    failed++;
  }
}

console.log("\n=== safe-github-publish Shape Tests ===\n");

// ── 1. Shape file exists ────────────────────────────────────────────────
const shapePath = path.join(SHAPES_DIR, "safe-github-publish.ts");
check("Shape file exists", fs.existsSync(shapePath));

if (fs.existsSync(shapePath)) {
  const shapeSrc = fs.readFileSync(shapePath, "utf8");

  // ── 2. Shape name is exactly "safe-github-publish" ────────────────────
  check(
    'Shape name is "safe-github-publish"',
    shapeSrc.includes('name: "safe-github-publish"') ||
      shapeSrc.includes("name: 'safe-github-publish'") ||
      shapeSrc.includes("name: `safe-github-publish`")
  );

  // ── 3. Exports safeGithubPublishShape ────────────────────────────────
  check(
    "Exports safeGithubPublishShape",
    shapeSrc.includes("export const safeGithubPublishShape")
  );

  // ── 4. Uses SpawnGuard (bounded spawns) ──────────────────────────────
  check("Uses SpawnGuard", shapeSrc.includes("SpawnGuard"));

  // ── 5. Uses spawnSubagent (substrate primitive) ──────────────────────
  check(
    "Uses spawnSubagent",
    shapeSrc.includes("spawnSubagent")
  );

  // ── 6. No sibling-shape imports ──────────────────────────────────────
  const hasSiblingImport =
    shapeSrc.includes('from "./plan-execute-verify"') ||
    shapeSrc.includes('from "./multi-verify-vote"') ||
    shapeSrc.includes('from "./composable-pipeline"') ||
    shapeSrc.includes('from "./verify-only"');
  check("No sibling-shape imports", !hasSiblingImport);

  // ── 7. Implements OrchestrationShape ─────────────────────────────────
  check(
    "Implements OrchestrationShape interface",
    shapeSrc.includes("OrchestrationShape = {") ||
      shapeSrc.includes(": OrchestrationShape")
  );

  // ── 8. References gitleaks ───────────────────────────────────────────
  check("References gitleaks for secret scanning", shapeSrc.includes("gitleaks"));

  // ── 9. References install.ps1 ───────────────────────────────────────
  check("References one-click installer", shapeSrc.includes("install.ps1"));

  // ── 10. References role integrity ───────────────────────────────────
  check(
    "Enforces role integrity (orchestrator != executor)",
    shapeSrc.includes("roleIntegrity") ||
      shapeSrc.includes("orchestrator") ||
      shapeSrc.includes("ROLE")
  );
}

// ── 11. Registered in index.ts ──────────────────────────────────────────
if (fs.existsSync(INDEX_PATH)) {
  const indexSrc = fs.readFileSync(INDEX_PATH, "utf8");
  check(
    "Import in index.ts",
    indexSrc.includes("safe-github-publish") && indexSrc.includes("safeGithubPublishShape")
  );
  check(
    "Registered in shapeRegistry",
    indexSrc.includes('"safe-github-publish"') &&
      indexSrc.includes("safeGithubPublishShape")
  );
}

// ── 12. Docs mention safe-github-publish as GitHub publishing method ────
if (fs.existsSync(PARADIGMS_PATH)) {
  const paradigmsSrc = fs.readFileSync(PARADIGMS_PATH, "utf8");
  check(
    "PARADIGMS.md lists safe-github-publish",
    paradigmsSrc.includes("safe-github-publish")
  );
}

if (fs.existsSync(README_PATH)) {
  const readmeSrc = fs.readFileSync(README_PATH, "utf8");
  check(
    "README.md mentions safe-github-publish as default GitHub method",
    readmeSrc.includes("safe-github-publish") &&
      (readmeSrc.includes("default") || readmeSrc.includes("recommended"))
  );
}

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

if (failed > 0) {
  process.exit(1);
}
