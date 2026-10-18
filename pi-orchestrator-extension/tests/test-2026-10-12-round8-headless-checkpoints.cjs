const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const jiti = require(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs'))(__filename, { interopDefault: true, fsCache: false });
const supervision = jiti(path.join(root, 'src/supervision.ts'));
(async () => {
  const externalTemp = require('./fixtures/round8-owned-temp.cjs')('round8-workspace');
  const workspace = path.join(externalTemp,'workspace');
  fs.mkdirSync(workspace);
  try {
    process.env.PI_CODING_AGENT_DIR=path.join(externalTemp,'fixture-agent');
    require('./fixtures/round8-models.cjs')(process.env.PI_CODING_AGENT_DIR);
    const mission = supervision.createFrozenMission({ originalTask: 'CREATE out-1.txt', cwd: workspace,
      worktree: {root: workspace, realRoot: fs.realpathSync.native(workspace), branch: null, baseline: null},
      paradigm: 'plan-execute-verify', lane: 'product', routes: [], constraints: [], nonGoals: [],
      acceptanceCriteria: [{id:'AC-01', text:'Create the file', required:true}] });
    const task = {id:'task-1', description:'CREATE out-1.txt', dependsOn:[], criteria:['AC-01'], predictedWriteSet:['out-1.txt']};
    let state = supervision.createInitialSupervisionState({runId:'round8-checkpoint', mission, tasks:[task]});
    const store = new supervision.SupervisionStateStore(state.runId);
    store.create(state);
    state = store.appendCheckpoint(state, {kind:'plan', createdAt:new Date().toISOString(), missionHash:mission.missionHash, criteria:['AC-01'], effectChanges:[], outcome:'plan_ready'}, {plan:{tasks:[task]}});
    const snapshot = supervision.buildInspectionSnapshot(state);
    assert.equal(snapshot.planSummary.tasks[0].acceptanceCriteria[0].text, 'Create the file');
    assert.deepEqual(snapshot.planSummary.tasks[0].predictedWriteSet, ['out-1.txt']);
    assert.ok(fs.existsSync(snapshot.savedArtifacts.plan));
    assert.equal(snapshot.checkpointState.freshApprovalAvailable, true);
    assert.equal(snapshot.liveStatus.manifestState, 'not started yet');
    assert.ok(!snapshot.liveStatus.observationErrors.some(x => x.includes('phase manifest unavailable')));
    assert.equal(supervision.checkAutomaticPlanApproval(state, {allowedWriteSet:['out-1.txt']}).approved, true);
    for (const [tasks, scope, reason] of [
      [[], ['out-1.txt'], /missing/i],
      [[{...task,predictedWriteSet:['outside.txt']}], ['out-1.txt'], /scope/i],
      [[{...task,predictedWriteSet:['native/audio.cpp']}], ['native/'], /protected/i],
      [[{...task,predictedWriteSet:undefined}], ['out-1.txt'], /scope/i],
    ]) {
      const decision = supervision.checkAutomaticPlanApproval({...state,tasks}, {allowedWriteSet:scope});
      assert.equal(decision.approved,false); assert.match(decision.reasons.join(';'),reason);
    }
    process.env.PI_CLI_PATH = path.join(__dirname,'fake-pi.cjs');
    process.env.FAKE_PI_PLAN_STYLE = 'impl-1-ws';
    process.env.FAKE_PI_EXECUTOR_STYLE = 'write-summary-table';
    let tool;
    jiti(path.join(root,'src/index.ts')).default({registerTool(t){if(t.name==='orchestrate')tool=t},registerCommand(){}});
    const routes = {plannerProvider:'openai-codex',plannerModel:'gpt-6-astra',executorProvider:'openai-codex',executorModel:'gpt-6.1-sol',verifierProvider:'openai-codex',verifierModel:'gpt-6.1-sol'};
    const call = params => tool.execute('round8', {...routes,...params}, undefined, ()=>{}, {cwd:workspace});
    const planned = await call({task:'CREATE file out-1.txt',cwd:workspace,predictedWriteSet:'out-1.txt',preflight:false,maxRetries:0});
    assert.equal(planned.details.status,'awaiting_supervisor', JSON.stringify(planned.details.error ?? planned.details.infrastructureFailures));
    assert.equal(fs.existsSync(path.join(workspace,'out-1.txt')),false,'default off');
    const inspected = await call({action:'inspect',runId:planned.details.runId});
    assert.ok(inspected.details.planSummary.tasks.length);
    assert.equal(inspected.details.checkpointState.approvalOutstanding,true);
    assert.match(inspected.content[0].text,/Saved plan:/);
    // Plain supervisor: inspect the summary, then request a fresh approval and continue.
    const renewed = await call({action:'continue',runId:planned.details.runId});
    const executed = await call({action:'continue',runId:planned.details.runId,approvalToken:renewed.details.approvalToken});
    assert.equal(executed.details.checkpoint.kind,'executor');
    const settled = await call({action:'inspect',runId:planned.details.runId});
    assert.ok(settled.details.settledResult);
    assert.ok(settled.details.contentChanges.some(c=>c.path==='out-1.txt'));
    assert.ok(fs.existsSync(settled.details.savedArtifacts.result));
    fs.rmSync(path.join(workspace,'out-1.txt'));
    const automatic = await call({task:'CREATE file out-1.txt',cwd:workspace,predictedWriteSet:'out-1.txt',preflight:false,maxRetries:0,automaticPlanApproval:true});
    assert.equal(automatic.details.checkpoint.kind,'executor','intact opt-in plan enters executor');
    const durable = JSON.parse(fs.readFileSync(path.join(process.env.PI_ORCHESTRATOR_RUNS_ROOT,automatic.details.runId,'supervision.json')));
    assert.equal(durable.automaticPlanApprovals[0].authority,'fixed-host-checks');
    fs.rmSync(path.join(workspace,'out-1.txt'));
    for (const [style,reason] of [['round8-outside',/scope/i],['round8-protected',/protected/i],['round8-missing',/missing/i]]) {
      process.env.FAKE_PI_PLAN_STYLE=style;
      const refused=await call({task:'CREATE file out-1.txt',cwd:workspace,predictedWriteSet:'out-1.txt',automaticPlanApproval:true,preflight:false,maxRetries:0});
      assert.equal(refused.details.status,'awaiting_supervisor');
      assert.match(refused.details.pauseReason,reason);
      assert.equal(fs.existsSync(path.join(workspace,'out-1.txt')),false,'refused plan never dispatches executor');
    }
    // A whole-workspace cutoff must not starve the independently saved approved scope.
    const graphify=path.join(workspace,'graphify');fs.mkdirSync(graphify);
    for(let i=0;i<2001;i++)fs.writeFileSync(path.join(graphify,`b-${String(i).padStart(4,'0')}.md`),'unchanged');
    const product=path.join(workspace,'pi-orchestrator-extension');fs.mkdirSync(product);
    fs.writeFileSync(path.join(product,'index.ts'),'before');
    process.env.FAKE_PI_PLAN_STYLE='impl-1-ws';
    const partial=await call({task:'CREATE file out-1.txt',cwd:workspace,predictedWriteSet:'out-1.txt,pi-orchestrator-extension/',automaticPlanApproval:true,preflight:false,maxRetries:0});
    assert.equal(partial.details.checkpoint.kind,'executor');
    fs.writeFileSync(path.join(graphify,'a.md'),'cutoff shifter');
    fs.writeFileSync(path.join(product,'index.ts'),'after');
    const partialInspect=await call({action:'inspect',runId:partial.details.runId});
    assert.equal(partialInspect.details.contentCoverage.workspace.partial,true);
    assert.equal(partialInspect.details.contentCoverage.approvedScope.partial,false);
    assert.ok(partialInspect.details.contentCoverage.approvedScope.changes.some(c=>c.path==='pi-orchestrator-extension/index.ts'&&c.kind==='modified'));
    assert.ok(!partialInspect.details.contentChanges.some(c=>c.kind==='deleted'&&c.path.startsWith('graphify/')));
    const reference=partialInspect.details.contentCoverage.approvedScope.baselineReference;
    assert.ok(fs.existsSync(reference.split('#')[0]));
    assert.match(partialInspect.content[0].text,/Coverage: partial workspace/);
    console.log('PASS round8 checkpoint summaries, plain approval, fixed automatic approval, settled evidence and partial inspection scope coverage');
  } finally { fs.rmSync(externalTemp,{recursive:true,force:true}); }
})().catch(error => { console.error(error); process.exitCode=1; });
