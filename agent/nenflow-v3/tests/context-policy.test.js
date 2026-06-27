const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const root = path.resolve('%USERPROFILE%/.pi/agent');
const runtime = path.join(root, 'nenflow-v3');
const policy = require(path.join(runtime, 'context-policy.js'));

function mkRunDir(runId = `RUN_20990101-000000_${Math.random().toString(16).slice(2)}`) {
  const dir = path.join(os.tmpdir(), 'nenflow-v3-tests', 'runs', runId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return { runId, dir };
}

function continuationBody({ runId, role = 'EXECUTOR', measuredAt = new Date().toISOString(), threshold = 40, saturation = '~41%' } = {}) {
  return `---\nartifact_type: CONTINUATION_CONTRACT\nrole: ${role}\nrun_id: ${runId}\ncontinuation_from: ${role}\ncontext_saturation_estimate: "${saturation}"\ncontext_handoff_threshold_percent: ${threshold}\nthreshold_source: user_prompt\nmeasured_at: ${measuredAt}\n---\n\n# ATT_4 — CONTINUATION CONTRACT\n\n## Work Completed\n- Completed concrete file inspection and wrote durable evidence.\n\n## Work Remaining\n- Finish the remaining implementation work and write the normal role artifact.\n\n## Critical Context\n- Run ${runId}; all artifact paths are under this run directory.\n\n## Resume Instruction\nFresh ${role} continuation for run ${runId}: read this continuation contract, then complete the remaining work and write the normal role output.\n`;
}

test('threshold parser accepts and propagates configured values', () => {
  for (const n of [65, 45, 35, 20, 40]) {
    const got = policy.buildContextPolicy(`if context goes above ${n}% create a handoff`, '');
    assert.equal(got.handoff_threshold_percent, n);
    assert.equal(got.threshold_source, 'user_prompt');
    assert.equal(got.warning_threshold_percent, Math.max(1, n - 5));
    assert.equal(got.hard_risk_threshold_percent, Math.min(99, n + 5));
  }
});

test('threshold parser rejects signed, malformed, out-of-range, or unrelated percentages and defaults safely', () => {
  for (const raw of [
    'context threshold -4%',
    'context threshold - 4%',
    'context threshold -40%',
    'context threshold +4%',
    'context threshold + 40%',
    'context threshold 0%',
    'context threshold 100%',
    'context threshold 101%',
    'context threshold 4%%',
    'context threshold 4.5.6%',
    'context threshold %40',
    'context threshold abc4%',
    'context threshold 4%abc',
    'context threshold --4%',
    'context threshold ++4%',
    '',
    'the CSS width is 42%',
    'marketing conversion is 40% this week',
  ]) {
    const got = policy.buildContextPolicy(raw, '');
    assert.equal(got.handoff_threshold_percent, 65, raw);
    assert.equal(got.threshold_source, 'default', raw);
  }
});

test('intake frontmatter threshold fields accept only clean whole-field values', () => {
  assert.equal(policy.buildContextPolicy('', '---\ncontext_handoff_threshold_percent: 40\n---\n').handoff_threshold_percent, 40);
  assert.equal(policy.buildContextPolicy('', '---\ncontext_handoff_threshold_percent: 40%\n---\n').handoff_threshold_percent, 40);
  assert.equal(policy.buildContextPolicy('', '---\ncontext_handoff_threshold_percent: "~41%"\n---\n').handoff_threshold_percent, 41);
  for (const raw of ['-4%', '+4%', 'abc4%', '4%abc', '4%%', '4.5.6%']) {
    const got = policy.buildContextPolicy('', `---\ncontext_handoff_threshold_percent: "${raw}"\n---\n`);
    assert.equal(got.handoff_threshold_percent, 65, raw);
    assert.equal(got.threshold_source, 'default', raw);
  }
});

test('RUN_CONFIG write/read/default validation', () => {
  const { runId, dir } = mkRunDir();
  const cfgPath = path.join(dir, 'RUN_CONFIG.json');
  const cfg = policy.buildRunConfig(runId, policy.buildContextPolicy('context threshold 35%', ''));
  policy.writeRunConfig(cfgPath, cfg);
  assert.deepEqual(policy.readRunConfig(cfgPath, runId), cfg);
  assert.equal(policy.readRunConfig(path.join(dir, 'missing.json'), runId).context_handoff.handoff_threshold_percent, 65);
  assert.equal(policy.validateRunConfig({ schema_version: 1, run_id: runId, context_handoff: { handoff_threshold_percent: '40%', warning_threshold_percent: '35', hard_risk_threshold_percent: '~45%', threshold_source: 'x' } }, runId).ok, true);
  assert.equal(policy.validateRunConfig({ schema_version: 1, run_id: runId, context_handoff: { handoff_threshold_percent: 100, warning_threshold_percent: 1, hard_risk_threshold_percent: 2, threshold_source: 'x' } }, runId).ok, false);
  assert.equal(policy.validateRunConfig({ schema_version: 1, run_id: runId, context_handoff: { handoff_threshold_percent: '-40%', warning_threshold_percent: 1, hard_risk_threshold_percent: 2, threshold_source: 'x' } }, runId).ok, false);
});

test('continuation helpers build/find canonical paths and resume prompts', () => {
  const { runId, dir } = mkRunDir();
  const p1 = policy.buildContinuationPath(dir, 4, 'executor', 1);
  const p2 = policy.buildContinuationPath(dir, 4, 'EXECUTOR', 2);
  fs.writeFileSync(p1, continuationBody({ runId }), 'utf8');
  fs.writeFileSync(p2, continuationBody({ runId }), 'utf8');
  assert.equal(policy.findContinuation(dir, 4, 'executor'), p2);
  const prompt = policy.buildContinuationResumePrompt({ role: 'executor', runId, contractPath: p2, runConfigPath: path.join(dir, 'RUN_CONFIG.json'), intakePath: path.join(dir, 'ATT_0_INTAKE.md'), normalOutputPath: path.join(dir, 'ATT_4_EXECUTION.md'), nextContinuationPath: policy.buildContinuationPath(dir, 4, 'EXECUTOR', 3) });
  assert.match(prompt, /Route D continuation for EXECUTOR/);
  assert.match(prompt, /RUN_CONFIG\.json/);
  assert.match(prompt, /remaining work/i);
});

test('strict continuation validator accepts complete contract and rejects bad contracts', () => {
  const { runId, dir } = mkRunDir();
  const valid = path.join(dir, 'ATT_4_CONTINUATION_EXECUTOR_1.md');
  fs.writeFileSync(valid, continuationBody({ runId }), 'utf8');
  assert.deepEqual(policy.validateContinuationContract(valid, { expectedRole: 'EXECUTOR', expectedRunId: runId }).errors, []);

  const missing = path.join(dir, 'ATT_4_CONTINUATION_EXECUTOR_2.md');
  fs.writeFileSync(missing, `---\nartifact_type: CONTINUATION_CONTRACT\nrole: EXECUTOR\nrun_id: ${runId}\ncontinuation_from: EXECUTOR\ncontext_saturation_estimate: "~40%"\ncontext_handoff_threshold_percent: 40\nmeasured_at: ${new Date().toISOString()}\n---\n\n# bad\n`, 'utf8');
  assert.equal(policy.validateContinuationContract(missing, { expectedRole: 'EXECUTOR', expectedRunId: runId }).ok, false);

  const roleMismatch = path.join(dir, 'ATT_4_CONTINUATION_PLANNER_1.md');
  fs.writeFileSync(roleMismatch, continuationBody({ runId, role: 'PLANNER' }), 'utf8');
  assert.equal(policy.validateContinuationContract(roleMismatch, { expectedRole: 'EXECUTOR', expectedRunId: runId }).ok, false);

  const stale = path.join(dir, 'ATT_4_CONTINUATION_EXECUTOR_3.md');
  fs.writeFileSync(stale, continuationBody({ runId, measuredAt: '2000-01-01T00:00:00.000Z' }), 'utf8');
  assert.equal(policy.validateContinuationContract(stale, { expectedRole: 'EXECUTOR', expectedRunId: runId }).ok, false);

  const badName = path.join(dir, 'BAD_CONTINUATION_EXECUTOR.md');
  fs.writeFileSync(badName, continuationBody({ runId }), 'utf8');
  assert.equal(policy.validateContinuationContract(badName, { expectedRole: 'EXECUTOR', expectedRunId: runId }).ok, false);

  assert.equal(policy.validateContinuationContract(valid, { expectedRole: 'EXECUTOR', expectedRunId: 'RUN_DIFFERENT' }).ok, false);

  const outside = path.join(os.tmpdir(), 'ATT_4_CONTINUATION_EXECUTOR_9.md');
  fs.writeFileSync(outside, continuationBody({ runId }), 'utf8');
  assert.equal(policy.validateContinuationContract(outside, { expectedRole: 'EXECUTOR', expectedRunId: runId }).ok, false);
});

test('validator CLI preserves normal artifact validation and rejects malformed continuations', () => {
  const validator = path.join(runtime, 'validator.js');
  const planPath = '%USERPROFILE%/.pi/agent/nenflow-v3/runs/RUN_20260512-163845/ATT_2_PLAN.md';
  const plan = cp.spawnSync(process.execPath, [validator, planPath, 'PLANNER', 'PLAN'], { encoding: 'utf8' });
  assert.equal(plan.status, 0, plan.stderr || plan.stdout);

  const { runId, dir } = mkRunDir();
  const execPath = path.join(dir, 'ATT_4_EXECUTION.md');
  fs.writeFileSync(execPath, `---\nartifact_type: EXECUTION_REPORT\nrole: EXECUTOR\nrun_id: ${runId}\ncontext_saturation_estimate: "~10%"\n---\n\n# Execution\n`, 'utf8');
  const exec = cp.spawnSync(process.execPath, [validator, execPath, 'EXECUTOR', 'EXECUTION_REPORT'], { encoding: 'utf8' });
  assert.equal(exec.status, 0, exec.stderr || exec.stdout);

  const verificationPath = path.join(dir, 'ATT_5_VERIFICATION.md');
  fs.writeFileSync(verificationPath, `---\nartifact_type: VERIFICATION_REPORT\nrole: VERIFIER\nrun_id: ${runId}\nverdict: PASS\ncontext_saturation_estimate: "~10%"\n---\n\n# Verification\n\nVERDICT: PASS\n`, 'utf8');
  const verification = cp.spawnSync(process.execPath, [validator, verificationPath, 'VERIFIER', 'VERIFICATION_REPORT'], { encoding: 'utf8' });
  assert.equal(verification.status, 0, verification.stderr || verification.stdout);

  const valid = path.join(dir, 'ATT_4_CONTINUATION_EXECUTOR_1.md');
  fs.writeFileSync(valid, continuationBody({ runId }), 'utf8');
  const ok = cp.spawnSync(process.execPath, [validator, valid, 'EXECUTOR', 'CONTINUATION_CONTRACT'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr || ok.stdout);

  const invalid = path.join(dir, 'ATT_4_CONTINUATION_EXECUTOR_2.md');
  fs.writeFileSync(invalid, continuationBody({ runId }).replace('## Work Remaining\n- Finish the remaining implementation work and write the normal role artifact.\n', ''), 'utf8');
  const bad = cp.spawnSync(process.execPath, [validator, invalid, 'EXECUTOR', 'CONTINUATION_CONTRACT'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0, bad.stdout);
});

test('active Pi orchestrator and role skills contain configurable Route D propagation', () => {
  const orch = fs.readFileSync(path.join(root, 'skills/nenflow-v3/SKILL.md'), 'utf8');
  assert.match(orch, /Route D — Context Handoff Continuation/);
  assert.match(orch, /RUN_CONFIG\.json/);
  assert.match(orch, /context_handoff_threshold_percent/);
  assert.match(orch, /buildContinuationResumePrompt/);

  for (const name of ['nenflow-pev-researcher', 'nenflow-pev-planner', 'nenflow-pev-executor', 'nenflow-pev-verifier']) {
    const txt = fs.readFileSync(path.join(root, `skills/${name}/SKILL.md`), 'utf8');
    assert.equal(txt.includes('At ~65% self-estimated saturation'), false, name);
    assert.match(txt, /context_handoff_threshold_percent/, name);
    assert.match(txt, /RUN_CONFIG\.json/, name);
    assert.match(txt, /exact continuation path/, name);
  }
});
