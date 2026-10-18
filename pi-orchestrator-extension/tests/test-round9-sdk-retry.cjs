// Public lifecycle + both launchers; host-owned restoration response, never a worker assertion.
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),cp=require('node:child_process'),{pathToFileURL}=require('node:url'),{syncBuiltinESMExports}=require('node:module');
const ROOT=path.resolve(__dirname,'..'),originalSpawn=cp.spawn,originalSync=(...args)=>require('./fixtures/round9-command-proof.cjs').bindSync(nativeSync)(...args),nativeSync=cp.spawnSync,children=[],observers=[],syncCommands=[],hostProof=[],absence=new Map();
const {observeSync,expectedCommand,assertExpectedCommands,processInventoryRows}=require('./fixtures/round9-command-proof.cjs');
const descendants=(rows,pid)=>{const ids=new Set([pid]);for(let i=0;i<rows.length;i++){const n=ids.size;for(const row of rows){const parent=rows.find(p=>p.pid===row.parentPid);if(parent&&ids.has(parent.pid)&&Date.parse(row.born)>=Date.parse(parent.born))ids.add(row.pid);}if(n===ids.size)break;}return rows.filter(p=>p.pid!==pid&&ids.has(p.pid));};
const nestedRecords=()=>hostProof.flatMap(p=>[...p.children,...p.syncCommands,...p.observers]);
let previousSample;
const creatorSamples=[];
function retainSample(rows,at,boundary='independent_snapshot'){
 for(const record of [...children,...observers,...syncCommands,...nestedRecords()])for(const g of [record.identity,...(record.descendants??[])].filter(Boolean))if(!rows.some(p=>p.pid===g.pid))absence.set(g.pid+':'+g.born,{...g,at});
 // Include the native-close boundary: the production recorder samples there
 // too. PID 0 is excluded by its parser, not a reason to drop that observation.
 if(process.argv.includes('--creator-probe'))for(const record of children.filter(r=>r.identity))for(const candidate of rows.filter(r=>r.born>=record.identity.born&&(!record.completedAt||Date.parse(r.born)<=Date.parse(record.completedAt))&&r.parentPid>0&&!rows.some(p=>p.pid===r.parentPid&&p.born<=r.born)))creatorSamples.push({at,boundary,previousAt:previousSample?.at,previousBoundary:previousSample?.boundary,root:record.identity,nativeRootCompletion:record.closed?{code:record.code,signal:record.signal,completedAt:record.completedAt}:null,candidate,comparedCreator:rows.find(r=>r.pid===candidate.parentPid)??null,previousCandidate:previousSample?.rows.find(r=>r.pid===candidate.pid&&r.born===candidate.born)??null,previousCreator:previousSample?.rows.find(r=>r.pid===candidate.parentPid&&r.born<=candidate.born)??null});
 previousSample={at,rows,boundary};
}
function snapshot(){const r=originalSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-Command',"$r=@(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -gt 0} | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='parentPid';e={[int]$_.ParentProcessId}},@{n='born';e={$_.CreationDate.ToUniversalTime().ToString('o')}}); ConvertTo-Json -Compress -InputObject $r"],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0);assert.equal(r.signal,null);const rows=JSON.parse(r.stdout);observers.push({pid:r.pid,expectedCommand:r.expectedCommand,identity:rows.find(p=>p.pid===r.pid),descendants:descendants(rows,r.pid),code:r.status,signal:r.signal,completedAt:r.completedAt});retainSample(rows,r.completedAt);return rows;}
function check(ok,label){if(!ok)throw Object.assign(Error(label),{safeLabel:true});}
(async()=>{
 const parent=fs.realpathSync(process.argv[2]);check(path.isAbsolute(parent)&&!parent.startsWith(path.dirname(ROOT)+path.sep),'owned external parent');
 const run=path.join(parent,'r-'+crypto.randomBytes(4).toString('hex'));fs.mkdirSync(run);const cwd=path.join(run,'product');fs.mkdirSync(cwd);
 const launcher=await import(pathToFileURL(path.join(ROOT,'../agent/skills/headless-orchestration/scripts/launch.mjs')).href);
 for(const d of ['agent','runs','next-runs','user-workflows','project-workflows','tmp','cache'])fs.mkdirSync(path.join(run,'runtime',d),{recursive:true});fs.mkdirSync(path.join(run,'sessions'));
 Object.assign(process.env,launcher.childEnvironment({cwd,runDir:run,piCli:path.join(__dirname,'fixtures/round9-retry-worker.cjs')}));require('./fixtures/round8-models.cjs')(process.env.PI_CODING_AGENT_DIR);
 const secret=crypto.randomBytes(24).toString('hex'),config=path.join(run,'fixture.json'),log=path.join(run,'workers.jsonl');process.env.ROUND9_RETRY_CONFIG=config;
 const verifierMode=process.argv.includes('--verifier')||process.argv.includes('--verify-only');
 const repairMode=process.argv.includes('--bounded-repair');
 const configure=n=>fs.writeFileSync(config,JSON.stringify({failBuilders:verifierMode||repairMode?0:n,failVerifiers:verifierMode?1:0,malformedVerifiers:repairMode?1:0,mixedPolicy:process.argv.includes('--mixed-policy'),secret,log}));configure(1);
 const calls=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 const assertAttemptAccounting=dir=>{const phases=fs.readdirSync(dir).filter(n=>/^phase-.*\.result\.json$/.test(n)).map(n=>JSON.parse(fs.readFileSync(path.join(dir,n)))).filter(p=>p.pid);const expected=calls();check(phases.length===expected.length&&expected.every(c=>phases.some(p=>p.pid===c.pid)),'every physical worker has original durable phase evidence');check(phases.every(p=>p.providerAttemptEvidence?.agentStarts===1&&p.providerAttemptEvidence?.automaticRetries===0),'every fixture provider attempt accounted without SDK auto retries');check(expected.every(c=>c.provider==='openai-codex'&&['gpt-6-astra','gpt-6.1-sol'].includes(c.model)),'all attempts retain fixed role routes');};
 const initial=snapshot(),testIdentity=initial.find(p=>p.pid===process.pid),wrapperIdentity=initial.find(p=>p.pid===testIdentity.parentPid);
 cp.spawn=(...args)=>{const child=originalSpawn(...args),record={pid:child.pid,child,expectedCommand:expectedCommand(args[0],args[1])};children.push(record);const end=child.stdin?.end.bind(child.stdin);let pending;if(end)child.stdin.end=(...a)=>{if(!record.identity){pending=a;return child.stdin;}return end(...a);};child.once('spawn',()=>{try{const rows=snapshot();record.identity=rows.find(p=>p.pid===child.pid);record.descendants=descendants(rows,child.pid);}finally{if(pending)end(...pending);}});child.once('close',(code,signal)=>Object.assign(record,{closed:true,code,signal,completedAt:new Date().toISOString()}));return child;};
 cp.spawnSync=(...args)=>{const result=observeSync(originalSync,syncCommands,...args);try{const rows=processInventoryRows(JSON.parse(String(result.stdout)));if(rows&&!result.error&&result.status===0&&result.signal===null)retainSample(rows,new Date().toISOString(),'host_sync_inventory');}catch{}return result;};syncBuiltinESMExports();
 const sdk=await import(pathToFileURL(path.join(ROOT,'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href),originalComplete=sdk.ModelRuntime.prototype.completeSimple;
 fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'auth.json'),JSON.stringify({'openai-codex':{type:'api_key',key:secret}}));
 let restored=false,probes=0,session,failure;
 if(!process.argv.includes('--cli-provider'))sdk.ModelRuntime.prototype.completeSimple=async function(model,context){probes++;check(model.provider==='openai-codex'&&model.id==='gpt-6.1-sol','same frozen provider route');if(!restored)throw Error('synthetic remote refusal');return {stopReason:'stop',content:[{type:'text',text:context.messages[0].content.replace('Reply with exactly ','')}]};};
 try{
  if(process.argv.includes('--cli-provider')){
   // Actual shipped CLI; only provider HTTP I/O is offline. No substitute worker
   // executable or prototype provider shim is involved in this branch.
   const http=require('node:http');let workerRequests=0,probeRequests=0,scenario='mixed';
   const server=http.createServer((request,response)=>{let raw='';request.setEncoding('utf8');request.on('data',s=>raw+=s);request.on('end',()=>{
    let body;try{body=JSON.parse(raw);}catch{response.writeHead(400);response.end();return;}
    const challenge=body.messages?.flatMap(m=>typeof m.content==='string'?[m.content]:Array.isArray(m.content)?m.content.map(c=>c.text??''):[]).map(t=>/^Reply with exactly ([a-f0-9]{32})$/.exec(t)).find(Boolean)?.[1];
    if(challenge){probeRequests++;console.log('CLI_HTTP restoration '+probeRequests);response.writeHead(200,{'content-type':'text/event-stream'});response.end('data: '+JSON.stringify({id:'offline',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{role:'assistant',content:challenge},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'offline',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\ndata: [DONE]\n\n');return;}
    workerRequests++;const status=scenario==='transient'?500:workerRequests===2?401:400;
    console.log('CLI_HTTP worker '+workerRequests+' status='+status);
    response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:status===401?'authentication token expired':status===500?'provider temporarily unavailable':'provider policy refused; try rephrasing',type:'offline_fixture'}}));
   });});
   await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
   try{
    const port=server.address().port;process.env.PI_CLI_PATH=path.join(require('../tools/round9-runtime.cjs').modules,'@earendil-works/pi-coding-agent/dist/cli.js');
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'models.json'),JSON.stringify({providers:{'openai-codex':{baseUrl:`http://127.0.0.1:${port}/v1`,api:'openai-completions',apiKey:'offline-fixture',models:[{id:'gpt-6.1-sol',name:'Offline shipped CLI',reasoning:false,input:['text'],contextWindow:200000,maxTokens:16000}]}}}));
    const jiti=require(path.join(ROOT,'node_modules/jiti'))(__filename,{interopDefault:true,fsCache:false}),sub=await jiti.import(path.join(ROOT,'src/substrate.ts')),legacy=await jiti.import(path.join(ROOT,'src/index.ts'));
    for(const [name,launch] of [['index',legacy.runLegacySubagentForTest],['substrate',sub.spawnSubagent]]){
     scenario='mixed';workerRequests=0;probeRequests=0;let reserves=0;
     const dir=path.join(run,name);fs.mkdirSync(dir);
     const opts={cwd,agents:new Map([['reviewer',{name:'reviewer',provider:'openai-codex',model:'gpt-6.1-sol',tools:[]}]]),readOnly:true,allowLocalModel:false,workerExecutionConstraints:{noForceKill:true},phaseResultFile:path.join(dir,'phase-cli.result.json'),phaseLogFile:path.join(dir,'phase-cli.log'),infrastructureRetry:{file:path.join(dir,'operation.retry.json'),reserve:()=>reserves++}};
     let error;
     try{await launch('reviewer','Review the offline fixture only.',opts);}catch(e){error=e;}
     console.log('CLI_ATTEMPTS '+name+' workers='+workerRequests+' probes='+probeRequests+' outcome='+(error?.name??'success')+' code='+(String(error?.message).match(/^[A-Z_]+(?=:)/)?.[0]??'unclassified'));
     check(error?.name==='ProviderRefusalError','mixed actual CLI stops with terminal policy refusal');
     check(workerRequests===3&&probeRequests===1&&reserves===2,'actual CLI: THREE worker requests, one same-route restoration, no fourth physical launch');
     const phases=fs.readdirSync(dir).filter(n=>n.endsWith('.result.json')).map(n=>JSON.parse(fs.readFileSync(path.join(dir,n))));
     check(phases.length===3&&phases.every(p=>p.providerAttemptEvidence?.agentStarts===1&&p.providerAttemptEvidence?.automaticRetries===0),'actual CLI protocol proves three physical workers without automatic retries');
     const consumed=JSON.parse(fs.readFileSync(opts.infrastructureRetry.file));check(consumed.policyRetryConsumed&&consumed.status==='failed','policy consumption is durable on the logical operation');
     scenario='transient';workerRequests=0;probeRequests=0;
     try{await launch('reviewer','Review the offline fixture only.',{...opts,infrastructureRetry:undefined,phaseResultFile:path.join(dir,'transient.result.json'),phaseLogFile:path.join(dir,'transient.log')});}catch{}
     check(workerRequests===1&&probeRequests===0,'actual CLI transient provider failure has exactly one provider request');
     // A supported but unsafe isolated configuration is refused before spawn.
     const settingsFile=path.join(process.env.PI_CODING_AGENT_DIR,'settings.json'),saved=fs.readFileSync(settingsFile);const count=children.length;
     const projectDir=path.join(cwd,'.pi'),projectSettings=path.join(projectDir,'settings.json');fs.mkdirSync(projectDir,{recursive:true});
     try{for(const fault of ['global','project','masked-global']){
      fs.writeFileSync(settingsFile,fault==='project'?saved:JSON.stringify({retry:{enabled:true,provider:{maxRetries:1}}}));
      if(fault==='global'){if(fs.existsSync(projectSettings))fs.rmSync(projectSettings);}else fs.writeFileSync(projectSettings,JSON.stringify({retry:{enabled:fault==='project',provider:{maxRetries:fault==='project'?1:0}}}));
      await assert.rejects(launch('reviewer','Review only.',{...opts,infrastructureRetry:undefined}),/WORKER_RETRY_CONFIGURATION_REQUIRED/);check(children.length===count,'unsafe SDK retry configuration cannot dispatch');
     }}finally{fs.writeFileSync(settingsFile,saved);if(fs.existsSync(projectSettings))fs.rmSync(projectSettings);}
     console.log('PASS actual shipped CLI '+name+' provider request accounting, terminal mixed refusal and supported configuration gate');
    }
   }finally{await new Promise(resolve=>server.close(resolve));}
   return;
  }
  const settingsManager=sdk.SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false,maxRetries:0},cacheWarming:'off'}),modelRuntime=await sdk.ModelRuntime.create({allowModelNetwork:false,refreshOnCreate:false,authPath:path.join(process.env.PI_CODING_AGENT_DIR,'auth.json'),modelsPath:path.join(process.env.PI_CODING_AGENT_DIR,'models.json'),modelsStorePath:path.join(process.env.PI_CODING_AGENT_DIR,'models-store.json')});
  const loader=new sdk.DefaultResourceLoader({cwd,agentDir:process.env.PI_CODING_AGENT_DIR,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,additionalExtensionPaths:[path.join(ROOT,'src/index.ts')],systemPrompt:'Offline fixture host'});await loader.reload();check(!loader.getExtensions().errors.length,'SDK extension loads');
  ({session}=await sdk.createAgentSession({cwd,agentDir:process.env.PI_CODING_AGENT_DIR,modelRuntime,model:modelRuntime.getModel('openai-codex','gpt-6-astra'),resourceLoader:loader,settingsManager,tools:['orchestrate'],sessionManager:sdk.SessionManager.inMemory(cwd)}));
  await session.bindExtensions({mode:'json',uiContext:{notify(){},setWidget(){},setStatus(){},setEditorText(){},onTerminalInput:()=>()=>{}}});const tool=session.agent.state.tools.find(t=>t.name==='orchestrate');
  const base={action:'run',cwd,task:'Inspect only; do not edit.',supervision:'visible-main',paradigm:'plan-execute-verify',adaptiveSupervision:'off',plannerProvider:'openai-codex',plannerModel:'gpt-6-astra',executorProvider:'openai-codex',executorModel:'gpt-6.1-sol',verifierProvider:'openai-codex',verifierModel:'gpt-6.1-sol',plannerCount:1,executorConcurrency:1,verifierCount:1,maxRetries:0,maxSubagents:process.argv.includes('--cap-three')?3:6,noForceKill:true,preflight:false,automaticPlanApproval:true,predictedWriteSet:'product.txt'};
  fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'auth.json'),JSON.stringify({'openai-codex':{type:'api_key',key:secret}}));
  if(repairMode){let result=(await tool.execute('repair-initial',{...base,maxRetries:1})).details;const id=result.runId;check(result.status==='awaiting_supervisor','initial writer settles');for(const label of ['review-fails','bounded-repair-dispatch','review-passes'])result=(await tool.execute(label,{action:'continue',runId:id,approvalToken:result.approvalToken})).details;check(result.terminalOutcome==='pass','host-generated repair crosses actual public approval fence and final review');const state=JSON.parse(fs.readFileSync(path.join(process.env.PI_ORCHESTRATOR_RUNS_ROOT,id,'supervision.json')));check(JSON.stringify(state.runtime.executorOutputs.map(o=>o.taskId))===JSON.stringify(['only','repair-1']),'original writer retained once, one bounded repair only');check(calls().filter(c=>c.role==='builder').length===2,'only the approved original and repair writers launch');console.log('PASS actual public bounded repair checkpoint -> dispatch fence -> independent final review; no original writer replay');return;}
  if(process.argv.includes('--verify-only')){restored=true;const result=(await tool.execute('verify-only-retry',{...base,supervision:'off',paradigm:'verify-only'})).details;if(process.argv.includes('--mixed-policy')){check(result.status!=='pass'&&calls().length===3&&calls().every(c=>c.role==='verifier'),'verify-only mixed retry stops at THREE verifier launches');console.log('PASS public verify-only mixed policy/auth/restoration/policy; no fourth, planner or writer');return;}check(result.status==='pass'&&result.spawnedCount===2,'public verify-only restores and retries within its existing guard');check(calls().length===2&&calls().every(c=>c.role==='verifier'),'verify-only launches verifier twice and no writer/planner');check(result.verifierRuns[0].processTrees.length===2,'verify-only retains both attempts');console.log('PASS public verify-only restoration retry, fixed route and two charged attempts; no writer/planner');return;}
  let result=(await tool.execute('retry-first',base)).details;const id=result.runId,dir=path.join(process.env.PI_ORCHESTRATOR_RUNS_ROOT,id);
  if(verifierMode){check(result.status==='awaiting_supervisor','writer settles before verifier failure');result=(await tool.execute('verify-first',{action:'continue',runId:id,approvalToken:result.approvalToken})).details;}
  check(result.status==='blocked_infrastructure','failed restoration remains blocked');
  const inspectedRetry=(await tool.execute('inspect-restoration',{action:'inspect',runId:id})).details;
  check(inspectedRetry.allowedNextActions.includes('continue')&&!inspectedRetry.allowedNextActions.includes('adopt'),'inspection advertises only executable same-owner restored retry');
  check(inspectedRetry.liveStatus.durableStatus==='blocked_infrastructure'&&inspectedRetry.liveStatus.lifecycle.allowedNextActions.includes('continue'),'store/live projection matches public enforcement');
  check(calls().filter(c=>c.role==='builder').length===1,'initial failed worker ONE');
  const continueOnce=async()=>{const approval=(await tool.execute('fresh',{action:'continue',runId:id})).details;return (await tool.execute('consume',{action:'continue',runId:id,approvalToken:approval.approvalToken})).details;};
  // Changed bytes and another lifecycle call are NOT remote restoration proof.
  fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'auth.json'),JSON.stringify({'openai-codex':{type:'api_key',key:crypto.randomBytes(24).toString('hex')}}));
  result=await continueOnce();check(result.status==='blocked_infrastructure','unchanged remote failure refuses');check(calls().filter(c=>c.role==='builder').length===1,'failed probe cannot redispatch');
  restored=true;result=await continueOnce();
  if(verifierMode&&process.argv.includes('--mixed-policy')){check(result.terminalOutcome!=='pass'&&calls().filter(c=>c.role==='verifier').length===3&&calls().filter(c=>c.role==='builder').length===1,'public continuation retains policy consumption: verifier THREE writer ONE');assertAttemptAccounting(dir);console.log('PASS public continue mixed policy/auth/restoration/policy; no fourth launch or writer replay');return;}
  if(verifierMode){check(result.terminalOutcome==='pass','restored verifier reaches terminal review');
   const publications=fs.readdirSync(dir).filter(n=>/^phase-.*\.result\.json$/.test(n)).map(n=>({name:n,value:JSON.parse(fs.readFileSync(path.join(dir,n)))}));
   check(publications.every(({name,value:v})=>{const trees=v.processTrees??[v.processTree];return trees.every(t=>t?.launchId===v.launchId&&t.phaseId===path.join(dir,name)&&t.settledMembers?.some(s=>s.member.pid===t.rootPid&&s.member.born===t.rootBorn&&s.launchId===v.launchId&&s.phaseId===t.phaseId));}),'actual public verifier path retains original launch/phase/exact-birth settlement facts');check(calls().filter(c=>c.role==='builder').length===1,'settled writer never replayed');check(calls().filter(c=>c.role==='verifier').length===2,'one original verifier and one restored retry');const state=JSON.parse(fs.readFileSync(path.join(dir,'supervision.json')));check(JSON.parse(fs.readFileSync(path.join(process.env.PI_ORCHESTRATOR_RUNS_ROOT,id,state.checkpoints.at(-1).id+'-verifier.json'))).payload.verifier.processTrees.length===2,'both original and retry verifier inventories retained');check(JSON.parse(fs.readFileSync(path.join(dir,'spawn-budget.json'))).reserved===4,'all physical attempts charged');assertAttemptAccounting(dir);console.log('PASS public writer -> zero-tool verifier refusal -> failed restoration -> continue -> single restored verifier retry; original inventories and final review retained');return;}
  check(result.status==='awaiting_supervisor','restored same-role worker settles');check(calls().filter(c=>c.role==='builder').length===2,'one retry dispatch');
  const state=JSON.parse(fs.readFileSync(path.join(dir,'supervision.json')));check(state.runtime.executorOutputs.length===1,'one durable settled output');
  result=(await tool.execute('verify',{action:'continue',runId:id,approvalToken:result.approvalToken})).details;if(process.argv.includes('--cap-three')){
   check(calls().length===3,'explicit cap THREE never launches FOUR across continue/restoration');
   check(result.terminalOutcome!=='pass','exhausted cap cannot publish PASS');
   console.log('PASS cap THREE across refused probes, confirmed retry and checkpoint continuation; no fourth dispatch or PASS');
   return;
  }
  check(result.terminalOutcome==='pass','independent verification follows retry');
  check(calls().filter(c=>c.role==='builder').length===2,'settled writer never replayed');
  const retryFiles=fs.readdirSync(dir).filter(n=>n.endsWith('.retry.json')).map(n=>JSON.parse(fs.readFileSync(path.join(dir,n))));check(retryFiles.some(r=>r.status==='settled'&&r.restoration==='confirmed'),'durable exclusive retry consumed and settled');
  // Standalone substrate uses the same durable record, separate phase evidence.
  const jiti=require(path.join(ROOT,'node_modules/jiti'))(__filename,{interopDefault:true,fsCache:false}),sub=await jiti.import(path.join(ROOT,'src/substrate.ts'));
  const before=calls().filter(c=>c.role==='builder').length;configure(before+1);let reserves=0;
  const opts={agents:new Map([['coder',{name:'coder',provider:'openai-codex',model:'gpt-6.1-sol'}]]),cwd,allowLocalModel:false,workerExecutionConstraints:{noForceKill:true},phaseResultFile:path.join(dir,'phase-direct.result.json'),phaseLogFile:path.join(dir,'phase-direct.log'),infrastructureRetry:{identity:'direct same phase',reserve:()=>reserves++}};
  await sub.spawnSubagent('coder','Inspect only',opts);check(reserves===1&&calls().filter(c=>c.role==='builder').length===before+2,'substrate restored retry exactly once');
  try{await sub.spawnSubagent('coder','Inspect only',opts);}catch{}check(calls().filter(c=>c.role==='builder').length===before+2,'repeated standalone continuation cannot reset consumed retry');
  for(const file of fs.readdirSync(dir).filter(n=>/\.(?:log|json)$/.test(n)))check(!fs.readFileSync(path.join(dir,file),'utf8').includes(secret),'no synthetic credential in shared durable output');
  check(probes>=3,'independent provider path observed refusal and restoration');
  check(launcher.continuationCommand?.('orc-same')==='/orchestrate continue --run-id orc-same','supported same-run continuation command');
  console.log('PASS public restoration refusal/success, unchanged-file non-proof, durable same-role ONE retry, no replay, both launchers and safe publications');
 }catch(error){failure=error;console.error('RETRY_PRODUCT_CHECK_FAILED '+(error.safeLabel?error.message:error.name));}finally{
  session?.dispose();sdk.ModelRuntime.prototype.completeSimple=originalComplete;cp.spawn=originalSpawn;cp.spawnSync=nativeSync;syncBuiltinESMExports();
  for(const r of children)if(!r.closed)await new Promise(resolve=>r.child.once('close',resolve));
  const rows=snapshot(),all=[...children,...syncCommands,...observers.slice(0,-1),...nestedRecords()];
  if(process.argv.includes('--creator-probe'))fs.writeFileSync(path.join(run,'creator-boundaries.json'),JSON.stringify(creatorSamples,null,2));
  fs.writeFileSync(path.join(run,'process-proof.json'),JSON.stringify({testIdentity,wrapperIdentity,hosts:[],fixtures:children.map(r=>r.identity),hostProof:[{children:children.map(({child,...r})=>r),syncCommands,observers},...hostProof],observers,independentlyAbsentGenerations:[...absence.values()]},null,2));
  assertExpectedCommands([...children,...syncCommands,...observers]);
  for(const r of all){check(r.signal===null,'natural process completion');for(const g of [r.identity,...(r.descendants??[])].filter(Boolean)){
   const current=rows.find(p=>p.pid===g.pid);
   const waitedRoot=g.pid===r.pid&&r.signal===null&&Number.isInteger(r.code);
   check(!current||current.born!==g.born&&(absence.has(g.pid+':'+g.born)||waitedRoot),'independent old-generation completion/absence (reuse alone is not evidence)');
  }}
  check(children.every(r=>r.identity),'all worker kernel generations observed before EOF');
  check(calls().every(c=>[...children,...hostProof.flatMap(p=>p.children)].some(r=>r.pid===c.pid)),'every expected fixture dispatch has creation-bound command proof');
  console.log('CLEANUP every worker/helper/observer generation independently absent; no windows/owner action');
 }
 if(failure)throw failure;
})().catch(error=>{console.error('RETRY_CHECK_FAILED '+(error.safeLabel?error.message:error.name)+' '+String(error.stack).split('\n').slice(1,4).join(' '));process.exitCode=1;});
