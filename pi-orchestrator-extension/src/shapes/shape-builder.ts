/**
 * Shape: shape-builder
 * =====================
 * Deterministic meta-orchestration for creating new reusable orchestration
 * workflows. Ordinary specs compile to user/project-owned declarative JSON,
 * are rediscovered and canary-checked in the same process, and become usable
 * without reload. The explicit artifactKind=native-shape branch retains the
 * original extension-code generation and reload-gated lifecycle.
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
  compileDeclarativeWorkflow,
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
  type ShapeBuilderDeclarativeVerification,
} from "../shape-builder-support";
import {
  DYNAMIC_WORKFLOW_LIMITS,
  dynamicWorkflowRoots,
  ensureDynamicWorkflowRoot,
  resolveDynamicWorkflow,
  runDynamicWorkflowCanary,
  validateDynamicWorkflow,
  workflowArtifactPath,
} from "../dynamic-workflow";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { link, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveShapePhaseRoute } from "../routes";

// ── Shape export ──────────────────────────────────────────────────────────

export const shapeBuilderShape: OrchestrationShape = {
  name: "shape-builder",
  description:
    "Deterministic meta-constructor. Ordinary specs create durable declarative " +
    "workflows that are usable in the current session without reload; explicit " +
    "artifactKind=native-shape builds retain code-generation and reload gates. " +
    "Must be selected explicitly via --paradigm shape-builder.",
  run: runShapeBuilder,
};

// ── Main orchestration ────────────────────────────────────────────────────

async function runShapeBuilder(
  context: OrchestrationShapeContext,
): Promise<OrchestrationShapeResult> {
  const { params, signal, onUpdate, inheritedModel, agents } = context;
  const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }] });
  const spawnGuard = new SpawnGuard(Math.min(params.maxSubagents, 2));

  emit("Shape-builder: deterministic meta-constructor starting.");
  throwIfAborted(signal);

  // ── Step 1: Parse and validate the common spec ─────────────────────────
  emit("Shape-builder: parsing spec JSON from task...");
  const parsed = parseShapeBuilderSpecFromTask(params.task);
  if ("error" in parsed) {
    return failResult("proposed", `Spec parse failed: ${parsed.error}`, spawnGuard);
  }
  const spec: ShapeBuilderSpec = parsed;
  const reserved = new Set(RESERVED_SHAPE_NAMES);
  const specErrors = validateShapeBuilderSpec(spec, reserved);
  if (specErrors.length > 0) {
    return failResult("proposed", `Spec validation failed: ${specErrors.join("; ")}`, spawnGuard);
  }

  const targetName = normalizeShapeName(spec.targetName);
  emit(`Shape-builder: target "${targetName}" spec validated as ${spec.artifactKind}.`);

  // Ordinary ShapeBuilderSpec builds are data-only. This branch performs no
  // subagent spawn, shell command, registry edit, TypeScript generation, or
  // runtime reload.
  if (spec.artifactKind === "declarative-workflow") {
    return runDeclarativeShapeBuilder(context, spec, reserved, spawnGuard, emit);
  }

  // A native shape would permanently take registry precedence over data with
  // the same name. Reject either durable entry (including a dangling symlink)
  // rather than silently changing the meaning of an existing workflow.
  const durableRoots = dynamicWorkflowRoots(params.cwd);
  for (const [scope, root] of [["project", durableRoots.project], ["user", durableRoots.user]] as const) {
    const candidate = workflowArtifactPath(root, targetName);
    if (pathEntryExists(candidate)) {
      return failResult("proposed", `Native shape collides with existing ${scope} workflow artifact: ${candidate}`, spawnGuard);
    }
  }

  // ── Explicit native-shape path: retain all historical safety gates ─────
  const extensionRoot = resolveExtensionRoot(import.meta.url);
  emit(`Shape-builder(native): resolved extension root = ${extensionRoot}`);
  const rootErrors = verifyExtensionRoot(extensionRoot);
  if (rootErrors.length > 0) {
    return failResult("proposed", `Extension root validation failed: ${rootErrors.join("; ")}`, spawnGuard);
  }

  // ── Step 4: Render generated native sources ────────────────────────────
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

// ── Declarative build path ────────────────────────────────────────────────

async function runDeclarativeShapeBuilder(
  context: OrchestrationShapeContext,
  spec: ShapeBuilderSpec,
  nativeNames: ReadonlySet<string>,
  spawnGuard: SpawnGuard,
  emit: (text: string) => void,
): Promise<OrchestrationShapeResult> {
  const targetName = normalizeShapeName(spec.targetName);
  const roots = dynamicWorkflowRoots(context.params.cwd);
  const selectedRoot = ensureDynamicWorkflowRoot(spec.scope === "project" ? roots.project : roots.user);
  const artifactPath = workflowArtifactPath(selectedRoot, targetName);
  let created = false;

  try {
    // A user artifact hidden by a project artifact would not satisfy immediate
    // discovery, so reject before touching the user root.
    if (spec.scope === "user") {
      const projectArtifact = workflowArtifactPath(roots.project, targetName);
      if (pathEntryExists(projectArtifact)) {
        throw new Error(
          `Project workflow ${projectArtifact} already has precedence over user workflow ${targetName}; choose scope=project or another name.`,
        );
      }
    }

    emit(`Shape-builder: compiling declarative workflow for ${spec.scope} scope.`);
    const document = compileDeclarativeWorkflow(spec);
    const validated = validateDynamicWorkflow(document, {
      expectedName: targetName,
      nativeNames,
    });
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > DYNAMIC_WORKFLOW_LIMITS.MAX_ARTIFACT_BYTES) {
      throw new Error(`Compiled workflow exceeds ${DYNAMIC_WORKFLOW_LIMITS.MAX_ARTIFACT_BYTES} bytes.`);
    }

    created = await publishWorkflowAtomically(selectedRoot, artifactPath, serialized);
    emit(`Shape-builder: ${created ? "published" : "reused identical"} artifact ${artifactPath}.`);

    // Resolve exactly as orchestrate will on its next invocation. No static
    // import or module cache participates in this discovery.
    const discovered = resolveDynamicWorkflow(targetName, {
      cwd: context.params.cwd,
      nativeNames,
      roots,
    });
    if (!discovered) throw new Error(`Invocation-time resolver did not discover ${targetName}.`);
    if (path.resolve(discovered.provenance.sourcePath) !== path.resolve(artifactPath)) {
      throw new Error(`Resolver selected unexpected source ${discovered.provenance.sourcePath}.`);
    }
    if (discovered.provenance.scope !== spec.scope) {
      throw new Error(`Resolver selected ${discovered.provenance.scope} scope, expected ${spec.scope}.`);
    }

    const canary = runDynamicWorkflowCanary(discovered);
    if (canary.details.status !== "pass" || canary.details.canary !== true || canary.details.spawnedCount !== 0) {
      throw new Error("Deterministic zero-spawn canary did not return PASS.");
    }

    const verification: ShapeBuilderDeclarativeVerification = {
      overall: "pass",
      implemented_verified: true,
      reloadRequired: false,
      targetName,
      artifactKind: "declarative-workflow",
      scope: spec.scope,
      sourcePath: discovered.provenance.sourcePath,
      contentHash: discovered.provenance.contentHash,
      schemaVersion: discovered.provenance.schemaVersion,
      checks: [
        { id: "schema", status: "pass", citation: `schemaVersion=${discovered.provenance.schemaVersion}` },
        { id: "trusted-write", status: "pass", citation: discovered.provenance.sourcePath },
        { id: "runtime-discovery", status: "pass", citation: `${discovered.provenance.scope}:${targetName}` },
        { id: "deterministic-canary", status: "pass", citation: "spawnedCount=0" },
      ],
    };
    const implementationReport = {
      artifactKind: "declarative-workflow",
      scope: spec.scope,
      sourcePath: discovered.provenance.sourcePath,
      schemaVersion: discovered.provenance.schemaVersion,
      contentHash: discovered.provenance.contentHash,
      snapshotHash: discovered.provenance.snapshotHash,
      atomicPublication: created ? "created" : "identical-existing",
      staticRegistryEdited: false,
      generatedTypeScript: false,
      generatedTestModule: false,
    };

    let lifecycle: ShapeBuilderLifecycleState = {
      ...buildInitialLifecycleState(selectedRoot, targetName, [artifactPath], []),
      artifactKind: "declarative-workflow",
      scope: spec.scope,
    };
    lifecycle = requireLifecycleTransition(lifecycle, "implementation_reported", { implementationReport });
    lifecycle = requireLifecycleTransition(lifecycle, "declarative_verified", { verification });
    lifecycle = requireLifecycleTransition(lifecycle, "runtime_discovered", {
      sourcePath: discovered.provenance.sourcePath,
      contentHash: discovered.provenance.contentHash,
    });
    lifecycle = requireLifecycleTransition(lifecycle, "canary_passed", {
      deterministic: true,
      spawnedCount: 0,
    });
    lifecycle = {
      ...lifecycle,
      implementationReport,
      verification,
      discoveryProbe: {
        sameProcess: true,
        sourcePath: discovered.provenance.sourcePath,
        scope: discovered.provenance.scope,
      },
      canary: canary.details,
    };
    await writeLifecycleState(lifecycle);

    emit("Shape-builder: runtime discovery and deterministic canary passed; reload is not required.");
    return {
      markdown: [
        "# Shape-Builder: CANARY_PASSED",
        "",
        `**Target:** \`${targetName}\``,
        "**Artifact:** declarative workflow JSON",
        `**Scope:** ${spec.scope}`,
        "**Lifecycle status:** canary_passed",
        "**Usable:** true",
        "**Reload required:** false",
        "",
        "## Durable Artifact",
        `- Source: \`${discovered.provenance.sourcePath}\``,
        `- Schema version: ${discovered.provenance.schemaVersion}`,
        `- Content SHA-256: \`${discovered.provenance.contentHash}\``,
        "- Static registry/import edits: none",
        "- Generated TypeScript/tests: none",
        "",
        "## Same-Session Verification",
        "- Invocation-time resolver: PASS",
        "- Deterministic canary: PASS (0 spawns)",
        `- Run now with \`--paradigm ${targetName}\``,
      ].join("\n"),
      details: {
        status: "pass",
        paradigm: "shape-builder",
        targetName,
        artifactKind: "declarative-workflow",
        scope: spec.scope,
        lifecycleStatus: "canary_passed",
        implemented_verified: true,
        usable: true,
        reloadRequired: false,
        nextRequiredGate: "none",
        lifecycleStatePath: lifecycle.lifecycleStatePath,
        generatedFiles: [artifactPath],
        implementationReport,
        verification,
        canary: canary.details,
        spawnedCount: 0,
        spawnedCap: spawnGuard.cap,
      },
    };
  } catch (error) {
    // Do not leave a newly-created source behind when post-publication
    // validation/discovery/canary/lifecycle persistence fails.
    if (created) await rm(artifactPath, { force: true }).catch(() => undefined);
    return failDetails(
      "proposed",
      `Declarative workflow build failed: ${error instanceof Error ? error.message : String(error)}`,
      spawnGuard,
      targetName,
    );
  }
}

async function publishWorkflowAtomically(root: string, destination: string, content: string): Promise<boolean> {
  const absoluteRoot = path.resolve(root);
  const relative = path.relative(absoluteRoot, path.resolve(destination));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Workflow destination escapes trusted root: ${destination}`);
  }
  if (pathEntryExists(destination)) {
    const existing = await readExistingWorkflowArtifact(absoluteRoot, destination);
    if (existing === content) return false;
    throw new Error(`Workflow artifact already exists and differs: ${destination}`);
  }

  const temporary = path.join(absoluteRoot, `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Hard-link publication is same-filesystem, atomic, and never overwrites a
    // concurrently-created destination. The temporary name is then removed.
    await link(temporary, destination);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST" && pathEntryExists(destination)) {
      const existing = await readExistingWorkflowArtifact(absoluteRoot, destination);
      if (existing === content) return false;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readExistingWorkflowArtifact(root: string, destination: string): Promise<string> {
  const stat = lstatSync(destination);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing to replace non-regular workflow artifact: ${destination}`);
  }
  const canonicalRoot = realpathSync.native(path.resolve(root));
  const canonicalDestination = realpathSync.native(path.resolve(destination));
  const relative = path.relative(canonicalRoot, canonicalDestination);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Existing workflow artifact escapes trusted root: ${destination}`);
  }
  return readFile(canonicalDestination, "utf8");
}

function pathEntryExists(candidate: string): boolean {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

function requireLifecycleTransition(
  state: ShapeBuilderLifecycleState,
  status: ShapeBuilderLifecycleState["lifecycleStatus"],
  evidence: Record<string, unknown>,
): ShapeBuilderLifecycleState {
  const result = transitionAndUpdateState(state, status, "shape-builder", evidence);
  if (!result.success) throw new Error(`Lifecycle transition failed: ${result.error}`);
  return result.state;
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
