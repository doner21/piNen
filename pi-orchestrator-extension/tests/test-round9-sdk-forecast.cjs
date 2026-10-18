// Real SDK binding, command/tool admission, durable plan and builder dispatch.
'use strict';
const {observeSync,expectedCommand,assertExpectedCommands,bindSync}=require('./fixtures/round9-command-proof.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{pathToFileURL}=require('node:url');
(async()=>{
 const ROOT=fs.realpathSync(path.resolve(__dirname,'..')),parent=process.argv[2];
 const canonical=p=>{assert.ok(p&&path.isAbsolute(p));for(let q=p;;q=path.dirname(q)){const s=fs.lstatSync(q);assert.ok(!s.isSymbolicLink());if(s.isFile())assert.equal(s.nlink,1);if(path.dirname(q)===q)break;}assert.equal(fs.realpathSync(p),path.resolve(p));return p;};
 const within=(a,b)=>{const r=path.relative(a,b);return !r||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
 canonical(parent);const externalTemp=path.join(parent,'s-'+crypto.randomBytes(4).toString('hex'));
 for(const protectedRoot of [path.dirname(ROOT),...(process.env.ROUND9_PROTECTED_ROOTS?JSON.parse(process.env.ROUND9_PROTECTED_ROOTS):[])])assert.ok(!within(protectedRoot,externalTemp)&&!within(externalTemp,protectedRoot));
 assert.ok(!fs.existsSync(externalTemp));
 const physical=p=>{const s=fs.lstatSync(p);assert.ok(!s.isSymbolicLink());if(s.isFile())assert.equal(s.nlink,1);else if(s.isDirectory())for(const name of fs.readdirSync(p))physical(path.join(p,name));};
 canonical(ROOT); // Already independently prepared; do not copy/inventory dependencies again.
 fs.mkdirSync(externalTemp);canonical(externalTemp);
 const frozen=ROOT,cwd=path.join(externalTemp,'p'),runDir=path.join(externalTemp,'r');
 fs.mkdirSync(cwd);fs.mkdirSync(runDir);
 const launcher=await import(pathToFileURL(path.join(ROOT,'../agent/skills/headless-orchestration/scripts/launch.mjs')).href);
 const worker=path.join(externalTemp,'worker.cjs');fs.copyFileSync(path.join(__dirname,'fixtures/round9-worker.cjs'),worker);
 Object.assign(process.env,launcher.childEnvironment({cwd,runDir,piCli:worker}));
 for(const dir of ['agent','runs','next-runs','user-workflows','project-workflows','tmp','cache'])fs.mkdirSync(path.join(runDir,'runtime',dir),{recursive:true});fs.mkdirSync(path.join(runDir,'sessions'));
 require('./fixtures/round8-models.cjs')(process.env.PI_CODING_AGENT_DIR);
 const log=path.join(externalTemp,'workers.jsonl'),config=path.join(externalTemp,'worker-config.json');process.env.ROUND9_WORKER_CONFIG=config;
 const plan=(file,needs=[])=>({tasks:[{id:'task-1',description:'Inspect the fixture only; no file changes.',dependsOn:[],expectsFileChange:false,outputType:'validation'}],protected_areas_needed:needs,predicted_write_set:[file]});
 const configure=(file,needs=[])=>fs.writeFileSync(config,JSON.stringify({log,plan:plan(file,needs)}));
 const calls=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 const builders=()=>calls().filter(c=>c.role==='builder').length;
 const cp=require('node:child_process'),{syncBuiltinESMExports}=require('node:module'),originalSpawn=cp.spawn,nativeSync=cp.spawnSync,originalSpawnSync=bindSync(nativeSync),children=[],observers=[],syncCommands=[],absence=new Map();
 // Independent OS identities, not launcher claims or a signal-zero PID probe.
 // The deterministic EOF fixture has no subprocess/tool execution capability.
 const descendants=(rows,pid)=>{const found=new Set([pid]);for(let n=0;n<rows.length;n++){const size=found.size;for(const p of rows){const parent=rows.find(row=>row.ProcessId===p.ParentProcessId);
  // CIM emits fixed-width UTC birth identities. A stale creator PID is not
  // ancestry when the child predates that creator generation (even sub-ms).
  if(parent&&found.has(parent.ProcessId)&&typeof p.created==='string'&&typeof parent.created==='string'&&p.created>=parent.created)found.add(p.ProcessId);
 }if(size===found.size)break;}return rows.filter(p=>p.ProcessId!==pid&&found.has(p.ProcessId));};
 const snapshot=()=>{const r=originalSpawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-Command',"$rows=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{n='created';e={$_.CreationDate.ToUniversalTime().ToString('o')}}); ConvertTo-Json -Compress -InputObject $rows"],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,'independent inventory observer returned normally');assert.equal(r.signal,null);const rows=JSON.parse(r.stdout);observers.push({pid:r.pid,expectedCommand:r.expectedCommand,status:r.status,signal:r.signal,completedAt:r.completedAt,identity:rows.find(p=>p.ProcessId===r.pid),descendants:descendants(rows,r.pid)});for(const record of [...children,...observers,...syncCommands])for(const g of [record.identity,...(record.descendants??[])])if(g&&!rows.some(p=>p.ProcessId===(g.pid??g.ProcessId)))absence.set((g.pid??g.ProcessId)+':'+(g.born??g.created),{pid:g.pid??g.ProcessId,parentPid:g.parentPid??g.ParentProcessId,born:g.born??g.created,at:new Date().toISOString()});return rows;};
 const initialRows=snapshot(),testIdentity=initialRows.find(p=>p.ProcessId===process.pid),wrapperIdentity=initialRows.find(p=>p.ProcessId===testIdentity.ParentProcessId);
 cp.spawn=(...args)=>{const child=originalSpawn(...args);const record={child,pid:child.pid,settled:false,expectedCommand:require('./fixtures/round9-command-proof.cjs').expectedCommand(args[0],args[1])};children.push(record);const end=child.stdin?.end.bind(child.stdin);let pendingEnd;if(end)child.stdin.end=(...a)=>{if(!record.identity){pendingEnd=a;return child.stdin;}return end(...a);};child.once('spawn',()=>{try{const rows=snapshot();record.identity=rows.find(p=>p.ProcessId===child.pid);assert.ok(record.identity,'root kernel identity captured before stdin EOF');record.descendants=descendants(rows,child.pid);assert.ok(record.descendants.every(p=>p.Name==='conhost.exe'),'only OS console helpers, no fixture-spawned processes');}catch(error){record.inventoryError=error.message;}finally{if(pendingEnd)end(...pendingEnd);}});child.once('close',(code,signal)=>{Object.assign(record,{settled:true,code,signal,completedAt:new Date().toISOString()});});return child;};
 cp.spawnSync=(...args)=>observeSync(originalSpawnSync,syncCommands,...args);
 syncBuiltinESMExports();
 let session;

 // Legacy PEV's write-set observer requires a git-observable workspace. This
 // creates only an empty repository in owned scratch: no staging or commits.
 let failure;
 try{
  const initialized=cp.spawnSync('C:/Program Files/Git/cmd/git.exe',['init','--quiet',cwd],{windowsHide:true,encoding:'utf8'});assert.equal(initialized.status,0);
  const sdk=await import(pathToFileURL(path.join(frozen,'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  const settingsManager=sdk.SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false,maxRetries:0},cacheWarming:'off'});
  const modelRuntime=await sdk.ModelRuntime.create({allowModelNetwork:false,refreshOnCreate:false,authPath:path.join(process.env.PI_CODING_AGENT_DIR,'auth.json'),modelsPath:path.join(process.env.PI_CODING_AGENT_DIR,'models.json'),modelsStorePath:path.join(process.env.PI_CODING_AGENT_DIR,'models-store.json')});
  const resourceLoader=new sdk.DefaultResourceLoader({cwd,agentDir:process.env.PI_CODING_AGENT_DIR,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,additionalExtensionPaths:[path.join(frozen,'src/index.ts')],systemPrompt:'Offline command host; no model requests.'});
  await resourceLoader.reload();assert.deepEqual(resourceLoader.getExtensions().errors,[]);
  ({session}=await sdk.createAgentSession({cwd,agentDir:process.env.PI_CODING_AGENT_DIR,modelRuntime,model:modelRuntime.getModel('openai-codex','gpt-6-astra'),resourceLoader,settingsManager,tools:['orchestrate'],sessionManager:sdk.SessionManager.inMemory(cwd)}));
  await session.bindExtensions({mode:'json',uiContext:{notify(){},setWidget(){},setStatus(){},setEditorText(){},onTerminalInput:()=>()=>{}}});
  let latest;session.subscribe(e=>{if(e.type==='message_end'&&e.message?.role==='custom'&&e.message.customType==='orchestrate-result')latest=e.message.details;});
  const command=async text=>{latest=undefined;await session.prompt(text);return latest;};
  const tool=session.agent.state.tools.find(t=>t.name==='orchestrate');assert.ok(tool);
  const base={action:'run',cwd,supervision:'visible-main',paradigm:'plan-execute-verify',adaptiveSupervision:'off',plannerProvider:'openai-codex',plannerModel:'gpt-6-astra',executorProvider:'openai-codex',executorModel:'gpt-6.1-sol',verifierProvider:'openai-codex',verifierModel:'gpt-6.1-sol',plannerCount:1,executorConcurrency:1,verifierCount:1,maxRetries:0,maxSubagents:5,noForceKill:true,preflight:false,task:'Inspect the fixture only; no file changes.'};
  const controls='--paradigm plan-execute-verify --adaptive-supervision off --planner-provider openai-codex --planner-model gpt-6-astra --executor-provider openai-codex --executor-model gpt-6.1-sol --verifier-provider openai-codex --verifier-model gpt-6.1-sol --planner-count 1 --executor-concurrency 1 --verifier-count 1 --max-retries 0 --no-force-kill --no-preflight --max-subagents 5';
  const waiter='tools/phase1/native/waiter.cpp',observed='native-observe-notify-wake:'+waiter,covering='native-code:tools/phase1/native/';
  for(const supervision of ['visible-main','off']){
   configure(waiter,[observed]);const before=builders();
   await tool.execute('covering-observation',{...base,supervision,automaticPlanApproval:true,predictedWriteSet:waiter,protectedAreasNeeded:[observed],protectedAreaGrants:[covering]});
   assert.equal(builders(),before+1,'covering native grant admits narrow observe/notify/wake on the public builder route');
  }
  for(const name of ['STOP.cpp','device.cpp','lease.cpp','voice-allocation.cpp','crossfade.cpp','A-B.cpp']){
   const file='tools/phase1/native/'+name;configure(file,[observed]);const before=builders();
   const refused=await tool.execute('observe-negative',{...base,automaticPlanApproval:true,predictedWriteSet:file,protectedAreasNeeded:[observed],protectedAreaGrants:[observed]});
   assert.equal(builders(),before,'narrow observation excludes '+name);assert.equal(refused.details.status,'awaiting_supervisor');
  }
  if(process.argv.includes('--covering-only')){console.log('PASS public covering native grant and STOP/device/lease/allocation/A-B negatives; visible-main and off');return;}
  const file='tools/stage6/native/CMakeLists.txt',exact='native-code:'+file;
  for(const automaticPlanApproval of [false,true]){
   configure(file);const before=builders();
   const result=await tool.execute('forecast-'+automaticPlanApproval,{...base,predictedWriteSet:file,automaticPlanApproval});
   assert.equal(result.details.status,'awaiting_supervisor','planner inspection must reach the plan checkpoint, not cancel before launch');const id=result.details.runId;
   assert.ok(calls().filter(c=>c.role==='planner').every(c=>c.tools==='read,grep,find,ls'),'planner uses an enforced read-only capability allowlist');
   const inspected=await command('/orchestrate inspect --run-id '+id);assert.equal(inspected.protectedAreaDecision.approved,false,'native producing CMake is protected');
   const saved=JSON.parse(fs.readFileSync(inspected.savedArtifacts.plan,'utf8'));assert.ok(saved.payload.plan.protectedAreasNeeded.includes(exact),'saved effective forecast retains the inferred precise native need');
   await command('/orchestrate continue --run-id '+id+' --approval-token '+result.details.approvalToken);
   assert.equal(builders(),before,'manual/automatic rejection launches zero builders');
  }
  configure(file);let before=builders();
  const rejected=await command('/orchestrate run '+controls+' --supervision visible-main --automatic-plan-approval on --write-set '+file+' -- '+base.task);
  assert.equal(rejected.status,'awaiting_supervisor');assert.equal(builders(),before,'command auto rejection');
  // Legacy/off is not permission to bypass owner grants. The fixture never edits native files even on RED.
  configure(file);before=builders();
  try{await tool.execute('off-rejected',{...base,supervision:'off',predictedWriteSet:file});}catch(error){assert.match(error.message,/protected|permission/i);}
  assert.equal(builders(),before,'public off tool rejects before builder');
  await command('/orchestrate run '+controls+' --supervision off --write-set '+file+' -- '+base.task);
  assert.equal(builders(),before,'public off command rejects before builder');
  // Other protected native roots, generated inputs and explicit needs use the same public route.
  for(const protectedFile of ['experiments/phase0/parallel-crossfade/host.cpp','tools/phase1/native/build.ps1','generated/new.hxx','generated/engine.cpp.in']){
   configure(protectedFile);const count=builders();
   const denied=await tool.execute('native-forecast',{...base,predictedWriteSet:protectedFile,automaticPlanApproval:true});
   assert.equal(denied.details.status,'awaiting_supervisor');assert.equal(builders(),count);
  }
  configure('src/ordinary.ts',['live-hardware']);
  const explicit=await tool.execute('explicit-need',{...base,predictedWriteSet:'src/ordinary.ts',automaticPlanApproval:true});
  assert.equal(explicit.details.protectedAreaDecision.approved,false,'explicit live hardware needs never disappear');assert.equal(builders(),before);
  // A precise mission admission grant succeeds; planner-supplied grants never do.
  configure(file,[exact]);
  const granted=await tool.execute('precise-granted',{...base,predictedWriteSet:file,protectedAreasNeeded:[exact],protectedAreaGrants:[exact],automaticPlanApproval:true});
  assert.equal(builders(),before+1,'precise grant survives normalization, save, automatic approval and actual dispatch');
  assert.equal(granted.details.status,'awaiting_supervisor');
  const grantedState=JSON.parse(fs.readFileSync(path.join(process.env.PI_ORCHESTRATOR_RUNS_ROOT,granted.details.runId,'supervision.json'),'utf8'));
  assert.deepEqual(grantedState.mission.protectedAreaGrants,[exact]);
  before=builders();configure(file,[exact]);
  const commandGrant=await command('/orchestrate run '+controls+' --supervision visible-main --automatic-plan-approval on --write-set '+file+' --protected-areas-needed '+JSON.stringify(JSON.stringify([exact]))+' --protected-area-grants '+JSON.stringify(JSON.stringify([exact]))+' -- '+base.task);
  assert.ok(commandGrant?.runId);assert.equal(builders(),before+1,'exact command grant reaches actual dispatch');
  // Manual approval is not a grant, but an exact admission grant remains
  // usable with manual approval and with supervision explicitly disabled.
  configure(file,[exact]);before=builders();
  const manualGrant=await tool.execute('manual-precise-grant',{...base,predictedWriteSet:file,protectedAreasNeeded:[exact],protectedAreaGrants:[exact],automaticPlanApproval:false});
  assert.equal(builders(),before,'manual grant waits for checkpoint approval');
  await tool.execute('manual-continue',{action:'continue',runId:manualGrant.details.runId,approvalToken:manualGrant.details.approvalToken});
  assert.equal(builders(),before+1,'manual exact grant reaches actual builder dispatch');
  before=builders();
  await tool.execute('off-precise-grant',{...base,supervision:'off',predictedWriteSet:file,protectedAreasNeeded:[exact],protectedAreaGrants:[exact]});
  assert.equal(builders(),before+1,'off preserves precise grant admission');
  before=builders();configure(file);
  const wrongScope=await tool.execute('wrong-scope',{...base,predictedWriteSet:file,protectedAreaGrants:['native-code:tools/phase1/native/'],automaticPlanApproval:true});
  assert.equal(wrongScope.details.status,'awaiting_supervisor');assert.equal(builders(),before,'unrelated scoped grant never launches a builder');
  configure('src/ordinary.ts');before=builders();
  const offOrdinary=await tool.execute('off-ordinary',{...base,supervision:'off',predictedWriteSet:'src/ordinary.ts'});
  assert.equal(builders(),before+1,'off ordinary TS remains allowed');assert.ok(offOrdinary.details);
  before=builders();
  const ordinary=await command('/orchestrate run '+controls+' --supervision visible-main --automatic-plan-approval off --write-set src/ordinary.ts --protected-areas-needed "[]" --protected-area-grants "[]" -- '+base.task);
  assert.ok(ordinary?.runId,'command accepts exact permission admission fields');
  const statePath=path.join(process.env.PI_ORCHESTRATOR_RUNS_ROOT,ordinary.runId,'supervision.json');
  const ordinaryState=JSON.parse(fs.readFileSync(statePath,'utf8'));assert.deepEqual(ordinaryState.runtime.plan.protectedAreasNeeded,[]);
  const continued=await command('/orchestrate continue --run-id '+ordinary.runId+' --approval-token '+ordinary.approvalToken);
  assert.equal(builders(),before+1,'ordinary TS manual approval dispatches');assert.equal(continued.status,'awaiting_supervisor');
  // Race a durable change after the outer permission check but before the exclusive load.
  for(const mutation of ['need','task','grant']){
   configure('src/fenced.ts');const fenced=await tool.execute('fenced',{...base,predictedWriteSet:'src/fenced.ts'});
   const fenceStatePath=path.join(process.env.PI_ORCHESTRATOR_RUNS_ROOT,fenced.details.runId,'supervision.json');
   const originalOpen=fs.openSync;let changed=false;before=builders();
   fs.openSync=function(p,...args){if(String(p)===fenceStatePath+'.approval.lock'&&!changed){changed=true;const s=JSON.parse(fs.readFileSync(fenceStatePath,'utf8'));
    if(mutation==='need')s.runtime.plan.protectedAreasNeeded=['native-code'];
    if(mutation==='task')s.runtime.plan.tasks[0].predictedWriteSet=['generated/late.cpp'];
    if(mutation==='grant')s.mission.protectedAreaGrants=['native-code'];
    fs.writeFileSync(fenceStatePath,JSON.stringify(s));}return originalOpen.call(this,p,...args);};
   try{await command('/orchestrate continue --run-id '+fenced.details.runId+' --approval-token '+fenced.details.approvalToken);}finally{fs.openSync=originalOpen;}
   assert.ok(changed,'production approval fence reached');assert.equal(builders(),before,'under-fence changed '+mutation+' cannot launch');
   assert.equal(JSON.parse(fs.readFileSync(fenceStatePath,'utf8')).currentApproval.consumedAt,undefined,'rejection does not consume authority');
  }
  // Standalone exported PEV shape uses the substrate launcher, not index's inline launcher.
  const jiti=require(path.join(frozen,'node_modules/jiti'))(__filename,{interopDefault:true,moduleCache:false,fsCache:false});
  const {planExecuteVerifyShape}=await jiti.import(path.join(frozen,'src/shapes/plan-execute-verify.ts'));
  const agents=new Map([['planner',{name:'planner',provider:'openai-codex',model:'gpt-6-astra'}],['coder',{name:'coder',provider:'openai-codex',model:'gpt-6.1-sol'}],['reviewer',{name:'reviewer',provider:'openai-codex',model:'gpt-6.1-sol'}]]);
  const standalone={...base,plannerAgent:'planner',executorAgent:'coder',verifierAgent:'reviewer',supervision:'off',concurrency:1,maxRetriesExplicit:true,maxSubagentsExplicit:true,allowLocalModel:false,hardGates:'off',discoveryOnly:false,orchestrationControls:{runtimeRoles:[],rawMatches:[]},workerExecutionConstraints:{noForceKill:true}};
  configure(file);before=builders();const plannerCount=calls().filter(c=>c.role==='planner').length;
  try{await planExecuteVerifyShape.run({params:{...standalone,predictedWriteSet:[file],protectedAreasNeeded:[],protectedAreaGrants:[]},agents,inferredModelRouting:{}});}catch(error){assert.match(error.message,/protected|permission/i);}
  assert.equal(calls().filter(c=>c.role==='planner').length,plannerCount+1,'standalone planner may inspect protected input before the saved-plan permission decision');
  assert.equal(builders(),before,'standalone PEV refuses ungranted native input');
  configure(file,[exact]);
  await planExecuteVerifyShape.run({params:{...standalone,predictedWriteSet:[file],protectedAreasNeeded:[exact],protectedAreaGrants:[exact]},agents,inferredModelRouting:{}});
  assert.equal(builders(),before+1,'standalone exact grant reaches the substrate builder');before=builders();
  configure('src/ordinary.ts');const standaloneResult=await planExecuteVerifyShape.run({params:{...standalone,predictedWriteSet:['src/ordinary.ts'],protectedAreasNeeded:[],protectedAreaGrants:[]},agents,inferredModelRouting:{}});
  assert.equal(builders(),before+1,'standalone ordinary TS dispatches');assert.ok(standaloneResult);
  const {spawnSubagent}=await jiti.import(path.join(frozen,'src/substrate.ts'));
  configure(file);before=builders();
  const guarded={agents,cwd,allowLocalModel:false,workerExecutionConstraints:{noForceKill:true,protectedAreaAuthorization:{needed:[],grants:[],paths:[file]}}};
  await assert.rejects(()=>spawnSubagent('coder','Inspect only',guarded),/protected|permission/i,'unknown builder capabilities are checked even without phaseMutates');
  assert.equal(builders(),before,'direct substrate gate refuses before launch');
  const inspectAgents=new Map(agents);inspectAgents.set('planner',{...agents.get('planner'),tools:['read','grep','find','ls']});
  await spawnSubagent('planner','Inspect only',{...guarded,agents:inspectAgents});
  assert.equal(builders(),before,'real substrate honors the exact read-only profile, not just role labels');
  assert.ok(calls().filter(c=>c.role==='planner').every(c=>c.tools==='read,grep,find,ls'),'both launchers install read-only planner capabilities');
  console.log('PASS public command/tool -> saved plan -> manual/automatic/fenced dispatch, off and standalone PEV; precise grants and ordinary TS');
 }catch(error){failure=error;}finally{
  session?.dispose();cp.spawn=originalSpawn;cp.spawnSync=nativeSync;syncBuiltinESMExports();
  // All launcher roots and fixtures complete naturally. The fixture starts no helpers.
  for(const r of children){if(!r.settled)await new Promise(resolve=>r.child.once('close',resolve));assert.equal(r.signal,null);}
  const rows=snapshot();
  const ended=(g,r)=>{if(!g)return false;const pid=g.pid??g.ProcessId,born=g.born??g.created,current=rows.find(p=>p.ProcessId===pid);return !current||current.created!==born&&(pid===r.pid&&r.signal===null&&Number.isInteger(r.code??r.status)||absence.has(pid+':'+born));};
  const proof=children.map(r=>{const generation=[r.identity,...(r.descendants??[])];return {pid:r.pid,code:r.code,signal:r.signal,expectedCommand:r.expectedCommand,identity:r.identity,descendants:r.descendants,inventoryError:r.inventoryError,absent:generation.every(g=>ended(g,r))};});
  // Write useful failure proof BEFORE assertions, retaining missing identities.
  fs.writeFileSync(path.join(externalTemp,'sdk-forecast-process-proof.json'),JSON.stringify({testPid:process.pid,testIdentity,wrapperIdentity,children:proof,observers,syncCommands,visibleWindows:0,independentlyAbsentGenerations:[...absence.values()]}));
  const normalized=records=>records.map(r=>({...r,identity:r.identity?{pid:r.identity.pid??r.identity.ProcessId,born:r.identity.born??r.identity.created}:undefined}));
  assertExpectedCommands([...normalized(proof),...syncCommands,...normalized(observers)]);
  assert.ok(proof.every(r=>r.identity&&!r.inventoryError&&r.absent),'independent inventory proves every recorded generation and console helper absent; reused PID is not clean');
  assert.ok(calls().every(c=>proof.some(r=>r.pid===c.pid)),'every fixture launch accounted');
  assert.ok(observers.slice(0,-1).every(r=>r.status===0&&r.signal===null&&[r.identity,...r.descendants].every(g=>ended(g,r))),'inventory observers and console helpers require independent old-generation completion, not PID-only assertions');
  assert.ok(syncCommands.every(r=>r.signal===null&&[r.identity,...(r.descendants??[])].every(g=>ended(g,r))),'creation-bound synchronous Git generations absent (PID reuse alone is not evidence)');

  console.log('CLEANUP all '+proof.length+' worker generations and console helpers independently absent; EOF cleanup, no visible windows');
 }
 if(failure)throw failure;
})().catch(error=>{console.error('SDK_FORECAST_CHECK_FAILED: '+error.name+' '+String(error.message).replace(/[\r\n]+/g,' ').slice(0,220));process.exitCode=1;});
