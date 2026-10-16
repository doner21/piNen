/**
 * Actual-AgentSession no-force-kill fixture.
 *
 * The caller must isolate every Pi/config/run root before loading this module.
 * This fixture keeps Pi's real bash schema and dispatch path. It decorates only
 * the final execute boundary with a test safety backstop: a forbidden payload
 * reaching that boundary is recorded and rejected, and is always a test
 * failure rather than evidence that the production guard worked.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function hasRecursiveOwnTimeout(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Object.prototype.hasOwnProperty.call(value, "timeout")) return true;
  for (const key of Object.keys(value)) {
    if (hasRecursiveOwnTimeout(value[key], seen)) return true;
  }
  return false;
}

// NULL-TIMEOUT-ALLOWED (owner rule, 6 October 2026): a strict tool schema
// (OpenAI GPT-6.1 Sol workers) always sends `timeout: null` for an omitted
// optional field, so an owned timeout key whose value is null, anywhere in
// the recursive walk, is no longer forbidden. Every other owned value
// (undefined, zero, a string, a boolean, an object, an array) stays
// forbidden wherever it appears. This test-side safety backstop must use
// this SAME value-aware rule the production guard now uses, or it would
// wrongly intercept a call the production guard correctly allowed.
function hasForbiddenOwnTimeout(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Object.prototype.hasOwnProperty.call(value, "timeout") && value.timeout !== null) return true;
  for (const key of Object.keys(value)) {
    if (key === "timeout") continue; // null here is allowed; already decided above
    if (hasForbiddenOwnTimeout(value[key], seen)) return true;
  }
  return false;
}

function textOf(result) {
  return (result?.content ?? [])
    .filter((item) => item?.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function makeCases() {
  const ownUndefined = { command: "printf forbidden-undefined", timeout: undefined };
  assert.equal(Object.hasOwn(ownUndefined, "timeout"), true,
    "the undefined case must own the key before provider/JSON serialization");
  return [
    // NULL-TIMEOUT-ALLOWED (owner rule, 6 October 2026, superseding the prior
    // "key presence, including null, is forbidden" policy for null only):
    // OpenAI's strict tool schema always sends timeout: null for an omitted
    // optional field, so this real strict-schema-shaped call
    // ({"command":"node -v","timeout":null}) must now EXECUTE rather than be
    // blocked. This case is restated from its prior "guard" expectation
    // (premise-corrected by name) to prove the command really runs.
    { id: "timeout-null", args: { command: "node -v", timeout: null }, expected: "allowed", outputPattern: /^v\d+\.\d+\.\d+/ },
    // Sibling non-null case kept refusing: `undefined` is not `null`, so an
    // owned timeout key whose value is undefined remains forbidden exactly
    // as before.
    { id: "timeout-undefined", args: ownUndefined, expected: "guard" },
    { id: "timeout-empty", args: { command: "printf forbidden-empty", timeout: "" }, expected: "guard" },
    { id: "timeout-whitespace", args: { command: "printf forbidden-whitespace", timeout: "   " }, expected: "guard" },
    { id: "timeout-zero", args: { command: "printf forbidden-zero", timeout: 0 }, expected: "guard" },
    { id: "timeout-positive", args: { command: "printf forbidden-positive", timeout: 30 }, expected: "guard" },
    { id: "timeout-numeric-string", args: { command: "printf forbidden-string", timeout: "30" }, expected: "guard" },
    { id: "timeout-boolean", args: { command: "printf forbidden-boolean", timeout: true }, expected: "guard" },
    { id: "timeout-object", args: { command: "printf forbidden-object", timeout: {} }, expected: "validation" },
    { id: "timeout-array", args: { command: "printf forbidden-array", timeout: [] }, expected: "validation" },
    // Nested metadata case, also premise-corrected by name: the owner's rule
    // is "consistent with the rule" at any recursion depth, so a nested null
    // timeout is allowed too, while a nested non-null timeout (the sibling
    // case directly below) keeps refusing.
    {
      id: "nested-object-timeout",
      args: { command: "printf nested-null-allowed", metadata: { timeout: null } },
      expected: "allowed",
      outputPattern: /^nested-null-allowed$/,
    },
    {
      id: "nested-array-timeout",
      args: { command: "printf forbidden-nested-array", metadata: [{ safe: true }, { timeout: undefined }] },
      expected: "guard",
    },
    // Review 29 finding 5 (coverage note): before this case, the only kept
    // nested non-null refusal was the JavaScript-only nested-array-timeout
    // case above (undefined, which no JSON tool call can carry). This case
    // pins a JSON-realistic nested non-null value (a plain number) so a
    // guard that only checked a TOP-LEVEL timeout value (treating nested
    // values as always allowed) would wrongly let this through instead of
    // blocking it.
    {
      id: "nested-numeric-timeout",
      args: { command: "printf forbidden-nested-numeric", metadata: { timeout: 30 } },
      expected: "guard",
    },
  ];
}

function makeToolCalls(ai, cases, allowedSuffix) {
  return [
    ...cases.map(({ id, args }) => ai.fauxToolCall("bash", args, { id })),
    ai.fauxToolCall("bash", { command: `printf allowed-${allowedSuffix}` }, { id: `allowed-${allowedSuffix}` }),
    ai.fauxToolCall("bash", { command: "printf timeout-in-command-only" }, { id: `command-text-${allowedSuffix}` }),
    ai.fauxToolCall("read", { path: "missing-fixture-file" }, { id: `unrelated-${allowedSuffix}` }),
  ];
}

async function runRole({ root, role, tools, guardPath, expectedVerifierTools }) {
  const sdk = require(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent"));
  const ai = require(path.join(root, "node_modules", "@earendil-works", "pi-ai"));
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const cwd = process.env.ITEM2_WORKSPACE;
  assert.ok(agentDir && cwd, "isolated agent and workspace roots must exist before Pi imports");
  assert.equal(process.env.PI_OFFLINE, "1");
  if (role === "verifier") {
    assert.deepEqual(tools, expectedVerifierTools,
      "reviewer fixture must use the production verifier evidence-tool fence");
  }

  const observations = {
    role,
    raw: new Map(),
    normalized: new Map(),
    ends: new Map(),
    executionBoundary: [],
    safetyInterceptions: [],
  };
  const instrumentation = (pi) => {
    pi.on("tool_execution_start", (event) => {
      if (event.toolName !== "bash") return;
      observations.raw.set(event.toolCallId, {
        args: event.args,
        recursiveTimeout: hasRecursiveOwnTimeout(event.args),
        forbiddenTimeout: hasForbiddenOwnTimeout(event.args),
        topLevelTimeout: Boolean(event.args && typeof event.args === "object" && Object.hasOwn(event.args, "timeout")),
      });
    });
    pi.on("tool_execution_end", (event) => {
      observations.ends.set(event.toolCallId, {
        isError: event.isError,
        text: textOf(event.result),
      });
    });
  };

  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    modelsStorePath: path.join(agentDir, `models-store-${role}.json`),
    allowModelNetwork: false,
  });
  const model = modelRuntime.getModel("fixture", "guard-model");
  assert.ok(model, "isolated fixture model must resolve");
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    additionalExtensionPaths: [guardPath],
    extensionFactories: [{ name: `item2-observer-${role}`, factory: instrumentation }],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, [], "production guard must load explicitly");

  const created = await sdk.createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    resourceLoader,
    settingsManager,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    tools,
  });
  const session = created.session;
  const productionBeforeToolCall = session.agent.beforeToolCall.bind(session.agent);
  session.agent.beforeToolCall = async (context, signal) => {
    if (context.toolCall.name === "bash") {
      observations.normalized.set(context.toolCall.id, {
        input: context.args,
        recursiveTimeout: hasRecursiveOwnTimeout(context.args),
        topLevelTimeout: Boolean(context.args && typeof context.args === "object" && Object.hasOwn(context.args, "timeout")),
      });
    }
    return productionBeforeToolCall(context, signal);
  };
  const bash = session.agent.state.tools.find((tool) => tool.name === "bash");
  assert.ok(bash, `${role} must receive Pi's built-in bash tool`);
  const schemaSnapshot = JSON.stringify(bash.parameters);
  assert.match(schemaSnapshot, /"timeout"/);
  assert.match(schemaSnapshot, /"number"/);
  assert.doesNotMatch(schemaSnapshot, /"Any"|"any"/,
    "the regression must retain Pi's optional-number timeout schema");

  // Preserve the real schema, preparation, AgentSession hooks, validation and
  // dispatch. This wrapper observes only the final native-execution boundary.
  const realExecute = bash.execute.bind(bash);
  bash.execute = async (toolCallId, input, signal, onUpdate) => {
    // Forbidden-aware, not merely ownership-aware: an own timeout key whose
    // value is null (NULL-TIMEOUT-ALLOWED) must reach real execution, while
    // every other owned value must still be intercepted here as a genuine
    // production-guard bypass.
    const rawForbidden = observations.raw.get(toolCallId)?.forbiddenTimeout === true;
    const record = {
      toolCallId,
      rawForbidden,
      recursiveTimeout: hasRecursiveOwnTimeout(input),
      forbiddenTimeout: hasForbiddenOwnTimeout(input),
      topLevelTimeout: Boolean(input && typeof input === "object" && Object.hasOwn(input, "timeout")),
    };
    observations.executionBoundary.push(record);
    if (rawForbidden || record.forbiddenTimeout) {
      observations.safetyInterceptions.push(record);
      throw new Error(`TEST_SAFETY_BACKSTOP: forbidden timeout payload reached bash execution (${toolCallId})`);
    }
    return realExecute(toolCallId, input, signal, onUpdate);
  };

  const cases = makeCases();
  const faux = ai.createFauxCore({
    provider: "fixture",
    models: [{ id: "guard-model", contextWindow: 200_000, maxTokens: 1_000 }],
  });
  faux.setResponses([
    ai.fauxAssistantMessage(makeToolCalls(ai, cases, "parallel"), { stopReason: "toolUse" }),
    ai.fauxAssistantMessage("parallel complete", { stopReason: "stop" }),
    ai.fauxAssistantMessage([
      ai.fauxToolCall("bash", { command: "printf sequential-allowed" }, { id: "sequential-allowed" }),
      // A non-null forbidden value (not timeout: null) keeps this reused-ID
      // probe about ID-correlation state, not about the null-specific rule
      // change proven separately by the "timeout-null" case above.
      ai.fauxToolCall("bash", { command: "printf sequential-forbidden", timeout: 9 }, { id: "reused-id" }),
      ai.fauxToolCall("bash", { command: "printf validation-forbidden", timeout: {} }, { id: "validation-reused-id" }),
    ], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage("sequential complete", { stopReason: "stop" }),
    ai.fauxAssistantMessage([
      ai.fauxToolCall("bash", { command: "printf reused-id-allowed" }, { id: "reused-id" }),
      ai.fauxToolCall("bash", { command: "printf validation-reused-id-allowed" }, { id: "validation-reused-id" }),
    ], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage("reuse complete", { stopReason: "stop" }),
  ]);
  session.agent.streamFunction = faux.streamSimple;

  try {
    session.agent.toolExecution = "parallel";
    await session.prompt(`item2 ${role} parallel dispatch matrix`);
    session.agent.toolExecution = "sequential";
    await session.prompt(`item2 ${role} sequential mixed dispatch`);
    session.agent.toolExecution = "parallel";
    await session.prompt(`item2 ${role} reused-id next turn`);

    assert.equal(JSON.stringify(bash.parameters), schemaSnapshot, "the real bash schema must remain unchanged");
    assert.equal(faux.state.callCount, 6);
    for (const testCase of cases) {
      const raw = observations.raw.get(testCase.id);
      const end = observations.ends.get(testCase.id);
      assert.ok(raw?.recursiveTimeout, `${role}/${testCase.id} must own a raw recursive timeout key`);
      if (testCase.expected === "allowed") {
        // NULL-TIMEOUT-ALLOWED: the real command must actually run (not be
        // blocked, and not be a stubbed/simulated result).
        assert.equal(end?.isError, false,
          `${role}/${testCase.id} must execute under the owner's NULL-TIMEOUT-ALLOWED rule (6 October 2026)`);
        assert.match(end.text, testCase.outputPattern,
          `${role}/${testCase.id} must show the command actually ran, not a stub result`);
        continue;
      }
      assert.ok(end?.isError, `${role}/${testCase.id} must fail before native execution`);
      if (testCase.expected === "guard") {
        assert.equal(
          end.text,
          "NO_FORCE_KILL_CONSTRAINT: bash arguments must omit the timeout key or set it to null; the call was blocked before dispatch.",
          `${role}/${testCase.id} must be blocked by the production guard with its stable reason`,
        );
      } else {
        assert.match(end.text, /Validation failed for tool "bash"/,
          `${role}/${testCase.id} must retain Pi schema validation`);
      }
    }
  } finally {
    session.dispose();
  }

  return { observations, cases, modelCalls: faux.state.callCount, schemaSnapshot };
}

function argumentValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function runCliWorker() {
  const root = path.resolve(__dirname, "..", "..");
  const args = process.argv.slice(2);
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const cwd = process.cwd();
  assert.ok(agentDir && process.env.PI_OFFLINE === "1",
    "CLI fixture requires isolated offline configuration before Pi imports");

  const sdk = require(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent"));
  const ai = require(path.join(root, "node_modules", "@earendil-works", "pi-ai"));
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    modelsStorePath: path.join(agentDir, `models-store-launcher-${process.pid}.json`),
    allowModelNetwork: false,
  });
  const model = modelRuntime.getModel("fixture", "guard-model");
  assert.ok(model);

  const extensionPaths = [];
  for (let index = 0; index < args.length; index += 1) {
    if ((args[index] === "--extension" || args[index] === "-e") && args[index + 1]) {
      extensionPaths.push(args[index + 1]);
    }
  }
  const effectiveExtensionPaths = process.env.ITEM2_SUPPRESS_GUARD === "1"
    ? extensionPaths.filter((entry) => path.basename(entry) !== "worker-execution-constraints.ts")
    : extensionPaths;
  const rawById = new Map();
  const safetyInterceptions = [];
  const instrumentation = (pi) => {
    pi.on("tool_execution_start", (event) => {
      if (event.toolName === "bash") rawById.set(event.toolCallId, hasRecursiveOwnTimeout(event.args));
    });
  };
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: args.includes("--no-extensions"),
    additionalExtensionPaths: effectiveExtensionPaths,
    extensionFactories: [{ name: "item2-launch-observer", factory: instrumentation }],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);

  const selectedTools = (argumentValue(args, "--tools") || "bash")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const created = await sdk.createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    resourceLoader,
    settingsManager,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    tools: selectedTools,
  });
  const session = created.session;
  session.subscribe((event) => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  });
  const bash = session.agent.state.tools.find((tool) => tool.name === "bash");
  assert.ok(bash, "launcher role must retain bash for this guard probe");
  const realExecute = bash.execute.bind(bash);
  bash.execute = async (toolCallId, input, signal, onUpdate) => {
    if (rawById.get(toolCallId) === true || hasRecursiveOwnTimeout(input)) {
      safetyInterceptions.push(toolCallId);
      throw new Error(`TEST_SAFETY_BACKSTOP: launcher wiring allowed forbidden execution (${toolCallId})`);
    }
    return realExecute(toolCallId, input, signal, onUpdate);
  };

  const faux = ai.createFauxCore({
    provider: "fixture",
    models: [{ id: "guard-model", contextWindow: 200_000, maxTokens: 1_000 }],
  });
  faux.setResponses([
    ai.fauxAssistantMessage([
      // Kept as a non-null forbidden value (not timeout: null) so this
      // launcher-wiring probe still proves the guard loads and blocks a
      // genuinely forbidden call through both real host launchers; the
      // null-specific NULL-TIMEOUT-ALLOWED proof lives in runRole's
      // "timeout-null" case above, which drives a real AgentSession through
      // the same production guard extension.
      ai.fauxToolCall("bash", { command: "printf launcher-forbidden", timeout: 20 }, { id: "launcher-20" }),
      ai.fauxToolCall("bash", { command: "printf launcher-allowed" }, { id: "launcher-allowed" }),
    ], { stopReason: "toolUse" }),
    ai.fauxAssistantMessage("launcher guard probe complete", { stopReason: "stop" }),
  ]);
  session.agent.streamFunction = faux.streamSimple;

  let prompt = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) prompt += chunk;
  try {
    await session.prompt(prompt || "launcher guard probe");
    const recordFile = process.env.ITEM2_LAUNCH_RECORDS;
    if (recordFile) {
      fs.appendFileSync(recordFile, `${JSON.stringify({
        launcher: process.env.ITEM2_LAUNCHER_KIND,
        role: path.basename(argumentValue(args, "--append-system-prompt") || "unknown")
          .replace(/-system-prompt\.txt$/, ""),
        noExtensions: args.includes("--no-extensions"),
        extensionPaths,
        effectiveExtensionPaths,
        tools: selectedTools,
        safetyInterceptions,
        modelCalls: faux.state.callCount,
      })}\n`, "utf8");
    }
  } finally {
    session.dispose();
  }
}

module.exports = { hasRecursiveOwnTimeout, runRole };

if (require.main === module) {
  runCliWorker().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
