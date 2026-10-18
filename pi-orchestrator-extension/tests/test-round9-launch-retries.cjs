// Complete production launchers, exclusive durable claim, injected process/provider I/O.
'use strict';
const {compile,SCRATCH,substrate,ts,ROOT}=require('./test-2026-10-06-round7-worker-settlement.cjs');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const load=require(path.join(ROOT,'node_modules/jiti'))(__filename,{interopDefault:true,fsCache:false});
const judgment=load(path.join(ROOT,'src/judgment.ts')),capacity=load(path.join(ROOT,'src/executor-recovery/budget-estimator.ts'));
let restored=false,probes=0,kernel={rows:[]},onRestore=()=>{};
const generation=vm.createContext({exports:{},process,structuredClone,require:id=>id==='node:child_process'?{spawnSync:()=>({status:kernel.error?1:0,signal:null,stdout:JSON.stringify(kernel.rows)})}:id==='./process-inventory.cjs'?require(path.join(ROOT,'src/process-inventory.cjs')):require(id)});
vm.runInContext(ts.transpileModule(fs.readFileSync(path.join(ROOT,'src/process-generation.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText,generation);
const context=vm.createContext({exports:{},process,structuredClone,require:id=>id==='@earendil-works/pi-coding-agent'?{ModelRuntime:{create:async()=>({getModel:(provider,id)=>({provider,id}),completeSimple:async(_m,ctx)=>{probes++;onRestore();if(!restored)throw Error('not restored');return {stopReason:'stop',content:[{type:'text',text:ctx.messages[0].content.replace('Reply with exactly ','')}]};}})}}:id==='./run-state'?{atomicWriteJsonSync:(f,v)=>fs.writeFileSync(f,JSON.stringify(v))}:require(id)});
vm.runInContext(ts.transpileModule(fs.readFileSync(path.join(ROOT,'src/infrastructure-retry.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText,context);
fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'auth.json'),JSON.stringify({'owner-provider':{type:'api_key',key:'offline-fixture'}}));
async function exercise(relative,name,label){
 const [mode,fault]=label.split(':');kernel={rows:[]};onRestore=()=>{};
 let resuming=false;
 const currentFault=()=>resuming?undefined:fault?.startsWith('second-')?(launches===2?fault.slice(7):undefined):fault;
 const dir=path.join(SCRATCH,name+'-'+label.replace(':','-'));fs.mkdirSync(dir);const sidecar=path.join(dir,'phase.result.json');
 let launches=0,reserves=0,active,telemetry;const queue=[],waiters=[],routes=[],admissions=[];
 const next=()=>queue.length?Promise.resolve(queue.shift()):new Promise(resolve=>waiters.push(resolve));
 const deps={
  withInfrastructureRetry:context.exports.withInfrastructureRetry,
  ...generation.exports,
  truncateWithNotice:text=>text,
  isNoToolInfrastructureFailure:(f,t,c)=>{telemetry={complete:c,total:t.total,failures:f.length};return substrate.isNoToolInfrastructureFailure(f,t,c);},
  READ_ONLY_EVIDENCE_TOOLS:substrate.READ_ONLY_EVIDENCE_TOOLS,VERIFIER_EVIDENCE_TOOLS:substrate.VERIFIER_EVIDENCE_TOOLS,
  buildProviderRefusalRetryPrompt:substrate.buildProviderRefusalRetryPrompt,
  atomicWriteJsonSync(f,v){if(mode.endsWith('publication-loss')&&f===sidecar&&v.status==='incomplete')throw Error('FIXTURE_TERMINAL_PUBLICATION_LOST');
   if(f===sidecar&&v.settlement){
    if(fault==='missing'){fs.rmSync(f,{force:true});return;}
    if(fault==='unbound')v={...v,processTree:{...v.processTree,launchId:undefined}};
    if(fault==='wrong-phase')v={...v,processTree:{...v.processTree,phaseId:path.join(dir,'other.result.json'),settledMembers:v.processTree.settledMembers?.map(p=>({...p,phaseId:path.join(dir,'other.result.json')}))}};
    if(fault==='wrong-task')v={...v,taskSha256:'0'.repeat(64)};
    if(fault==='copied')v={...v,launchId:'copied',processTree:{...v.processTree,launchId:'copied',settledMembers:v.processTree.settledMembers?.map(p=>({...p,launchId:'copied'}))}};
    if(fault==='forged-clean')v={...v,processTree:{...v.processTree,members:v.processTree.members.slice(0,1),status:'clean',survivors:[]}};
   }fs.writeFileSync(f,JSON.stringify(v));},
  allocatePhaseEvidence:(_a,logFile,resultFile)=>({resultFile:resultFile??sidecar,logFile}),appendSubagentPhaseLog(){},rejectLocalModelIfNeeded(){},formatRoutedModel:()=> 'owner-route',
  workerExecutionConstraintContext:{getStore:()=>undefined},subagentPhaseLogContext:{getStore:()=>undefined},
  async resolveCompleteWorkerLaunchPrompt(){if(launches&&fault==='admission-change')kernel={rows:[{pid:45001,parentPid:44001,born:'2026-10-01T00:00:01.000Z'}]};return {provider:'owner-provider',model:'owner-model',modelArgument:'owner-model',systemPrompt:'binding',toolSchemas:[],contextWindow:10000,maxOutputTokens:1000};},
  assertWorkerPromptFitsCapacity(value){admissions.push(value.prompt);return capacity.assertWorkerPromptFitsCapacity(value);},async mkTempDir(){const p=path.join(dir,'tmp-'+launches);fs.mkdirSync(p,{recursive:true});return p;},
  materializeFrozenTestAuthorizationPolicy:()=>({file:path.join(dir,'policy'),sha256:'a'.repeat(64)}),safeFileName:v=>v,writeFile:fs.promises.writeFile,rm:fs.promises.rm,
  resolvePiCommand:()=>({command:'injected-only',argsPrefix:[],env:{}}),WORKER_MONITOR_BOOTSTRAP_EXTENSION:'bootstrap',WORKER_NO_OUTPUT_MONITOR_EXTENSION:'monitor',WORKER_EXECUTION_CONSTRAINTS_EXTENSION:'guard',
  buildWindowsEpermSpawnAttempts:(command,args,options)=>{routes.push(args.filter(a=>!String(a).includes('system-prompt')));return [{command,args,options}];},
  emptyToolCallSummary:()=>({total:0,mutating:0,byTool:{}}),recordToolCall:(v,n)=>{v.total++;v.byTool[n]=(v.byTool[n]||0)+1;},
  ActionEvidenceCollector:class{observe(){}finalize(){return {entries:[]};}},
  spawn(){launches++;kernel={rows:[{pid:44000+launches,parentPid:100,born:'2026-10-01T00:00:00.000Z'},{pid:45000+launches,parentPid:44000+launches,born:'2026-10-01T00:00:01.000Z'}]};if(launches>1&&mode.endsWith('publication-loss'))throw Error('UNEXPECTED_PUBLICATION_REDISPATCH');if(launches>3&&['policy-auth-policy','policy-auth-continue-policy'].includes(mode))throw Error('FOURTH_POLICY_LAUNCH');if(launches>1&&['nameless','variant','unknown-event','policy-incomplete','variant-auth-policy','auth-unrestored','auth-policy','policy-cap'].includes(mode))throw Error('UNEXPECTED_REDISPATCH');const child=new EventEmitter();child.pid=44000+launches;child.stdout=new EventEmitter();child.stderr=new EventEmitter();const reader=new EventEmitter();reader.close=()=>{};child.reader=reader;active=child;if(waiters.length)waiters.shift()(child);else queue.push(child);return child;},
  setTimeout:()=>({unref(){}}),setInterval:()=>({unref(){}}),clearTimeout(){},clearInterval(){},getPiChildFirstJsonTimeoutMs:()=>0,
  createInterface:()=>active.reader,isPiJsonProtocolEvent:e=>e?.type!=='unrecognized_fixture_event',acknowledgeNoOutputAlarm(){},optionalString:v=>typeof v==='string'?v:undefined,
  NO_OUTPUT_MONITOR_READY_MARKER:'FIXTURE_MONITOR_READY',NO_FORCE_KILL_GUARD_READY_MARKER:'FIXTURE_GUARD_READY',
  classifyProviderRefusal:substrate.classifyProviderRefusal,ProviderRefusalError:substrate.ProviderRefusalError,
  formatSpawnFailure:error=>error.message,buildWindowsEpermEvidence:()=>({}),writeWindowsEpermEvidence:async()=>undefined,
  SubagentDetachedError:class extends Error{},SubagentTerminalAmbiguousError:class extends Error{},isWindowsSpawnEperm:()=>false,
 };
 const ctx=compile(relative,name,deps);
 const source=fs.readFileSync(path.join(ROOT,'src/substrate.ts'),'utf8'),ast=ts.createSourceFile('substrate.ts',source,ts.ScriptTarget.Latest,true);
 const preflight=ast.statements.find(n=>n.name?.text==='preflightProviderHealth').getText(ast).replace(/^export\s+/,'');
 Object.assign(ctx,{spawnSubagent:ctx.launch,AbortController,formatRoutedModel:()=> 'owner-route',parseProviderError:judgment.parseProviderError,formatProviderError:judgment.formatProviderError,SubagentInfrastructureError:substrate.SubagentInfrastructureError});
 vm.runInContext(ts.transpileModule(preflight+';globalThis.preflight=preflightProviderHealth;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,ctx);
 const options={cwd:dir,readOnly:true,workerExecutionConstraints:{noForceKill:true},agents:new Map([['reviewer',{name:'reviewer',provider:'owner-provider',model:'owner-model',tools:['read','grep','find','ls']}]]),phaseResultFile:sidecar,reserveSpawn(){if(mode==='policy-cap'&&launches)throw Error('CAP_REFUSED');reserves++;},infrastructureRetry:{file:path.join(dir,'retry.json'),reserve(){if(mode==='policy-cap')throw Error('CAP_REFUSED');}}};
 onRestore=()=>{if(fault==='restoration-change')kernel={rows:[{pid:45001,parentPid:44001,born:'2026-10-01T00:00:01.000Z'}]};if(fault==='restoration-publication-change'){const prior=JSON.parse(fs.readFileSync(sidecar));prior.taskSha256='0'.repeat(64);fs.writeFileSync(sidecar,JSON.stringify(prior));}};
 restored=!['auth-unrestored','policy-auth','auth-policy','policy-auth-continue-policy'].includes(mode);probes=0;
 let pending=(mode==='preflight'?ctx.preflight([{provider:'owner-provider',model:'owner-model',roles:['reviewer']}],{cwd:dir,allowLocalModel:false}):ctx.launch('reviewer','Review owned fixture only.',options)).then(value=>({value}),error=>({error}));
 const drive=async(kind)=>{
  const child=await Promise.race([next(),pending.then(o=>fault?undefined:Promise.reject(o.error||Error('unexpected early settlement')))]);if(!child)return;
  child.stderr.emit('data',Buffer.from('FIXTURE_MONITOR_READY FIXTURE_GUARD_READY'));
  if(kind!=='policy-incomplete')child.reader.emit('line',JSON.stringify({type:'agent_start'}));
  if(kind==='unknown-event')child.reader.emit('line',JSON.stringify({type:'unrecognized_fixture_event'}));
  if(['nameless','variant','variant-auth-policy'].includes(kind))child.reader.emit('line',JSON.stringify({type:'tool_execution_start',toolCallId:'unknown',...(kind==='nameless'?{}:{tool_name:'read'})}));
  const failure=kind!=='success';
  child.reader.emit('line',JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:failure?'error':'stop',...(failure?{errorMessage:['policy','policy-incomplete'].includes(kind)?'provider policy refused; try rephrasing':['auth-policy','variant-auth-policy'].includes(kind)?'authentication token expired; provider policy refused; try rephrasing':'authentication token expired'}:{}),content:failure?'':'verified fixture'}}));
  if(kind!=='policy-incomplete')child.reader.emit('line',JSON.stringify({type:'agent_end'}));const obstruction=currentFault();kernel=obstruction==='unknown'?{rows:[],error:true}:['survivors','survivors-resume','forged-clean'].includes(obstruction)?{rows:kernel.rows.slice(1)}:obstruction==='unproven-reuse'?{rows:kernel.rows.slice(1).map(g=>({...g,born:'2026-10-01T00:00:02.000Z'}))}:obstruction==='missed-parent'?{rows:[{pid:46000,parentPid:49999,born:'2026-10-01T00:00:01.000Z'}]}:{rows:[]};child.emit('close',failure?1:0);
 };
 await drive(mode==='policy-incomplete'?'policy-incomplete':mode.startsWith('policy')?'policy':mode==='auth-policy'?'auth-policy':mode.startsWith('auth')?'auth':mode);
 if(mode==='policy'||mode==='auth-restored'||mode==='preflight')await drive('success');
 if(mode==='policy-auth'||mode==='policy-auth-restored')await drive('auth');
 if(mode==='policy-auth-restored')await drive('success');
 if(mode==='policy-auth-policy'){await drive('auth');await drive('policy');}
 if(mode==='policy-auth-continue-policy'){
  await drive('auth');assert.ok((await pending).error,'failed restoration blocks');
  const waiting=JSON.parse(fs.readFileSync(options.infrastructureRetry.file));assert.equal(waiting.status,'waiting');
  restored=true;
  const fresh=compile(relative,name,deps);
  pending=fresh.launch('reviewer','Review owned fixture only.',options).then(value=>({value}),error=>({error}));
  await drive('policy');
 }
 if(mode==='auth-policy-restored'){await drive('policy');await drive('success');}
 let outcome=await pending;
 if(fault==='unpinned-continue'){
  assert.ok(outcome.error);assert.equal(launches,1);const saved=JSON.parse(fs.readFileSync(options.infrastructureRetry.file));assert.equal(saved.status,'waiting');delete saved.predecessors;fs.writeFileSync(options.infrastructureRetry.file,JSON.stringify(saved));const original=fs.readFileSync(sidecar,'utf8');
  restored=true;kernel={rows:[]};const fresh=compile(relative,name,deps);await assert.rejects(fresh.launch('reviewer','Review owned fixture only.',options),error=>error instanceof generation.exports.RetryCleanupError);assert.equal(launches,1,'older waiting claim without recorder pins cannot manufacture authority');assert.equal(fs.readFileSync(sidecar,'utf8'),original);assert.equal(reserves,1);
 }else if(fault?.endsWith('survivors-resume')){
  const before=fault.startsWith('second-')?2:1;
  assert.ok(outcome.error);assert.equal(launches,before);const original=fs.readFileSync(sidecar,'utf8');const waiting=JSON.parse(fs.readFileSync(options.infrastructureRetry.file));assert.equal(waiting.status,'waiting');assert.equal(waiting.policyRetryConsumed===true,mode.startsWith('policy-auth'));
  resuming=true;kernel={rows:[]};waiters.length=0;queue.length=0;const fresh=compile(relative,name,deps);pending=fresh.launch('reviewer','Review owned fixture only.',options).then(value=>({value}),error=>({error}));await drive('success');outcome=await pending;
  assert.ok(!outcome.error,'same-owner eligible pending retry resumes after independently clean observation');assert.equal(launches,before+1);assert.equal(reserves,before+1);assert.equal(fs.readFileSync(sidecar,'utf8'),original,'predecessor publication remains unchanged');assert.equal(JSON.parse(fs.readFileSync(options.infrastructureRetry.file)).status,'settled');
  await assert.rejects(fresh.launch('reviewer','Review owned fixture only.',options));assert.equal(launches,before+1,'continuation never replenishes allowance');
 }else if(mode==='preflight'){
  assert.ok(outcome.error instanceof substrate.SubagentInfrastructureError,'typed infrastructure refusal propagates through preflight');assert.equal(launches,1,'preflight cannot downgrade to transient string retry');
  const refusal=new generation.exports.RetryCleanupError();ctx.spawnSubagent=async()=>{throw refusal;};await assert.rejects(ctx.preflight([{provider:'owner-provider',model:'owner-model',roles:['reviewer']}],{cwd:dir,allowLocalModel:false}),error=>error===refusal);assert.equal(launches,1,'typed cleanup preflight refusal never dispatches');
 }else if(fault){
  assert.ok(outcome.error,'cleanup must refuse '+fault);assert.equal(launches,fault.startsWith('second-')?2:1,'predecessor cleanup must block physical redispatch');
  const saved=JSON.parse(fs.readFileSync(options.infrastructureRetry.file));assert.equal(saved.status,'waiting','cleanup alone preserves pending retry');assert.equal(saved.policyRetryConsumed===true,mode.startsWith('policy-auth')&&fault.startsWith('second-'),'cleanup never consumes an unused policy retry');if(!mode.startsWith('auth-policy'))assert.notEqual(saved.restoration,'confirmed','cleanup never consumes unused infrastructure retry');
  assert.equal(reserves,launches,'no extra physical budget charge');
 }else if(['policy','auth-restored','policy-auth-restored','auth-policy-restored'].includes(mode)){
  const count=mode.endsWith('policy-restored')||mode==='policy-auth-restored'?3:2;
  assert.ok(!outcome.error,'supported retry settles '+mode+' '+JSON.stringify(telemetry)+' '+(outcome.error?.name??''));assert.equal(launches,count);assert.equal(reserves,count,'every launch charged');
  for(const route of routes)assert.deepEqual(route,routes[0],'same role/routes/guards');
  assert.equal(admissions.length,count,'ordinary admission runs for every launch');assert.ok(admissions.every(text=>text.includes('Review owned fixture only.')),'binding prompt retained');
  assert.equal(JSON.parse(fs.readFileSync(options.infrastructureRetry.file)).status,'settled','one durable operation settles');
  await assert.rejects(ctx.launch('reviewer','Review owned fixture only.',options));assert.equal(launches,count,'settled operation cannot replay');
  const trees=outcome.value.processTrees??[outcome.value.processTree];assert.equal(new Set(trees.map(t=>t.rootPid)).size,count,'all launch generations retained');
 }else{assert.ok(outcome.error);assert.equal(launches,['policy-auth-policy','policy-auth-continue-policy'].includes(mode)?3:mode==='policy-auth'?2:1,'unknown telemetry/restoration refusal never redispatches');}
 if(['nameless','variant','unknown-event','policy-incomplete','variant-auth-policy'].includes(mode))assert.equal(probes,0,'every start invalidates zero-tool restoration');
 if(mode.endsWith('publication-loss')){assert.equal(probes,0,'publication loss is not a restoration opportunity');await assert.rejects(ctx.launch('reviewer','Review owned fixture only.',options));assert.equal(launches,1,'lost durable settlement is never replayed');}
 if(mode==='policy')assert.equal(probes,0,'policy rewording is not an authentication probe');
 if(['auth-unrestored','auth-policy','policy-auth'].includes(mode))assert.ok(probes>0,'authentication requires independent restoration');
 console.log('PASS '+name+'/'+label);
}
(async()=>{let failures=0;try{for(const [file,name] of [['src/index.ts','runSubagent'],['src/substrate.ts','spawnSubagent']])for(const mode of ['policy','policy-incomplete','nameless','variant','unknown-event','auth-unrestored','auth-restored','policy-auth','policy-cap','auth-policy','variant-auth-policy','policy-auth-restored','auth-policy-restored','policy-auth-policy','policy-auth-continue-policy','policy-publication-loss','auth-publication-loss',...['survivors','unknown','missing','unbound','wrong-phase','wrong-task','copied','forged-clean','restoration-change','restoration-publication-change','admission-change','unproven-reuse','missed-parent','survivors-resume'].map(f=>'auth-restored:'+f),...['survivors','unknown','admission-change','survivors-resume'].map(f=>'policy:'+f),'policy-auth-restored:second-survivors','auth-policy-restored:second-survivors','policy-auth-restored:second-survivors-resume','auth-policy-restored:second-survivors-resume','auth-unrestored:unpinned-continue','preflight:typed']){try{await exercise(file,name,mode);}catch(error){failures++;console.error('RED '+name+'/'+mode+' '+error.name+' '+(error.code??'')+' '+String(error.message).split('\n')[0]);}}assert.equal(failures,0,'production retry checks failed');process.exitCode=0;}finally{fs.rmSync(SCRATCH,{recursive:true,force:true});}})().catch(()=>{console.error('LAUNCH_RETRY_CHECK_FAILED (safe labels only)');process.exitCode=1;});
