import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { validateWorkflowInput } from "./compiler";
import { projectRun } from "./event-store";
import { OutputSchemaRegistry, createBuiltinSchemaRegistry } from "./schemas";
import type {
  CompiledPhase,
  CompiledWorkflow,
  EffectRecord,
  EffectStatus,
  FailureCategory,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  KernelOptions,
  KernelResult,
  NewRunEvent,
  PhaseOutcome,
  ProcessStatus,
  ProjectedPhaseState,
  ProtocolStatus,
  RunEvent,
  SemanticStatus,
  WorkerAdapter,
  WorkerCapabilities,
  WorkerEvent,
  WorkerInspection,
  WorkspaceBinding,
  WorkspaceManager,
} from "./types";

export interface RunKernelOptions {
  schemas?: OutputSchemaRegistry;
}

export class KernelInvariantError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "KernelInvariantError";
    this.code = code;
  }
}

/** One host-owned scheduler and phase lifecycle for every v2 workflow. */
export class RunKernel {
  readonly #schemas: OutputSchemaRegistry;

  constructor(options: RunKernelOptions = {}) {
    this.#schemas = options.schemas ?? createBuiltinSchemaRegistry();
  }

  async run(compiled: CompiledWorkflow, options: KernelOptions): Promise<KernelResult> {
    if (options.eventStore.runId !== options.runId) throw new KernelInvariantError("RUN_ID_MISMATCH", "event store and kernel run ids differ");
    const existingEvents = options.eventStore.readAll();
    const resuming = existingEvents.length > 0;
    const workspaceRoot = canonicalDirectory(options.workspaceRoot);
    const input = validateWorkflowInput(compiled.ir, options.input);
    const outcomes: Record<string, PhaseOutcome> = {};
    const outputs: Record<string, JsonValue> = {};
    const attemptOffsets = new Map<string, number>();
    let attemptsUsed = existingEvents.filter((event) => event.type === "phase.attempt.started").length;
    let resumePending = false;

    const capabilities = new Map<WorkerAdapter, WorkerCapabilities>();
    const capabilityFor = async (adapter: WorkerAdapter): Promise<WorkerCapabilities> => {
      const existing = capabilities.get(adapter);
      if (existing) return existing;
      const discovered = await adapter.capabilities();
      capabilities.set(adapter, discovered);
      return discovered;
    };
    const adapterFor = (phase: CompiledPhase): WorkerAdapter | undefined => phase.kind === "deterministic-command"
      ? options.commandAdapter
      : phase.kind === "agent"
        ? options.agentAdapter
        : undefined;

    const append = (event: Omit<NewRunEvent, "runId">): ReturnType<KernelOptions["eventStore"]["append"]> => {
      const stored = options.eventStore.append({ ...event, runId: options.runId });
      options.onEvent?.(stored);
      return stored;
    };

    let terminalFailure = false;
    if (!resuming) {
      append({ type: "run.created", data: { workflow: compiled.ir.name, workspaceRoot, input, runtimePolicy: cloneJson(options.runtimePolicy ?? {}) } });
      append({
        type: "workflow.compiled",
        data: {
          workflowHash: compiled.hash,
          schemaVersion: compiled.ir.schemaVersion,
          canonicalJson: compiled.canonicalJson,
          schedule: compiled.schedule,
        },
      });
    } else {
      const created = existingEvents.find((event) => event.type === "run.created");
      if (!created) throw new KernelInvariantError("RESUME_EVENT_MISSING", "run.created event is missing");
      if (created.data.workspaceRoot !== workspaceRoot) {
        throw new KernelInvariantError("RESUME_WORKSPACE_MISMATCH", `stored workspace ${String(created.data.workspaceRoot)} does not match ${workspaceRoot}`);
      }
      if (JSON.stringify(created.data.input) !== JSON.stringify(input)) {
        throw new KernelInvariantError("RESUME_INPUT_MISMATCH", "resume inputs differ from the pinned run.created input");
      }
      const storedRuntimePolicy = created.data.runtimePolicy ?? {};
      if (JSON.stringify(storedRuntimePolicy) !== JSON.stringify(options.runtimePolicy ?? {})) {
        throw new KernelInvariantError("RESUME_RUNTIME_POLICY_MISMATCH", "resume worker profiles, model inheritance, or local-model policy differ from the pinned run");
      }
      const projection = projectRun(existingEvents);
      if (projection.workflowHash !== compiled.hash) {
        throw new KernelInvariantError("RESUME_WORKFLOW_MISMATCH", `stored workflow hash ${String(projection.workflowHash)} does not match ${compiled.hash}`);
      }
      if (projection.status === "succeeded" || projection.status === "failed" || projection.status === "cancelled") {
        throw new KernelInvariantError("RUN_ALREADY_TERMINAL", `run ${options.runId} is already ${projection.status}`);
      }
      for (const phase of compiled.ir.phases) {
        const state = projection.phases[phase.id];
        const offset = existingEvents
          .filter((event) => event.phaseId === phase.id && event.type === "phase.attempt.started")
          .reduce((max, event) => Math.max(max, event.attempt ?? 0), 0);
        attemptOffsets.set(phase.id, offset);
        if (!state) continue;
        if (state.status === "succeeded") {
          const restored = restoreSucceededOutcome(phase, state, existingEvents);
          assertRestoredOutputValid(this.#schemas, phase, restored.output);
          outcomes[phase.id] = restored;
          if (restored.output !== undefined) outputs[phase.id] = restored.output;
        } else if ((state.status === "running" || state.status === "waiting") && state.output !== undefined) {
          const validatedEvent = [...existingEvents].reverse().find((event) => event.phaseId === phase.id && event.type === "worker.result.validated");
          if (!validatedEvent || JSON.stringify(validatedEvent.data.output) !== JSON.stringify(state.output)) {
            throw new KernelInvariantError("RESUME_RESULT_PROVENANCE_MISSING", `phase ${phase.id} has projected output without matching worker.result.validated event`);
          }
          assertRestoredOutputValid(this.#schemas, phase, state.output);
          const processExitCode = recoveredProcessExitCode(phase, validatedEvent, existingEvents);
          const recovered = recoveredValidatedOutcome(phase, state, validatedEvent, processExitCode);
          outcomes[phase.id] = recovered;
          if (recovered.output !== undefined) outputs[phase.id] = recovered.output;
          if (recovered.status === "succeeded") {
            append({
              type: "phase.succeeded",
              phaseId: phase.id,
              attempt: recovered.attempt,
              data: { output: recovered.output, process: recovered.process, protocol: recovered.protocol, semantic: recovered.semantic, effectStatus: recovered.effects.status, ...(recovered.workspace ? { workspace: recovered.workspace } : {}), recoveredValidatedResult: true },
            });
          } else {
            if (recovered.category === "semantic-failure") {
              append({ type: "phase.semantic.failed", phaseId: phase.id, attempt: recovered.attempt, data: { category: recovered.category, output: recovered.output, recoveredValidatedResult: true } });
            }
            append({ type: "phase.failed", phaseId: phase.id, attempt: recovered.attempt, data: { category: recovered.category, message: recovered.error, output: recovered.output, process: recovered.process, protocol: recovered.protocol } });
            terminalFailure = true;
          }
        } else if (state.status === "failed" || state.status === "outcome-unknown" || state.status === "cancelled") {
          outcomes[phase.id] = restoreTerminalOutcome(phase, state, existingEvents);
          terminalFailure = true;
        } else if (state.status === "running" || state.status === "waiting" || state.status === "retrying") {
          const attempt = Math.max(1, offset);
          const workerRunId = lastWorkerRunId(existingEvents, phase.id, attempt);
          const adapter = adapterFor(phase);
          const inspection = adapter && workerRunId
            ? await safeInspect(adapter, workerRunId)
            : unknownInspection(workerRunId ?? `${options.runId}:${phase.id}:${attempt}`);
          append({
            type: "worker.inspected",
            phaseId: phase.id,
            attempt,
            data: {
              workerRunId: inspection.workerRunId,
              state: inspection.state,
              effectStatus: inspection.effects.status,
              ...(inspection.publication ? { publication: inspection.publication } : {}),
              ...(inspection.error ? { error: inspection.error } : {}),
            },
          });
          for (const effect of inspection.effects.mutations) {
            append({ type: "effect.observed", phaseId: phase.id, attempt, data: { effect, recoveredByInspection: true } });
          }
          state.effects = mergeEffects(state.effects, inspection.effects);
          if (inspection.state === "completed" && inspection.output !== undefined) {
            const attemptEvents = existingEvents.filter((event) => event.phaseId === phase.id && event.attempt === attempt);
            const candidateProvenance = attemptEvents.some((event) => event.type === "worker.candidate.preserved"
              || (event.type === "worker.transport.failed" && event.data.category === "candidate-result-preserved"));
            const detachedProvenance = attemptEvents.some((event) => event.type === "worker.detached"
              && publicationIdentityMatches(event.data.publication, inspection.publication));
            if (candidateProvenance || (inspection.publication && !detachedProvenance)) {
              const message = candidateProvenance
                ? "durable publication belongs to an ambiguous candidate and cannot be promoted"
                : "durable result has no matching worker.detached event provenance";
              append({ type: "worker.transport.failed", phaseId: phase.id, attempt, data: { category: "candidate-result-preserved", message, recoveredByInspection: true } });
              if (phase.access === "workspace-write" && phase.workspace.mode === "shared") {
                const outcome = terminalOutcome(phase, attempt, "outcome-unknown", message, state.effects, state.workspace, true);
                outcomes[phase.id] = outcome;
                append({ type: "phase.outcome.unknown", phaseId: phase.id, attempt, data: { category: "outcome-unknown", cause: "candidate-result-preserved", message, effectStatus: outcome.effects.status } });
                terminalFailure = true;
              } else if (state.workspace?.mode === "isolated") {
                await options.workspaceManager?.preserve(state.workspace, message);
              }
              continue;
            }
            const publishedValidation = this.#schemas.validate(phase.outputSchema, inspection.output);
            if (!publishedValidation.ok) {
              const message = `published result failed ${phase.outputSchema}: ${publishedValidation.error ?? "invalid output"}`;
              append({ type: "worker.transport.failed", phaseId: phase.id, attempt, data: { category: "protocol-failure", message, recoveredByInspection: true } });
              if (phase.access === "workspace-write" && phase.workspace.mode === "shared") {
                const outcome = terminalOutcome(phase, attempt, "outcome-unknown", message, state.effects, state.workspace, true);
                outcomes[phase.id] = outcome;
                append({ type: "phase.outcome.unknown", phaseId: phase.id, attempt, data: { category: "outcome-unknown", cause: "protocol-failure", message, effectStatus: outcome.effects.status } });
                terminalFailure = true;
              } else {
                if (state.workspace?.mode === "isolated") await options.workspaceManager?.preserve(state.workspace, message);
                // Untrusted publication is not promoted. The next bounded
                // read-only/disposable attempt may safely replace it.
              }
              continue;
            }
            if (!Number.isInteger(inspection.exitCode)) {
              const message = `published phase ${phase.id} has no durable integer process exit code`;
              append({ type: "worker.transport.failed", phaseId: phase.id, attempt, data: { category: "protocol-failure", message, recoveredByInspection: true } });
              if (phase.access === "workspace-write" && phase.workspace.mode === "shared") {
                const outcome = terminalOutcome(phase, attempt, "outcome-unknown", message, state.effects, state.workspace, true);
                outcomes[phase.id] = outcome;
                append({ type: "phase.outcome.unknown", phaseId: phase.id, attempt, data: { category: "outcome-unknown", cause: "protocol-failure", message, effectStatus: outcome.effects.status } });
                terminalFailure = true;
              } else if (state.workspace?.mode === "isolated") {
                await options.workspaceManager?.preserve(state.workspace, message);
              }
              continue;
            }
            if (phase.access === "read-only" && state.effects.status === "observed") {
              const violation = terminalOutcome(phase, attempt, "authorization-violation", `Read-only phase inspection observed ${state.effects.mutations.length} workspace mutation(s)`, state.effects, state.workspace);
              outcomes[phase.id] = violation;
              append({ type: "phase.failed", phaseId: phase.id, attempt, data: { category: violation.category, message: violation.error, process: violation.process, protocol: violation.protocol, effectStatus: violation.effects.status } });
              terminalFailure = true;
              continue;
            }
            append({ type: "worker.result.published", phaseId: phase.id, attempt, data: { publication: inspection.publication, exitCode: inspection.exitCode } });
            append({ type: "worker.result.received", phaseId: phase.id, attempt, data: { exitCode: inspection.exitCode, recoveredByInspection: true } });
            const validatedEvent = append({ type: "worker.result.validated", phaseId: phase.id, attempt, data: { output: inspection.output, schema: phase.outputSchema, processExitCode: inspection.exitCode, recoveredByInspection: true } });
            const projectedState: ProjectedPhaseState = { ...state, output: inspection.output, workspace: state.workspace };
            const recovered = recoveredValidatedOutcome(phase, projectedState, validatedEvent, inspection.exitCode!);
            outcomes[phase.id] = recovered;
            if (recovered.output !== undefined) outputs[phase.id] = recovered.output;
            if (recovered.status === "succeeded") {
              append({ type: "phase.succeeded", phaseId: phase.id, attempt, data: { output: recovered.output, process: recovered.process, protocol: recovered.protocol, semantic: recovered.semantic, effectStatus: recovered.effects.status, ...(recovered.workspace ? { workspace: recovered.workspace } : {}), recoveredPublishedResult: true } });
            } else {
              if (recovered.category === "semantic-failure") append({ type: "phase.semantic.failed", phaseId: phase.id, attempt, data: { category: recovered.category, output: recovered.output, recoveredPublishedResult: true } });
              append({ type: "phase.failed", phaseId: phase.id, attempt, data: { category: recovered.category, message: recovered.error, output: recovered.output, process: recovered.process, protocol: recovered.protocol } });
              terminalFailure = true;
            }
          } else if (inspection.state === "running") {
            const waiting = pendingOutcome(phase, attempt, "result-file-pending", `Worker ${inspection.workerRunId} is still running; resume after durable result publication`, state.effects, state.workspace);
            outcomes[phase.id] = waiting;
            append({ type: "phase.waiting", phaseId: phase.id, attempt, data: { category: waiting.category, message: waiting.error, workerRunId: inspection.workerRunId, ...(inspection.publication ? { publication: inspection.publication } : {}) } });
            resumePending = true;
          } else if (phase.access === "workspace-write" && phase.workspace.mode === "shared") {
            const outcome = terminalOutcome(phase, attempt, "outcome-unknown", "Interrupted shared writer cannot be replayed safely", state.effects, state.workspace, true);
            outcomes[phase.id] = outcome;
            append({ type: "phase.outcome.unknown", phaseId: phase.id, attempt, data: { category: "outcome-unknown", message: outcome.error, effectStatus: outcome.effects.status } });
            terminalFailure = true;
          } else {
            if (state.workspace?.mode === "isolated") await options.workspaceManager?.preserve(state.workspace, "interrupted attempt replaced by safe isolated replay");
            // Read-only and disposable isolated attempts are safe to replay from
            // the next bounded attempt. Leave the phase absent from outcomes.
          }
        }
      }
      append({ type: "run.resumed", data: { workflowHash: compiled.hash, restoredPhases: Object.keys(outcomes).sort(), attemptsUsed } });
    }

    if (resumePending && !terminalFailure) {
      append({ type: "run.paused", data: { reason: "survivor-result-pending", attemptsUsed } });
      return {
        runId: options.runId,
        status: "pending",
        workflowHash: compiled.hash,
        phaseOutcomes: sortRecord(outcomes),
        projection: projectRun(options.eventStore.readAll()),
      };
    }

    let cancelled = false;
    let runPending = false;
    for (const wave of compiled.schedule.waves) {
      if (options.signal?.aborted) {
        cancelled = true;
        break;
      }
      if (terminalFailure) break;
      const pendingWave = wave
        .map((scheduled) => compiled.ir.phases.find((phase) => phase.id === scheduled.id)!)
        .filter((phase) => outcomes[phase.id]?.status !== "succeeded");
      if (!pendingWave.length) continue;
      for (const phase of pendingWave) append({ type: "phase.ready", phaseId: phase.id, data: { resumed: resuming } });
      const results = await boundedMap(
        pendingWave,
        compiled.ir.limits.maxConcurrency,
        async (phase) => {
          const result = await this.#executePhase({
            compiled,
            phase,
            input,
            outputs,
            workspaceRoot,
            outcomes,
            options,
            append,
            capabilityFor,
            attemptOffset: attemptOffsets.get(phase.id) ?? 0,
            reserveAttempt: () => {
              attemptsUsed += 1;
              if (attemptsUsed > compiled.ir.limits.maxTotalAttempts) throw new KernelInvariantError("ATTEMPT_BUDGET_EXHAUSTED", "runtime exceeded compiled attempt budget");
            },
          });
          outcomes[phase.id] = result;
          if (result.output !== undefined) outputs[phase.id] = result.output;
          return result;
        },
      );
      if (results.some((result) => result.status === "cancelled")) cancelled = true;
      if (results.some((result) => result.status === "pending")) runPending = true;
      if (results.some((result) => result.status !== "succeeded" && result.status !== "pending")) terminalFailure = true;
      if (runPending) break;
    }

    let status: KernelResult["status"];
    if (runPending) {
      status = "pending";
      append({ type: "run.paused", data: { reason: "survivor-result-pending", attemptsUsed } });
    } else if (cancelled || options.signal?.aborted) {
      status = "cancelled";
      append({ type: "run.cancelled", data: { attemptsUsed } });
    } else {
      const terminal = outcomes[compiled.ir.completion.terminalPhase];
      const complete = Object.keys(outcomes).length === compiled.ir.phases.length;
      const terminalPass = terminal?.status === "succeeded"
        && (compiled.ir.completion.require !== "pass" || terminal.semantic.status === "pass");
      status = complete && terminalPass && !terminalFailure ? "pass" : "fail";
      append({
        type: status === "pass" ? "run.completed" : "run.failed",
        data: {
          status,
          attemptsUsed,
          terminalPhase: compiled.ir.completion.terminalPhase,
          terminalStatus: terminal?.status ?? "not-run",
        },
      });
    }

    return {
      runId: options.runId,
      status,
      workflowHash: compiled.hash,
      phaseOutcomes: sortRecord(outcomes),
      projection: projectRun(options.eventStore.readAll()),
    };
  }

  async #executePhase(context: {
    compiled: CompiledWorkflow;
    phase: CompiledPhase;
    input: Record<string, JsonPrimitive>;
    outputs: Record<string, JsonValue>;
    outcomes: Record<string, PhaseOutcome>;
    workspaceRoot: string;
    options: KernelOptions;
    append: (event: Omit<NewRunEvent, "runId">) => unknown;
    capabilityFor: (adapter: WorkerAdapter) => Promise<WorkerCapabilities>;
    attemptOffset: number;
    reserveAttempt: () => void;
  }): Promise<PhaseOutcome> {
    const { phase, append } = context;
    if (phase.kind === "join") return this.#executeJoin(context);
    if (phase.kind === "integrate") return await this.#executeIntegration(context);
    const adapter = phase.kind === "deterministic-command" ? context.options.commandAdapter : context.options.agentAdapter;
    if (!adapter) return this.#terminalFailure(context, context.attemptOffset + 1, "capability-mismatch", "No adapter configured for deterministic-command phases");
    const capabilities = await context.capabilityFor(adapter);
    if (!capabilities.phaseKinds.includes(phase.kind) || !capabilities.accessModes.includes(phase.access) || !capabilities.structuredOutput) {
      return this.#terminalFailure(context, context.attemptOffset + 1, "capability-mismatch", `Adapter ${capabilities.adapter} cannot honor ${phase.kind}/${phase.access}/structured-output`);
    }

    if (context.attemptOffset >= phase.retry.maxAttempts) {
      return this.#terminalFailure(context, context.attemptOffset, "budget-exhausted", `phase ${phase.id} has no remaining attempts after resume`);
    }
    for (let attempt = context.attemptOffset + 1; attempt <= phase.retry.maxAttempts; attempt++) {
      context.reserveAttempt();
      if (context.options.signal?.aborted) return this.#cancelled(context, attempt, "run signal aborted before phase start");
      const workerRunId = `${context.options.runId}:${phase.id}:${attempt}`;
      let workspace: WorkspaceBinding;
      try {
        workspace = await prepareWorkspace(context.options.workspaceManager, context.options.runId, phase, attempt, context.workspaceRoot);
      } catch (error) {
        return this.#terminalFailure(context, attempt, "internal-error", `workspace preparation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      append({ type: "workspace.prepared", phaseId: phase.id, attempt, data: { binding: workspace } });
      const resolvedInput = resolvePhaseInput(phase.input, context.input, context.outputs, workspace.root);
      append({ type: "phase.attempt.started", phaseId: phase.id, attempt, data: { workerRunId, adapter: capabilities.adapter, workspace } });

      const process: ProcessStatus = { started: false, exitCode: null };
      const protocol: ProtocolStatus = { status: "missing", schema: phase.outputSchema };
      const effects: EffectStatus = { status: "none", mutations: [] };
      let semantic: SemanticStatus = { status: "not-applicable" };
      let output: JsonValue | undefined;
      let failure: { category: FailureCategory; message: string } | undefined;
      let sawTerminal = false;
      let timedOut = false;
      const controller = linkedAbortController(context.options.signal);
      const timer = setTimeout(() => {
        if (context.options.signal?.aborted) return;
        timedOut = true;
        controller.abort(new Error(`phase timeout after ${phase.timeoutMs}ms`));
      }, phase.timeoutMs);

      try {
        const stream = adapter.start({
          runId: context.options.runId,
          workerRunId,
          phase,
          attempt,
          input: resolvedInput,
          workspaceRoot: workspace.root,
          signal: controller.signal,
        });
        for await (const event of stream) {
          append({ type: "worker.event.received", phaseId: phase.id, attempt, data: { eventType: event.type } });
          if (event.type === "started") {
            process.started = true;
            append({ type: "worker.started", phaseId: phase.id, attempt, data: { workerRunId: event.workerRunId } });
          } else if (event.type === "effect") {
            if (phase.access === "read-only") {
              failure = { category: "authorization-violation", message: `Read-only phase observed ${event.effect.kind} effect at ${event.effect.path}` };
              sawTerminal = true;
              break;
            }
            addEffect(effects, event.effect);
            append({ type: "effect.observed", phaseId: phase.id, attempt, data: { effect: event.effect } });
          } else if (event.type === "failed") {
            process.exitCode = event.exitCode ?? null;
            const category = event.category === "detached-survivor" || event.category === "candidate-result-preserved"
              ? event.category
              : context.options.signal?.aborted
                ? "cancelled"
                : timedOut && event.category === "cancelled"
                  ? "budget-exhausted"
                  : event.category;
            failure = { category, message: timedOut && category !== "cancelled" ? `phase timeout after ${phase.timeoutMs}ms` : event.message };
            sawTerminal = true;
            append({ type: "worker.transport.failed", phaseId: phase.id, attempt, data: { category, message: failure.message, ...(event.publication ? { publication: event.publication } : {}), ...(event.candidate === undefined ? {} : { candidate: event.candidate }) } });
            if (event.publication) {
              append({ type: category === "detached-survivor" ? "worker.detached" : category === "candidate-result-preserved" ? "worker.candidate.preserved" : "worker.result.published", phaseId: phase.id, attempt, data: { publication: event.publication, ...(event.candidate === undefined ? {} : { candidate: event.candidate }) } });
            }
            break;
          } else if (event.type === "result") {
            process.started = true;
            process.exitCode = event.exitCode;
            if (event.signal) process.signal = event.signal;
            output = event.output;
            protocol.status = "valid";
            append({ type: "worker.result.received", phaseId: phase.id, attempt, data: { exitCode: event.exitCode } });
            const validation = this.#schemas.validate(phase.outputSchema, event.output);
            if (!validation.ok) {
              protocol.status = "invalid";
              protocol.error = validation.error;
              failure = { category: "protocol-failure", message: validation.error ?? "structured output validation failed" };
            } else {
              append({ type: "worker.result.validated", phaseId: phase.id, attempt, data: { output: event.output, schema: phase.outputSchema, processExitCode: event.exitCode, ...(event.signal ? { processSignal: event.signal } : {}) } });
              if (phase.resultMode === "gate") {
                const gate = event.output as { status: "pass" | "fail"; summary?: string };
                semantic = { status: gate.status, ...(gate.summary ? { summary: gate.summary } : {}) };
                if (gate.status === "fail") failure = { category: "semantic-failure", message: gate.summary ?? "gate returned fail" };
              }
              if (event.exitCode !== 0 && !failure) {
                failure = {
                  category: phase.kind === "deterministic-command" ? "deterministic-check-failure" : "protocol-failure",
                  message: `worker exited ${event.exitCode} after returning a result`,
                };
              }
            }
            sawTerminal = true;
            break;
          }
        }
      } catch (error) {
        failure = {
          category: timedOut
            ? "budget-exhausted"
            : controller.signal.aborted && context.options.signal?.aborted
              ? "cancelled"
              : "protocol-failure",
          message: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearTimeout(timer);
      }

      if (!sawTerminal && !failure) failure = { category: "protocol-failure", message: "worker stream ended without a terminal result" };
      const inspection = await safeInspect(adapter, workerRunId);
      if (effects.status === "none" && inspection.effects.status === "observed") {
        for (const effect of inspection.effects.mutations) {
          addEffect(effects, effect);
          append({ type: "effect.observed", phaseId: phase.id, attempt, data: { effect, recoveredByInspection: true } });
        }
      } else if (effects.status === "none" && inspection.effects.status === "unsupported") {
        effects.status = "unsupported";
      }
      if (phase.access === "read-only" && effects.status === "observed") {
        failure = {
          category: "authorization-violation",
          message: `Read-only phase inspection observed ${effects.mutations.length} workspace mutation(s)`,
        };
      }

      if (!failure && output !== undefined) {
        append({
          type: "phase.succeeded",
          phaseId: phase.id,
          attempt,
          data: { output, process, protocol, semantic, effectStatus: effects.status, workspace },
        });
        return { phaseId: phase.id, attempt, status: "succeeded", process, protocol, semantic, effects, workspace, output };
      }

      const category = failure?.category ?? "internal-error";
      const message = failure?.message ?? "phase failed without a classified error";
      if (category === "cancelled") return this.#cancelled(context, attempt, message, { process, protocol, semantic, effects, workspace, output });
      if (category === "detached-survivor" || category === "result-file-pending") {
        const pending = pendingOutcome(phase, attempt, "result-file-pending", message, effects, workspace);
        append({ type: "phase.waiting", phaseId: phase.id, attempt, data: { category: pending.category, message, workerRunId } });
        return pending;
      }

      const mutationUnknown = phase.access === "workspace-write"
        && phase.workspace.mode === "shared"
        && (
          effects.status === "observed"
          || (effects.status === "unsupported" && (process.started || inspection.state === "running"))
        )
        && isAcknowledgementFailure(category);
      if (mutationUnknown) {
        append({ type: "phase.outcome.unknown", phaseId: phase.id, attempt, data: { category: "outcome-unknown", cause: category, message, process, protocol, effectStatus: effects.status } });
        return {
          phaseId: phase.id,
          attempt,
          status: "outcome-unknown",
          category: "outcome-unknown",
          process,
          protocol,
          semantic,
          effects,
          workspace,
          ...(output === undefined ? {} : { output }),
          error: `${category}: ${message}`,
        };
      }

      if (category === "candidate-result-preserved" && workspace.mode === "isolated") {
        await context.options.workspaceManager?.preserve(workspace, `${category}: ${message}`);
        append({ type: "workspace.preserved", phaseId: phase.id, attempt, data: { binding: workspace, reason: message, disposition: "candidate-result-preserved" } });
      }

      const canRetry = attempt < phase.retry.maxAttempts
        && phase.retry.on.includes(category)
        && retryIsMutationSafe(phase, effects);
      if (canRetry) {
        if (workspace.mode === "isolated") {
          await context.options.workspaceManager?.preserve(workspace, `${category}: ${message}`);
          append({ type: "workspace.preserved", phaseId: phase.id, attempt, data: { binding: workspace, reason: message, disposition: "replaced-by-retry" } });
        }
        append({ type: "phase.retry.scheduled", phaseId: phase.id, attempt, data: { category, nextAttempt: attempt + 1, mutationSafe: true } });
        continue;
      }

      if (category === "semantic-failure") append({ type: "phase.semantic.failed", phaseId: phase.id, attempt, data: { category, message, output } });
      append({ type: "phase.failed", phaseId: phase.id, attempt, data: { category, message, process, protocol, semantic, effectStatus: effects.status, ...(output === undefined ? {} : { output }) } });
      return {
        phaseId: phase.id,
        attempt,
        status: "failed",
        category,
        process,
        protocol,
        semantic,
        effects,
        workspace,
        ...(output === undefined ? {} : { output }),
        error: message,
      };
    }
    throw new KernelInvariantError("UNREACHABLE_RETRY_STATE", `phase ${phase.id} exhausted loop without returning`);
  }

  async #executeIntegration(context: {
    phase: CompiledPhase;
    outcomes: Record<string, PhaseOutcome>;
    workspaceRoot: string;
    options: KernelOptions;
    append: (event: Omit<NewRunEvent, "runId">) => unknown;
    reserveAttempt: () => void;
  }): Promise<PhaseOutcome> {
    context.reserveAttempt();
    const { phase, append } = context;
    const attempt = 1;
    if (!phase.integrate || !context.options.workspaceManager) {
      return this.#terminalFailure(context, attempt, "capability-mismatch", "No workspace manager configured for explicit integration");
    }
    let workspace: WorkspaceBinding;
    try {
      workspace = await prepareWorkspace(context.options.workspaceManager, context.options.runId, phase, attempt, context.workspaceRoot);
    } catch (error) {
      return this.#terminalFailure(context, attempt, "internal-error", `integration workspace preparation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    append({ type: "workspace.prepared", phaseId: phase.id, attempt, data: { binding: workspace } });
    append({ type: "phase.attempt.started", phaseId: phase.id, attempt, data: { adapter: "host-integrate-v1", workspace } });
    const sources: WorkspaceBinding[] = [];
    for (const sourceId of phase.integrate.sources) {
      const source = context.outcomes[sourceId];
      if (source?.status !== "succeeded" || source.workspace?.mode !== "isolated") {
        return this.#terminalFailure(context, attempt, "internal-error", `integration source ${sourceId} has no succeeded isolated workspace`);
      }
      sources.push(source.workspace);
    }
    try {
      const integrated = await context.options.workspaceManager.integrate({
        runId: context.options.runId,
        phase,
        attempt,
        productRoot: context.workspaceRoot,
        sources,
      });
      const validation = this.#schemas.validate(phase.outputSchema, integrated.output);
      if (!validation.ok) return this.#terminalFailure(context, attempt, "protocol-failure", validation.error ?? "integration output validation failed");
      for (const effect of integrated.effects.mutations) {
        append({ type: "effect.observed", phaseId: phase.id, attempt, data: { effect, integration: true } });
      }
      append({ type: "workspace.integrated", phaseId: phase.id, attempt, data: { sources, target: workspace, effects: integrated.effects } });
      append({ type: "worker.result.validated", phaseId: phase.id, attempt, data: { output: integrated.output, schema: phase.outputSchema, deterministic: true, processExitCode: 0 } });
      append({ type: "phase.succeeded", phaseId: phase.id, attempt, data: { output: integrated.output, deterministic: true, effectStatus: integrated.effects.status, workspace } });
      return {
        phaseId: phase.id,
        attempt,
        status: "succeeded",
        process: { started: false, exitCode: 0 },
        protocol: { status: "valid", schema: phase.outputSchema },
        semantic: { status: "not-applicable" },
        effects: integrated.effects,
        workspace,
        output: integrated.output,
      };
    } catch (error) {
      return this.#terminalFailure(context, attempt, "authorization-violation", `integration failed closed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #executeJoin(context: {
    phase: CompiledPhase;
    outputs: Record<string, JsonValue>;
    append: (event: Omit<NewRunEvent, "runId">) => unknown;
    reserveAttempt: () => void;
    attemptOffset: number;
  }): PhaseOutcome {
    const attempt = Math.max(1, context.attemptOffset);
    if (context.attemptOffset === 0) context.reserveAttempt();
    const { phase, append } = context;
    append({ type: "phase.attempt.started", phaseId: phase.id, attempt, data: { adapter: "host-join-v1", replayedHostAttempt: context.attemptOffset > 0 } });
    const phaseIds = [...phase.dependsOn].sort();
    const missing = phaseIds.filter((id) => context.outputs[id] === undefined);
    if (missing.length) return this.#terminalFailure(context as never, attempt, "internal-error", `join missing dependency outputs: ${missing.join(", ")}`);
    const dependencyOutputs: Record<string, JsonValue> = {};
    for (const id of phaseIds) dependencyOutputs[id] = context.outputs[id];
    const output: JsonValue = { phaseIds, outputs: dependencyOutputs };
    const validation = this.#schemas.validate(phase.outputSchema, output);
    if (!validation.ok) return this.#terminalFailure(context as never, attempt, "protocol-failure", validation.error ?? "join schema failed");
    append({ type: "worker.result.validated", phaseId: phase.id, attempt, data: { output, schema: phase.outputSchema, deterministic: true, processExitCode: 0 } });
    append({ type: "phase.succeeded", phaseId: phase.id, attempt, data: { output, deterministic: true, effectStatus: "none" } });
    return {
      phaseId: phase.id,
      attempt,
      status: "succeeded",
      process: { started: false, exitCode: 0 },
      protocol: { status: "valid", schema: phase.outputSchema },
      semantic: { status: "not-applicable" },
      effects: { status: "none", mutations: [] },
      output,
    };
  }

  #terminalFailure(
    context: { phase: CompiledPhase; append: (event: Omit<NewRunEvent, "runId">) => unknown },
    attempt: number,
    category: FailureCategory,
    message: string,
  ): PhaseOutcome {
    const outcome: PhaseOutcome = {
      phaseId: context.phase.id,
      attempt,
      status: "failed",
      category,
      process: { started: false, exitCode: null },
      protocol: { status: "missing", schema: context.phase.outputSchema, error: message },
      semantic: { status: "not-applicable" },
      effects: { status: "none", mutations: [] },
      error: message,
    };
    context.append({ type: "phase.failed", phaseId: context.phase.id, attempt, data: { category, message } });
    return outcome;
  }

  #cancelled(
    context: { phase: CompiledPhase; append: (event: Omit<NewRunEvent, "runId">) => unknown },
    attempt: number,
    message: string,
    partial?: Partial<PhaseOutcome>,
  ): PhaseOutcome {
    context.append({ type: "phase.failed", phaseId: context.phase.id, attempt, data: { category: "cancelled", message } });
    return {
      phaseId: context.phase.id,
      attempt,
      status: "cancelled",
      category: "cancelled",
      process: partial?.process ?? { started: false, exitCode: null },
      protocol: partial?.protocol ?? { status: "missing", schema: context.phase.outputSchema },
      semantic: partial?.semantic ?? { status: "not-applicable" },
      effects: partial?.effects ?? { status: "none", mutations: [] },
      ...(partial?.workspace ? { workspace: partial.workspace } : {}),
      ...(partial?.output === undefined ? {} : { output: partial.output }),
      error: message,
    };
  }
}

function assertRestoredOutputValid(
  schemas: OutputSchemaRegistry,
  phase: CompiledPhase,
  output: JsonValue | undefined,
): asserts output is JsonValue {
  if (output === undefined) throw new KernelInvariantError("RESUME_OUTPUT_MISSING", `phase ${phase.id} has no durable output`);
  const validation = schemas.validate(phase.outputSchema, output);
  if (!validation.ok) {
    throw new KernelInvariantError("RESUME_OUTPUT_INVALID", `phase ${phase.id} failed ${phase.outputSchema}: ${validation.error ?? "invalid output"}`);
  }
}

function recoveredProcessExitCode(phase: CompiledPhase, validated: RunEvent, events: RunEvent[]): number {
  const direct = validated.data.processExitCode;
  const received = [...events].reverse().find((event) => event.phaseId === phase.id
    && event.attempt === validated.attempt
    && event.type === "worker.result.received");
  const value = Number.isInteger(direct) ? direct : received?.data.exitCode;
  if (!Number.isInteger(value)) {
    throw new KernelInvariantError("RESUME_PROCESS_PROVENANCE_MISSING", `validated phase ${phase.id} has no durable process exit code`);
  }
  return value as number;
}

function recoveredValidatedOutcome(
  phase: CompiledPhase,
  state: ProjectedPhaseState,
  event: RunEvent,
  processExitCode: number,
): PhaseOutcome {
  const output = cloneJson(state.output!);
  const semantic: SemanticStatus = phase.resultMode === "gate" && isGateOutput(output)
    ? { status: output.status, ...(typeof output.summary === "string" ? { summary: output.summary } : {}) }
    : { status: "not-applicable" };
  const semanticFailed = semantic.status === "fail";
  const processFailed = processExitCode !== 0;
  const failed = semanticFailed || processFailed;
  const category: FailureCategory | undefined = semanticFailed
    ? "semantic-failure"
    : processFailed
      ? phase.kind === "deterministic-command" ? "deterministic-check-failure" : "protocol-failure"
      : undefined;
  return {
    phaseId: phase.id,
    attempt: event.attempt ?? Math.max(1, state.attempts),
    status: failed ? "failed" : "succeeded",
    ...(category ? { category } : {}),
    process: { started: true, exitCode: processExitCode },
    protocol: { status: "valid", schema: phase.outputSchema },
    semantic,
    effects: state.effects,
    ...(state.workspace ? { workspace: cloneWorkspaceBinding(state.workspace) } : {}),
    output,
    ...(failed ? { error: semanticFailed ? `recovered gate ${phase.id} returned fail` : `recovered worker exited ${processExitCode}` } : {}),
  };
}

function restoreSucceededOutcome(
  phase: CompiledPhase,
  state: ProjectedPhaseState,
  events: RunEvent[],
): PhaseOutcome {
  const event = [...events].reverse().find((candidate) => candidate.phaseId === phase.id && candidate.type === "phase.succeeded");
  if (!event) throw new KernelInvariantError("RESUME_EVENT_MISSING", `phase ${phase.id} is projected succeeded without phase.succeeded event`);
  const output = state.output ?? event.data.output as JsonValue | undefined;
  if (output === undefined) throw new KernelInvariantError("RESUME_OUTPUT_MISSING", `succeeded phase ${phase.id} has no durable output`);
  const process = isProcessStatus(event.data.process)
    ? event.data.process
    : { started: phase.kind !== "join", exitCode: 0 };
  const protocol = isProtocolStatus(event.data.protocol)
    ? event.data.protocol
    : { status: "valid" as const, schema: phase.outputSchema };
  const semantic = isSemanticStatus(event.data.semantic)
    ? event.data.semantic
    : phase.resultMode === "gate" && isGateOutput(output)
      ? { status: output.status, ...(typeof output.summary === "string" ? { summary: output.summary } : {}) }
      : { status: "not-applicable" as const };
  return {
    phaseId: phase.id,
    attempt: event.attempt ?? Math.max(1, state.attempts),
    status: "succeeded",
    process,
    protocol,
    semantic,
    effects: state.effects,
    ...(state.workspace ? { workspace: cloneWorkspaceBinding(state.workspace) } : {}),
    output: cloneJson(output),
  };
}

function restoreTerminalOutcome(
  phase: CompiledPhase,
  state: ProjectedPhaseState,
  events: RunEvent[],
): PhaseOutcome {
  const event = [...events].reverse().find((candidate) => candidate.phaseId === phase.id
    && (candidate.type === "phase.failed" || candidate.type === "phase.outcome.unknown" || candidate.type === "phase.semantic.failed"));
  const category = state.status === "outcome-unknown" ? "outcome-unknown" : state.category ?? "internal-error";
  return {
    phaseId: phase.id,
    attempt: event?.attempt ?? Math.max(1, state.attempts),
    status: state.status === "outcome-unknown" ? "outcome-unknown" : state.status === "cancelled" ? "cancelled" : "failed",
    category,
    process: isProcessStatus(event?.data.process) ? event.data.process : { started: state.attempts > 0, exitCode: null },
    protocol: isProtocolStatus(event?.data.protocol) ? event.data.protocol : { status: "missing", schema: phase.outputSchema },
    semantic: isSemanticStatus(event?.data.semantic) ? event.data.semantic : { status: "not-applicable" },
    effects: state.effects,
    ...(state.workspace ? { workspace: cloneWorkspaceBinding(state.workspace) } : {}),
    ...(state.output === undefined ? {} : { output: cloneJson(state.output) }),
    error: typeof event?.data.message === "string" ? event.data.message : `restored terminal ${category}`,
  };
}

function isProcessStatus(value: unknown): value is ProcessStatus {
  if (!value || typeof value !== "object") return false;
  const item = value as ProcessStatus;
  return typeof item.started === "boolean" && (item.exitCode === null || Number.isInteger(item.exitCode));
}

function isProtocolStatus(value: unknown): value is ProtocolStatus {
  if (!value || typeof value !== "object") return false;
  const item = value as ProtocolStatus;
  return (item.status === "valid" || item.status === "invalid" || item.status === "missing") && typeof item.schema === "string";
}

function isSemanticStatus(value: unknown): value is SemanticStatus {
  if (!value || typeof value !== "object") return false;
  const item = value as SemanticStatus;
  return item.status === "not-applicable" || item.status === "pass" || item.status === "fail";
}

function isGateOutput(value: JsonValue): value is { status: "pass" | "fail"; summary?: string } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && ((value as { status?: unknown }).status === "pass" || (value as { status?: unknown }).status === "fail");
}

function resolvePhaseInput(
  source: JsonObject,
  inputs: Record<string, JsonPrimitive>,
  outputs: Record<string, JsonValue>,
  workspaceRoot: string,
): JsonObject {
  const resolve = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === "object") {
      const object: JsonObject = {};
      for (const key of Object.keys(value).sort()) object[key] = resolve(value[key]);
      return object;
    }
    if (typeof value !== "string" || !value.startsWith("${") || !value.endsWith("}")) return value;
    const expression = value.slice(2, -1);
    if (expression === "workspace.root") return workspaceRoot;
    if (expression.startsWith("inputs.")) {
      const key = expression.slice("inputs.".length);
      if (!Object.hasOwn(inputs, key)) throw new KernelInvariantError("MISSING_RESOLVED_INPUT", key);
      return inputs[key];
    }
    const match = /^phases\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.(output|effects)$/.exec(expression);
    if (match?.[2] === "output") {
      if (!Object.hasOwn(outputs, match[1])) throw new KernelInvariantError("MISSING_DEPENDENCY_OUTPUT", match[1]);
      return cloneJson(outputs[match[1]]);
    }
    // Effect references are reserved in the v2 syntax; the first spike does
    // not yet expose an effect projection as phase input.
    if (match?.[2] === "effects") throw new KernelInvariantError("EFFECT_INPUT_NOT_IMPLEMENTED", expression);
    throw new KernelInvariantError("INVALID_COMPILED_EXPRESSION", expression);
  };
  return resolve(source) as JsonObject;
}

function addEffect(status: EffectStatus, effect: EffectRecord): void {
  status.status = "observed";
  const key = `${effect.kind}\0${effect.path}`;
  if (!status.mutations.some((item) => `${item.kind}\0${item.path}` === key)) status.mutations.push({ ...effect });
  status.mutations.sort((a, b) => `${a.path}\0${a.kind}`.localeCompare(`${b.path}\0${b.kind}`));
}

function retryIsMutationSafe(phase: CompiledPhase, effects: EffectStatus): boolean {
  if (phase.access === "read-only") return effects.status === "none";
  if (phase.workspace.mode === "isolated") return true;
  return effects.status === "none";
}

function isAcknowledgementFailure(category: FailureCategory): boolean {
  return category === "provider-transient"
    || category === "protocol-failure"
    || category === "launch-failure"
    || category === "result-file-pending"
    || category === "effects-unobservable";
}

async function prepareWorkspace(
  manager: WorkspaceManager | undefined,
  runId: string,
  phase: CompiledPhase,
  attempt: number,
  productRoot: string,
): Promise<WorkspaceBinding> {
  if (manager) return await manager.prepare({ runId, phase, attempt, productRoot });
  if (phase.workspace.mode === "isolated" || phase.kind === "integrate") {
    throw new KernelInvariantError("WORKSPACE_MANAGER_MISSING", `phase ${phase.id} requires the isolated workspace manager`);
  }
  return { mode: "shared", root: productRoot, productRoot, phaseId: phase.id, attempt };
}

function pendingOutcome(
  phase: CompiledPhase,
  attempt: number,
  category: "result-file-pending" | "detached-survivor",
  message: string,
  effects: EffectStatus,
  workspace?: WorkspaceBinding,
): PhaseOutcome {
  return {
    phaseId: phase.id,
    attempt,
    status: "pending",
    category,
    process: { started: true, exitCode: null },
    protocol: { status: "missing", schema: phase.outputSchema },
    semantic: { status: "not-applicable" },
    effects,
    ...(workspace ? { workspace: cloneWorkspaceBinding(workspace) } : {}),
    error: message,
  };
}

function terminalOutcome(
  phase: CompiledPhase,
  attempt: number,
  category: FailureCategory,
  message: string,
  effects: EffectStatus,
  workspace?: WorkspaceBinding,
  outcomeUnknown = false,
): PhaseOutcome {
  return {
    phaseId: phase.id,
    attempt,
    status: outcomeUnknown ? "outcome-unknown" : "failed",
    category,
    process: { started: true, exitCode: null },
    protocol: { status: "missing", schema: phase.outputSchema },
    semantic: { status: "not-applicable" },
    effects,
    ...(workspace ? { workspace: cloneWorkspaceBinding(workspace) } : {}),
    error: message,
  };
}

function lastWorkerRunId(events: RunEvent[], phaseId: string, attempt: number): string | undefined {
  const event = [...events].reverse().find((candidate) => candidate.phaseId === phaseId
    && candidate.attempt === attempt
    && candidate.type === "phase.attempt.started");
  return typeof event?.data.workerRunId === "string" ? event.data.workerRunId : undefined;
}

function unknownInspection(workerRunId: string): WorkerInspection {
  return { workerRunId, state: "unknown", effects: { status: "unsupported", mutations: [] } };
}

function mergeEffects(left: EffectStatus, right: EffectStatus): EffectStatus {
  const merged: EffectStatus = {
    status: left.status === "observed" || right.status === "observed"
      ? "observed"
      : left.status === "unsupported" || right.status === "unsupported"
        ? "unsupported"
        : "none",
    mutations: [],
  };
  for (const effect of [...left.mutations, ...right.mutations]) addEffect(merged, effect);
  if (!merged.mutations.length && merged.status === "observed") merged.status = "none";
  return merged;
}

function publicationIdentityMatches(recorded: unknown, inspected: unknown): boolean {
  if (!recorded || typeof recorded !== "object" || Array.isArray(recorded)
    || !inspected || typeof inspected !== "object" || Array.isArray(inspected)) return false;
  const left = recorded as { manifestFile?: unknown; resultFile?: unknown };
  const right = inspected as { manifestFile?: unknown; resultFile?: unknown };
  return typeof left.manifestFile === "string"
    && typeof left.resultFile === "string"
    && left.manifestFile === right.manifestFile
    && left.resultFile === right.resultFile;
}

function cloneWorkspaceBinding(binding: WorkspaceBinding): WorkspaceBinding {
  return JSON.parse(JSON.stringify(binding)) as WorkspaceBinding;
}

async function safeInspect(adapter: WorkerAdapter, workerRunId: string): Promise<Awaited<ReturnType<WorkerAdapter["inspect"]>>> {
  try {
    return await adapter.inspect(workerRunId);
  } catch {
    return unknownInspection(workerRunId);
  }
}

function linkedAbortController(parent?: AbortSignal): AbortController {
  const controller = new AbortController();
  const reason = () => ({ code: "ORCN_PARENT_ABORT", cause: parent?.reason instanceof Error ? parent.reason.message : String(parent?.reason ?? "aborted") });
  if (parent?.aborted) controller.abort(reason());
  else parent?.addEventListener("abort", () => controller.abort(reason()), { once: true });
  return controller;
}

async function boundedMap<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

function canonicalDirectory(directory: string): string {
  const absolute = path.resolve(directory);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new KernelInvariantError("WORKSPACE_MISSING", absolute);
  return realpathSync(absolute);
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sortRecord<T>(value: Record<string, T>): Record<string, T> {
  const result: Record<string, T> = {};
  for (const key of Object.keys(value).sort()) result[key] = value[key];
  return result;
}
