import { estimateTokens } from "@earendil-works/pi-coding-agent";

/**
 * Pre-spawn worker admission against the complete launcher assembly.
 *
 * Pi's public estimateTokens() is a chars/4 estimate, not a tokenizer or an
 * exact provider count. Admission therefore reports it honestly and applies a
 * fixed host uncertainty margin plus a framing/tool allowance. The complete
 * SDK-assembled system prompt, final user prompt, and active tool schemas are
 * all measured; no binding text or evidence is removed to make a request fit.
 */

export type BudgetRiskLevel = "SAFE" | "AT_RISK" | "CRITICAL";
export type BudgetRecommendation = "PROCEED" | "SPLIT_BEFORE_SPAWN" | "REDUCE_SCOPE";

export const DEFAULT_REPLY_RESERVE_TOKENS = 16_384;
export const ADMISSION_ESTIMATE_MARGIN_PERCENT = 25;
export const ADMISSION_FRAMING_ALLOWANCE_TOKENS = 4_096;
export const ADMISSION_MEASUREMENT_METHOD = "pi-estimateTokens-with-fixed-host-allowances" as const;

export interface PromptSectionEstimate {
  name: "completeSystemPrompt" | "userPrompt" | "activeToolSchemas";
  chars: number;
  utf8Bytes: number;
  /** Pi estimateTokens() result; an estimate, not an exact tokenizer count. */
  estimatedTokens: number;
}

export interface ContextBudget {
  /** Characters across the complete measured system/user/tool sections. */
  promptChars: number;
  /** UTF-8 bytes across measured sections, retained as diagnostics only. */
  promptUtf8Bytes: number;
  /** Margin-adjusted input estimate used for admission. */
  estimatedPromptTokens: number;
  /** Alias that makes the admission quantity explicit to new callers. */
  admissionInputTokens: number;
  /** Sum of Pi's per-section estimates before host allowances. */
  baseEstimatedInputTokens: number;
  maxAgentContextTokens: number;
  saturationPercent: number;
  risk: BudgetRiskLevel;
  recommendation: BudgetRecommendation;
  /** Total host allowance: uncertainty margin, framing allowance, and reply reserve. */
  reservedOverheadTokens: number;
  usableBudgetTokens: number;
  measurementMethod: typeof ADMISSION_MEASUREMENT_METHOD;
  measurementCaveat: string;
  sections: PromptSectionEstimate[];
  marginPercent: number;
  estimateMarginTokens: number;
  framingAllowanceTokens: number;
  replyReserveTokens: number;
  modelOutputCapabilityTokens: number;
  availableInputTokens: number;
}

/**
 * Legacy diagnostic API retained for historical shapes. It is intentionally
 * non-authoritative and never recommends a pre-spawn split; the complete
 * launcher admission below owns spawn decisions.
 */
export function estimateExecutorContextBudget(
  promptChars: number,
  _legacyModelId?: string,
  _legacyOptions?: { criticalThreshold?: number },
): ContextBudget {
  return {
    promptChars,
    promptUtf8Bytes: Math.max(0, promptChars),
    estimatedPromptTokens: Math.max(0, promptChars),
    admissionInputTokens: Math.max(0, promptChars),
    baseEstimatedInputTokens: Math.max(0, promptChars),
    maxAgentContextTokens: Number.MAX_SAFE_INTEGER,
    saturationPercent: 0,
    risk: "SAFE",
    recommendation: "PROCEED",
    reservedOverheadTokens: 0,
    usableBudgetTokens: Number.MAX_SAFE_INTEGER,
    measurementMethod: ADMISSION_MEASUREMENT_METHOD,
    measurementCaveat: "Legacy character diagnostic only; not an exact token count.",
    sections: [],
    marginPercent: 0,
    estimateMarginTokens: 0,
    framingAllowanceTokens: 0,
    replyReserveTokens: 0,
    modelOutputCapabilityTokens: 0,
    availableInputTokens: Number.MAX_SAFE_INTEGER,
  };
}

/** Historical task splitting is disabled; complete launcher admission supersedes it. */
export function computeAdaptiveTaskSizeCap(_legacyModelId?: string): number {
  return Number.MAX_SAFE_INTEGER;
}

export interface WorkerPromptCapacityInput {
  /** Exact user prompt sent to the child. */
  prompt: string;
  /** Pi's fully assembled prompt, including context files, skills and role text. */
  completeSystemPrompt: string;
  /** Exact active tool definitions from the assembled Pi session. */
  toolSchemas: unknown;
  /** Context window from the exact launcher-selected Model. */
  contextWindow: number;
  /** Maximum output capability from that same configured Model. */
  maxOutputTokens: number;
  modelId?: string;
  bindingSection?: string;
}

function estimateTextSection(
  name: PromptSectionEstimate["name"],
  text: string,
): PromptSectionEstimate {
  const estimatedTokens = estimateTokens({
    role: "user",
    content: text,
    timestamp: 0,
  });
  if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 0) {
    throw new Error(
      `BINDING_PROMPT_CAPACITY_UNRESOLVED: Pi estimateTokens returned invalid estimated tokens for ${name}: ${String(estimatedTokens)}.`,
    );
  }
  return {
    name,
    chars: text.length,
    utf8Bytes: Buffer.byteLength(text, "utf8"),
    estimatedTokens,
  };
}

function serializeToolSchemas(toolSchemas: unknown): string {
  try {
    const serialized = JSON.stringify(toolSchemas);
    if (serialized === undefined) {
      throw new Error("serialization produced undefined");
    }
    return serialized;
  } catch (error) {
    throw new Error(
      `BINDING_PROMPT_CAPACITY_UNRESOLVED: active tool schemas could not be serialized for estimation: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

function formatSectionDiagnostics(sections: PromptSectionEstimate[]): string {
  return sections
    .map((section) =>
      `${section.name}=${section.estimatedTokens} estimated token(s) ` +
      `(${section.chars} chars, ${section.utf8Bytes} UTF-8 bytes)`,
    )
    .join("; ");
}

/**
 * Refuse before spawn when the complete margin-adjusted estimate plus a
 * realistic reply reserve exceeds the configured context window.
 *
 * Policy (fixed, not tuned per prompt):
 *   E = sum(Pi estimateTokens(section))
 *   admissionInput = E + ceil(E * 25%) + 4096
 *   replyReserve = min(model.maxTokens, 16384)
 */
export function assertWorkerPromptFitsCapacity(input: WorkerPromptCapacityInput): ContextBudget {
  if (!Number.isSafeInteger(input.contextWindow) || input.contextWindow <= 0) {
    throw new Error(`BINDING_PROMPT_CAPACITY_UNRESOLVED: invalid launcher contextWindow ${String(input.contextWindow)}.`);
  }
  if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 0) {
    throw new Error(`BINDING_PROMPT_CAPACITY_UNRESOLVED: invalid launcher maxTokens ${String(input.maxOutputTokens)}.`);
  }

  const toolSchemasText = serializeToolSchemas(input.toolSchemas);
  const sections = [
    estimateTextSection("completeSystemPrompt", input.completeSystemPrompt),
    estimateTextSection("userPrompt", input.prompt),
    estimateTextSection("activeToolSchemas", toolSchemasText),
  ];
  const baseEstimatedInputTokens = sections.reduce((sum, section) => sum + section.estimatedTokens, 0);
  if (!Number.isSafeInteger(baseEstimatedInputTokens)) {
    throw new Error("BINDING_PROMPT_CAPACITY_UNRESOLVED: summed input estimate is not a safe integer.");
  }

  const estimateMarginTokens = Math.ceil(
    baseEstimatedInputTokens * ADMISSION_ESTIMATE_MARGIN_PERCENT / 100,
  );
  const admissionInputTokens = baseEstimatedInputTokens
    + estimateMarginTokens
    + ADMISSION_FRAMING_ALLOWANCE_TOKENS;
  if (!Number.isSafeInteger(admissionInputTokens)) {
    throw new Error("BINDING_PROMPT_CAPACITY_UNRESOLVED: margin-adjusted input estimate is not a safe integer.");
  }

  const replyReserveTokens = Math.min(input.maxOutputTokens, DEFAULT_REPLY_RESERVE_TOKENS);
  const availableInputTokens = Math.max(0, input.contextWindow - replyReserveTokens);
  const promptChars = sections.reduce((sum, section) => sum + section.chars, 0);
  const promptUtf8Bytes = sections.reduce((sum, section) => sum + section.utf8Bytes, 0);
  const saturationPercent = Math.round((admissionInputTokens / input.contextWindow) * 100);
  const risk: BudgetRiskLevel = admissionInputTokens > availableInputTokens
    ? "CRITICAL"
    : saturationPercent >= 80 ? "AT_RISK" : "SAFE";
  const budget: ContextBudget = {
    promptChars,
    promptUtf8Bytes,
    estimatedPromptTokens: admissionInputTokens,
    admissionInputTokens,
    baseEstimatedInputTokens,
    maxAgentContextTokens: input.contextWindow,
    saturationPercent,
    risk,
    recommendation: risk === "CRITICAL" ? "REDUCE_SCOPE" : "PROCEED",
    reservedOverheadTokens: estimateMarginTokens + ADMISSION_FRAMING_ALLOWANCE_TOKENS + replyReserveTokens,
    usableBudgetTokens: Math.max(0, availableInputTokens - admissionInputTokens),
    measurementMethod: ADMISSION_MEASUREMENT_METHOD,
    measurementCaveat:
      "Estimated with Pi estimateTokens, not an exact tokenizer/provider count; the host adds a fixed 25% uncertainty margin and 4096-token framing/tool allowance.",
    sections,
    marginPercent: ADMISSION_ESTIMATE_MARGIN_PERCENT,
    estimateMarginTokens,
    framingAllowanceTokens: ADMISSION_FRAMING_ALLOWANCE_TOKENS,
    replyReserveTokens,
    modelOutputCapabilityTokens: input.maxOutputTokens,
    availableInputTokens,
  };

  if (admissionInputTokens > availableInputTokens) {
    const section = input.bindingSection ?? "binding owner instructions and acceptance criteria";
    throw new Error(
      `BINDING_PROMPT_CAPACITY_REFUSED: section ${JSON.stringify(section)} does not fit configured ` +
      `${input.modelId ?? "default"} capacity with the complete Pi prompt and active tool schemas. ` +
      `Estimated input for admission ${admissionInputTokens} token(s), available input ${availableInputTokens}; ` +
      `sections: ${formatSectionDiagnostics(sections)}; base estimate ${baseEstimatedInputTokens}, ` +
      `${ADMISSION_ESTIMATE_MARGIN_PERCENT}% uncertainty margin ${estimateMarginTokens}, ` +
      `${ADMISSION_FRAMING_ALLOWANCE_TOKENS} framing/tool allowance, ${replyReserveTokens} reply reserve ` +
      `(model output capability ${input.maxOutputTokens}). This is an estimate, not an exact tokenizer/provider count. ` +
      "No worker was spawned and no binding text was truncated.",
    );
  }
  return budget;
}
