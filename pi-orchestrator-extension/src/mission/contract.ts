import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import {
  MISSION_SCHEMA_VERSION,
  type CompiledMission,
  type CompiledMissionContractV1,
  type MissionBudgets,
  type MissionContractV1,
  type MissionRoute,
  type MissionValidatorSpec,
  type ThinkingLevel,
} from "./types";

const CONTRACT_KEYS = new Set(["schemaVersion", "objective", "cwd", "route", "fallbacks", "budgets", "validator", "constraints"]);
const ROUTE_KEYS = new Set(["provider", "model", "thinkingLevel"]);
const BUDGET_KEYS = new Set(["wallClockMs", "maxTurns", "maxRestarts", "maxSpecialists", "maxTokens"]);
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export class MissionContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "MissionContractError";
    this.code = code;
  }
}

export function compileMissionContract(source: MissionContractV1 | unknown): CompiledMission {
  const value = requireRecord(source, "mission contract");
  rejectUnknown(value, CONTRACT_KEYS, "mission contract");
  if (value.schemaVersion !== MISSION_SCHEMA_VERSION) {
    throw new MissionContractError("MISSION_SCHEMA_UNSUPPORTED", `expected schemaVersion ${MISSION_SCHEMA_VERSION}`);
  }
  const objective = requireBoundedText(value.objective, "objective", 1, 200_000);
  const cwdInput = requireBoundedText(value.cwd, "cwd", 1, 32_768);
  const cwd = canonicalDirectory(cwdInput);
  const route = compileRoute(value.route, "route");
  const fallbacks = value.fallbacks === undefined
    ? []
    : requireArray(value.fallbacks, "fallbacks").map((item, index) => compileRoute(item, `fallbacks[${index}]`));
  if (fallbacks.length > 5) throw new MissionContractError("MISSION_FALLBACK_LIMIT", "at most five fallback routes are allowed");
  const seenRoutes = new Set<string>();
  for (const [index, candidate] of [route, ...fallbacks].entries()) {
    const key = `${candidate.provider}\0${candidate.model}\0${candidate.thinkingLevel}`;
    if (seenRoutes.has(key)) throw new MissionContractError("MISSION_ROUTE_DUPLICATE", `duplicate route at index ${index}`);
    seenRoutes.add(key);
  }
  const budgets = compileBudgets(value.budgets);
  const validator = compileValidator(value.validator);
  const constraints = value.constraints === undefined
    ? []
    : requireArray(value.constraints, "constraints").map((item, index) => requireBoundedText(item, `constraints[${index}]`, 1, 4_096));
  if (constraints.length > 64) throw new MissionContractError("MISSION_CONSTRAINT_LIMIT", "at most 64 constraints are allowed");
  if (new Set(constraints).size !== constraints.length) throw new MissionContractError("MISSION_CONSTRAINT_DUPLICATE", "constraints must be unique");

  const contract: CompiledMissionContractV1 = {
    schemaVersion: MISSION_SCHEMA_VERSION,
    objective,
    cwd,
    workspaceFingerprint: computeWorkspaceFingerprint(cwd),
    route,
    fallbacks,
    budgets,
    validator,
    constraints: [...constraints],
  };
  const canonicalJson = stableStringify(contract);
  const missionHash = createHash("sha256").update(canonicalJson).digest("hex");
  return { contract, canonicalJson, missionHash };
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function computeWorkspaceFingerprint(canonicalCwd: string): string {
  const identity = process.platform === "win32" ? canonicalCwd.toLocaleLowerCase("en-US") : canonicalCwd;
  return createHash("sha256").update(`pi-durable-workspace-v1\0${identity}`).digest("hex");
}

function compileRoute(value: unknown, label: string): Required<MissionRoute> {
  const route = requireRecord(value, label);
  rejectUnknown(route, ROUTE_KEYS, label);
  const provider = requireBoundedText(route.provider, `${label}.provider`, 1, 128);
  const model = requireBoundedText(route.model, `${label}.model`, 1, 256);
  const thinkingLevel = route.thinkingLevel === undefined ? "off" : route.thinkingLevel;
  if (typeof thinkingLevel !== "string" || !THINKING_LEVELS.has(thinkingLevel as ThinkingLevel)) {
    throw new MissionContractError("MISSION_THINKING_INVALID", `${label}.thinkingLevel is invalid`);
  }
  return { provider, model, thinkingLevel: thinkingLevel as ThinkingLevel };
}

function compileBudgets(value: unknown): Required<MissionBudgets> {
  const budgets = requireRecord(value, "budgets");
  rejectUnknown(budgets, BUDGET_KEYS, "budgets");
  return {
    wallClockMs: requireInteger(budgets.wallClockMs, "budgets.wallClockMs", 1_000, 7 * 24 * 60 * 60 * 1_000),
    maxTurns: requireInteger(budgets.maxTurns, "budgets.maxTurns", 1, 1_000),
    maxRestarts: requireInteger(budgets.maxRestarts, "budgets.maxRestarts", 0, 100),
    maxSpecialists: requireInteger(budgets.maxSpecialists, "budgets.maxSpecialists", 0, 100),
    maxTokens: budgets.maxTokens === undefined
      ? 10_000_000
      : requireInteger(budgets.maxTokens, "budgets.maxTokens", 1, 100_000_000),
  };
}

function compileValidator(value: unknown): MissionValidatorSpec {
  const validator = requireRecord(value, "validator");
  if (validator.kind === "none") {
    rejectUnknown(validator, new Set(["kind", "readOnly"]), "validator");
    if (validator.readOnly !== true) throw new MissionContractError("MISSION_VALIDATOR_INVALID", "validator none requires readOnly=true");
    return { kind: "none", readOnly: true };
  }
  if (validator.kind !== "node-workspace-validator") {
    throw new MissionContractError("MISSION_VALIDATOR_INVALID", "unknown validator kind");
  }
  rejectUnknown(validator, new Set(["kind", "script", "timeoutMs", "maxOutputBytes"]), "validator");
  if (validator.script !== "validate.cjs") {
    throw new MissionContractError("MISSION_VALIDATOR_INVALID", "node-workspace-validator script must be exactly validate.cjs");
  }
  return {
    kind: "node-workspace-validator",
    script: "validate.cjs",
    timeoutMs: requireInteger(validator.timeoutMs, "validator.timeoutMs", 100, 60 * 60 * 1_000),
    maxOutputBytes: requireInteger(validator.maxOutputBytes, "validator.maxOutputBytes", 1_024, 16 * 1_024 * 1_024),
  };
}

function canonicalDirectory(input: string): string {
  const absolute = path.resolve(input);
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch (error) {
    throw new MissionContractError("MISSION_CWD_MISSING", `${absolute}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!statSync(canonical).isDirectory()) throw new MissionContractError("MISSION_CWD_INVALID", `${canonical} is not a directory`);
  return canonical;
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new MissionContractError("MISSION_NUMBER_INVALID", `${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function requireBoundedText(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== "string") throw new MissionContractError("MISSION_TEXT_INVALID", `${label} must be a string`);
  const text = value.trim();
  if (text.length < minimum || text.length > maximum) {
    throw new MissionContractError("MISSION_TEXT_INVALID", `${label} length must be ${minimum} through ${maximum}`);
  }
  if (text.includes("\0")) throw new MissionContractError("MISSION_TEXT_INVALID", `${label} contains NUL`);
  return text;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new MissionContractError("MISSION_ARRAY_INVALID", `${label} must be an array`);
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MissionContractError("MISSION_OBJECT_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) throw new MissionContractError("MISSION_UNKNOWN_FIELD", `${label}: ${unknown.join(", ")}`);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) output[key] = sortJson(item);
    }
    return output;
  }
  return value;
}
