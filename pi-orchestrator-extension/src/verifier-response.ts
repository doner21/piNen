/** Conservative parser for visible-main verifier verdicts. */

export interface VerifierParseDiagnostic {
  code: "verifier_json_eof_suffix_recovered" | "verifier_json_semantic_fallback" | "invalid_verifier_json";
  message: string;
  advisory: boolean;
}

export type VerifierParseRecovery =
  | { strategy: "eof_closing_suffix"; appendedSuffix: string }
  | { strategy: "semantic_field_extraction"; extractedFields: ["status", "criterionFindings"] };

export interface VisibleMainVerifierResponse {
  parsed: Record<string, unknown> | null;
  raw: string;
  diagnostics: VerifierParseDiagnostic[];
  recovery?: VerifierParseRecovery;
}

export interface RecoveredVerifierSettlementAssessment {
  /** True only when recovery supplied syntax, never substantive verdict content. */
  terminalEligible: boolean;
  issues: string[];
}

export interface VerifierCriteriaProvenanceContext {
  /** Only an explicit owner contract may make presentation format verdict-determining. */
  executorOutputContractSource?: "explicit" | "inferred";
  /** Host/planner presentation suggestions that are advisory rather than product criteria. */
  plannerInferredPresentationRules?: string[];
}

export interface NormalizedVisibleMainVerifierResponse extends VisibleMainVerifierResponse {
  /** Capability-only reasons removed from the semantic verdict. */
  capabilityTelemetry: string[];
  /** Presentation-only failure text retained after an inferred rule is demoted to advisory. */
  inferredPresentationTelemetry: string[];
  presentationNormalization?: {
    strategy: "inferred_presentation_advisory";
    originalStatus: "fail";
    normalizedStatus: "pass";
  };
  /** Present only when no substantive failed reason/evidence remains. */
  commandUnavailable?: {
    code: "command_unavailable";
    message: string;
    retryAllowed: true;
    retryEligible: true;
  };
}

// Infrastructure is an explicit, fail-closed exception. These patterns match
// complete capability statements only; command-like words near a product or
// implementation finding are never enough to change its semantic meaning.
const CAPABILITY_SUBJECT = String.raw`(?:i|we|(?:this|the)\s+(?:verifier|worker))`;
const CAPABILITY_OBJECT = String.raw`(?:bash(?:\s+(?:commands?|command[- ]execution))?|command[- ]execution|bash\s+or\s+command[- ]execution)`;
const CAPABILITY_STATEMENT_PATTERNS = [
  /^(?:this|the)\s+worker\s+exposes\s+only\s+read\s*\/\s*grep\s*\/\s*find\s*\/\s*ls\s*,\s*not\s+bash[.!]?$/i,
  new RegExp(String.raw`^${CAPABILITY_SUBJECT}\s+(?:(?:do\s+not|don't|does\s+not|doesn't)\s+have|(?:has|have)\s+no|lack(?:s)?)\s+access\s+to\s+${CAPABILITY_OBJECT}[.!]?$`, "i"),
  new RegExp(String.raw`^${CAPABILITY_SUBJECT}\s+(?:cannot|can't|(?:am|are|is)\s+unable\s+to)\s+(?:execute\s+(?:bash\s+)?commands?|access\s+(?:(?:to\s+)?the\s+|to\s+)?${CAPABILITY_OBJECT}(?:\s+tool)?|(?:run|use)\s+bash)[.!]?$`, "i"),
  new RegExp(String.raw`^${CAPABILITY_SUBJECT}\s+(?:cannot|can't|(?:am|are|is)\s+unable\s+to)\s+execute\s+the\s+required\s+(?:test|command)\s+because\s+(?:its|the)\s+bash(?:\s+command[- ]execution)?\s+tool\s+is\s+unavailable[.!]?$`, "i"),
];

// The historical 09:52 replay used one longer capability-only reason. Keep it
// as an exact whole-value allowlist entry rather than reopening prose search.
const HISTORICAL_0952_CAPABILITY_REASON = "Independent verification is incomplete: this worker exposes only read/grep/find/ls, not bash. I could not independently execute tests, inspect the current full cumulative Git diff, recompute protected hashes/outside-six equality, or verify process cleanup. No files were changed.";

/**
 * Separate verifier capability telemetry from semantic findings. A verifier
 * that reports only an unavailable command surface is retryable
 * infrastructure; mixed responses retain every substantive reason/finding.
 */
export function normalizeVisibleMainVerifierResponse(
  response: VisibleMainVerifierResponse,
  provenance: VerifierCriteriaProvenanceContext = {},
): NormalizedVisibleMainVerifierResponse {
  const parsed = response.parsed ? structuredClone(response.parsed) : null;
  let hasUnclassifiableFailureContent = Boolean(parsed && (
    (Object.prototype.hasOwnProperty.call(parsed, "reasons") && !Array.isArray(parsed.reasons))
    || (Object.prototype.hasOwnProperty.call(parsed, "criterionFindings") && !Array.isArray(parsed.criterionFindings))
  ));
  const rawCapabilityOnly = parsed === null && isCapabilityOnlyCommandUnavailableProse(response.raw);
  const capabilityTelemetry = rawCapabilityOnly ? [response.raw.trim()] : [];
  const substantiveText: string[] = [];
  const classifyText = (text: string): void => {
    if (!text.trim()) {
      hasUnclassifiableFailureContent = true;
    } else if (isCapabilityOnlyCommandText(text)) {
      capabilityTelemetry.push(text);
    } else {
      substantiveText.push(text);
    }
  };

  const reasonValues = Array.isArray(parsed?.reasons) ? parsed.reasons : [];
  if (reasonValues.some((reason) => typeof reason !== "string")) hasUnclassifiableFailureContent = true;
  const rawReasons = reasonValues.filter((reason): reason is string => typeof reason === "string");
  rawReasons.forEach(classifyText);
  if (parsed && Array.isArray(parsed.reasons)) {
    parsed.reasons = rawReasons.filter((reason) => !isCapabilityOnlyCommandText(reason));
  }

  const findings = Array.isArray(parsed?.criterionFindings) ? parsed.criterionFindings : [];
  for (const value of findings) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      hasUnclassifiableFailureContent = true;
      continue;
    }
    const finding = value as Record<string, unknown>;
    if (finding.status !== "pass" && finding.status !== "fail") hasUnclassifiableFailureContent = true;
    if (!Array.isArray(finding.evidence)) {
      hasUnclassifiableFailureContent = true;
      continue;
    }
    for (const value of finding.evidence) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        hasUnclassifiableFailureContent = true;
        continue;
      }
      const evidence = value as Record<string, unknown>;
      if (typeof evidence.observed !== "string") {
        hasUnclassifiableFailureContent = true;
        continue;
      }
      classifyText(evidence.observed);
      collectTextValuesExcept(evidence, new Set(["kind", "observed", "exitCode"])).forEach(classifyText);
    }
    collectTextValuesExcept(finding, new Set(["criterionId", "status", "evidence"])).forEach(classifyText);
  }
  if (parsed) {
    collectTextValuesExcept(parsed, new Set(["status", "reasons", "criterionFindings"])).forEach(classifyText);
    const outsideJson = rawTextOutsideParsedJson(response);
    if (outsideJson) classifyText(outsideJson);
  }

  const capabilityOnlyFailure = rawCapabilityOnly || (parsed?.status === "fail"
    && capabilityTelemetry.length > 0
    && substantiveText.length === 0
    && !hasUnclassifiableFailureContent);

  const presentation = normalizeInferredPresentationFailure(parsed, provenance, hasUnclassifiableFailureContent);

  return {
    ...response,
    parsed,
    capabilityTelemetry: [...new Set(capabilityTelemetry)],
    inferredPresentationTelemetry: presentation.telemetry,
    ...(presentation.normalized
      ? {
          presentationNormalization: {
            strategy: "inferred_presentation_advisory" as const,
            originalStatus: "fail" as const,
            normalizedStatus: "pass" as const,
          },
        }
      : {}),
    ...(capabilityOnlyFailure
      ? {
          commandUnavailable: {
            code: "command_unavailable" as const,
            message: capabilityTelemetry.join("; "),
            retryAllowed: true as const,
            retryEligible: true as const,
          },
        }
      : {}),
  };
}

const INFERRED_PRESENTATION_FAILURE = /\b(?:single[- ]line|multiple lines|more than one (?:output )?line|line[- ]count)\b/i;
const OUTPUT_PRESENTATION_SUBJECT = /\b(?:executor|response|output|answer)\b/i;
const PRESENTATION_ENFORCEMENT = /\b(?:violat(?:e|es|ed|ing|ion)|requirement|format|rule)\b/i;

function isInferredPresentationFailureText(text: string): boolean {
  return INFERRED_PRESENTATION_FAILURE.test(text)
    && OUTPUT_PRESENTATION_SUBJECT.test(text)
    && PRESENTATION_ENFORCEMENT.test(text);
}

/**
 * Repair only the narrow false-negative where a verifier says the substantive
 * criterion is supported but marks it FAIL solely for an inferred line-count
 * rule. Unknown provenance, explicit owner formatting, nonzero evidence, and
 * any semantic failure reason remain untouched.
 */
function normalizeInferredPresentationFailure(
  parsed: Record<string, unknown> | null,
  provenance: VerifierCriteriaProvenanceContext,
  hasUnclassifiableFailureContent: boolean,
): { normalized: boolean; telemetry: string[] } {
  if (
    !parsed
    || parsed.status !== "fail"
    || hasUnclassifiableFailureContent
    || provenance.executorOutputContractSource !== "inferred"
    || !Array.isArray(provenance.plannerInferredPresentationRules)
    || provenance.plannerInferredPresentationRules.length === 0
  ) return { normalized: false, telemetry: [] };

  const reasons = Array.isArray(parsed.reasons)
    ? parsed.reasons.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    : [];
  if (reasons.length === 0 || !reasons.every(isInferredPresentationFailureText)) {
    return { normalized: false, telemetry: [] };
  }

  const findings = Array.isArray(parsed.criterionFindings) ? parsed.criterionFindings : [];
  const failedFindings = findings.filter((value) => value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).status === "fail") as Array<Record<string, unknown>>;
  if (failedFindings.length === 0) return { normalized: false, telemetry: [] };

  const telemetry = [...reasons];
  let hasGroundedSubstantiveEvidence = false;
  for (const finding of failedFindings) {
    if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) return { normalized: false, telemetry: [] };
    let findingNamesPresentationCause = false;
    for (const value of finding.evidence) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return { normalized: false, telemetry: [] };
      const evidence = value as Record<string, unknown>;
      if (typeof evidence.exitCode === "number" && evidence.exitCode !== 0) return { normalized: false, telemetry: [] };
      if (typeof evidence.observed !== "string" || !evidence.observed.trim()) return { normalized: false, telemetry: [] };
      if (isInferredPresentationFailureText(evidence.observed)) {
        telemetry.push(evidence.observed);
        findingNamesPresentationCause = true;
      } else {
        hasGroundedSubstantiveEvidence = true;
      }
    }
    if (!findingNamesPresentationCause) return { normalized: false, telemetry: [] };
  }
  if (!hasGroundedSubstantiveEvidence) return { normalized: false, telemetry: [] };

  parsed.status = "pass";
  for (const finding of failedFindings) finding.status = "pass";
  return { normalized: true, telemetry: [...new Set(telemetry)] };
}

/** Collect text from extension fields; contract fields are handled explicitly. */
function collectTextValuesExcept(record: Record<string, unknown>, excludedKeys: Set<string>): string[] {
  const text: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") text.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach(visit);
  };
  for (const [key, value] of Object.entries(record)) {
    if (!excludedKeys.has(key)) visit(value);
  }
  return text;
}

/** Return only prose discarded around the parsed JSON; fences are structural. */
function rawTextOutsideParsedJson(response: VisibleMainVerifierResponse): string {
  if (response.recovery && objectToEof(response.raw)) return "";
  const object = extractBalancedObject(response.raw);
  if (!object) return response.raw.trim();
  const start = response.raw.indexOf(object);
  return `${response.raw.slice(0, start)}\n${response.raw.slice(start + object.length)}`
    .replace(/```(?:json|text)?/gi, "")
    .trim();
}

const NO_MUTATION_SELF_REPORT_PATTERN = /^(?:no\s+(?:workspace\s+)?files?\s+were\s+(?:changed|modified|added|deleted)|i\s+(?:did\s+not|didn't)\s+(?:change|modify|add|delete)\s+(?:any\s+)?files?|the\s+workspace\s+(?:was|remained)\s+unchanged)[.!]?$/i;

function isCapabilityStatement(text: string): boolean {
  const value = text.trim().replace(/\s+/g, " ");
  return CAPABILITY_STATEMENT_PATTERNS.some((pattern) => pattern.test(value));
}

/** Match only a complete allowlisted capability value, never a substring. */
function isCapabilityOnlyCommandText(text: string): boolean {
  const normalized = String(text).trim();
  if (!normalized) return false;
  if (normalized === HISTORICAL_0952_CAPABILITY_REASON) return true;
  const statements = normalized
    .split(/(?:\r?\n)+|(?<=[.!?])\s+/)
    .map((statement) => statement.trim())
    .filter(Boolean);
  return statements.length > 0
    && statements.some(isCapabilityStatement)
    && statements.every((statement) => isCapabilityStatement(statement) || NO_MUTATION_SELF_REPORT_PATTERN.test(statement));
}

/**
 * Recognize plain-text infrastructure only when the complete unfenced response
 * consists of allowlisted capability statements and optional no-mutation
 * telemetry. Malformed JSON and mixed semantic prose fail closed.
 */
function isCapabilityOnlyCommandUnavailableProse(text: string): boolean {
  const normalized = String(text).trim().replace(/^```(?:text)?\s*/i, "").replace(/\s*```$/, "").trim();
  return Boolean(normalized) && !/^[{[]/.test(normalized) && isCapabilityOnlyCommandText(normalized);
}

const MAX_INFERRED_CLOSERS = 2;
const SEMANTIC_FALLBACK_CLOSERS = 3;
const SEMANTIC_ROOT_STATUS_PATTERN = /^\s*\{\s*"status"\s*:\s*"(?:pass|fail)"\s*,/;
const SEMANTIC_FINDINGS_FIELD_PATTERN = /"criterionFindings"\s*:\s*\[/;

/**
 * Parse a verifier response without relaxing the shared/general JSON parser.
 * Recovery is limited to an otherwise valid object missing at most two closing
 * array/object delimiters at EOF. Incomplete strings, primitives, mismatched
 * delimiters, and corruption in the middle remain hard parse failures.
 */
export function parseVisibleMainVerifierResponse(text: string): VisibleMainVerifierResponse {
  const raw = text;
  for (const candidate of strictCandidates(text)) {
    const parsed = parseRecord(candidate);
    if (parsed) return { parsed, raw, diagnostics: [] };
  }

  const candidate = objectToEof(text);
  const appendedSuffix = candidate ? inferClosingSuffix(candidate) : null;
  if (candidate && appendedSuffix) {
    const parsed = parseRecord(candidate.trimEnd() + appendedSuffix);
    // Closing-suffix recovery may restore JSON structure only. Reject a
    // duplicate/contradictory root verdict or an incomplete finding envelope
    // here rather than letting JSON.parse's last-key-wins behavior invent an
    // authoritative semantic result.
    if (parsed && isCompleteSemanticVerdict(parsed, candidate)) {
      return {
        parsed,
        raw,
        recovery: { strategy: "eof_closing_suffix", appendedSuffix },
        diagnostics: [{
          code: "verifier_json_eof_suffix_recovered",
          message: `Verifier JSON ended at EOF with a complete value but omitted ${appendedSuffix.length} closing delimiter(s); inferred ${JSON.stringify(appendedSuffix)}.`,
          advisory: true,
        }],
      };
    }
  }

  // Keep the broad, syntax-preserving repair above as the first recovery
  // attempt. The fallback below recognizes only the verifier contract's root
  // status and a semantically complete criterionFindings collection. It then
  // reparses the entire reconstructed payload, so regex recognition cannot
  // skip unrelated corruption or dangling values.
  const semanticallyExtracted = candidate ? extractSemanticVerifierFields(candidate) : null;
  if (semanticallyExtracted) {
    return {
      parsed: semanticallyExtracted,
      raw,
      recovery: { strategy: "semantic_field_extraction", extractedFields: ["status", "criterionFindings"] },
      diagnostics: [{
        code: "verifier_json_semantic_fallback",
        message: "Verifier JSON could not use bounded EOF repair; conservatively extracted one root status and complete criterionFindings from the recognizable reviewer contract.",
        advisory: true,
      }],
    };
  }

  return {
    parsed: null,
    raw,
    diagnostics: [{
      code: "invalid_verifier_json",
      message: "Verifier output was not valid JSON and was not eligible for bounded EOF closing-suffix recovery.",
      advisory: false,
    }],
  };
}

function strictCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates = [trimmed, ...extractFenceContents(trimmed)];
  const balanced = extractBalancedObject(trimmed);
  if (balanced) candidates.push(balanced);
  return [...new Set(candidates.filter(Boolean))];
}

function parseRecord(candidate: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(candidate);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function extractSemanticVerifierFields(candidate: string): Record<string, unknown> | null {
  if (!SEMANTIC_ROOT_STATUS_PATTERN.test(candidate) || !SEMANTIC_FINDINGS_FIELD_PATTERN.test(candidate)) return null;

  // A complete final evidence array followed by EOF can omit exactly the
  // finding object, criterionFindings array, and root object closers. Anything
  // deeper means a required finding value is itself incomplete.
  const suffix = inferClosingSuffix(candidate, true, SEMANTIC_FALLBACK_CLOSERS);
  if (suffix !== "}]}") return null;
  const parsed = parseRecord(candidate.trimEnd() + suffix);
  if (!parsed || !isCompleteSemanticVerdict(parsed, candidate)) return null;
  return parsed;
}

function isCompleteSemanticVerdict(parsed: Record<string, unknown>, source: string): boolean {
  const rootProperties = topLevelPropertyNames(source);
  if (rootProperties.filter((name) => name === "status").length !== 1) return false;
  if (rootProperties.filter((name) => name === "reasons").length !== 1) return false;
  if (rootProperties.filter((name) => name === "criterionFindings").length !== 1) return false;
  if (parsed.status !== "pass" && parsed.status !== "fail") return false;
  if (!Array.isArray(parsed.reasons) || parsed.reasons.some((reason) => typeof reason !== "string")) return false;
  if (!Array.isArray(parsed.criterionFindings) || parsed.criterionFindings.length === 0) return false;

  const criterionIds = new Set<string>();
  let hasFailedFinding = false;
  for (const value of parsed.criterionFindings) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const finding = value as Record<string, unknown>;
    if (typeof finding.criterionId !== "string" || !finding.criterionId.trim()) return false;
    if (finding.status !== "pass" && finding.status !== "fail") return false;
    if (finding.status === "fail") hasFailedFinding = true;
    if (!Array.isArray(finding.evidence)) return false;
    if (criterionIds.has(finding.criterionId)) return false;
    criterionIds.add(finding.criterionId);
  }
  // A root PASS cannot contradict a failed criterion. A root FAIL remains a
  // genuine semantic stop even when every per-criterion finding passed (for
  // example, an overall safety reason outside one finding's evidence).
  return parsed.status !== "pass" || !hasFailedFinding;
}

/**
 * Decide whether a recovered verdict is complete enough for ordinary terminal
 * settlement. Parsing proves that only EOF closers were supplied; this check
 * binds the recovered findings to the frozen criterion IDs and requires each
 * conclusion to retain at least one complete evidence observation.
 */
export function assessRecoveredVerifierSettlement(
  response: VisibleMainVerifierResponse,
  expectedCriterionIds: readonly string[],
): RecoveredVerifierSettlementAssessment {
  const issues: string[] = [];
  if (!response.recovery) issues.push("response did not use bounded verifier recovery");
  const parsed = response.parsed;
  if (!parsed) return { terminalEligible: false, issues: [...issues, "recovered response has no parsed verdict"] };

  const expected = new Set(expectedCriterionIds);
  if (expected.size !== expectedCriterionIds.length || expected.size === 0 || [...expected].some((id) => !id.trim())) {
    issues.push("frozen criterion identity set is invalid");
  }
  if (parsed.status !== "pass" && parsed.status !== "fail") issues.push("root status is missing or invalid");
  if (!Array.isArray(parsed.reasons) || parsed.reasons.some((reason) => typeof reason !== "string")) {
    issues.push("reasons collection is missing or invalid");
  }

  const findings = Array.isArray(parsed.criterionFindings) ? parsed.criterionFindings : [];
  if (!Array.isArray(parsed.criterionFindings) || findings.length === 0) issues.push("criterion findings are missing or empty");
  const seen = new Set<string>();
  let failedCount = 0;
  for (const value of findings) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push("criterion finding is not an object");
      continue;
    }
    const finding = value as Record<string, unknown>;
    const criterionId = typeof finding.criterionId === "string" ? finding.criterionId : "";
    if (!criterionId || !expected.has(criterionId)) issues.push(`unexpected or missing criterion id ${JSON.stringify(criterionId)}`);
    if (seen.has(criterionId)) issues.push(`duplicate criterion finding ${JSON.stringify(criterionId)}`);
    seen.add(criterionId);
    if (finding.status !== "pass" && finding.status !== "fail") issues.push(`invalid status for ${criterionId || "unnamed criterion"}`);
    if (finding.status === "fail") failedCount += 1;

    const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
    if (!Array.isArray(finding.evidence) || evidence.length === 0) {
      issues.push(`missing evidence for ${criterionId || "unnamed criterion"}`);
      continue;
    }
    for (const evidenceValue of evidence) {
      if (!evidenceValue || typeof evidenceValue !== "object" || Array.isArray(evidenceValue)) {
        issues.push(`invalid evidence for ${criterionId || "unnamed criterion"}`);
        continue;
      }
      const item = evidenceValue as Record<string, unknown>;
      if (typeof item.kind !== "string" || !item.kind.trim()) issues.push(`missing evidence kind for ${criterionId || "unnamed criterion"}`);
      if (typeof item.observed !== "string" || !item.observed.trim()) issues.push(`missing evidence observation for ${criterionId || "unnamed criterion"}`);
      if (Object.prototype.hasOwnProperty.call(item, "exitCode") && !Number.isInteger(item.exitCode)) {
        issues.push(`invalid evidence exit code for ${criterionId || "unnamed criterion"}`);
      }
    }
  }
  for (const criterionId of expected) if (!seen.has(criterionId)) issues.push(`missing finding for ${criterionId}`);
  if (parsed.status === "pass" && failedCount > 0) issues.push("root PASS contradicts a failed criterion");

  return { terminalEligible: issues.length === 0, issues: [...new Set(issues)] };
}

/** Collect object keys at root depth without confusing strings or nested evidence for keys. */
function topLevelPropertyNames(source: string): string[] {
  const names: string[] = [];
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  let stringStart = -1;

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') {
        inString = false;
        if (stack.length === 1 && stack[0] === "}") {
          let cursor = index + 1;
          while (/\s/.test(source[cursor] ?? "")) cursor++;
          if (source[cursor] === ":") {
            try {
              names.push(JSON.parse(source.slice(stringStart, index + 1)) as string);
            } catch {
              return [];
            }
          }
        }
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      stringStart = index;
    } else if (char === "{") {
      stack.push("}");
    } else if (char === "[") {
      stack.push("]");
    } else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return [];
    }
  }
  return inString ? [] : names;
}

function extractFenceContents(text: string): string[] {
  const results: string[] = [];
  const regex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) results.push(match[1].trim());
  return results;
}

function extractBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const suffix = inferClosingSuffix(text.slice(start), false);
  if (suffix !== "") return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  return null;
}

function objectToEof(text: string): string | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  const prefix = trimmed.slice(0, start).trim();
  if (prefix && !/^```(?:json)?$/i.test(prefix)) return null;
  return trimmed.slice(start).replace(/\s*```\s*$/, "");
}

/** Return missing closers, an empty string when balanced, or null when unsafe. */
function inferClosingSuffix(candidate: string, requireMissing = true, maxClosers = MAX_INFERRED_CLOSERS): string | null {
  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (const char of candidate) {
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      stack.push("}");
    } else if (char === "[") {
      stack.push("]");
    } else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return null;
    }
  }

  if (inString || escape) return null;
  if (stack.length === 0) return requireMissing ? null : "";
  if (!requireMissing) return null;
  if (stack.length > maxClosers) return null;
  // Recovery may only close a completed structured value, never guess the end
  // of a string, number, boolean, null, object member, or array element.
  if (!/[}\]]\s*$/.test(candidate)) return null;
  return [...stack].reverse().join("");
}
