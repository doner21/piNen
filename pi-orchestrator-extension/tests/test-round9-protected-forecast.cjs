#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.resolve(__dirname,'..'), ts=require(path.join(ROOT,'node_modules/typescript'));
const source=fs.readFileSync(path.join(ROOT,'src/supervision.ts'),'utf8'),ast=ts.createSourceFile('supervision.ts',source,ts.ScriptTarget.Latest,true);
const names=['checkAutomaticPlanApproval','checkProtectedAreaForecast','decideProtectedAreaPermission','excludesNativeObservation','isProtectedNativePath','protectedScopeCovers','checkSavedPlanConsistency','canonicalValue','canonicalJson'];
const declarations=ast.statements.filter(n=>names.includes(n.name?.text)).map(n=>n.getText(ast).replace(/^export\s+/,'')).join('\n');
let savedPlan, corruptSaved, repairPayload;
const context=vm.createContext({Error,Set,path,process:{pid:800001},performance:{timeOrigin:100000},verifyFrozenMission:()=>true,runDirFor:()=>'/owned/run',fs:{existsSync:()=>true,readFileSync:file=>JSON.stringify({payload:String(file).includes('-verifier.json')?repairPayload:{plan:corruptSaved??savedPlan}})},validateCriterionTaskPlan:()=>[],checkLanePaths:()=>[]});
vm.runInContext(ts.transpileModule(declarations+'\nglobalThis.api=checkAutomaticPlanApproval;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
function decision(needs,grants=[],file='src/audio-device-client.ts') {
  savedPlan={tasks:[{id:'task-1',description:'ordinary authorized TypeScript',criteria:['AC-01'],dependsOn:[],predictedWriteSet:[file]}],predictedWriteSet:[file],protectedAreasNeeded:needs,raw:{protected_area_grants:['native-code']}};
  return context.api({runId:'fixture',mission:{acceptanceCriteria:[{id:'AC-01'}],protectedAreaGrants:grants},runtime:{plan:savedPlan},tasks:[{...savedPlan.tasks[0],criteria:['AC-01'],predictedWriteSet:[file]}],checkpoints:[{id:'checkpoint-1',kind:'plan',outcome:'plan_ready'}]}, {allowedWriteSet:[file]});
}
assert.equal(decision(['native-code'],[],'src/ordinary.ts').approved,false,'ungranted explicit protected need must stop before builder');
assert.match(decision(['native-code'],[],'src/ordinary.ts').reasons.join(';'),/owner.*native-code/i,'precise named owner request, not planner self-grant');
assert.equal(decision([],[]).approved,true,'TypeScript talking to audio/device is ordinary, not filename-protected');
assert.equal(decision(['native-code'],['native-code'],'experiments/phase0/parallel-crossfade/host.cpp').approved,true,'recorded named grant is authoritative');
assert.equal(decision(undefined,[],'src/ordinary.ts').approved,false,'missing forecast is not an empty forecast');
// Native-producing inputs and generated source must not hide behind an empty forecast.
for(const file of ['tools/stage6/native/CMakeLists.txt','tools/stage6/native/build.ps1','tools/phase1/native/README.md','experiments/phase0/parallel-crossfade/build.bat','generated/dsp.c++','generated/dsp.hxx','generated/engine.mm','generated/voice.cu','generated/build.cmake']) {
  assert.equal(decision([],[],file).approved,false,'protected native input: '+file);
}
assert.equal(decision([],[],'src/native-device-client.ts').approved,true,'ordinary TypeScript remains ordinary');
const exact='native-code:tools/stage6/native/CMakeLists.txt';
assert.equal(decision([exact],[exact],'tools/stage6/native/CMakeLists.txt').approved,true,'precise admission grant covers the precise need');
assert.equal(decision([exact],['native-code:tools/phase1/native/'],'tools/stage6/native/CMakeLists.txt').approved,false,'unrelated grant cannot authorize producing build input');
assert.equal(decision([],['native-code:tools/stage6/native/'],'tools/stage6/native/CMakeLists.txt').approved,true,'an already recorded native folder grant covers work within that exact scope');
assert.equal(decision([],['native-code:tools/stage6/native/'],'tools/stage6/native-other/CMakeLists.txt').approved,false,'prefix grant is segment bounded');
const observed='native-observe-notify-wake:experiments/phase0/parallel-crossfade/waiter.cpp';
assert.equal(decision([observed],[observed],'experiments/phase0/parallel-crossfade/waiter.cpp').approved,true,'already granted observation needs no second grant');
for(const grant of ['native-code','native-code:experiments/phase0/parallel-crossfade/'])assert.equal(decision([observed],[grant],'experiments/phase0/parallel-crossfade/waiter.cpp').approved,true,'covering native grant satisfies narrow adjacent observation');
assert.equal(decision([observed],['native-code:tools/phase1/native/'],'experiments/phase0/parallel-crossfade/waiter.cpp').approved,false,'unrelated native scope cannot cover observation');
assert.equal(decision([observed],[observed],'experiments/phase0/parallel-crossfade/STOP.cpp').approved,false,'observation exception never grants STOP');
for(const name of ['device.cpp','lease.cpp','voice-allocation.cpp','crossfade.cpp','A-B.cpp'])assert.equal(decision([observed],[observed],'experiments/phase0/parallel-crossfade/'+name).approved,false,'observation never grants '+name);
// Same covered scope: camel/compound names must not turn STOP/device/lease/
// allocation/swap into the adjacent observation exception.
const scope='native-observe-notify-wake:tools/phase1/native/';
for(const name of ['audioDeviceClient.cpp','device_lease.cpp','STOPButton.cpp','voiceAllocation.cpp','crossFade.cpp','ABSwap.cpp'])assert.equal(decision([scope],[scope],'tools/phase1/native/'+name).approved,false,'compound protected operation '+name);
assert.equal(decision([scope],[scope],'tools/phase1/native/captureWake.cpp').approved,true,'scoped capture/wake stays ordinary adjacent observation');
// Strict parsing must not let a convenient alias hide a conflicting or malformed one.
const indexText=fs.readFileSync(path.join(ROOT,'src/index.ts'),'utf8');
const indexAst=ts.createSourceFile('index.ts',indexText,ts.ScriptTarget.Latest,true);
const parseDeclarations=indexAst.statements.filter(n=>['parsePlan','parseProtectedAreaForecast'].includes(n.name?.text)).map(n=>n.getText(indexAst).replace(/^export\s+/, '')).join('\n');
const parser=vm.createContext({extractJson:JSON.parse,normalizePlanTask:(x)=>x,parseWriteSetInput:x=>x,stringArray:x=>x,optionalString:x=>x,inferDefaultExpectsFileChange:()=>false});
vm.runInContext(ts.transpileModule(parseDeclarations+'\nglobalThis.parse=parsePlan;globalThis.forecast=parseProtectedAreaForecast;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,parser);
const parsed=extra=>parser.parse(JSON.stringify({tasks:[{id:'one',description:'inspect',dependsOn:[]}],...extra}),'inspect');
assert.equal(parsed({protected_areas_needed:[],protectedAreasNeeded:['native-code']}).protectedAreasNeeded,undefined,'conflicting forecast aliases fail closed');
assert.equal(parsed({protected_areas_needed:[],protectedAreasNeeded:null}).protectedAreasNeeded,undefined,'malformed aliases cannot be hidden by []');
assert.equal(parsed({protected_areas_needed:'none'}).protectedAreasNeeded,undefined);
assert.equal(parsed({}).protectedAreasNeeded,undefined);
assert.equal(JSON.stringify(parsed({protected_areas_needed:[]}).protectedAreasNeeded),'[]');
assert.equal(JSON.stringify(parsed({protected_areas_needed:['native-code'],protectedAreasNeeded:['native-code']}).protectedAreasNeeded),'["native-code"]');
assert.equal(JSON.stringify(parser.forecast({},true)),'[]','deterministic host plan persists explicit empty forecast');
assert.equal(JSON.stringify(parser.forecast({protectedAreasNeeded:['native-code']},true)),'["native-code"]','deterministic supplied needs preserved');
assert.equal(parser.forecast({protectedAreasNeeded:null},true),undefined,'deterministic malformed forecast is not none');
// Checkpoint state is authoritative for dependencies, criteria and task scopes too.
for(const [field,value] of [['dependsOn',['missing']],['criteria',['AC-other']],['predictedWriteSet',['outside.ts']]]) {
  decision([]);corruptSaved=JSON.parse(JSON.stringify(savedPlan));corruptSaved.tasks[0][field]=value;
  assert.equal(decision([]).approved,false,'saved/runtime '+field+' mismatch must refuse');corruptSaved=undefined;
}
// A precheck can race a changed durable plan. The dispatch fence must recheck
// permission before consuming authority, even for a valid manual approval.
let dispatchMethod;function walk(n){if(ts.isMethodDeclaration(n)&&n.name?.text==='consumeApprovalForDispatch')dispatchMethod=n.getText(ast);ts.forEachChild(n,walk);}walk(ast);
let consumed=0;Object.assign(context,{createApprovalConsumptionMetadata:()=>({}),consumeApprovalToken:()=>{consumed++;return {};}});
vm.runInContext(ts.transpileModule('class Store {'+dispatchMethod+'}\nglobalThis.Store=Store;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
// Existing fs binding is a deliberately non-writing transaction fixture.
vm.runInContext('fs.openSync=()=>1;fs.closeSync=()=>{};fs.unlinkSync=()=>{};',context);
const store=new context.Store();store.stateFile='/owned/run/supervision.json';store.runDir='/owned/run';store.save=()=>{};
// This extracted-method fixture isolates the downstream protected/saved-plan
// gates with lifecycle authority already established. Real ownership and
// settlement issuance/consumption run through the public SDK lifecycle tests.
store.assertApprovalAuthority=()=>{};
store.loadReadOnly=()=>({runId:'fixture',currentApproval:{},mission:{protectedAreaGrants:[]},tasks:[],runtime:{kind:'generic-shape',cursor:{stage:'executor-task'},plan:{tasks:[],protectedAreasNeeded:['native-code']}}});
assert.throws(()=>store.consumeApprovalForDispatch('valid',{action:'continue'}),/protected|permission/i,'dispatch rechecks protected needs under the ownership fence');assert.equal(consumed,0);
decision([]);corruptSaved=JSON.parse(JSON.stringify(savedPlan));corruptSaved.tasks[0].dependsOn=['forged'];
store.loadReadOnly=()=>({runId:'fixture',currentApproval:{},mission:{protectedAreaGrants:[]},tasks:savedPlan.tasks,checkpoints:[{id:'checkpoint-1',kind:'plan'}],runtime:{kind:'generic-shape',cursor:{stage:'executor-task'},plan:savedPlan}});
assert.throws(()=>store.consumeApprovalForDispatch('valid',{action:'continue'}),/saved plan|checkpoint/i,'manual dispatch refuses changed saved dependency under fence');assert.equal(consumed,0);corruptSaved=undefined;
assert.doesNotThrow(()=>store.consumeApprovalForDispatch('valid',{action:'continue'}),'intact ordinary plan may consume manual authority');assert.equal(consumed,1);
// A host-generated bounded repair is an authenticated verifier-checkpoint
// extension of the original plan, not an arbitrary plan amendment.
const original=JSON.parse(JSON.stringify(savedPlan));
const repair={id:'repair-1',description:'Repair only verifier failures for AC-01',dependsOn:['task-1'],criteria:['AC-01'],predictedWriteSet:['src/audio-device-client.ts']};
repairPayload={boundedRepair:repair};
const repairedState={runId:'fixture',currentApproval:{},mission:{protectedAreaGrants:[],acceptanceCriteria:[{id:'AC-01'}]},tasks:[...original.tasks,repair],approvedTaskIds:['task-1','repair-1'],checkpoints:[{id:'checkpoint-1',sequence:1,kind:'plan'},{id:'checkpoint-2',sequence:2,kind:'verifier',outcome:'fail'}],runtime:{kind:'generic-shape',params:{maxRetries:1},repairCount:1,cursor:{stage:'executor-task'},plan:{...original,tasks:[...original.tasks,repair]}}};
store.loadReadOnly=()=>repairedState;
assert.doesNotThrow(()=>store.consumeApprovalForDispatch('repair',{action:'continue'}),'host-generated bounded repair must reach actual dispatch fence');
const accepted=consumed;
for(const change of [s=>{s.tasks[0].description='forged original';},s=>{s.tasks[1].description='arbitrary task-list edit';},s=>{s.runtime.plan.protectedAreasNeeded=undefined;},s=>{s.tasks[1].predictedWriteSet=['generated/new.cpp'];}]){
 const state=JSON.parse(JSON.stringify(repairedState));change(state);store.loadReadOnly=()=>state;
 assert.throws(()=>store.consumeApprovalForDispatch('forged',{action:'continue'}),/saved plan|checkpoint|permission/i);assert.equal(consumed,accepted,'refusal never consumes dispatch authority');
}
store.loadReadOnly=()=>repairedState;repairPayload=undefined;
assert.throws(()=>store.consumeApprovalForDispatch('unproven',{action:'continue'}),/saved plan|checkpoint/i,'no verifier repair evidence means no task extension');assert.equal(consumed,accepted);
// Run the real pre-launch permission gates from BOTH launchers. A profile name
// or recovery label is not capability proof; an exact nonmutating tool list is.
const substrateText=fs.readFileSync(path.join(ROOT,'src/substrate.ts'),'utf8');
const substrateAst=ts.createSourceFile('substrate.ts',substrateText,ts.ScriptTarget.Latest,true);
const readOnlyHelper=substrateAst.statements.find(n=>n.name?.text==='isProvablyReadOnlySubagent').getText(substrateAst).replace(/^export\s+/,'');
for(const [tree,text,name] of [[indexAst,indexText,'runSubagentAttempt'],[substrateAst,substrateText,'spawnSubagentAttempt']]){
 const fn=tree.statements.find(n=>n.name?.text===name),body=fn.body.statements;const boundary=body.findIndex(n=>/const startedAt = Date.now/.test(n.getText(tree)));assert.ok(boundary>0);
 const gate=body.slice(0,boundary).map(n=>n.getText(tree)).join('\n');
 const sandbox=vm.createContext({Set,Error,READ_ONLY_EVIDENCE_TOOLS:['read','grep','find','ls'],workerExecutionConstraintContext:{getStore:()=>undefined},decideProtectedAreaPermission:()=>({approved:false,reasons:['owner native grant missing']})});
 vm.runInContext(ts.transpileModule(readOnlyHelper+'\nfunction gate(agentName, options){'+gate+'}\nglobalThis.gate=gate;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,sandbox);
 const options=tools=>({agents:new Map([['worker',{name:'worker',...(tools?{tools}: {})}]]),cwd:'/owned',workerExecutionConstraints:{protectedAreaAuthorization:{needed:[],grants:[],paths:['native.cpp']}}});
 for(const tools of [undefined,['bash'],['read','write'],['custom-tool']])assert.throws(()=>sandbox.gate('worker',options(tools)),/permission/i,name+' refuses mutating/unknown profile before any launch');
 assert.throws(()=>sandbox.gate('worker',{...options(undefined),recoverableRole:'planner',phaseMutates:false}),/permission/i,name+' semantic label alone never bypasses grant checks');
 assert.doesNotThrow(()=>sandbox.gate('worker',{...options(undefined),readOnly:true}),name+' enforced read-only capabilities may inspect');
 assert.doesNotThrow(()=>sandbox.gate('worker',options(['read','grep','find','ls'])),name+' exact read-only profile may inspect');
}
// Context-bound shapes must not lose admission authority on their way to the
// substrate. Copy/freeze grants rather than retaining a mutable caller object.
let frozenConstraints;
const constraintsContext=vm.createContext({Object,JSON,workerExecutionConstraintContext:{run:(value,operation)=>{frozenConstraints=value;return operation();}}});
const constraintFns=['withWorkerExecutionConstraints','deepFreezeValue'].map(name=>substrateAst.statements.find(n=>n.name?.text===name).getText(substrateAst).replace(/^export\s+/,'')).join('\n');
vm.runInContext(ts.transpileModule(constraintFns+'\nglobalThis.bind=withWorkerExecutionConstraints;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,constraintsContext);
const auth={needed:[],grants:[],paths:['generated/native.cpp']};constraintsContext.bind({noForceKill:true,protectedAreaAuthorization:auth},()=>{});
assert.equal(JSON.stringify(frozenConstraints.protectedAreaAuthorization),JSON.stringify(auth),'context-bound authorization must survive to the launcher');
assert.ok(Object.isFrozen(frozenConstraints.protectedAreaAuthorization.paths),'nested authorization is immutable');auth.grants.push('native-code');assert.equal(frozenConstraints.protectedAreaAuthorization.grants.length,0,'later caller grants cannot widen admission');
console.log('PASS strict forecasts, no self-grants, checkpoint/fence refusal and consistent capability-based permission gates');
