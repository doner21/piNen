#!/usr/bin/env node
// NenFlow v3 artifact validator
// Usage: node validator.js <file-path> <ROLE> [ARTIFACT_TYPE]

const fs = require("fs");
const path = require("path");
const { validateContinuationContract } = require("./context-policy.js");

const [, , filePath, expectedRole, expectedArtifactType] = process.argv;

if (!filePath || !expectedRole) {
  console.error("FAIL: Usage: node validator.js <file-path> <ROLE> [ARTIFACT_TYPE]");
  process.exit(1);
}

function getField(frontmatter, field) {
  const match = frontmatter.match(new RegExp(`^${field}\\s*:\\s*(.+)$`, "mi"));
  return match ? match[1].trim().replace(/^['\"]|['\"]$/g, "") : null;
}

let content;
try {
  content = fs.readFileSync(filePath, "utf8");
} catch {
  console.error(`FAIL: Cannot read file: ${filePath}`);
  process.exit(1);
}

const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
if (!fmMatch) {
  console.error("FAIL: No YAML frontmatter found (must start with ---)");
  process.exit(1);
}

const frontmatter = fmMatch[1];
const required = ["artifact_type", "role", "run_id"];
const missing = required.filter((field) => !getField(frontmatter, field));
if (missing.length > 0) {
  console.error(`FAIL: Missing required frontmatter fields: ${missing.join(", ")}`);
  process.exit(1);
}

const actualRole = (getField(frontmatter, "role") || "").toUpperCase();
const expectRole = expectedRole.toUpperCase();
if (actualRole !== expectRole) {
  console.error(`FAIL: Role mismatch — expected "${expectRole}", got "${actualRole}"`);
  process.exit(1);
}

const actualArtifactType = (getField(frontmatter, "artifact_type") || "").toUpperCase();
if (expectedArtifactType && actualArtifactType !== expectedArtifactType.toUpperCase()) {
  console.error(
    `FAIL: Artifact type mismatch — expected "${expectedArtifactType.toUpperCase()}", got "${actualArtifactType}"`,
  );
  process.exit(1);
}

if (actualArtifactType === "VERIFICATION_REPORT") {
  const verdict = getField(frontmatter, "verdict");
  if (!verdict || !/^(PASS|FAIL)$/i.test(verdict)) {
    console.error('FAIL: VERIFICATION_REPORT requires frontmatter verdict: PASS or FAIL');
    process.exit(1);
  }
  if (!/^VERDICT:\s*(PASS|FAIL)\s*$/mi.test(content)) {
    console.error('FAIL: VERIFICATION_REPORT body must end with a VERDICT: PASS|FAIL line');
    process.exit(1);
  }
}

if (actualArtifactType === "CONTINUATION_CONTRACT") {
  const result = validateContinuationContract(filePath, { expectedRole: expectRole });
  if (!result.ok) {
    console.error(`FAIL: CONTINUATION_CONTRACT invalid — ${result.errors.join("; ")}`);
    process.exit(1);
  }
}

console.log(
  `PASS: ${path.basename(filePath)} validated as role=${expectRole} artifact_type=${actualArtifactType}`,
);
