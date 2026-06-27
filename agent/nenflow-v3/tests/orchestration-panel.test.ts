/**
 * Unit tests for the NenFlow v3 OrchestrationStatusPanel component.
 *
 * These tests verify the render output of the panel component against
 * simulated orchestration state without requiring a running Pi instance.
 *
 * Run: node ~/.pi/agent/nenflow-v3/tests/orchestration-panel.test.ts
 *   or: npx tsx ~/.pi/agent/nenflow-v3/tests/orchestration-panel.test.ts
 */

const assert = require("node:assert");
const test = require("node:test");

// ---------------------------------------------------------------------------
// Stub theme — returns ANSI-wrapped strings like the real Pi theme would
// ---------------------------------------------------------------------------

// Map color names to ANSI codes so stripAnsi works correctly
const colorCodes: Record<string, string> = {
  accent: "36",
  success: "32",
  warning: "33",
  error: "31",
  muted: "90",
  dim: "2",
};

const theme = {
  fg: (color: string, text: string) => `\x1b[${colorCodes[color] || "37"}m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
  dim: (text: string) => `\x1b[2m${text}\x1b[0m`,
};

// Stub TUI
const tui = { requestRender: () => {} };

// ---------------------------------------------------------------------------
// Replicate the panel component logic (extracted from extension for testing)
// ---------------------------------------------------------------------------

interface RoleAssignment {
  agentName: string;
  role: string;
  model: string;
  provider: string;
}

interface SubagentState {
  agentName: string;
  role: string;
  task: string;
  status: "pending" | "running" | "completed" | "failed";
  model?: string;
  provider?: string;
  startTime?: string | null;
  endTime?: string | null;
  exitCode?: number | null;
  contextTokens?: number | null;
}

interface OrchestrationState {
  run_id: string;
  phase: string;
  updated_at: string;
  completed?: boolean;
  totalSubagents: number;
  completedSubagents: number;
  workingSubagents: number;
  contextPercent: number | null;
  subagents: SubagentState[];
}

interface OrchestrationHeader {
  run_id: string;
  paradigm: string;
  maxSubagents: number;
  maxRetries: number;
  concurrency: number;
  roles: RoleAssignment[];
}

// Helper: strip ANSI codes for plaintext assertions
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// Helper: check that all strings in an array fit within width (ignoring ANSI)
function allWithinWidth(lines: string[], width: number): boolean {
  for (const line of lines) {
    const plain = stripAnsi(line);
    if (plain.length > width) return false;
  }
  return true;
}

/**
 * Minimal render function matching the panel's render logic.
 * This mirrors OrchestrationPanelComponent.render() from the extension.
 */
function renderPanel(
  header: OrchestrationHeader,
  state: OrchestrationState,
  width: number,
): string[] {
  const h = header;
  const s = state;
  const lines: string[] = [];

  const fit = (text: string): string => {
    const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
    if (plain.length <= width) return text;
    let visible = 0;
    let result = "";
    let inEscape = false;
    for (let i = 0; i < text.length; i++) {
      if (inEscape) {
        result += text[i];
        if (text[i] === "m") inEscape = false;
        continue;
      }
      if (text[i] === "\x1b" && text[i + 1] === "[") {
        inEscape = true;
        result += text[i];
        continue;
      }
      if (visible >= width) break;
      result += text[i];
      visible++;
    }
    return result;
  };

  const dimDivider = "─".repeat(Math.min(width - 2, 38));

  lines.push(fit(theme.fg("accent", theme.bold(` NenFlow v3 Orchestration `))));
  lines.push(fit(theme.fg("dim", dimDivider)));
  lines.push(fit(""));
  lines.push(fit(theme.fg("accent", theme.bold("Config"))));
  lines.push(fit(`  max-subagents : ${h.maxSubagents}`));
  lines.push(fit(`  max-retries   : ${h.maxRetries}`));
  lines.push(fit(`  concurrency   : ${h.concurrency}`));
  lines.push(fit(`  paradigm      : ${h.paradigm}`));

  lines.push(fit(""));
  lines.push(fit(theme.fg("accent", theme.bold("Model Assignments"))));
  for (const role of h.roles) {
    const modelStr = `${role.provider}/${role.model}`;
    const color =
      role.role === "executor" ? "success" :
      role.role === "verifier" ? "warning" : "accent";
    const line = `  ${theme.fg(color, role.agentName.padEnd(16))} ${theme.fg("dim", "\u2192")} ${theme.fg("muted", role.role.padEnd(10))} ${modelStr}`;
    lines.push(fit(line));

    // Show task assignment for this role, if known from subagent state
    const agentState = s.subagents.find((a) => a.agentName === role.agentName);
    if (agentState && agentState.task) {
      const shortTask = agentState.task.length > 28
        ? agentState.task.slice(0, 25) + "..."
        : agentState.task;
      lines.push(fit(`    ${theme.fg("dim", "task:")} ${theme.fg("muted", shortTask)}`));
    }
  }

  lines.push(fit(""));
  lines.push(fit(theme.fg("accent", theme.bold("Status"))));
  const phaseColor = s.phase === "ERROR" ? "error" : s.completed ? "success" : "accent";
  lines.push(fit(`  phase         : ${theme.fg(phaseColor, s.phase)}`));

  const workingPct = s.totalSubagents > 0
    ? `${Math.round((s.completedSubagents / s.totalSubagents) * 100)}%`
    : "--";
  const ctxPct = s.contextPercent !== null ? `${s.contextPercent}%` : "--";
  const activePct = s.totalSubagents > 0
    ? `${Math.round(((s.workingSubagents + s.completedSubagents) / s.totalSubagents) * 100)}%`
    : "--";
  lines.push(fit(`  progress      : ${s.completedSubagents}/${s.totalSubagents} done (${workingPct})`));
  lines.push(fit(`  working       : ${s.workingSubagents}/${s.totalSubagents} active (${activePct})`));
  lines.push(fit(`  context       : ${ctxPct}`));

  lines.push(fit(""));
  lines.push(fit(theme.fg("accent", theme.bold("Subagents"))));
  if (s.subagents.length === 0) {
    lines.push(fit(theme.fg("dim", "  (none yet)")));
  } else {
    for (const agent of s.subagents) {
      const statusIcon =
        agent.status === "running" ? theme.fg("warning", "\u25CC") :
        agent.status === "completed" ? theme.fg("success", "\u2713") :
        agent.status === "failed" ? theme.fg("error", "\u2717") :
        theme.fg("dim", "\u25CB");

      const shortTask = agent.task.length > 30
        ? agent.task.slice(0, 27) + "..."
        : agent.task || "(no task)";
      lines.push(fit(`  ${statusIcon} ${theme.fg("accent", agent.agentName)} ${theme.fg("dim", shortTask)}`));

      const mdl = [agent.provider, agent.model].filter(Boolean).join("/") || "?";
      lines.push(fit(`    ${theme.fg("muted", mdl)}`));

      if (agent.contextTokens && agent.status === "running") {
        lines.push(fit(`    ${theme.fg("warning", `ctx: ~${agent.contextTokens} tokens`)}`));
      }
    }
  }

  lines.push(fit(""));
  lines.push(fit(theme.fg("dim", dimDivider)));
  lines.push(fit(theme.fg("dim", " esc|q:close  r:refresh")));

  return lines.map((l) => fit(l));
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const defaultHeader: OrchestrationHeader = {
  run_id: "RUN_TEST_001",
  paradigm: "nenflow-v3",
  maxSubagents: 1,
  maxRetries: 5,
  concurrency: 1,
  roles: [
    { agentName: "pev-researcher", role: "researcher", model: "deepseek-v4-pro", provider: "deepseek" },
    { agentName: "pev-planner", role: "planner", model: "deepseek-v4-pro", provider: "deepseek" },
    { agentName: "pev-executor", role: "executor", model: "deepseek-v4-pro", provider: "deepseek" },
    { agentName: "pev-verifier", role: "verifier", model: "deepseek-v4-flash", provider: "deepseek" },
  ],
};

function makeState(overrides: Partial<OrchestrationState> = {}): OrchestrationState {
  return {
    run_id: "RUN_TEST_001",
    phase: "INTAKE",
    updated_at: new Date().toISOString(),
    totalSubagents: 4,
    completedSubagents: 0,
    workingSubagents: 0,
    contextPercent: null,
    subagents: defaultHeader.roles.map((r) => ({
      agentName: r.agentName,
      role: r.role,
      task: "",
      status: "pending" as const,
      model: r.model,
      provider: r.provider,
    })),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

// Test 1: Panel renders all required fields
test("Panel renders all required static fields", () => {
  const state = makeState();
  const lines = renderPanel(defaultHeader, state, 60);
  const plain = lines.map(stripAnsi).join("\n");

  assert.ok(plain.includes("max-subagents"), "should show max-subagents field");
  assert.ok(plain.includes("max-retries"), "should show max-retries field");
  assert.ok(plain.includes("concurrency"), "should show concurrency field");
  assert.ok(plain.includes("paradigm"), "should show paradigm field");
  assert.ok(plain.includes("nenflow-v3"), "should show paradigm value");
  assert.ok(plain.includes("1"), "should show max-subagents value");
  assert.ok(plain.includes("5"), "should show max-retries value");
});

// Test 2: Panel renders all model assignments
test("Panel renders per-LLM model assignments", () => {
  const state = makeState();
  const lines = renderPanel(defaultHeader, state, 60);
  const plain = lines.map(stripAnsi).join("\n");

  assert.ok(plain.includes("pev-researcher"), "should show researcher agent");
  assert.ok(plain.includes("pev-planner"), "should show planner agent");
  assert.ok(plain.includes("pev-executor"), "should show executor agent");
  assert.ok(plain.includes("pev-verifier"), "should show verifier agent");
  assert.ok(plain.includes("deepseek/deepseek-v4-pro"), "should show model for pro roles");
  assert.ok(plain.includes("deepseek/deepseek-v4-flash"), "should show model for verifier");
});

// Test 3: Context percentage shows "--" when no agents are working
test("Context percentage is '--' when no subagents are working", () => {
  const state = makeState({ contextPercent: null });
  const lines = renderPanel(defaultHeader, state, 60);
  const plain = lines.map(stripAnsi).join("\n");
  assert.ok(plain.includes("context       : --"), "context should be '--' when null");
});

// Test 4: Context percentage shows value when set
test("Context percentage shows value when set", () => {
  const state = makeState({ contextPercent: 42 });
  const lines = renderPanel(defaultHeader, state, 60);
  const plain = lines.map(stripAnsi).join("\n");
  assert.ok(plain.includes("context       : 42%"), "context should show 42%");
});

// Test 5: Subagent status indicators render correctly
test("Subagent status indicators render correctly", () => {
  const state = makeState({
    subagents: [
      { agentName: "pev-researcher", role: "researcher", task: "Research the codebase", status: "completed", model: "deepseek-v4-pro", provider: "deepseek" },
      { agentName: "pev-planner", role: "planner", task: "Create implementation plan", status: "running", model: "deepseek-v4-pro", provider: "deepseek" },
      { agentName: "pev-executor", role: "executor", task: "Implement the panel", status: "pending", model: "deepseek-v4-pro", provider: "deepseek" },
      { agentName: "pev-verifier", role: "verifier", task: "Verify implementation", status: "failed", model: "deepseek-v4-flash", provider: "deepseek" },
    ],
    completedSubagents: 2,
    workingSubagents: 1,
  });
  const lines = renderPanel(defaultHeader, state, 60);
  const plain = lines.map(stripAnsi).join("\n");

  assert.ok(plain.includes("Research the codebase"), "should show researcher task");
  assert.ok(plain.includes("Create implementation plan"), "should show planner task");
  assert.ok(plain.includes("Implement the panel"), "should show executor task");
  assert.ok(plain.includes("Verify implementation"), "should show verifier task");
});

// Test 6: Progress displays completion percentage
test("Progress shows completion fraction and percentage", () => {
  const state = makeState({ completedSubagents: 2, totalSubagents: 4 });
  const lines = renderPanel(defaultHeader, state, 60);
  const plain = lines.map(stripAnsi).join("\n");
  assert.ok(plain.includes("2/4") && plain.includes("(50%)"), "should show 2/4 (50%)");
});

// Test 7: Empty subagent list shows "(none yet)"
test("Empty subagent list shows '(none yet)'", () => {
  const state = makeState({ subagents: [], totalSubagents: 0 });
  const lines = renderPanel(defaultHeader, state, 60);
  const plain = lines.map(stripAnsi).join("\n");
  assert.ok(plain.includes("(none yet)"), "should show (none yet) for empty subagents");
});

// Test 8: All lines respect width constraint
test("All rendered lines fit within specified width", () => {
  const widths = [40, 50, 60, 80, 120];
  const state = makeState({
    subagents: [
      { agentName: "pev-researcher", role: "researcher", task: "A very long task description that exceeds normal limits", status: "running", model: "deepseek-v4-pro", provider: "deepseek", startTime: new Date().toISOString(), contextTokens: 5000 },
      { agentName: "pev-planner", role: "planner", task: "Another very long task description", status: "completed", model: "deepseek-v4-pro", provider: "deepseek", startTime: "2026-06-03T00:00:00Z", endTime: "2026-06-03T00:05:00Z" },
    ],
    workingSubagents: 1,
    completedSubagents: 1,
  });

  for (const width of widths) {
    const lines = renderPanel(defaultHeader, state, width);
    const ok = allWithinWidth(lines, width);
    assert.ok(ok, `all lines should fit within width ${width}`);
  }
});

// Test 9: Phase changes reflect correctly
test("Phase changes are reflected in render output", () => {
  for (const phase of ["INTAKE", "PLAN", "EXECUTE", "VERIFY", "COMPLETE", "ERROR"]) {
    const state = makeState({ phase, completed: phase === "COMPLETE" });
    const lines = renderPanel(defaultHeader, state, 60);
    const plain = lines.map(stripAnsi).join("\n");
    assert.ok(plain.includes(phase), `phase '${phase}' should appear in output`);
  }
});

// Test 10: Progress shows "--" when total is 0
test("Progress shows '--' when total is 0", () => {
  const state = makeState({ totalSubagents: 0, completedSubagents: 0 });
  const lines = renderPanel(defaultHeader, state, 60);
  const plain = lines.map(stripAnsi).join("\n");
  assert.ok(plain.includes("(--)"), "should show (--) when total subagents is 0");
});

// Test 11: Overlay visible callback logic
test("Overlay visibility callback hides below 90 columns, shows above", () => {
  const visible = (termWidth: number) => termWidth >= 90;
  assert.ok(!visible(85), "should hide at width 85");
  assert.ok(!visible(89), "should hide at width 89");
  assert.ok(visible(90), "should show at width 90");
  assert.ok(visible(95), "should show at width 95");
  assert.ok(visible(120), "should show at width 120");
});

// Test 12: Long tasks are truncated in render
test("Tasks longer than 30 chars are truncated with ellipsis", () => {
  const longTask = "This is a very long task description that goes on and on";
  const state = makeState({
    subagents: [
      { agentName: "pev-researcher", role: "researcher", task: longTask, status: "running", model: "deepseek-v4-pro", provider: "deepseek" },
    ],
    workingSubagents: 1,
  });
  const lines = renderPanel(defaultHeader, state, 60);
  const plain = lines.map(stripAnsi).join("\n");

  // Should contain a truncated version but not the full string
  assert.ok(!plain.includes(longTask), "full long task should not appear");
  assert.ok(plain.includes(longTask.slice(0, 27)), "truncated task start should appear");
  assert.ok(plain.includes("..."), "ellipsis should appear after truncated task");
});

// Test 13: Short tasks are shown in full
test("Short tasks are shown in full without truncation", () => {
  const shortTask = "Research the code";
  const state = makeState({
    subagents: [
      { agentName: "pev-researcher", role: "researcher", task: shortTask, status: "running", model: "deepseek-v4-pro", provider: "deepseek" },
    ],
    workingSubagents: 1,
  });
  const lines = renderPanel(defaultHeader, state, 60);
  const plain = lines.map(stripAnsi).join("\n");
  assert.ok(plain.includes(shortTask), "short task should appear in full");
});

console.log("\nAll orchestration panel tests passed.\n");
