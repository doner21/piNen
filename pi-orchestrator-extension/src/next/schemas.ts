import type { JsonValue } from "./types";

export interface SchemaValidation {
  ok: boolean;
  error?: string;
}

export type OutputValidator = (value: JsonValue) => SchemaValidation;

export class OutputSchemaRegistry {
  readonly #validators = new Map<string, OutputValidator>();

  register(id: string, validator: OutputValidator): this {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-v[1-9][0-9]*$/.test(id)) {
      throw new Error(`Invalid output schema id: ${JSON.stringify(id)}`);
    }
    if (this.#validators.has(id)) throw new Error(`Output schema already registered: ${id}`);
    this.#validators.set(id, validator);
    return this;
  }

  has(id: string): boolean {
    return this.#validators.has(id);
  }

  validate(id: string, value: JsonValue): SchemaValidation {
    const validator = this.#validators.get(id);
    if (!validator) return { ok: false, error: `Unknown output schema: ${id}` };
    try {
      return validator(value);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  ids(): string[] {
    return [...this.#validators.keys()].sort();
  }
}

function record(value: JsonValue): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function hasOnlyKeys(value: Record<string, JsonValue>, allowed: string[]): string | undefined {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  return unknown.length ? `unknown field(s): ${unknown.join(", ")}` : undefined;
}

function informational(value: JsonValue): SchemaValidation {
  const item = record(value);
  if (!item) return { ok: false, error: "expected an object" };
  const unknown = hasOnlyKeys(item, ["summary", "data"]);
  if (unknown) return { ok: false, error: unknown };
  if (typeof item.summary !== "string" || !item.summary.trim()) {
    return { ok: false, error: "summary must be a non-empty string" };
  }
  return { ok: true };
}

function plan(value: JsonValue): SchemaValidation {
  const item = record(value);
  if (!item) return { ok: false, error: "expected an object" };
  const unknown = hasOnlyKeys(item, ["summary", "steps"]);
  if (unknown) return { ok: false, error: unknown };
  if (typeof item.summary !== "string" || !Array.isArray(item.steps) || !item.steps.every((entry) => typeof entry === "string" && entry.trim())) {
    return { ok: false, error: "plan requires summary:string and steps:string[]" };
  }
  return { ok: true };
}

function implementation(value: JsonValue): SchemaValidation {
  const item = record(value);
  if (!item) return { ok: false, error: "expected an object" };
  const unknown = hasOnlyKeys(item, ["summary", "files", "tests"]);
  if (unknown) return { ok: false, error: unknown };
  if (typeof item.summary !== "string") return { ok: false, error: "summary must be a string" };
  for (const key of ["files", "tests"] as const) {
    if (!Array.isArray(item[key]) || !item[key].every((entry) => typeof entry === "string")) {
      return { ok: false, error: `${key} must be a string array` };
    }
  }
  return { ok: true };
}

function verification(value: JsonValue): SchemaValidation {
  const item = record(value);
  if (!item) return { ok: false, error: "expected an object" };
  const unknown = hasOnlyKeys(item, ["status", "summary", "checks", "remaining"]);
  if (unknown) return { ok: false, error: unknown };
  if (item.status !== "pass" && item.status !== "fail") return { ok: false, error: "status must be pass or fail" };
  if (typeof item.summary !== "string") return { ok: false, error: "summary must be a string" };
  if (!Array.isArray(item.checks) || !item.checks.every((entry) => {
    const check = record(entry);
    return Boolean(check)
      && typeof check!.id === "string"
      && (check!.status === "pass" || check!.status === "fail")
      && Array.isArray(check!.evidence)
      && check!.evidence.every((evidence) => typeof evidence === "string")
      && !hasOnlyKeys(check!, ["id", "status", "evidence"]);
  })) return { ok: false, error: "checks must contain strict {id,status,evidence[]} objects" };
  if (!Array.isArray(item.remaining) || !item.remaining.every((entry) => typeof entry === "string")) {
    return { ok: false, error: "remaining must be a string array" };
  }
  return { ok: true };
}

function commandResult(value: JsonValue): SchemaValidation {
  const item = record(value);
  if (!item) return { ok: false, error: "expected an object" };
  const unknown = hasOnlyKeys(item, ["exitCode", "stdout", "stderr"]);
  if (unknown) return { ok: false, error: unknown };
  if (!Number.isInteger(item.exitCode) || typeof item.stdout !== "string" || typeof item.stderr !== "string") {
    return { ok: false, error: "command result requires integer exitCode, stdout:string, stderr:string" };
  }
  return { ok: true };
}

function integrationResult(value: JsonValue): SchemaValidation {
  const item = record(value);
  if (!item) return { ok: false, error: "expected an object" };
  const unknown = hasOnlyKeys(item, ["status", "sources", "mutations"]);
  if (unknown) return { ok: false, error: unknown };
  if (item.status !== "integrated") return { ok: false, error: "status must be integrated" };
  if (!Array.isArray(item.sources) || !item.sources.every((entry) => typeof entry === "string")) {
    return { ok: false, error: "sources must be a string array" };
  }
  if (!Array.isArray(item.mutations) || !item.mutations.every((entry) => {
    const mutation = record(entry);
    return Boolean(mutation)
      && typeof mutation!.path === "string"
      && (mutation!.kind === "created" || mutation!.kind === "modified" || mutation!.kind === "deleted" || mutation!.kind === "external")
      && !hasOnlyKeys(mutation!, ["path", "kind"]);
  })) return { ok: false, error: "mutations must contain strict {path,kind} objects" };
  return { ok: true };
}

function joinResult(value: JsonValue): SchemaValidation {
  const item = record(value);
  if (!item) return { ok: false, error: "expected an object" };
  const unknown = hasOnlyKeys(item, ["phaseIds", "outputs"]);
  if (unknown) return { ok: false, error: unknown };
  if (!Array.isArray(item.phaseIds) || !item.phaseIds.every((entry) => typeof entry === "string")) {
    return { ok: false, error: "phaseIds must be a string array" };
  }
  if (!item.outputs || typeof item.outputs !== "object" || Array.isArray(item.outputs)) {
    return { ok: false, error: "outputs must be an object" };
  }
  return { ok: true };
}

export function createBuiltinSchemaRegistry(): OutputSchemaRegistry {
  return new OutputSchemaRegistry()
    .register("informational-v1", informational)
    .register("plan-v1", plan)
    .register("implementation-v1", implementation)
    .register("verification-v1", verification)
    .register("command-result-v1", commandResult)
    .register("integration-result-v1", integrationResult)
    .register("join-v1", joinResult);
}
