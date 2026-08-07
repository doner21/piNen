/**
 * Shape: ssi-single-writer-exclusive-lane
 *
 * SSI completion with real phase barriers, one allowlisted logical writer,
 * and one cross-process machine-resource lane. Shapes are siblings: this
 * module uses substrate primitives directly and never imports another shape.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  SpawnGuard,
  spawnSubagent,
  throwIfAborted,
  truncateWithNotice,
  type AgentProfile,
  type SpawnSubagentOptions,
  type SubagentResult,
} from "../substrate";
import { formatRouteLabel, resolveShapePhaseRoute } from "../routes";
import type {
  OrchestrationShape,
  OrchestrationShapeContext,
  OrchestrationShapeResult,
} from "../types";

const execFileAsync = promisify(execFile);
const MAX_FINAL_CHARS = 20_000;
const MAX_SPAWNS = 11; // 3 diagnosis + synthesis + writer + 2 reviews + machine + repair + retest + finalizer
const DEFAULT_MACHINE_LOCK = path.join(os.tmpdir(), "pi-orchestrator-ssi-machine-resource.lock");
const READ_ONLY_TOOLS = ["read"] as const;
const WRITER_TOOLS = ["read", "edit", "write"] as const;
const MACHINE_TOOLS = ["read", "bash"] as const;

const ALLOWED_EXECUTOR_ROUTES = new Set([
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.5",
  "zai/glm-5.2",
]);

interface WriterTuple {
  agentName: string;
  provider: string;
  model: string;
}

interface Finding {
  summary: string;
  evidence: string;
  repair: string;
  file?: string;
  line?: number;
}

interface ReviewVerdict {
  status: "PASS" | "FAIL";
  findings: Finding[];
}

interface MachineVerdict {
  status: "PASS" | "FAIL";
  checks: Array<{ command: string; status: "PASS" | "FAIL"; exitCode: number; evidence: string }>;
  cleanup: { status: "PASS" | "FAIL"; survivingProcesses: string[]; resourcesReleased: boolean };
  findings: Finding[];
}

interface FinalizerVerdict {
  status: "PASS" | "FAIL";
  action: "committed" | "noop";
  branch: string;
  localHash: string;
  remoteHash: string;
  taskRelevantChangesRemain: boolean;
  sensoryCard: string;
  reason?: string;
}

interface RuntimeDependencies {
  spawn: (
    agentName: string,
    task: string,
    options: SpawnSubagentOptions,
  ) => Promise<SubagentResult>;
  machineLockPath: string;
  onLockEvent?: (event: "acquired" | "released", lockPath: string) => void;
}

const PRODUCTION_DEPS: RuntimeDependencies = {
  spawn: spawnSubagent,
  machineLockPath: DEFAULT_MACHINE_LOCK,
};

export const ssiSingleWriterExclusiveLaneShape: OrchestrationShape = {
  name: "ssi-single-writer-exclusive-lane",
  description: "SSI completion with parallel read-only diagnosis, one allowlisted logical writer, and an exclusive serialized machine-test lane.",
  run: (context) => runSsiSingleWriterExclusiveLane(context, PRODUCTION_DEPS),
};

/** Narrow dependency seam for fake-substrate tests; production uses the export above. */
export const __ssiSingleWriterExclusiveLaneTest = {
  run(
    context: OrchestrationShapeContext,
    overrides: Partial<RuntimeDependencies> = {},
  ): Promise<OrchestrationShapeResult> {
    return runSsiSingleWriterExclusiveLane(context, { ...PRODUCTION_DEPS, ...overrides });
  },
  defaultMachineLockPath: DEFAULT_MACHINE_LOCK,
};

async function runSsiSingleWriterExclusiveLane(
  context: OrchestrationShapeContext,
  deps: RuntimeDependencies,
): Promise<OrchestrationShapeResult> {
  const { params, signal, onUpdate, inheritedModel, agents } = context;
  const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }] });

  // Canary is deliberately before route, git, lock, and spawn setup.
  if (params.task.trim().startsWith("SHAPE_CANARY:ssi-single-writer-exclusive-lane")) {
    return {
      markdown: "# ssi-single-writer-exclusive-lane Canary: PASS\n\nNo subprocess, lock, git, or mutation operation ran.",
      details: {
        status: "pass",
        paradigm: "ssi-single-writer-exclusive-lane",
        canary: true,
        spawnedCount: 0,
        spawnedCap: 0,
      },
    };
  }

  // Resolve and reject the executor route before *any* work subprocess starts.
  const writerTuple = resolveWriterTuple(params, agents, inheritedModel);
  assertAllowlistedWriter(writerTuple);
  if (params.maxSubagents < MAX_SPAWNS) {
    throw new Error(
      `ssi-single-writer-exclusive-lane requires a preflight spawn allowance of ${MAX_SPAWNS}; ` +
        `received maxSubagents=${params.maxSubagents}. No work was spawned.`,
    );
  }

  const spawnGuard = new SpawnGuard(MAX_SPAWNS);
  const outputs: SubagentResult[] = [];
  const records: Array<Record<string, unknown>> = [];
  const failures: string[] = [];
  let repairRan = false;
  let finalizerRan = false;
  let lockAcquisitions = 0;

  const plannerRoute = resolveShapePhaseRoute("planner", params.plannerAgent, params);
  const verifierRoute = resolveShapePhaseRoute("verifier", params.verifierAgent, params);

  const launch = async (
    phase: string,
    agentName: string,
    prompt: string,
    tools: readonly string[],
    route: { provider?: string; model?: string } | undefined,
    phaseMutates = false,
    instance = 1,
  ): Promise<SubagentResult> => {
    throwIfAborted(signal);
    const spawned = spawnGuard.reserve();
    emit(
      `ssi-single-writer-exclusive-lane: ${phase} instance ${instance} on ${formatRouteLabel(route)} ` +
        `(${spawned}/${spawnGuard.cap}).`,
    );
    const phaseAgents = cloneProfileWithTools(agents, agentName, tools, route);
    const result = await deps.spawn(agentName, prompt, {
      agents: phaseAgents,
      cwd: params.cwd,
      allowLocalModel: params.allowLocalModel,
      signal,
      inheritedModel,
      onProgress: emit,
      modelOverride: route ? { provider: route.provider, model: route.model } : undefined,
      phaseMutates,
    });
    outputs.push(result);
    records.push({
      phase,
      instance,
      agentName,
      provider: route?.provider ?? result.provider,
      model: route?.model ?? result.model,
      tools: [...tools],
      phaseMutates,
      exitCode: result.exitCode,
      isolatedContext: true,
    });
    return result;
  };

  // Barrier 1: exactly three distinct diagnosis subprocesses overlap.
  const diagnosisPrompts = [
    "musical-slice completeness and current diff scope",
    "native, control, and runtime correctness",
    "test, process, audio-device, and exclusive-resource risk",
  ].map((perspective, index) =>
    buildPrompt(
      "parallel-read-only-diagnosis",
      params.task,
      [],
      [
        `DIAGNOSIS_INSTANCE: ${index + 1}/3`,
        `Independently diagnose ${perspective}.`,
        "Read only. Do not run bash, edit, write, build, test, launch hosts, access WASAPI, or invoke recursive orchestration.",
        "Separate ordinary DAW hot-swap requirements from optional concurrent-rebuild stress tooling.",
      ].join("\n"),
    ),
  );
  const diagnoses = await Promise.all(
    diagnosisPrompts.map((prompt, index) =>
      launch("parallel-read-only-diagnosis", params.plannerAgent, prompt, READ_ONLY_TOOLS, plannerRoute, false, index + 1),
    ),
  );
  if (!allExitedZero(diagnoses)) {
    failures.push("At least one read-only diagnosis exited nonzero; synthesis and all mutating phases were stopped.");
    return finish("fail", params.task, spawnGuard, outputs, records, failures, writerTuple, repairRan, finalizerRan, lockAcquisitions);
  }

  // Barrier 2: synthesis starts only after every diagnosis has exited.
  const synthesis = await launch(
    "synthesize-smallest-plan",
    params.plannerAgent,
    buildPrompt(
      "synthesize-smallest-plan",
      params.task,
      diagnoses,
      [
        "Synthesize one smallest finish plan and a deterministic ordinary-SSI gate manifest.",
        "Read only: do not run bash, edit, write, build, or test.",
        "List gate commands in the exact serial order the single machine verifier must execute.",
      ].join("\n"),
    ),
    READ_ONLY_TOOLS,
    plannerRoute,
  );
  if (synthesis.exitCode !== 0) {
    failures.push("Read-only synthesis exited nonzero; the writer was not launched.");
    return finish("fail", params.task, spawnGuard, outputs, records, failures, writerTuple, repairRan, finalizerRan, lockAcquisitions);
  }

  // Barrier 3: one implementation subprocess, using the exact resolved writer tuple.
  const implementation = await launch(
    "single-writer-implementation",
    writerTuple.agentName,
    buildPrompt(
      "single-writer-implementation",
      params.task,
      [synthesis],
      [
        "Act as the sole logical SSI source writer.",
        "Use read/edit/write only. Do not use bash, build, test, commit, push, launch hosts, access WASAPI, or invoke recursive orchestration.",
        "Preserve unrelated dirty work and report exact changed paths.",
      ].join("\n"),
    ),
    WRITER_TOOLS,
    writerTuple,
    true,
  );
  if (implementation.exitCode !== 0 || !resultMatchesWriter(implementation, writerTuple)) {
    failures.push("The sole implementation writer failed or returned a route identity inconsistent with the resolved writer tuple.");
    return finish("fail", params.task, spawnGuard, outputs, records, failures, writerTuple, repairRan, finalizerRan, lockAcquisitions);
  }

  // Barrier 4: exactly two source-only reviews overlap after the writer exits.
  const reviewPrompts = [
    "musical, control, and native correctness",
    "security, lifecycle, process cleanup, and test adequacy",
  ].map((perspective, index) =>
    buildPrompt(
      "parallel-read-only-source-review",
      params.task,
      [synthesis, implementation],
      [
        `SOURCE_REVIEW_INSTANCE: ${index + 1}/2`,
        `Review ${perspective}. Read source and diffs only; do not use bash, edit, write, build, or test.`,
        "Return only strict JSON (no fence or commentary):",
        '{"status":"PASS|FAIL","findings":[{"summary":"...","evidence":"...","repair":"...","file":"relative/path","line":1}]}',
        "PASS requires an empty findings array. Every FAIL finding must be concrete and file-cited.",
      ].join("\n"),
    ),
  );
  const reviewResults = await Promise.all(
    reviewPrompts.map((prompt, index) =>
      launch("parallel-read-only-source-review", params.verifierAgent, prompt, READ_ONLY_TOOLS, verifierRoute, false, index + 1),
    ),
  );

  const parsedReviews: ReviewVerdict[] = [];
  let protocolFailure = false;
  for (const [index, result] of reviewResults.entries()) {
    if (result.exitCode !== 0) {
      failures.push(`Source review ${index + 1} exited nonzero.`);
      protocolFailure = true;
      continue;
    }
    try {
      parsedReviews.push(parseReviewVerdict(result.text));
    } catch (error) {
      failures.push(`Source review ${index + 1} malformed strict JSON: ${errorMessage(error)}`);
      protocolFailure = true;
    }
  }

  // Barrier 5: scheduler owns one atomic cross-process lock and one verifier,
  // regardless of verifierCount. The lock is always released before repair.
  const initialMachine = await runMachineLane({
    label: "exclusive-machine-test-lane",
    prompt: buildMachinePrompt("INITIAL_MACHINE_VERIFICATION", params.task, synthesis, reviewResults),
    cwd: params.cwd,
    lockPath: deps.machineLockPath,
    lockOwner: context.runId ?? `pid-${process.pid}`,
    spawn: () => launch(
      "exclusive-machine-test-lane",
      params.verifierAgent,
      buildMachinePrompt("INITIAL_MACHINE_VERIFICATION", params.task, synthesis, reviewResults),
      MACHINE_TOOLS,
      verifierRoute,
    ),
    onLockEvent: deps.onLockEvent,
  });
  if (initialMachine.lockAcquired) lockAcquisitions++;
  if (initialMachine.error) failures.push(initialMachine.error);
  if (initialMachine.contentChanged) {
    failures.push("The read-only initial machine verifier changed tracked or nonignored untracked working-file contents.");
    protocolFailure = true;
  }

  let initialVerdict: MachineVerdict | undefined;
  if (initialMachine.result) {
    if (initialMachine.result.exitCode !== 0) {
      failures.push("Initial machine verifier exited nonzero.");
      protocolFailure = true;
    } else {
      try {
        initialVerdict = parseMachineVerdict(initialMachine.result.text);
        if (!hasCleanupProof(initialVerdict)) {
          failures.push("Initial machine verdict is missing passing process/resource cleanup proof.");
          protocolFailure = true;
        }
      } catch (error) {
        failures.push(`Initial machine verdict malformed strict JSON: ${errorMessage(error)}`);
        protocolFailure = true;
      }
    }
  } else {
    protocolFailure = true;
  }

  const reviewsPass =
    parsedReviews.length === 2 && parsedReviews.every((verdict) => verdict.status === "PASS");
  const initialMachinePass = initialVerdict?.status === "PASS" && hasCleanupProof(initialVerdict);
  let finalMachineVerdict = initialVerdict;
  let finalMachinePass = Boolean(!protocolFailure && reviewsPass && initialMachinePass);

  if (!finalMachinePass && !protocolFailure) {
    const concreteFindings = [
      ...parsedReviews.filter((verdict) => verdict.status === "FAIL").flatMap((verdict) => verdict.findings),
      ...(initialVerdict?.status === "FAIL" ? initialVerdict.findings : []),
    ].filter(isConcreteFinding);

    if (concreteFindings.length > 0) {
      repairRan = true;
      const repair = await launch(
        "bounded-same-writer-repair",
        writerTuple.agentName,
        buildPrompt(
          "bounded-same-writer-repair",
          params.task,
          [implementation, ...reviewResults, ...(initialMachine.result ? [initialMachine.result] : [])],
          [
            "Perform the one permitted bounded repair as the exact same logical writer tuple used for implementation.",
            "Use read/edit/write only. Do not use bash, build, test, commit, push, launch hosts, or access WASAPI.",
            `CONCRETE_FINDINGS_JSON:\n${JSON.stringify(concreteFindings)}`,
          ].join("\n"),
        ),
        WRITER_TOOLS,
        writerTuple,
        true,
      );

      if (repair.exitCode !== 0 || !resultMatchesWriter(repair, writerTuple)) {
        failures.push("The single bounded repair failed or changed logical writer route identity.");
      } else {
        const retestPrompt = buildMachinePrompt(
          "FINAL_SERIALIZED_RETEST",
          params.task,
          synthesis,
          [repair, ...(initialMachine.result ? [initialMachine.result] : [])],
        );
        const retest = await runMachineLane({
          label: "exclusive-serialized-retest",
          prompt: retestPrompt,
          cwd: params.cwd,
          lockPath: deps.machineLockPath,
          lockOwner: context.runId ?? `pid-${process.pid}`,
          spawn: () => launch(
            "exclusive-serialized-retest",
            params.verifierAgent,
            retestPrompt,
            MACHINE_TOOLS,
            verifierRoute,
          ),
          onLockEvent: deps.onLockEvent,
        });
        if (retest.lockAcquired) lockAcquisitions++;
        if (retest.error) failures.push(retest.error);
        if (retest.contentChanged) failures.push("The read-only retest verifier changed working-file contents.");

        if (retest.result && retest.result.exitCode === 0 && !retest.error && !retest.contentChanged) {
          try {
            finalMachineVerdict = parseMachineVerdict(retest.result.text);
            finalMachinePass = finalMachineVerdict.status === "PASS" && hasCleanupProof(finalMachineVerdict);
            if (!hasCleanupProof(finalMachineVerdict)) failures.push("Final retest lacks passing cleanup proof.");
            if (finalMachineVerdict.status !== "PASS") failures.push("Final retest verdict is FAIL.");
          } catch (error) {
            failures.push(`Final retest verdict malformed strict JSON: ${errorMessage(error)}`);
          }
        } else {
          failures.push("Final retest did not complete cleanly with exit code zero.");
        }
      }
    } else {
      failures.push("A gate failed without concrete repair findings; fail-closed policy forbids a speculative repair.");
    }
  }

  if (!finalMachinePass) {
    return finish("fail", params.task, spawnGuard, outputs, records, failures, writerTuple, repairRan, finalizerRan, lockAcquisitions, finalMachineVerdict);
  }

  // Barrier 6: finalizer is PASS-gated, reuses the writer tuple, cannot edit or
  // write, and is checked for working-content mutation independently.
  finalizerRan = true;
  const beforeFinalize = await fingerprintWorkingContents(params.cwd);
  const beforeGit = await readLocalGitIdentity(params.cwd);
  let finalizer: SubagentResult | undefined;
  let finalizerLaunchError: unknown;
  try {
    finalizer = await launch(
      "same-writer-finalize",
      writerTuple.agentName,
      buildPrompt(
        "same-writer-finalize",
        params.task,
        [...(finalMachineVerdict ? [syntheticResult("machine-verdict", JSON.stringify(finalMachineVerdict))] : [])],
        [
          "The final serialized machine verdict is PASS with cleanup proof.",
          "Use read/bash only: inspect, stage, commit, push, and verify, but do not edit or write working files.",
          "Return only strict JSON (no fence or commentary):",
          '{"status":"PASS|FAIL","action":"committed|noop","branch":"...","localHash":"...","remoteHash":"...","taskRelevantChangesRemain":false,"sensoryCard":"...","reason":"optional"}',
          "noop is permitted only when local/remote already match and no task-relevant changes remain.",
        ].join("\n"),
      ),
      MACHINE_TOOLS,
      writerTuple,
    );
  } catch (error) {
    finalizerLaunchError = error;
  }
  const afterFinalize = await fingerprintWorkingContents(params.cwd);
  if (beforeFinalize !== afterFinalize) {
    failures.push("Finalizer changed tracked or nonignored untracked working-file contents.");
    return finish("fail", params.task, spawnGuard, outputs, records, failures, writerTuple, repairRan, finalizerRan, lockAcquisitions, finalMachineVerdict);
  }
  if (finalizerLaunchError || !finalizer) {
    failures.push(`Finalizer subprocess failed: ${errorMessage(finalizerLaunchError)}`);
    return finish("fail", params.task, spawnGuard, outputs, records, failures, writerTuple, repairRan, finalizerRan, lockAcquisitions, finalMachineVerdict);
  }
  if (finalizer.exitCode !== 0 || !resultMatchesWriter(finalizer, writerTuple)) {
    failures.push("Finalizer exited nonzero or changed logical writer route identity.");
    return finish("fail", params.task, spawnGuard, outputs, records, failures, writerTuple, repairRan, finalizerRan, lockAcquisitions, finalMachineVerdict);
  }

  let finalizerVerdict: FinalizerVerdict;
  try {
    finalizerVerdict = parseFinalizerVerdict(finalizer.text);
  } catch (error) {
    failures.push(`Finalizer verdict malformed strict JSON: ${errorMessage(error)}`);
    return finish("fail", params.task, spawnGuard, outputs, records, failures, writerTuple, repairRan, finalizerRan, lockAcquisitions, finalMachineVerdict);
  }
  if (finalizerVerdict.status !== "PASS") {
    failures.push(`Finalizer reported FAIL${finalizerVerdict.reason ? `: ${finalizerVerdict.reason}` : "."}`);
    return finish("fail", params.task, spawnGuard, outputs, records, failures, writerTuple, repairRan, finalizerRan, lockAcquisitions, finalMachineVerdict, finalizerVerdict);
  }

  try {
    const independent = await verifyLocalRemoteIdentity(params.cwd);
    const claimsMatch =
      finalizerVerdict.branch === independent.branch &&
      finalizerVerdict.localHash.toLowerCase() === independent.localHash &&
      finalizerVerdict.remoteHash.toLowerCase() === independent.remoteHash;
    if (!claimsMatch) throw new Error("finalizer hash/branch claims do not match independent git observations");
    if (finalizerVerdict.taskRelevantChangesRemain) throw new Error("task-relevant changes remain after finalization");
    if (finalizerVerdict.action === "noop" && beforeGit.localHash !== independent.localHash) {
      throw new Error("noop finalizer changed HEAD");
    }
    if (finalizerVerdict.action === "committed" && beforeGit.localHash === independent.localHash) {
      throw new Error("committed finalizer did not advance HEAD");
    }
  } catch (error) {
    failures.push(`Independent local/remote verification failed: ${errorMessage(error)}`);
    return finish("fail", params.task, spawnGuard, outputs, records, failures, writerTuple, repairRan, finalizerRan, lockAcquisitions, finalMachineVerdict, finalizerVerdict);
  }

  return finish("pass", params.task, spawnGuard, outputs, records, failures, writerTuple, repairRan, finalizerRan, lockAcquisitions, finalMachineVerdict, finalizerVerdict);
}

function resolveWriterTuple(
  params: OrchestrationShapeContext["params"],
  agents: Map<string, AgentProfile>,
  inheritedModel?: { provider?: string; model?: string },
): WriterTuple {
  const explicit = resolveShapePhaseRoute("executor", params.executorAgent, params);
  const profile = agents.get(params.executorAgent);
  const provider = explicit?.provider ?? profile?.provider ?? inheritedModel?.provider;
  const model = explicit?.model ?? profile?.model ?? inheritedModel?.model;
  if (!provider || !model) {
    throw new Error("Executor route must resolve to an explicit provider/model before any work spawns.");
  }
  return { agentName: params.executorAgent, provider, model };
}

function assertAllowlistedWriter(tuple: WriterTuple): void {
  const provider = tuple.provider.trim().toLowerCase();
  const model = tuple.model.trim().toLowerCase();
  const route = `${provider}/${model}`;
  if (provider.includes("openrouter") || model.includes("openrouter")) {
    throw new Error(`Executor route ${tuple.provider}/${tuple.model} is rejected: every OpenRouter executor route is forbidden. No work was spawned.`);
  }
  if (provider.includes("deepseek") || model.includes("deepseek")) {
    throw new Error(`Executor route ${tuple.provider}/${tuple.model} is rejected: DeepSeek executors are forbidden. No work was spawned.`);
  }
  if (!ALLOWED_EXECUTOR_ROUTES.has(route)) {
    throw new Error(
      `Executor route ${tuple.provider}/${tuple.model} is not allowlisted. Allowed direct routes: ` +
        [...ALLOWED_EXECUTOR_ROUTES].join(", ") + ". No work was spawned.",
    );
  }
}

function cloneProfileWithTools(
  agents: Map<string, AgentProfile>,
  agentName: string,
  tools: readonly string[],
  route?: { provider?: string; model?: string },
): Map<string, AgentProfile> {
  const cloned = new Map(agents);
  const base = agents.get(agentName) ?? { name: agentName };
  cloned.set(agentName, {
    ...base,
    name: agentName,
    ...(route?.provider ? { provider: route.provider } : {}),
    ...(route?.model ? { model: route.model } : {}),
    tools: [...tools],
  });
  return cloned;
}

function buildPrompt(phase: string, task: string, prior: SubagentResult[], instructions: string): string {
  return [
    `SSI_SHAPE_PHASE: ${phase}`,
    "You are one isolated subprocess in a finite orchestration. Do not invoke recursive orchestration.",
    `ORIGINAL_TASK:\n${task}`,
    prior.length
      ? `PRIOR_OUTPUTS:\n${prior.map((item, index) => `[${index + 1}] ${item.agentName}: ${truncateWithNotice(item.text, 4000, "prior output")}`).join("\n\n")}`
      : "PRIOR_OUTPUTS: none",
    instructions,
  ].join("\n\n");
}

function buildMachinePrompt(
  marker: "INITIAL_MACHINE_VERIFICATION" | "FINAL_SERIALIZED_RETEST",
  task: string,
  synthesis: SubagentResult,
  prior: SubagentResult[],
): string {
  return buildPrompt(
    marker === "INITIAL_MACHINE_VERIFICATION" ? "exclusive-machine-test-lane" : "exclusive-serialized-retest",
    task,
    [synthesis, ...prior],
    [
      marker,
      "You are the only machine verifier holding the scheduler-owned SSI machine-resource lock.",
      "Run the synthesized ordinary SSI gate commands strictly one at a time: await each command and cleanup before starting the next.",
      "Do not edit or write source. Do not recursively orchestrate. Verify zero surviving SSI-owned processes and released process/device resources.",
      "Return only strict JSON (no fence or commentary):",
      '{"status":"PASS|FAIL","checks":[{"command":"...","status":"PASS|FAIL","exitCode":0,"evidence":"..."}],"cleanup":{"status":"PASS|FAIL","survivingProcesses":[],"resourcesReleased":true},"findings":[{"summary":"...","evidence":"...","repair":"..."}]}',
      "Overall PASS requires every check PASS and cleanup PASS with no surviving processes and resourcesReleased=true.",
    ].join("\n"),
  );
}

async function runMachineLane(input: {
  label: string;
  prompt: string;
  cwd: string;
  lockPath: string;
  lockOwner: string;
  spawn: () => Promise<SubagentResult>;
  onLockEvent?: RuntimeDependencies["onLockEvent"];
}): Promise<{
  result?: SubagentResult;
  error?: string;
  contentChanged: boolean;
  lockAcquired: boolean;
}> {
  let acquired = false;
  let before: string | undefined;
  let result: SubagentResult | undefined;
  let error: string | undefined;
  let contentChanged = false;
  try {
    await mkdir(input.lockPath); // atomic across processes; EEXIST fails closed
    acquired = true;
    input.onLockEvent?.("acquired", input.lockPath);
    await writeFile(
      path.join(input.lockPath, "owner.json"),
      JSON.stringify({ owner: input.lockOwner, pid: process.pid, phase: input.label, acquiredAt: new Date().toISOString() }),
      "utf8",
    );
    before = await fingerprintWorkingContents(input.cwd);
    result = await input.spawn();
  } catch (caught) {
    const code = (caught as NodeJS.ErrnoException)?.code;
    error = code === "EEXIST"
      ? `SSI machine-resource lock is already held at ${input.lockPath}; ${input.label} did not spawn.`
      : `${input.label} failed: ${errorMessage(caught)}`;
  } finally {
    if (before !== undefined) {
      try {
        const after = await fingerprintWorkingContents(input.cwd);
        contentChanged = before !== after;
      } catch (caught) {
        error = `${error ? `${error}; ` : ""}failed to fingerprint working contents after ${input.label}: ${errorMessage(caught)}`;
      }
    }
    if (acquired) {
      try {
        await rm(input.lockPath, { recursive: true, force: false });
        input.onLockEvent?.("released", input.lockPath);
      } catch (caught) {
        error = `${error ? `${error}; ` : ""}failed to release scheduler-owned SSI lock: ${errorMessage(caught)}`;
      }
    }
  }
  return { result, error, contentChanged, lockAcquired: acquired };
}

function parseStrictObject(text: string, label: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${label} is empty`);
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${label} is not one complete JSON value: ${errorMessage(error)}`);
  }
  if (!isRecord(value)) throw new Error(`${label} root must be an object`);
  return value;
}

function parseReviewVerdict(text: string): ReviewVerdict {
  const value = parseStrictObject(text, "review verdict");
  const status = parseStatus(value.status, "review status");
  if (!Array.isArray(value.findings)) throw new Error("review findings must be an array");
  const findings = value.findings.map((finding, index) => parseFinding(finding, `review finding ${index + 1}`, true));
  if (status === "PASS" && findings.length > 0) throw new Error("PASS review must have no findings");
  return { status, findings };
}

function parseMachineVerdict(text: string): MachineVerdict {
  const value = parseStrictObject(text, "machine verdict");
  const status = parseStatus(value.status, "machine status");
  if (!Array.isArray(value.checks) || value.checks.length === 0) throw new Error("machine checks must be a nonempty array");
  const checks = value.checks.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`machine check ${index + 1} must be an object`);
    const command = nonemptyString(raw.command, `machine check ${index + 1} command`);
    const checkStatus = parseStatus(raw.status, `machine check ${index + 1} status`);
    if (!Number.isInteger(raw.exitCode)) throw new Error(`machine check ${index + 1} exitCode must be an integer`);
    const evidence = nonemptyString(raw.evidence, `machine check ${index + 1} evidence`);
    return { command, status: checkStatus, exitCode: raw.exitCode as number, evidence };
  });
  if (!isRecord(value.cleanup)) throw new Error("machine cleanup must be an object");
  const cleanupStatus = parseStatus(value.cleanup.status, "cleanup status");
  if (!Array.isArray(value.cleanup.survivingProcesses) || !value.cleanup.survivingProcesses.every((item) => typeof item === "string")) {
    throw new Error("cleanup survivingProcesses must be a string array");
  }
  if (typeof value.cleanup.resourcesReleased !== "boolean") throw new Error("cleanup resourcesReleased must be boolean");
  if (!Array.isArray(value.findings)) throw new Error("machine findings must be an array");
  const findings = value.findings.map((finding, index) => parseFinding(finding, `machine finding ${index + 1}`, false));
  const cleanup = {
    status: cleanupStatus,
    survivingProcesses: value.cleanup.survivingProcesses as string[],
    resourcesReleased: value.cleanup.resourcesReleased,
  };
  if (status === "PASS") {
    if (checks.some((check) => check.status !== "PASS" || check.exitCode !== 0)) throw new Error("PASS machine verdict contains a failing check");
    if (!hasCleanupProof({ status, checks, cleanup, findings })) throw new Error("PASS machine verdict lacks cleanup proof");
    if (findings.length > 0) throw new Error("PASS machine verdict must have no findings");
  }
  return { status, checks, cleanup, findings };
}

function parseFinalizerVerdict(text: string): FinalizerVerdict {
  const value = parseStrictObject(text, "finalizer verdict");
  const status = parseStatus(value.status, "finalizer status");
  if (value.action !== "committed" && value.action !== "noop") throw new Error("finalizer action must be committed or noop");
  const branch = nonemptyString(value.branch, "finalizer branch");
  const localHash = gitHash(value.localHash, "finalizer localHash");
  const remoteHash = gitHash(value.remoteHash, "finalizer remoteHash");
  if (typeof value.taskRelevantChangesRemain !== "boolean") throw new Error("taskRelevantChangesRemain must be boolean");
  const sensoryCard = nonemptyString(value.sensoryCard, "finalizer sensoryCard");
  const reason = value.reason === undefined ? undefined : nonemptyString(value.reason, "finalizer reason");
  return {
    status,
    action: value.action,
    branch,
    localHash,
    remoteHash,
    taskRelevantChangesRemain: value.taskRelevantChangesRemain,
    sensoryCard,
    ...(reason ? { reason } : {}),
  };
}

function parseFinding(raw: unknown, label: string, requireFile: boolean): Finding {
  if (!isRecord(raw)) throw new Error(`${label} must be an object`);
  const finding: Finding = {
    summary: nonemptyString(raw.summary, `${label} summary`),
    evidence: nonemptyString(raw.evidence, `${label} evidence`),
    repair: nonemptyString(raw.repair, `${label} repair`),
  };
  if (requireFile) {
    finding.file = nonemptyString(raw.file, `${label} file`);
    if (!Number.isInteger(raw.line) || (raw.line as number) < 1) throw new Error(`${label} line must be a positive integer`);
    finding.line = raw.line as number;
  }
  return finding;
}

function parseStatus(value: unknown, label: string): "PASS" | "FAIL" {
  if (value !== "PASS" && value !== "FAIL") throw new Error(`${label} must be exactly PASS or FAIL`);
  return value;
}

function hasCleanupProof(verdict: MachineVerdict): boolean {
  return verdict.cleanup.status === "PASS" &&
    verdict.cleanup.survivingProcesses.length === 0 &&
    verdict.cleanup.resourcesReleased === true;
}

function isConcreteFinding(finding: Finding): boolean {
  return Boolean(finding.summary.trim() && finding.evidence.trim() && finding.repair.trim());
}

function resultMatchesWriter(result: SubagentResult, tuple: WriterTuple): boolean {
  return result.agentName === tuple.agentName &&
    (!result.provider || result.provider === tuple.provider) &&
    (!result.model || result.model === tuple.model);
}

function allExitedZero(results: SubagentResult[]): boolean {
  return results.every((result) => result.exitCode === 0);
}

async function fingerprintWorkingContents(cwd: string): Promise<string> {
  const listed = await git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const files = [...new Set(listed.split("\0").filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const hash = createHash("sha256");
  for (const relative of files) {
    updateFramed(hash, relative);
    const absolute = path.resolve(cwd, relative);
    let stat;
    try {
      stat = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        updateFramed(hash, "<missing>");
        continue;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      updateFramed(hash, "<symlink>");
      updateFramed(hash, await readlink(absolute));
    } else if (stat.isFile()) {
      updateFramed(hash, "<file>");
      updateFramed(hash, await readFile(absolute));
    } else {
      updateFramed(hash, `<other:${stat.mode}>`);
    }
  }
  return hash.digest("hex");
}

function updateFramed(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

async function readLocalGitIdentity(cwd: string): Promise<{ branch: string; localHash: string }> {
  const branch = (await git(cwd, ["branch", "--show-current"])).trim();
  if (!branch) throw new Error("working tree is on a detached HEAD");
  const localHash = gitHash((await git(cwd, ["rev-parse", "HEAD"])).trim(), "local HEAD");
  return { branch, localHash };
}

async function verifyLocalRemoteIdentity(cwd: string): Promise<{ branch: string; localHash: string; remoteHash: string }> {
  const local = await readLocalGitIdentity(cwd);
  const ref = `refs/heads/${local.branch}`;
  const output = await git(cwd, ["ls-remote", "--exit-code", "origin", ref]);
  const matching = output
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/))
    .find((parts) => parts[1] === ref);
  if (!matching) throw new Error(`origin did not report ${ref}`);
  const remoteHash = gitHash(matching[0], "remote tip");
  if (local.localHash !== remoteHash) {
    throw new Error(`local HEAD ${local.localHash} does not equal origin ${ref} ${remoteHash}`);
  }
  return { ...local, remoteHash };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  }) as { stdout: string | Buffer };
  return typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf8");
}

function gitHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{40,64}$/.test(value)) throw new Error(`${label} must be a Git object hash`);
  return value.toLowerCase();
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function syntheticResult(agentName: string, text: string): SubagentResult {
  return { agentName, task: "", text, stderr: "", exitCode: 0, durationMs: 0, events: 0 };
}

function finish(
  status: "pass" | "fail",
  task: string,
  spawnGuard: SpawnGuard,
  outputs: SubagentResult[],
  records: Array<Record<string, unknown>>,
  failures: string[],
  writerTuple: WriterTuple,
  repairRan: boolean,
  finalizerRan: boolean,
  lockAcquisitions: number,
  machineVerdict?: MachineVerdict,
  finalizerVerdict?: FinalizerVerdict,
): OrchestrationShapeResult {
  const route = `${writerTuple.agentName}@${writerTuple.provider}/${writerTuple.model}`;
  const lines = [
    `# ssi-single-writer-exclusive-lane Orchestration: ${status.toUpperCase()}`,
    "",
    `**Task:** ${truncateWithNotice(task, 2000, "task")}`,
    `**Logical writer tuple:** ${route}`,
    `**Repair ran:** ${repairRan ? "yes (one bounded repair and one retest)" : "no"}`,
    `**Machine lock acquisitions:** ${lockAcquisitions}`,
    `**Subagents spawned:** ${spawnGuard.spawned}/${spawnGuard.cap}`,
    "",
    "Same logical writer means the exact agentName/provider/model tuple was reused across isolated subprocesses; it does not mean one persistent process.",
  ];
  if (failures.length) lines.push("", "## Failures", ...failures.map((failure) => `- ${failure}`));
  if (finalizerVerdict?.sensoryCard && status === "pass") lines.push("", "## Sensory test card", finalizerVerdict.sensoryCard);
  lines.push("", "## Phase outputs");
  outputs.forEach((output, index) => {
    lines.push(`### ${index + 1}. ${records[index]?.phase ?? output.agentName}`, truncateWithNotice(output.text, 2500, "phase output"));
  });
  return {
    markdown: truncateWithNotice(lines.join("\n"), MAX_FINAL_CHARS, "final report"),
    details: {
      status,
      paradigm: "ssi-single-writer-exclusive-lane",
      spawnedCount: spawnGuard.spawned,
      spawnedCap: spawnGuard.cap,
      requestedVerifierCountIgnoredForMachineLane: true,
      writerTuple,
      writerTupleMeaning: "Exact agentName/provider/model reused across isolated subprocesses.",
      repairRan,
      finalizerRan,
      lockAcquisitions,
      machineVerdict,
      finalizerVerdict,
      failures,
      roleResults: records,
      outputs: outputs.map((output) => ({
        agentName: output.agentName,
        provider: output.provider,
        model: output.model,
        exitCode: output.exitCode,
        durationMs: output.durationMs,
        text: truncateWithNotice(output.text, 2000, "phase output"),
      })),
    },
  };
}
