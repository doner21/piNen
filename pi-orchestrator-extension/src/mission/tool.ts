import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import path from "node:path";

import { compileMissionContract } from "./contract";
import { inspectDurableMission, loadDurableMissionContract, type DurableMissionInspection } from "./inspection";
import { PiRpcMissionWorkerFactory } from "./rpc-worker";
import { defaultMissionRunsRoot, runDurableMission } from "./runner";
import type { MissionWorkerFactory, ThinkingLevel } from "./types";

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const runOnlyFields = new Set([
  "objective", "cwd", "provider", "model", "thinkingLevel", "fallbacks", "wallClockMs", "maxTurns",
  "maxRestarts", "maxTokens", "validator", "validatorTimeoutMs", "validatorMaxOutputBytes", "constraints",
]);

export const durableMissionToolSchema = Type.Object({
  action: Type.Optional(StringEnum(["run", "resume", "inspect"] as const, { description: "Start, durably resume, or inspect one mission. Defaults to run." })),
  runId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Stable mission id. Required for resume and inspect." })),
  objective: Type.Optional(Type.String({ minLength: 1, maxLength: 200_000, description: "Concrete objective owned by one long-horizon coding agent. Required for run." })),
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 32_768, description: "Product workspace. Runtime state is always stored outside it." })),
  provider: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Primary provider; defaults to the current Pi model provider." })),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Primary model; defaults to the current Pi model." })),
  thinkingLevel: Type.Optional(StringEnum(thinkingLevels)),
  fallbacks: Type.Optional(Type.Array(Type.Object({
    provider: Type.String({ minLength: 1, maxLength: 128 }),
    model: Type.String({ minLength: 1, maxLength: 256 }),
    thinkingLevel: Type.Optional(StringEnum(thinkingLevels)),
  }), { maxItems: 5, description: "Ordered initial-start fallbacks. Exact-session resume never changes the selected route." })),
  wallClockMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 604_800_000, description: "Whole-mission wall-clock budget." })),
  maxTurns: Type.Optional(Type.Number({ minimum: 1, maximum: 1_000 })),
  maxRestarts: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  maxTokens: Type.Optional(Type.Number({ minimum: 1, maximum: 100_000_000 })),
  validator: Type.Optional(StringEnum(["node-workspace-validator", "read-only"] as const, {
    description: "Defaults to fixed ./validate.cjs. read-only forbids every observed workspace effect.",
  })),
  validatorTimeoutMs: Type.Optional(Type.Number({ minimum: 100, maximum: 3_600_000 })),
  validatorMaxOutputBytes: Type.Optional(Type.Number({ minimum: 1_024, maximum: 16_777_216 })),
  constraints: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), { maxItems: 64 })),
});

export type DurableMissionToolParams = Static<typeof durableMissionToolSchema>;

export interface DurableMissionToolDependencies {
  runsRoot?: () => string;
  createWorkerFactory?: (runsRoot: string) => MissionWorkerFactory;
}

/** Register the opt-in first-slice tool without changing either legacy orchestration tool. */
export function registerDurableMissionTool(pi: ExtensionAPI, dependencies: DurableMissionToolDependencies = {}): void {
  pi.registerTool(createDurableMissionToolDefinition(pi, dependencies));
}

export function createDurableMissionToolDefinition(pi: ExtensionAPI, dependencies: DurableMissionToolDependencies = {}) {
  const resolveRunsRoot = dependencies.runsRoot ?? defaultMissionRunsRoot;
  const createWorkerFactory = dependencies.createWorkerFactory
    ?? ((runsRoot: string) => new PiRpcMissionWorkerFactory({ sessionRoot: path.join(runsRoot, "worker-sessions") }));

  return defineTool({
    name: "orchestrate_mission",
    label: "Durable Mission",
    description: "Run, resume, or inspect one durable single-agent coding mission with an exclusive workspace writer, exact Pi session/route recovery, fixed host validation, and fail-closed crash classification.",
    promptSnippet: "Run one long-horizon coding agent under durable crash recovery and fixed host validation.",
    promptGuidelines: [
      "Use orchestrate_mission only for an explicit durable single-agent coding mission; it is not a planner/executor/verifier workflow.",
      "For orchestrate_mission resume or inspect, pass only action and runId; the objective, workspace, route, budgets, validator, and constraints are restored from durable state.",
      "Treat pending and outcome-unknown as nonterminal. Inspect safeAction before deciding whether to wait, resume, or reconcile.",
    ],
    parameters: durableMissionToolSchema,
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as DurableMissionToolParams;
      const action = params.action ?? "run";
      const runsRoot = path.resolve(resolveRunsRoot());
      if (action === "inspect") {
        assertId(params.runId, action);
        assertNoRunFields(params, action);
        const report = inspectDurableMission({ runsRoot, runId: params.runId! });
        return toolResult(report);
      }
      if (action === "resume") {
        assertId(params.runId, action);
        assertNoRunFields(params, action);
      }

      const compiled = action === "resume"
        ? loadDurableMissionContract(runsRoot, params.runId!)
        : compileMissionContract(buildRunContract(params, ctx, pi));
      const workerFactory = createWorkerFactory(runsRoot);
      const progressTypes = new Set(["mission.started", "mission.resumed", "worker.started", "worker.settled", "validator.completed", "repair.requested", "mission.paused", "mission.outcome-unknown", "mission.succeeded", "mission.failed", "mission.cancelled", "budget.exhausted"]);
      const result = await runDurableMission({
        contract: compiled,
        workerFactory,
        ...(params.runId ? { runId: params.runId } : {}),
        runsRoot,
        signal,
        onEvent(event) {
          if (!progressTypes.has(event.type)) return;
          onUpdate?.({
            content: [{ type: "text", text: `Durable mission ${event.runId}: ${event.type}` }],
            details: { runId: event.runId, event: event.type, seq: event.seq },
          });
        },
      });
      const report = inspectDurableMission({ runsRoot, runId: result.runId });
      return toolResult(report, result.status);
    },
  });
}

function buildRunContract(params: DurableMissionToolParams, ctx: { cwd?: string; model?: { provider?: string; id?: string } }, pi: ExtensionAPI) {
  if (typeof params.objective !== "string" || !params.objective.trim()) throw new Error("orchestrate_mission run requires objective");
  const provider = params.provider?.trim() || ctx.model?.provider;
  const model = params.model?.trim() || ctx.model?.id;
  if (!provider || !model) throw new Error("orchestrate_mission run requires provider/model or an active Pi model");
  const thinkingLevel = (params.thinkingLevel ?? pi.getThinkingLevel()) as ThinkingLevel;
  const readOnly = params.validator === "read-only";
  return {
    schemaVersion: 1,
    objective: params.objective,
    cwd: params.cwd ?? ctx.cwd ?? process.cwd(),
    route: { provider, model, thinkingLevel },
    fallbacks: (params.fallbacks ?? []).map((route) => ({
      provider: route.provider,
      model: route.model,
      thinkingLevel: (route.thinkingLevel ?? "off") as ThinkingLevel,
    })),
    budgets: {
      wallClockMs: integer(params.wallClockMs, 30 * 60_000, "wallClockMs"),
      maxTurns: integer(params.maxTurns, 20, "maxTurns"),
      maxRestarts: integer(params.maxRestarts, 3, "maxRestarts"),
      maxSpecialists: 0,
      maxTokens: integer(params.maxTokens, 2_000_000, "maxTokens"),
    },
    validator: readOnly
      ? { kind: "none" as const, readOnly: true as const }
      : {
          kind: "node-workspace-validator" as const,
          script: "validate.cjs" as const,
          timeoutMs: integer(params.validatorTimeoutMs, 10 * 60_000, "validatorTimeoutMs"),
          maxOutputBytes: integer(params.validatorMaxOutputBytes, 64 * 1_024, "validatorMaxOutputBytes"),
        },
    constraints: params.constraints ?? [],
  };
}

function integer(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected)) throw new Error(`orchestrate_mission ${label} must be an integer`);
  return selected;
}

function assertId(runId: string | undefined, action: string): asserts runId is string {
  if (!runId?.trim()) throw new Error(`orchestrate_mission ${action} requires runId`);
}

function assertNoRunFields(params: DurableMissionToolParams, action: string): void {
  const supplied = Object.keys(params).filter((key) => runOnlyFields.has(key));
  if (supplied.length) throw new Error(`orchestrate_mission ${action} restores pinned inputs; remove ${supplied.sort().join(", ")}`);
}

function toolResult(report: DurableMissionInspection, runStatus?: string) {
  const status = runStatus ?? report.state.toLowerCase().replace(/_/g, "-");
  const text = [
    `Durable mission ${report.runId}: ${status}`,
    `State: ${report.state}`,
    `Mission: ${report.missionHash}`,
    `Validator: ${report.validator?.status ?? "not-run"}`,
    `Safe action: ${report.safeAction.code} — ${report.safeAction.reason}`,
  ].join("\n");
  return { content: [{ type: "text" as const, text }], details: { status, ...report } };
}
