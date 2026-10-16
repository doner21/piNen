#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { isolated, api } = require('./test-2026-10-06-round7-test-isolation.cjs');
const directory = isolated('round7-review-');
try {
  const prompts = api('src/index.ts', ['buildVerificationPrompt', 'buildVisibleMainVerificationPrompt'], {
    bindingPromptPreamble: () => 'BINDING OWNER INSTRUCTIONS: OWNER_MARKER', formatIntakeForPrompt: JSON.stringify,
    commandTimesFromHostResults: outputs => outputs.map(output => output.commandTimes ?? null),
  });
  for (const outputs of [[], [{ taskId: 'task-1', commandTimes: { unavailable: true, entries: [] } }], [{ taskId: 'task-1', commandTimes: { entries: [{ durationMs: 12 }] } }]]) {
    const rendered = [prompts.buildVerificationPrompt({ successCriteria: ['OWNER_MARKER'] }, { tasks: [] }, outputs, 'owner-route', 'observed artifacts'), prompts.buildVisibleMainVerificationPrompt({}, { acceptanceCriteria: ['OWNER_MARKER'] }, { tasks: [] }, outputs)];
    for (const prompt of rendered) {
      assert.match(prompt, /Advisory review question/i, 'cost question is advisory');
      assert.match(prompt, /was work unexpectedly slow or expensive/i, 'ask the actual owner question');
      assert.match(prompt, /available timing\/usage evidence/i, 'cite available evidence only');
      assert.match(prompt, /Missing evidence is unknown, not zero/i);
      assert.match(prompt, /(?:Do not guess|Never guess).*cost/i);
      assert.match(prompt, /not a new PASS\/FAIL gate/i);
      assert.match(prompt, /independently.*(?:re-run|rerun).*checks/i, 'independent verification retained explicitly');
      assert.match(prompt, /BINDING OWNER INSTRUCTIONS/);
      assert.match(prompt, /HOST-OWNED COMMAND TIMING/);
      assert.match(prompt, /PROVENANCE RULE/);
      assert.match(prompt, /OWNER_MARKER/);
    }
    assert.match(rendered[0], /Use status "pass" only if/);
    assert.match(rendered[0], /owner_criteria are verdict-determining/);
    assert.match(rendered[1], /owner criteria remain hard/);
  }
  console.log('PASS round7 advisory review question: unknown/available timing and binding independent review');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
