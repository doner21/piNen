#!/usr/bin/env node
'use strict';
// Execute the complete production launchers. Only their I/O boundaries are
// injected: the event consumers, recorder and result building are production.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const ROOT=path.resolve(__dirname,'..'),SOURCE=process.env.ROUND7_BASELINE_SOURCE_ROOT||ROOT;
const ts=require(path.join(ROOT,'node_modules/typescript'));
const parent=fs.realpathSync(process.env.ROUND7_TIMING_SCRATCH_PARENT||os.tmpdir());
assert.ok(parent&&path.isAbsolute(parent)&&parent===path.resolve(parent),'canonical scratch parent');
const within=(root,file)=>{const relative=path.relative(root,file);return relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative));};
assert.ok(!within(ROOT,parent)&&!/(?:orch-r7-timing-inputs-|orch-r7-timing-repair-inputs-)/i.test(parent),'scratch outside workspace/read-only inputs');
const SCRATCH=fs.mkdtempSync(path.join(parent,'command-times-'));
let wall=Date.parse('2026-10-06T12:00:00Z'),mono=100;
const HOST_NOW=Date.parse('2026-10-06T12:00:00Z');
class Clock extends Date { constructor(...args){super(...(args.length?args:[HOST_NOW]));}static now(){return HOST_NOW;} }
function decl(relative,names){const file=path.join(SOURCE,relative),text=fs.readFileSync(file,'utf8'),ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);return names.map(name=>{const node=ast.statements.find(n=>n.name?.text===name);assert.ok(node,`existing production declaration ${name}`);return node.getText(ast).replace(/^export\s+/,'');}).join('\n');}
function timingModule(){const file=path.join(SOURCE,'src/command-times.ts');if(!fs.existsSync(file))return {};const source=fs.readFileSync(file,'utf8');const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;const mod={exports:{}};vm.runInNewContext(js,{module:mod,exports:mod.exports,require:id=>id==='./action-evidence'?actionMod.exports:require(id),Date:Clock,performance:{now:()=>mono},process,console,Buffer});return mod.exports;}
const actionFile=path.join(SOURCE,'src/action-evidence.ts');const actionMod={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(actionFile,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText,{module:actionMod,exports:actionMod.exports,require:id=>id.startsWith('.')?require(path.join(path.dirname(actionFile),id)):require(id),Date:Clock,Buffer,TextDecoder,console,process});
const timing=timingModule();
// The original source genuinely lacks timing. Only its selected preservation
// replay omits additive assertions; current production never gets that waiver.
const authorityBaseline=process.env.ROUND7_TIMING_CONFLICT_ONLY==='1'&&!timing.CommandTimesCollector;
for(const [key,dir] of Object.entries({PI_CODING_AGENT_DIR:'agent',PI_ORCHESTRATOR_RUNS_ROOT:'runs',PI_ORCHESTRATOR_NEXT_RUNS_ROOT:'next'})){process.env[key]=path.join(SCRATCH,dir);fs.mkdirSync(process.env[key]);}
process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER=SCRATCH;process.env.PI_OFFLINE='1';
const Module=require('node:module'),PI=path.join(ROOT,'node_modules/@earendil-works/pi-coding-agent/node_modules');process.env.NODE_PATH=[PI,path.join(ROOT,'node_modules')].join(path.delimiter);Module._initPaths();
const jiti=require(path.join(PI,'jiti/lib/jiti.cjs'))(__filename,{interopDefault:true,moduleCache:true,fsCache:false});
const runState=jiti(path.join(SOURCE,'src/run-state.ts')),supervision=jiti(path.join(SOURCE,'src/supervision.ts')),recovery=jiti(path.join(SOURCE,'src/role-recovery.ts'));
function api(relative,names,deps={}){const js=ts.transpileModule(decl(relative,names)+`\nglobalThis.api={${names.join(',')}};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;const context=vm.createContext({Date:Clock,path,process,console,structuredClone,...timing,...deps});vm.runInContext(js,context);return context.api;}
const getCommandTimesForRun=timing.readRunCommandTimes?api('src/substrate.ts',['getCommandTimesForRun'],{subagentPhaseLogContext:{getStore:()=>({runId:'orc-timing-checkpoint'})},phaseResultPathFor:runState.phaseResultPathFor}).getCommandTimesForRun:()=>undefined;
function compile(relative,name,deps){const source=decl('src/substrate.ts',['SubagentPhaseResultRecorder','isValidBoundPhaseResult'])+'\n'+decl(relative,[name,'buildSubagentSystemPrompt','describeJsonEvent','extractMessageText']);const js=ts.transpileModule(source+`\nglobalThis.launch=${name};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;const context=vm.createContext({Date:Clock,path,os,process,console,Buffer,structuredClone,createHash:crypto.createHash,randomBytes:crypto.randomBytes,existsSync:fs.existsSync,readFileSync:fs.readFileSync,refreshLiveStatus(){},reduceSilenceAlarms:a=>a,...timing,...deps});vm.runInContext(js,context);return context;}
const failures=[];async function check(id,body){try{await body();console.log('PASS '+id);}catch(e){failures.push({id,error:e.message});console.log('RED '+id+': '+e.message);}}
async function launch(relative,name,worker,scenario={}){
 const dir=path.join(SCRATCH,`${name}-${worker}`);assert.ok(path.isAbsolute(dir)&&path.dirname(dir)===SCRATCH);fs.mkdirSync(dir);
 const resultFile=path.join(dir,'phase-2-reviewer.result.json'),child=new EventEmitter(),reader=new EventEmitter();child.pid=44100+worker;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{throw Error('no signals');};reader.close=()=>{};
 let readyResolve;const ready=new Promise(r=>{readyResolve=r;});const handle={unref(){}};
 const publications=[],hostLogs=[];
 class FailingTimingCollector extends (timing.CommandTimesCollector||class {}) { observe(event){if(scenario.timingFailure===event.type&&event.toolCallId==='cancel')throw Error('SECRET_TIMING_PARSER_FAILURE');return super.observe(event);} }
 const deps={
 ...(scenario.timingFailure?{CommandTimesCollector:FailingTimingCollector}:{}),
 atomicWriteJsonSync(file,value){publications.push(structuredClone(value));fs.writeFileSync(file,JSON.stringify(value));},
 allocatePhaseEvidence:()=>({resultFile,logFile:path.join(dir,'phase-2-reviewer.log')}),appendSubagentPhaseLog(file,kind,text){if(kind==='host')hostLogs.push(text);},
 rejectLocalModelIfNeeded(){},formatRoutedModel:()=> 'owner-route',workerExecutionConstraintContext:{getStore:()=>undefined},subagentPhaseLogContext:{getStore:()=>({runId:'run-safe',phaseName:'verify',phaseIndex:2})},
 async resolveCompleteWorkerLaunchPrompt(){return {provider:'owner',model:'model',modelArgument:'model',systemPrompt:'fixture',toolSchemas:[],contextWindow:10000,maxOutputTokens:1000};},assertWorkerPromptFitsCapacity(){if(scenario.refuse)throw Error('BINDING_CAPACITY_FIXTURE');},async mkTempDir(){const tmp=path.join(dir,'prompt');fs.mkdirSync(tmp);return tmp;},materializeFrozenTestAuthorizationPolicy:()=>({file:path.join(dir,'policy.json'),sha256:'a'.repeat(64)}),safeFileName:v=>v,writeFile:fs.promises.writeFile,rm:fs.promises.rm,
 resolvePiCommand:()=>({command:'injected-io',argsPrefix:[],env:{}}),WORKER_MONITOR_BOOTSTRAP_EXTENSION:'bootstrap',WORKER_NO_OUTPUT_MONITOR_EXTENSION:'monitor',WORKER_EXECUTION_CONSTRAINTS_EXTENSION:'guard',buildWindowsEpermSpawnAttempts:(command,args,options)=>[{command,args,options}],emptyToolCallSummary:()=>({total:0,mutating:0,byTool:{}}),
 ActionEvidenceCollector:actionMod.exports.ActionEvidenceCollector,spawn(){readyResolve();return child;},buildWindowsEpermEvidence:()=>({}),writeWindowsEpermEvidence:async()=>undefined,formatSpawnFailure:e=>e.message,
 setTimeout:()=>handle,setInterval:()=>handle,clearTimeout(){},clearInterval(){},getPiChildFirstJsonTimeoutMs:()=>0,createInterface:()=>reader,isPiJsonProtocolEvent:()=>true,acknowledgeNoOutputAlarm(){},recordToolCall(){},optionalString:v=>typeof v==='string'?v:undefined,NO_OUTPUT_MONITOR_READY_MARKER:'MONITOR_READY',NO_FORCE_KILL_GUARD_READY_MARKER:'GUARD_READY',classifyProviderRefusal:()=>undefined,SubagentDetachedError:class extends Error{},SubagentTerminalAmbiguousError:class extends Error{},isWindowsSpawnEperm:()=>false,
 };
 const ctx=compile(relative,name,deps);const pending=ctx.launch('reviewer',scenario.task||'Review fixture',{agents:new Map([['reviewer',{name:'reviewer'}]]),cwd:dir,commandTimingPrior:scenario.prior,commandTimingClocks:{wallNow:()=>wall,monotonicNow:()=>mono},commandTimingContext:{runId:'run-SECRET',role:scenario.role||'verifier',phase:2,stage:scenario.stage||'initial'},phaseResultFile:resultFile,phaseLogFile:path.join(dir,'phase-2-reviewer.log')});const settled=pending.then(value=>({value}),error=>({error}));if(scenario.refuse){const outcome=await settled,published=JSON.parse(fs.readFileSync(resultFile));await check(name+'/retry admission preserves prior timing',()=>{assert.ok(outcome.error);assert.equal(published.status,'incomplete');assert.ok(scenario.prior,'prior actual observations required');assert.equal(JSON.stringify(timing.mergeCommandTimes(published.commandTimes)),JSON.stringify(timing.mergeCommandTimes(scenario.prior)));});return published;}
 await ready;child.stderr.emit('data',Buffer.from('MONITOR_READY'));
 const emit=e=>reader.emit('line',JSON.stringify(e));
 const start=(id,toolName='bash')=>emit({type:'tool_execution_start',toolCallId:id,toolName,args:{command:'SECRET_PASSWORD=hidden'}});
 const end=(id,extra={})=>emit({type:'tool_execution_end',toolCallId:id,toolName:'bash',isError:false,result:{content:[{type:'text',text:'SECRET_RESULT'}]},...extra});
 wall=Date.parse('2026-10-06T12:00:00Z');mono=100;start('same-secret-id');mono=110;start('same-secret-id');
 const running=JSON.parse(fs.readFileSync(resultFile));
 if(!authorityBaseline)await check(name+'/running durable start',()=>{assert.equal(running.commandTimes?.entries.length,1+(scenario.prior?.entries.length||0),'actual start must be persisted before settlement');const latest=crypto.createHash('sha256').update(`${running.launchId}:0`).digest('hex');assert.equal(running.commandTimes.entries.find(e=>e.launchId===latest).endedAt,undefined);});
 wall-=60000;mono=150;end('same-secret-id');mono=900;end('same-secret-id');
 mono=1000;start('incomplete',scenario.conflict==='after-end'||scenario.timingFailure?'read':'bash');mono=1100;end('end-only');mono=1200;start('error');mono=1250;end('error',{isError:true});mono=1300;start('cancel');
 const receipt={schemaVersion:1,outcome:'cancelled_no_output',invocationId:'cancel-safe',summary:'observed cancellation',partialLog:'SECRET_RESULT',artifactPath:'SECRET_PATH',artifactSha256:'a'.repeat(64),artifactBytes:0,artifactIntegrity:'verified',cancellationRequested:true,cancellationAccepted:true,cancellationConfirmed:true,confirmationBasis:'terminal_signal_after_owned_handle_action',terminalExitCode:null,terminalSignal:'SIGTERM',cancellationTarget:'retained-direct-test-child-handle',eligibility:'authenticated_run_owned_test_child'};
 const cancellation={type:'tool_execution_update',toolCallId:'cancel',partialResult:{details:{noOutputCancellation:receipt}}};emit(cancellation);emit(cancellation);
 const conflicting={...cancellation,partialResult:{details:{noOutputCancellation:{...receipt,summary:'conflicting canonical receipt'}}}};
 if(scenario.conflict==='update')emit(conflicting); // Exact independent preservation stream.
 mono=1350;end('cancel',{isError:true,result:scenario.conflict==='end'?{details:{noOutputCancellation:{...receipt,summary:'conflicting terminal receipt'}},content:[]}:{content:[]}});
 if(scenario.conflict==='after-end'){emit(cancellation);emit(cancellation);emit(conflicting);}
 mono=1400;start('custom','SECRET_TOOL_NAME');mono=1450;end('custom');
 emit({type:'message_end',message:{role:'assistant',stopReason:'stop',content:scenario.text||'verified'}});emit({type:'agent_end'});child.emit('close',scenario.loss?1:0);
 const outcome=await settled;const persisted=JSON.parse(fs.readFileSync(resultFile));
 if(scenario.conflict==='update'||scenario.conflict==='after-end'){
  await check(name+'/'+scenario.conflict+' authoritative cancellation rejection',()=>{
   assert.ok(outcome.error?.message.includes('ACTION_EVIDENCE_CANCELLATION_CONFLICT'),'actual canonical conflict must reject, not worker success or an unrelated fixture error');
   // Pre-timing has no additive timing/incomplete-action publication contract;
   // its authoritative rejection reason is the preservation baseline.
   if(authorityBaseline)return;
   assert.equal(persisted.status,'incomplete');assert.ok(persisted.incompleteReason.includes('ACTION_EVIDENCE_CANCELLATION_CONFLICT'));
   const times=persisted.commandTimes?.entries;assert.ok(times?.some(e=>e.outcome==='incomplete'&&e.endedAt===undefined),'observed unended timing survives rejection');assert.ok(times.some(e=>e.durationMs===50),'already observed durations survive rejection');
   const ledger=persisted.actionEvidence;assert.ok(ledger?.entries.some(e=>e.status==='incomplete'),'observed pending authoritative actions survive rejection');assert.ok(ledger.entries.some(e=>e.outcome==='succeeded'),'completed authoritative actions survive rejection');assert.equal(ledger.cancellationJournals[0]?.count,scenario.conflict==='update'?1:2,'identical receipts remain idempotent');
  });return persisted;
 }
 if(scenario.timingFailure){
  await check(name+'/'+scenario.timingFailure+' timing failure preserves authority',()=>{
   assert.equal(outcome.error,undefined,'noncritical timing failure cannot block valid action evidence');assert.equal(persisted.status,'complete');assert.equal(persisted.commandTimes?.unavailable,true,'missing timing must never be presented as complete');
   assert.ok(outcome.value.actionEvidence.entries.some(e=>e.outcome==='cancelled_no_output'),'authoritative valid cancellation remains observed');assert.ok(outcome.value.actionEvidence.entries.some(e=>e.status==='incomplete'),'pending action remains observed');assert.ok(persisted.commandTimes.entries.length>0,'prior timing observations retained');
   assert.ok(hostLogs.some(text=>text.includes('COMMAND_TIMES_UNAVAILABLE')),'explicit safe timing diagnostic');assert.equal(JSON.stringify(persisted.commandTimes).includes('SECRET'),false);assert.equal(hostLogs.some(text=>text.includes('SECRET_TIMING')),false,'raw parser errors cannot leak secrets');
  });return outcome.value;
 }
 if(scenario.conflict==='end')await check(name+'/sealed receipt overrides conflicting terminal payload',()=>{assert.equal(outcome.error,undefined);const cancelled=outcome.value.actionEvidence.entries.find(e=>e.outcome==='cancelled_no_output');assert.equal(cancelled.noOutput.summary,receipt.summary,'existing authoritative update/end precedence retained');});
 if(scenario.loss){await check(name+'/worker loss preserves incomplete command',()=>{if(scenario.prior)assert.ok(scenario.prior.entries.every(e=>persisted.commandTimes?.entries.some(current=>current.id===e.id)),'prior observations survive failed retry');assert.ok(outcome.error,'failed worker must reject');assert.equal(persisted.status,'incomplete');const entry=persisted.commandTimes?.entries.find(e=>e.outcome==='incomplete');assert.ok(entry,'unended start is retained');assert.equal(entry.endedAt,undefined);assert.equal(entry.durationMs,undefined);assert.equal(persisted.commandTimes.entries.find(e=>e.outcome==='cancelled_no_output')?.durationMs,50,'observed cancellation persists even without successful worker settlement');});return persisted;}
 assert.equal(outcome.error,undefined,outcome.error?.stack);const result=outcome.value;
 await check(name+'/complete command evidence',()=>{const order=['same-secret-id','incomplete','end-only','error','cancel','custom'].map(id=>crypto.createHash('sha256').update(id).digest('hex'));const priorIds=new Set(scenario.prior?.entries.map(e=>e.id)||[]);const entries=result.commandTimes?.entries.filter(e=>!priorIds.has(e.id)).sort((a,b)=>order.indexOf(a.toolCallId)-order.indexOf(b.toolCallId));assert.equal(entries?.length,6,'production result must carry all observed tool commands');assert.equal(entries[0].durationMs,50,'duplicate events idempotent; duration uses monotonic, not reversed wall clock');assert.equal(entries[0].startedAt,'2026-10-06T12:00:00.000Z');assert.equal(entries[0].endedAt,'2026-10-06T11:59:00.000Z');assert.equal(entries[0].outcome,'succeeded');assert.equal(entries[1].outcome,'incomplete');assert.equal(entries[1].endedAt,undefined);assert.equal(entries[2].startedAt,undefined);assert.equal(entries[2].durationMs,undefined);assert.equal(entries[3].outcome,'failed');assert.equal(entries[4].outcome,'cancelled_no_output');assert.equal(JSON.stringify(entries).includes('SECRET'),false);assert.equal(JSON.stringify(entries).includes('same-secret-id'),false);assert.equal(JSON.stringify(persisted.result.commandTimes),JSON.stringify(result.commandTimes));assert.equal(JSON.stringify(timing.mergeCommandTimes(persisted.commandTimes)),JSON.stringify(timing.mergeCommandTimes(result.commandTimes)));assert.ok(entries.every(e=>e.runId&&e.launchId&&e.role==='verifier'&&e.phase===2&&e.stage===(scenario.stage||'initial')));});
 return result;
}
(async()=>{try{const results=[];
 if(process.env.ROUND7_TIMING_ORIGINAL_ONLY!=='1')for(const [relative,name]of [['src/substrate.ts','spawnSubagent'],['src/index.ts','runSubagent']]){
  await launch(relative,name,77,{conflict:'update'});
  if(process.env.ROUND7_TIMING_CONFLICT_ONLY==='1')continue;
  await launch(relative,name,78,{conflict:'after-end'});await launch(relative,name,79,{conflict:'end'});
  await launch(relative,name,80,{timingFailure:'tool_execution_update'});await launch(relative,name,81,{timingFailure:'tool_execution_end'});
  await launch(relative,name,82,{conflict:'update',timingFailure:'tool_execution_update'});
  await launch(relative,name,83,{conflict:'after-end',timingFailure:'tool_execution_end'});
 }
 if(process.env.ROUND7_TIMING_CONFLICT_ONLY==='1')return;
 for(const [relative,name]of [['src/substrate.ts','spawnSubagent'],['src/index.ts','runSubagent']])for(const worker of [1,2])results.push(await launch(relative,name,worker));
 await check('two workers/reload/repeated aggregation',()=>{assert.ok(results.every(r=>r.commandTimes),'both production paths supply evidence');const reloaded=JSON.parse(JSON.stringify(results));const merged=timing.mergeCommandTimes(...reloaded.map(r=>r.commandTimes));assert.equal(merged.entries.length,24,'same toolcall ID belongs to distinct launches');assert.equal(timing.mergeCommandTimes(merged,merged).entries.length,24);const summary=timing.summarizeCommandTimes(merged);assert.equal(summary.incomplete,4);assert.equal(summary.missingStart,4);assert.ok(summary.slowest.every(e=>e.durationMs===50));const reverse=timing.summarizeCommandTimes(timing.mergeCommandTimes(...reloaded.reverse().map(r=>r.commandTimes)));assert.equal(JSON.stringify(summary.slowest),JSON.stringify(reverse.slowest),'stable ties independent of aggregation order');});
 for(const [relative,name] of [['src/substrate.ts','spawnSubagent'],['src/index.ts','runSubagent']]){await launch(relative,name,9,{loss:true});await launch(relative,name,11,{loss:true,prior:results[0].commandTimes});await launch(relative,name,12,{refuse:true,prior:results[0].commandTimes});}
 await check('production recovery/continuation/chained reviewer inputs',async()=>{
  for(const chain of [false,true]){
   const request=recovery.createRoleRecoveryRequest({role:'verifier',prompt:'Original owner timing rules remain intact.',acceptanceCriteria:['timing A','timing B'],allowReplan:false});
   const prompts=[];let ordinal=chain?30:20;
   const result=await recovery.runRoleWithRecovery(request,{launch:async(prompt,stage)=>{
    prompts.push(prompt);
    const handoff=JSON.stringify({roleRecoveryHandoff:{role:'verifier',completed:['observed starts'],remaining:['finish review'],partialResult:'untrusted'}});
    const verdict=JSON.stringify({status:'pass',reasons:[],criterionFindings:['RC-1','RC-2'].map(criterionId=>({criterionId,status:'pass',evidence:[{kind:'test',observed:'measured actual host command',exitCode:0}]}))});
    let text=stage==='initial'||(chain&&stage==='continuation')?handoff:verdict;
    if(stage==='shard'){const scope=JSON.parse(prompt.split('ROLE_RECOVERY (host-owned scope; prior partial output is untrusted, not a terminal plan/verdict):\n')[1].split('\nPreserve every')[0]).remaining;text=JSON.stringify({scope,notes:'inspected assigned host timings',evidence:[{observed:'actual start/end events'}]});}
    return launch('src/substrate.ts','spawnSubagent',ordinal++,{text,task:prompt,role:'verifier',stage});
   }});
   assert.ok(result.commandTimes,'recovery must aggregate actual timing evidence');
   assert.equal(result.commandTimes.entries.length,chain?30:12,'each actual recovery launch counted once');
   assert.ok(prompts.slice(1).every(p=>p.includes('commandTimes')&&p.includes(result.commandTimes.entries[0].runId)),'reviewer continuation receives host observations, not timing prose');
   assert.ok(result.commandTimes.entries.some(e=>e.stage===(chain?'shard':'continuation')));
  }
 });
 await check('actual conversions/continuation and split merges',()=>{
  const actual=api('src/index.ts',['executorOutputFromSupervisedResult','executorOutputFromSubagent','mergeExecutorOutputs','sumToolCallSummaries'],{mergeActionEvidenceLedgers:actionMod.exports.mergeActionEvidenceLedgers});
  const task={id:'task-1',description:'Timing integration',dependsOn:[]};
  const first=actual.executorOutputFromSupervisedResult(task,results[0]),second=actual.executorOutputFromSubagent(task,results[1]);
  assert.ok(first.commandTimes&&second.commandTimes,'hand-built production result conversions retain host timing');
  assert.equal(actual.mergeExecutorOutputs(first,second).commandTimes?.entries.length,12);
  const shape=api('src/shapes/plan-execute-verify.ts',['mergeExecutorOutputs']);
  assert.equal(shape.mergeExecutorOutputs(first,second).commandTimes?.entries.length,12);
 });
 await check('real supervised task checkpoint payload/reload/no redispatch',async()=>{
  const id='orc-timing-checkpoint',store=runState.RunStateStore.create(id,'plan-execute-verify','Timing integration',{},[]);
  const task={id:'task-1',description:'Timing integration',dependsOn:[]};
  const converted=api('src/index.ts',['executorOutputFromSupervisedResult']).executorOutputFromSupervisedResult(task,results[0]);
  let dispatches=0;
  const host=api('src/index.ts',['executeOneSupervisedTask','executorOutputFromSupervisedResult'],{RunStateStore:runState.RunStateStore,requireGenericRuntime:s=>s.runtime,executeExecutorTaskWithRecovery:async()=>{dispatches++;return converted;},SubagentDetachedError:class extends Error{}});
  const state={runId:id,mission:{paradigm:'plan-execute-verify',originalTask:'Timing integration'},runtime:{adapterState:{},executorOutputs:[]}};
  await host.executeOneSupervisedTask(state,{}, {},new Map(),task,{tasks:[task]},undefined,()=>{});
  const loaded=runState.RunStateStore.load(id),checkpoint=[...loaded.checkpoints.values()][0];
  assert.ok(checkpoint.commandTimes,'actual supervised checkpointPhase caller serializes timing');
  assert.equal(checkpoint.commandTimes.entries.length,6);
  const restored=await host.executeOneSupervisedTask(state,{}, {},new Map(),task,{tasks:[task]},undefined,()=>{});
  assert.equal(dispatches,1,'reload restores, never replays executor');assert.equal(restored.commandTimes.entries.length,6);
  assert.equal(getCommandTimesForRun(id)?.entries.length,6,'actual run aggregation sees checkpoint evidence');
 });
 await check('actual reviewer prompts/ordinary round summaries/details',()=>{
  const deps={getCommandTimesForRun,MAX_EXECUTOR_MARKDOWN_CHARS:10000,MAX_FINAL_MARKDOWN_CHARS:100000,MAX_DETAIL_TEXT_CHARS:10000,truncateWithNotice:v=>v,formatToolCallSummary:()=> 'observed',formatRoutingEvidence:v=>v.evidence};
  const names=['buildFinalResult','buildDetails','compactExecutorOutput','compactPlan','compactUnknown','compactVerifierResult','buildVerificationPrompt'];
  const task={id:'task-1',description:'Timing integration',dependsOn:[]};
  const outputs=api('src/index.ts',['executorOutputFromSubagent']).executorOutputFromSubagent(task,results[0]);
  const state={runId:'orc-timing-checkpoint',attempt:1,spawnedCount:4,spawnGuard:{spawned:4,cap:10},intake:null,plan:null,planText:'',executorOutputs:[outputs],verifierResult:null,verifierResults:[],routingEvidence:[],routingCheck:null,attempts:[],failureReasons:[],gateWarnings:[],commitEvidence:[],taskLedger:new Map(),progressLog:[],recoveryLog:[],recoveryDepth:0,maxRecoveryDepth:3,finalResult:''};
  for(const relative of ['src/index.ts','src/shapes/plan-execute-verify.ts']){
   const host=api(relative,names,{...deps,bindingPromptPreamble:()=> 'OWNER-END',formatIntakeForPrompt:()=> '{}'});
   const details=host.buildDetails('pass',{task:'Timing integration',maxSubagents:10},state);
   assert.equal(details.commandTimes?.entries.length,6,'round details preserve host timings once');
   const markdown=host.buildFinalResult('pass',{task:'Timing integration',maxSubagents:10},state);
   assert.ok(markdown.includes('## Host command times')&&markdown.includes('50ms')&&markdown.includes('incomplete: 1'),'actual round summary includes slowest and honest incomplete count');
   const prompt=host.buildVerificationPrompt({},null,[outputs],'');assert.ok(prompt.includes('HOST-OWNED COMMAND TIMING')&&prompt.includes(results[0].commandTimes.entries[0].id),'independent reviewer receives the actual timing evidence');
  }
  const visible=api('src/index.ts',['buildVisibleMainVerificationPrompt'],{bindingPromptPreamble:()=> 'OWNER-END'}).buildVisibleMainVerificationPrompt({}, {},null,[outputs]);assert.ok(visible.includes('HOST-OWNED COMMAND TIMING')&&visible.includes(results[0].commandTimes.entries[0].id));
 });
 await check('real supervision envelope reload and compact round summary',()=>{
  const id='orc-timing-supervision',runDir=runState.runDirFor(id);fs.mkdirSync(runDir);
  const mission=supervision.createFrozenMission({originalTask:'Timing integration',cwd:runDir,worktree:{root:runDir,realRoot:runDir,branch:'fixture',baseline:'fixture'},paradigm:'plan-execute-verify',lane:'orchestrator-maintenance',routes:[],constraints:[],nonGoals:[],acceptanceCriteria:[{id:'AC-01',text:'timing',required:true}]});
  const state=supervision.createInitialSupervisionState({runId:id,mission,tasks:[]}),store=new supervision.SupervisionStateStore(id,process.env.PI_ORCHESTRATOR_RUNS_ROOT);store.create(state);
  const saved=store.appendCheckpoint(state,{kind:'executor',createdAt:new Date(HOST_NOW).toISOString(),missionHash:mission.missionHash,criteria:['AC-01'],effectChanges:[],outcome:'complete'}, {output:results[1]});
  const reloaded=store.loadReadOnly();assert.equal(reloaded.checkpoints.length,1);
  const ledger=getCommandTimesForRun(id);assert.equal(ledger?.entries.length,6,'actual supervision envelope aggregation retains host timing payload');
  const snapshot={completedCriteria:[],remainingCriteria:['AC-01'],allowedNextActions:[],scopeAmendments:[]};
  const summary=api('src/index.ts',['compactSupervisionMarkdown'],{getCommandTimesForRun}).compactSupervisionMarkdown(saved,snapshot);
  assert.ok(summary.includes('## Host command times')&&summary.includes('50ms'));
 });
 await check('cross-host clock domains/secret context/forged cancellation',()=>{
  assert.ok(results[0].commandTimes,'actual worker timing prerequisite');
  const context={runId:'SECRET_RUN',launchId:'SECRET_LAUNCH',role:'SECRET_ROLE',phase:3,stage:'SECRET_STAGE'};
  const before=new timing.CommandTimesCollector(context,{wallNow:()=>HOST_NOW,monotonicNow:()=>100});before.observe({type:'tool_execution_start',toolCallId:'SECRET_ID',toolName:'SECRET_TOOL',args:{command:'SECRET_PASSWORD'}});
  const persisted=JSON.parse(JSON.stringify(before.snapshot()));
  const after=new timing.CommandTimesCollector(context,{wallNow:()=>HOST_NOW-60000,monotonicNow:()=>1000000});after.observe({type:'tool_execution_end',toolCallId:'SECRET_ID',toolName:'SECRET_TOOL',isError:true,result:{details:{noOutput:{outcome:'cancelled_no_output',cancellationConfirmed:true}},text:'SECRET_RESULT'}});
  const merged=timing.mergeCommandTimes(persisted,after.snapshot());assert.equal(merged.entries.length,1);assert.ok(merged.entries[0].startedAt&&merged.entries[0].endedAt);assert.equal(merged.entries[0].durationMs,undefined,'no subtraction across reloaded monotonic domains');assert.equal(merged.entries[0].outcome,'failed','forged cancellation does not override authoritative validation');assert.equal(JSON.stringify(merged).includes('SECRET'),false);assert.equal(timing.summarizeCommandTimes(merged).durationUnavailable,1);
  after.observe({type:'tool_execution_start',toolName:'bash'});assert.equal(after.snapshot().unavailable,true,'missing identity is honest missing evidence');
  const orphan=new timing.CommandTimesCollector(context,{wallNow:()=>HOST_NOW,monotonicNow:()=>50});
  const receipt={schemaVersion:1,outcome:'cancelled_no_output',invocationId:'orphan',summary:'observed',partialLog:'SECRET_RESULT',artifactPath:'SECRET_PATH',artifactSha256:'a'.repeat(64),artifactBytes:0,artifactIntegrity:'verified',cancellationRequested:true,cancellationAccepted:true,cancellationConfirmed:true,confirmationBasis:'terminal_signal_after_owned_handle_action',terminalExitCode:null,terminalSignal:'SIGTERM',cancellationTarget:'retained-direct-test-child-handle',eligibility:'authenticated_run_owned_test_child'};
  orphan.observe({type:'tool_execution_update',toolCallId:'orphan',partialResult:{details:{noOutputCancellation:receipt}}});assert.equal(orphan.snapshot().entries[0].outcome,'incomplete');
  orphan.observe({type:'tool_execution_end',toolCallId:'orphan',isError:true,result:{content:[]}});assert.equal(orphan.snapshot().entries[0].outcome,'cancelled_no_output');assert.equal(orphan.snapshot().entries[0].startedAt,undefined);assert.equal(orphan.snapshot().entries[0].durationMs,undefined);
  const unsafe={schemaVersion:1,entries:[{...merged.entries[0],tool:'SECRET_TOOL',args:'SECRET_ARGS',result:'SECRET_RESULT'}]};assert.equal(timing.summarizeCommandTimes(unsafe).unavailable,true);assert.equal(timing.formatCommandTimes(unsafe).includes('SECRET'),false);
  const malformed=timing.mergeCommandTimes({schemaVersion:1});assert.equal(malformed.unavailable,true);
  const extras=timing.mergeCommandTimes({schemaVersion:1,entries:[{...merged.entries[0],args:'SECRET_ARGS',result:'SECRET_RESULT'}]});assert.equal(JSON.stringify(extras).includes('SECRET'),false);
 });
 if(process.env.ROUND7_TIMING_ORIGINAL_ONLY!=='1')await check('collector observation failure preserves prior incomplete timing',()=>{
  let fail=false;
  const collector=new timing.CommandTimesCollector({runId:'safe',launchId:'safe'},{wallNow:()=>{if(fail)throw Error('SECRET_CLOCK_FAILURE');return HOST_NOW;},monotonicNow:()=>100});
  collector.observe({type:'tool_execution_start',toolCallId:'safe',toolName:'bash'});fail=true;
  assert.throws(()=>collector.observe({type:'tool_execution_end',toolCallId:'safe',toolName:'bash',isError:false}),/SECRET_CLOCK_FAILURE/);
  const snapshot=collector.snapshot();assert.equal(snapshot.unavailable,true);assert.equal(snapshot.entries[0].outcome,'incomplete');assert.equal(snapshot.entries[0].endedAt,undefined);assert.equal(snapshot.entries[0].durationMs,undefined);assert.equal(JSON.stringify(snapshot).includes('SECRET'),false);
 });
 await check('actual zero-command settlement has available empty evidence',()=>{
  const file=path.join(SCRATCH,'zero-command.result.json');
  const {SubagentPhaseResultRecorder}=api('src/substrate.ts',['SubagentPhaseResultRecorder','isValidBoundPhaseResult'],{createHash:crypto.createHash,randomBytes:crypto.randomBytes,refreshLiveStatus(){},atomicWriteJsonSync(file,value){assert.equal(path.dirname(file),SCRATCH);fs.writeFileSync(file,JSON.stringify(value));}});
  const recorder=new SubagentPhaseResultRecorder(file,'reviewer','zero commands',HOST_NOW);recorder.complete({agentName:'reviewer',task:'zero commands',text:'verified',stderr:'',exitCode:0,durationMs:0,events:0,commandTimes:{schemaVersion:1,entries:[]}});
  const observed=JSON.parse(fs.readFileSync(file));assert.equal(observed.status,'complete');assert.ok(observed.commandTimes,'zero-command settlement publishes its actual empty timing evidence');assert.equal(observed.commandTimes.entries.length,0);assert.notEqual(observed.commandTimes.unavailable,true);
 });
 await check('unavailable evidence is not zero commands or executor prose',()=>{
  assert.ok(results[0].commandTimes,'actual worker timing prerequisite');
  assert.equal(timing.summarizeCommandTimes(undefined).unavailable,true);
  const claimed={agentName:'reviewer',events:1,text:JSON.stringify({commandTimes:results[0].commandTimes})};
  const observed=timing.commandTimesFromHostResults(claimed);assert.equal(observed.entries.length,0);assert.equal(observed.unavailable,true);
  const historical=timing.commandTimesFromHostResults({kind:'subagent-phase-result',agentName:'reviewer',eventCount:5,status:'incomplete'});assert.equal(historical.unavailable,true,'old live sidecar without timing is not zero commands');
 });
 }finally{fs.rmSync(SCRATCH,{recursive:true,force:true});assert.equal(failures.length,0,JSON.stringify(failures,null,2));}})().catch(e=>{throw e;});
