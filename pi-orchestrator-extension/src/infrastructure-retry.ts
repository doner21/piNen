import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { atomicWriteJsonSync } from "./run-state";
import type { RetryPredecessorEvidence } from "./process-generation";

export interface InfrastructureRetryOptions {
  /** Stable original phase/task identity, not a continuation's prompt or spawn index. */
  identity?: string;
  file?: string;
  reserve: () => void;
}
/** One logical operation owns every predecessor, including mixed policy/auth
 * attempts. Consumption is committed only at the final synchronous spawn seam. */
export interface PolicyRetryBudget {
  used: boolean;
  consume: () => void;
  retain: (evidence: RetryPredecessorEvidence) => void;
  beforeDispatch: () => void;
  readonly predecessors: readonly RetryPredecessorEvidence[];
  resumePolicy?: OriginalPhaseEvidence;
}
export interface RetryRoute { provider: string; model: string; api?: string; baseUrl?: string; }
export interface OriginalPhaseEvidence { phaseResultFile?: string; phaseLogFile?: string; }
interface RetryState {
  version: 1;
  binding: string;
  status: "running" | "waiting" | "consumed" | "settled" | "failed";
  restoration: "unconfirmed" | "refused" | "confirmed";
  originalEvidence?: OriginalPhaseEvidence;
  policyRetryConsumed?: boolean;
  predecessors?: RetryPredecessorEvidence[];
  pendingPolicy?: boolean;
}

/** No worker claim, local expiry, file modification or elapsed time is proof.
 * Read ONLY an explicitly isolated store. Disable credential mutation and ambient
 * auth, then require a fresh successful no-tool response on the frozen route.
 * No provider error/response is persisted. No refresh owner is introduced. */
export async function confirmIsolatedRoute(route: RetryRoute): Promise<boolean> {
  try {
    const dir = process.env.PI_CODING_AGENT_DIR;
    if (!dir || !path.isAbsolute(dir) || /(?:^|[\\/])\.pi(?:[\\/]|$)/i.test(dir) || realpathSync(dir) !== path.resolve(dir)) return false;
    for (let p = dir;; p = path.dirname(p)) {
      if (lstatSync(p).isSymbolicLink()) return false;
      if (p === path.dirname(p)) break;
    }
    const file = path.join(dir, "auth.json"), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return false;
    const supplied = JSON.parse(readFileSync(file, "utf8"))[route.provider];
    // This operation does not renew OAuth. Explicit manual provisioning remains
    // necessary where no independent renewal owner exists.
    if (!supplied || supplied.type === "oauth" && (!Number.isFinite(supplied.expires) || supplied.expires <= Date.now() + 300_000)) return false;
    const apiKey = supplied.type === "oauth" ? supplied.access : supplied.type === "api_key" ? supplied.key : undefined;
    if (typeof apiKey !== "string" || !apiKey) return false;
    const runtime = await ModelRuntime.create({
      credentials: { read: async (provider: string) => provider === route.provider ? structuredClone(supplied) : undefined,
        list: async () => [{ providerId: route.provider, type: supplied.type }],
        delete: async () => { throw new Error("RESTORATION_PROBE_CANNOT_MUTATE"); },
        modify: async () => { throw new Error("RESTORATION_PROBE_CANNOT_RENEW"); } },
      modelsPath: path.join(dir, "models.json"), modelsStorePath: path.join(dir, "models-store.json"),
      allowModelNetwork: false, refreshOnCreate: false,
    });
    const model = runtime.getModel(route.provider, route.model);
    if (!model || model.provider !== route.provider || model.id !== route.model
      || route.api !== undefined && model.api !== route.api || route.baseUrl !== undefined && model.baseUrl !== route.baseUrl) return false;
    const challenge = randomBytes(16).toString("hex");
    const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: `Reply with exactly ${challenge}`, timestamp: Date.now() }] }, { apiKey, env: {}, maxRetries: 0 });
    return ["stop", "end_turn"].includes(result.stopReason) && !result.errorMessage
      && result.content.every(block => block.type !== "toolCall")
      && result.content.map(block => block.type === "text" ? block.text : "").join("").trim() === challenge;
  } catch { return false; }
}

/** One exclusive durable claim covers probe + consume + dispatch + settlement.
 * An abandoned claim is deliberately NOT stolen: uncertain dispatch cannot be
 * converted into another writer. A consumed record never resets on continuation.
 * The callback re-enters the ordinary launcher admission and permission checks. */
export async function withInfrastructureRetry<T>(input: {
  options?: InfrastructureRetryOptions;
  route: () => Promise<RetryRoute>;
  identity: string;
  originalEvidence?: OriginalPhaseEvidence;
  launch: (retry: boolean, evidence?: OriginalPhaseEvidence, policyRetry?: PolicyRetryBudget) => Promise<T>;
  eligible: (error: unknown) => boolean;
  refused: (attempted: boolean) => Error;
  assess: (evidence: readonly RetryPredecessorEvidence[]) => unknown;
  blocked: (error: unknown) => boolean;
}): Promise<T> {
  const options = input.options;
  if (!options?.file) {
    const predecessors: RetryPredecessorEvidence[] = [];
    const policyRetry: PolicyRetryBudget = { used: false, predecessors,
      retain: pin => { predecessors.push(structuredClone(pin)); },
      consume() { input.assess(predecessors); this.used = true; },
      beforeDispatch() { if (predecessors.length) input.assess(predecessors); } };
    return input.launch(false, undefined, policyRetry);
  }
  const file = options.file;
  const binding = createHash("sha256").update(options.identity ?? input.identity).digest("hex");
  const read = (): RetryState | undefined => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  let saved: RetryState | undefined;
  mkdirSync(path.dirname(file), { recursive: true });
  let fd: number | undefined;
  try {
    fd = openSync(file + ".lock", "wx", 0o600);
    saved = read();
    if (saved && (saved.version !== 1 || saved.binding !== binding)) throw new Error("INFRASTRUCTURE_RETRY_BINDING_CHANGED: dispatch refused.");
    if (saved && (saved.policyRetryConsumed !== undefined && typeof saved.policyRetryConsumed !== "boolean"
      || saved.pendingPolicy !== undefined && typeof saved.pendingPolicy !== "boolean"
      || saved.predecessors !== undefined && !Array.isArray(saved.predecessors))) throw new Error("POLICY_RETRY_STATE_UNKNOWN: dispatch refused.");
    if (saved && saved.status !== "waiting") throw new Error("INFRASTRUCTURE_RETRY_CONSUMED_OR_UNCERTAIN: preserve settled work; no dispatch and no new zero-tool claim.");
    const route = await input.route();
    const routeBinding = createHash("sha256").update(JSON.stringify(route)).digest("hex");
    const routeFile = file + ".route";
    if (existsSync(routeFile)) {
      if (readFileSync(routeFile, "utf8") !== routeBinding) throw new Error("INFRASTRUCTURE_RETRY_ROUTE_CHANGED: frozen route dispatch refused.");
    } else writeFileSync(routeFile, routeBinding, { flag: "wx", mode: 0o600 });
    // Continuations may have a different physical spawn count. The first claim,
    // not that count, owns all original and retry evidence paths. Old waiting
    // claims without evidence refuse rather than inventing a new phase.
    if (saved && input.originalEvidence && !saved.originalEvidence) throw new Error("INFRASTRUCTURE_ORIGINAL_EVIDENCE_UNKNOWN: preserve settled shards; dispatch refused.");
    const state: RetryState = saved ?? { version: 1, binding, status: "running", restoration: "unconfirmed", policyRetryConsumed: false, originalEvidence: input.originalEvidence };
    // Older waiting records already have authoritative policy-attempt sidecars.
    // Keep that consumption on upgrade; absence never replenishes a recorded bit.
    const original = state.originalEvidence?.phaseResultFile;
    const priorPolicy = original?.replace(/\.result\.json$/, "-policy-retry.result.json");
    if (saved && state.policyRetryConsumed === undefined && priorPolicy && priorPolicy !== original && existsSync(priorPolicy)) {
      state.policyRetryConsumed = true; atomicWriteJsonSync(file, state);
    }
    let pendingInfrastructure = false;
    const predecessors = state.predecessors ??= [];
    const policyRetry: PolicyRetryBudget = { used: state.policyRetryConsumed === true, predecessors,
      retain(pin) {
        predecessors.push(structuredClone(pin));
        atomicWriteJsonSync(file, state);
      },
      consume() {
        if (this.used) throw new Error("POLICY_RETRY_CONSUMED: no further rewording dispatch.");
        state.pendingPolicy = true;
        atomicWriteJsonSync(file, state);
        input.assess(predecessors);
        this.used = true;
      },
      beforeDispatch() {
        // All awaits (restoration, prompt admission, preparation) precede this
        // check. Nothing asynchronous may intervene before physical spawn.
        if (predecessors.length || pendingInfrastructure || state.pendingPolicy) input.assess(predecessors);
        if (pendingInfrastructure) {
          options.reserve();
          state.status = "consumed"; state.restoration = "confirmed";
          pendingInfrastructure = false;
        }
        if (state.pendingPolicy) {
          options.reserve();
          state.policyRetryConsumed = true; state.pendingPolicy = false;
          this.used = true;
        }
        atomicWriteJsonSync(file, state);
      },
    };
    if (!saved) {
      atomicWriteJsonSync(file, state);
      try {
        const result = await input.launch(false, state.originalEvidence, policyRetry);
        state.status = "settled"; atomicWriteJsonSync(file, state);
        return result;
      } catch (error) {
        state.status = input.eligible(error) || input.blocked(error) ? "waiting" : "failed";
        atomicWriteJsonSync(file, state);
        if (state.status !== "waiting" || input.blocked(error)) throw error;
      }
    }
    input.assess(predecessors);
    if (state.pendingPolicy) {
      // Resume only the already eligible read-only rewording, never its
      // predecessor. A consumed infrastructure allowance stays consumed.
      const prior = predecessors.at(-1);
      policyRetry.resumePolicy = { phaseResultFile: prior?.file, phaseLogFile: prior?.file?.replace(/\.result\.json$/, ".log") };
      policyRetry.used = true;
    } else {
      if (!await confirmIsolatedRoute(route)) {
        state.restoration = "refused"; atomicWriteJsonSync(file, state);
        throw input.refused(false);
      }
      input.assess(predecessors);
      pendingInfrastructure = true;
    }
    try {
      const result = await input.launch(state.restoration === "confirmed" || pendingInfrastructure, state.originalEvidence, policyRetry);
      state.status = "settled"; atomicWriteJsonSync(file, state);
      return result;
    } catch (error) {
      state.status = input.blocked(error) ? "waiting" : "failed"; atomicWriteJsonSync(file, state);
      if (input.eligible(error)) throw input.refused(true);
      throw error;
    }
  } finally {
    if (fd !== undefined) { closeSync(fd); unlinkSync(file + ".lock"); }
  }
}
