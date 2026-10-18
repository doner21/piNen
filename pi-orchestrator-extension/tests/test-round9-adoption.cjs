#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=fs.realpathSync(path.resolve(__dirname,'..')),parent=fs.realpathSync(process.argv[2]||'');
assert.ok(parent&&path.isAbsolute(parent)&&!parent.startsWith(path.dirname(ROOT)), 'explicit external scratch parent');
for(let p=parent;;p=path.dirname(p)){assert.equal(fs.lstatSync(p).isSymbolicLink(),false);if(path.dirname(p)===p)break;}
const externalTemp=path.join(parent,'adoption-'+crypto.randomBytes(8).toString('hex'));
assert.ok(path.isAbsolute(externalTemp)&&!fs.existsSync(externalTemp));fs.mkdirSync(externalTemp);assert.equal(fs.realpathSync(externalTemp),externalTemp);
for(const [key,name]of Object.entries({PI_CODING_AGENT_DIR:'agent',PI_ORCHESTRATOR_RUNS_ROOT:'runs',PI_ORCHESTRATOR_NEXT_RUNS_ROOT:'next'})){process.env[key]=path.join(externalTemp,name);fs.mkdirSync(process.env[key]);}
process.env.JITI_FS_CACHE='0';
const jiti=require(path.join(ROOT,'node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs'))(__filename,{interopDefault:true,fsCache:false});
const s=jiti(path.join(ROOT,'src/supervision.ts')),w=jiti(path.join(ROOT,'src/write-set.ts'));
const host='800001:100000',newHost='800002:100001',dead=pid=>[800001,800004].includes(pid)?{status:'dead',evidence:'ESRCH'}:{status:'unknown',reason:'fixture refuses every other process'};
let serial=0;
function fixture(retired=false,withTree=true){
 const cwd=path.join(externalTemp,'candidate-'+(++serial));fs.mkdirSync(cwd);fs.writeFileSync(path.join(cwd,'product.txt'),'settled writer bytes');
 const routes=['planner','executor','verifier'].map(role=>({role,agentName:role,provider:'named',model:'fixed'}));
 const mission=s.createFrozenMission({originalTask:'Inspect settled work only',cwd,worktree:{root:cwd,realRoot:cwd,branch:null,baseline:null},paradigm:'plan-execute-verify',lane:'product',routes,constraints:[],nonGoals:[],acceptanceCriteria:[{id:'AC-01',text:'Review settled work',required:true}]});
 const task={id:'task-1',description:'settled writer',dependsOn:[],criteria:['AC-01'],predictedWriteSet:['product.txt']};
 const identity={protocolId:s.HOST_TASK_BOUNDARY_PROTOCOL_ID,adapterId:s.PEV_SHAPE_ADAPTER_ID,adapterVersion:1};
 let state=s.createInitialSupervisionState({runId:'adopt-'+serial,mission,tasks:[task]});
 const inventory={schemaVersion:1,rootPid:800004,rootBorn:new Date(100000).toISOString(),observedAt:new Date().toISOString(),members:[{pid:800004,parentPid:800001,born:new Date(100000).toISOString()}],status:'clean',survivors:[],unknown:[]};
 const output={taskId:'task-1',output:'completed',exitCode:0,...(withTree?{processTree:inventory}:{})};
 state.runtime=s.createGenericSupervisionRuntime({identity,cursor:s.createGenericSupervisionCursor(identity,{stage:'verifier',nextTaskIndex:1,completedTaskIds:['task-1']}),params:Object.fromEntries(routes.flatMap(r=>[[r.role+'Agent',r.agentName],[r.role+'Provider',r.provider],[r.role+'Model',r.model]])),intake:{},plan:{tasks:[task],notes:'intact',protectedAreasNeeded:[]},completedTaskIds:['task-1'],executorOutputs:[output],contentBaseline:w.captureContentSignatureSnapshot(cwd),repairCount:0,hostInstanceId:host});
 const store=new s.SupervisionStateStore(state.runId);store.create(state);
 state=store.appendCheckpoint(state,{kind:'plan',createdAt:new Date().toISOString(),missionHash:mission.missionHash,criteria:['AC-01'],effectChanges:[],outcome:'plan_ready'},{plan:state.runtime.plan});
 state=store.appendCheckpoint(state,{kind:'executor',createdAt:new Date().toISOString(),missionHash:mission.missionHash,taskId:'task-1',criteria:['AC-01'],effectChanges:[],outcome:'settled'},{output});
 state.status='paused';state.pauseReason=s.deadOwningHostPauseReason(host,dead);store.save(state);
 fs.writeFileSync(path.join(store.runDir,'state.json'),JSON.stringify({runId:state.runId,phases:withTree?[{index:0,name:'writer',status:'done'}]:[]}));
 if(withTree){
  inventory.launchId='fixture-launch';inventory.phaseId=path.join(store.runDir,'phase-0-writer.result.json');
  inventory.settledMembers=[{member:{...inventory.members[0]},launchId:inventory.launchId,phaseId:inventory.phaseId,observedAt:inventory.observedAt,source:'native_close'}];
  // Publish identical original bindings in every retained output/checkpoint.
  state.runtime.executorOutputs[0].processTree=inventory;store.save(state);
  const checkpointFile=path.join(store.runDir,'checkpoint-0002-executor.json'),envelope=JSON.parse(fs.readFileSync(checkpointFile));envelope.payload.output.processTree=inventory;fs.writeFileSync(checkpointFile,JSON.stringify(envelope));
  fs.writeFileSync(inventory.phaseId,JSON.stringify({kind:'subagent-phase-result',launchId:inventory.launchId,status:'complete',pid:800004,startedAt:new Date(100000).toISOString(),processTree:inventory,result:output}));
 }
 if(retired){const r=store.retirePausedIfSafe({observeProcess:dead});assert.equal(r.retired,true);state=r.state;}
 return {store,state,cwd};
}
try{
 for(const retired of [false,true]){
  const f=fixture(retired),before=fs.readFileSync(f.store.stateFile),bytes=fs.readFileSync(path.join(f.cwd,'product.txt'));
  for(const observation of [{status:'dead',evidence:'ESRCH'},{status:'alive',startedAt:100000},{status:'alive',startedAt:900000},{status:'unknown',reason:'EPERM'},{status:'dead',evidence:'uncertain'}]){
   const options={observeProcess:()=>observation,hostInstanceId:newHost};
   assert.throws(()=>f.store.adoptDeadHost(newHost,options),/deferred to round10/);
   assert.ok(!s.buildInspectionSnapshot(f.state,options).allowedNextActions.includes('adopt'));
   assert.throws(()=>f.store.issueCheckpointApproval(f.state,newHost,options),/LIFECYCLE_REFUSED/);
   assert.deepEqual(fs.readFileSync(f.store.stateFile),before);assert.deepEqual(fs.readFileSync(path.join(f.cwd,'product.txt')),bytes);
  }
 }
 for(const mode of ['same-owner','foreign','changed-owner','changed-evidence']){
  const f=fixture(),options={observeProcess:dead};
  if(mode==='foreign'){assert.throws(()=>f.store.issueCheckpointApproval(f.state,newHost,options),/foreign/);continue;}
  f.state.status='awaiting_supervisor';f.state.currentTaskId=undefined;
  f.state=f.store.appendCheckpoint(f.state,{kind:'verifier',createdAt:new Date().toISOString(),missionHash:f.state.mission.missionHash,criteria:['AC-01'],effectChanges:[],outcome:'routing_advisory'},{verifierResult:{status:'pass'}});
  const issued=f.store.issueCheckpointApproval(f.state,host,options),before=fs.readFileSync(f.store.stateFile);
  if(mode.startsWith('changed-')){const open=fs.openSync,phase=path.join(f.store.runDir,'phase-0-writer.result.json'),originalPhase=fs.readFileSync(phase);fs.openSync=function(file,...args){if(String(file)===f.store.stateFile+'.approval.lock'){if(mode==='changed-owner'){const v=JSON.parse(before);v.runtime.hostInstanceId=newHost;fs.writeFileSync(f.store.stateFile,JSON.stringify(v));}else{const v=JSON.parse(originalPhase);v.heartbeatSequence=99;fs.writeFileSync(phase,JSON.stringify(v));}}return open.call(this,file,...args);};try{assert.throws(()=>f.store.acceptWithReason(issued.token,'bounded owner disposition',host,new Date(),options),/LIFECYCLE_REFUSED/);}finally{fs.openSync=open;fs.writeFileSync(f.store.stateFile,before);fs.writeFileSync(phase,originalPhase);}assert.equal(fs.existsSync(f.store.stateFile+'.approval.lock'),false);}
  else{const accepted=f.store.acceptWithReason(issued.token,'bounded owner disposition',host,new Date(),options);assert.equal(accepted.terminalOutcome,'accepted_with_reason');assert.throws(()=>f.store.acceptWithReason(issued.token,'again',host,new Date(),options));}
 }
 for(const fault of ['missing','unknown','survivor','unproven-reuse']){
  const f=fixture(false,fault!=='missing'),sidecar=path.join(f.store.runDir,'phase-0-writer.result.json');
  if(fault!=='missing'){const r=JSON.parse(fs.readFileSync(sidecar));if(fault==='unknown')r.processTree.unknown.push('historical_inventory_gap');if(fault==='unproven-reuse')delete r.processTree.settledMembers;fs.writeFileSync(sidecar,JSON.stringify(r));}
  const obs=pid=>pid===800004&&['survivor','unproven-reuse'].includes(fault)?{status:'alive',startedAt:fault==='survivor'?100000:900000}:dead(pid);
  assert.equal(s.assessPausedRunRetirement(f.state,f.store.runDir,obs).eligible,false,fault+' cannot retire');
  assert.throws(()=>f.store.issueCheckpointApproval(f.state,host,{observeProcess:obs}),/LIFECYCLE_REFUSED/);
 }
 const cleanup=fixture(),generations=jiti(path.join(ROOT,'src/process-generation.ts'));
 cleanup.state.status='blocked_infrastructure';cleanup.state.currentTaskId='task-1';cleanup.state.audit.infrastructureFailures.push(s.classifyInfrastructureFailure(new generations.RetryCleanupError()));cleanup.store.save(cleanup.state);
 assert.equal(cleanup.state.audit.infrastructureFailures.at(-1).code,'retry_cleanup','typed cleanup is infrastructure, never ordinary repair or invented zero-tool auth');
 const held=fs.readFileSync(path.join(cleanup.cwd,'product.txt'));
 for(const observation of [{status:'unknown'},{status:'alive',startedAt:100000,birthIdentity:new Date(100000).toISOString()}])assert.throws(()=>cleanup.store.issueCheckpointApproval(cleanup.state,host,{observeProcess:()=>observation}),/LIFECYCLE_REFUSED/);
 assert.throws(()=>cleanup.store.issueCheckpointApproval(cleanup.state,newHost,{observeProcess:dead}),/foreign/);
 assert.ok(s.buildInspectionSnapshot(cleanup.state,{hostInstanceId:host,observeProcess:dead}).allowedNextActions.includes('continue'),'same-owner cleanup-blocked retry remains eligible only after independent cleanup');
 const issuedCleanup=cleanup.store.issueCheckpointApproval(cleanup.state,host,{observeProcess:dead});
 const expectedCleanup={runId:cleanup.state.runId,missionHash:cleanup.state.mission.missionHash,checkpointId:cleanup.state.checkpoints.at(-1).id,action:'continue'};
 cleanup.store.consumeApprovalForDispatch(issuedCleanup.token,expectedCleanup,new Date(),host,{observeProcess:dead});assert.throws(()=>cleanup.store.consumeApprovalForDispatch(issuedCleanup.token,expectedCleanup,new Date(),host,{observeProcess:dead}));assert.deepEqual(fs.readFileSync(path.join(cleanup.cwd,'product.txt')),held,'approval never replays the settled writer');
 console.log('PASS typed cleanup pending retry: same-owner locked approval, unknown/live/foreign refusal and preserved writer');
 const raced=fixture(),lock=raced.store.stateFile+'.approval.lock';fs.writeFileSync(lock,'other consumer');
 assert.throws(()=>raced.store.adoptDeadHost(newHost,{observeProcess:dead}),/deferred to round10/);assert.equal(fs.readFileSync(lock,'utf8'),'other consumer');
 assert.throws(()=>raced.store.consumeApprovalForDispatch('not-authority',{runId:raced.state.runId,missionHash:raced.state.mission.missionHash,checkpointId:'checkpoint-0002',action:'continue'}),/already being consumed/);assert.equal(fs.existsSync(lock),true);
 console.log('PASS deferred takeover/no authority, foreign refusal, conservative retirement, same-owner acceptance/fences and no replay');
}finally{fs.rmSync(externalTemp,{recursive:true,force:true});}
