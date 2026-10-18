// Causal output checks. No assertion prints provider content or fixture values.
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),vm=require('node:vm'),{pathToFileURL}=require('node:url');
const ROOT=path.resolve(__dirname,'..'),ts=require(path.join(ROOT,'node_modules/typescript'));
const check=(ok,label,assertion)=>{if(!ok)throw Object.assign(Error(label),{safeLabel:true,assertion});};
const failures=[],failedBodies=[],children=[],observations=[],fixtureGenerations=[],originalSpawn=cp.spawn,originalSync=require('./fixtures/round9-command-proof.cjs').bindSync(cp.spawnSync);
let stage='setup';
// Persist only fixed test identifiers, never exception text/stacks or IPC payloads.
const checkpointFailure=error=>({ok:false,stage,assertion:/^output-assertion-\d{2}$/.test(error?.assertion)?error.assertion:'unexpected-error'});
function descendants(rows,pid){const ids=new Set([pid]);for(let n=0;n<rows.length;n++){const before=ids.size;for(const row of rows){const parent=rows.find(p=>p.pid===row.parentPid);if(parent&&ids.has(parent.pid)&&Date.parse(row.born)>=Date.parse(parent.born))ids.add(row.pid);}if(before===ids.size)break;}return rows.filter(p=>p.pid!==pid&&ids.has(p.pid));}
let nextWorkerReady,nativeBashActive=false;
const PS='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
function snapshot(){
 const r=originalSync(PS,['-NoProfile','-NonInteractive','-Command',"$r=@(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -gt 0} | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='parentPid';e={[int]$_.ParentProcessId}},@{n='born';e={$_.CreationDate.ToUniversalTime().ToString('o')}}); ConvertTo-Json -Compress -InputObject $r"],{encoding:'utf8',windowsHide:true});
 check(r.status===0&&r.signal===null,'inventory settled naturally','output-assertion-01');const rows=JSON.parse(r.stdout);
 observations.push({pid:r.pid,expectedCommand:r.expectedCommand,code:r.status,signal:r.signal,completedAt:r.completedAt,identity:rows.find(p=>p.pid===r.pid),descendants:descendants(rows,r.pid)});return rows;
}
async function test(label,body){stage=label;try{await body();console.log('PASS '+label);}catch(error){failures.push(label);const diagnostic=checkpointFailure(error);failedBodies.push(diagnostic);console.error('RED '+label+' '+diagnostic.assertion);}}
function declaration(file,name){const source=fs.readFileSync(path.join(ROOT,file),'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);return ast.statements.find(n=>n.name?.text===name).getText(ast).replace(/^export\s+/,'');}
async function checkpointHost(){
 stage=process.argv[3]==='run'?'checkpoint-run':'checkpoint-restore';
 const cfg=JSON.parse(fs.readFileSync(process.env.ROUND9_OUTPUT_HOST_CONFIG,'utf8'));
 const sdk=await import(pathToFileURL(path.join(ROOT,'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
 const settingsManager=sdk.SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false,maxRetries:0},cacheWarming:'off'});
 const modelRuntime=await sdk.ModelRuntime.create({allowModelNetwork:false,refreshOnCreate:false,authPath:path.join(process.env.PI_CODING_AGENT_DIR,'auth.json'),modelsPath:path.join(process.env.PI_CODING_AGENT_DIR,'models.json')});
 const loader=new sdk.DefaultResourceLoader({cwd:cfg.cwd,agentDir:process.env.PI_CODING_AGENT_DIR,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,additionalExtensionPaths:[path.join(ROOT,'src/index.ts')],systemPrompt:'Offline output test'});await loader.reload();check(!loader.getExtensions().errors.length,'public extension loaded','output-assertion-02');
 const {session}=await sdk.createAgentSession({cwd:cfg.cwd,agentDir:process.env.PI_CODING_AGENT_DIR,modelRuntime,model:modelRuntime.getModel('openai-codex','gpt-6-astra'),resourceLoader:loader,settingsManager,tools:['orchestrate'],sessionManager:sdk.SessionManager.inMemory(cfg.cwd)});
 try{
  await session.bindExtensions({mode:'json',uiContext:{notify(){},setWidget(){},setStatus(){},setEditorText(){},onTerminalInput:()=>()=>{}}});
  const tool=session.agent.state.tools.find(t=>t.name==='orchestrate');let result;
  if(process.argv[3]==='run'){
   result=(await tool.execute('output-checkpoint',{action:'run',cwd:cfg.cwd,task:'Inspect only',supervision:'visible-main',paradigm:'plan-execute-verify',adaptiveSupervision:'off',plannerProvider:'openai-codex',plannerModel:'gpt-6-astra',executorProvider:'openai-codex',executorModel:'gpt-6.1-sol',verifierProvider:'openai-codex',verifierModel:'gpt-6.1-sol',plannerCount:1,executorConcurrency:1,verifierCount:1,maxRetries:0,maxSubagents:6,noForceKill:true,preflight:false,automaticPlanApproval:true,predictedWriteSet:'product.txt'})).details;
   check(result.status==='awaiting_supervisor','public settled writer checkpoint','output-assertion-03');
   const inspection=await tool.execute('output-inspection',{action:'inspect',runId:result.runId});
   const fixture=JSON.parse(fs.readFileSync(process.env.ROUND9_OUTPUT_CONFIG));
   check([fixture.secret,fixture.errorSecret].every(value=>!JSON.stringify(inspection).includes(value)),'actual public inspection is redacted','output-assertion-04');
   check(inspection.details.runId===result.runId&&fs.existsSync(inspection.details.savedArtifacts?.checkpoint),'inspection retains run/checkpoint bindings','output-assertion-05');
   let inspected;try{inspected=JSON.parse(inspection.details.settledResult?.text.replace(/^```json\s*|\s*```$/g,''));}catch{}
   check(inspected?.findings?.[0]?.observation==='complete useful finding'&&inspected?.binding==='original-task','inspection preserves useful structured findings','output-assertion-06');
   check(fs.readFileSync(inspection.details.savedArtifacts.result,'utf8').includes('useful-command'),'inspection exposes full useful action evidence through its result reference','output-assertion-07');
   await session.prompt('/orchestrate inspect --run-id '+result.runId);
   result=(await tool.execute('output-same-owner-review',{action:'continue',runId:result.runId,approvalToken:result.approvalToken})).details;
   check(result.terminalOutcome==='pass','existing public SDK owner reviews settled output without replay','output-assertion-08');
  }else{
   const runId=process.argv[4],jiti=require(path.join(ROOT,'node_modules/jiti'))(__filename,{interopDefault:true,fsCache:false}),storeModule=await jiti.import(path.join(ROOT,'src/run-state.ts'));
   const loaded=storeModule.RunStateStore.load(runId),checkpoint=[...loaded.checkpoints.values()].find(r=>r.agentName==='coder');
   check(checkpoint?.processTree||checkpoint?.processTrees?.length,'checkpoint retains process inventory','output-assertion-09');
   const source=declaration('src/index.ts','executeOneSupervisedTask'),js=ts.transpileModule(source+'\nglobalThis.restore=executeOneSupervisedTask',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
   const state=JSON.parse(fs.readFileSync(path.join(process.env.PI_ORCHESTRATOR_RUNS_ROOT,runId,'supervision.json'))),task=state.runtime.plan.tasks[0];
   const context=vm.createContext({RunStateStore:storeModule.RunStateStore,requireGenericRuntime:s=>s.runtime,executorOutputFromSupervisedResult:(_task,r)=>r,Error,Math,JSON});vm.runInContext(js,context);
   const restored=await context.restore(state,{}, {},new Map(),task,state.runtime.plan,undefined,()=>{});
   check(JSON.stringify(restored.processTree)===JSON.stringify(checkpoint.processTree)&&JSON.stringify(restored.processTrees)===JSON.stringify(checkpoint.processTrees),'fresh host restores exact checkpoint inventories','output-assertion-10');
   const stateFile=path.join(process.env.PI_ORCHESTRATOR_RUNS_ROOT,runId,'supervision.json'),before=fs.readFileSync(stateFile);
   const fixture=JSON.parse(fs.readFileSync(process.env.ROUND9_OUTPUT_CONFIG)),launches=fs.readFileSync(fixture.launchLog);
   for(const action of ['adopt','continue','accept']){
    stage='checkpoint-'+action;
    let refused=false;
    try{await tool.execute('output-takeover-refused',{action,runId,reason:'not transfer authority'});}catch(error){refused=action!=='adopt'||String(error.message).startsWith('ADOPT_REFUSED:');}
    check(refused,'fresh public SDK host cannot transfer ownership through '+action,'output-assertion-11');
    check(before.equals(fs.readFileSync(stateFile))&&launches.equals(fs.readFileSync(fixture.launchLog)),'refused takeover preserves saved output and dispatches nothing','output-assertion-12');
   }
   result={runId,status:state.status,terminalOutcome:state.terminalOutcome};
  }
  process.send({ok:true,stage,runId:result.runId,status:result.status,terminalOutcome:result.terminalOutcome});
 }catch(error){process.send(checkpointFailure(error));process.exitCode=1;}
 finally{session.dispose();process.disconnect();}
}
if(process.argv[2]==='--checkpoint-host')checkpointHost().catch(error=>{if(process.connected){process.send(checkpointFailure(error));process.disconnect();}process.exitCode=1;});
else (async()=>{
 const parent=fs.realpathSync(process.argv[2]||process.env.ROUND9_OWNED_RUNTIME),run=path.join(parent,'o-'+crypto.randomBytes(4).toString('hex'));
 for(let p=parent;;p=path.dirname(p)){check(!fs.lstatSync(p).isSymbolicLink(),'physical owned ancestors','output-assertion-13');if(path.dirname(p)===p)break;}
 check(parent.includes(path.join('repair-after-review','coordinator','tests')),'owned child scratch','output-assertion-14');fs.mkdirSync(run);
 const cwd=path.join(run,'product');fs.mkdirSync(cwd);const runtime=path.join(run,'isolated');
 for(const d of ['sessions','runtime/agent','runtime/runs','runtime/next-runs','runtime/tmp','runtime/cache','runtime/user-workflows','runtime/project-workflows'])fs.mkdirSync(path.join(runtime,d),{recursive:true});
 const launcher=await import(pathToFileURL(path.join(ROOT,'../agent/skills/headless-orchestration/scripts/launch.mjs')).href);
 const env=launcher.childEnvironment({cwd,runDir:runtime,piCli:path.join(__dirname,'fixtures/round9-output-worker.cjs')});Object.assign(process.env,env);
 require('./fixtures/round8-models.cjs')(env.PI_CODING_AGENT_DIR);
 const secret=crypto.randomBytes(32).toString('hex'),errorSecret=crypto.randomBytes(32).toString('hex'),config=path.join(run,'private-fixture.json'),launchLog=path.join(run,'launches.jsonl');
 const configure=error=>fs.writeFileSync(config,JSON.stringify({secret,errorSecret,error,launchLog}));configure(false);process.env.ROUND9_OUTPUT_CONFIG=config;
 const initial=snapshot(),testIdentity=initial.find(p=>p.pid===process.pid);
 cp.spawn=(command,args,options)=>{
  const worker=args?.some(a=>String(a).includes('round9-output-worker.cjs'));
  if(!worker&&/node(?:\.exe)?$/i.test(String(command)))args=['--require',path.join(__dirname,'fixtures/round9-command-preload.cjs'),...args];
  const nativeBash=nativeBashActive&&/bash(?:\.exe)?$/i.test(String(command));
  const sampler=args?.includes(path.join(ROOT,'src/windows-process-io-sampler.ps1'));
  if(sampler){
   // The real sensor can fail before a CIM enumeration finishes. Hold this
   // same PowerShell generation on stdin BEFORE invoking its unchanged script,
   // then release it only after independent creation/creator observation.
   // This is not sensor readiness or descendant/root settlement evidence.
   const file=args.indexOf('-File'),quote=value=>"'"+String(value).replaceAll("'","''")+"'";
   args=[...args.slice(0,file),'-Command',"$null = [Console]::In.ReadLine(); & "+args.slice(file+1).map(quote).join(' ')];
  }
  const child=originalSpawn(command,args,worker?{...options,stdio:['pipe','pipe','pipe','ipc']}:nativeBash?{...options,stdio:['pipe','pipe','pipe']}:options),r={pid:child.pid,child,worker,expectedCommand:{executable:path.resolve(command),argvSha256:crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex')}};children.push(r);
  r.closed=new Promise(resolve=>child.once('close',(code,signal)=>{Object.assign(r,{code,signal,settled:true,completedAt:new Date().toISOString()});resolve();}));
  const end=child.stdin?.end.bind(child.stdin);let pending;
  if(worker&&end)child.stdin.end=(...a)=>{if(!r.identity){pending=a;return child.stdin;}return end(...a);};
  child.once('spawn',()=>{const rows=snapshot();r.identity=rows.find(p=>p.pid===child.pid);r.descendants=descendants(rows,child.pid);if(sampler)child.stdin.write('\n');if(pending)end(...pending);if(nativeBash)child.stdin.end('ready\n');});
  const onReady=worker?nextWorkerReady:undefined;if(worker)nextWorkerReady=undefined;
  if(worker)child.on('message',m=>{if(m.ready){r.ready=true;if(onReady)onReady(child);else child.send({settle:true});}});
  return child;
 };require('node:module').syncBuiltinESMExports();
 const jiti=require(path.join(ROOT,'node_modules/jiti'))(__filename,{interopDefault:true,fsCache:false,moduleCache:false});
 const sub=await jiti.import(path.join(ROOT,'src/substrate.ts')),legacy=await jiti.import(path.join(ROOT,'src/index.ts'));
 const agents=new Map([['coder',{name:'coder',provider:'openai-codex',model:'gpt-6.1-sol'}]]);
 const scan=(directory,exclude=new Set())=>{for(const name of fs.readdirSync(directory)){const f=path.join(directory,name);if(exclude.has(f))continue;if(fs.statSync(f).isDirectory())scan(f,exclude);else {const bytes=fs.readFileSync(f);check([secret,errorSecret].flatMap(value=>[value,value.slice(0,17),value.slice(17)]).every(value=>!bytes.includes(Buffer.from(value))),'persisted sink contains no credential or streamed fragment','output-assertion-15');}}};
 try{
  if(!process.argv.includes('--public-only'))await test('native SDK bash useful complete output',async()=>{
   const authorization=sub.materializeFrozenTestAuthorizationPolicy(undefined,run,cwd);
   Object.assign(process.env,{PI_ORCHESTRATOR_TEST_AUTHORIZATION_FILE:authorization.file,PI_ORCHESTRATOR_TEST_AUTHORIZATION_SHA256:authorization.sha256,PI_ORCHESTRATOR_NO_OUTPUT_EVIDENCE_ROOT:path.join(run,'bash-evidence'),PI_ORCHESTRATOR_ALARM_ACK_ROOT:path.join(run,'bash-acks')});
   let tool;const handlers=new Map();const monitor=await jiti.import(path.join(ROOT,'src/worker-no-output-monitor.ts'));
   (monitor.default??monitor)({registerTool:t=>tool=t,on:(name,fn)=>handlers.set(name,fn),events:{emit(){}}});
   const sdk=await import(pathToFileURL(path.join(ROOT,'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
   const context={cwd,sessionManager:sdk.SessionManager.inMemory(cwd)};
   const execute=async(id,command)=>{nativeBashActive=true;try{const result=await tool.execute(id,{command:'read -r fixtureReady; '+command},undefined,undefined,context);return handlers.get('tool_result')({toolName:'bash',toolCallId:id,...result});}finally{nativeBashActive=false;}};
   const published=await execute('output-native','printf harmless-complete-command-output');
   check(published.content.some(c=>c.type==='text'&&c.text.includes('harmless-complete-command-output')),'native bash retains harmless stdout','output-assertion-16');
   const echoed=await execute('output-echo',"printf '%s\\n' '"+secret+"' 'client_secret="+secret+"' 'useful-complete-output'");
   check(!JSON.stringify(echoed).includes(secret)&&JSON.stringify(echoed).includes('useful-complete-output'),'native bash complete echo protection preserves useful tail','output-assertion-17');
   const large=await execute('output-large',`for ((i=0;i<2500;i++)); do printf 'meaningful-line-%s\\n' "$i"; done`);
   const full=large.details?.fullOutputPath;check(full&&fs.existsSync(full),'native SDK functioning sanitized full-output reference','output-assertion-18');
   const bytes=fs.readFileSync(full,'utf8');check(bytes.includes('meaningful-line-0\n')&&bytes.includes('meaningful-line-2499\n')&&bytes.split('\n').length===2501,'full command output retains every meaningful line','output-assertion-19');
  });
  if(!process.argv.includes('--bash-only')) {
  if(!process.argv.includes('--public-only'))for(const [label,launch] of [['substrate',sub.spawnSubagent],['index',legacy.runLegacySubagentForTest]]){
   for(const mode of ['final','error','detached','publication-failure'])await test(label+' '+mode,async()=>{
    configure(mode==='error');const dir=path.join(run,label+'-'+mode);fs.mkdirSync(dir);
    const options={cwd,agents,allowLocalModel:false,workerExecutionConstraints:{noForceKill:true},phaseLogFile:path.join(dir,'phase.log'),phaseResultFile:path.join(dir,'phase.result.json'),phaseMutates:mode==='publication-failure',disableProviderRefusalRetry:true};
    let controller,detachedChild;
    if(mode==='detached'){
     controller=new AbortController();options.signal=controller.signal;options.abortSurvival={resultFile:path.join(dir,'survivor.json'),manifestFile:path.join(dir,'survivor.manifest.json')};
    }
    // At protocol readiness obstruct only this attempt's terminal destination.
    // This is real filesystem failure, not a mocked SessionManager/recorder.
    if(mode==='publication-failure')nextWorkerReady=child=>{fs.rmSync(options.phaseResultFile);fs.mkdirSync(options.phaseResultFile);child.send({settle:true});};
    if(controller)nextWorkerReady=child=>{detachedChild=child;controller.abort();};
    const before=children.length;let result,error;
    try{result=await launch('coder','Inspect only',options);}catch(e){error=e;}finally{
     nextWorkerReady=undefined;detachedChild?.send({settle:true});
     for(const r of children.slice(before)){if(r.worker&&r.child.connected)r.child.send({settle:true});await r.closed;}
    }
    if(mode==='publication-failure')check(error?.name==='SubagentTerminalAmbiguousError'&&error.info?.candidate?.text,'publication loss is conservative and preserves settled candidate','output-assertion-20');
    else if(mode==='error'){check(error,'assistant error is refused','output-assertion-21');check(fs.readFileSync(options.phaseLogFile,'utf8').includes('malformed echo'),'useful complete malformed diagnostic prose retained','output-assertion-22');}
    else if(mode==='detached'){check(error?.name==='SubagentDetachedError','existing detach contract','output-assertion-23');check(fs.existsSync(options.abortSurvival.resultFile),'detached settlement persisted','output-assertion-24');const saved=JSON.parse(fs.readFileSync(options.abortSurvival.resultFile));check(saved.processTree||saved.processTrees?.length,'detached result retains process inventories','output-assertion-25');}
    else {
     check(result?.exitCode===0,'final result settles','output-assertion-26');let parsed;try{parsed=JSON.parse(result.text.replace(/^```json\s*|\s*```$/g,''));}catch{}
     check(parsed?.findings?.[0]?.observation==='complete useful finding'&&parsed?.binding==='original-task','complete useful structured result preserved','output-assertion-27');
     const ledger=JSON.stringify(result.actionEvidence);check(ledger.includes('useful-command'),'useful action command retained','output-assertion-28');
     check(fs.readFileSync(options.phaseLogFile,'utf8').includes('useful-complete-output'),'complete successful tool output remains in the phase log','output-assertion-29');
     const publication=JSON.parse(fs.readFileSync(options.phaseResultFile));check(JSON.stringify(publication).includes('complete useful finding')&&JSON.stringify(publication).includes('useful-command'),'phase result preserves findings and action ledger','output-assertion-30');
    }
    scan(dir);if(result)check([secret,errorSecret].every(value=>!JSON.stringify(result).includes(value)),'returned result redacted','output-assertion-31');if(error)check([secret,errorSecret].every(value=>!String(error.message).includes(value)&&!JSON.stringify(error.info||{}).includes(value)),'error and candidate redacted','output-assertion-32');
   });
  }
  configure(false);
  await test('public SDK tool and command checkpoints',async()=>{
   const hostConfig=path.join(run,'host-fixture.json');fs.writeFileSync(hostConfig,JSON.stringify({cwd}));
   const host=async(mode,id='')=>{
    const child=cp.spawn(process.execPath,[__filename,'--checkpoint-host',mode,id],{cwd,env:{...process.env,ROUND9_OUTPUT_HOST_CONFIG:hostConfig},stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
    child.stdout.resume();child.stderr.resume();let response;child.on('message',m=>response=m);
    const record=children.find(r=>r.child===child);await record.closed;
    record.checkpointDiagnostic={ok:response?.ok===true,stage:['checkpoint-run','checkpoint-restore','checkpoint-adopt','checkpoint-continue','checkpoint-accept'].includes(response?.stage)?response.stage:'checkpoint-settlement',assertion:/^output-assertion-\d{2}$/.test(response?.assertion)?response.assertion:undefined,code:record.code,signal:record.signal};
    check(record.code===0&&response?.ok,'public SDK checkpoint host settled','output-assertion-33');return response;
   };
   // Earlier full-sequence launcher cases share this log. Count only writers
   // added by this public run, not those deliberately launched by prior cases.
   const writerCount=()=>fs.existsSync(launchLog)?fs.readFileSync(launchLog,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(r=>r.role==='writer').length:0;
   const initialWriters=writerCount(),result=await host('run'),before=writerCount();
   check(result.terminalOutcome==='pass'&&before-initialWriters===1,'same-owner independent review completes with one original writer','output-assertion-34');
   const persisted=path.join(env.PI_ORCHESTRATOR_RUNS_ROOT,result.runId);
   const state=JSON.parse(fs.readFileSync(path.join(persisted,'supervision.json')));
   check(state.runtime.executorOutputs.some(o=>JSON.stringify(o).includes('complete useful finding')&&JSON.stringify(o).includes('useful-command')),'supervision checkpoint preserves complete findings and actions','output-assertion-35');
   const allSaved=fs.readdirSync(persisted).filter(n=>n.endsWith('.json')).map(n=>fs.readFileSync(path.join(persisted,n),'utf8')).join('\n');
   check(allSaved.includes('complete useful finding')&&allSaved.includes('useful-command'),'executor checkpoint/inspection sources retain findings and action commands','output-assertion-36');
   await host('refuse-takeover',result.runId);
   const after=writerCount();
   check(before===after,'settled writer is never replayed during same-owner review or fresh-host takeover refusal','output-assertion-37');scan(env.PI_ORCHESTRATOR_RUNS_ROOT);
  });
  await test('actual public headless host and SDK transcript',async()=>{
   const hostRun=path.join(run,'headless');for(const d of ['sessions','runtime/agent','runtime/runs','runtime/next-runs','runtime/tmp','runtime/cache','runtime/user-workflows','runtime/project-workflows'])fs.mkdirSync(path.join(hostRun,d),{recursive:true});
   const frozen=path.resolve(ROOT,'..'),sdkFile=path.join(frozen,'output-sdk-'+crypto.randomUUID()+'.mjs');
   const realSDK=pathToFileURL(path.join(ROOT,'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href;
   const events=pathToFileURL(path.join(ROOT,'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js')).href;
   fs.writeFileSync(sdkFile,`export * from ${JSON.stringify(realSDK)}; import {ModelRuntime} from ${JSON.stringify(realSDK)}; import {AssistantMessageEventStream} from ${JSON.stringify(events)}; import fs from 'node:fs';
ModelRuntime.prototype.streamSimple=function(model){const s=new AssistantMessageEventStream();const cfg=JSON.parse(fs.readFileSync(process.env.ROUND9_OUTPUT_CONFIG));const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:'stop',content:[{type:'text',text:String.fromCharCode(96,96,96)+'json\\n'+JSON.stringify({client_secret:cfg.secret,echo:cfg.secret,findings:['complete headless finding'],binding:'headless-task',diagnostic:'diagnostic '+cfg.errorSecret+' {"\\\\u0061ccess":"'+cfg.errorSecret+'" malformed echo '+cfg.errorSecret})+'\\n'+String.fromCharCode(96,96,96)},{type:'thinking',thinking:cfg.secret,thinkingSignature:cfg.secret}],usage:{input:0,output:0,totalTokens:0,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,total:0,cacheRead:0,cacheWrite:0}}};s.push({type:'done',reason:'stop',message});s.end(message);return s;};`);
   require('./fixtures/round8-models.cjs')(path.join(hostRun,'runtime/agent'));
   const auth=path.join(hostRun,'runtime/agent/auth.json');fs.writeFileSync(auth,JSON.stringify({'openai-codex':{type:'oauth',access:secret,refresh:secret,accountId:secret,expires:Date.now()+86400000}}));
   const cfg={nodeExe:process.execPath,cwd,frozenRoot:frozen,extension:path.join(ROOT,'src/index.ts'),sdkEntry:sdkFile,piCli:path.join(__dirname,'fixtures/round9-output-worker.cjs'),runDir:hostRun,provider:'openai-codex',model:'gpt-6-astra',evidenceRoots:[],credentialRenewalOwner:'independent-runtime-login',automaticPlanApproval:true,systemFile:path.join(hostRun,'system.md'),commandFile:path.join(hostRun,'command.txt'),supervisorFile:path.join(hostRun,'supervisor.md')};
   fs.writeFileSync(cfg.systemFile,'Offline headless output fixture');fs.writeFileSync(cfg.supervisorFile,'Return a short report');
   fs.writeFileSync(cfg.commandFile,'/orchestrate run --supervision visible-main --adaptive-supervision off --paradigm plan-execute-verify --planner-provider openai-codex --planner-model gpt-6-astra --executor-provider openai-codex --executor-model gpt-6.1-sol --verifier-provider openai-codex --verifier-model gpt-6.1-sol --planner-count 1 --executor-concurrency 1 --verifier-count 1 --max-retries 0 --max-subagents 6 --automatic-plan-approval on --no-force-kill --no-preflight --write-set product.txt -- '+JSON.stringify('Inspect only'));
   const cfgFile=path.join(hostRun,'config.json');fs.writeFileSync(cfgFile,JSON.stringify(cfg));
   // Run the shipped host, not a VM or SessionManager replacement. Its SDK shim
   // changes only the offline provider stream; persistence is the actual SDK.
   const headlessStart=fs.existsSync(launchLog)?fs.readFileSync(launchLog,'utf8').trim().split('\n').length:0;
   const child=cp.spawn(process.execPath,[path.join(ROOT,'../agent/skills/headless-orchestration/scripts/orchestrate-host.mjs'),cfgFile],{cwd,env:{...process.env,ROUND9_OUTPUT_CONFIG:config},stdio:['ignore','pipe','pipe'],windowsHide:true});let sharedOutput='';child.stdout.on('data',s=>sharedOutput+=s);child.stderr.on('data',s=>sharedOutput+=s);const record=children.find(r=>r.child===child);await record.closed;
   check([secret,errorSecret].flatMap(value=>[value,value.slice(0,17),value.slice(17)]).every(value=>!sharedOutput.includes(value)),'headless shared stdout/stderr redacted','output-assertion-38');
   check(record.code===0&&record.signal===null,'headless natural settlement','output-assertion-39');check(fs.existsSync(path.join(hostRun,'completion.json')),'headless SDK settled','output-assertion-40');
   for(const id of fs.readdirSync(path.join(hostRun,'runtime/runs'))){
    const stateFile=path.join(hostRun,'runtime/runs',id,'supervision.json');if(!fs.existsSync(stateFile))continue;
    const before=fs.readFileSync(stateFile),saved=JSON.parse(before);let projection;
    try{projection=await launcher.readCurrentProjection(cfgFile,id);}finally{Object.assign(process.env,env);}
    check(projection.durableStatus===saved.status&&projection.terminalOutcome===saved.terminalOutcome,'public headless status distinguishes durable verdict from SDK completion','output-assertion-41');
    check(projection.lifecycle.actionRefusals.continue&& !projection.lifecycle.allowedNextActions.includes('continue'),'headless status cannot advertise foreign-host continuation','output-assertion-42');
    check(before.equals(fs.readFileSync(stateFile)),'headless inspection preserves ownership, approvals and checkpoint history','output-assertion-43');
   }
   const transcripts=fs.readdirSync(path.join(hostRun,'sessions')).filter(n=>n.endsWith('.jsonl'));check(transcripts.length>0,'actual SDK persisted session transcript','output-assertion-44');
   check(transcripts.some(n=>fs.readFileSync(path.join(hostRun,'sessions',n),'utf8').includes('assistant')),'actual assistant transcript persisted','output-assertion-45');scan(hostRun,new Set([auth]));
   const report=fs.readFileSync(path.join(hostRun,'report.md'),'utf8');let reportValue;try{reportValue=JSON.parse(report.replace(/^```json\s*|\s*```$/g,''));}catch{}
   check(reportValue?.findings?.[0]==='complete headless finding'&&reportValue?.binding==='headless-task'&&reportValue?.diagnostic?.includes('malformed echo'),'headless report preserves structured findings, binding and useful diagnostic prose','output-assertion-46');
   check(transcripts.some(n=>fs.readFileSync(path.join(hostRun,'sessions',n),'utf8').includes('complete headless finding')),'actual SDK transcript preserves useful complete output','output-assertion-47');
   const inventories=[];
   for(const id of fs.readdirSync(path.join(hostRun,'runtime/runs')))for(const name of fs.readdirSync(path.join(hostRun,'runtime/runs',id)).filter(n=>/^phase-.*\.result\.json$/.test(n))){
    const phase=JSON.parse(fs.readFileSync(path.join(hostRun,'runtime/runs',id,name)));
    for(const tree of phase.processTrees||[phase.processTree]){check(tree?.rootBorn&&tree.members?.length,'every headless attempt retained generation inventory','output-assertion-48');inventories.push(tree);fixtureGenerations.push(...tree.members);}
   }
   const launched=fs.readFileSync(launchLog,'utf8').trim().split('\n').slice(headlessStart).map(JSON.parse);
   check(launched.length>0&&launched.every(r=>inventories.some(t=>t.rootPid===r.pid&&t.rootBorn)),'every expected headless worker covered','output-assertion-49');
  });
  }
 }finally{
  cp.spawn=originalSpawn;require('node:module').syncBuiltinESMExports();
  for(const r of children){if(r.worker&&r.child.connected)r.child.send({settle:true});await r.closed;}
  const retainPhases=dir=>{if(!fs.existsSync(dir))return;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())retainPhases(file);else if(/^phase-.*\.result\.json$/.test(entry.name)){const phase=JSON.parse(fs.readFileSync(file));for(const tree of phase.processTrees||[phase.processTree]){check(tree?.rootBorn&&tree.members?.length,'every public SDK attempt retained creation inventory','output-assertion-50');fixtureGenerations.push(...tree.members);}}}};
  retainPhases(env.PI_ORCHESTRATOR_RUNS_ROOT);
  const rows=snapshot();
  const records=children.map(({child,closed,onReady,...r})=>r),generations=[...fixtureGenerations,...records.flatMap(r=>[r.identity,...(r.descendants||[])]),...observations.flatMap(r=>[r.identity,...(r.descendants||[])])];
  const proof={testIdentity,wrapperIdentity:initial.find(p=>p.pid===testIdentity.parentPid),hostProof:[{children:records,syncCommands:[],observers:observations}],fixtures:fixtureGenerations,observers:observations,failures,failedBodies,independentlyAbsentGenerations:generations.filter(g=>g&&!rows.some(p=>p.pid===g.pid)),finalization:{stage:'launch-coverage',status:'unknown'}};
  try{
   check(children.every(r=>r.identity&&r.signal===null&&r.settled),'every expected launch has observed creation identity and natural closure','output-assertion-51');
   proof.finalization.stage='observer-coverage';
   check(observations.every(r=>r.identity),'every expected observer retained creation identity','output-assertion-52');
   proof.finalization.stage='descendant-absence';
   for(const g of fixtureGenerations)check(!rows.some(p=>p.pid===g.pid),'headless descendant independently absent','output-assertion-53');
   for(const r of children)for(const g of r.descendants||[])check(!rows.some(p=>p.pid===g.pid),'test descendant independently absent (reuse is not absence)','output-assertion-54');
   proof.finalization.stage='root-settlement';
   for(const r of children)check(!rows.some(p=>p.pid===r.identity.pid&&p.born===r.identity.born),'creation-bound waited root naturally ended','output-assertion-55');
   proof.finalization.status='passed';
   console.log('CLEANUP all output workers/headless host naturally ended; no windows or owner action');
  }catch(error){proof.finalization.status='failed';proof.finalization.label=error.safeLabel?error.message:'finalization unavailable';throw error;}
  finally{fs.writeFileSync(path.join(run,'process-proof.json'),JSON.stringify(proof,null,2));}
 }
 check(!failures.length,'output boundary checks failed','output-assertion-56');
})().catch(error=>{console.error('OUTPUT_BOUNDARY_CHECK_FAILED '+checkpointFailure(error).assertion);process.exitCode=1;});
