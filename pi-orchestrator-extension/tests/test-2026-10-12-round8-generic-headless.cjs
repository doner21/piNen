// Real frozen SDK/resource-loader/command host; worker responses remain deterministic fixtures.
// This does NOT prove an Astra supervisor or real worker monitor loading.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
(async()=>{
 const originalCwd=process.cwd();
 const root=path.resolve(__dirname,'..');
 // Keep nested SDK package paths below Windows package-resolution limits.
 // The isolated runner already adds a unique owner directory.
 const temp=require('./fixtures/round8-owned-temp.cjs')('r8');
 let session;
 try {
  const cwd=path.join(temp,'project'),frozen=path.join(temp,'frozen'),runDir=path.join(temp,'run');
  fs.mkdirSync(cwd);fs.mkdirSync(frozen);fs.mkdirSync(runDir);
  // Physical candidate copy, including its owned SDK and peers. Never load running source.
  fs.cpSync(path.join(root,'src'),path.join(frozen,'src'),{recursive:true,dereference:true});
  fs.cpSync(path.join(root,'node_modules'),path.join(frozen,'node_modules'),{recursive:true,dereference:true});
  for(const peer of ['pi-ai','pi-agent-core','pi-tui','pi-telemetry']) {
   const target=path.join(frozen,'node_modules/@earendil-works',peer);
   if(!fs.existsSync(target))throw Error('Physically provision SDK peer '+peer+' before running this test');
  }
  const noLinks=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,e.name);assert.equal(fs.lstatSync(full).isSymbolicLink(),false);if(e.isDirectory())noLinks(full)}};noLinks(frozen);
  const workflows=path.join(cwd,'.pi','orchestrator-workflows');fs.mkdirSync(workflows,{recursive:true});
  fs.copyFileSync(path.join(root,'../agent/skills/headless-orchestration/references/two-builds.workflow.json'),path.join(workflows,'two-builds.workflow.json'));
  const launcher=await import(pathToFileURL(path.join(root,'../agent/skills/headless-orchestration/scripts/launch.mjs')).href);
  Object.assign(process.env,launcher.childEnvironment({cwd,runDir,piCli:path.join(__dirname,'fake-pi.cjs')}));
  for(const dir of ['agent','runs','next-runs','user-workflows','project-workflows','tmp','cache'])fs.mkdirSync(path.join(runDir,'runtime',dir),{recursive:true});
  fs.mkdirSync(path.join(runDir,'sessions'));
  require('./fixtures/round8-models.cjs')(process.env.PI_CODING_AGENT_DIR);
  process.env.FAKE_PI_EXECUTOR_STYLE='write-summary-table';
  const log=path.join(temp,'calls.jsonl');process.env.FAKE_PI_LOG=log;
  assert.equal(process.env.PI_ORCHESTRATOR_PROJECT_WORKFLOWS_ROOT,workflows);
  const sdk=await import(pathToFileURL(path.join(frozen,'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  const settingsManager=sdk.SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false,maxRetries:0},cacheWarming:'off'});
  const modelRuntime=await sdk.ModelRuntime.create({allowModelNetwork:false,authPath:path.join(process.env.PI_CODING_AGENT_DIR,'auth.json'),modelsPath:path.join(process.env.PI_CODING_AGENT_DIR,'models.json'),modelsStorePath:path.join(process.env.PI_CODING_AGENT_DIR,'models-store.json')});
  const model=modelRuntime.getModel('openai-codex','gpt-6-astra');assert.ok(model);
  const resourceLoader=new sdk.DefaultResourceLoader({cwd,agentDir:process.env.PI_CODING_AGENT_DIR,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,additionalExtensionPaths:[path.join(frozen,'src/index.ts')],systemPrompt:'Fixture command host. No model prompts.'});
  await resourceLoader.reload();assert.deepEqual(resourceLoader.getExtensions().errors,[]);
  ({session}=await sdk.createAgentSession({cwd,agentDir:process.env.PI_CODING_AGENT_DIR,modelRuntime,model,resourceLoader,settingsManager,tools:['orchestrate'],sessionManager:sdk.SessionManager.inMemory(cwd)}));
  await session.bindExtensions({mode:'json',uiContext:{notify(){},setWidget(){},setStatus(){},setEditorText(){},onTerminalInput:()=>()=>{}}});
  assert.ok(session.getActiveToolNames().includes('orchestrate'));
  let latest;
  session.subscribe(e=>{if(e.type==='message_end'&&e.message?.role==='custom'&&e.message.customType==='orchestrate-result')latest=e.message.details});
  const command=async text=>{latest=undefined;await session.prompt(text);assert.ok(latest,'real command host must return custom result');return latest};
  const controls='--supervision visible-main --paradigm two-builds --adaptive-supervision off --planner-provider openai-codex --planner-model gpt-6-astra --executor-provider openai-codex --executor-model gpt-6.1-sol --verifier-provider openai-codex --verifier-model gpt-6.1-sol --planner-count 1 --executor-concurrency 1 --verifier-count 1 --max-retries 0 --no-force-kill --no-preflight --max-subagents 5 --predicted-write-set out-1.txt,out-2.txt --automatic-plan-approval off';
  const commandFile=path.join(runDir,'command.txt'),configFile=path.join(runDir,'config.json');
  for(const file of ['system.md','supervisor.md'])fs.writeFileSync(path.join(runDir,file),'Plain supervisor fixture');
  const cfg={nodeExe:process.execPath,cwd,frozenRoot:frozen,runDir,extension:path.join(frozen,'src/index.ts'),sdkEntry:path.join(frozen,'node_modules/@earendil-works/pi-coding-agent/dist/index.js'),piCli:path.join(frozen,'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),provider:'openai-codex',model:'gpt-6-astra',evidenceRoots:[],systemFile:path.join(runDir,'system.md'),supervisorFile:path.join(runDir,'supervisor.md'),commandFile,automaticPlanApproval:false};
  const initialCommand='/orchestrate run '+controls+' -- CREATE file out-1.txt and CREATE file out-2.txt; verify each change.';
  fs.writeFileSync(commandFile,initialCommand);fs.writeFileSync(configFile,JSON.stringify(cfg));
  assert.equal(launcher.validateConfig(configFile).cfg.automaticPlanApproval,false,'arbitrary project paradigm with default-off');
  fs.writeFileSync(commandFile,initialCommand.replace('--automatic-plan-approval off','--automatic-plan-approval on'));
  assert.throws(()=>launcher.validateConfig(configFile),/DECLARE_AUTOMATIC/);
  cfg.automaticPlanApproval=true;fs.writeFileSync(configFile,JSON.stringify(cfg));
  assert.equal(launcher.validateConfig(configFile).cfg.automaticPlanApproval,true);
  fs.writeFileSync(commandFile,initialCommand);cfg.automaticPlanApproval=false;fs.writeFileSync(configFile,JSON.stringify(cfg));
  let result=await command(initialCommand);
  const runId=result.runId;assert.ok(runId);assert.equal(result.checkpoint.kind,'plan');
  assert.equal(fs.existsSync(path.join(cwd,'out-1.txt')),false,'default-off plan requires approval');
  let checkpoints=0;
  while(result.status!=='terminal'&&checkpoints<7){
   const inspected=await command('/orchestrate inspect --run-id '+runId);
   assert.equal(inspected.planSummary.tasks.length,4);assert.ok(inspected.savedArtifacts.plan);
   assert.equal(inspected.checkpointState.freshApprovalAvailable,true);
   if(checkpoints===0)assert.equal(inspected.liveStatus.manifestState,'not started yet');
   else {
    assert.equal(inspected.liveStatus.manifestState,'available');
    assert.ok(inspected.liveStatus.phases.length,'settled phases visible at each phase checkpoint');
    const expected=['build-one','verify-one','build-two','verify-two'][checkpoints-1];
    if(expected)assert.ok(inspected.liveStatus.phases.some(p=>p.name.includes(expected)&&p.status==='done'),'assigned phase visibly settled, not just a manifest existence flag');
    assert.equal(inspected.liveStatus.phase,null,'no stopped phase is presented as an active worker');
   }
   if(checkpoints===1){
    assert.equal(fs.existsSync(path.join(cwd,'out-1.txt')),true);
    assert.equal(fs.existsSync(path.join(cwd,'out-2.txt')),false,'second phase must not replay mission-wide CREATE');
    const paused=await command('/orchestrate pause --run-id '+runId);
    assert.equal(paused.status,'paused','controlled checkpoint recovery');
    const recovered=await command('/orchestrate inspect --run-id '+runId);
    assert.ok(recovered.allowedNextActions.includes('continue'));
   }
   // Plain supervisor behavior, through the owning SDK command boundary.
   const renewed=await command('/orchestrate continue --run-id '+runId);
   result=await command('/orchestrate continue --run-id '+runId+' --approval-token '+renewed.approvalToken);
   checkpoints++;
  }
  assert.equal(result.terminalOutcome,'pass');
  for(const file of ['out-1.txt','out-2.txt'])assert.ok(fs.readFileSync(path.join(cwd,file),'utf8').includes(file));
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.slice(0,4).map(c=>c.agentName),['coder','reviewer','coder','reviewer']);
  assert.ok(calls.slice(4).every(c=>c.agentName==='reviewer'),'only final criterion verification may follow the four assigned phases');
  assert.ok(calls.every(c=>c.provider==='openai-codex'&&c.model==='gpt-6.1-sol'),'exact executor/verifier routes');
  const runPath=path.join(process.env.PI_ORCHESTRATOR_RUNS_ROOT,runId);
  const durable=JSON.parse(fs.readFileSync(path.join(runPath,'supervision.json')));
  const effects=durable.checkpoints.filter(c=>c.kind==='executor');
  assert.equal(effects.length,4);assert.deepEqual(effects.filter(c=>c.effectChanges.length).map(c=>c.effectChanges.map(e=>e.path)),[['out-1.txt'],['out-2.txt']]);
  const manifest=JSON.parse(fs.readFileSync(path.join(runPath,'state.json')));
  assert.equal(manifest.phases.length,4);assert.ok(manifest.phases.every(p=>p.status==='done'));
  const inspected=await command('/orchestrate inspect --run-id '+runId);
  assert.equal(inspected.liveStatus.manifestState,'available','phase status is projected through inspect');
  assert.equal(inspected.liveStatus.going,'not going','settled host is not reported running');
  assert.equal(inspected.liveStatus.phases.length,4);
  assert.ok(inspected.liveStatus.phases.every(p=>p.status==='done'));
  const commands=result.commandTimes.entries.filter(e=>e.tool==='bash');
  assert.equal(commands.length,2,'both actual phase commands must survive checkpoint recovery');
  assert.equal(new Set(commands.map(e=>e.launchId)).size,2,'independent phase launches');
  assert.ok(commands.every(e=>e.outcome==='succeeded'&&e.startedAt&&e.endedAt&&e.durationMs>=0),'settled host timings, not mere object presence');
  console.log('PASS owned frozen SDK headless command host, project discovery, approvals, two changes each independently verified, status/effects/command timing and controlled checkpoint recovery. Real-model supervisor/transport-loss recovery remain separate boundaries.');
 }finally{
  session?.dispose();process.chdir(originalCwd);
  // Windows keeps loaded SDK native modules mapped. The owning outer test
  // runner removes this scratch only after the child has settled.
 }
})().catch(e=>{console.error(e);process.exitCode=1});
