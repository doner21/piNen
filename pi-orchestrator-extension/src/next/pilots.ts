import type { WorkflowSpec } from "./types";

/** Read-only parallel inspection followed by a strict host join. */
export function readOnlyFanoutJoinPilot(): WorkflowSpec {
  return {
    schemaVersion: 2,
    name: "next-read-only-fanout-join",
    description: "Two bounded read-only workers run concurrently and a host join emits deterministic dependency ordering.",
    inputs: {
      task: { type: "string", required: true },
    },
    defaults: { timeoutMs: 30_000, maxAttempts: 1 },
    limits: { maxConcurrency: 2, maxTotalAttempts: 5 },
    phases: [
      {
        id: "inspect-api",
        kind: "agent",
        role: "reviewer",
        agent: { name: "reviewer" },
        access: "read-only",
        workspace: { mode: "shared" },
        resultMode: "informational",
        outputSchema: "informational-v1",
        input: { task: "${inputs.task}", perspective: "api" },
        retry: { on: ["protocol-failure", "provider-transient", "launch-failure"], maxAttempts: 2 },
      },
      {
        id: "inspect-state",
        kind: "agent",
        role: "reviewer",
        agent: { name: "reviewer" },
        access: "read-only",
        workspace: { mode: "shared" },
        resultMode: "informational",
        outputSchema: "informational-v1",
        input: { task: "${inputs.task}", perspective: "state" },
        retry: { on: ["protocol-failure", "provider-transient", "launch-failure"], maxAttempts: 2 },
      },
      {
        id: "join-findings",
        kind: "join",
        dependsOn: ["inspect-state", "inspect-api"],
        access: "read-only",
        workspace: { mode: "shared" },
        resultMode: "informational",
        outputSchema: "join-v1",
      },
    ],
    completion: { terminalPhase: "join-findings", require: "success" },
  };
}

/** Single shared writer, direct argv machine check, then a typed semantic gate. */
export function singleWriterPevPilot(validatorScript = "validate.cjs"): WorkflowSpec {
  return singleWriterPevWorkflow({
    executable: "node",
    args: [validatorScript],
    cwd: ".",
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
  });
}

export interface SingleWriterPevCommand {
  executable: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export function singleWriterPevWorkflow(command: SingleWriterPevCommand): WorkflowSpec {
  return {
    schemaVersion: 2,
    name: "next-single-writer-pev",
    description: "Plan, mutate a disposable dirty-state-preserving workspace, explicitly integrate it, run a deterministic check, and gate the result with a strict verifier schema.",
    inputs: {
      task: { type: "string", required: true },
    },
    defaults: { timeoutMs: 30_000, maxAttempts: 1 },
    limits: { maxConcurrency: 1, maxTotalAttempts: 9 },
    phases: [
      {
        id: "plan",
        kind: "agent",
        role: "planner",
        agent: { name: "planner" },
        access: "read-only",
        workspace: { mode: "shared" },
        resultMode: "informational",
        outputSchema: "plan-v1",
        input: { task: "${inputs.task}" },
        retry: { on: ["protocol-failure", "provider-transient", "launch-failure"], maxAttempts: 2 },
      },
      {
        id: "implement",
        kind: "agent",
        role: "executor",
        agent: { name: "coder" },
        dependsOn: ["plan"],
        access: "workspace-write",
        workspace: { mode: "isolated" },
        resultMode: "informational",
        outputSchema: "implementation-v1",
        input: { task: "${inputs.task}", plan: "${phases.plan.output}" },
        retry: { on: ["protocol-failure", "provider-transient", "launch-failure", "result-file-pending"], maxAttempts: 2 },
      },
      {
        id: "integrate",
        kind: "integrate",
        dependsOn: ["implement"],
        access: "workspace-write",
        workspace: { mode: "shared" },
        resultMode: "deterministic",
        outputSchema: "integration-result-v1",
        integrate: { sources: ["implement"], strategy: "apply-clean" },
      },
      {
        id: "test",
        kind: "deterministic-command",
        dependsOn: ["integrate"],
        access: "read-only",
        workspace: { mode: "shared" },
        resultMode: "deterministic",
        outputSchema: "command-result-v1",
        retry: { on: ["protocol-failure", "launch-failure"], maxAttempts: 2 },
        command: {
          executable: command.executable,
          args: [...command.args],
          cwd: command.cwd ?? ".",
          timeoutMs: command.timeoutMs ?? 10_000,
          maxOutputBytes: command.maxOutputBytes ?? 64 * 1024,
        },
      },
      {
        id: "verify",
        kind: "agent",
        role: "verifier",
        agent: { name: "reviewer" },
        dependsOn: ["plan", "implement", "integrate", "test"],
        access: "read-only",
        workspace: { mode: "shared" },
        resultMode: "gate",
        outputSchema: "verification-v1",
        input: {
          task: "${inputs.task}",
          plan: "${phases.plan.output}",
          implementation: "${phases.implement.output}",
          integration: "${phases.integrate.output}",
          test: "${phases.test.output}",
        },
        retry: { on: ["protocol-failure", "provider-transient", "launch-failure"], maxAttempts: 2 },
      },
    ],
    completion: { terminalPhase: "verify", require: "pass" },
  };
}
