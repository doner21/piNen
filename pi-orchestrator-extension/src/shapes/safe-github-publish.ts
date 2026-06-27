/**
 * Shape: safe-github-publish
 * ===========================
 * Safe GitHub publishing orchestration shape — the default recommended method
 * for pushing sanitized repos to GitHub in piNen.
 *
 * Phases:
 *   1. Contract/intake (Planner): produces sanitization plan and allowlist
 *   2. Delegated sanitize/build/create/push (Executor): builds staging tree,
 *      runs local checks, creates private repo, pushes
 *   3. Remote safety verification (Verifier): independent clone and scan
 *
 * Properties:
 * - Bounded: uses SpawnGuard/substrate primitives; no unbounded loops
 * - Role integrity: visible/current role remains ORCHESTRATOR; executor and
 *   verifier do main-task work. Verifier falsifies if orchestrator ran
 *   staging/commit/push directly.
 * - No recursive /orchestrate: subagents use standard tool profiles
 * - Private-first: GitHub repos are created private by default
 *
 * ONE-LINE RULE: Shapes are siblings — they stand on the substrate, never
 * build on each other.
 */

import {
  SpawnGuard,
  spawnSubagent,
  runBoundedPool,
  formatRoutedModel,
  truncateWithNotice,
  throwIfAborted,
  type AgentProfile,
  type SubagentResult,
} from "../substrate";

import type {
  OrchestrationShape,
  OrchestrationShapeContext,
  OrchestrationShapeResult,
  NormalizedParams,
} from "../types";

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_FINAL_CHARS = 20_000;
const MAX_DETAIL_CHARS = 4_000;

// ── Shape export ───────────────────────────────────────────────────────────

export const safeGithubPublishShape: OrchestrationShape = {
  name: "safe-github-publish",
  description:
    "Safe GitHub publishing: contract/intake → delegated sanitize/build/create/push " +
    "by executor → independent remote verification. Private-first repo creation. " +
    "Enforces allowlist staging, gitleaks scanning, path denylists, and role integrity. " +
    "This is the default recommended method for GitHub publishing in piNen.",
  run: runSafeGithubPublish,
};

// ── Types ──────────────────────────────────────────────────────────────────

interface PublishResult {
  phase: string;
  status: "pass" | "fail";
  repoUrl?: string;
  commitHash?: string;
  stagingPath?: string;
  evidence: string[];
  failures: string[];
}

// ── Main loop ──────────────────────────────────────────────────────────────

async function runSafeGithubPublish(
  context: OrchestrationShapeContext,
): Promise<OrchestrationShapeResult> {
  const { params, signal, onUpdate, inheritedModel, agents } = context;
  const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }] });

  const spawnGuard = new SpawnGuard(params.maxSubagents);
  const evidence: string[] = [];
  const failures: string[] = [];

  emit(
    `safe-github-publish: starting safe publish pipeline for task: ${truncateWithNotice(params.task, 200, "task")}`,
  );
  emit(
    `safe-github-publish: max subagents=${spawnGuard.cap}, ` +
    `concurrency=${params.concurrency}, max retries=${params.maxRetries}`,
  );

  throwIfAborted(signal);

  // ── Phase 1: Plan / Contract (Planner) ─────────────────────────────────
  emit("Phase 1: Planning publish contract...");
  const plannerOverride = toModelOverride(params.plannerModel, params.plannerProvider);

  const planResult = await spawnSubagent(
    params.plannerAgent,
    buildPlannerPrompt(params),
    {
      agents,
      cwd: params.cwd,
      allowLocalModel: params.allowLocalModel,
      signal,
      inheritedModel,
      onProgress: emit,
      modelOverride: plannerOverride,
    },
  );
  spawnGuard.reserve();

  emit(
    `Planner finished: ${planResult.agentName} ` +
    `(${planResult.provider || "default"}/${planResult.model || "default"}, ${planResult.durationMs}ms)`,
  );
  evidence.push(`Planner spawned: ${planResult.agentName}`);

  // ── Phase 2: Delegate to Executor ──────────────────────────────────────
  emit("Phase 2: Delegating sanitize/build/create/push to executor...");
  const executorOverride = toModelOverride(params.executorModel, params.executorProvider);

  const executorResult = await spawnSubagent(
    params.executorAgent,
    buildExecutorPrompt(params, planResult.text),
    {
      agents,
      cwd: params.cwd,
      allowLocalModel: params.allowLocalModel,
      signal,
      inheritedModel,
      onProgress: emit,
      modelOverride: executorOverride,
    },
  );
  spawnGuard.reserve();

  emit(
    `Executor finished: ${executorResult.agentName} ` +
    `(${executorResult.provider || "default"}/${executorResult.model || "default"}, ${executorResult.durationMs}ms)`,
  );
  evidence.push(`Executor spawned: ${executorResult.agentName}`);

  // Parse executor result for repo URL and commit hash
  const execParsed = parsePublishResult(executorResult.text);

  // ── Phase 3: Independent Verification ──────────────────────────────────
  emit("Phase 3: Independent remote verification...");
  const verifierOverride = toModelOverride(params.verifierModel, params.verifierProvider);

  // Build verifier agents with evidence-gathering tools (read, bash, grep)
  const verifierAgents = buildVerifierAgents(agents, params.verifierAgent);

  const verifierResult = await spawnSubagent(
    params.verifierAgent,
    buildVerifierPrompt(params, execParsed, executorResult.text),
    {
      agents: verifierAgents,
      cwd: params.cwd,
      allowLocalModel: params.allowLocalModel,
      signal,
      inheritedModel,
      onProgress: emit,
      modelOverride: verifierOverride,
    },
  );
  spawnGuard.reserve();

  emit(
    `Verifier finished: ${verifierResult.agentName} ` +
    `(${verifierResult.provider || "default"}/${verifierResult.model || "default"}, ${verifierResult.durationMs}ms)`,
  );
  evidence.push(`Verifier spawned: ${verifierResult.agentName}`);

  // Parse verifier verdict
  const verifyParsed = parseVerdict(verifierResult.text);

  // ── Build final result ─────────────────────────────────────────────────
  const finalStatus: "pass" | "fail" = verifyParsed.passed ? "pass" : "fail";

  if (verifyParsed.passed) {
    evidence.push("Remote verification: PASS");
  } else {
    failures.push(`Remote verification: FAIL — ${verifyParsed.reasons.join("; ")}`);
  }

  if (execParsed.repoUrl) {
    evidence.push(`Repo URL: ${execParsed.repoUrl}`);
  }
  if (execParsed.commitHash) {
    evidence.push(`Commit: ${execParsed.commitHash}`);
  }

  const markdown = buildMarkdown(finalStatus, params, spawnGuard, execParsed, verifyParsed, evidence, failures);
  const details = buildDetails(finalStatus, params, spawnGuard, execParsed, verifyParsed, evidence, failures);

  return { markdown, details };
}

// ── Prompts ────────────────────────────────────────────────────────────────

function buildPlannerPrompt(params: NormalizedParams): string {
  return `You are the PLANNER for a safe-github-publish orchestration.
Your ONLY job is to produce a publish plan and sanitization contract. Do NOT execute, copy files, create repos, or push.

TASK: ${params.task}

Produce a structured plan in JSON format with these fields:
{
  "targetRepoName": "string",
  "sourcePath": "string (absolute path to source)",
  "stagingStrategy": "string (allowlist copy, never copy .git or runtime)",
  "allowlist": ["path1", "path2", ...],
  "denylist": ["pattern1", "pattern2", ...],
  "requiredDocs": ["doc1", "doc2", ...],
  "requiredTemplates": ["template1", "template2", ...],
  "localCheckGates": ["gitleaks detect", "path denylist scan", ...],
  "repoVisibility": "private",
  "installerRequired": true,
  "roleIntegrityNote": "visible orchestrator must not execute staging/commit/push"
}

IMPORTANT CONSTRAINTS:
- Never copy source .git/ directory or nested .git/ directories.
- Never copy secrets, auth files, tokens, session data, runtime state.
- Never include personal paths, emails, or project memory.
- Use allowlist-only copying (never broad recursive root copy).
- Repository must be created PRIVATE first.
- Include a one-click Windows installer (install.ps1).
- Include the safe-github-publish shape in the published repo.

Return ONLY the JSON object (no markdown fences, no commentary).`;
}

function buildExecutorPrompt(params: NormalizedParams, planText: string): string {
  return `You are the EXECUTOR for a safe-github-publish orchestration.
Your job is to sanitize, build, create, and push. The planner produced this contract:

${planText}

EXECUTION REQUIREMENTS:
1. Create a clean staging tree OUTSIDE the source directory using the planner's allowlist.
2. NEVER copy source .git/ history or nested .git/ directories.
3. Sanitize all files: remove personal paths, emails, tokens, secrets.
4. Create required docs, templates, and the one-click Windows installer (install.ps1).
5. Preserve piNen logo above-editor behavior in pinen-logo.ts.
6. Run local verification gates BEFORE any commit/push:
   - gitleaks detect (secret scanning)
   - Path denylist scan (no auth.json, sessions/, etc.)
   - Personal path/email scan (no donor names/paths)
   - Installer static sanity check (powershell -File ./install.ps1 -DryRun)
7. git init -b main in the staging directory.
8. Create a PRIVATE GitHub repo (gh repo create <owner>/<name> --private).
9. Push only if ALL local checks pass.
10. Record: staging path, commit hash, remote URL, repo visibility.

ABORT if:
- Any secret or personal data is found in staging.
- Any denylisted path exists in staging.
- GitHub authentication is unavailable.
- Local checks fail.
- Installer is missing or unsafe.

Return a JSON result:
{
  "status": "pass|fail",
  "repoUrl": "https://github.com/<owner>/<name>",
  "commitHash": "abc123...",
  "stagingPath": "/path/to/staging",
  "repoVisibility": "private",
  "includedManifest": ["file1", "file2", ...],
  "excludedItems": ["item1", "item2", ...],
  "checksRun": ["check1", "check2", ...],
  "failures": ["reason1 if any"],
  "roleIntegrityStatement": "The visible orchestrator did not execute staging/sanitization/commit/repo-create/push."
}`;
}

function buildVerifierPrompt(
  params: NormalizedParams,
  execParsed: PublishResult,
  executorText: string,
): string {
  const repoUrl = execParsed.repoUrl || "(not yet determined)";
  return `You are the VERIFIER for a safe-github-publish orchestration.
Your job is to INDEPENDENTLY verify the published repository.
Do NOT rely solely on the executor's narrative — gather your own evidence.

EXECUTOR CLAIMS:
${executorText.substring(0, 2000)}

VERIFICATION GATES:
1. Clone the remote repo (if URL is known): git clone --depth 1 ${repoUrl} verify-push
2. Check repo metadata: name, visibility (must be private), default branch.
3. Run denylisted path scan: no auth.json, mcp.json, sessions/, node_modules/, .env, tokens, etc.
4. Run gitleaks detect (secret scanning).
5. Run personal path/email scan: no donor names, emails, or absolute paths.
6. Verify fresh git history: only 1 commit, no inherited source history.
7. Verify required artifacts exist:
   - install.ps1 (one-click installer)
   - pi-orchestrator-extension/src/shapes/safe-github-publish.ts (the shape itself)
   - pinen-logo.ts with aboveEditor placement
   - saafe-github-publish documented as default publishing method
8. Installer static check: powershell -File ./install.ps1 -DryRun
9. Verify no runtime state, sessions, run artifacts, graphify-brain data, or personal project memory.

CRITICAL ROLE-INTEGRITY CHECK:
- Verify the orchestrator role ledger shows the VISIBLE/CURRENT orchestrator did NOT execute staging/sanitization/commit/repo-create/push.
- FAIL if the visible orchestrator performed main-task execution directly.
- FAIL if the requested safe-github-publish shape was replaced by a different shape.

Return JSON:
{
  "passed": true|false,
  "reasons": ["evidence-based reason 1", "reason 2", ...],
  "evidence": [
    {"gate": "gate name", "status": "pass|fail", "detail": "evidence"}
  ],
  "roleIntegrity": "pass|fail"
}`;
}

// ── Parsing ────────────────────────────────────────────────────────────────

function parsePublishResult(text: string): PublishResult {
  const parsed = extractJson(text);
  if (parsed && typeof parsed === "object") {
    const raw = parsed as Record<string, unknown>;
    return {
      phase: "executor",
      status: String(raw.status || "").toLowerCase() === "pass" ? "pass" : "fail",
      repoUrl: typeof raw.repoUrl === "string" ? raw.repoUrl : undefined,
      commitHash: typeof raw.commitHash === "string" ? raw.commitHash : undefined,
      stagingPath: typeof raw.stagingPath === "string" ? raw.stagingPath : undefined,
      evidence: [],
      failures: Array.isArray(raw.failures) ? raw.failures.map(String) : [],
    };
  }
  return {
    phase: "executor",
    status: "fail",
    repoUrl: undefined,
    evidence: [],
    failures: ["Could not parse executor result JSON."],
  };
}

interface VerdictParsed {
  passed: boolean;
  reasons: string[];
  evidence: Array<{ gate: string; status: string; detail: string }>;
  roleIntegrity: string;
}

function parseVerdict(text: string): VerdictParsed {
  const parsed = extractJson(text);
  if (parsed && typeof parsed === "object") {
    const raw = parsed as Record<string, unknown>;
    const passed = String(raw.passed ?? raw.overall ?? "").toLowerCase() === "true" ||
      String(raw.passed ?? raw.overall ?? "").toLowerCase() === "pass";
    return {
      passed,
      reasons: Array.isArray(raw.reasons) ? raw.reasons.map(String) : [],
      evidence: Array.isArray(raw.evidence)
        ? raw.evidence.map((e: unknown) => {
            if (e && typeof e === "object") {
              const obj = e as Record<string, unknown>;
              return {
                gate: String(obj.gate || ""),
                status: String(obj.status || ""),
                detail: String(obj.detail || ""),
              };
            }
            return { gate: "", status: "fail", detail: String(e) };
          })
        : [],
      roleIntegrity: String(raw.roleIntegrity || "unknown"),
    };
  }
  return {
    passed: false,
    reasons: ["Could not parse verifier result JSON."],
    evidence: [],
    roleIntegrity: "unknown",
  };
}

// ── Verifier agent profile (with evidence-gathering tools) ────────────────

function buildVerifierAgents(
  agents: Map<string, AgentProfile>,
  verifierAgent: string,
): Map<string, AgentProfile> {
  const cloned = new Map(agents);
  const profile = agents.get(verifierAgent) ?? { name: verifierAgent };
  const tools = new Set((profile.tools ?? []).map((t) => String(t).trim()).filter(Boolean));
  tools.add("read");
  tools.add("bash");
  tools.add("grep");
  cloned.set(verifierAgent, { ...profile, name: verifierAgent, tools: [...tools] });
  return cloned;
}

// ── Result builders ────────────────────────────────────────────────────────

function buildMarkdown(
  status: "pass" | "fail",
  params: NormalizedParams,
  spawnGuard: SpawnGuard,
  execParsed: PublishResult,
  verifyParsed: VerdictParsed,
  evidence: string[],
  failures: string[],
): string {
  const lines: string[] = [
    `# safe-github-publish Orchestration: ${status.toUpperCase()}`,
    "",
    `**Task:** ${truncateWithNotice(params.task, 500, "task")}`,
    `**Paradigm:** safe-github-publish (default GitHub publishing method)`,
    `**Subagents spawned:** ${spawnGuard.spawned}/${spawnGuard.cap}`,
    "",
  ];

  if (execParsed.repoUrl) {
    lines.push(`**Remote URL:** ${execParsed.repoUrl}`);
  }
  if (execParsed.commitHash) {
    lines.push(`**Commit:** ${execParsed.commitHash}`);
  }
  if (execParsed.stagingPath) {
    lines.push(`**Staging path:** ${execParsed.stagingPath}`);
  }

  lines.push("", "## Execution Evidence");
  for (const item of evidence) {
    lines.push(`- ${item}`);
  }

  lines.push("", "## Verification Gates");
  for (const gate of verifyParsed.evidence) {
    lines.push(`- **${gate.gate}** [${gate.status.toUpperCase()}] ${gate.detail}`);
  }

  lines.push("", "## Role Integrity");
  lines.push(`- Verifier assessment: ${verifyParsed.roleIntegrity}`);
  lines.push("- Visible/current orchestrator must not have executed staging/commit/create/push");
  lines.push("- Executor and verifier performed main-task work");

  if (failures.length > 0) {
    lines.push("", "## Failures");
    for (const f of failures) {
      lines.push(`- ${f}`);
    }
  }

  return truncateWithNotice(lines.join("\n"), MAX_FINAL_CHARS, "final safe-github-publish report");
}

function buildDetails(
  status: "pass" | "fail",
  params: NormalizedParams,
  spawnGuard: SpawnGuard,
  execParsed: PublishResult,
  verifyParsed: VerdictParsed,
  evidence: string[],
  failures: string[],
): Record<string, unknown> {
  return {
    status,
    paradigm: "safe-github-publish",
    params: { ...params, task: truncateWithNotice(params.task, MAX_DETAIL_CHARS, "task") },
    spawnedCount: spawnGuard.spawned,
    spawnedCap: spawnGuard.cap,
    repoUrl: execParsed.repoUrl,
    commitHash: execParsed.commitHash,
    stagingPath: execParsed.stagingPath,
    evidence,
    failures,
    verificationGates: verifyParsed.evidence,
    roleIntegrity: verifyParsed.roleIntegrity,
  };
}

// ── Local utilities ────────────────────────────────────────────────────────

function toModelOverride(
  model?: string,
  provider?: string,
): { model?: string; provider?: string } | undefined {
  if (!model && !provider) return undefined;
  return { model, provider };
}

function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  for (const candidate of [
    trimmed,
    ...extractFenceContents(trimmed),
    extractBalancedObject(trimmed),
  ].filter(Boolean) as string[]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // next
    }
  }
  return null;
}

function extractFenceContents(text: string): string[] {
  const results: string[] = [];
  const regex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) results.push(match[1].trim());
  return results;
}

function extractBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
