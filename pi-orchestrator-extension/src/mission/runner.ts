import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { compileMissionContract } from "./contract";
import { FileMissionJournal, MissionJournalError } from "./event-store";
import { FileWorkspaceLease, WorkspaceLeaseError } from "./lease";
import type {
  CompiledMission,
  MissionEvent,
  MissionProjection,
  MissionWorker,
  MissionWorkerEvent,
  MissionWorkerIdentity,
  MissionWorkerInspection,
  MissionWorkerFactory,
  NewMissionEvent,
  ProcessInspector,
  WorkspaceEffect,
  WorkspaceLeaseHandle,
  WorkspaceSnapshotRecord,
} from "./types";
import { pinNodeWorkspaceValidator, runPinnedNodeValidator, type PinnedNodeValidator } from "./validator";
import { captureWorkspaceSnapshot, diffWorkspaceSnapshots, readWorkspaceSnapshot, writeWorkspaceSnapshot } from "./workspace";

export interface DurableMissionRunOptions {
  contract: CompiledMission | Parameters<typeof compileMissionContract>[0];
  workerFactory: MissionWorkerFactory;
  runId?: string;
  runsRoot?: string;
  signal?: AbortSignal;
  processInspector?: ProcessInspector;
  ownerPid?: number;
  ownerProcessStartedAt?: string;
  leaseTtlMs?: number;
  onEvent?: (event: MissionEvent) => void;
  onProgress?: (message: string) => void;
}

export interface DurableMissionResult {
  runId: string;
  status: "pass" | "fail" | "pending" | "outcome-unknown" | "cancelled";
  runDirectory: string;
  eventFile: string;
  projection: MissionProjection;
}

export async function runDurableMission(options: DurableMissionRunOptions): Promise<DurableMissionResult> {
  const compiled = isCompiledMission(options.contract) ? options.contract : compileMissionContract(options.contract);
  const runsRoot = path.resolve(options.runsRoot ?? defaultMissionRunsRoot());
  assertRunsRootOutsideWorkspace(compiled.contract.cwd, runsRoot);
  const requestedRunId = options.runId?.trim();
  const runId = requestedRunId || `mission-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const existing = existsSync(path.join(runsRoot, runId));
  const journal = existing ? FileMissionJournal.open(runsRoot, runId) : FileMissionJournal.create(runsRoot, runId);
  let lease: WorkspaceLeaseHandle | undefined;
  let worker: MissionWorker | undefined;
  let workerIdentity: MissionWorkerIdentity | undefined;
  let generation = existing ? journal.projection().generation : 1;
  const append = (event: Omit<NewMissionEvent, "runId" | "generation"> & { generation?: number }): MissionEvent => {
    const stored = journal.append({ ...event, runId, generation: event.generation ?? generation });
    options.onEvent?.(stored);
    options.onProgress?.(`Durable mission ${runId}: ${stored.type}`);
    return stored;
  };

  try {
    if (!existing) {
      append({
        type: "mission.created",
        data: {
          missionHash: compiled.missionHash,
          canonicalJson: compiled.canonicalJson,
          cwd: compiled.contract.cwd,
          workerAdapter: options.workerFactory.adapterName,
        },
      });
    } else {
      assertPinnedMission(journal.readAll(), compiled, options.workerFactory.adapterName);
    }

    const prior = journal.projection();
    if (prior.state === "SUCCEEDED" || prior.state === "FAILED" || prior.state === "CANCELLED") {
      throw new MissionRunnerError("MISSION_ALREADY_TERMINAL", `${runId} is ${prior.state}`);
    }
    if (prior.state === "OUTCOME_UNKNOWN") return resultFor(journal, "outcome-unknown");
    try {
      lease = FileWorkspaceLease.acquire({
        leaseRoot: path.join(path.dirname(journal.runDirectory), "workspace-leases"),
        workspacePath: compiled.contract.cwd,
        workspaceFingerprint: compiled.contract.workspaceFingerprint,
        runId,
        missionHash: compiled.missionHash,
        ttlMs: options.leaseTtlMs,
        processInspector: options.processInspector,
        ownerPid: options.ownerPid,
        ownerProcessStartedAt: options.ownerProcessStartedAt,
      });
      generation = lease.record.generation;
      append({ type: "lease.acquired", data: { lease: publicLease(lease.record) } });
    } catch (error) {
      if (error instanceof WorkspaceLeaseError && error.code === "WORKSPACE_WRITER_UNCLASSIFIED") {
        append({
          type: "mission.outcome-unknown",
          generation: prior.generation,
          data: { reason: "the prior workspace lease owner died before a worker identity was fenced; inspect for an unrecorded writer before retry" },
        });
        return resultFor(journal, "outcome-unknown");
      }
      if (error instanceof WorkspaceLeaseError && (error.code === "WORKSPACE_WRITER_ACTIVE" || error.code === "WORKSPACE_SUPERVISOR_ACTIVE")) {
        const inspection = prior.worker ? await options.workerFactory.inspect(prior.worker).catch(() => undefined) : undefined;
        append({
          type: "mission.paused",
          generation: prior.generation,
          data: {
            reason: inspection?.state === "running" || inspection?.state === "idle"
              ? "prior mission worker is still alive"
              : error.message,
            nextAction: "wait-worker",
          },
        });
        return resultFor(journal, "pending");
      }
      throw error;
    }

    if (existing) append({ type: "mission.resumed", data: { previousGeneration: prior.generation, missionHash: compiled.missionHash } });
    else append({ type: "mission.started", data: { missionHash: compiled.missionHash } });

    const baseline = existing
      ? loadBaselineSnapshot(journal.runDirectory, journal.projection())
      : captureAndPersistSnapshot(journal.runDirectory, compiled.contract.cwd, "baseline");
    let resumeReconciliation: { snapshot: WorkspaceSnapshotRecord; effects: WorkspaceEffect[] } | undefined;
    if (!existing) append({ type: "workspace.snapshot", data: { role: "baseline", digest: baseline.digest, file: snapshotFile(journal.runDirectory, "baseline", baseline.digest) } });
    else resumeReconciliation = reconcileWorkspace(journal, append, baseline, compiled.contract.cwd, "resume");

    const pinnedValidator = compiled.contract.validator.kind === "node-workspace-validator"
      ? pinNodeWorkspaceValidator(compiled.contract.cwd, journal.runDirectory, compiled.contract.validator, existing)
      : undefined;
    if (pinnedValidator && !existing) append({ type: "validator.pinned", data: { sha256: pinnedValidator.sha256, file: pinnedValidator.pinnedFile } });

    let prompt = initialPrompt(compiled);
    if (existing) {
      const resumeAction = prior.nextAction;
      if (resumeAction === "inspect-outcome") {
        releaseLease(lease, append);
        append({ type: "mission.outcome-unknown", data: { reason: prior.reason ?? "durable state requires outcome inspection before another writer starts" } });
        return resultFor(journal, "outcome-unknown");
      }
      if (prior.validator?.status === "pass") {
        releaseLease(lease, append);
        append({ type: "mission.succeeded", data: { reason: "durable host validator pass recovered before terminal publication", validatorSha256: prior.validator.validatorSha256 } });
        return resultFor(journal, "pass");
      }
      if (resumeAction === "validate") {
        if (!pinnedValidator) {
          if (resumeReconciliation?.effects.length) {
            releaseLease(lease, append);
            append({ type: "mission.failed", data: { reason: `read-only mission observed ${resumeReconciliation.effects.length} workspace effect(s)` } });
            return resultFor(journal, "fail");
          }
          releaseLease(lease, append);
          append({ type: "mission.succeeded", data: { reason: "read-only worker settlement recovered without workspace effects" } });
          return resultFor(journal, "pass");
        }
        const settledTurn = prior.usage.turns;
        append({ type: "validator.started", data: { turn: settledTurn, sha256: pinnedValidator.sha256, resumed: true } });
        const validator = await runPinnedNodeValidator(pinnedValidator, compiled.contract.cwd, options.signal);
        append({ type: "validator.completed", data: { turn: settledTurn, result: validator, resumed: true } });
        if (options.signal?.aborted) {
          releaseLease(lease, append);
          append({ type: "mission.cancelled", data: { reason: "caller aborted during recovered validation" } });
          return resultFor(journal, "cancelled");
        }
        if (validator.status === "pass") {
          releaseLease(lease, append);
          append({ type: "mission.succeeded", data: { reason: "recovered host validator passed", validatorSha256: validator.validatorSha256 } });
          return resultFor(journal, "pass");
        }
        prompt = repairPrompt(compiled, validator, resumeReconciliation?.effects ?? [], settledTurn);
        append({ type: "repair.requested", data: { turn: settledTurn, feedback: prompt, validator, resumed: true } });
      } else if (resumeAction === "repair") {
        if (!prior.validator) {
          releaseLease(lease, append);
          append({ type: "mission.outcome-unknown", data: { reason: "repair was requested without a durable failing validator result" } });
          return resultFor(journal, "outcome-unknown");
        }
        prompt = repairPrompt(compiled, prior.validator, resumeReconciliation?.effects ?? [], prior.usage.turns);
      } else {
        prompt = recoveryPrompt(compiled, journal.projection());
      }
      if (prior.usage.restarts >= compiled.contract.budgets.maxRestarts) {
        releaseLease(lease, append);
        append({ type: "budget.exhausted", data: { reason: "restart budget exhausted before replacement worker" } });
        return resultFor(journal, "fail");
      }
    }

    if (options.signal?.aborted) {
      releaseLease(lease, append);
      append({ type: "mission.cancelled", data: { reason: "caller aborted before worker start" } });
      return resultFor(journal, "cancelled");
    }

    const preWorkerBudgetReason = exhaustedBudget(compiled, journal.projection());
    if (preWorkerBudgetReason) {
      releaseLease(lease, append);
      append({ type: "budget.exhausted", data: { reason: preWorkerBudgetReason } });
      return resultFor(journal, "fail");
    }

    const projectionBeforeWorker = journal.projection();
    worker = await options.workerFactory.open({
      runId,
      generation,
      cwd: compiled.contract.cwd,
      route: compiled.contract.route,
      fallbacks: compiled.contract.fallbacks,
      readOnly: compiled.contract.validator.kind === "none",
      ...(existing && projectionBeforeWorker.worker ? { resume: { ...projectionBeforeWorker.worker, generation } } : {}),
    });
    workerIdentity = assertWorkerIdentity(worker, options.workerFactory.adapterName, generation, compiled.contract.cwd, [compiled.contract.route, ...compiled.contract.fallbacks]);
    if (workerIdentity.pid) lease.bindWorker(workerIdentity.pid, workerIdentity.processStartedAt);
    append({ type: "worker.started", data: { identity: workerIdentity, resumed: existing && Boolean(projectionBeforeWorker.worker) } });

    while (true) {
      const projection = journal.projection();
      const budgetReason = exhaustedBudget(compiled, projection);
      if (budgetReason) {
        await closeWorkerBestEffort(worker, options.workerFactory);
        releaseLease(lease, append);
        append({ type: "budget.exhausted", data: { reason: budgetReason } });
        return resultFor(journal, "fail");
      }
      if (options.signal?.aborted) {
        try {
          await cancelWorker(worker, options.workerFactory);
        } catch (error) {
          append({ type: "mission.paused", data: { reason: cancellationCleanupReason(error), nextAction: "wait-worker" } });
          return resultFor(journal, "pending");
        }
        reconcileWorkspace(journal, append, baseline, compiled.contract.cwd, `cancel-${projection.usage.turns + 1}`);
        releaseLease(lease, append);
        append({ type: "mission.cancelled", data: { reason: "caller aborted" } });
        return resultFor(journal, "cancelled");
      }

      const turn = projection.usage.turns + 1;
      const workerOutcome = await runWorkerTurn(worker, prompt, options.signal, append, lease, turn);
      const after = reconcileWorkspace(journal, append, baseline, compiled.contract.cwd, `turn-${turn}`);
      if (options.signal?.aborted) {
        try {
          await cancelWorker(worker, options.workerFactory);
        } catch (error) {
          append({ type: "mission.paused", data: { reason: cancellationCleanupReason(error), nextAction: "wait-worker" } });
          return resultFor(journal, "pending");
        }
        releaseLease(lease, append);
        append({ type: "mission.cancelled", data: { reason: "caller aborted during worker turn" } });
        return resultFor(journal, "cancelled");
      }
      if (compiled.contract.validator.kind === "none" && after.effects.length) {
        await closeWorkerBestEffort(worker, options.workerFactory);
        releaseLease(lease, append);
        append({ type: "mission.failed", data: { reason: `read-only mission observed ${after.effects.length} workspace effect(s)` } });
        return resultFor(journal, "fail");
      }

      if (workerOutcome.kind === "failed") {
        const inspection = await worker.inspect();
        const durableInspection = publicWorkerInspection(inspection, workerIdentity!);
        append({ type: "worker.failed", data: { message: workerOutcome.message, recoverable: inspection.state === "exited" && Boolean(workerIdentity!.sessionFile), inspection: durableInspection } });
        if (inspection.state === "running") {
          append({ type: "mission.paused", data: { reason: "worker transport failed but process is still alive", nextAction: "wait-worker" } });
          return resultFor(journal, "pending");
        }
        await closeWorkerBestEffort(worker, options.workerFactory);
        if (inspection.state === "exited" && workerIdentity!.sessionFile) {
          append({ type: "worker.exited", data: { reason: workerOutcome.message, identity: workerIdentity } });
          releaseLease(lease, append);
          append({ type: "mission.paused", data: { reason: "worker exited; persistent session can be resumed", nextAction: "resume-worker" } });
          return resultFor(journal, "pending");
        }
        if (after.effects.length) {
          releaseLease(lease, append);
          append({ type: "mission.outcome-unknown", data: { reason: `worker failure after ${after.effects.length} observed effect(s): ${workerOutcome.message}` } });
          return resultFor(journal, "outcome-unknown");
        }
        releaseLease(lease, append);
        append({ type: "mission.failed", data: { reason: workerOutcome.message } });
        return resultFor(journal, "fail");
      }

      if (!pinnedValidator) {
        await closeWorkerBestEffort(worker, options.workerFactory);
        releaseLease(lease, append);
        append({ type: "mission.succeeded", data: { reason: "read-only worker settled without workspace effects" } });
        return resultFor(journal, "pass");
      }

      append({ type: "validator.started", data: { turn, sha256: pinnedValidator.sha256 } });
      const validator = await runPinnedNodeValidator(pinnedValidator, compiled.contract.cwd, options.signal);
      append({ type: "validator.completed", data: { turn, result: validator } });
      if (options.signal?.aborted) {
        try {
          await cancelWorker(worker, options.workerFactory);
        } catch (error) {
          append({ type: "mission.paused", data: { reason: cancellationCleanupReason(error), nextAction: "wait-worker" } });
          return resultFor(journal, "pending");
        }
        releaseLease(lease, append);
        append({ type: "mission.cancelled", data: { reason: "caller aborted during validation" } });
        return resultFor(journal, "cancelled");
      }
      if (validator.status === "pass") {
        await closeWorkerBestEffort(worker, options.workerFactory);
        releaseLease(lease, append);
        append({ type: "mission.succeeded", data: { reason: "host validator passed", validatorSha256: validator.validatorSha256 } });
        return resultFor(journal, "pass");
      }
      prompt = repairPrompt(compiled, validator, after.effects, turn);
      append({ type: "repair.requested", data: { turn, feedback: prompt, validator } });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof MissionJournalError) {
      // The authoritative log cannot safely describe cleanup. Release writer
      // authority only after the worker is confirmed gone; otherwise the live
      // lease remains the fail-closed fence until its owner process exits.
      const workerStopped = worker ? await terminateWorkerBestEffort(worker, options.workerFactory) : true;
      if (lease && workerStopped) releaseLeaseWithoutEventBestEffort(lease);
      throw error;
    }
    if (!lease && !worker && (error instanceof WorkspaceLeaseError || error instanceof MissionRunnerError)) throw error;

    const invariantFailure = error instanceof WorkspaceLeaseError || error instanceof MissionRunnerError;
    if (worker && invariantFailure) {
      const stopped = await terminateWorkerBestEffort(worker, options.workerFactory);
      if (!stopped) {
        append({ type: "mission.paused", data: { reason: `supervisor invariant failed and worker cleanup is unconfirmed: ${message}`, nextAction: "wait-worker" } });
        return resultFor(journal, "pending");
      }
      worker = undefined;
    }

    if (worker) {
      const inspection = await safeInspect(worker);
      if (inspection?.state === "running" || inspection?.state === "idle") {
        append({ type: "mission.paused", data: { reason: `supervisor error while worker remains alive: ${message}`, nextAction: "wait-worker" } });
        return resultFor(journal, "pending");
      }
      if (!inspection || inspection.state === "unknown") {
        const effects = durableEffects(journal);
        const stopped = await terminateWorkerBestEffort(worker, options.workerFactory);
        if (!stopped) {
          append({ type: "mission.paused", data: { reason: `supervisor error left an unclassified worker whose cleanup is unconfirmed: ${message}`, nextAction: "wait-worker" } });
          return resultFor(journal, "pending");
        }
        worker = undefined;
        if (lease && !releaseLeaseBestEffort(lease, append)) {
          append({ type: "mission.paused", data: { reason: `worker stopped but lease cleanup is unconfirmed after supervisor error: ${message}`, nextAction: "wait-worker" } });
          return resultFor(journal, "pending");
        }
        lease = undefined;
        if (effects.length) {
          append({ type: "mission.outcome-unknown", data: { reason: `supervisor error with unclassified worker after observed effects: ${message}` } });
          return resultFor(journal, "outcome-unknown");
        }
      }
    }

    const effects = durableEffects(journal);
    if (lease && !releaseLeaseBestEffort(lease, append)) {
      append({ type: "mission.paused", data: { reason: `supervisor error and writer lease cleanup is unconfirmed: ${message}`, nextAction: "wait-worker" } });
      return resultFor(journal, "pending");
    }
    if (effects.length) {
      append({ type: "mission.outcome-unknown", data: { reason: `supervisor error after ${effects.length} observed workspace effect(s): ${message}` } });
      return resultFor(journal, "outcome-unknown");
    }
    append({ type: "mission.failed", data: { reason: `supervisor error: ${message}` } });
    return resultFor(journal, "fail");
  } finally {
    journal.close();
  }
}

export function defaultMissionRunsRoot(): string {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, "Pi", "durable-missions");
  return path.join(process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state"), "pi", "durable-missions");
}

export class MissionRunnerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "MissionRunnerError";
    this.code = code;
  }
}

type Append = (event: Omit<NewMissionEvent, "runId" | "generation"> & { generation?: number }) => MissionEvent;

async function runWorkerTurn(
  worker: MissionWorker,
  prompt: string,
  signal: AbortSignal | undefined,
  append: Append,
  lease: WorkspaceLeaseHandle,
  turn: number,
): Promise<{ kind: "settled" } | { kind: "failed"; message: string }> {
  let terminal: "settled" | "failed" | undefined;
  let failure = "worker stream ended without settlement";
  try {
    for await (const event of worker.prompt(prompt, signal)) {
      appendWorkerEvent(event, append, lease, turn);
      if (event.type === "settled") terminal = "settled";
      if (event.type === "failed") {
        terminal = "failed";
        failure = event.message;
      }
      if (terminal) break;
    }
  } catch (error) {
    terminal = "failed";
    failure = error instanceof Error ? error.message : String(error);
  }
  return terminal === "settled" ? { kind: "settled" } : { kind: "failed", message: failure };
}

function appendWorkerEvent(event: MissionWorkerEvent, append: Append, lease: WorkspaceLeaseHandle, turn: number): void {
  if (event.type === "heartbeat") {
    const renewed = lease.renew();
    append({ type: "worker.heartbeat", at: event.at, data: { turn, at: event.at ?? renewed.renewedAt } });
    append({ type: "lease.renewed", data: { generation: renewed.generation, expiresAt: renewed.expiresAt } });
  } else if (event.type === "cursor") {
    append({ type: "worker.cursor", data: { turn, cursor: event.cursor } });
  } else if (event.type === "tool") {
    append({ type: "worker.event", data: { turn, ...event } });
  } else if (event.type === "settled") {
    append({ type: "worker.settled", data: { turn, cursor: event.cursor, tokens: event.tokens } });
  } else {
    if (event.cursor) append({ type: "worker.cursor", data: { turn, cursor: event.cursor } });
  }
}

function reconcileWorkspace(
  journal: FileMissionJournal,
  append: Append,
  baseline: WorkspaceSnapshotRecord,
  cwd: string,
  label: string,
): { snapshot: WorkspaceSnapshotRecord; effects: WorkspaceEffect[] } {
  const snapshot = captureAndPersistSnapshot(journal.runDirectory, cwd, label);
  const effects = diffWorkspaceSnapshots(baseline, snapshot);
  append({ type: "workspace.snapshot", data: { role: "latest", label, digest: snapshot.digest, file: snapshotFile(journal.runDirectory, label, snapshot.digest) } });
  if (effects.length) append({ type: "effects.observed", data: { label, effects } });
  return { snapshot, effects };
}

function captureAndPersistSnapshot(runDirectory: string, cwd: string, label: string): WorkspaceSnapshotRecord {
  const snapshot = captureWorkspaceSnapshot(cwd);
  writeWorkspaceSnapshot(runDirectory, label, snapshot);
  return snapshot;
}

function loadBaselineSnapshot(runDirectory: string, projection: MissionProjection): WorkspaceSnapshotRecord {
  if (!projection.baselineSnapshotDigest) throw new MissionRunnerError("MISSION_BASELINE_MISSING", projection.runId);
  return readWorkspaceSnapshot(snapshotFile(runDirectory, "baseline", projection.baselineSnapshotDigest));
}

function snapshotFile(runDirectory: string, label: string, digest: string): string {
  return path.join(runDirectory, "snapshots", `${label}-${digest}.json`);
}

function initialPrompt(compiled: CompiledMission): string {
  return [
    "DURABLE MISSION",
    `Mission hash: ${compiled.missionHash}`,
    `Objective:\n${compiled.contract.objective}`,
    compiled.contract.constraints.length ? `Constraints:\n${compiled.contract.constraints.map((item) => `- ${item}`).join("\n")}` : "Constraints: none beyond project policy.",
    compiled.contract.validator.kind === "node-workspace-validator"
      ? "A host-owned pinned validate.cjs check runs after you settle. Build, test, and fix the objective autonomously. Do not merely describe work."
      : "This is a read-only mission. Do not mutate the workspace.",
    "You own implementation strategy. Do not invoke another orchestration workflow. Return a concise plain-language summary when your current work is ready for host validation.",
  ].join("\n\n");
}

function recoveryPrompt(compiled: CompiledMission, projection: MissionProjection): string {
  return [
    "RESUME DURABLE MISSION",
    `Mission hash remains ${compiled.missionHash}.`,
    `Objective:\n${compiled.contract.objective}`,
    `The prior supervisor/worker generation ended before the mission reached a terminal state. Durable cursor: ${projection.cursor ?? "none"}.`,
    `Observed effects so far: ${projection.effects.length ? projection.effects.map((effect) => `${effect.kind}:${effect.path}`).join(", ") : "none"}.`,
    "Inspect the current workspace and session history. Preserve correct existing work, do not repeat mutations blindly, run relevant checks, and continue the same objective until ready for host validation.",
  ].join("\n\n");
}

function repairPrompt(
  compiled: CompiledMission,
  validator: Awaited<ReturnType<typeof runPinnedNodeValidator>>,
  effects: WorkspaceEffect[],
  turn: number,
): string {
  return [
    `HOST VALIDATOR FAILED AFTER TURN ${turn}`,
    `Mission hash: ${compiled.missionHash}`,
    `Status: ${validator.status}; exitCode=${String(validator.exitCode)}; timedOut=${validator.timedOut}; durationMs=${validator.durationMs}`,
    `Observed workspace effects: ${effects.length ? effects.map((effect) => `${effect.kind}:${effect.path}`).join(", ") : "none"}`,
    `stdout:\n${validator.stdout || "(empty)"}`,
    `stderr:\n${validator.stderr || "(empty)"}`,
    "Diagnose the actual failure, repair the product or an obsolete validator as appropriate, run relevant checks yourself, and settle again. Keep the mission unchanged.",
  ].join("\n\n");
}

function exhaustedBudget(compiled: CompiledMission, projection: MissionProjection): string | undefined {
  if (projection.usage.turns >= compiled.contract.budgets.maxTurns) return "turn budget exhausted";
  if (projection.usage.tokens >= compiled.contract.budgets.maxTokens) return "token budget exhausted";
  const wallElapsed = Date.now() - Date.parse(projection.usage.startedAt);
  if (wallElapsed >= compiled.contract.budgets.wallClockMs) return "wall-clock budget exhausted";
  return undefined;
}

function assertPinnedMission(events: MissionEvent[], compiled: CompiledMission, adapterName: string): void {
  const created = events.find((event) => event.type === "mission.created");
  if (!created || created.data.missionHash !== compiled.missionHash || created.data.canonicalJson !== compiled.canonicalJson
    || created.data.cwd !== compiled.contract.cwd || created.data.workerAdapter !== adapterName) {
    throw new MissionRunnerError("MISSION_RESUME_IDENTITY_MISMATCH", compiled.missionHash);
  }
}

function assertWorkerIdentity(
  worker: MissionWorker,
  adapterName: string,
  generation: number,
  cwd: string,
  allowedRoutes: CompiledMission["contract"]["fallbacks"],
): MissionWorkerIdentity {
  const identity = worker.identity as MissionWorkerIdentity & Record<string, unknown>;
  const identityKeys = new Set(["adapter", "workerId", "pid", "processStartedAt", "sessionId", "sessionFile", "cursor", "generation", "route"]);
  if (!identity || typeof identity !== "object" || Object.keys(identity).some((key) => !identityKeys.has(key))
    || identity.generation !== generation || !boundedIdentityText(identity.workerId) || identity.adapter !== adapterName
    || !boundedIdentityText(identity.sessionId) || !boundedIdentityText(identity.sessionFile)
    || !(identity.pid === null || (Number.isSafeInteger(identity.pid) && identity.pid > 0))
    || !(identity.cursor === null || boundedIdentityText(identity.cursor))
    || (identity.processStartedAt !== undefined && Number.isNaN(Date.parse(identity.processStartedAt)))) {
    throw new MissionRunnerError("MISSION_WORKER_IDENTITY_INVALID", "worker returned malformed or unknown identity fields");
  }
  const route = identity.route as (MissionWorkerIdentity["route"] & Record<string, unknown>) | undefined;
  if (!route || Object.keys(route).some((key) => !new Set(["provider", "model", "thinkingLevel"]).has(key))
    || !allowedRoutes.some((candidate) => candidate.provider === route.provider
      && candidate.model === route.model && candidate.thinkingLevel === route.thinkingLevel)) {
    throw new MissionRunnerError("MISSION_WORKER_ROUTE_INVALID", "worker returned an unpinned or malformed route");
  }
  if (!path.isAbsolute(identity.sessionFile)) throw new MissionRunnerError("MISSION_WORKER_SESSION_PATH_INVALID", "worker session path is not absolute");
  if (realpathSync(cwd) !== cwd) throw new MissionRunnerError("MISSION_WORKSPACE_NOT_CANONICAL", "mission workspace is not canonical");
  return {
    adapter: identity.adapter,
    workerId: identity.workerId,
    pid: identity.pid,
    ...(identity.processStartedAt ? { processStartedAt: identity.processStartedAt } : {}),
    sessionId: identity.sessionId,
    sessionFile: identity.sessionFile,
    cursor: identity.cursor,
    generation: identity.generation,
    route: { provider: route.provider, model: route.model, thinkingLevel: route.thinkingLevel },
  };
}

function publicWorkerInspection(inspection: MissionWorkerInspection, identity: MissionWorkerIdentity): MissionWorkerInspection {
  const state = inspection.state === "running" || inspection.state === "idle" || inspection.state === "exited" || inspection.state === "unknown"
    ? inspection.state : "unknown";
  return {
    state,
    identity,
    ...(inspection.exitCode === null || Number.isSafeInteger(inspection.exitCode) ? { exitCode: inspection.exitCode } : {}),
    ...(typeof inspection.error === "string" && inspection.error ? { error: "worker inspection reported an error" } : {}),
  };
}

function boundedIdentityText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768 && !value.includes("\0");
}

function releaseLease(lease: WorkspaceLeaseHandle, append: Append): void {
  const released = lease.release();
  append({ type: "lease.released", data: { generation: released.generation, releasedAt: released.releasedAt } });
}

async function cancelWorker(worker: MissionWorker, factory: MissionWorkerFactory): Promise<void> {
  try { await worker.abort(); } catch {}
  try { await worker.close(); } catch {}
  let inspection = await factory.inspect(worker.identity);
  if (inspection.state === "exited") return;
  const terminated = await factory.terminate(worker.identity);
  inspection = await factory.inspect(worker.identity);
  if (!terminated || inspection.state !== "exited") {
    throw new MissionRunnerError("MISSION_WORKER_CANCELLATION_UNCONFIRMED", `worker state is ${inspection.state}`);
  }
}

function cancellationCleanupReason(error: unknown): string {
  return `cancellation requested but worker cleanup is unconfirmed: ${error instanceof Error ? error.message : String(error)}`;
}

async function terminateWorkerBestEffort(worker: MissionWorker, factory: MissionWorkerFactory): Promise<boolean> {
  try {
    await cancelWorker(worker, factory);
    return true;
  } catch {
    return false;
  }
}

function releaseLeaseBestEffort(lease: WorkspaceLeaseHandle, append: Append): boolean {
  try {
    releaseLease(lease, append);
    return true;
  } catch {
    return false;
  }
}

function releaseLeaseWithoutEventBestEffort(lease: WorkspaceLeaseHandle): void {
  try { lease.release(); } catch {}
}

function durableEffects(journal: FileMissionJournal): WorkspaceEffect[] {
  try { return journal.projection().effects; } catch { return []; }
}

async function closeWorkerBestEffort(worker: MissionWorker, factory: MissionWorkerFactory): Promise<void> {
  try {
    await worker.close();
  } catch {
    const terminated = await factory.terminate(worker.identity);
    if (!terminated) throw new MissionRunnerError("MISSION_WORKER_CLEANUP_FAILED", "worker cleanup could not be confirmed");
  }
}

async function safeInspect(worker: MissionWorker): Promise<Awaited<ReturnType<MissionWorker["inspect"]>> | undefined> {
  try { return await worker.inspect(); } catch { return undefined; }
}

function publicLease(record: ReturnType<FileWorkspaceLease["renew"]>): Record<string, unknown> {
  return {
    generation: record.generation,
    ownerPid: record.ownerPid,
    workerPid: record.workerPid,
    acquiredAt: record.acquiredAt,
    expiresAt: record.expiresAt,
  };
}

function resultFor(journal: FileMissionJournal, status: DurableMissionResult["status"]): DurableMissionResult {
  return { runId: journal.runId, status, runDirectory: journal.runDirectory, eventFile: journal.eventFile, projection: journal.projection() };
}

function assertRunsRootOutsideWorkspace(cwd: string, runsRoot: string): void {
  const workspace = realpathSync(cwd);
  const runtime = prospectiveRealPath(runsRoot);
  const relative = path.relative(workspace, runtime);
  if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new MissionRunnerError("MISSION_RUNTIME_INSIDE_WORKSPACE", runsRoot);
  }
}

function prospectiveRealPath(target: string): string {
  const missing: string[] = [];
  let current = path.resolve(target);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new MissionRunnerError("MISSION_RUNTIME_PATH_INVALID", target);
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(realpathSync(current), ...missing);
}

function isCompiledMission(value: unknown): value is CompiledMission {
  return Boolean(value) && typeof value === "object" && typeof (value as CompiledMission).missionHash === "string"
    && typeof (value as CompiledMission).canonicalJson === "string" && Boolean((value as CompiledMission).contract);
}
