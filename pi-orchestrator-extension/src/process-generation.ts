/** Cumulative kernel identities, not PID-only child lists. No process control.
 * Sample at launch, tool boundaries, existing heartbeats and settlement. Known
 * descendants remain in the inventory after reparenting or root termination.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { validProcessGeneration as validMember, processInventoryRows } from "./process-inventory.cjs";

export interface ProcessGeneration { pid: number; parentPid: number; born: string }
export interface ProcessSnapshot { rows: ProcessGeneration[]; error?: string }
export interface ProcessTreeInventory {
  schemaVersion: 1;
  rootPid: number;
  rootBorn?: string;
  launchId?: string;
  phaseId?: string;
  /** Host/kernel facts for individual generations, never worker assertions or
   * a parent's completion promoted to descendants. Bound to this publication. */
  settledMembers?: Array<{ member: ProcessGeneration; launchId: string; phaseId: string; observedAt: string; source: "kernel_absence" | "native_close" }>;
  observedAt: string;
  members: ProcessGeneration[];
  /** Exact generations previously observed on a kernel ancestry path outside
   * this root. Never a process-name exemption or an unseen creator claim. */
  outsideTree?: ProcessGeneration[];
  status: "clean" | "survivors" | "unknown";
  survivors: ProcessGeneration[];
  unknown: string[];
}
const validPid = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
const key = (p: ProcessGeneration): string => `${p.pid}:${p.born}`;
const independentlySettled = (tree: ProcessTreeInventory, member: ProcessGeneration, laterBirth?: string): boolean =>
  !!tree.launchId && !!tree.phaseId && Array.isArray(tree.settledMembers) && tree.settledMembers.some(proof =>
    validMember(proof?.member) && key(proof.member) === key(member) && proof.member.parentPid === member.parentPid
    && proof.launchId === tree.launchId && proof.phaseId === tree.phaseId
    && ["kernel_absence", "native_close"].includes(proof.source)
    && (proof.source !== "native_close" || member.pid === tree.rootPid && member.born === tree.rootBorn)
    && Number.isFinite(Date.parse(proof.observedAt)) && Date.parse(proof.observedAt) >= Date.parse(member.born)
    && Date.parse(proof.observedAt) <= Date.parse(tree.observedAt)
    && (laterBirth === undefined || bornNotBefore(laterBirth, proof.observedAt)));
const bornNotBefore = (child: string, parent: string): boolean => {
  const delta = Date.parse(child) - Date.parse(parent);
  if (delta !== 0) return delta > 0;
  // CIM preserves 100ns precision. Do not collapse parent ordering to JS ms.
  const fraction = (value: string): string => (/\.(\d+)Z$/.exec(value)?.[1] ?? "").padEnd(7, "0");
  return fraction(child) >= fraction(parent);
};

/** Windows CIM CreationDate is the kernel generation identity. The observer
 * itself returns normally; it is not a worker or a member of the worker tree. */
export function snapshotProcesses(): ProcessSnapshot {
  if (process.platform !== "win32") return { rows: [], error: "kernel_inventory_unavailable_on_platform" };
  const result = spawnSync(path.join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-Command",
    "$r=@(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='parentPid';e={[int]$_.ParentProcessId}},@{n='born';e={$_.CreationDate.ToUniversalTime().ToString('o')}}); ConvertTo-Json -Compress -InputObject $r",
  ], { encoding: "utf8", windowsHide: true });
  try {
    if (result.error || result.status !== 0 || result.signal !== null) throw new Error();
    const rows = processInventoryRows(JSON.parse(result.stdout));
    if (!rows) throw new Error();
    return { rows };
  } catch { return { rows: [], error: "kernel_inventory_failed" }; }
}

export function assessProcessTree(value: unknown, snapshot: ProcessSnapshot): ProcessTreeInventory {
  const tree = value as ProcessTreeInventory | undefined;
  const invalid = !tree || tree.schemaVersion !== 1 || !validPid(tree.rootPid) || !Array.isArray(tree.members)
    || !tree.members.length || !tree.members.every(validMember) || !Array.isArray(tree.unknown)
    || !tree.members.some(p => p.pid === tree.rootPid && p.born === tree.rootBorn)
    || tree.outsideTree !== undefined && (!Array.isArray(tree.outsideTree) || !tree.outsideTree.every(validMember)
      || tree.outsideTree.some(p => tree.members.some(member => key(member) === key(p))));
  if (invalid) return { schemaVersion: 1, rootPid: tree?.rootPid ?? 0, observedAt: new Date().toISOString(), members: [], status: "unknown", survivors: [], unknown: ["missing_or_invalid_generation_inventory"] };
  const unknown = [...tree.unknown];
  if (tree.settledMembers !== undefined && (!Array.isArray(tree.settledMembers) || tree.settledMembers.some(proof =>
    !tree.members.some(member => validMember(proof?.member) && key(member) === key(proof.member) && member.parentPid === proof.member.parentPid)
    || !independentlySettled({ ...tree, settledMembers: [proof] }, proof.member)))) unknown.push("invalid_generation_settlement_binding");
  if (snapshot.error) unknown.push(snapshot.error);
  const members = new Map(tree.members.map(member => [key(member), member]));
  if (!snapshot.error) {
    let added = true;
    while (added) {
      added = false;
      for (const row of snapshot.rows) {
        if (members.has(key(row))) continue;
        const parent = snapshot.rows.find(p => p.pid === row.parentPid);
        const historicalParent = [...members.values()].find(p => p.pid === row.parentPid && bornNotBefore(row.born, p.born));
        if (parent && members.has(key(parent)) && bornNotBefore(row.born, parent.born)) {
          members.set(key(row), row); added = true;
        } else if (!parent && historicalParent) {
          // A new child first seen after parent death is evidence, not proof of
          // clean shutdown. Preserve its kernel identity but not owned status:
          // an unseen intervening parent generation cannot be excluded.
          members.set(key(row), row); added = true;
          unknown.push(`parent_generation_unobserved:${row.parentPid}:candidate:${row.pid}`);
        }
      }
    }
  }
  // Windows retains a child's creator PID after that creator ends. A new
  // orphan born during this root generation may be a grandchild whose short
  // lived intermediary fell between samples. Its ancestry is unresolved, NOT
  // proof of ownership and NOT proof of clean shutdown. Existing inspection,
  // adoption and acceptance gates retain this uncertainty without replay.
  if (!snapshot.error && tree.rootBorn) for (const row of snapshot.rows) {
    if (!members.has(key(row)) && !tree.outsideTree?.some(outside => key(outside) === key(row)) && bornNotBefore(row.born, tree.rootBorn)
      // A settled clean sample closes this generation's observation window;
      // unrelated orphans born later cannot have created the missed ancestry.
      && !(tree.status === "clean" && Number.isFinite(Date.parse(tree.observedAt)) && !bornNotBefore(tree.observedAt, row.born))
      && row.parentPid > 0 && !snapshot.rows.some(parent => parent.pid === row.parentPid && bornNotBefore(row.born, parent.born))) {
      unknown.push(`unresolved_creator_generation:${row.parentPid}:candidate:${key(row)}`);
    }
  }
  const survivors: ProcessGeneration[] = [];
  if (!snapshot.error) for (const member of members.values()) {
    const current = snapshot.rows.find(row => row.pid === member.pid);
    if (current && current.born !== member.born) {
      if (!independentlySettled(tree, member, current.born)) unknown.push(`pid_reused:${member.pid}`);
    } else if (current) survivors.push(member);
  }
  const status = unknown.length ? "unknown" : survivors.length ? "survivors" : "clean";
  return { ...tree, members: [...members.values()], observedAt: status === "clean" && tree.status === "clean" ? tree.observedAt : new Date().toISOString(), survivors, unknown: [...new Set(unknown)], status };
}

export class ProcessGenerationTracker {
  private tree: ProcessTreeInventory;
  // Transient prior OS observation, not another persisted machine inventory.
  private previousRows: ProcessGeneration[] = [];
  constructor(rootPid: number, private readonly snapshot: () => ProcessSnapshot = snapshotProcesses,
    binding: { launchId: string; phaseId: string } = { launchId: randomUUID(), phaseId: "in_memory" }) {
    this.tree = { schemaVersion: 1, rootPid, ...binding, observedAt: new Date().toISOString(), members: [], status: "unknown", survivors: [], unknown: [] };
    this.sample();
  }
  sample(): ProcessTreeInventory {
    const snapshot = this.snapshot();
    if (snapshot.error) this.tree.unknown.push(snapshot.error);
    else {
      const root = snapshot.rows.find(row => row.pid === this.tree.rootPid);
      if (!this.tree.rootBorn) {
        if (root) { this.tree.rootBorn = root.born; this.tree.members.push(root); }
        else this.tree.unknown.push("root_generation_not_observed");
      }
      // assessProcessTree expands matching live generations and retains
      // uncertain descendants first seen after their parent's disappearance.
    }
    if (!snapshot.error && this.tree.rootBorn) {
      const owned = new Set(this.tree.members.map(key)), outside = new Map((this.tree.outsideTree ?? []).map(row => [key(row), row]));
      const provenOutside = (row: ProcessGeneration): boolean => {
        const visited = new Set<string>();
        while (!visited.has(key(row))) {
          visited.add(key(row));
          if (owned.has(key(row))) return false;
          if (outside.has(key(row)) || !bornNotBefore(row.born, this.tree.rootBorn!)) return true;
          const parent = this.previousRows.find(p => p.pid === row.parentPid && bornNotBefore(row.born, p.born));
          if (!parent) return false;
          row = parent;
        }
        return false;
      };
      for (const row of snapshot.rows) {
        if (!bornNotBefore(row.born, this.tree.rootBorn) || owned.has(key(row)) || outside.has(key(row)) || snapshot.rows.some(p => p.pid === row.parentPid && bornNotBefore(row.born, p.born))) continue;
        const prior = this.previousRows.find(p => key(p) === key(row));
        // Only the SAME already observed generation can be excluded. A new
        // orphan with an unseen intermediary remains UNKNOWN, even if its PID
        // happens to match a former observer or other unrelated process.
        if (prior && provenOutside(prior)) outside.set(key(row), row);
      }
      if (outside.size) this.tree.outsideTree = [...outside.values()];
      this.previousRows = snapshot.rows;
    }
    // Retain PID absence BEFORE any later reuse; a different birth in this
    // sample is not an absence observation for the old generation.
    if (!snapshot.error) for (const member of this.tree.members) {
      if (!snapshot.rows.some(row => row.pid === member.pid)) this.retainSettlement(member, "kernel_absence");
    }
    this.tree = assessProcessTree(this.tree, snapshot);
    return this.current();
  }
  private retainSettlement(member: ProcessGeneration, source: "kernel_absence" | "native_close"): void {
    if (independentlySettled(this.tree, member)) return;
    const observedAt = new Date().toISOString();
    this.tree.observedAt = observedAt;
    (this.tree.settledMembers ??= []).push({ member: { ...member }, launchId: this.tree.launchId!, phaseId: this.tree.phaseId!, observedAt, source });
  }
  /** Called only from the host's matching ChildProcess close callback. */
  rootClosed(): void {
    const root = this.tree.members.find(member => member.pid === this.tree.rootPid && member.born === this.tree.rootBorn);
    if (root) this.retainSettlement(root, "native_close");
  }
  current(): ProcessTreeInventory { return structuredClone(this.tree); }
}

/** Recheck recorded generations with an existing identity observer (also used
 * under adoption/approval mutation fences). Unproven PID reuse stays UNKNOWN. */
export function assessTreeWithObserver(value: unknown, observe: (pid: number) => { status: string; startedAt?: number; birthIdentity?: string; evidence?: string }): ProcessTreeInventory {
  const tree = value as ProcessTreeInventory;
  if (!tree || !Array.isArray(tree.members)) return assessProcessTree(value, { rows: [] });
  const rows: ProcessGeneration[] = [], errors: string[] = [];
  for (const member of tree.members) {
    let observation;
    try { observation = observe(member.pid); } catch { observation = { status: "unknown" }; }
    if (observation.status === "alive" && observation.startedAt !== undefined) rows.push({ ...member, born: observation.birthIdentity ?? new Date(observation.startedAt).toISOString() });
    else if (observation.status !== "dead" || observation.evidence !== "ESRCH") errors.push(`generation_unobservable:${member.pid}`);
  }
  return assessProcessTree(value, { rows, ...(errors.length ? { error: errors.join(",") } : {}) });
}

export function assessResultProcessTrees(outputs: Array<{ processTree?: ProcessTreeInventory; processTrees?: ProcessTreeInventory[] }>): ProcessTreeInventory[] {
  const snapshot = snapshotProcesses();
  return outputs.flatMap(output => (output.processTrees?.length ? output.processTrees : [output.processTree]).map(tree => assessProcessTree(tree, snapshot)));
}

/** Recorder-originated pins live in the existing exclusive retry claim, not in
 * the worker publication being assessed. Matching copied fields are not authority. */
export interface RetryPredecessorEvidence {
  file?: string;
  launchId: string;
  agentName: string;
  taskSha256: string;
  pid?: number;
  settlement: "infrastructure_no_tools" | "provider_refused_read_only";
  treesSha256: string;
}
export function processTreesDigest(trees: ProcessTreeInventory[]): string {
  return createHash("sha256").update(JSON.stringify(trees)).digest("hex");
}
export class RetryCleanupError extends Error {
  // Pending dispatch, not a new zero-tool authentication claim.
  readonly info = { code: "retry_cleanup" as const, retryAllowed: true, retryEligible: true, retryAttempted: false, mutationAmbiguous: false };
  constructor() {
    super("RETRY_PREDECESSOR_CLEANUP_UNPROVEN: preserve original work and pending retry; no redispatch or repair replay.");
    this.name = "RetryCleanupError";
  }
}
/** A fresh kernel assessment AND the recorder's immutable launch pin are
 * required. Native root close never supplies descendant settlement. */
export function assessRetryPredecessors(evidence: readonly RetryPredecessorEvidence[]): ProcessTreeInventory[] {
  try {
    if (!evidence.length) throw new RetryCleanupError();
    const snapshot = snapshotProcesses(), assessed: ProcessTreeInventory[] = [];
    for (const pin of evidence) {
      if (!pin.file || !path.isAbsolute(pin.file) || !pin.launchId) throw new RetryCleanupError();
      const result = JSON.parse(fs.readFileSync(pin.file, "utf8"));
      const trees = result.processTrees ?? (result.processTree ? [result.processTree] : []);
      if (result.schemaVersion !== 1 || phaseSettlement(result) !== "closed_failure" || result.status !== "complete"
        || result.settlement !== pin.settlement || result.launchId !== pin.launchId || result.agentName !== pin.agentName
        || result.taskSha256 !== pin.taskSha256 || result.pid !== pin.pid || !trees.length
        || result.pid !== trees.at(-1)?.rootPid || processTreesDigest(trees) !== pin.treesSha256) throw new RetryCleanupError();
      for (const tree of trees) {
        if (tree.launchId !== pin.launchId || tree.phaseId !== pin.file) throw new RetryCleanupError();
        const current = assessProcessTree(tree, snapshot);
        if (current.status !== "clean") throw new RetryCleanupError();
        assessed.push(current);
      }
    }
    return assessed;
  } catch { throw new RetryCleanupError(); }
}

export type PhaseSettlement = "result" | "closed_failure" | "never_dispatched" | "ambiguous";
/** Host publication settlement is not semantic success. All lifecycle consumers
 * use these same phase facts plus the independently assessed member inventory. */
export function phaseSettlement(result: any): PhaseSettlement {
  if (result?.kind !== "subagent-phase-result") return "ambiguous";
  if (result.status === "incomplete" && result.settlement === "never_dispatched" && result.pid === undefined
    && result.processTree === undefined && result.processTrees === undefined && result.eventCount === 0 && result.result === undefined) return "never_dispatched";
  if (result.status === "incomplete" && result.settlement === "closed" && result.result === undefined) return "closed_failure";
  if (result.status === "complete") {
    if (result.settlement === "infrastructure_no_tools" || result.settlement === "provider_refused_read_only") return result.result === undefined ? "closed_failure" : "ambiguous";
    if (result.settlement !== undefined || !result.result || !Number.isInteger(result.result.exitCode)) return "ambiguous";
    return result.result.exitCode === 0 ? "result" : "closed_failure";
  }
  return "ambiguous";
}
export function readRunProcessTrees(runDir: string, observe?: Parameters<typeof assessTreeWithObserver>[1], options: { preDispatch?: boolean } = {}): { status: ProcessTreeInventory["status"]; trees: ProcessTreeInventory[]; reasons: string[]; phases: Array<{ file: string; settlement: PhaseSettlement; rootPids: number[] }> } {
  const trees: ProcessTreeInventory[] = [], reasons: string[] = [], phases: Array<{ file: string; settlement: PhaseSettlement; rootPids: number[] }> = [];
  try {
    const names = fs.readdirSync(runDir).filter(name => /^phase-.*\.result\.json$/i.test(name));
    if (!names.length) return { status: "unknown", trees, phases, reasons: ["missing_phase_generation_inventory"] };
    const snapshot = observe ? undefined : snapshotProcesses();
    for (const name of names) {
      const result = JSON.parse(fs.readFileSync(path.join(runDir, name), "utf8"));
      // Only an explicit host-owned pre-spawn refusal proves no tree existed.
      // A missing PID/inventory by itself is still UNKNOWN.
      const settlement = phaseSettlement(result);
      const inventories = Array.isArray(result.processTrees) && result.processTrees.length ? result.processTrees : [result.processTree];
      phases.push({ file: name, settlement, rootPids: inventories.filter(Boolean).map((tree: ProcessTreeInventory) => tree.rootPid) });
      if (settlement === "never_dispatched") continue;
      if (result.kind !== "subagent-phase-result" || result.pid !== inventories.at(-1)?.rootPid || !["running", "complete", "incomplete"].includes(result.status)) reasons.push(`${name}:invalid_tree_binding`);
      if (settlement === "ambiguous") reasons.push(`${name}:unsettled_phase`);
      for (const inventory of inventories) {
        // Restored evidence can only consume facts from its original launch
        // and phase, not a copied settlement from another publication.
        const bound = inventory && typeof result.launchId === "string" && result.launchId.length > 0 && inventory.launchId === result.launchId && inventory.phaseId === path.join(runDir, name);
        if (!bound) reasons.push(`${name}:unbound_generation_inventory`);
        const boundInventory = inventory && { ...inventory, ...(!bound ? { settledMembers: undefined } : {}) };
        const tree = observe ? assessTreeWithObserver(boundInventory, observe) : assessProcessTree(boundInventory, snapshot!);
        const resultTrees = result.result?.processTrees ?? (result.result?.processTree ? [result.result.processTree] : []);
        if (resultTrees.length && !resultTrees.some((r: ProcessTreeInventory) => r.rootPid === tree.rootPid && r.rootBorn === tree.rootBorn && JSON.stringify(r.members) === JSON.stringify(tree.members))) reasons.push(`${name}:result_tree_binding_changed`);
        trees.push(tree);
        if (tree.status !== "clean") reasons.push(`${name}:${tree.status}`);
      }
    }
    let manifest: any;
    try { manifest = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8")); }
    catch (error) {
      // Visible-main publishes the planner before allocating the executor
      // manifest. Only a caller's validated pre-dispatch checkpoint permits
      // that explicit boundary; phase settlement/bindings above still apply.
      if (!options.preDispatch || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      manifest = { phases: [] };
    }
    if (!Array.isArray(manifest.phases)) reasons.push("missing_phase_manifest");
    else for (const phase of manifest.phases) if (["running", "done", "detached", "ambiguous-completion"].includes(phase.status)
      && !names.some(name => name.startsWith(`phase-${phase.index}-`))) reasons.push(`missing_phase_inventory:${phase.index}`);
  } catch { reasons.push("unreadable_phase_generation_inventory"); }
  return { status: reasons.length ? trees.some(tree => tree.status === "survivors") ? "survivors" : "unknown" : "clean", trees, phases, reasons };
}
