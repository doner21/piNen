import fs from "node:fs";
import path from "node:path";
import { atomicWriteJsonSync } from "./run-state";

interface SpawnBudget { version: 1; cap: number; reserved: number; automaticCeiling?: boolean }
const fileFor = (runDir: string) => path.join(runDir, "spawn-budget.json");
function read(runDir: string): SpawnBudget | undefined {
  const file = fileFor(runDir);
  if (!fs.existsSync(file)) return undefined;
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as SpawnBudget;
  if (value.version !== 1 || !Number.isSafeInteger(value.cap) || value.cap < 1
    || !Number.isSafeInteger(value.reserved) || value.reserved < 0
    || value.automaticCeiling !== undefined && typeof value.automaticCeiling !== "boolean") throw new Error("Subagent spawn budget evidence invalid; dispatch refused.");
  return value;
}
/** Compatibility with pre-budget checkpoints: every observed physical root is
 * charged, including retry/exhaustion generations. Never reset on adoption. */
function observedLaunches(runDir: string, currentPhaseFile?: string): number {
  if (!fs.existsSync(runDir)) return 0;
  const roots = new Set<string>();
  for (const name of fs.readdirSync(runDir).filter(n => /^phase-.*\.result\.json$/.test(n))) {
    const phaseFile = path.join(runDir, name);
    if (currentPhaseFile && path.resolve(currentPhaseFile) === path.resolve(phaseFile)) continue; // caller has not attempted spawn yet
    const phase = JSON.parse(fs.readFileSync(phaseFile, "utf8"));
    if (!phase.pid && !phase.processTree && !phase.processTrees?.length
      && !(phase.kind === "subagent-phase-result" && phase.status === "incomplete" && phase.settlement === "never_dispatched" && phase.eventCount === 0)) {
      throw new Error("Subagent historical dispatch evidence unknown; budget cannot be replenished.");
    }
    const trees = phase.processTrees?.length ? phase.processTrees : phase.processTree ? [phase.processTree] : [];
    for (const tree of trees) {
      if (!Number.isSafeInteger(tree?.rootPid) || tree.rootPid < 1 || typeof tree.rootBorn !== "string" || !Number.isFinite(Date.parse(tree.rootBorn))) throw new Error("Subagent historical generation identity unknown; dispatch refused.");
      roots.add(`${tree.rootPid}:${tree.rootBorn}`);
    }
    if (phase.pid && !trees.some((tree: { rootPid: number }) => tree.rootPid === phase.pid)) throw new Error("Subagent historical PID-only dispatch evidence is not a launch count.");
  }
  return roots.size;
}
export function readRunSpawnCount(runDir: string): number {
  return read(runDir)?.reserved ?? observedLaunches(runDir);
}
/** Synchronous exclusive reservation immediately before physical spawn. A
 * failed/uncertain spawn is not refunded. A competing host cannot steal a lock
 * or widen the frozen cap. No process/clock based lease or recovery bypass. */
export function reserveRunSpawn(runDir: string, requestedCap: number, allowAutomaticIncrease = false, currentPhaseFile?: string): number {
  if (!Number.isSafeInteger(requestedCap) || requestedCap < 1) throw new Error("Invalid subagent ceiling.");
  fs.mkdirSync(runDir, { recursive: true });
  const file = fileFor(runDir);
  const fd = fs.openSync(file + ".lock", "wx", 0o600);
  try {
    const saved = read(runDir) ?? { version: 1 as const, cap: requestedCap, reserved: observedLaunches(runDir, currentPhaseFile), automaticCeiling: allowAutomaticIncrease };
    // Preserve existing implicit plan-size auto-raise; explicit owner caps can
    // never be widened. Neither route resets the already consumed reservations.
    if (saved.cap < requestedCap && saved.automaticCeiling && allowAutomaticIncrease) saved.cap = requestedCap;
    if (saved.cap !== requestedCap) throw new Error("Subagent ceiling changed from durable run budget; dispatch refused.");
    if (saved.reserved >= saved.cap) throw new Error(`Subagent ceiling exceeded: already spawned ${saved.reserved}/${saved.cap}.`);
    saved.reserved++;
    atomicWriteJsonSync(file, saved);
    return saved.reserved;
  } finally { fs.closeSync(fd); fs.unlinkSync(file + ".lock"); }
}
