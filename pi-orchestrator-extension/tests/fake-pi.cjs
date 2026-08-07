#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", main);

function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function agentNameFromSystemPrompt() {
  const systemPromptPath = argValue("--append-system-prompt") || "unknown-system-prompt.txt";
  return path.basename(systemPromptPath).replace(/-system-prompt\.txt$/, "") || "unknown";
}

function promptText() {
  if (stdin.trim()) return stdin;
  const last = args[args.length - 1];
  return last && !last.startsWith("--") ? last : "";
}

function extractIntake(prompt) {
  const marker = "INTAKE CONTRACT:\n";
  const start = prompt.indexOf(marker);
  if (start < 0) return null;
  const bodyStart = start + marker.length;
  const terminators = ["\n\nRules:", "\n\nFull plan:", "\n\nPlan:"];
  const bodyEnd = terminators
    .map((terminator) => prompt.indexOf(terminator, bodyStart))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? prompt.length;
  try {
    return JSON.parse(prompt.slice(bodyStart, bodyEnd).trim());
  } catch {
    return null;
  }
}

function countLogRecords(agentName) {
  const logPath = process.env.FAKE_PI_LOG;
  if (!logPath || !fs.existsSync(logPath)) return 0;
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  let count = 0;
  for (const line of lines) {
    try {
      if (JSON.parse(line).agentName === agentName) count++;
    } catch {
      // skip malformed lines
    }
  }
  return count;
}

/**
 * Judgment-hardening fixture behaviors (env-driven):
 * - FAKE_PI_PLAN_STYLE: "impl-1" | "impl-3" — planner emits CREATE-file tasks.
 * - FAKE_PI_EXECUTOR_STYLE:
 *   - "write-summary-table": really writes the target file, emits write/bash
 *     tool_execution events, replies with a markdown summary table (the
 *     Ramen Don false-FAIL reply shape).
 *   - "claims-no-write": claims files were created, writes nothing, no tool
 *     events (the 2026-06-03 false-PASS executor shape).
 * - FAKE_PI_VERIFIER_SEQUENCE: comma-separated per-verifier-call specs,
 *   e.g. "fail:task-2,pass" (consumed in call order via the log).
 * - provider "badprov": exits 1 with a structured 429 payload on stderr
 *   (pre-flight failure fixture).
 */
function respond(prompt) {
  if (prompt.includes("SHAPE-BUILDER IMPLEMENTATION VERIFIER")) {
    const status = process.env.FAKE_PI_SHAPE_BUILDER_VERIFIER_STATUS || "pass";
    const targetName = (prompt.match(/Target shape:\s*(\S+)/) || ["", "fixture-target"])[1];
    const lifecyclePath = (prompt.match(/Lifecycle state path:\s*(\S+)/) || ["", "/tmp/fixture-lifecycle.json"])[1];

    if (status === "fail") {
      return {
        toolEvents: [],
        text: JSON.stringify({
          overall: "fail",
          implemented_verified: false,
          reloadRequired: false,
          targetName,
          lifecycleStatePath: lifecyclePath,
          checks: [
            { id: "files", status: "pass", citations: ["src/shapes/fixture.ts:1"] },
            { id: "registry", status: "pass", citations: ["src/index.ts:123"] },
            { id: "docs", status: "pass", citations: ["README.md:45"] },
            { id: "tests", status: "fail", citations: ["command: exit 1"] },
            { id: "forbidden-behavior", status: "pass", citations: ["grep: no forbidden calls"] },
            { id: "sibling-rule", status: "pass", citations: ["grep: no sibling imports"] },
            { id: "lifecycle", status: "pass", citations: ["shape-builder-lifecycle/fixture.json:1"] },
            { id: "canary-template", status: "pass", citations: ["src/shapes/fixture.ts:5"] },
          ],
          commands: [
            { command: "node tests/test-fixture.cjs", exitCode: 1, stdoutSnippet: "FAIL" },
            { command: "npm test", exitCode: 0, stdoutSnippet: "PASS" },
          ],
          failReasons: ["Fixture verifier forced failure: tests check failed."],
        }),
      };
    }

    return {
      toolEvents: [
        { type: "tool_execution_start", toolName: "bash" },
        { type: "tool_execution_end", toolName: "bash" },
        { type: "tool_execution_start", toolName: "read" },
        { type: "tool_execution_end", toolName: "read" },
      ],
      text: JSON.stringify({
        overall: "pass",
        implemented_verified: true,
        reloadRequired: true,
        targetName,
        lifecycleStatePath: lifecyclePath,
        checks: [
          { id: "files", status: "pass", citations: ["src/shapes/" + targetName + ".ts:1", "tests/test-" + targetName + ".cjs:1"] },
          { id: "registry", status: "pass", citations: ["src/index.ts: shapeRegistry includes " + targetName] },
          { id: "docs", status: "pass", citations: ["README.md:generated shapes section", "PARADIGMS.md:generated shapes section"] },
          { id: "tests", status: "pass", citations: ["command: node tests/test-" + targetName + ".cjs exit 0", "command: npm test exit 0"] },
          { id: "forbidden-behavior", status: "pass", citations: ["grep: no agent_reload_runtime/agent_scheduler/executeCommand/sendUserMessage/orchestrate"] },
          { id: "sibling-rule", status: "pass", citations: ["grep: no sibling-shape imports in src/shapes/" + targetName + ".ts"] },
          { id: "lifecycle", status: "pass", citations: [lifecyclePath + ": status implementation_reported"] },
          { id: "canary-template", status: "pass", citations: ["src/shapes/" + targetName + ".ts: SHAPE_CANARY branch present"] },
        ],
        commands: [
          { command: "node tests/test-" + targetName + ".cjs", exitCode: 0, stdoutSnippet: "PASS " + targetName + ": static rules, canary branch" },
          { command: "npm test", exitCode: 0, stdoutSnippet: "PASS paradigm-creator: registry, static rules, helpers, propose-mode no-file-write" },
        ],
        failReasons: [],
      }),
    };
  }

  // paradigm-creator assessment fixture
  if (prompt.includes("PARADIGM-CREATOR ASSESSMENT")) {
    return {
      toolEvents: [],
      text: JSON.stringify({
        action: "create",
        confidence: 0.91,
        rationale: "The requested red-team / blue-team / judge loop is a reusable orchestration pattern not covered by the current explicit paradigms.",
        targetName: "red-team-judge",
        downstreamTask: "Run a bounded adversarial review loop for a migration audit.",
        spec: {
          name: "red-team-judge",
          purpose: "Run bounded adversarial review with a red-team critique, blue-team response, and judge synthesis.",
          phases: [
            {
              name: "red-team",
              role: "critic",
              agentName: "reviewer",
              prompt: "Critique the task or implementation and identify concrete risks with evidence.",
              expectedOutput: "A concise risk list with evidence and severity."
            },
            {
              name: "blue-team",
              role: "defender",
              agentName: "coder",
              prompt: "Respond to each red-team risk with mitigations or implementation changes.",
              expectedOutput: "A mitigation plan or patch summary mapped to each risk."
            },
            {
              name: "judge",
              role: "arbiter",
              agentName: "reviewer",
              prompt: "Judge whether the mitigations satisfy the risks and produce a final verdict.",
              expectedOutput: "PASS or FAIL with cited reasons."
            }
          ],
          maxSubagents: 3,
          maxIterations: 1,
          terminationCondition: "Stop after exactly one red-team, one blue-team, and one judge phase.",
          evidenceModel: "The judge verdict cites red-team risks and blue-team mitigations.",
          failureBehavior: "Fail if any phase exits nonzero or the judge returns unresolved high-severity risks.",
          userFacingExplanation: "This orchestration used a bounded adversarial review: critique, response, then independent judgment."
        }
      }),
    };
  }

  // dual-plan-synthesis-execute-verify fixture
  if (prompt.includes("dual-plan-synthesis-execute-verify orchestration")) {
    if (prompt.includes("independent implementation plan only")) {
      const mutating = process.env.FAKE_PI_DUAL_PLAN_MUTATING === "1";
      return {
        toolEvents: mutating ? [
          { type: "tool_execution_start", toolName: "bash" },
          { type: "tool_execution_end", toolName: "bash" },
        ] : [],
        text: "Fixture independent plan: inspect target, apply minimal patch, run targeted verification.",
      };
    }
    if (prompt.includes("synthesis reviewer")) {
      return { toolEvents: [], text: "Fixture synthesized plan: implement the minimal safe patch and verify the targeted invariant." };
    }
    if (prompt.includes("You are the executor")) {
      return {
        toolEvents: [
          { type: "tool_execution_start", toolName: "edit" },
          { type: "tool_execution_end", toolName: "edit" },
          { type: "tool_execution_start", toolName: "bash" },
          { type: "tool_execution_end", toolName: "bash" },
        ],
        text: "Fixture executor changed the target file and ran static checks successfully.",
      };
    }
    if (prompt.includes("direct-evidence verifier")) {
      const status = process.env.FAKE_PI_DUAL_VERIFIER_STATUS === "fail" ? "fail" : "pass";
      return {
        toolEvents: [],
        text: JSON.stringify({
          status,
          reasons: [status === "pass" ? "fixture direct evidence satisfied" : "fixture verifier forced failure"],
          feedback: status === "pass" ? "" : "address fixture verifier feedback",
          evidence: ["fixture diff inspected", "fixture static check passed"],
        }),
      };
    }
  }

  // verify-only paradigm fixture
  if (prompt.includes("VERIFICATION-ONLY orchestration")) {
    return {
      toolEvents: [],
      text: JSON.stringify({
        overall: "pass",
        reasons: ["all checks verified against cited evidence"],
        checks: [
          { id: "check-1", description: "fixture evidence check", status: "pass", citations: ["out-1.txt:1"] },
        ],
      }),
    };
  }

  // Ordered composable-pipeline fixture. It provides two independent candidate
  // plans, critiques, a parseable synthesized final plan, mutating execution,
  // and an env-driven verifier sequence for bounded retry tests.
  if (process.env.FAKE_PI_COMPOSABLE_ORDER_RETRY === "1") {
    if (/You are researcher \d+ of \d+ in a composable orchestration pipeline/.test(prompt)) {
      return { toolEvents: [], text: "Fixture research: inspected constraints and found one bounded implementation target." };
    }
    if (/You are independent planner \d+ of \d+ in a composable orchestration pipeline/.test(prompt)) {
      return {
        toolEvents: [],
        text: JSON.stringify({
          tasks: [{ id: "task-1", description: `CREATE the fixture target using candidate ${process.pid}.`, dependsOn: [] }],
          notes: `independent candidate plan from pid ${process.pid}`,
        }),
      };
    }
    if (/You are critic \d+ of \d+ in a composable orchestration pipeline/.test(prompt)) {
      return { toolEvents: [], text: "Fixture critique: compared both candidate plans and retained the smallest safe task." };
    }
    if (/You are synthesizer \d+ of \d+ in a composable orchestration pipeline/.test(prompt)) {
      return {
        toolEvents: [],
        text: JSON.stringify({
          tasks: [{ id: "task-1", description: "CREATE the final synthesized fixture target.", dependsOn: [] }],
          notes: "fixture final plan from synthesis",
        }),
      };
    }
    if (prompt.includes("You are executing one task from a deterministic composable orchestration.")) {
      return {
        toolEvents: [
          { type: "tool_execution_start", toolName: "edit" },
          { type: "tool_execution_end", toolName: "edit" },
        ],
        text: "Fixture executor applied the final synthesized plan.",
      };
    }
    if (/You are verifier \d+ of \d+ in a composable orchestration/.test(prompt)) {
      const specs = (process.env.FAKE_PI_COMPOSABLE_VERIFIER_SEQUENCE || "pass")
        .split(",").map((item) => item.trim()).filter(Boolean);
      const callIndex = Math.max(0, countLogRecords("reviewer") - 1);
      const spec = specs[Math.min(callIndex, specs.length - 1)] || "pass";
      const status = spec.startsWith("fail") ? "fail" : "pass";
      let cleanupArtifact = null;
      if (process.env.FAKE_PI_COMPOSABLE_VERIFIER_ARTIFACT === "1") {
        const match = prompt.match(/use only this run-owned directory:\s*([^\n]+)/i);
        if (match) {
          cleanupArtifact = path.join(match[1].trim(), `verifier-${process.pid}.json`);
          fs.mkdirSync(path.dirname(cleanupArtifact), { recursive: true });
          fs.writeFileSync(cleanupArtifact, JSON.stringify({ status }), "utf8");
        }
      }
      return {
        toolEvents: cleanupArtifact ? [
          { type: "tool_execution_start", toolName: "write" },
          { type: "tool_execution_end", toolName: "write" },
        ] : [],
        text: JSON.stringify({
          status,
          reasons: [`fixture composable verifier ${status}`],
          cleanupArtifact,
        }),
      };
    }
  }

  if (
    process.env.FAKE_PI_COMPOSABLE_PLAN_DEFAULT_ROUTE === "1" &&
    /You are (?:independent )?planner(?: \d+ of \d+)? in a composable orchestration pipeline/.test(prompt)
  ) {
    return {
      toolEvents: [],
      text: JSON.stringify({
        tasks: [{
          id: "task-1",
          description: "Execute the requested validation task.",
          dependsOn: [],
          agent: "coder",
          role: "validation",
          provider: "default",
          model: "default",
        }],
        notes: "Planner placeholders must inherit the configured executor route.",
      }),
    };
  }

  if (prompt.includes("Plan the following task")) {
    const style = process.env.FAKE_PI_PLAN_STYLE;
    if (style === "impl-1") {
      return {
        toolEvents: [],
        text: JSON.stringify({
          tasks: [{ id: "task-1", description: "CREATE file out-1.txt with the fixture content.", dependsOn: [] }],
          notes: "fixture impl plan (1 task)",
        }),
      };
    }
    if (style === "impl-1-ws") {
      // Same single CREATE task, but the planner also declares its predicted
      // write set (predict-then-write fixtures).
      return {
        toolEvents: [],
        text: JSON.stringify({
          tasks: [{ id: "task-1", description: "CREATE file out-1.txt with the fixture content.", dependsOn: [] }],
          notes: "fixture impl plan (1 task, predicted write set)",
          predicted_write_set: ["out-1.txt"],
        }),
      };
    }
    if (style === "impl-3") {
      return {
        toolEvents: [],
        text: JSON.stringify({
          tasks: [1, 2, 3].map((n) => ({
            id: `task-${n}`,
            description: `CREATE file out-${n}.txt with the fixture content.`,
            dependsOn: [],
          })),
          notes: "fixture impl plan (3 tasks)",
        }),
      };
    }
    if (style === "analysis-4") {
      return {
        toolEvents: [],
        text: JSON.stringify({
          tasks: [1, 2, 3, 4].map((n) => ({
            id: `task-${n}`,
            description: `Analyze tiny independent item ${n} and return the token item-${n}.`,
            dependsOn: [],
            outputType: "analysis",
          })),
          notes: "fixture analysis plan (4 independent tasks)",
        }),
      };
    }
    const intake = extractIntake(prompt);
    const researcherCount = intake?.orchestration_controls?.researcherCount || 0;
    if (researcherCount) {
      return {
        toolEvents: [],
        text: JSON.stringify({
          tasks: [
            {
              id: "task-1",
              description: "Research perspective A: inspect routing/intake normalization and explain why model routing can default incorrectly.",
              dependsOn: [],
              agent: "researcher",
              role: "routing-intake-researcher"
            },
            {
              id: "task-2",
              description: "Research perspective B: inspect orchestration language controls and map natural-language knobs to structured fields.",
              dependsOn: [],
              agent: "researcher",
              role: "orchestration-language-researcher"
            }
          ].slice(0, researcherCount),
          notes: `Created ${researcherCount} researcher task(s) because the intake contract requested researcher coverage.`
        }),
      };
    }
    const defaultTask = {
      id: "task-1",
      description: "Execute the requested work while preserving the intake constraints and routing contract.",
      dependsOn: [],
      agent: "coder",
      role: "implementation"
    };
    if (process.env.FAKE_PI_CONFLICT_EXECUTOR_ROUTE === "1") {
      defaultTask.provider = "deepseek";
      defaultTask.model = "deepseek-v4-flash";
    }
    return {
      toolEvents: [],
      text: JSON.stringify({ tasks: [defaultTask], notes: "Created one default coder executor task." }),
    };
  }

  if (prompt.includes("Verify the orchestration result")) {
    const sequence = process.env.FAKE_PI_VERIFIER_SEQUENCE;
    if (sequence) {
      const specs = sequence.split(",").map((s) => s.trim()).filter(Boolean);
      const callIndex = Math.max(0, countLogRecords("reviewer") - 1);
      const spec = specs[Math.min(callIndex, specs.length - 1)] || "pass";
      if (spec.startsWith("fail")) {
        const taskRef = spec.split(":")[1];
        return {
          toolEvents: [],
          text: JSON.stringify({
            status: "fail",
            reasons: [
              taskRef
                ? `${taskRef}: output file content incorrect — regenerate ${taskRef} only; other tasks are correct on disk`
                : "deterministic fake verifier forced failure",
            ],
          }),
        };
      }
      return { toolEvents: [], text: JSON.stringify({ status: "pass", reasons: ["fixture verifier pass"] }) };
    }
    const status = process.env.FAKE_PI_VERIFIER_STATUS === "fail" ? "fail" : "pass";
    return {
      toolEvents: [],
      text: JSON.stringify({
        status,
        reasons: [
          status === "pass"
            ? "deterministic fake verifier accepted outputs and routing evidence"
            : "deterministic fake verifier forced failure"
        ]
      }),
    };
  }

  if (prompt.includes("You are executing one task")) {
    const style = process.env.FAKE_PI_EXECUTOR_STYLE;
    if (style === "write-summary-table") {
      const match = prompt.match(/CREATE file ([\w./\\-]+)/i);
      const file = match ? match[1] : "fixture-out.txt";
      fs.writeFileSync(path.resolve(process.cwd(), file), `fixture content for ${file} written at ${new Date().toISOString()}\n`, "utf8");
      return {
        toolEvents: [
          { type: "tool_execution_start", toolName: "write" },
          { type: "tool_execution_end", toolName: "write" },
          { type: "tool_execution_start", toolName: "bash" },
          { type: "tool_execution_end", toolName: "bash" },
        ],
        // Ramen Don false-FAIL reply shape: a summary table, no prose about
        // files, long enough and pipe-terminated to trip legacy heuristics.
        text: [
          "| Task | Status | Artifact |",
          "|------|--------|----------|",
          `| ${file} | done | ${file} |`,
          "| build | ok | n/a |",
          "| tests | ok | n/a |",
          "| lint | ok | n/a |",
          "| typecheck | ok | n/a |",
          "| summary | implementation finished | table |",
        ].join("\n"),
      };
    }
    if (style === "claims-no-write") {
      return {
        toolEvents: [],
        text: "I created file out-1.txt and modified src/app.ts as requested. All requested implementation work is complete and verified.",
      };
    }
  }

  // frozen-gate-fix-loop executor (bounded-fix) fixture
  if (prompt.includes("You are the EXECUTOR in a frozen-gate-fix-loop orchestration")) {
    // Optional tamper variant: rewrite the frozen doc so the re-verify-freeze
    // deterministic phase (phase 3) detects a mismatch and FAILs the run.
    if (process.env.FAKE_PI_FGFL_TAMPER === "1") {
      const m = prompt.match(/FROZEN_DOC_ABS:\s*(.+)/);
      if (m) {
        try { fs.writeFileSync(m[1].trim(), `tampered by executor at ${new Date().toISOString()}\n`, "utf8"); } catch {}
      }
    }
    // Bounded fix: write ONLY a scoped marker file to cwd (never the frozen doc).
    try {
      fs.writeFileSync(path.resolve(process.cwd(), "bounded-fix-marker.txt"), `bounded fix applied at ${new Date().toISOString()}\n`, "utf8");
    } catch {}
    return {
      toolEvents: [
        { type: "tool_execution_start", toolName: "write" },
        { type: "tool_execution_end", toolName: "write" },
        { type: "tool_execution_start", toolName: "bash" },
        { type: "tool_execution_end", toolName: "bash" },
      ],
      text: [
        "## Bounded Fix Applied",
        "- Fixed exactly the enumerated findings; no restructuring beyond scope.",
        "- Frozen gate document was NOT modified.",
        "- Reran the gate pipeline with the fresh run-id; evidence artifacts are run-id-bound.",
        "## Files Touched",
        "- bounded-fix-marker.txt",
      ].join("\n"),
    };
  }

  // frozen-gate-fix-loop verifier fixture
  if (prompt.includes("You are the VERIFIER in a frozen-gate-fix-loop orchestration")) {
    const sequence = process.env.FAKE_PI_FGFL_VERIFIER_SEQUENCE;
    let overall = "pass";
    if (sequence) {
      const specs = sequence.split(",").map((s) => s.trim()).filter(Boolean);
      const callIndex = Math.max(0, countLogRecords("reviewer") - 1);
      overall = (specs[Math.min(callIndex, specs.length - 1)] || "pass").startsWith("fail") ? "fail" : "pass";
    } else {
      overall = process.env.FAKE_PI_FGFL_VERIFIER_STATUS === "fail" ? "fail" : "pass";
    }
    return {
      toolEvents: [],
      text: JSON.stringify({
        overall,
        reasons: [overall === "pass" ? "fixture verifier: findings resolved, fix stayed bounded, evidence run-id-bound" : "fixture verifier: residual finding not fully resolved"],
        feedback: overall === "pass" ? "" : "address the residual finding without restructuring beyond scope",
        evidence: ["fixture diff scope inspected", "fixture gate pipeline re-run"],
      }),
    };
  }

  // evidence-audit verifier fixture (single verifier; NO executor in this shape).
  // Env hooks: FAKE_PI_EVIDENCE_AUDIT_VERIFIER = pass | fail | unparseable.
  if (prompt.includes("You are the VERIFIER in an evidence-audit orchestration")) {
    const mode = process.env.FAKE_PI_EVIDENCE_AUDIT_VERIFIER || "pass";
    if (mode === "unparseable") {
      // Non-empty prose with no JSON verdict — the shape must fail-closed.
      return {
        toolEvents: [],
        text: [
          "I recomputed several of the gate hashes and inspected the run-id bindings.",
          "The evidence largely looks coherent but I cannot produce a definitive JSON verdict here.",
        ].join("\n"),
      };
    }
    const overall = mode === "fail" ? "fail" : "pass";
    return {
      toolEvents: [],
      text: JSON.stringify({
        overall,
        reasons: [overall === "pass"
          ? "fixture auditor: run-ids bound, gate JSONs recomputable from raw evidence, timestamps coherent"
          : "fixture auditor: a gate-evidence file carries a stale/mismatched run-id"],
        feedback: overall === "pass" ? "" : "rebind the stale evidence to the current run-id and re-run the gate",
        evidence: ["fixture recompute of gate metrics", "fixture run-id binding cross-check"],
      }),
    };
  }

  // independent-replication executor fixture (LANE A / LANE B).
  // Env hooks: FAKE_PI_IR_TAMPER=1 rewrites the frozen doc during LANE A so the
  // deterministic mid-re-verify detects a mismatch and FAILs the run.
  if (prompt.includes("in an independent-replication orchestration") && prompt.includes("You are the EXECUTOR for LANE")) {
    const isLaneA = prompt.includes("You are the EXECUTOR for LANE A");
    if (isLaneA && process.env.FAKE_PI_IR_TAMPER === "1") {
      const m = prompt.match(/A FROZEN gate document governs acceptance:\s*(.+)/);
      if (m) {
        try { fs.writeFileSync(m[1].trim(), `tampered by lane-A executor at ${new Date().toISOString()}\n`, "utf8"); } catch {}
      }
    }
    // Write a scoped marker file INSIDE the assigned lane subdirectory only.
    const laneMatch = prompt.match(/your assigned lane subdirectory:\s*(.+)/);
    if (laneMatch) {
      const laneDir = laneMatch[1].trim();
      try { fs.writeFileSync(path.resolve(laneDir, "impl-marker.txt"), `lane implementation written at ${new Date().toISOString()}\n`, "utf8"); } catch {}
    }
    return {
      toolEvents: [
        { type: "tool_execution_start", toolName: "write" },
        { type: "tool_execution_end", toolName: "write" },
      ],
      text: [
        `## Lane ${isLaneA ? "A" : "B"} Implementation`,
        "- Implemented the frozen gate independently inside my lane subdirectory.",
        "- All artifacts confined to my lane subdir; frozen gate document was NOT modified.",
        "## Files Created",
        "- impl-marker.txt",
      ].join("\n"),
    };
  }

  // independent-replication verifier fixture (LANE A / LANE B).
  // Env hooks: FAKE_PI_IR_LANEA_VERIFIER / FAKE_PI_IR_LANEB_VERIFIER = fail.
  if (prompt.includes("in an independent-replication orchestration") && prompt.includes("You are the VERIFIER for LANE")) {
    const isLaneB = prompt.includes("You are the VERIFIER for LANE B");
    let overall = "pass";
    if (isLaneB && process.env.FAKE_PI_IR_LANEB_VERIFIER === "fail") overall = "fail";
    if (!isLaneB && process.env.FAKE_PI_IR_LANEA_VERIFIER === "fail") overall = "fail";
    return {
      toolEvents: [],
      text: JSON.stringify({
        overall,
        reasons: [overall === "pass"
          ? `fixture lane ${isLaneB ? "B" : "A"} verifier: implementation satisfies the frozen gate, confined to the lane subdir`
          : `fixture lane ${isLaneB ? "B" : "A"} verifier: implementation does not satisfy the frozen gate`],
        feedback: "",
        evidence: ["fixture lane artifact inspection", "fixture gate re-check"],
      }),
    };
  }

  // win-console-spawn-root-cause planner fixture
  if (prompt.includes("You are the PLANNER in a win-console-spawn-root-cause investigation orchestration")) {
    return {
      toolEvents: [],
      text: [
        "## Boundaries",
        "- No broad core rewrites",
        "- No persistent system config changes",
        "- No Windows registry changes outside documented Pi paths",
        "",
        "## Hypotheses",
        "1. CREATE_NO_WINDOW flag missing on specific spawn paths in reload/new-session",
        "2. shell:true spawning intermediate cmd.exe with visible console",
        "3. Detached console allocation on child_process.spawn in extension/MCP launch",
        "4. node:wrapper spawning intermediate shell before Pi takes over",
        "",
        "## Instrumentation Plan",
        "1. Enable diagnostic spawn logging via PI_SPAWN_DIAG env var with timestamped log",
        "2. Capture parent PID, command line, executable path, shell usage, detached/window options",
        "3. Exercise reload lifecycle and record spawn events",
        "4. Exercise new-session lifecycle and record spawn events",
        "5. Exercise open-from-Terminal path and record spawn events",
        "",
        "## Scoped-out Items",
        "- Normal message-send flashes (already fixed)",
        "",
        "## Rollback Constraints",
        "- Any candidate fix must include exact rollback steps",
        "- No persistent system configuration changes",
        "",
        "## Uncertainty Notes",
        "- Hypothesis 2 and 4 need ProcMon or ETW verification",
      ].join("\n"),
    };
  }

  // win-console-spawn-root-cause executor fixture
  if (prompt.includes("You are the EXECUTOR in a win-console-spawn-root-cause investigation orchestration")) {
    const style = process.env.FAKE_PI_WIN_CONSOLE_EXECUTOR_STYLE;
    if (style === "static-grep-only") {
      return {
        toolEvents: [
          { type: "tool_execution_start", toolName: "grep" },
          { type: "tool_execution_end", toolName: "grep" },
        ],
        text: [
          "## Evidence Collected",
          "- src/reload.ts:120: grep result shows spawn call",
          "- src/launch.ts:45: grep result shows spawn with windowsHide",
          "## Findings",
          "- Found spawn calls in reload and launch paths",
          "## Candidate Fix",
          "- Add windowsHide to reload spawn",
          "## Rollback Path",
          "- Revert the flag addition",
          "## Open Questions",
          "- None",
          "## Files Touched",
          "- src/reload.ts",
        ].join("\n"),
      };
    }
    return {
      toolEvents: [
        { type: "tool_execution_start", toolName: "bash" },
        { type: "tool_execution_end", toolName: "bash" },
        { type: "tool_execution_start", toolName: "write" },
        { type: "tool_execution_end", toolName: "write" },
      ],
      text: [
        "## Evidence Collected",
        "- src/reload.ts:120: spawn(piPath, args, { shell: true }) — MISSING windowsHide",
        "- src/launch.ts:45: spawn(piPath, args, { windowsHide: true, detached: true }) ✓",
        "- Diagnostic log captured 3 spawn events during reload: PID 1234 shell=cmd.exe, PID 1235 shell=none windowsHide=true, PID 1236 shell=none windowsHide=false",
        "",
        "## Findings",
        "- Reload path at src/reload.ts:120 spawns with shell:true but no windowsHide flag",
        "- This creates an intermediate cmd.exe process with a visible console window",
        "- New-session and main launch paths correctly use windowsHide: true",
        "- Normal message-send paths were already fixed (scoped out)",
        "",
        "## Candidate Fix",
        "Add `windowsHide: true` to the spawn options object in src/reload.ts at line 120:",
        "```",
        "-  const child = spawn(piPath, args, { shell: true });",
        "+  const child = spawn(piPath, args, { shell: true, windowsHide: true });",
        "```",
        "",
        "## Rollback Path",
        "1. Remove the added `windowsHide: true` flag from src/reload.ts:120",
        "2. Run `git checkout src/reload.ts` to restore original",
        "",
        "## Open Questions",
        "- Are there other shell:true paths in the codebase that need windowsHide?",
        "- Does the open-from-Terminal path spawn through a different mechanism?",
        "",
        "## Files Touched",
        "- src/reload.ts (1 line changed)",
      ].join("\n"),
    };
  }

  // win-console-spawn-root-cause verifier fixture
  if (prompt.includes("You are the VERIFIER in a win-console-spawn-root-cause investigation orchestration")) {
    const verdict = process.env.FAKE_PI_WIN_CONSOLE_VERIFIER_VERDICT || "pass";
    if (verdict === "fail") {
      return {
        toolEvents: [],
        text: JSON.stringify({
          overall: "fail",
          reasons: [
            "FAIL condition 3: evidence is static-grep-only — no WMI/ETW/ProcMon or diagnostic spawn logging found",
            "FAIL condition 4: lifecycle path 'open-from-Terminal' was not separately exercised",
            "FAIL condition 7: rollback path is documented but inadequate — no verification step included",
          ],
          falsificationChecks: [
            { condition: "Orchestrator role integrity", status: "pass", evidence: "orchestrator did not perform investigation" },
            { condition: "Executor model is DeepSeek V4 Pro", status: "pass", evidence: "model route matches" },
            { condition: "Evidence is NOT static-grep-only", status: "fail", evidence: "only grep results found; no runtime instrumentation" },
            { condition: "Lifecycle paths separately exercised", status: "fail", evidence: "open-from-Terminal path not addressed" },
            { condition: "Boundaries addressed", status: "pass", evidence: "core, extensions, MCP paths examined" },
            { condition: "Windows console mechanics addressed", status: "pass", evidence: "CREATE_NO_WINDOW and windowsHide discussed" },
            { condition: "Rollback path documented", status: "fail", evidence: "rollback steps present but lack verification" },
            { condition: "Candidate fix is not too broad", status: "pass", evidence: "single flag addition in one file" },
          ],
          rollbackAssessment: "inadequate",
          broadFixConcern: false,
          notes: "Verifier determined FAIL: evidence collection was grep-only, open-from-Terminal path not exercised, rollback path incomplete.",
        }),
      };
    }
    return {
      toolEvents: [],
      text: JSON.stringify({
        overall: "pass",
        reasons: [
          "All 8 fail conditions checked and satisfied",
        ],
        falsificationChecks: [
          { condition: "Orchestrator role integrity", status: "pass", evidence: "orchestrator did not perform investigation" },
          { condition: "Executor model is DeepSeek V4 Pro", status: "pass", evidence: "model route matches deepseek/deepseek-v4-pro" },
          { condition: "Evidence is NOT static-grep-only", status: "pass", evidence: "diagnostic spawn logging and bash tool events observed" },
          { condition: "Lifecycle paths separately exercised", status: "pass", evidence: "reload, new-session, open-from-Terminal all covered" },
          { condition: "Boundaries addressed", status: "pass", evidence: "core, extensions, MCP, shell-launcher paths examined" },
          { condition: "Windows console mechanics addressed", status: "pass", evidence: "CREATE_NO_WINDOW, windowsHide, detached, shell all analyzed" },
          { condition: "Rollback path documented", status: "pass", evidence: "exact steps documented" },
          { condition: "Candidate fix is not too broad", status: "pass", evidence: "single flag change in one file" },
        ],
        rollbackAssessment: "adequate",
        broadFixConcern: false,
        notes: "All checks passed. Candidate fix is minimal and safe.",
      }),
    };
  }

  // win-lifecycle-process-trace planner fixture
  if (prompt.includes("You are the PLANNER in a win-lifecycle-process-trace orchestration")) {
    return {
      toolEvents: [],
      text: [
        "## Lifecycle Paths",
        "1. **Cold Start**: Pi.exe launched from scratch. Action markers: COLD_START_BEGIN, COLD_START_END. Correlation window: Pi.exe launch to first render.",
        "2. **Open-from-Terminal**: Terminal spawns Pi. Action markers: TERMINAL_OPEN_BEGIN, TERMINAL_OPEN_END. Correlation window: spawn command to Pi attach.",
        "3. **Reload**: /reload trigger. Action markers: RELOAD_BEGIN, RELOAD_END. Correlation window: /reload trigger to post-reload idle.",
        "4. **New-session**: /new trigger. Action markers: NEW_SESSION_BEGIN, NEW_SESSION_END. Correlation window: /new trigger to new session render.",
        "",
        "## Action Marker Scheme",
        "- Format: LIFECYCLE_ACTION_BEGIN / LIFECYCLE_ACTION_END with ISO 8601 timestamps",
        "- Naming: COLD_START, TERMINAL_OPEN, RELOAD, NEW_SESSION",
        "- Each marker pair brackets a correlation window",
        "",
        "## Correlation Windows",
        "| Lifecycle | Begin Trigger | End Trigger | Expected Duration |",
        "|-----------|---------------|-------------|-------------------|",
        "| Cold Start | Pi.exe launch | First render | < 10s |",
        "| Terminal Open | Spawn command | Pi attach | < 5s |",
        "| Reload | /reload trigger | Post-reload idle | < 15s |",
        "| New Session | /new trigger | Session render | < 10s |",
        "",
        "## Instrumentation Plan",
        "1. Materialize a PowerShell script that subscribes to Win32_ProcessStartTrace WMI events",
        "2. Script captures: ParentPID, ChildPID, CommandLine, ExecutablePath, shell usage, window flags, timestamps",
        "3. For each lifecycle path, produce a wrapper script that: (a) starts the WMI listener, (b) emits the BEGIN action marker with timestamp, (c) waits for the lifecycle action to complete, (d) emits the END action marker with timestamp, (e) stops the WMI listener, (f) saves captured events to a timestamped log file",
        "4. Scripts must NOT modify Pi source, Pi config, Windows registry, or system services",
        "5. Include cleanup: stop listeners, remove temp logs if desired",
        "",
        "## Scoped-out Items",
        "- Message-send spawns (already addressed)",
        "- Non-Windows platforms",
        "- Live Pi process interception",
        "",
        "## Rollback/Safety Constraints",
        "- All harness scripts are removable — delete the harness directory",
        "- No persistent hooks, no registry changes, no service modifications",
        "- WMI subscriptions terminate when the listening process exits",
        "",
        "## Uncertainty Notes",
        "- WMI Win32_ProcessStartTrace may require admin privileges on some Windows versions",
        "- ETW trace sessions may be an alternative if WMI unavailable",
        "",
        "## Expected Harness Deliverables",
        "- trace-harness/start-trace.ps1: Main orchestration script",
        "- trace-harness/lifecycles/cold-start.ps1: Cold start wrapper",
        "- trace-harness/lifecycles/terminal-open.ps1: Terminal open wrapper",
        "- trace-harness/lifecycles/reload.ps1: Reload wrapper",
        "- trace-harness/lifecycles/new-session.ps1: New session wrapper",
        "- trace-harness/cleanup.ps1: Cleanup/rollback script",
        "- VERIFICATION_CHECKLIST.md: Step-by-step manual run instructions",
      ].join("\n"),
    };
  }

  // win-lifecycle-process-trace executor fixture
  if (prompt.includes("You are the EXECUTOR in a win-lifecycle-process-trace orchestration")) {
    const style = process.env.FAKE_PI_WIN_LIFECYCLE_EXECUTOR_STYLE;
    if (style === "static-only") {
      return {
        toolEvents: [
          { type: "tool_execution_start", toolName: "grep" },
          { type: "tool_execution_end", toolName: "grep" },
        ],
        text: [
          "## Harness Artifacts Produced",
          "- trace-harness/start-trace.ps1: Main orchestration script",
          "",
          "## Verification Checklist",
          "1. Run start-trace.ps1",
          "2. Check the output log",
          "",
          "## Action Markers Implemented",
          "- (no action marker scheme implemented — static analysis only)",
          "",
          "## Correlation Windows",
          "- (no correlation windows defined — static analysis only)",
          "",
          "## Rollback/Cleanup Procedures",
          "- Delete trace-harness/ directory",
          "",
          "## External Process-Creation Evidence Contract",
          "- No external process-creation logging is implemented",
          "",
          "## Open Questions",
          "- None",
          "",
          "## Non-Invasiveness Attestation",
          "- No Pi source modification, no registry changes, no service config",
        ].join("\n"),
      };
    }
    return {
      toolEvents: [
        { type: "tool_execution_start", toolName: "write" },
        { type: "tool_execution_end", toolName: "write" },
        { type: "tool_execution_start", toolName: "bash" },
        { type: "tool_execution_end", toolName: "bash" },
      ],
      text: [
        "## Harness Artifacts Produced",
        "- trace-harness/start-trace.ps1: Main orchestration script that coordinates all lifecycle traces",
        "- trace-harness/lib/wmi-listener.ps1: WMI Win32_ProcessStartTrace subscription module capturing ParentPID, ChildPID, CommandLine, ExecutablePath, shell usage, window flags, timestamps",
        "- trace-harness/lifecycles/cold-start.ps1: Brackets Pi.exe cold launch with COLD_START_BEGIN/END markers and captures correlation window",
        "- trace-harness/lifecycles/terminal-open.ps1: Brackets terminal Pi spawn with TERMINAL_OPEN_BEGIN/END markers",
        "- trace-harness/lifecycles/reload.ps1: Brackets /reload with RELOAD_BEGIN/END markers",
        "- trace-harness/lifecycles/new-session.ps1: Brackets /new with NEW_SESSION_BEGIN/END markers",
        "- trace-harness/cleanup.ps1: Stops all listeners, archives logs, removes temp files",
        "- VERIFICATION_CHECKLIST.md: Step-by-step manual run instructions",
        "",
        "## Verification Checklist",
        "1. Open PowerShell as Administrator (required for WMI subscriptions)",
        "2. Run: .\\trace-harness\\lifecycles\\cold-start.ps1",
        "   - Verify COLD_START_BEGIN marker logged with timestamp",
        "   - Launch Pi.exe",
        "   - Verify COLD_START_END marker logged with timestamp",
        "   - Check captured process-creation events within correlation window",
        "3. Run: .\\trace-harness\\lifecycles\\terminal-open.ps1",
        "   - Open cmd.exe or powershell.exe",
        "   - Verify TERMINAL_OPEN_BEGIN marker logged",
        "   - Run 'pi' in the terminal",
        "   - Verify TERMINAL_OPEN_END marker and captured events",
        "4. Run: .\\trace-harness\\lifecycles\\reload.ps1",
        "   - Verify RELOAD_BEGIN marker, trigger /reload in Pi",
        "   - Verify RELOAD_END marker and captured spawn events",
        "5. Run: .\\trace-harness\\lifecycles\\new-session.ps1",
        "   - Verify NEW_SESSION_BEGIN marker, trigger /new in Pi",
        "   - Verify NEW_SESSION_END marker and captured spawn events",
        "6. Run: .\\trace-harness\\cleanup.ps1 to stop all listeners and archive logs",
        "",
        "## Action Markers Implemented",
        "| Lifecycle Path | Begin Marker | End Marker | Timestamp Format |",
        "|----------------|-------------|------------|------------------|",
        "| Cold Start | COLD_START_BEGIN | COLD_START_END | ISO 8601 |",
        "| Terminal Open | TERMINAL_OPEN_BEGIN | TERMINAL_OPEN_END | ISO 8601 |",
        "| Reload | RELOAD_BEGIN | RELOAD_END | ISO 8601 |",
        "| New Session | NEW_SESSION_BEGIN | NEW_SESSION_END | ISO 8601 |",
        "",
        "## Correlation Windows",
        "| Lifecycle Path | Window Start | Window End | Expected Duration |",
        "|----------------|-------------|------------|-------------------|",
        "| Cold Start | COLD_START_BEGIN timestamp | COLD_START_END timestamp | < 10s |",
        "| Terminal Open | TERMINAL_OPEN_BEGIN timestamp | TERMINAL_OPEN_END timestamp | < 5s |",
        "| Reload | RELOAD_BEGIN timestamp | RELOAD_END timestamp | < 15s |",
        "| New Session | NEW_SESSION_BEGIN timestamp | NEW_SESSION_END timestamp | < 10s |",
        "",
        "## Rollback/Cleanup Procedures",
        "1. Run .\\trace-harness\\cleanup.ps1 to stop all active WMI listeners",
        "2. Delete trace-harness/ directory to remove all harness artifacts",
        "3. No registry keys, no service modifications, no persisted hooks remain",
        "",
        "## External Process-Creation Evidence Contract",
        "A future human-approved run MUST capture:",
        "- For each lifecycle path: ParentPID, ChildPID, CommandLine, ExecutablePath",
        "- Shell usage (shell:true/false) and window flags (CREATE_NO_WINDOW, windowsHide, detached)",
        "- Timestamps correlated to action markers within each correlation window",
        "- Log output in trace-harness/logs/<lifecycle>_<timestamp>.json",
        "",
        "## Open Questions",
        "- WMI subscription requires Administrator privileges — ETW trace sessions may be needed as fallback",
        "- Open-from-Terminal path may spawn differently depending on terminal type (cmd.exe vs PowerShell vs Windows Terminal)",
        "",
        "## Non-Invasiveness Attestation",
        "- No Pi source code modified",
        "- No Windows registry changes",
        "- No system service configuration",
        "- No persistent hooks or injection",
        "- No live Pi process interception",
        "- All scripts terminate cleanly and are fully removable",
      ].join("\n"),
    };
  }

  // win-lifecycle-process-trace verifier fixture
  if (prompt.includes("You are the VERIFIER in a win-lifecycle-process-trace orchestration")) {
    const rawVerdict = process.env.FAKE_PI_WIN_LIFECYCLE_VERIFIER_VERDICT;
    const verdict = rawVerdict === "" ? "" : (rawVerdict || "pass");
    if (verdict === "fail") {
      const hasEvidenceBlock = prompt.includes("ORCHESTRATION EVIDENCE");
      return {
        toolEvents: [],
        text: JSON.stringify({
          overall: "fail",
          reasons: [
            "FAIL condition 3: evidence is static-only — no external process-creation logging references in executor output",
            "FAIL condition 4: action markers missing — no COLD_START_BEGIN/END, TERMINAL_OPEN_BEGIN/END, RELOAD_BEGIN/END, NEW_SESSION_BEGIN/END markers defined",
            "FAIL condition 5: correlation windows missing — no time-bounded capture windows defined",
          ],
          falsificationChecks: [
            { condition: "Role integrity (orchestratorExecutedMainTaskWork=false)", status: "pass", evidence: hasEvidenceBlock ? "ORCHESTRATION EVIDENCE block: orchestratorExecutedMainTaskWork=false" : "orchestrator did not perform trace/main-task work" },
            { condition: "Executor model is DeepSeek V4 Pro", status: "pass", evidence: hasEvidenceBlock ? "ORCHESTRATION EVIDENCE block: Executor model route=deepseek/deepseek-v4-pro" : "model route matches deepseek/deepseek-v4-pro" },
            { condition: "Evidence contains external process-creation logging", status: "fail", evidence: "no WMI/ETW/ProcessStartTrace references; only static file creation" },
            { condition: "Action markers present and defined", status: "fail", evidence: "no action marker scheme implemented in harness artifacts" },
            { condition: "Correlation windows defined", status: "fail", evidence: "no time-bounded capture windows specified" },
            { condition: "All lifecycle paths addressed (cold, terminal-open, reload, new-session)", status: "pass", evidence: "cold start, terminal open, reload, new-session paths documented" },
            { condition: "Rollback/safety procedures present", status: "pass", evidence: "cleanup script and deletion instructions provided" },
            { condition: "Shape did not fake live evidence", status: "pass", evidence: "non-invasive attestation present; no live tracing claimed" },
            { condition: "Output is not empty/unparseable", status: "pass", evidence: "structured executor output found" },
            { condition: "ORCHESTRATION EVIDENCE block present", status: hasEvidenceBlock ? "pass" : "fail", evidence: hasEvidenceBlock ? "ORCHESTRATION EVIDENCE block found in verifier prompt" : "ORCHESTRATION EVIDENCE block MISSING from verifier prompt" },
          ],
          rollbackAssessment: "adequate",
          actionMarkersPresent: false,
          correlationWindowsDefined: false,
          notes: "Verifier determined FAIL: evidence is static-only with no external process-creation logging references, action markers missing, correlation windows undefined.",
        }),
      };
    }
    if (verdict === "pass") {
      const hasEvidenceBlock = prompt.includes("ORCHESTRATION EVIDENCE");
      return {
        toolEvents: [],
        text: JSON.stringify({
          overall: "pass",
          reasons: [
            "All 9 fail conditions checked and satisfied",
          ],
          falsificationChecks: [
            { condition: "Role integrity (orchestratorExecutedMainTaskWork=false)", status: "pass", evidence: hasEvidenceBlock ? "ORCHESTRATION EVIDENCE block: orchestratorExecutedMainTaskWork=false, Live monitoring run by orchestrator=false" : "inferred from shape structure" },
            { condition: "Executor model is DeepSeek V4 Pro", status: "pass", evidence: hasEvidenceBlock ? "ORCHESTRATION EVIDENCE block: Executor model route=deepseek/deepseek-v4-pro" : "model route matches deepseek/deepseek-v4-pro" },
            { condition: "Evidence contains external process-creation logging", status: "pass", evidence: "WMI Win32_ProcessStartTrace referenced in harness; external process capture contract defined" },
            { condition: "Action markers present and defined", status: "pass", evidence: "COLD_START_BEGIN/END, TERMINAL_OPEN_BEGIN/END, RELOAD_BEGIN/END, NEW_SESSION_BEGIN/END markers implemented" },
            { condition: "Correlation windows defined", status: "pass", evidence: "time-bounded windows defined for all 4 lifecycle paths with expected durations" },
            { condition: "All lifecycle paths addressed (cold, terminal-open, reload, new-session)", status: "pass", evidence: "cold start, terminal open, reload, new-session all covered" },
            { condition: "Rollback/safety procedures present", status: "pass", evidence: "cleanup.ps1 + directory deletion instructions provided" },
            { condition: "Shape did not fake live evidence", status: "pass", evidence: "non-invasive attestation present; shape explicitly states separate human-approved run needed" },
            { condition: "Output is not empty/unparseable", status: "pass", evidence: "structured executor output with all required sections" },
            { condition: "ORCHESTRATION EVIDENCE block present", status: hasEvidenceBlock ? "pass" : "fail", evidence: hasEvidenceBlock ? "ORCHESTRATION EVIDENCE block found in verifier prompt" : "ORCHESTRATION EVIDENCE block MISSING from verifier prompt" },
          ],
          rollbackAssessment: "adequate",
          actionMarkersPresent: true,
          correlationWindowsDefined: true,
          notes: "All checks passed. Harness materials are comprehensive, non-invasive, and ready for human-approved run.",
        }),
      };
    }
    // Empty/indeterminate — fail closed
    if (verdict === "") {
      return {
        toolEvents: [],
        text: "",
      };
    }
    if (verdict === "unknown-json") {
      return {
        toolEvents: [],
        text: JSON.stringify({
          overall: "unknown",
          reasons: ["Cannot determine pass/fail from available evidence"],
          falsificationChecks: [
            { condition: "Evidence quality", status: "unknown", evidence: "ambiguous results" },
          ],
          notes: "The verifier could not reach a definitive conclusion.",
        }),
      };
    }
    if (verdict === "inconclusive-json") {
      return {
        toolEvents: [],
        text: JSON.stringify({
          status: "inconclusive",
          reasons: ["Evidence is ambiguous — more data needed"],
          falsificationChecks: [],
          notes: "Inconclusive: rerun with additional instrumentation.",
        }),
      };
    }
    if (verdict === "text-pass") {
      // Non-JSON prose text that contains "overall: pass" and "status: pass"
      // substrings. Must NOT be accepted as PASS — fail closed.
      return {
        toolEvents: [],
        text: [
          "I have reviewed the executor output and here is my assessment:",
          "",
          "The harness materials are comprehensive and well-structured.",
          "All lifecycle paths are covered with proper action markers.",
          "Overall: pass — the harness is ready for human-approved run.",
          "Status: pass — all checks satisfied.",
          "",
          "The WMI scripts are correctly implemented and the correlation",
          "windows are clearly defined. Rollback procedures are documented.",
          "",
          "I recommend proceeding with the human-approved run.",
        ].join("\n"),
      };
    }
    if (verdict === "wrapped-json-pass") {
      // Non-JSON wrapper prose containing an embedded JSON block with
      // {"overall":"pass"}. Must fail closed — embedded JSON pass in
      // non-JSON wrapper text is never a valid pass verdict.
      return {
        toolEvents: [],
        text: [
          "Here is my detailed verifier analysis of the executor output.",
          "",
          "The harness materials appear to cover most lifecycle paths.",
          "The scripts reference WMI process-creation tracing correctly.",
          "",
          "I am embedding the structured verdict below:",
          "",
          '{"overall":"pass","reasons":["All checks satisfied"],"falsificationChecks":[{"condition":"Evidence quality","status":"pass","evidence":"comprehensive"}],"notes":"Verdict embedded within analysis prose."}',
          "",
          "As shown above, the verifier JSON confirms all checks pass.",
          "The harness is ready for a human-approved run.",
          "",
          "This concludes my verifier report.",
        ].join("\n"),
      };
    }
    // unparseable — non-empty prose with no JSON and no clear verdict
    return {
      toolEvents: [],
      text: [
        "I have reviewed the executor output. There are several observations:",
        "- The harness scripts appear to reference WMI in the plan but the materialized files use a different approach.",
        "- The correlation windows are mentioned but the exact time brackets are ambiguous.",
        "- Some lifecycle paths reference action markers but others do not.",
        "Overall, the output is somewhat structured but I cannot produce a definitive JSON verdict.",
      ].join("\n"),
    };
  }

  return { toolEvents: [], text: "research complete" };
}

function main() {
  const fixtureProvider = argValue("--provider");
  // Provider preflight fixtures log before hanging/failing so tests can prove
  // exact primary/fallback attempt order without exposing credentials.
  if (fixtureProvider === "hangprov" || fixtureProvider === "badprov") {
    if (process.env.FAKE_PI_LOG) {
      fs.appendFileSync(process.env.FAKE_PI_LOG, `${JSON.stringify({
        agentName: agentNameFromSystemPrompt(),
        provider: fixtureProvider,
        model: argValue("--model") || null,
        preflightFixture: fixtureProvider === "hangprov" ? "hang" : "fail",
      })}\n`, "utf8");
    }
    if (fixtureProvider === "hangprov") {
      setInterval(() => {}, 60_000);
      return;
    }
  }

  // Pre-flight failure fixture: structured 429 payload, non-zero exit.
  if (fixtureProvider === "badprov") {
    process.stderr.write(JSON.stringify({
      error: {
        type: "rate_limit_error",
        status: 429,
        message: "Usage limit reached for provider badprov",
        resets_at: "2026-06-12T12:00:00Z",
      },
    }));
    process.exit(1);
    return;
  }

  const prompt = promptText();
  const intake = extractIntake(prompt);

  // Deterministic extractor: log exactly the BEGIN..END predicted write-set
  // block (or null if absent) without logging full prompts.
  let predictedWriteSetBlock = null;
  const pwsbMatch = prompt.match(/BEGIN_PREDICTED_WRITE_SET\n([\s\S]*?)\nEND_PREDICTED_WRITE_SET/);
  if (pwsbMatch) {
    predictedWriteSetBlock = pwsbMatch[0];
  }

  let composablePhase = null;
  if (/You are researcher \d+ of \d+ in a composable orchestration pipeline/.test(prompt)) composablePhase = "research";
  else if (/You are independent planner \d+ of \d+ in a composable orchestration pipeline/.test(prompt)) composablePhase = "plan";
  else if (/You are critic \d+ of \d+ in a composable orchestration pipeline/.test(prompt)) composablePhase = "critique";
  else if (/You are synthesizer \d+ of \d+ in a composable orchestration pipeline/.test(prompt)) composablePhase = "synthesize";
  else if (prompt.includes("You are executing one task from a deterministic composable orchestration.")) composablePhase = "execute";
  else if (/You are verifier \d+ of \d+ in a composable orchestration/.test(prompt)) composablePhase = "verify";
  const candidatePlanCount = (prompt.match(/^### Candidate Plan \d+/gm) || []).length;

  const record = {
    agentName: agentNameFromSystemPrompt(),
    composablePhase,
    candidatePlanCount,
    promptHasFinalSynthesizedPlan: prompt.includes("fixture final plan from synthesis"),
    provider: argValue("--provider") || null,
    model: argValue("--model") || null,
    tools: argValue("--tools") || null,
    noTools: args.includes("--no-tools"),
    predictedWriteSetBlock,
    promptHasIntake: Boolean(intake),
    orchestrationControls: intake && intake.orchestration_controls ? intake.orchestration_controls : null,
    routingRequirements: intake && intake.routing_requirements ? intake.routing_requirements : null,
    intakeSnapshot: intake ? {
      constraints: intake.constraints || [],
      invariants: intake.invariants || [],
      successCriteria: intake.success_criteria || [],
      failureCriteria: intake.failure_criteria || [],
      executorOutputContract: intake.executor_output_contract || null,
      originalTask: intake.original_task || null
    } : null,
    promptIncludesExecutorOutputContract: prompt.includes("Executor output contract (highest priority):"),
    promptIncludesNoGenericReportRule: prompt.includes("Do not add generic report sections."),
    promptSnippet: prompt.slice(0, 240)
  };
  if (process.env.FAKE_PI_LOG) {
    fs.appendFileSync(process.env.FAKE_PI_LOG, `${JSON.stringify(record)}\n`, "utf8");
  }

  const { toolEvents, text } = respond(prompt);
  console.log(JSON.stringify({ type: "message_start" }));
  for (const event of toolEvents) {
    console.log(JSON.stringify(event));
  }
  console.log(JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] }
  }));
  console.log(JSON.stringify({ type: "agent_end" }));
}
