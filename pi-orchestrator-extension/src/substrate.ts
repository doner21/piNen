/**
 * Layer A — Substrate
 * ==================
 * Role-agnostic safety and plumbing only. This module contains no
 * shape-specific orchestration concepts. It provides the bounded
 * infrastructure that every orchestration shape builds on.
 *
 * GUARANTEE: The substrate enforces hard non-negotiable caps. No shape,
 * no matter what it requests, can run forever or spawn unbounded subagents.
 * Bounded / cannot-run-forever is a **substrate guarantee**.
 *
 * SHAPE-OWNED: The *meaning* of termination (e.g. "make 3 passes",
 * "majority vote requires at least 3 passes") is **shape-owned**. The
 * substrate only enforces that whatever iterations/spawns the shape
 * requests are clamped to safe, finite limits.
 */

import { spawn, type SpawnOptions } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  emptyToolCallSummary,
  recordToolCall,
  parseProviderError,
  formatProviderError,
  type ToolCallSummary,
  type ProviderHealthError,
} from "./judgment";
import { getPiChildFirstJsonTimeoutMs, isPiJsonProtocolEvent, killOwnedProcessTree, resolvePiChildCommand } from "./child-launch.ts";

// ── Re-exported agent profile (role-agnostic shape) ────────────────────────

export interface AgentProfile {
  name: string;
  description?: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  tools?: string[];
  skills?: string[];
  agencyLevel?: string | number;
}

// ── Hard non-negotiable caps ───────────────────────────────────────────────

/**
 * Substrate-level hard limits. No shape can request more than these.
 * These are enforced at the substrate boundary before any work starts.
 *
 * - MAX_TOTAL_SPAWNS: absolute ceiling on subagent process spawns across
 *   the entire orchestration. Once hit, no further spawns are permitted.
 * - ABSOLUTE_MAX_ITERATIONS: absolute ceiling on the number of bounded
 *   iteration loops any shape may perform. The substrate clamps
 *   every shape-requested iteration value to this cap.
 */
export const SUBSTRATE_CAPS = {
  /** Absolute maximum subagent spawns (pipe ceiling). */
  MAX_TOTAL_SPAWNS: 200,
  /** Absolute maximum iterations any shape may request. Clamped here. */
  ABSOLUTE_MAX_ITERATIONS: 50,
} as const;

// ── Monotonic spawn-ceiling guard ──────────────────────────────────────────

/**
 * Monotonic spawn-ceiling guard.
 *
 * Guarantees:
 * - The total number of subagent spawns never exceeds `cap`.
 * - Spawns are counted monotonically (only increase).
 * - Checking and incrementing is atomic from the caller's perspective.
 *
 * The `cap` itself is clamped to SUBSTRATE_CAPS.MAX_TOTAL_SPAWNS on
 * construction, so even a shape that passes an absurdly high value is
 * bounded by the substrate.
 */
export class SpawnGuard {
  private _spawned = 0;
  readonly cap: number;

  constructor(requestedCap: number) {
    this.cap = clampSpawnCeiling(requestedCap);
  }

  /** Total spawns recorded so far. */
  get spawned(): number {
    return this._spawned;
  }

  /** Remaining spawn slots before the ceiling is hit. */
  get remaining(): number {
    return Math.max(0, this.cap - this._spawned);
  }

  /**
   * Reserve one spawn slot. Returns the new count on success.
   * Throws if the ceiling has already been reached — the substrate
   * guarantee is that no spawn can exceed the cap.
   */
  reserve(): number {
    if (this._spawned >= this.cap) {
      throw new Error(
        `Substrate spawn ceiling exceeded: already spawned ${this._spawned}/${this.cap}. ` +
          `This is a substrate-level hard cap (MAX_TOTAL_SPAWNS=${SUBSTRATE_CAPS.MAX_TOTAL_SPAWNS}). ` +
          `The orchestration cannot continue.`,
      );
    }
    return ++this._spawned;
  }

  /**
   * Raise the spawn ceiling. The new cap is clamped through the substrate
   * hard limit. The cap can only increase, never decrease (monotonic).
   * This supports runtime budget adjustments (e.g. auto-raise in the shape).
   */
  raiseCeiling(requestedCap: number): number {
    const clamped = clampSpawnCeiling(requestedCap);
    if (clamped > this.cap) {
      (this as { cap: number }).cap = clamped;
    }
    return this.cap;
  }

  /**
   * Check whether a given number of additional spawns would fit.
   * Does NOT reserve — use `reserve()` for that.
   */
  wouldFit(count: number): boolean {
    return this._spawned + count <= this.cap;
  }
}

// ── Clamping helpers ───────────────────────────────────────────────────────

/**
 * Clamp a shape-requested spawn ceiling through the substrate hard cap.
 * Every shape MUST pass its ceiling value through this function to
 * ensure the bounded/cannot-run-forever guarantee.
 */
export function clampSpawnCeiling(requested: number): number {
  return Math.max(1, Math.min(Math.trunc(requested), SUBSTRATE_CAPS.MAX_TOTAL_SPAWNS));
}

/**
 * Clamp a shape-requested iteration / attempt count through the
 * substrate hard cap. Shapes own the *meaning* of iterations
 * (e.g. retries, votes, rounds), but the substrate ensures they
 * cannot request an unbounded number.
 */
export function clampIterations(requested: number): number {
  return Math.max(1, Math.min(Math.trunc(requested), SUBSTRATE_CAPS.ABSOLUTE_MAX_ITERATIONS));
}

// ── Subagent result ────────────────────────────────────────────────────────

export interface SubagentResult {
  agentName: string;
  provider?: string;
  model?: string;
  task: string;
  text: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  events: number;
  /** Set by recovery/quality layer when subagent output appears truncated. */
  truncated?: boolean;
  /** Set by recovery layer when the subagent signalled context exhaustion. */
  contextExhaustionSignal?: boolean;
  /**
   * Effect-evidence telemetry: tool executions observed in the child's
   * JSONL stream. `mutating` counts write/edit/bash-class tools.
   */
  toolCalls?: ToolCallSummary;
  /** Transient assistant/transport failures cleared by the child's successful auto-retry lifecycle. */
  recoveredAssistantFailures?: string[];
}

// ── spawnSubagent ──────────────────────────────────────────────────────────

export interface SpawnSubagentOptions {
  /** Agent profiles map for resolving agent configuration. */
  agents: Map<string, AgentProfile>;
  /** Working directory for the spawned process. */
  cwd: string;
  /** Whether to permit local-model providers (ollama, lmstudio, etc.). */
  allowLocalModel: boolean;
  /** AbortSignal to cancel the subprocess. */
  signal?: AbortSignal;
  /** Optional inherited model/provider from the parent call context. */
  inheritedModel?: { provider?: string; model?: string };
  /** Optional progress callback. */
  onProgress?: (text: string) => void;
  /** Optional per-spawn model/provider override. */
  modelOverride?: { model?: string; provider?: string };
  /**
   * Abort-survivor mode (ABORT-RESUME-DESIGN.md): when the AbortSignal fires,
   * do NOT kill the child. Instead persist a survivor manifest, reject the
   * awaiting promise with SubagentDetachedError, keep collecting the child's
   * JSONL output in the background, and write the full SubagentResult to
   * `resultFile` when the child eventually closes. Opt-in per spawn; spawns
   * without this option keep exact kill-on-abort semantics.
   */
  abortSurvival?: {
    resultFile: string;
    manifestFile: string;
    phaseName?: string;
    phaseIndex?: number;
  };
  /**
   * True for phases that may mutate files. A terminal assistant/transport error
   * after such a child was launched is ambiguous: the child may already have
   * changed disk. It must surface as a no-retry result-lost/candidate state,
   * never as permission to auto-respawn the phase.
   */
  phaseMutates?: boolean;
}

/**
 * Thrown instead of "Subagent <name> aborted." when abort-survivor mode is
 * active: the child is still running and its result will be persisted to
 * `resultFile`. Callers should persist the detachment and surface a resume
 * hint rather than treating this as a plain failure.
 */
export class SubagentDetachedError extends Error {
  readonly manifest: {
    pid: number | undefined;
    agentName: string;
    phaseName: string;
    phaseIndex: number;
    startedAt: number;
    detachedAt: string;
    resultFile: string;
  };

  constructor(agentName: string, manifest: SubagentDetachedError["manifest"]) {
    super(
      `Subagent ${agentName} detached (abort-survivor mode): child pid=${manifest.pid} continues in the background; ` +
        `its result will be written to ${manifest.resultFile}.`,
    );
    this.name = "SubagentDetachedError";
    this.manifest = manifest;
  }
}

export interface SubagentTerminalAmbiguousInfo {
  code: "AMBIGUOUS_COMPLETION" | "RESULT_LOST_AFTER_MUTATION";
  retryAllowed: false;
  resultLost: boolean;
  agentName: string;
  errorMessage: string;
  exitCode: number | null;
  stderr: string;
  assistantFailures: string[];
  candidate?: SubagentResult;
}

export class SubagentTerminalAmbiguousError extends Error {
  readonly info: SubagentTerminalAmbiguousInfo;

  constructor(agentName: string, info: Omit<SubagentTerminalAmbiguousInfo, "agentName" | "retryAllowed">) {
    const payload: SubagentTerminalAmbiguousInfo = {
      ...info,
      agentName,
      retryAllowed: false,
    };
    super(
      `Subagent ${agentName} ended in a terminal ambiguous mutating state ` +
        `(code=${payload.code}, retryAllowed=false): ${payload.errorMessage}`,
    );
    this.name = "SubagentTerminalAmbiguousError";
    this.info = payload;
  }
}

/**
 * Spawn a single isolated Pi subagent process.
 *
 * This is role-agnostic plumbing: it resolves the agent profile,
 * builds a system prompt, launches Pi in JSON mode, pipes the task,
 * collects stdout events, and returns the final assistant text.
 *
 * It does NOT know about any shape-specific semantics.
 */
export async function spawnSubagent(
  agentName: string,
  task: string,
  options: SpawnSubagentOptions,
): Promise<SubagentResult> {
  const startedAt = Date.now();
  const loadedProfile = options.agents.get(agentName) ?? { name: agentName };
  const profile: AgentProfile = {
    ...loadedProfile,
    provider: options.modelOverride?.provider ?? loadedProfile.provider ?? options.inheritedModel?.provider,
    model: options.modelOverride?.model ?? loadedProfile.model ?? options.inheritedModel?.model,
  };
  rejectLocalModelIfNeeded(profile, options.allowLocalModel);
  options.onProgress?.(
    `Subagent ${profile.name}: using ${formatRoutedModel(profile.provider, profile.model)}.`,
  );

  const tempDir = await mkTempDir();
  const promptFile = path.join(tempDir, `${safeFileName(agentName)}-system-prompt.txt`);
  const systemPrompt = buildSubagentSystemPrompt(profile);
  await writeFile(promptFile, systemPrompt, "utf8");

  const command = resolvePiCommand();
  const args = [
    ...command.argsPrefix,
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--append-system-prompt",
    promptFile,
  ];

  if (profile.provider) args.push("--provider", profile.provider);
  if (profile.model) args.push("--model", profile.model);
  if (profile.tools) {
    const tools = profile.tools
      .map(String)
      .map((tool) => tool.trim())
      .filter(Boolean)
      .filter((tool) => tool !== "orchestrate");
    if (tools.length > 0) args.push("--tools", tools.join(","));
    else args.push("--no-tools");
  }
  for (const skill of profile.skills ?? []) {
    const trimmed = String(skill).trim();
    if (trimmed) args.push("--skill", trimmed);
  }

  // Pipe the task via stdin to avoid ENAMETOOLONG on Windows.
  const safeArgLen = process.platform === "win32" ? 6000 : 128_000;
  let pipeStdin = false;
  if (task.length <= safeArgLen) {
    args.push(task);
  } else {
    pipeStdin = true;
    options.onProgress?.(
      `Subagent ${profile.name}: prompt size ${task.length} chars exceeds safe arg limit ${safeArgLen}; piping via stdin.`,
    );
  }

  options.onProgress?.(
    `Subagent ${profile.name}: launching ${path.basename(command.command)} ${args.includes("--no-extensions") ? "--no-extensions" : ""} --mode json in ${options.cwd}`,
  );

  const baseSpawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: command.env ?? process.env,
    stdio: [pipeStdin ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: command.shell,
  };
  const launchAttempts = buildWindowsEpermSpawnAttempts(command.command, args, baseSpawnOptions);

  try {
    for (let attemptIndex = 0; attemptIndex < launchAttempts.length; attemptIndex++) {
      const launch = launchAttempts[attemptIndex];
      let stderr = "";
      let lastAssistantText = "";
      let eventCount = 0;
      let killedByAbort = false;
      let agentEnded = false;
      let protocolTimedOut = false;
      let firstJsonProtocolEventSeen = false;
      let firstJsonTimer: NodeJS.Timeout | undefined;
      const firstJsonTimeoutMs = getPiChildFirstJsonTimeoutMs(command.env ?? process.env);
      const markFirstJsonProtocolEvent = () => {
        if (firstJsonProtocolEventSeen) return;
        firstJsonProtocolEventSeen = true;
        if (firstJsonTimer) clearTimeout(firstJsonTimer);
      };
      const assistantFailures: string[] = [];
      // Retryable failures are parked here when Pi reports that the child will
      // retry (or that its auto-retry succeeded). They remain useful telemetry,
      // but must not poison a subsequently successful child result.
      const recoveredAssistantFailures: string[] = [];
      const toolCalls = emptyToolCallSummary();

      let child;
      try {
        child = spawn(launch.command, launch.args, launch.options);
        firstJsonTimer = setTimeout(() => {
          protocolTimedOut = true;
          stderr += `\nPI_CHILD_FIRST_JSON_TIMEOUT: no valid JSON protocol event within ${firstJsonTimeoutMs}ms from ${path.basename(launch.command)}; terminating owned child tree.`;
          try { child.kill("SIGTERM"); } catch {}
          killOwnedProcessTree(child.pid, "first-json-timeout");
        }, firstJsonTimeoutMs);
        firstJsonTimer.unref?.();
      } catch (err) {
        if (isWindowsSpawnEperm(err) && attemptIndex < launchAttempts.length - 1) {
          const next = launchAttempts[attemptIndex + 1];
          options.onProgress?.(
            `Subagent ${profile.name}: Windows spawn EPERM from ${formatSpawnAttempt(launch)}; ` +
              `retrying with ${formatSpawnAttempt(next)}.`,
          );
          continue;
        }
        // Terminal EPERM: capture evidence before throwing.
        const evidence = buildWindowsEpermEvidence(err, launch, options.cwd);
        const evidencePath = await writeWindowsEpermEvidence(evidence);
        const evidenceSuffix = evidencePath ? ` Evidence: ${evidencePath}` : " Evidence capture skipped.";
        throw new Error(formatSpawnFailure(err, launch, options.cwd) + evidenceSuffix);
      }

      // Pipe the task via stdin when it exceeds the safe arg limit.
      if (pipeStdin && child.stdin) {
        child.stdin.write(task);
        child.stdin.end();
      }

      // Abort-survivor plumbing (ABORT-RESUME-DESIGN.md): when enabled, an
      // abort detaches instead of killing. detachReject unwinds the awaiting
      // promise; the background close-handler persists the final result.
      let detachReject: ((err: SubagentDetachedError) => void) | undefined;
      const detachPromise = new Promise<never>((_resolve, reject) => {
        detachReject = reject;
      });
      // Prevent unhandled-rejection noise when the race resolves normally.
      detachPromise.catch(() => {});

      const abortHandler = () => {
        const survival = options.abortSurvival;
        if (survival) {
          const manifest = {
            pid: child.pid,
            agentName: profile.name,
            phaseName: survival.phaseName ?? "(unnamed)",
            phaseIndex: survival.phaseIndex ?? -1,
            startedAt,
            detachedAt: new Date().toISOString(),
            resultFile: survival.resultFile,
          };
          try {
            writeFileSync(survival.manifestFile, JSON.stringify(manifest, null, 2), "utf8");
          } catch {}
          // Background completion: when the orphaned child finally closes,
          // persist the complete SubagentResult from the still-attached
          // collectors. (v1 limitation: requires this Pi process to stay
          // alive; the child's cwd artifacts are durable regardless.)
          child.once("close", (code) => {
            const backgroundResult: SubagentResult = {
              agentName: profile.name,
              task,
              text: lastAssistantText.trim(),
              stderr: stderr.trim(),
              exitCode: code,
              durationMs: Date.now() - startedAt,
              events: eventCount,
              toolCalls,
            };
            if (profile.provider) backgroundResult.provider = profile.provider;
            if (profile.model) backgroundResult.model = profile.model;
            if (recoveredAssistantFailures.length > 0) {
              backgroundResult.recoveredAssistantFailures = [...recoveredAssistantFailures];
            }
            try {
              writeFileSync(survival.resultFile, JSON.stringify(backgroundResult, null, 2), "utf8");
            } catch {}
          });
          detachReject?.(new SubagentDetachedError(profile.name, manifest));
          return;
        }
        killedByAbort = true;
        if (firstJsonTimer) clearTimeout(firstJsonTimer);
        try { child.kill("SIGTERM"); } catch {}
        killOwnedProcessTree(child.pid, "abort");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
          killOwnedProcessTree(child.pid, "abort-hard-kill");
        }, 2000).unref?.();
      };
      if (options.signal) {
        if (options.signal.aborted) abortHandler();
        else options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      const stdoutReader = createInterface({ input: child.stdout });
      stdoutReader.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const event = JSON.parse(trimmed);
          if (isPiJsonProtocolEvent(event)) markFirstJsonProtocolEvent();
          eventCount++;
          const progress = describeJsonEvent(profile.name, event);
          if (progress) options.onProgress?.(progress);

          // Effect-evidence telemetry: count tool executions by tool name.
          if (event?.type === "tool_execution_start") {
            const toolName = optionalString((event as Record<string, unknown>).toolName);
            if (toolName) recordToolCall(toolCalls, toolName);
          }

          // Respect Pi's child auto-retry lifecycle. An agent_end carrying
          // willRetry=true closes only the failed attempt, not the child turn.
          // Park its failures as recovered telemetry and keep accepting the
          // retry's assistant messages. A successful auto_retry_end is a
          // belt-and-braces recovery signal for protocol variants that omit or
          // reorder willRetry.
          if (event?.type === "agent_end") {
            if ((event as { willRetry?: boolean }).willRetry === true) {
              recoveredAssistantFailures.push(...assistantFailures);
              assistantFailures.length = 0;
              agentEnded = false;
            } else {
              agentEnded = true;
            }
          }
          if (event?.type === "auto_retry_end" && (event as { success?: boolean }).success === true) {
            recoveredAssistantFailures.push(...assistantFailures);
            assistantFailures.length = 0;
          }

          if (
            event?.type === "message_end" &&
            event.message?.role === "assistant" &&
            !agentEnded
          ) {
            lastAssistantText = extractMessageText(event.message);
            const stopReason =
              optionalString(event.message.stopReason) ??
              optionalString(event.stopReason);
            const errorMessage =
              optionalString(event.message.errorMessage) ??
              optionalString(event.errorMessage) ??
              optionalString(event.message.error?.message) ??
              optionalString(event.error?.message);
            const normalizedStopReason = stopReason?.toLowerCase();
            if (normalizedStopReason === "error" || normalizedStopReason === "aborted") {
              assistantFailures.push(`assistant stopReason=${stopReason}`);
            }
            if (errorMessage) assistantFailures.push(`assistant errorMessage=${errorMessage}`);
          }
        } catch {
          // JSON mode should emit JSONL; ignore any incidental non-JSON line defensively.
        }
      });

      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      let exitCode: number | null;
      try {
        exitCode = await Promise.race([
          new Promise<number | null>((resolve, reject) => {
            child.on("error", reject);
            child.on("close", (code) => resolve(code));
          }),
          detachPromise,
        ]);
      } catch (err) {
        if (firstJsonTimer) clearTimeout(firstJsonTimer);
        if (options.signal) options.signal.removeEventListener("abort", abortHandler);
        if (err instanceof SubagentDetachedError) {
          // Deliberately do NOT close the stdoutReader: the background
          // collectors keep accumulating until the orphaned child closes.
          options.onProgress?.(
            `Subagent ${profile.name}: DETACHED on abort (pid=${err.manifest.pid}); ` +
              `result will be persisted to ${err.manifest.resultFile}.`,
          );
          throw err;
        }
        stdoutReader.close();
        if (isWindowsSpawnEperm(err) && attemptIndex < launchAttempts.length - 1) {
          const next = launchAttempts[attemptIndex + 1];
          options.onProgress?.(
            `Subagent ${profile.name}: Windows spawn EPERM from ${formatSpawnAttempt(launch)}; ` +
              `retrying with ${formatSpawnAttempt(next)}.`,
          );
          continue;
        }
        // Terminal EPERM: capture evidence before throwing.
        const evidence = buildWindowsEpermEvidence(err, launch, options.cwd);
        const evidencePath = await writeWindowsEpermEvidence(evidence);
        const evidenceSuffix = evidencePath ? ` Evidence: ${evidencePath}` : " Evidence capture skipped.";
        throw new Error(formatSpawnFailure(err, launch, options.cwd) + evidenceSuffix);
      }

      if (firstJsonTimer) clearTimeout(firstJsonTimer);
      if (options.signal) options.signal.removeEventListener("abort", abortHandler);
      stdoutReader.close();

      const buildCandidate = (): SubagentResult => {
        const candidate: SubagentResult = {
          agentName: profile.name,
          task,
          text: lastAssistantText.trim(),
          stderr: stderr.trim(),
          exitCode,
          durationMs: Date.now() - startedAt,
          events: eventCount,
          toolCalls,
        };
        if (profile.provider) candidate.provider = profile.provider;
        if (profile.model) candidate.model = profile.model;
        if (recoveredAssistantFailures.length > 0) {
          candidate.recoveredAssistantFailures = [...recoveredAssistantFailures];
        }
        return candidate;
      };
      const throwAmbiguousIfMutating = (errorMessage: string): void => {
        const mutatingEvidence = options.phaseMutates === true || toolCalls.mutating > 0;
        if (!mutatingEvidence) return;
        const candidate = lastAssistantText.trim() ? buildCandidate() : undefined;
        throw new SubagentTerminalAmbiguousError(profile.name, {
          code: candidate ? "AMBIGUOUS_COMPLETION" : "RESULT_LOST_AFTER_MUTATION",
          resultLost: !candidate,
          errorMessage,
          exitCode,
          stderr: stderr.trim(),
          assistantFailures: [...assistantFailures],
          ...(candidate ? { candidate } : {}),
        });
      };

      if (killedByAbort) throw new Error(`Subagent ${agentName} aborted.`);
      if (protocolTimedOut) {
        const message = JSON.stringify({
          type: "pi_child_first_json_timeout",
          agent: agentName,
          timeoutMs: firstJsonTimeoutMs,
          pid: child.pid,
          cwd: options.cwd,
          commandBasename: path.basename(launch.command),
          launchRuntime: command.launchRuntime,
        });
        throwAmbiguousIfMutating(message);
        throw new Error(message);
      }
      if (exitCode !== 0) {
        const message = `Subagent ${agentName} exited with code ${exitCode}. stderr: ${truncateWithNotice(stderr.trim(), 2000, "stderr")}`;
        throwAmbiguousIfMutating(message);
        throw new Error(message);
      }
      if (assistantFailures.length > 0) {
        const stderrSuffix = stderr.trim()
          ? ` stderr: ${truncateWithNotice(stderr.trim(), 1000, "stderr")}`
          : "";
        const message =
          `Subagent ${agentName} reported assistant failure despite exit code 0: ` +
          `${truncateWithNotice(assistantFailures.join("; "), 2000, "assistant failure details")}.${stderrSuffix}`;
        throwAmbiguousIfMutating(message);
        throw new Error(message);
      }

      const result = buildCandidate();
      if (recoveredAssistantFailures.length > 0) {
        options.onProgress?.(
          `Subagent ${profile.name}: transient assistant/transport failure(s) auto-recovered by child retry: ` +
            truncateWithNotice(recoveredAssistantFailures.join("; "), 1000, "recovered failure details"),
        );
      }
      return result;
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  throw new Error(`Subagent ${agentName} did not launch: no spawn attempts were available.`);
}

// ── Windows spawn hardening ───────────────────────────────────────────────

export interface SpawnAttemptDescriptor {
  label: string;
  command: string;
  args: string[];
  options: SpawnOptions;
}

export function buildWindowsEpermSpawnAttempts(
  command: string,
  args: string[],
  baseOptions: SpawnOptions,
): SpawnAttemptDescriptor[] {
  const attempts: SpawnAttemptDescriptor[] = [
    { label: "primary", command, args, options: baseOptions },
  ];
  if (process.platform !== "win32") return attempts;

  // Some Windows hosts return EPERM for direct hidden console-subsystem
  // CreateProcess calls from TUI/job-object contexts. Keep the normal hidden
  // launch first, then retry through cmd.exe (still hidden) before the final
  // no-CREATE_NO_WINDOW fallback.
  if (!baseOptions.shell) {
    attempts.push({
      label: "windows-shell-hidden-fallback",
      command,
      args,
      options: { ...baseOptions, shell: true, windowsHide: true, detached: false },
    });
  }

  attempts.push({
    label: "windows-visible-fallback",
    command,
    args,
    options: { ...baseOptions, windowsHide: false, detached: false },
  });
  return attempts;
}

export function isWindowsSpawnEperm(err: unknown): boolean {
  if (process.platform !== "win32") return false;
  const record = err as { code?: unknown; message?: unknown };
  return record?.code === "EPERM" || /\bspawn\b[\s\S]*\bEPERM\b/i.test(String(record?.message ?? err));
}

export function formatSpawnAttempt(attempt: SpawnAttemptDescriptor): string {
  const command = path.basename(attempt.command || "<unknown>");
  const shell = attempt.options.shell ? "shell" : "direct";
  const hidden = attempt.options.windowsHide === false ? "visible" : "hidden";
  return `${attempt.label} ${command} (${shell}, ${hidden})`;
}

export function formatSpawnFailure(err: unknown, attempt: SpawnAttemptDescriptor, cwd: string): string {
  const record = err as { code?: unknown; message?: unknown };
  const code = record?.code ? ` code=${String(record.code)}` : "";
  const message = String(record?.message ?? err);
  const hint = isWindowsSpawnEperm(err)
    ? " Hint: Windows returned EPERM while launching a Pi subagent subprocess. " +
      "Common causes are antivirus/EDR interception, a restrictive parent Job object, " +
      "or CREATE_NO_WINDOW/windowsHide interactions in a console-less TUI process. " +
      "Try launching Pi from a normal terminal, checking Defender/EDR events, or " +
      "testing node child-process creation from the same parent context."
    : "";
  return `spawn failed (${formatSpawnAttempt(attempt)}) cwd=${cwd}${code}: ${message}.${hint}`;
}

// ── Windows EPERM evidence capture ──────────────────────────────────────

/**
 * JSON-serializable evidence record written to disk when a Windows spawn
 * EPERM cannot be retried (terminal failure). Contains only safe,
 * read-only fields — never logs API keys, prompts, full env, or task text.
 */
export interface WindowsEpermEvidence {
  schemaVersion: number;
  kind: "windows-spawn-eperm-evidence";
  timestampUtc: string;
  pid: number;
  ppid: number;
  platform: string;
  nodeVersion: string;
  execPath: {
    basename: string;
    equalsProcessExecPath: boolean;
    exists: boolean;
  };
  cwd: {
    basename: string;
    exists: boolean;
  };
  attempt: {
    label: string;
    commandBasename: string;
    argsCount: number;
    options: {
      shell: boolean;
      windowsHide: boolean;
      detached: boolean;
      stdioShape: string;
    };
  };
  envAllowlist: {
    PATH_present: boolean;
    PI_CLI_PATH_present: boolean;
    PI_CLI_present: boolean;
  };
  error: {
    code: string | null;
    message: string;
  };
  correlationWindowMinutes: number;
}

/**
 * Redacted view of a spawn attempt — never includes the full command path
 * unless it equals process.execPath, and never logs argument text.
 */
export interface SafeAttemptView {
  label: string;
  commandBasename: string;
  argsCount: number;
  shell: boolean;
  windowsHide: boolean;
  detached: boolean;
  stdioShape: string;
}

/**
 * Redact a SpawnAttemptDescriptor into a SafeAttemptView for evidence
 * capture. Only computes basename, counts, and boolean flags.
 */
export function redactSpawnAttempt(attempt: SpawnAttemptDescriptor): SafeAttemptView {
  return {
    label: attempt.label,
    commandBasename: path.basename(attempt.command || "<unknown>"),
    argsCount: attempt.args?.length ?? 0,
    shell: attempt.options?.shell === true,
    windowsHide: attempt.options?.windowsHide !== false,
    detached: attempt.options?.detached === true,
    stdioShape: JSON.stringify((attempt.options?.stdio ?? ["ignore", "pipe", "pipe"]).map((s: unknown) => s === "pipe" ? "pipe" : s === "ignore" ? "ignore" : "inherit")),
  };
}

/**
 * Sanitize a spawn error message to remove full command paths and other
 * potentially sensitive strings while preserving useful diagnostic info.
 */
function sanitizeSpawnErrorMessage(err: unknown, attempt: SpawnAttemptDescriptor): string {
  let sanitized = String((err as { message?: unknown })?.message ?? err);
  // Replace the full command path with its basename.
  const commandPath = attempt.command;
  if (commandPath && commandPath.length > 4) {
    const escaped = commandPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    sanitized = sanitized.replace(new RegExp(escaped, "g"), path.basename(commandPath));
  }
  // Additional scrubbing: remove anything that looks like a Windows full path.
  sanitized = sanitized.replace(/[A-Za-z]:\\[^\s"'>;,!]{8,}/g, "[path-redacted]");
  return sanitized.slice(0, 500);
}

/**
 * Build a WindowsEpermEvidence record from the error, spawn attempt, and
 * working directory. Pure — performs no I/O.
 */
export function buildWindowsEpermEvidence(
  err: unknown,
  attempt: SpawnAttemptDescriptor,
  cwd: string,
): WindowsEpermEvidence {
  const record = err as { code?: unknown; message?: unknown };
  const safe = redactSpawnAttempt(attempt);
  return {
    schemaVersion: 1,
    kind: "windows-spawn-eperm-evidence",
    timestampUtc: new Date().toISOString(),
    pid: process.pid,
    ppid: process.ppid,
    platform: process.platform,
    nodeVersion: process.version,
    execPath: {
      basename: path.basename(process.execPath),
      equalsProcessExecPath: safe.commandBasename === path.basename(process.execPath),
      exists: existsSync(process.execPath),
    },
    cwd: {
      basename: path.basename(cwd),
      exists: existsSync(cwd),
    },
    attempt: {
      label: safe.label,
      commandBasename: safe.commandBasename,
      argsCount: safe.argsCount,
      options: {
        shell: safe.shell,
        windowsHide: safe.windowsHide,
        detached: safe.detached,
        stdioShape: safe.stdioShape,
      },
    },
    envAllowlist: {
      PATH_present: "PATH" in process.env,
      PI_CLI_PATH_present: "PI_CLI_PATH" in process.env,
      PI_CLI_present: "PI_CLI" in process.env,
    },
    error: {
      code: typeof record?.code === "string" ? record.code : null,
      message: sanitizeSpawnErrorMessage(err, attempt),
    },
    correlationWindowMinutes: 10,
  };
}

/**
 * Best-effort write of WindowsEpermEvidence to disk. Creates
 * `agent/diagnostics/spawn-eperm/` if needed, writes a JSON file, and
 * returns the path. Swallows all errors silently — never throws.
 */
export async function writeWindowsEpermEvidence(
  evidence: WindowsEpermEvidence,
): Promise<string | null> {
  try {
    const dir = path.resolve(process.cwd(), "agent", "diagnostics", "spawn-eperm");
    await mkdir(dir, { recursive: true });
    const fileName = `spawn-eperm-${evidence.pid}-${Date.now()}.json`;
    const filePath = path.join(dir, fileName);
    await writeFile(filePath, JSON.stringify(evidence, null, 2), "utf8");
    return filePath;
  } catch {
    return null;
  }
}

// ── Pre-flight provider health checks (F5) ────────────────────────────────

export interface PreflightRoute {
  /** Role(s) this route serves — for reporting only. */
  roles: string[];
  provider?: string;
  model?: string;
}

export interface PreflightResult {
  roles: string[];
  provider?: string;
  model?: string;
  ok: boolean;
  durationMs: number;
  error?: ProviderHealthError;
}

/**
 * Run a 1-token health ping for each unique routed provider/model pair
 * BEFORE any work subagent is spawned (F5). Failures are returned as
 * structured, machine-readable errors (provider, type, resets_at) instead
 * of raw payload dumps. Pings do not count against orchestration budgets.
 */
export async function preflightProviderHealth(
  routes: PreflightRoute[],
  options: {
    cwd: string;
    allowLocalModel: boolean;
    signal?: AbortSignal;
    onProgress?: (text: string) => void;
    /** Hard wall-clock bound for each provider/model ping. Production default: 20 seconds. */
    timeoutMs?: number;
  },
): Promise<PreflightResult[]> {
  // Dedupe identical provider/model pairs, merging role labels.
  const unique = new Map<string, PreflightRoute>();
  for (const route of routes) {
    if (!route.provider && !route.model) continue;
    const key = `${route.provider ?? ""}::${route.model ?? ""}`;
    const existing = unique.get(key);
    if (existing) existing.roles.push(...route.roles.filter((r) => !existing.roles.includes(r)));
    else unique.set(key, { roles: [...route.roles], provider: route.provider, model: route.model });
  }

  const results: PreflightResult[] = [];
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 20_000));
  const preflightAgents = new Map<string, AgentProfile>([
    ["preflight", { name: "preflight", description: "Provider health ping", tools: [] }],
  ]);

  for (const route of unique.values()) {
    const startedAt = Date.now();
    const label = formatRoutedModel(route.provider, route.model);
    options.onProgress?.(`Preflight ping: checking ${label} (roles: ${route.roles.join(", ")}, timeout=${timeoutMs}ms)...`);
    const pingController = new AbortController();
    let timedOut = false;
    const outerAbort = () => pingController.abort();
    if (options.signal) {
      if (options.signal.aborted) outerAbort();
      else options.signal.addEventListener("abort", outerAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      pingController.abort();
    }, timeoutMs);
    timer.unref?.();
    try {
      const ping = await spawnSubagent("preflight", "Reply with the single word: pong", {
        agents: preflightAgents,
        cwd: options.cwd,
        allowLocalModel: options.allowLocalModel,
        signal: pingController.signal,
        // Suppress per-spawn progress so preflight lines can never be
        // mistaken for model-routing attestation evidence
        // ("Subagent X: using ...") in the final report.
        onProgress: undefined,
        modelOverride: { model: route.model, provider: route.provider },
      });
      results.push({
        roles: route.roles,
        provider: route.provider,
        model: route.model,
        ok: true,
        durationMs: Date.now() - startedAt,
      });
      options.onProgress?.(`Preflight ping: ${label} healthy (${Date.now() - startedAt}ms, ${ping.events} event(s)).`);
    } catch (err) {
      if (options.signal?.aborted && !timedOut) {
        throw new Error(`PREFLIGHT ABORTED while checking ${label}.`);
      }
      const raw = timedOut
        ? `PREFLIGHT_TIMEOUT: ${label} timed out after ${timeoutMs}ms`
        : String(err);
      const error = parseProviderError(raw, route.provider, route.model);
      results.push({
        roles: route.roles,
        provider: route.provider,
        model: route.model,
        ok: false,
        durationMs: Date.now() - startedAt,
        error,
      });
      options.onProgress?.(`Preflight ping FAILED: ${formatProviderError(error)}`);
    } finally {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", outerAbort);
    }
  }

  return results;
}

// ── runBoundedPool ─────────────────────────────────────────────────────────

/**
 * Run a bounded pool of concurrent workers over an array of items.
 *
 * Role-agnostic: takes any items and any worker function. By itself
 * it does NOT enforce a spawn ceiling — the caller should use a
 * SpawnGuard to bound resource usage.
 */
export async function runBoundedPool<T, R>(
  items: T[],
  concurrency: number,
  outerSignal: AbortSignal | undefined,
  worker: (item: T, index: number, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const controller = new AbortController();
  let nextIndex = 0;
  let firstError: unknown;

  const abortSiblings = (error?: unknown) => {
    if (error !== undefined && firstError === undefined) firstError = error;
    if (!controller.signal.aborted) controller.abort();
  };

  const outerAbortHandler = () => abortSiblings(new Error("Orchestration aborted."));
  if (outerSignal) {
    if (outerSignal.aborted) outerAbortHandler();
    else outerSignal.addEventListener("abort", outerAbortHandler, { once: true });
  }

  const workerCount = Math.min(concurrency, items.length);
  const runners = Array.from({ length: workerCount }, async () => {
    while (!controller.signal.aborted) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index, controller.signal);
      } catch (error) {
        abortSiblings(error);
        return;
      }
    }
  });

  try {
    await Promise.allSettled(runners);
  } finally {
    if (outerSignal) outerSignal.removeEventListener("abort", outerAbortHandler);
  }

  if (firstError !== undefined) throw firstError;
  throwIfAborted(outerSignal);
  return results;
}

// ── buildExecutionWaves ────────────────────────────────────────────────────

/**
 * Build a topological wave schedule from items with `id` and `dependsOn`.
 *
 * Returns an array of waves where each wave is an array of items whose
 * dependencies have all been satisfied by previous waves. Items in the
 * same wave are independent and can run concurrently.
 *
 * Throws on duplicate IDs, missing dependencies, or dependency cycles.
 *
 * This is role-agnostic — it only knows about `id` and `dependsOn` fields.
 */
export function buildExecutionWaves<T extends { id: string; dependsOn: string[] }>(
  items: T[],
): T[][] {
  const itemById = new Map<string, T>();
  for (const [index, item] of items.entries()) {
    if (!item.id.trim()) throw new Error(`Item at index ${index} has an empty id.`);
    if (itemById.has(item.id)) throw new Error(`Duplicate item id: ${item.id}`);
    itemById.set(item.id, item);
  }

  for (const item of items) {
    for (const dependencyId of item.dependsOn) {
      if (!itemById.has(dependencyId)) {
        throw new Error(`Item ${item.id} depends on unknown id: ${dependencyId}`);
      }
    }
  }

  const completed = new Set<string>();
  const remaining = new Map(items.map((item) => [item.id, new Set(item.dependsOn)]));
  const waves: T[][] = [];

  while (remaining.size > 0) {
    const readyIds = [...remaining.entries()]
      .filter(([, dependencies]) =>
        [...dependencies].every((dependencyId) => completed.has(dependencyId)),
      )
      .map(([id]) => id);

    if (readyIds.length === 0) {
      throw new Error(
        `Dependency cycle detected among item ids: ${[...remaining.keys()].join(", ")}`,
      );
    }

    const wave = readyIds.map((id) => itemById.get(id)!);
    waves.push(wave);
    for (const id of readyIds) {
      remaining.delete(id);
      completed.add(id);
    }
  }

  return waves;
}

// ── runWorkGraph ───────────────────────────────────────────────────────────

/**
 * Run a work graph (array of waves) through a bounded pool.
 *
 * Each wave runs to completion (with bounded concurrency) before the next
 * wave begins. Between waves, the abort signal is checked so a long-running
 * graph can be cancelled cooperatively.
 *
 * This is role-agnostic: it takes waves and a worker, and does not know
 * what the items represent or what the worker produces.
 */
export async function runWorkGraph<T, R>(
  waves: T[][],
  concurrency: number,
  signal: AbortSignal | undefined,
  worker: (item: T, index: number, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const outputs: R[] = [];
  for (const [waveIndex, wave] of waves.entries()) {
    throwIfAborted(signal);
    const waveOutputs = await runBoundedPool(wave, concurrency, signal, async (task, index, workerSignal) => {
      return worker(task, index, workerSignal);
    });
    outputs.push(...waveOutputs);
    if (waveIndex < waves.length - 1) throwIfAborted(signal);
  }
  return outputs;
}

// ── Utility helpers (internal plumbing) ────────────────────────────────────

interface ResolvedPiCommand {
  command: string;
  argsPrefix: string[];
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  launchRuntime?: string;
}

function buildSubagentSystemPrompt(profile: AgentProfile): string {
  const parts = [
    `You are the isolated Pi subagent named ${profile.name}.`,
    profile.description ? `Description: ${profile.description}` : "",
    profile.agencyLevel !== undefined ? `Agency level: ${profile.agencyLevel}` : "",
    "You receive only the task in the user prompt. Do not assume access to parent conversation history.",
    "Do not call or request a shared blackboard. Return a final concise assistant response for the orchestrator.",
    "Do not invoke the orchestrate tool or spawn additional orchestrations.",
    profile.systemPrompt ?? "",
  ];
  return parts.filter(Boolean).join("\n\n");
}

function describeJsonEvent(agentName: string, event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const raw = event as Record<string, unknown>;
  const eventType = optionalString(raw.type);
  const assistantEvent =
    raw.assistantMessageEvent && typeof raw.assistantMessageEvent === "object"
      ? (raw.assistantMessageEvent as Record<string, unknown>)
      : undefined;
  const innerType = optionalString(assistantEvent?.type) ?? eventType;

  if (innerType === "tool_call_start") {
    const toolName =
      optionalString(assistantEvent?.toolName) ?? optionalString(raw.toolName) ?? "unknown-tool";
    return `Subagent ${agentName}: tool call started (${toolName})`;
  }
  if (eventType === "tool_execution_start") {
    const toolName = optionalString(raw.toolName) ?? "unknown-tool";
    return `Subagent ${agentName}: executing tool ${toolName}`;
  }
  if (eventType === "tool_execution_end") {
    const toolName = optionalString(raw.toolName) ?? "unknown-tool";
    return `Subagent ${agentName}: tool ${toolName} finished`;
  }
  if (eventType === "message_start") return `Subagent ${agentName}: assistant response started`;
  if (eventType === "message_end") return `Subagent ${agentName}: assistant response finished`;
  if (eventType === "agent_end") return `Subagent ${agentName}: process agent_end received`;
  return null;
}

function extractMessageText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && (part as Record<string, unknown>).type === "text") {
        return String((part as Record<string, unknown>).text ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function resolvePiCommand(): ResolvedPiCommand {
  const envPath = process.env.PI_CLI_PATH?.trim();
  if (envPath) return resolvePiCliPath(envPath, "PI_CLI_PATH");

  const envCommand = process.env.PI_CLI?.trim();
  if (envCommand)
    return { command: envCommand, argsPrefix: [], shell: shouldUseWindowsShell(envCommand) };

  const currentCliScript = process.argv[1];
  if (currentCliScript && isExistingPiCliScript(currentCliScript)) {
    return resolvePiChildCommand(currentCliScript, "process.argv[1]");
  }

  const cliScript = process.argv.find((arg) => isExistingPiCliScript(arg));
  if (cliScript) return resolvePiChildCommand(cliScript, "process.argv");

  const installedCliScript = resolveInstalledPiCliScript();
  if (installedCliScript) return resolvePiChildCommand(installedCliScript, "installed Pi CLI");

  return process.platform === "win32"
    ? { command: "pi.cmd", argsPrefix: [], shell: true }
    : { command: "pi", argsPrefix: [] };
}

function resolvePiCliPath(cliPath: string, envName: string): ResolvedPiCommand {
  if (!existsSync(cliPath))
    throw new Error(`${envName} points to a missing Pi CLI path: ${cliPath}`);
  const ext = path.extname(cliPath).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs")
    return resolvePiChildCommand(cliPath, envName);
  return { command: cliPath, argsPrefix: [], shell: shouldUseWindowsShell(cliPath), launchRuntime: shouldUseWindowsShell(cliPath) ? "shell" : "native" };
}

function shouldUseWindowsShell(command: string): boolean | undefined {
  if (process.platform !== "win32") return undefined;
  return /\.(cmd|bat)(?:$|\s)/i.test(command) ? true : undefined;
}

function isExistingPiCliScript(candidate: string): boolean {
  return (
    /pi-coding-agent[\\/]dist[\\/](main|cli)\.js$/.test(candidate) && existsSync(candidate)
  );
}

function resolveInstalledPiCliScript(): string | null {
  const candidates = [
    process.env.APPDATA
      ? path.join(
          process.env.APPDATA,
          "npm",
          "node_modules",
          "@earendil-works",
          "pi-coding-agent",
          "dist",
          "cli.js",
        )
      : "",
    path.join(
      os.homedir(),
      ".npm-global",
      "lib",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    ),
    path.join(
      os.homedir(),
      ".nvm",
      "versions",
      "node",
      "current",
      "lib",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    ),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Format a provider/model pair for display/logging.
 * Also exported so shapes can use it for progress messages.
 */
export function formatRoutedModel(provider?: string, model?: string): string {
  if (provider && model) return `${provider}/${model}`;
  if (model) return model;
  if (provider) return `${provider}/default`;
  return "Pi default provider/model";
}

function rejectLocalModelIfNeeded(profile: AgentProfile, allowLocalModel: boolean) {
  if (allowLocalModel) return;
  const combined = `${profile.provider ?? ""} ${profile.model ?? ""}`.toLowerCase();
  if (/\b(local|ollama|lmstudio|llama\.cpp|kobold|text-generation-webui)\b/.test(combined)) {
    throw new Error(
      `Agent ${profile.name} appears to target a local model (${profile.provider ?? ""}/${profile.model ?? ""}). Set allowLocalModel=true to permit it.`,
    );
  }
}

async function mkTempDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `pi-orchestrator-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

function safeFileName(name: string): string {
  return name.replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 80) || "agent";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function truncateWithNotice(text: string, max: number, label: string): string {
  if (text.length <= max) return text;
  const notice = `\n\n_(${label} truncated: ${text.length - max} additional characters omitted.)_`;
  return `${text.slice(0, Math.max(0, max - notice.length))}${notice}`;
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Orchestration aborted.");
}
