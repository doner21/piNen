#!/usr/bin/env node
// Shared NenFlow v3 context-handoff policy helpers.

const fs = require("fs");
const path = require("path");

const DEFAULT_HANDOFF_THRESHOLD_PERCENT = 65;
const VALID_ROLES = new Set(["RESEARCHER", "PLANNER", "EXECUTOR", "VERIFIER", "ORCHESTRATOR"]);
const CONTINUATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const KEYWORD_RE = /context|handoff|threshold|saturation|window|past|above|exceed|cross|health|rot|continuation/i;

function normalizePath(value) {
  return path.resolve(String(value || ""));
}

function parseFrontmatter(content) {
  const match = String(content || "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    fields[m[1]] = m[2].trim().replace(/^['\"]|['\"]$/g, "");
  }
  return fields;
}

function isValidPercent(value) {
  return parsePercentValue(value) !== null;
}

function parsePercentValue(raw) {
  const match = String(raw).trim().match(/^~?\s*(\d{1,3}(?:\.\d+)?)\s*%?\s*$/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return null;
  return n;
}

function hasSeparatedSignBefore(src, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(src[i])) i -= 1;
  return i >= 0 && /[+-]/.test(src[i]);
}

function hasInvalidTokenBoundary(src, index, length) {
  const before = index > 0 ? src[index - 1] : "";
  const after = index + length < src.length ? src[index + length] : "";
  if (before && /[A-Za-z0-9_.+-]/.test(before)) return true;
  if (after && /[A-Za-z0-9_.%+-]/.test(after)) return true;
  if (hasSeparatedSignBefore(src, index)) return true;
  return false;
}

function parseContextThreshold(text) {
  if (!text) return null;
  const src = String(text);
  const candidates = [];
  const pctRe = /(\d{1,3}(?:\.\d+)?)\s*%/g;
  let match;
  while ((match = pctRe.exec(src))) {
    if (hasInvalidTokenBoundary(src, match.index, match[0].length)) continue;
    const percent = parsePercentValue(match[0]);
    if (percent === null) continue;
    const start = Math.max(0, match.index - 80);
    const end = Math.min(src.length, match.index + match[0].length + 80);
    const context = src.slice(start, end);
    candidates.push({ percent, index: match.index, context, keyword: KEYWORD_RE.test(context) });
  }
  const chosen = candidates.find((c) => c.keyword);
  if (!chosen) return null;
  return {
    percent: chosen.percent,
    match: `${chosen.percent}%`,
    context: chosen.context.trim(),
    index: chosen.index,
  };
}

function thresholdFromIntakeFrontmatter(intakeText) {
  const fm = parseFrontmatter(intakeText);
  if (!fm || fm.context_handoff_threshold_percent === undefined) return null;
  const percent = parsePercentValue(fm.context_handoff_threshold_percent);
  if (percent === null) return null;
  return { percent, match: `${percent}%`, context: "intake frontmatter", index: 0 };
}

function buildContextPolicy(rawPrompt = "", intakeText = "") {
  const fromPrompt = parseContextThreshold(rawPrompt);
  const fromIntakeField = thresholdFromIntakeFrontmatter(intakeText);
  const fromIntakeText = parseContextThreshold(intakeText);
  const selected = fromPrompt || fromIntakeField || fromIntakeText;
  const threshold = selected ? selected.percent : DEFAULT_HANDOFF_THRESHOLD_PERCENT;
  const source = fromPrompt ? "user_prompt" : selected ? "intake" : "default";
  return {
    handoff_threshold_percent: threshold,
    threshold_source: source,
    warning_threshold_percent: Math.max(1, threshold - 5),
    hard_risk_threshold_percent: Math.min(99, threshold + 5),
    matched_context: selected ? selected.context : null,
  };
}

function buildRunConfig(runId, policy = buildContextPolicy()) {
  return {
    schema_version: 1,
    run_id: runId,
    context_handoff: {
      handoff_threshold_percent: policy.handoff_threshold_percent,
      threshold_source: policy.threshold_source || "default",
      warning_threshold_percent: policy.warning_threshold_percent,
      hard_risk_threshold_percent: policy.hard_risk_threshold_percent,
    },
  };
}

function validateRunConfig(config, expectedRunId) {
  const errors = [];
  if (!config || typeof config !== "object") errors.push("config must be an object");
  if (errors.length) return { ok: false, errors };
  if (config.schema_version !== 1) errors.push("schema_version must be 1");
  if (!config.run_id || (expectedRunId && config.run_id !== expectedRunId)) errors.push("run_id missing or mismatched");
  const handoff = config.context_handoff || {};
  if (!isValidPercent(handoff.handoff_threshold_percent)) errors.push("context_handoff.handoff_threshold_percent must be >0 and <100");
  if (!isValidPercent(handoff.warning_threshold_percent)) errors.push("context_handoff.warning_threshold_percent must be >0 and <100");
  if (!isValidPercent(handoff.hard_risk_threshold_percent)) errors.push("context_handoff.hard_risk_threshold_percent must be >0 and <100");
  if (!handoff.threshold_source) errors.push("context_handoff.threshold_source is required");
  return { ok: errors.length === 0, errors };
}

function writeRunConfig(filePath, config) {
  const result = validateRunConfig(config, config && config.run_id);
  if (!result.ok) throw new Error(`Invalid RUN_CONFIG.json: ${result.errors.join("; ")}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return filePath;
}

function readRunConfig(filePath, expectedRunId) {
  if (!filePath || !fs.existsSync(filePath)) {
    return buildRunConfig(expectedRunId || "RUN_UNKNOWN", buildContextPolicy());
  }
  const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const result = validateRunConfig(config, expectedRunId);
  if (!result.ok) throw new Error(`Invalid RUN_CONFIG.json: ${result.errors.join("; ")}`);
  return config;
}

function buildContinuationPath(runDir, stage, role, attempt = 1) {
  const upperRole = String(role || "").toUpperCase();
  const suffix = attempt === undefined || attempt === null ? "" : `_${attempt}`;
  return path.join(runDir, `ATT_${Number(stage)}_CONTINUATION_${upperRole}${suffix}.md`);
}

function continuationMatchFor(fileName, stage, role) {
  const upperRole = String(role || "").toUpperCase();
  const stagePart = stage === undefined || stage === null ? "\\d+" : String(Number(stage));
  const re = new RegExp(`^ATT_${stagePart}_CONTINUATION_${upperRole}(?:_(\\d+))?\\.md$`, "i");
  return String(fileName || "").match(re);
}

function findContinuation(runDir, stage, role) {
  if (!fs.existsSync(runDir)) return null;
  const candidates = fs.readdirSync(runDir)
    .map((name) => ({ name, match: continuationMatchFor(name, stage, role) }))
    .filter((x) => x.match)
    .map((x) => ({ filePath: path.join(runDir, x.name), attempt: x.match[1] ? Number(x.match[1]) : 0, name: x.name }))
    .sort((a, b) => b.attempt - a.attempt || b.name.localeCompare(a.name));
  return candidates.length ? candidates[0].filePath : null;
}

function getSection(content, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\r?\\n)##\\s+${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s+|$)`, "i");
  const match = String(content || "").match(re);
  return match ? match[1].trim() : "";
}

function looksPlaceholder(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return true;
  return /\[(what|key|exact|list|fill|todo|tbd|n\/a|what has|what still|exact instruction)/i.test(trimmed)
    || /TODO|TBD|PLACEHOLDER|Replace this/i.test(trimmed);
}

function inferRunDir(filePath, runId) {
  const resolved = normalizePath(filePath);
  const parts = resolved.split(/[\\/]+/);
  const idx = parts.lastIndexOf(runId);
  if (idx > 0 && parts[idx - 1] === "runs") return parts.slice(0, idx + 1).join(path.sep);
  return path.dirname(resolved);
}

function isInside(child, parent) {
  const rel = path.relative(normalizePath(parent), normalizePath(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function validateContinuationContract(filePath, options = {}) {
  const errors = [];
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return { ok: false, errors: [`cannot read continuation contract: ${err.message}`] };
  }
  const fm = parseFrontmatter(content);
  if (!fm) errors.push("No YAML frontmatter found");
  const role = (fm && fm.role || "").toUpperCase();
  const runId = fm && fm.run_id;
  if (fm) {
    if ((fm.artifact_type || "").toUpperCase() !== "CONTINUATION_CONTRACT") errors.push("artifact_type must be CONTINUATION_CONTRACT");
    if (!VALID_ROLES.has(role)) errors.push("role must be one of RESEARCHER, PLANNER, EXECUTOR, VERIFIER, ORCHESTRATOR");
    if (options.expectedRole && role !== String(options.expectedRole).toUpperCase()) errors.push(`role mismatch: expected ${String(options.expectedRole).toUpperCase()}, got ${role || "<missing>"}`);
    if (!runId) errors.push("run_id is required");
    if (options.expectedRunId && runId !== options.expectedRunId) errors.push(`run_id mismatch: expected ${options.expectedRunId}, got ${runId || "<missing>"}`);
    if ((fm.continuation_from || "").toUpperCase() !== role) errors.push("continuation_from must equal role");
    if (!isValidPercent(parsePercentValue(fm.context_saturation_estimate))) errors.push("context_saturation_estimate must contain a valid percentage >0 and <100");
    if (fm.context_handoff_threshold_percent !== undefined && !isValidPercent(parsePercentValue(fm.context_handoff_threshold_percent))) errors.push("context_handoff_threshold_percent must be >0 and <100 when present");
    if (fm.measured_at === undefined) errors.push("measured_at is required");
    else {
      const measured = Date.parse(fm.measured_at);
      const now = options.now === undefined ? Date.now() : Number(options.now);
      const maxAgeMs = options.maxAgeMs === undefined ? CONTINUATION_MAX_AGE_MS : Number(options.maxAgeMs);
      if (!Number.isFinite(measured)) errors.push("measured_at must be an ISO-8601 timestamp");
      else if (measured - now > 5 * 60 * 1000) errors.push("measured_at is too far in the future");
      else if (now - measured > maxAgeMs) errors.push("continuation contract is stale");
    }
  }
  if (runId) {
    const runDir = options.runDir || inferRunDir(filePath, runId);
    if (!isInside(filePath, runDir)) errors.push("continuation contract path must be inside its run directory");
    const folderName = path.basename(runDir);
    if (folderName !== runId) errors.push("continuation contract must live in runs/{run_id}/");
  }
  if (role) {
    const name = path.basename(filePath);
    if (!continuationMatchFor(name, undefined, role)) errors.push(`filename must match ATT_<n>_CONTINUATION_${role}(_<attempt>).md`);
  }
  for (const heading of ["Work Completed", "Work Remaining", "Critical Context", "Resume Instruction"]) {
    const section = getSection(content, heading);
    if (looksPlaceholder(section)) errors.push(`${heading} must be non-empty and non-placeholder`);
  }
  const resume = getSection(content, "Resume Instruction");
  if (fm && resume) {
    if (role && !new RegExp(role, "i").test(resume)) errors.push("Resume Instruction must mention the role");
    if (runId && !resume.includes(runId)) errors.push("Resume Instruction must mention the run_id");
    if (!/contract/i.test(resume)) errors.push("Resume Instruction must mention the continuation contract");
    if (!/remaining/i.test(resume)) errors.push("Resume Instruction must mention remaining work");
  }
  return { ok: errors.length === 0, errors };
}

function buildContinuationResumePrompt({ role, runId, contractPath, runConfigPath, intakePath, researchPath, planPath, verifierBriefPath, normalOutputPath, nextContinuationPath }) {
  const upperRole = String(role || "").toUpperCase();
  const lines = [
    `NenFlow v3 Route D continuation for ${upperRole}.`,
    `Run id: ${runId}.`,
    `Read and obey the continuation contract: ${contractPath}`,
    `Read RUN_CONFIG.json for context_handoff_threshold_percent: ${runConfigPath}`,
  ];
  for (const [label, value] of Object.entries({ intakePath, researchPath, planPath, verifierBriefPath })) {
    if (value) lines.push(`Read ${label}: ${value}`);
  }
  if (normalOutputPath) lines.push(`Produce the normal ${upperRole} output at exactly: ${normalOutputPath}`);
  if (nextContinuationPath) lines.push(`If remaining work again reaches the configured threshold, write the next continuation contract at exactly: ${nextContinuationPath}`);
  lines.push("Resume only the remaining work from the contract; do not redo completed work unless necessary to verify state.");
  return lines.join("\n");
}

module.exports = {
  DEFAULT_HANDOFF_THRESHOLD_PERCENT,
  CONTINUATION_MAX_AGE_MS,
  parseFrontmatter,
  parseContextThreshold,
  buildContextPolicy,
  buildRunConfig,
  validateRunConfig,
  readRunConfig,
  writeRunConfig,
  buildContinuationPath,
  findContinuation,
  buildContinuationResumePrompt,
  validateContinuationContract,
};
