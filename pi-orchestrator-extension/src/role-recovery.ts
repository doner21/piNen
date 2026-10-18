import { createHash } from "node:crypto";
import { mergeCommandTimes } from "./command-times";
import type { SubagentResult } from "./substrate";
import {
  captureContentSignatureSnapshot, diffContentSignatureSnapshots,
  captureExternalEvidenceSnapshot, diffExternalEvidenceSnapshots,
} from "./write-set";
import { HostPublicationObservation, withHostPublicationObservation } from "./host-publications";

export type RecoverableRole = "planner" | "verifier";
export type RoleRecoveryStage = "initial" | "continuation" | "shard" | "replan" | "synthesis";
export interface RoleRecoveryStep {
  stage: RoleRecoveryStage;
  scope: string[];
  outcome: "complete" | "context_exhausted" | "capacity_refused" | "invalid_terminal";
  /** Partial worker results are never terminal role results/checkpoints. */
  result?: SubagentResult;
}
export interface RoleRecoveryEvidence {
  role: RecoverableRole;
  terminalValidated: true;
  sourceOptions: RoleRecoveryOptions;
  steps: RoleRecoveryStep[];
}
export interface RoleRecoveryOptions {
  /** A work-count bound, not a clock or an enlarged token reserve. */
  maxWorkers: number;
  allowContinuation: boolean;
  allowSplit: boolean;
  allowReplan: boolean;
}
export interface RoleRecoveryRequest {
  role: RecoverableRole;
  originalPrompt: string;
  criteria: Array<{ id: string; text: string }>;
  acceptanceCriteria: string[];
  sourceOptions: RoleRecoveryOptions;
  /** Only host-generated evidence slots may be partitioned. Binding text stays. */
  slots: Array<{ start: number; end: number; items: unknown[]; shared: unknown[] }>;
  verifyOnly: boolean;
}

/** Only definitive provider/protocol exhaustion triggers substantive recovery.
 * Ordinary prose mentioning capacity, product failures and refusals do not. */
export function isRoleContextExhaustion(stopReason: unknown, errorMessage?: unknown): boolean {
  if (typeof stopReason === "string" && /^(?:length|max_tokens|context_length|context_exhausted)$/i.test(stopReason)) return true;
  return typeof errorMessage === "string" && /(?:context (?:window|length|limit).*(?:exceed|exhaust)|maximum context length|prompt is too long|too many tokens|context_length_exceeded)/i.test(errorMessage);
}

export class RoleContextExhaustionError extends Error {
  readonly candidate: SubagentResult;
  constructor(candidate: SubagentResult) {
    super("ROLE_CONTEXT_EXHAUSTED: settled worker needs substantive continuation, splitting or planning.");
    this.name = "RoleContextExhaustionError";
    this.candidate = { ...candidate, contextExhaustionSignal: true, truncated: true };
  }
}
export class RoleRecoveryExhaustedError extends Error {
  readonly roleRecovery: { role: RecoverableRole; sourceOptions: RoleRecoveryOptions; steps: RoleRecoveryStep[] };
  constructor(request: RoleRecoveryRequest, steps: RoleRecoveryStep[], reason: string) {
    super(`ROLE_RECOVERY_EXHAUSTED: ${request.role}: ${reason}. Completed executors are retained; no partial verdict/plan is terminal.`);
    this.name = "RoleRecoveryExhaustedError";
    this.roleRecovery = { role: request.role, sourceOptions: request.sourceOptions, steps: [...steps] };
  }
}

/** Locate a complete JSON value, without EOF repair or semantic reconstruction. */
function jsonValue(text: string, start: number): { value: unknown; start: number; end: number } | undefined {
  while (/\s/.test(text[start] ?? "") && start < text.length) start++;
  if (text[start] !== "{" && text[start] !== "[") return undefined;
  let quoted = false, escaped = false;
  const stack: string[] = [];
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') { quoted = true; continue; }
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      if (stack.pop() !== (char === "}" ? "{" : "[")) return undefined;
      if (stack.length === 0) {
        try { return { value: JSON.parse(text.slice(start, index + 1)), start, end: index + 1 }; } catch { return undefined; }
      }
    }
  }
  return undefined;
}
function evidenceFragments(values: unknown[]): { items: unknown[]; shared: unknown[] } {
  const items: unknown[] = [], shared: unknown[] = [];
  for (const [outputIndex, value] of values.entries()) {
    const item = record(value), key = item?.actionEvidence ? "actionEvidence" : "ledger";
    const ledger = record(item?.[key]);
    // Zero/one-record outputs remain independently partitionable units. Moving
    // their entire (possibly large) output into shared metadata would make a
    // multi-output prompt inseparable even though no ledger split is needed.
    if (!item || !ledger || !Array.isArray(ledger.entries) || ledger.entries.length < 2) { items.push(value); continue; }
    const { entries, ...ledgerMetadata } = ledger;
    // Snapshots, timing, output and ledger metadata are shared ONCE, not spread
    // into every command. Records retain a stable reference to that metadata.
    shared.push({ ...item, [key]: { ...ledgerMetadata, entries: [] }, recoveryOutputIndex: outputIndex });
    for (const [entryIndex, entry] of entries.entries()) {
      items.push({ recoveryOutputIndex: outputIndex, taskId: item.taskId, entryIndex, [key]: { entries: [entry] } });
    }
  }
  return { items, shared };
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function parseResult(text: string): Record<string, unknown> | undefined {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  const parsed = jsonValue(unfenced, 0);
  return parsed && !unfenced.slice(parsed.end).trim() ? record(parsed.value) : undefined;
}

/** Build recovery from the actual role prompt. Slots are recognized only after
 * its complete intake/binding JSON, and only for the host's output/ledger JSON
 * fields. Owner-authored delimiter-looking text inside that JSON cannot become
 * a removable slot. Unknown prompts remain intact (safe refusal if too large). */
export function createRoleRecoveryRequest(input: {
  role: RecoverableRole; prompt: string; acceptanceCriteria?: string[];
  verifyOnly?: boolean; allowReplan?: boolean; options?: Partial<RoleRecoveryOptions>;
}): RoleRecoveryRequest {
  const bindingMarker = "BINDING OWNER INSTRUCTIONS, SAFETY, AND ACCEPTANCE — COMPLETE AND VERBATIM WHERE APPLICABLE:\n";
  const intakeMarker = "INTAKE CONTRACT:\n";
  const marker = input.prompt.startsWith(bindingMarker) ? bindingMarker : intakeMarker;
  const hostPrompt = input.prompt.startsWith(bindingMarker)
    || input.prompt.startsWith("Plan the following task for executor subagents.")
    || input.prompt.startsWith("Verify the orchestration result against the intake contract.");
  const position = hostPrompt && !input.verifyOnly ? input.prompt.indexOf(marker) : -1;
  const binding = position >= 0 ? jsonValue(input.prompt, position + marker.length) : undefined;
  const bound = record(binding?.value);
  const acceptanceCriteria = [...(input.acceptanceCriteria ?? (Array.isArray(bound?.success_criteria) ? bound.success_criteria.filter((v): v is string => typeof v === "string") : []))];
  let criteria = acceptanceCriteria.map((text, index) => ({ id: `RC-${index + 1}`, text }));
  const afterBinding = input.verifyOnly ? input.prompt.length : binding?.end ?? input.prompt.length;
  const missionIndex = input.prompt.indexOf("\nMission: ", afterBinding);
  const mission = missionIndex >= 0 ? record(jsonValue(input.prompt, missionIndex + "\nMission: ".length)?.value) : undefined;
  if (Array.isArray(mission?.acceptanceCriteria)) {
    criteria = mission.acceptanceCriteria.map(record).filter((v): v is Record<string, unknown> => Boolean(v)).map(v => ({ id: String(v.id), text: String(v.text ?? "") }));
  }
  if (input.verifyOnly) {
    const checklist = input.prompt.split("EVIDENCE CHECKLIST (verbatim from the caller — treat each enumerable item as a check):\n")[1]?.split("\n\nInstructions:\n")[0] ?? input.prompt;
    const enumerated = checklist.split(/\r?\n/).filter(line => /^\s*(?:\d+[.)]|[-*])\s+\S/.test(line));
    criteria = (enumerated.length ? enumerated : [checklist]).map((text, index) => ({ id: `check-${index + 1}`, text }));
  }
  if (!criteria.length) criteria = [{ id: "RC-1", text: "Verify the complete original task and every owner acceptance requirement." }];
  const slots: RoleRecoveryRequest["slots"] = [];
  // Array-valued evidence fields are the only scope reduction. No prompt
  // substrings, instruction truncation, JSON repair or reserve tuning occurs.
  for (const label of ["\n\nExecutor outputs:\n", "\nExecutor outputs: ", "\nROLE_RECOVERY_PLANNING_CONTEXT:\n"]) {
    const at = input.prompt.indexOf(label, afterBinding);
    const slot = at >= 0 ? jsonValue(input.prompt, at + label.length) : undefined;
    if (slot && Array.isArray(slot.value)) slots.push({ start: slot.start, end: slot.end, ...evidenceFragments(slot.value) });
  }
  const ledgerLabel = "HOST-OWNED ACTION EVIDENCE AUTHORITY:";
  const ledgerAt = input.prompt.indexOf(ledgerLabel, slots[0]?.end ?? afterBinding);
  if (ledgerAt >= 0) {
    // The host writes its ledger after its authority paragraph. Parse the first
    // complete array after that paragraph, not command strings within outputs.
    const at = input.prompt.indexOf("\n[", ledgerAt);
    const slot = at >= 0 ? jsonValue(input.prompt, at + 1) : undefined;
    if (slot && Array.isArray(slot.value)) slots.push({ start: slot.start, end: slot.end, ...evidenceFragments(slot.value) });
  }
  return {
    role: input.role, originalPrompt: input.prompt, criteria, acceptanceCriteria,
    verifyOnly: input.verifyOnly === true, slots,
    sourceOptions: {
      maxWorkers: Number.isFinite(input.options?.maxWorkers ?? 8) ? Math.max(1, Math.min(8, Math.trunc(input.options?.maxWorkers ?? 8))) : 8,
      allowContinuation: input.options?.allowContinuation !== false,
      allowSplit: input.options?.allowSplit !== false,
      allowReplan: input.verifyOnly !== true && input.allowReplan !== false && input.options?.allowReplan !== false,
    },
  };
}

/** Every recovery worker retains the original instruction-bearing prompt.
 * Evidence is partitioned structurally, never summarized to admit a launch. */
function scopedPrompt(request: RoleRecoveryRequest, indexes: number[] | undefined): string {
  if (indexes === undefined) return request.originalPrompt;
  let prompt = request.originalPrompt;
  for (const slot of [...request.slots].sort((a, b) => b.start - a.start)) {
    const selected = [...slot.shared, ...indexes.filter(index => index < slot.items.length).map(index => slot.items[index])];
    prompt = prompt.slice(0, slot.start) + JSON.stringify(selected) + prompt.slice(slot.end);
  }
  return prompt;
}

export function isRoleRecoveryHandoff(text: string, role: RecoverableRole): boolean {
  const parsed = parseResult(text), handoff = record(parsed?.roleRecoveryHandoff);
  return Boolean(handoff && handoff.role === role && Array.isArray(handoff.remaining) && handoff.remaining.length
    && handoff.remaining.every(value => typeof value === "string" && value.trim())
    && Array.isArray(handoff.completed) && handoff.completed.every(value => typeof value === "string"));
}

function terminalIssues(request: RoleRecoveryRequest, result: SubagentResult): string[] {
  if (result.exitCode !== 0 || result.truncated || result.contextExhaustionSignal) return ["worker is incomplete"];
  const parsed = parseResult(result.text);
  if (!parsed) return ["terminal output is not complete JSON"];
  if (request.role === "planner") {
    if (JSON.stringify(parsed.acceptance_criteria ?? parsed.acceptanceCriteria) !== JSON.stringify(request.acceptanceCriteria)) return ["recovered plan changed or omitted frozen acceptance criteria"];
    if (!Array.isArray(parsed.tasks) || !parsed.tasks.length) return ["recovered plan has no tasks"];
    const tasks = parsed.tasks.map(record);
    if (tasks.some(task => !task || typeof task.id !== "string" || !task.id.trim() || task.id !== task.id.trim() || typeof task.description !== "string" || !task.description.trim() || !Array.isArray(task.dependsOn))) return ["recovered plan contains invalid tasks"];
    const ids = tasks.map(task => String(task!.id));
    if (new Set(ids).size !== ids.length) return ["recovered plan repeats task IDs"];
    const done = new Set<string>();
    for (let round = 0; round < tasks.length; round++) for (const task of tasks) {
      if ((task!.dependsOn as unknown[]).every(id => typeof id === "string" && done.has(id))) done.add(String(task!.id));
    }
    return done.size === tasks.length ? [] : ["recovered plan has unknown dependencies or a cycle"];
  }
  const status = request.verifyOnly ? parsed.overall : parsed.status;
  if (status !== "pass" && status !== "fail") return ["verifier omitted terminal status"];
  const findings = request.verifyOnly ? parsed.checks : parsed.criterionFindings;
  if (!Array.isArray(findings) || findings.length !== request.criteria.length) return ["verifier omitted or duplicated required findings"];
  const ids = new Set<string>();
  for (const value of findings) {
    const finding = record(value), id = String(request.verifyOnly ? finding?.id : finding?.criterionId);
    if (!finding || ids.has(id) || !request.criteria.some(c => c.id === id) || (finding.status !== "pass" && finding.status !== "fail")) return ["invalid or unknown required finding"];
    ids.add(id);
    const evidence = request.verifyOnly ? finding.citations : finding.evidence;
    if (!Array.isArray(evidence) || !evidence.length || evidence.some(value => request.verifyOnly ? typeof value !== "string" || !value.trim() : !record(value) || typeof record(value)!.observed !== "string" || !String(record(value)!.observed).trim())) return ["required finding has no concrete evidence"];
    if (status === "pass" && finding.status !== "pass") return ["PASS contradicts a failed finding"];
  }
  return Array.isArray(parsed.reasons) && parsed.reasons.every(value => typeof value === "string") ? [] : ["verifier omitted reasons array"];
}

/** Observe each worker, including rejected/exhausted workers, so a later shard
 * cannot restore an earlier mutation and launder the recovery into a PASS.
 * Host publications are attributed by actual byte transitions, not filenames.
 * Existing outer batch observations keep receiving the same publications. */
export async function observeRoleReadOnlyLaunch<T>(cwd: string, evidenceRoots: string[], operation: () => Promise<T>, allowBuildOutputs = false): Promise<T> {
  const exhaustive = { maxFiles: Number.MAX_SAFE_INTEGER, maxTotalBytes: Number.MAX_SAFE_INTEGER, maxFileBytes: Number.MAX_SAFE_INTEGER, excludeDirectories: [] };
  const before = captureContentSignatureSnapshot(cwd, exhaustive), externalBefore = captureExternalEvidenceSnapshot(evidenceRoots);
  const host = new HostPublicationObservation(cwd);
  return withHostPublicationObservation(host, async () => {
    try { return await operation(); }
    finally {
      // Keep membership live until the gate takes its final snapshot. Closing the
      // scope first leaves a microtask gap in which an active sibling can publish
      // authentic bytes that this still-pending gate would wrongly reject.
      const after = captureContentSignatureSnapshot(cwd, exhaustive), externalAfter = captureExternalEvidenceSnapshot(evidenceRoots);
      const admitted = host.admittedPaths(before, after);
      // Visible-main's existing gate admits only the Vite tool cache. Only the
      // standalone verify-only contract also tolerates these build outputs.
      const cachePrefixes = ["node_modules/.vite/", ...(allowBuildOutputs ? ["dist/", "out/", "build/", "coverage/", ".cache/", ".next/", "node_modules/.cache/"] : [])];
      const changes = diffContentSignatureSnapshots(before, after).filter(change => !admitted.has(change.path)
        && !cachePrefixes.some(prefix => change.path.replaceAll("\\", "/").toLowerCase().startsWith(prefix)));
      if (changes.length || before.truncated || after.truncated || JSON.stringify(before.omitted) !== JSON.stringify(after.omitted)
        || diffExternalEvidenceSnapshots(externalBefore, externalAfter).length || externalBefore.unobservableRoots.length || externalAfter.unobservableRoots.length) {
        throw new Error(`ROLE_RECOVERY_INTEGRITY: read-only worker changed workspace/evidence or observation was unavailable: ${changes.map(change => change.path).join(", ")}`);
      }
    }
  });
}

/** Shared, bounded role recovery. Launch callbacks remain the real configured
 * launchers: they own admission, spawn ceilings, watcher/guard and settlement.
 * Planning reshapes only this role's remaining inspection scopes; it never
 * creates executor tasks, changes routes/criteria or re-runs completed work. */
export async function runRoleWithRecovery(request: RoleRecoveryRequest, callbacks: {
  launch: (prompt: string, stage: RoleRecoveryStage, index: number) => Promise<SubagentResult>;
  launchPlanner?: (prompt: string, stage: RoleRecoveryStage, index: number) => Promise<SubagentResult>;
  signal?: AbortSignal;
  /** Advisory check only; the launcher's monotonic reserve remains authority. */
  canLaunch?: () => boolean;
  onProgress?: (text: string) => void;
}): Promise<SubagentResult> {
  const steps: RoleRecoveryStep[] = [];
  let attempts = 0;
  let parentPromptBytes = Buffer.byteLength(request.originalPrompt, "utf8");
  let fixedRoute: { provider?: string; model?: string; agentName: string } | undefined;
  const fail = (reason: string): never => { throw new RoleRecoveryExhaustedError(request, steps, reason); };
  const attempt = async (prompt: string, stage: RoleRecoveryStage, scope: string[], planner = false): Promise<SubagentResult | undefined> => {
    if (callbacks.signal?.aborted) throw new Error("Role recovery stopped after settled worker: run is paused/cancelled.");
    if (attempts >= request.sourceOptions.maxWorkers) return fail("bounded worker recovery budget exhausted");
    if (callbacks.canLaunch && !callbacks.canLaunch()) return fail("configured spawn guard has no remaining role-worker capacity");
    const index = attempts++;
    callbacks.onProgress?.(`${request.role} recovery: ${stage} (${attempts}/${request.sourceOptions.maxWorkers}), scope ${scope.join(", ") || "complete role"}.`);
    try {
      const result = await (planner ? callbacks.launchPlanner! : callbacks.launch)(prompt, stage, index);
      if (!planner) {
        const route = { provider: result.provider, model: result.model, agentName: result.agentName };
        if (fixedRoute && JSON.stringify(fixedRoute) !== JSON.stringify(route)) return fail("configured role route changed during recovery");
        fixedRoute = route;
      }
      if (result.contextExhaustionSignal || result.truncated || isRoleRecoveryHandoff(result.text, request.role)) throw new RoleContextExhaustionError(result);
      steps.push({ stage, scope, outcome: "complete", result });
      if (callbacks.signal?.aborted) throw new Error("Role recovery stopped after settled worker: run is paused/cancelled.");
      return result;
    } catch (error) {
      if (error instanceof RoleContextExhaustionError) {
        if (stage === "initial" || stage === "continuation") parentPromptBytes = Buffer.byteLength(prompt, "utf8");
        if (!planner) {
          const route = { provider: error.candidate.provider, model: error.candidate.model, agentName: error.candidate.agentName };
          if (fixedRoute && JSON.stringify(fixedRoute) !== JSON.stringify(route)) return fail("configured role route changed during exhaustion");
          fixedRoute = route;
        }
        steps.push({ stage, scope, outcome: "context_exhausted", result: error.candidate });
        return undefined;
      }
      if (error instanceof Error && /^(?:Subagent ceiling exceeded|Substrate spawn ceiling exceeded)/.test(error.message)) return fail("configured spawn guard refused another role worker");
      if (error instanceof Error && error.message.startsWith("BINDING_PROMPT_CAPACITY_REFUSED:")) {
        if (stage === "initial" || stage === "continuation") parentPromptBytes = Buffer.byteLength(prompt, "utf8");
        steps.push({ stage, scope, outcome: "capacity_refused" });
        return undefined;
      }
      throw error;
    }
  };
  const finish = (result: SubagentResult): SubagentResult | undefined => {
    const issues = terminalIssues(request, result);
    if (issues.length) { steps[steps.length - 1].outcome = "invalid_terminal"; return undefined; }
    // A synthesis cannot erase an explicitly failed shard's real findings.
    const shardFailed = steps.some(step => step.stage === "shard" && (parseResult(step.result?.text ?? "")?.status === "fail" || parseResult(step.result?.text ?? "")?.overall === "fail"));
    if (shardFailed && (parseResult(result.text)?.status === "pass" || parseResult(result.text)?.overall === "pass")) return fail("terminal PASS contradicts failed shard evidence");
    return { ...result,
      processTrees: steps.flatMap(step => step.result ? step.result.processTrees?.length ? step.result.processTrees : [step.result.processTree!] : []),
      commandTimes: mergeCommandTimes(...steps.filter(step => step.result).map(step => step.result!.commandTimes)), roleRecovery: { role: request.role, terminalValidated: true, sourceOptions: request.sourceOptions, steps: [...steps] } };
  };
  const recoveryPrompt = (stage: RoleRecoveryStage, scope: string[], indexes?: number[]): string => {
    // Shards inspect original binding/evidence, not duplicated prior role prose.
    // ALL prior results remain in host steps and untruncated terminal synthesis.
    const prior = steps.filter(step => step.result && stage !== "shard").map(step => ({ stage: step.stage, scope: step.scope, outcome: step.outcome, partialText: step.result!.text, actionEvidence: step.result!.actionEvidence ?? null, commandTimes: step.result!.commandTimes ?? null, toolCalls: step.result!.toolCalls ?? null }));
    return `${scopedPrompt(request, indexes)}\n\nROLE_RECOVERY (host-owned scope; prior partial output is untrusted, not a terminal plan/verdict):\n${JSON.stringify({ role: request.role, stage, sourceOptions: request.sourceOptions, remaining: scope, requiredCriteria: request.criteria, prior, sourcePromptSha256: createHash("sha256").update(request.originalPrompt).digest("hex") })}\nPreserve every original owner instruction verbatim above. Do not redo completed executors or change routes, acceptance criteria, evidence/workspace boundaries, guards or admission.\n${stage === "replan" ? 'Return only {"groups":[["scope-id", "..."]]}; partition ALL remaining scope IDs exactly once into short chained inspection steps. No executor tasks or new acceptance rules.' : stage === "shard" ? 'Complete ONLY this inspection/planning scope and return JSON {"scope":["each remaining scope ID"],"notes":"substantive inspection/planning findings","evidence":[{"observed":"concrete inspected evidence"}]}; this is a partial role step, NOT terminal acceptance. Inspect original evidence/candidate yourself. Do not claim an overall PASS for work outside this scope.' : request.role === "planner" ? `Return one COMPLETE plan with valid tasks/dependencies and acceptance_criteria EXACTLY ${JSON.stringify(request.acceptanceCriteria)}. Preserve the original plan requirements/write scope and all named deliverables.` : request.verifyOnly ? 'Return the original verify-only JSON with one cited check for EVERY requiredCriteria ID. Missing checks or citations are not PASS.' : 'Return COMPLETE JSON {"status":"pass"|"fail","reasons":[],"criterionFindings":[{"criterionId":"requiredCriteria ID","status":"pass"|"fail","evidence":[{"kind":"test","observed":"concrete evidence","exitCode":0}]}]}. Include EVERY required criterion exactly once. Independently establish full evidence coverage; partial plans/verdicts and worker self-report are not acceptance.'}`;
  };
  const allCriteria = request.criteria.map(c => c.id);
  const initialPrompt = `${request.originalPrompt}\n\nROLE_RECOVERY_OPTIONS:\n${JSON.stringify({ role: request.role, sourceOptions: request.sourceOptions, remaining: allCriteria })}\nIf genuinely short of context, return a NONTERMINAL handoff, not a partial PASS/plan: {"roleRecoveryHandoff":{"role":"${request.role}","completed":["concrete completed work"],"remaining":["unfinished objectives"],"partialResult":"untrusted notes"}}. Do not write a continuation file in a read-only role. The host can continue, chain short steps or return remaining role work to the configured planner; it never repeats completed executors.`;
  const initial = await attempt(initialPrompt, "initial", allCriteria);
  if (initial) {
    if (!initial.recoveredAssistantFailures?.includes("role_context_exhaustion_auto_recovered")) return initial;
    // Pi can compact/retry inside one worker after agent_end. Such a result is
    // still recovered work: require the same complete plan/findings before it
    // becomes a terminal checkpoint, without launching an unnecessary worker.
    const terminal = finish(initial);
    if (terminal) return terminal;
  }
  const sourceFailure = steps[0].outcome;
  if (sourceFailure !== "capacity_refused" && request.sourceOptions.allowContinuation) {
    const continuation = await attempt(recoveryPrompt("continuation", allCriteria), "continuation", allCriteria);
    if (continuation) { const terminal = finish(continuation); if (terminal) return terminal; }
  }
  if (!request.sourceOptions.allowSplit) return fail("continuation did not yield a complete role result; splitting disabled");
  const unitCount = Math.max(0, ...request.slots.map(slot => slot.items.length));
  const scopes = unitCount > 1 ? Array.from({ length: unitCount }, (_, index) => `evidence-${index + 1}`) : allCriteria;
  if (sourceFailure === "capacity_refused" && unitCount < 2) return fail("binding/inseparable prompt cannot safely fit; no separable evidence slots");
  const middle = Math.ceil(scopes.length / 2);
  let groups = scopes.length > 1 ? [scopes.slice(0, middle), scopes.slice(middle)] : [scopes];
  // A planner can reshape substantive exhausted work, but never invent a
  // planner route in verify-only. All configured callbacks retain their routes.
  if (sourceFailure !== "capacity_refused" && request.sourceOptions.allowReplan && callbacks.launchPlanner) {
    const replanned = await attempt(recoveryPrompt("replan", scopes, unitCount > 1 ? [] : undefined), "replan", scopes, true);
    const proposed = replanned && parseResult(replanned.text)?.groups;
    if (!Array.isArray(proposed) || proposed.some(group => !Array.isArray(group) || !group.length || group.some(id => typeof id !== "string"))) return fail("return-to-planning did not produce complete bounded inspection groups");
    const flattened = proposed.flat() as string[];
    if (flattened.length !== scopes.length || new Set(flattened).size !== scopes.length || flattened.some(id => !scopes.includes(id))) return fail("planner changed or omitted recovery scope");
    groups = proposed as string[][];
  }
  const parentSizes = new Map(groups.map(group => [group, parentPromptBytes]));
  for (const group of groups) {
    const indexes = unitCount > 1 ? group.map(id => scopes.indexOf(id)) : undefined;
    const prompt = recoveryPrompt("shard", group, indexes);
    const shrinks = Buffer.byteLength(prompt, "utf8") < parentSizes.get(group)!;
    // Refuse non-shrinking scopes before a launcher call. Shared metadata and
    // binding are inseparable; admission and spawn ceilings remain unchanged.
    const shard = shrinks ? await attempt(prompt, "shard", group) : undefined;
    if (!shard && (!shrinks || ["capacity_refused", "context_exhausted"].includes(steps[steps.length - 1].outcome)) && group.length > 1) {
      const offset = groups.indexOf(group), splitAt = Math.ceil(group.length / 2);
      const children = [group.slice(0, splitAt), group.slice(splitAt)];
      for (const child of children) parentSizes.set(child, Math.min(parentSizes.get(group)!, Buffer.byteLength(prompt, "utf8")));
      groups.splice(offset + 1, 0, ...children);
      continue;
    }
    const notes = shard && parseResult(shard.text);
    if (!shard || shard.exitCode !== 0 || !notes || JSON.stringify(notes.scope) !== JSON.stringify(group)
      || typeof notes.notes !== "string" || !notes.notes.trim() || !Array.isArray(notes.evidence) || !notes.evidence.length
      || notes.evidence.some(value => typeof record(value)?.observed !== "string" || !String(record(value)?.observed).trim())) return fail("chained scope did not settle with complete grounded inspection notes");
  }
  // Full original instructions plus ALL untruncated chained findings. The
  // original evidence arrays were inspected in the settled shards, not dropped
  // or replaced by executor self-report. Admission remains mandatory here.
  const synthesis = await attempt(recoveryPrompt("synthesis", allCriteria, unitCount > 1 ? [] : undefined), "synthesis", allCriteria);
  if (!synthesis) return fail("terminal synthesis cannot safely fit/finish on the configured role");
  return finish(synthesis) ?? fail("recovered plan/verdict failed complete criteria/dependency validation");
}
