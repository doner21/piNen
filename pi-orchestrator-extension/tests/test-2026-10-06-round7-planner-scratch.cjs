#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { SOURCE, isolated, api } = require('./test-2026-10-06-round7-test-isolation.cjs');
const directory = isolated('round7-planner-');
const failures = [];
function check(name, body) { try { body(); console.log('PASS ' + name); } catch (error) { failures.push(name + ': ' + error.message); console.log('RED ' + name + ': ' + error.message); } }
try {
  check('planner scratch scope', () => {
  const { buildPlanningPrompt } = api('src/index.ts', ['buildPlanningPrompt'], {
    bindingPromptPreamble: () => 'BINDING OWNER INSTRUCTIONS', formatIntakeForPrompt: JSON.stringify,
    plannerAcceptanceCriteriaInstruction: () => 'OWNER_ACCEPTANCE', plannerDeliverablesInstruction: () => 'OWNER_DELIVERABLES',
  });
  for (const evidence of [[], ['C:/read-only-evidence']]) {
    const prompt = buildPlanningPrompt({ successCriteria: ['OWNER_ACCEPTANCE'], deliverables: [] }, 1, [], [], ['src/only.ts'], evidence);
    assert.match(prompt, /Repository content writes.*(?:MUST|must).*within this set/, 'repository writes retain the named write set');
    assert.match(prompt, /disposable owned external scratch/i, 'owned external scratch differs from repository content writes');
    assert.match(prompt, /declared read-only evidence roots.*live.*frozen.*READONLY/i, 'evidence/live/frozen remain explicitly READONLY even without declared roots');
    assert.match(prompt, /outside the repository.*never grants.*write authority/i, 'external placement cannot grant evidence writes');
    assert.match(prompt, /newly owned.*(?:absolute|canonical).*outside.*(?:repository|workspace).*evidence/i, 'scratch validation is not a broad external write exemption');
    assert.doesNotMatch(prompt, /Every file your tasks create or modify MUST/, 'obsolete blanket scope removed');
    assert.match(prompt, /out-of-set mutation is an automatic deterministic FAIL/);
    assert.match(prompt, /predicted_write_set/);
    if (evidence.length) assert.match(prompt, /Any write beneath them fails/);
  }
  });
  check('README null policy', () => {
  const readme = fs.readFileSync(require('node:path').join(SOURCE, 'README.md'), 'utf8');
  const row = readme.split(/\r?\n/).find(line => line.startsWith('| **Hard when explicitly frozen** | A guarded worker calls `bash`'));
  assert.ok(row);
  assert.match(row, /absent.*null.*allowed/i, 'README must agree with null/absent guard policy');
  assert.match(row, /own.*non-null.*(?:blocked|blocks)/i, 'README must retain rejection of owned non-null values');
  assert.doesNotMatch(row, /including `null`/);
  });
  check('unchanged guard null/absent/non-null policy', () => {
  const guard = api('src/worker-execution-constraints.ts', ['ownsForbiddenBashTimeoutArgument']).ownsForbiddenBashTimeoutArgument;
  assert.equal(guard({ command: 'fixture' }), false);
  assert.equal(guard({ timeout: null }), false);
  assert.equal(guard({ nested: { timeout: null } }), false);
  assert.equal(guard(Object.create({ timeout: 1 })), false);
  for (const value of [undefined, 0, 1, '1', false, {}, []]) assert.equal(guard({ nested: { timeout: value } }), true);
  });
  assert.deepEqual(failures, [], 'all planner/README semantic assertions');
  console.log('PASS round7 planner scratch and unchanged guard/README agreement');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
