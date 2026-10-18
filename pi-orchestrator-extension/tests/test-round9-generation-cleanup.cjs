// Independent post-command reconciliation. Does not confer cleanup from root exit alone.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const {assertExpectedCommands,assertExpectedCoverage,expectedCommand,findCommandProof}=require('./fixtures/round9-command-proof.cjs');
if(process.argv.includes('--exercise-failures')) {
 process.exitCode=1; // An unresolved fixture promise is never a successful check.
 exerciseFailures().then(()=>{process.exitCode=0;}).catch(error=>{console.error('CLEANUP_FAILURE_PATH_CHECK_FAILED '+error.name+' '+String(error.message).split('\n')[0]+' '+String(error.stack).split('\n').find(line=>/^\s+at /.test(line)));});
}else {
const issues=[];
const attempt=(kind,label,body)=>{try{return body();}catch{issues.push({kind,label});}};
const outside=process.argv.includes('--outside');
const scratch=fs.realpathSync(process.argv[2]),prepared=JSON.parse(fs.readFileSync(path.join(scratch,'prepared.json'))),copy=path.join(scratch,'copy');
const files=['pi-orchestrator-extension/src/process-inventory.cjs','pi-orchestrator-extension/src/process-generation.ts','pi-orchestrator-extension/src/live-status.ts','pi-orchestrator-extension/src/substrate.ts','pi-orchestrator-extension/src/index.ts','pi-orchestrator-extension/src/supervision.ts','pi-orchestrator-extension/src/shapes/plan-execute-verify.ts','agent/skills/headless-orchestration/scripts/launch.mjs','agent/skills/headless-orchestration/scripts/orchestrate-host.mjs','pi-orchestrator-extension/tests/test-round9-sdk-generations.cjs','pi-orchestrator-extension/tests/test-round9-adoption.cjs','pi-orchestrator-extension/tests/test-round9-process-generations.cjs','pi-orchestrator-extension/tests/test-round9-generation-cleanup.cjs','pi-orchestrator-extension/tests/fixtures/round9-tree-worker.cjs','pi-orchestrator-extension/tests/fixtures/round9-owned-window.ps1'];
for(const file of files)attempt('qualification','source_equality',()=>assert.ok(fs.readFileSync(path.join(prepared.candidate,file)).equals(fs.readFileSync(path.join(copy,file)))));
const pids=new Set(),completed=new Set(),completedAt=new Map(),known=new Map(),priorAbsence=new Set(),absentPidAt=new Map(),proofs=[];
let proofTime=0;
const generationKey=(pid,born)=>`${pid}:${born??'unknown'}`;
// Native-wait completion bounds later births; file mtime is only a
// conservative fallback. Neither elapsed time nor PID reuse alone is proof.
function retain(record,waited=false){assert.ok(record,'missing expected generation identity retained as UNKNOWN');const pid=record.pid,born=record.born??record.identity?.born??null;assert.ok(Number.isSafeInteger(pid)&&pid>0,'expected process identity malformed');assert.ok(typeof born==='string'&&Number.isFinite(Date.parse(born))||waited&&Number.isFinite(Date.parse(record.completedAt??'')),'generation identity missing without native completion');if(Number.isSafeInteger(pid)&&pid>0){pids.add(pid);if(!known.has(pid))known.set(pid,new Set());known.get(pid).add(born);if(waited){const k=generationKey(pid,born);completed.add(k);const nativeEnd=Date.parse(record.completedAt??'');const at=Number.isFinite(nativeEnd)&&nativeEnd>=Date.parse(born??'')&&nativeEnd<=proofTime?nativeEnd:proofTime;if(at)completedAt.set(k,born===null?Math.max(completedAt.get(k)??0,at):Math.min(completedAt.get(k)??Infinity,at));}}
 const descendants=record.descendants??[],admitted=new Set([pid]),rows=[{pid,born},...descendants];let added=true;
 while(added){added=false;for(const child of descendants){const parent=rows.find(row=>row.pid===child.parentPid);if(parent&&admitted.has(parent.pid)&&Date.parse(child.born)>=Date.parse(parent.born)&&!admitted.has(child.pid)){admitted.add(child.pid);added=true;}}}
 for(const child of descendants)if(admitted.has(child.pid))retain(child);
 if(record.identity)retain(record.identity,waited);}
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,e.name);if(e.isDirectory())walk(full);else if(['process-proof.json','cleanup-observed.json','sdk-forecast-process-proof.json'].includes(e.name)){
 attempt('unknown','process_proof_malformed_or_incomplete',()=>{
 const proof=JSON.parse(fs.readFileSync(full));
 if(e.name==='sdk-forecast-process-proof.json'){
  const normalize=g=>g?{pid:g.pid??g.ProcessId,parentPid:g.parentPid??g.ParentProcessId,born:g.born??g.created}:undefined;
  const command=r=>({...r,code:r.code??r.status,identity:normalize(r.identity),descendants:(r.descendants??[]).map(normalize)});
  proof.testIdentity=normalize(proof.testIdentity);proof.wrapperIdentity=normalize(proof.wrapperIdentity);
  proof.hostProof=[{children:proof.children.map(command),syncCommands:proof.syncCommands.map(command),observers:proof.observers.map(command)}];
  proof.observers=proof.observers.map(command);
  proof.independentlyAbsentGenerations=proof.independentlyAbsentGenerations??[]; // no PID-only inferred absence
 }
 proofTime=fs.statSync(full).mtimeMs;proofs.push(full);retain(proof.testIdentity);retain(proof.wrapperIdentity);
 for(const g of proof.independentlyAbsentGenerations??[]){
  priorAbsence.add(generationKey(g.pid,g.born));const at=Date.parse(g.at??proof.observers?.at(-1)?.identity?.born??'');
  if(Number.isFinite(at)&&Date.parse(g.born)<=at)absentPidAt.set(g.pid,Math.max(absentPidAt.get(g.pid)??0,at));
 }for(const f of proof.fixtures??[])retain(f);for(const h of proof.hosts??[])retain(h,true);
 for(const h of proof.hostProof??[]){assert.ok(!h.cleanupError,'nested reconciliation unresolved');assertExpectedCommands([...h.children,...h.syncCommands,...h.observers]);for(const r of [...h.children,...h.syncCommands,...h.observers])retain(r,r.pid!==proof.testIdentity?.pid&&r.signal===null&&Number.isInteger(r.code));}assertExpectedCommands(proof.observers??[]);for(const r of proof.observers??[])retain(r,r.signal===null&&r.code===0);
 if(Array.isArray(proof.currentRecorded)){
  const own=[...(proof.fixtures??[]),...(proof.hosts??[]),...(proof.hostProof??[]).flatMap(p=>[...p.children,...p.syncCommands,...p.observers].flatMap(r=>[r.identity,...(r.descendants??[])]))].filter(Boolean);
  for(const g of own)if(!proof.currentRecorded.some(row=>row.pid===g.pid)){
   priorAbsence.add(generationKey(g.pid,g.born));
   const at=Date.parse(proof.observers?.at(-1)?.identity?.born??'');if(Number.isFinite(at))absentPidAt.set(g.pid,Math.max(absentPidAt.get(g.pid)??0,at));
  }
 }
 });
 }else if(/^phase-.*\.result\.json$/.test(e.name)){
 const phase=path.relative(scratch,full);
 attempt('unknown','phase_inventory_missing_or_malformed:'+phase,()=>{const r=JSON.parse(fs.readFileSync(full));const trees=r.processTrees??[r.processTree];if(r.kind==='subagent-phase-result'&&r.status==='incomplete'&&r.settlement==='never_dispatched'&&r.eventCount===0&&r.pid===undefined&&r.processTree===undefined&&r.processTrees===undefined)return;assert.ok(Array.isArray(trees)&&trees.length);for(const [index,tree] of trees.entries()){assert.ok(tree?.rootBorn&&tree.members?.length&&Array.isArray(tree.unknown));for(const g of tree.members)retain(g);
 if(tree.launchId===r.launchId&&typeof r.launchId==='string'&&tree.phaseId===full)for(const s of tree.settledMembers??[]){
  const g=tree.members.find(g=>g.pid===s.member?.pid&&g.born===s.member.born&&g.parentPid===s.member.parentPid),at=Date.parse(s.observedAt);
  if(g&&s.launchId===r.launchId&&s.phaseId===full&&['kernel_absence','native_close'].includes(s.source)
    &&(s.source!=='native_close'||g.pid===tree.rootPid&&g.born===tree.rootBorn)
    &&Number.isFinite(at)&&at>=Date.parse(g.born)&&at<=Date.parse(tree.observedAt))priorAbsence.add(generationKey(g.pid,g.born));
 }
 if(tree.unknown.length)issues.push({kind:'unknown',label:'phase_inventory_present_unknown',phase,tree:index,rootPid:tree.rootPid,rootBorn:tree.rootBorn,reasons:tree.unknown});}});
 }}}
const manifestFile=path.join(scratch,'aggregate','expected-commands.json');
const manifest=fs.existsSync(manifestFile)?attempt('qualification','manifest_malformed',()=>JSON.parse(fs.readFileSync(manifestFile))):undefined;
let runRoot=manifest?.runRoot??path.join(scratch,'runs');
if(!path.relative(scratch,runRoot)||path.relative(scratch,runRoot).startsWith('..')||path.isAbsolute(path.relative(scratch,runRoot))){issues.push({kind:'unknown',label:'unowned_manifest_root'});runRoot=path.join(scratch,'runs');}
attempt('unknown','run_inventory_unavailable',()=>walk(runRoot));
// The outside reconciliation also re-observes retained helpers from focused
// checks in this same owned scratch, not just the final aggregate's subtree.
if(outside&&!manifest)issues.push({kind:'qualification',label:'aggregate_manifest_missing'});
if(outside&&manifest)for(const name of fs.readdirSync(path.join(scratch,'runs'))){const dir=path.join(scratch,'runs',name);if(path.resolve(dir)!==path.resolve(runRoot)&&fs.lstatSync(dir).isDirectory())attempt('unknown','focused_inventory_unavailable',()=>walk(dir));}
let selectedEnvironments,qualificationFailure,coverage;
if(manifest){try{
 coverage=JSON.parse(fs.readFileSync(path.join(scratch,'aggregate','command-coverage.json')));
 selectedEnvironments=new Set([manifest.aggregateEnvironment,process.env.ROUND9_OWNED_RUNTIME,...coverage.map(c=>c.environment)].map(p=>path.resolve(p)));
 const expected=outside?manifest.commands:manifest.commands.filter(c=>c.name!=='independent-generation-cleanup');
 assertExpectedCoverage(expected,coverage);
 for(const command of expected.filter(c=>c.requiresProof)){
  const proof=coverage.find(r=>r.name===command.name);
  assert.ok(proof.proofs.some(file=>{const relative=path.relative(runRoot,file);return relative&&!relative.startsWith('..')&&!path.isAbsolute(relative);}), 'SDK expected command requires its worker proof, not merely a preload proof');
 }
 if(outside){const results=JSON.parse(fs.readFileSync(path.join(scratch,'aggregate','results.json')));assert.equal(results.results.length,manifest.commands.length,'every expected aggregate command completed');assert.ok(results.results.every(r=>r.code===0&&r.signal===null),'aggregate product verdict remains honest');}
}catch(error){qualificationFailure=error;issues.push({kind:'qualification',label:'aggregate_qualification_failed'});}}
// Failed qualification must not suppress the separate OS cleanup observation.
// It is rethrown after observation, never converted into a product PASS.
const visited=new Set();
function commandProofs(base){const dir=path.join(base,'command-proofs');if(fs.existsSync(dir)&&!visited.has(dir)){visited.add(dir);attempt('unknown','command_proof_unavailable',()=>walk(dir));}}
const statuses=[],pending=[];
// Wrapper environments are siblings under coordinator/tests, not necessarily
// siblings of this nested owned scratch. Use the already retained exact paths.
const environmentParent=path.dirname(process.env.ROUND9_OWNED_RUNTIME);
// Include focused commands in this same owned scratch as well as manifest
// commands. Each start record is containment-checked below; no PID/name waiver.
const environmentDirs=[...new Set([...(selectedEnvironments??[]),...fs.readdirSync(environmentParent).filter(n=>n.startsWith('environment-')).map(n=>path.join(environmentParent,n))])];
for(const dir of environmentDirs){attempt('unknown','environment_evidence_unavailable',()=>{const start=path.join(dir,'started.public.json');if(selectedEnvironments?.has(path.resolve(dir)))assert.ok(fs.existsSync(start),'expected wrapper start evidence missing');if(!fs.existsSync(start))return;const started=JSON.parse(fs.readFileSync(start)),rel=path.relative(scratch,started.cwd);if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)||started.pid===process.pid)return;
 commandProofs(dir);
 const checkerProof=path.join(dir,'cleanup-observed.json');if(fs.existsSync(checkerProof))walk(dir);
 const finished=path.join(dir,'settled.public.json');
 if(!fs.existsSync(finished)){pending.push(started.pid);return;}
 const settled=JSON.parse(fs.readFileSync(finished));proofTime=Date.parse(settled.at);assert.equal(settled.signal,null);
 const command=coverage?.find(c=>path.resolve(c.environment)===path.resolve(dir));
 let identity=command&&findCommandProof(path.join(dir,'command-proofs'),{pid:started.pid,expectedCommand:command.expectedCommand})?.identity;
 if(!identity&&manifest&&path.resolve(dir)===path.resolve(manifest.aggregateEnvironment)){
  const file=path.join(runRoot,'process-proof.json');if(fs.existsSync(file)){const own=JSON.parse(fs.readFileSync(file)).testIdentity;if(own?.pid===started.pid)identity=own;}
 }
 // Public settlement is the wrapper's native wait. A process writing its own
 // beforeExit proof is NOT evidence that it has already ended.
 retain({...identity,pid:started.pid,completedAt:settled.at},true);statuses.push({pid:started.pid,code:settled.code});
 // A successful window-only proving run also inventories its own console helper.
 const windowFile=path.join(dir,'window-proof.json');if(fs.existsSync(windowFile)){const w=JSON.parse(fs.readFileSync(windowFile));const root=w.generations?.[0];assertExpectedCommands([{pid:root?.pid,identity:root,expectedCommand:w.expectedCommand,code:settled.code,signal:settled.signal}]);assertExpectedCommands(w.observers??[]);for(const g of w.generations??[]){retain(g);if(settled.code===0){priorAbsence.add(generationKey(g.pid,g.born));const at=Date.parse(w.observers?.at(-1)?.identity?.born??'');if(Number.isFinite(at)&&Date.parse(g.born)<=at)absentPidAt.set(g.pid,Math.max(absentPidAt.get(g.pid)??0,at));}}for(const r of w.observers??[])retain(r,r.code===0&&r.signal===null);}
});}
if(!proofs.length)issues.push({kind:'unknown',label:'process_proofs_missing'});
const label=path.basename(scratch).replace(/'/g,"''");
const command=`$r=@(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -gt 0} | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='parentPid';e={[int]$_.ParentProcessId}},@{n='born';e={$_.CreationDate.ToUniversalTime().ToString('o')}},@{n='labelled';e={$_.CommandLine -like '*${label}*'}},Name); ConvertTo-Json -Compress -InputObject $r`;
const observerArgs=['-NoProfile','-NonInteractive','-Command',command];
const observed=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',observerArgs,{encoding:'utf8',windowsHide:true});const observedCompletedAt=new Date().toISOString();let rows=[],observationStatus='unknown';attempt('unknown','outside_os_inventory_failed',()=>{assert.equal(observed.status,0);assert.equal(observed.signal,null);rows=JSON.parse(observed.stdout);assert.ok(Array.isArray(rows)&&rows.some(r=>r.pid===process.pid));observationStatus='observed';});
const self=rows.find(r=>r.pid===process.pid)??{pid:process.pid,parentPid:process.ppid},allowed=new Set([process.pid,self.parentPid,observed.pid]);
// Only this check's current ancestry/observer generation may remain labelled.
let ancestor=self;for(let n=0;n<rows.length;n++){const parent=rows.find(r=>r.pid===ancestor.parentPid);if(!parent||Date.parse(parent.born)<fs.statSync(scratch).birthtimeMs)break;allowed.add(parent.pid);ancestor=parent;}
// Console helpers of the still-running check/aggregate ancestry are current
// infrastructure, not settled fixtures. The outer reviewer reconciles these
// after the aggregate returns. Never exempt arbitrary ancestry descendants.
for(const row of rows)if(row.Name==='conhost.exe'&&allowed.has(row.parentPid)){
 const parent=rows.find(p=>p.pid===row.parentPid);
 if(parent&&Date.parse(row.born)>=Date.parse(parent.born))allowed.add(row.pid);
}
// Only the current check's observers, not every child of its aggregate
// ancestor, are exempt. Otherwise an active aggregate could hide a leftover.
const observerIds=new Set([observed.pid]);
for(let n=0;n<rows.length;n++){const size=observerIds.size;for(const row of rows)if(observerIds.has(row.parentPid))observerIds.add(row.pid);if(size===observerIds.size)break;}
for(const pid of observerIds)allowed.add(pid);
for(const pid of pending)if(!allowed.has(pid))issues.push({kind:'survivor',label:'unfinished_command',pid});
const reused=[];
for(const row of rows)if(pids.has(row.pid)&&!allowed.has(row.pid)){
 // A waited OS handle is independent evidence of the OLD root's completion;
 // reuse alone, or a reused helper with no such evidence, never proves cleanup.
 const generations=[...(known.get(row.pid)??[])];
 const independentlyEnded=generations.every(born=>{
  if(born===row.born)return false;
  return completed.has(generationKey(row.pid,born))||priorAbsence.has(generationKey(row.pid,born))||(born!==null&&Date.parse(born)<=(absentPidAt.get(row.pid)??0));
 });
 if(independentlyEnded){reused.push(row.pid);continue;}
 issues.push({kind:'survivor',label:'recorded_generation_or_unproven_reuse',pid:row.pid});
}
const scratchBirth=fs.statSync(scratch).birthtimeMs;
const unaccounted=rows.filter(row=>{
 if(allowed.has(row.pid)||!pids.has(row.parentPid)||Date.parse(row.born)<scratchBirth)return false;
 const parent=rows.find(p=>p.pid===row.parentPid);
 if(parent&&reused.includes(parent.pid)&&Date.parse(row.born)>=Date.parse(parent.born))return false; // current, not old parent generation
 const births=[...(known.get(row.parentPid)??[])];
 // A child born AFTER every recorded parent generation independently returned
 // cannot belong to those old generations, even when its new parent is gone.
 if(births.length&&births.every(born=>(completedAt.get(generationKey(row.parentPid,born))??Infinity)<Date.parse(row.born)))return false;
 const absentAt=absentPidAt.get(row.parentPid);
 if(absentAt!==undefined&&absentAt<Date.parse(row.born)&&births.length&&births.every(born=>born!==null&&Date.parse(born)<=absentAt))return false;
 if(births.length&&births.every(born=>born!==null&&Date.parse(row.born)<Date.parse(born)))return false; // predates every recorded test parent
 return true;
});
fs.writeFileSync(path.join(process.env.ROUND9_OWNED_RUNTIME,'generation-blockers.json'),JSON.stringify(unaccounted.map(row=>({row,currentParent:rows.find(p=>p.pid===row.parentPid),recordedParentBirths:[...(known.get(row.parentPid)??[])],independentlyAbsentAt:absentPidAt.get(row.parentPid),waitedParentGenerations:[...completed].filter(k=>k.startsWith(row.parentPid+':'))})),null,2));
if(unaccounted.length)issues.push({kind:'survivor',label:'unaccounted_descendants',pids:unaccounted.map(r=>r.pid)});
if(rows.some(row=>row.labelled&&!allowed.has(row.pid)))issues.push({kind:'survivor',label:'labelled_fixture_window_or_helper'});
const proof={at:new Date().toISOString(),qualification:issues.some(i=>i.kind==='qualification')?'failed':'passed',cleanup:issues.some(i=>i.kind==='survivor')?'survivors':issues.some(i=>i.kind==='unknown')?'unknown':'clean',issues,observation:{status:observationStatus,rows},checkedPids:[...pids],proofs,statuses,reusedCompletedRoots:reused,self,wrapper:rows.find(r=>r.pid===self.parentPid),observer:{pid:observed.pid,expectedCommand:expectedCommand('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',observerArgs),code:observed.status,signal:observed.signal,completedAt:observedCompletedAt,identity:rows.find(r=>r.pid===observed.pid),descendants:rows.filter(r=>r.parentPid===observed.pid)}};
fs.writeFileSync(path.join(process.env.ROUND9_OWNED_RUNTIME,'generation-cleanup.json'),JSON.stringify(proof,null,2));
fs.writeFileSync(path.join(process.env.ROUND9_OWNED_RUNTIME,'cleanup-observed.json'),JSON.stringify({testIdentity:self,wrapperIdentity:proof.wrapper,hostProof:[],observers:[proof.observer]},null,2));
if(issues.length){console.error('CLEANUP_OBSERVATION_RETAINED; qualification or cleanup failed, not PASS');process.exitCode=1;}else
console.log('PASS current-source equality and independent cleanup of '+pids.size+' recorded test/worker/window/helper/observer generations; reused PIDs are not absence evidence');

}

async function exerciseFailures(){
 const cp=require('node:child_process'),crypto=require('node:crypto'),ROOT=path.resolve(__dirname,'..'),parent=fs.realpathSync(process.argv[2]);
 const wrapper='C:/Users/you/pi-headless-runs/round9-final-task-bfe0e1c9-be36-4ac1-870e-bb14bd87234a/repair-after-review/coordinator/test-command.mjs';
 const preload=path.join(__dirname,'fixtures/round9-command-preload.cjs');
 const source=fs.readFileSync(__filename,'utf8'),files=require('node:vm').runInNewContext(source.match(/const files=(\[[^;]+\]);/)[1]);
 let owned=parent;while(!fs.existsSync(path.join(owned,'prepared.json'))){assert.notEqual(owned,path.dirname(owned));owned=path.dirname(owned);}
 const base=path.join(owned,'cf-'+crypto.randomBytes(4).toString('hex'));fs.mkdirSync(base);
 for(const fault of ['source-mismatch','malformed-proof','malformed-proof-shape','missing-inventory','ambiguous-never-dispatched','present-unknown','command-failure','survivor']){
  const scratch=path.join(base,'c-'+crypto.randomBytes(4).toString('hex'));fs.mkdirSync(scratch);fs.mkdirSync(path.join(scratch,'runs'));fs.mkdirSync(path.join(scratch,'copy'));
  for(const relative of files){const dest=path.join(scratch,'copy',relative);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(path.dirname(ROOT),relative),dest);}
  fs.writeFileSync(path.join(scratch,'prepared.json'),JSON.stringify({candidate:path.dirname(ROOT)}));
  if(fault==='source-mismatch')fs.appendFileSync(path.join(scratch,'copy',files[0]),'\n// mismatch fixture\n');
  let helper,helperClosed;
  try{
   if(fault==='survivor'){helper=cp.spawn(process.execPath,['--require',preload,'-e',"process.on('message',()=>process.disconnect());process.send({ready:true});",scratch],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});helperClosed=new Promise(resolve=>helper.once('close',(code,signal)=>resolve({code,signal})));await new Promise((resolve,reject)=>{helper.once('message',resolve);helper.once('error',reject);helper.once('close',()=>reject(Error('owned helper ended before readiness')));});}
   const observed=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-Command',"$r=@(Get-CimInstance Win32_Process | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='parentPid';e={[int]$_.ParentProcessId}},@{n='born';e={$_.CreationDate.ToUniversalTime().ToString('o')}}); ConvertTo-Json -Compress -InputObject $r"],{encoding:'utf8',windowsHide:true});assert.equal(observed.status,0);const rows=JSON.parse(observed.stdout);
   const proof={testIdentity:rows.find(r=>r.pid===observed.pid),wrapperIdentity:rows.find(r=>r.pid===observed.pid),hostProof:[],fixtures:helper?[rows.find(r=>r.pid===helper.pid)]:[],observers:[]};
   fs.writeFileSync(path.join(scratch,'runs','process-proof.json'),fault==='malformed-proof'?'{':JSON.stringify(fault==='malformed-proof-shape'?{testIdentity:{},wrapperIdentity:{},hostProof:[],fixtures:[],observers:[]}:proof));
   if(fault==='missing-inventory')fs.writeFileSync(path.join(scratch,'runs','phase-fixture.result.json'),JSON.stringify({status:'complete'}));
   if(fault==='ambiguous-never-dispatched')fs.writeFileSync(path.join(scratch,'runs','phase-fixture.result.json'),JSON.stringify({kind:'subagent-phase-result',status:'incomplete',settlement:'never_dispatched',eventCount:1}));
   if(fault==='present-unknown')fs.writeFileSync(path.join(scratch,'runs','phase-fixture.result.json'),JSON.stringify({kind:'subagent-phase-result',status:'complete',processTree:{rootPid:proof.testIdentity.pid,rootBorn:proof.testIdentity.born,members:[proof.testIdentity],unknown:['fixture_unresolved_creator']}}));
   if(fault==='command-failure'){fs.mkdirSync(path.join(scratch,'aggregate'));fs.writeFileSync(path.join(scratch,'aggregate','expected-commands.json'),JSON.stringify({runRoot:path.join(scratch,'runs'),aggregateEnvironment:process.env.ROUND9_OWNED_RUNTIME,commands:[{name:'failed-command'}]}));fs.writeFileSync(path.join(scratch,'aggregate','command-coverage.json'),'[]');}
   if(fault==='source-mismatch'){
    for(const relative of ['tools/check-round9.cjs','tools/round9-runtime.cjs','tests/fixtures/round9-command-proof.cjs','src/streaming-redactor.cjs']){const dest=path.join(scratch,'copy/pi-orchestrator-extension',relative);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(ROOT,relative),dest);}
    const aggregate=cp.spawn(process.execPath,[wrapper,'--cwd',scratch,'--',process.execPath,'--require',preload,path.join(scratch,'copy/pi-orchestrator-extension/tools/check-round9.cjs'),scratch,path.dirname(ROOT),require('../tools/round9-runtime.cjs').frozen,'C:/Users/you/pi-headless-runs/round9-final-task-bfe0e1c9-be36-4ac1-870e-bb14bd87234a/repair-after-review/inputs'],{stdio:['ignore','pipe','pipe'],windowsHide:true});aggregate.stdout.resume();aggregate.stderr.resume();await new Promise(resolve=>aggregate.once('close',resolve));
    const result=JSON.parse(fs.readFileSync(path.join(scratch,'aggregate/results.json')));assert.equal(result.sourceEquality,false,'actual aggregate source failure is retained');const manifest=JSON.parse(fs.readFileSync(path.join(scratch,'aggregate/expected-commands.json')));assert.ok(fs.existsSync(path.join(manifest.runRoot,'process-proof.json')),'actual aggregate finally retains independent inventory despite source failure');
   }
   const child=cp.spawn(process.execPath,[wrapper,'--cwd',scratch,'--',process.execPath,'--require',preload,__filename,scratch,'--outside'],{stdio:['ignore','pipe','pipe'],windowsHide:true});let marker='',env;child.stdout.on('data',chunk=>{marker=(marker+chunk).slice(-4096);env??=marker.match(/TEST_ENVIRONMENT ([^\r\n]+)/)?.[1];});child.stderr.resume();const ended=await new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
   assert.equal(ended.signal,null);assert.ok(env);const file=path.join(env,'generation-cleanup.json');assert.ok(fs.existsSync(file),'every failure retains outside OS observations');const result=JSON.parse(fs.readFileSync(file));assert.ok(result.observation&&result.observation.status==='observed','outside OS inventory actually executed');assert.notEqual(JSON.parse(fs.readFileSync(path.join(env,'settled.public.json'))).code,0,'failure never becomes PASS');if(['malformed-proof','malformed-proof-shape','missing-inventory','ambiguous-never-dispatched'].includes(fault))assert.equal(result.cleanup,'unknown');if(fault==='present-unknown'){assert.equal(result.cleanup,'unknown');assert.ok(result.issues.some(i=>i.label==='phase_inventory_present_unknown'&&i.phase.endsWith('phase-fixture.result.json')&&i.reasons.includes('fixture_unresolved_creator')));assert.ok(!result.issues.some(i=>i.label.startsWith('phase_inventory_missing_or_malformed')));}if(fault==='survivor')assert.equal(result.cleanup,'survivors');console.log('PASS cleanup failure-total '+fault);
  }finally{if(helper){if(helper.connected)helper.send({close:true});const ended=await helperClosed;assert.equal(ended.signal,null);assert.equal(ended.code,0);}}
 }
}
