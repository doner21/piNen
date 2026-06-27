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

  return { toolEvents: [], text: "research complete" };
}

function main() {
  // Pre-flight failure fixture: structured 429 payload, non-zero exit.
  if (argValue("--provider") === "badprov") {
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
  const record = {
    agentName: agentNameFromSystemPrompt(),
    provider: argValue("--provider") || null,
    model: argValue("--model") || null,
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
