/**
 * Shape: shape-builder
 * =====================
 * Deterministic meta-orchestration for creating new reusable orchestration
 * shapes. Manages full lifecycle gating:
 *
 *   proposed -> implementation_reported -> implemented_verified
 *   -> (parent reload + discovery + canary) -> canary_passed
 *
 * V1 is explicit-only and mutates only within the resolved extension root.
 * It does not reload the runtime, schedule continuations, or mark a
 * generated shape usable before post-reload discovery and canary.
 *
 * ONE-LINE RULE: Shapes are siblings — they stand on the substrate, never
 * build on each other.
 */

import {
  SpawnGuard,
  spawnSubagent,
  throwIfAborted,
  truncateWithNotice,
  type AgentProfile,
} from "../substrate";

import type {
  OrchestrationShape,
  OrchestrationShapeContext,
  OrchestrationShapeResult,
  NormalizedParams,
} from "../types";

import {
  normalizeShapeName,
  parseShapeBuilderSpecFromTask,
  validateShapeBuilderSpec,
  resolveExtensionRoot,
  verifyExtensionRoot,
  resolveInRoot,
  buildInitialLifecycleState,
  writeLifecycleState,
  readLifecycleState,
  transitionAndUpdateState,
  recordFailure,
  renderShapeSource,
  renderShapeTest,
  staticCheckGeneratedShape,
  lifecycleStatePath,
  applyAnchoredEdit,
  buildContinuationTemplate,
  buildImplementationVerifierPrompt,
  parseVerifierJson,
  reloadDiagnosticsPath,
  computeNextRequiredGate,
  RESERVED_SHAPE_NAMES,
  SHAPE_BUILDER_VERIFIER_MARKER,
  type ShapeBuilderLifecycleState,
  type ShapeBuilderAnchoredEdit,
  type ShapeBuilderSpec,
  type ShapeBuilderVerifierJson,
} from "../shape-builder-support";

import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolveShapePhaseRoute } from "../routes";

// ── Shape export ──────────────────────────────────────────────────────────

export const shapeBuilderShape: OrchestrationShape = {
  name: "shape-builder",
  description:
    "Deterministic meta-constructor for creating new orchestration shapes " +
    "with full lifecycle gating. V1 is explicit-only: creates shape source, " +
    "tests, registry/docs edits, runs independent verification, and returns " +
    "reloadRequired:true when verified. Must be selected explicitly via " +
    "--paradigm shape-builder.",
  run: runShapeBuilder,
};

// ── Main orchestration ────────────────────────────────────────────────────

async function runShapeBuilder(
  context: OrchestrationShapeContext,
): Promise<OrchestrationShapeResult> {
  const { params, signal, onUpdate, inheritedModel, agents } = context;
  const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }] });
  const spawnGuard = new SpawnGuard(Math.min(params.maxSubagents, 2));

  emit("Shape-builder: deterministic meta-constructor starting. V1 explicit-only with lifecycle gating.");
  throwIfAborted(signal);

  // ── Step 1: Parse spec ────────────────────────────────────────────────
  emit("Shape-builder: parsing spec JSON from task...");
  const parsed = parseShapeBuilderSpecFromTask(params.task);
  if ("error" in parsed) {
    return failResult("proposed", `Spec parse failed: ${parsed.error}`, spawnGuard);
  }
  const spec: ShapeBuilderSpec = parsed;

  // ── Step 2: Resolve extension root ─────────────────────────────────────
  const extensionRoot = resolveExtensionRoot(import.meta.url);
  emit(`Shape-builder: resolved extension root = ${extensionRoot}`);
  const rootErrors = verifyExtensionRoot(extensionRoot);
  if (rootErrors.length > 0) {
    return failResult("proposed", `Extension root validation failed: ${rootErrors.join("; ")}`, spawnGuard);
  }

  // ── Step 3: Validate spec against reserved names ────────────────────────
  const reserved = new Set([
    ...RESERVED_SHAPE_NAMES,
    // Also reserve name=shape-builder itself to prevent the shape from self-overwriting
  ]);
  const specErrors = validateShapeBuilderSpec(spec, reserved);
  if (specErrors.length > 0) {
    return failResult("proposed", `Spec validation failed: ${specErrors.join("; ")}`, spawnGuard);
  }

  const targetName = normalizeShapeName(spec.targetName);
  emit(`Shape-builder: target "${targetName}" spec validated.`);

  // ── Step 4: Render generated sources ───────────────────────────────────
  const shapeSource = renderShapeSource(spec);
  const testSource = renderShapeTest(targetName);
  const staticErrors = staticCheckGeneratedShape(shapeSource);
  if (staticErrors.length > 0) {
    return failResult("proposed", `Generated source static checks failed: ${staticErrors.join("; ")}`, spawnGuard);
  }

  // ── Step 5: Compute file paths and anchored edits ───────────────────────
  const shapeFilePath = `src/shapes/${targetName}.ts`;
  const testFilePath = `tests/test-${targetName}.cjs`;
  const generatedFiles = [shapeFilePath, testFilePath];

  const anchoredEdits: ShapeBuilderAnchoredEdit[] = [
    // index.ts: import
    {
      path: "src/index.ts",
      anchor: "// shape-builder generated imports:end",
      action: "insert",
      content: `import { ${toIdentifierName(targetName)} } from "./shapes/${targetName}";`,
    },
    // index.ts: registry entry
    {
      path: "src/index.ts",
      anchor: "// shape-builder generated registry entries:end",
      action: "insert",
      content: `  ["${targetName}", ${toIdentifierName(targetName)}],`,
    },
    // index.ts: paradigm valid-values name
    {
      path: "src/index.ts",
      anchor: "// shape-builder generated paradigm names:end",
      action: "insert",
      content: `  "${targetName}",`,
    },
    // package.json: deterministic test script append
    {
      path: "package.json",
      anchor: "scripts.test.append",
      action: "insert",
      content: `node tests/test-${targetName}.cjs`,
    },
    // README.md: generated shapes
    {
      path: "README.md",
      anchor: "<!-- shape-builder:generated-shapes:end -->",
      action: "insert",
      content: `- \`${targetName}\`: ${spec.userFacingExplanation}`,
    },
    // PARADIGMS.md: generated shapes
    {
      path: "PARADIGMS.md",
      anchor: "<!-- shape-builder:generated-shapes:end -->",
      action: "insert",
      content: `- \`${targetName}\`: ${spec.userFacingExplanation}`,
    },
  ];

  // ── Step 6: Create lifecycle state at "proposed" ────────────────────────
  const lifecycle = buildInitialLifecycleState(extensionRoot, targetName, generatedFiles, anchoredEdits);
  const statePath = lifecycle.lifecycleStatePath;
  await writeLifecycleState(lifecycle);
  emit(`Shape-builder: lifecycle state written at "proposed" → ${statePath}.`);

  // ── Step 7: Write generated files ──────────────────────────────────────
  emit("Shape-builder: writing generated shape and test sources...");
  const shapeAbs = resolveInRoot(extensionRoot, shapeFilePath);
  const testAbs = resolveInRoot(extensionRoot, testFilePath);

  // Check if files already exist
  for (const [relPath, absPath, content] of [
    [shapeFilePath, shapeAbs, shapeSource],
    [testFilePath, testAbs, testSource],
  ] as const) {
    if (existsSync(absPath)) {
      const existing = await readFile(absPath, "utf8");
      if (existing !== content) {
        return failResult("proposed", `File already exists and differs: ${relPath}`, spawnGuard);
      }
    } else {
      await writeFile(absPath, content, "utf8");
    }
  }

  // Apply anchored edits
  emit("Shape-builder: applying anchored edits...");
  for (const edit of anchoredEdits) {
    const result = await applyAnchoredEdit(extensionRoot, edit);
    if (!result.ok) {
      return failResult("proposed", `Anchored edit failed: ${edit.path} — ${result.error}`, spawnGuard);
    }
  }

  // ── Step 8: Run local deterministic checks ──────────────────────────────
  emit("Shape-builder: running local deterministic checks...");

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

  // Run generated test
  const testCmd = `node tests/test-${targetName}.cjs`;
  let testResult;
  try {
    testResult = spawnSync("node", [`tests/test-${targetName}.cjs`], {
      cwd: extensionRoot,
      timeout: 30_000,
      encoding: "utf8",
      windowsHide: true,
    });
  } catch (err) {
    testResult = { status: 1, stdout: "", stderr: String(err) };
  }

  const testPassed = testResult.status === 0;

  // Run npm test
  let npmResult;
  try {
    const npmCommand = process.platform === "win32" ? `${npmCmd} test` : npmCmd;
    const npmArgs = process.platform === "win32" ? [] : ["test"];
    npmResult = spawnSync(npmCommand, npmArgs, {
      cwd: extensionRoot,
      timeout: 120_000,
      encoding: "utf8",
      windowsHide: true,
      shell: process.platform === "win32",
    });
  } catch (err) {
    npmResult = { status: 1, stdout: "", stderr: String(err) };
  }

  const npmPassed = npmResult.status === 0;

  // ── Step 9: Transition to implementation_reported ────────────────────────
  const implReport = {
    shapeSourceFile: shapeFilePath,
    testSourceFile: testFilePath,
    anchoredEdits: anchoredEdits.length,
    staticCheckPassed: true,
    generatedTestPassed: testPassed,
    generatedTestOutput: truncateWithNotice(testResult.stdout || testResult.stderr || "", 2000, "test output"),
    npmTestPassed: npmPassed,
    npmTestOutput: truncateWithNotice(npmResult.stdout || npmResult.stderr || "", 2000, "npm test output"),
  };

  if (!testPassed || !npmPassed) {
    const failLifecycle = recordLifecycleFailure(lifecycle, "implementation_report",
      `Local checks failed: generatedTest=${testPassed}, npmTest=${npmPassed}`,
      implReport);
    await writeLifecycleState(failLifecycle);
    return failDetails("implementation_reported",
      `Local checks failed: generatedTest=${testPassed}, npmTest=${npmPassed}`,
      spawnGuard, targetName, statePath, implReport);
  }

  const reportedResult = transitionAndUpdateState(
    lifecycle, "implementation_reported", "shape-builder", { implementationReport: implReport }
  );
  if (!reportedResult.success) {
    return failResult("proposed", `Lifecycle transition failed: ${reportedResult.error}`, spawnGuard);
  }

  const reportedState = {
    ...reportedResult.state,
    implementationReport: implReport,
  };
  await writeLifecycleState(reportedState);
  emit(`Shape-builder: lifecycle → implementation_reported.`);

  // ── Step 10: Spawn independent verifier ─────────────────────────────────
  emit("Shape-builder: spawning independent implementation verifier...");
  const spawned = spawnGuard.reserve();
  emit(`Shape-builder: verifier spawn (${spawned}/${spawnGuard.cap}).`);

  // Clone verifier profile with read/bash/grep tools
  const verifierProfile = buildVerifierAgent(agents, params.verifierAgent);
  const verifierAgents = new Map(agents);
  verifierAgents.set(params.verifierAgent, verifierProfile);

  const verifierPrompt = buildImplementationVerifierPrompt({
    targetName,
    extensionRoot,
    lifecycleStatePath: statePath,
    generatedFiles,
    anchoredEditPaths: anchoredEdits.map((e) => e.path),
    testCommand: testCmd,
  });

  let verifierText: string;
  try {
    const verifierResult = await spawnSubagent(
      params.verifierAgent,
      verifierPrompt,
      {
        agents: verifierAgents,
        cwd: params.cwd,
        allowLocalModel: params.allowLocalModel,
        signal,
        inheritedModel,
        onProgress: emit,
        modelOverride: resolveShapePhaseRoute("verifier", params.verifierAgent, params),
      },
    );
    verifierText = verifierResult.text;
    emit(`Shape-builder: verifier returned (${verifierResult.text.length} chars).`);
  } catch (err) {
    const failState = recordLifecycleFailure(reportedState, "implementation_verification",
      `Verifier spawn failed: ${String(err)}`, {});
    await writeLifecycleState(failState);
    return failDetails("implementation_reported",
      `Verifier spawn failed: ${String(err)}`,
      spawnGuard, targetName, statePath, implReport);
  }

  // ── Step 11: Parse verifier JSON ────────────────────────────────────────
  const verification = parseVerifierJson(verifierText, targetName, statePath);
  if ("error" in verification) {
    const failState = recordLifecycleFailure(reportedState, "implementation_verification",
      `Verifier parse/validation failed: ${verification.error}`,
      { verifierText: truncateWithNotice(verifierText, 2000, "verifier raw") });
    await writeLifecycleState(failState);
    return failDetails("implementation_reported",
      `Verifier returned invalid response: ${verification.error}`,
      spawnGuard, targetName, statePath, implReport);
  }

  if (verification.overall !== "pass") {
    const failState = recordLifecycleFailure(reportedState, "implementation_verification",
      `Verifier returned overall: fail. Reasons: ${verification.failReasons.join("; ")}`,
      { verification });
    await writeLifecycleState(failState);
    return failDetails("implementation_reported",
      `Verifier FAIL: ${verification.failReasons.join("; ")}`,
      spawnGuard, targetName, statePath, implReport);
  }

  // ── Step 12: Transition to implemented_verified ─────────────────────────
  const verifiedResult = transitionAndUpdateState(
    reportedState, "implemented_verified", "shape-builder", { verification }
  );
  if (!verifiedResult.success) {
    return failResult("implementation_reported",
      `Lifecycle transition to implemented_verified failed: ${verifiedResult.error}`,
      spawnGuard);
  }

  const verifiedState = {
    ...verifiedResult.state,
    verification,
    implementationReport: implReport,
  };
  await writeLifecycleState(verifiedState);
  emit("Shape-builder: lifecycle → implemented_verified (reload required).");

  const continuationTemplate = buildContinuationTemplate(targetName);
  const diagPath = reloadDiagnosticsPath();

  // ── Step 13: Return success with reloadRequired ─────────────────────────
  return {
    markdown: [
      `# Shape-Builder: IMPLEMENTED_VERIFIED`,
      "",
      `**Target:** \`${targetName}\``,
      `**Lifecycle status:** implemented_verified`,
      `**Usable:** false (requires runtime reload + discovery + canary)`,
      `**Reload required:** true`,
      `**Next gate:** agent_reload`,
      "",
      "## Generated Files",
      ...generatedFiles.map((f) => `- \`${f}\``),
      "",
      "## Verification",
      `- Overall: ${verification.overall}`,
      `- Checks passed: ${verification.checks.filter((c) => c.status === "pass").length}/${verification.checks.length}`,
      ...verification.checks.map((c) => `- \`${c.id}\`: ${c.status} — ${c.citations.join(", ")}`),
      "",
      "## Reload Handoff",
      "The visible ORCHESTRATOR must:",
      "1. Schedule a continuation before reloading.",
      "2. Call agent_reload_runtime.",
      "3. Stop immediately in the old runtime.",
      "4. On resume, read reload diagnostics first.",
      `5. Verify runtime discovery lists \`${targetName}\`.`,
      `6. Run canary with \`--paradigm ${targetName} "SHAPE_CANARY:${targetName}"\`.`,
      "7. Only after canary passes, mark the shape usable.",
      "",
      "```text",
      continuationTemplate,
      "```",
    ].join("\n"),
    details: {
      status: "pass",
      paradigm: "shape-builder",
      targetName,
      lifecycleStatus: "implemented_verified",
      implemented_verified: true,
      usable: false,
      reloadRequired: true,
      nextRequiredGate: "agent_reload",
      lifecycleStatePath: statePath,
      diagnosticsPath: diagPath,
      continuationTemplate,
      implementationReport: implReport,
      verification: {
        overall: verification.overall,
        implemented_verified: verification.implemented_verified,
        checkCount: verification.checks.length,
        failedChecks: verification.checks.filter((c) => c.status !== "pass").map((c) => c.id),
      },
      generatedFiles,
      spawnedCount: spawnGuard.spawned,
      spawnedCap: spawnGuard.cap,
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function failResult(
  lastStatus: string,
  reason: string,
  spawnGuard: SpawnGuard,
): OrchestrationShapeResult {
  return {
    markdown: `# Shape-Builder: FAIL\n\n**Reason:** ${reason}\n**Last status:** ${lastStatus}\n**Spawning count:** ${spawnGuard.spawned}/${spawnGuard.cap}`,
    details: {
      status: "fail",
      paradigm: "shape-builder",
      lifecycleStatus: lastStatus,
      implemented_verified: false,
      usable: false,
      reloadRequired: false,
      spawnedCount: spawnGuard.spawned,
      spawnedCap: spawnGuard.cap,
      failureReason: truncateWithNotice(reason, 2000, "failure reason"),
    },
  };
}

function failDetails(
  lifecycleStatus: string,
  reason: string,
  spawnGuard: SpawnGuard,
  targetName: string,
  statePath?: string,
  implReport?: Record<string, unknown>,
): OrchestrationShapeResult {
  return {
    markdown: [
      `# Shape-Builder: FAIL`,
      "",
      `**Target:** \`${targetName}\``,
      `**Lifecycle status:** ${lifecycleStatus}`,
      `**Usable:** false`,
      `**Reload required:** false`,
      `**Reason:** ${reason}`,
    ].join("\n"),
    details: {
      status: "fail",
      paradigm: "shape-builder",
      targetName,
      lifecycleStatus,
      implemented_verified: false,
      usable: false,
      reloadRequired: false,
      nextRequiredGate: computeNextRequiredGate(lifecycleStatus as ShapeBuilderLifecycleState["lifecycleStatus"]),
      lifecycleStatePath: statePath || "",
      spawnedCount: spawnGuard.spawned,
      spawnedCap: spawnGuard.cap,
      failureReason: truncateWithNotice(reason, 2000, "failure reason"),
      implementationReport: implReport,
    },
  };
}

function recordLifecycleFailure(
  state: ShapeBuilderLifecycleState,
  gate: string,
  reason: string,
  evidence: unknown,
): ShapeBuilderLifecycleState {
  return recordFailure(state, gate, reason, evidence);
}

function buildVerifierAgent(agents: Map<string, AgentProfile>, verifierAgentName: string): AgentProfile {
  const base = agents.get(verifierAgentName) ?? { name: verifierAgentName };
  return {
    ...base,
    name: verifierAgentName,
    // Grant read/bash/grep for independent evidence gathering
    tools: ["read", "bash", "grep"],
  };
}

function toIdentifierName(name: string): string {
  const normalized = normalizeShapeName(name)
    .split("-")
    .map((part, index) => (index === 0 ? part : part.slice(0, 1).toUpperCase() + part.slice(1)))
    .join("") || "generated";
  const candidate = /^[a-zA-Z_]/.test(normalized) ? normalized : `shape${normalized}`;
  return `${candidate}Shape`;
}
