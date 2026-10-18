#!/usr/bin/env node
'use strict';
require("./round9-runtime.cjs");
// Only deliberately process-free tests use this preload. SDK/windows do NOT.
if(require.main!==module){
 const cp=require('node:child_process');for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=()=>{throw Error('PROCESS_FREE_CHECK_STARTED_HELPER');};
 require('node:module').syncBuiltinESMExports();
}else{
 const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),cp=require('node:child_process');
 const {WithheldOutputStream}=require('../src/streaming-redactor.cjs');
 const ROOT=fs.realpathSync(path.resolve(__dirname,'..'));
 const WRAPPER='C:/Users/you/pi-headless-runs/round9-final-task-bfe0e1c9-be36-4ac1-870e-bb14bd87234a/repair-after-review/coordinator/test-command.mjs';
 const PARENT=path.join(path.dirname(WRAPPER),'tests');
 const within=(a,b)=>{const r=path.relative(a,b);return !r||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
 function physical(p){assert.ok(p&&path.isAbsolute(p));for(let q=p;;q=path.dirname(q)){const s=fs.lstatSync(q,{bigint:true});assert.ok(!s.isSymbolicLink());if(s.isFile())assert.equal(s.nlink,1n);if(q===path.dirname(q))break;}assert.equal(fs.realpathSync.native(p),path.resolve(p));return path.resolve(p);}
 const {expectedCommand,assertExpectedCommands,findCommandProof,bindSync}=require('../tests/fixtures/round9-command-proof.cjs');
 const sync=bindSync(cp.spawnSync),observers=[];
 function inventory(){const r=sync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-Command',"$r=@(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -gt 0} | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='parentPid';e={[int]$_.ParentProcessId}},@{n='born';e={$_.CreationDate.ToUniversalTime().ToString('o')}}); ConvertTo-Json -Compress -InputObject $r"],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0);assert.equal(r.signal,null);const rows=JSON.parse(r.stdout);observers.push({pid:r.pid,expectedCommand:r.expectedCommand,code:r.status,signal:r.signal,completedAt:r.completedAt,identity:rows.find(p=>p.pid===r.pid),descendants:descendants(rows,r.pid)});return rows;}
 function descendants(rows,pid){const ids=new Set([pid]);for(let n=0;n<rows.length;n++){const old=ids.size;for(const row of rows){const parent=rows.find(p=>p.pid===row.parentPid);if(parent&&ids.has(parent.pid)&&Date.parse(row.born)>=Date.parse(parent.born))ids.add(row.pid);}if(old===ids.size)break;}return rows.filter(p=>p.pid!==pid&&ids.has(p.pid));}
 async function main(){
  assert.equal(process.argv.length,6,'usage: check-round9.cjs ownedScratch currentCandidate frozenRoot inputsRoot');
  const [scratch,candidate,frozen,inputs]=process.argv.slice(2).map(physical);
  assert.ok(within(physical(PARENT),scratch)&&scratch!==physical(PARENT));assert.equal(ROOT,path.join(scratch,'copy','pi-orchestrator-extension'));
  for(const p of [candidate,frozen,inputs])assert.ok(!within(p,scratch)&&!within(scratch,p),'disjoint scratch');
  assert.equal(JSON.parse(fs.readFileSync(path.join(scratch,'prepared.json'))).candidate,candidate);
  const logRoot=path.join(scratch,'aggregate');assert.ok(!fs.existsSync(logRoot),'one fresh aggregate');fs.mkdirSync(logRoot);
  const runs=path.join(physical(path.join(scratch,'runs')),'a-'+require('node:crypto').randomBytes(4).toString('hex'));fs.mkdirSync(runs);
  const preload=path.join(ROOT,'tests/fixtures/round9-command-preload.cjs');
  const commandArgs=command=>['--require',preload,...command.args];
  const sourceEquality=()=>{for(const relative of ['pi-orchestrator-extension/src','pi-orchestrator-extension/tests','pi-orchestrator-extension/tools','agent/skills/headless-orchestration','agent/extensions/agent-scheduler','agent/extensions/lib/pi-child-launch.ts','pi-orchestrator-extension/package.json','pi-orchestrator-extension/README.md']){
   const compare=(a,b)=>{physical(a);physical(b);if(fs.lstatSync(a).isDirectory()){const names=fs.readdirSync(a);assert.deepEqual(fs.readdirSync(b),names,'current source inventory');for(const n of names)compare(path.join(a,n),path.join(b,n));}else{assert.ok(fs.readFileSync(a).equals(fs.readFileSync(b)),'current source bytes');const x=fs.statSync(a,{bigint:true}),y=fs.statSync(b,{bigint:true});assert.ok(x.dev!==y.dev||x.ino!==y.ino);}};
   compare(path.join(candidate,relative),path.join(scratch,'copy',relative));}};
  const seam=(name,file,...args)=>({name,args:['--require',__filename,path.join(ROOT,file),...args]});
  const sdk=(name,file,...args)=>({name,args:[path.isAbsolute(file)?file:path.join(ROOT,file),...args]});
  const commands=[
   seam('prompt','tests/test-round9-prompt-recovery.cjs'),
   seam('role','tests/test-2026-10-06-round7-role-recovery.cjs'),
   seam('forecast','tests/test-round9-protected-forecast.cjs'),
   seam('lifecycle','tests/test-round9-lifecycle.cjs',runs),
   seam('generations','tests/test-round9-process-generations.cjs'),
   seam('sample-retention','tests/test-round9-sample-retention.cjs'),
   seam('takeover-deferred-and-ownership','tests/test-round9-adoption.cjs',runs),
   seam('infrastructure','tests/test-round9-infrastructure.cjs'),
   seam('retry-state','tests/test-round9-restored-retry.cjs'),
   seam('launch-retries','tests/test-round9-launch-retries.cjs'),
   seam('settlement','tests/test-2026-10-06-round7-worker-settlement.cjs'),
   sdk('missed-generation','tests/test-round9-missed-generation.cjs',runs),
   seam('aggregate-output','tests/test-round9-aggregate-output.cjs'),
   sdk('cleanup-failure-paths','tests/test-round9-generation-cleanup.cjs',runs,'--exercise-failures'),
   seam('redaction','tests/test-round9-redaction.cjs'),
   seam('headless-redaction','tests/test-round9-headless-redaction.cjs'),
   sdk('output-boundaries','tests/test-round9-output-boundaries.cjs',runs),
   seam('login','tests/test-round9-login.cjs'),
   seam('provisioning','tests/test-round9-provisioning.mjs',runs),
   seam('provider','tests/test-round9-provider-contract.mjs'),
   seam('wake','tests/test-round9-wake-successor.cjs'),
   seam('scheduler-contract','tests/test-round9-scheduler-contract.cjs'),
   seam('scheduler-delivery','tests/test-round9-scheduler-delivery.cjs'),
   sdk('sdk-forecast','tests/test-round9-sdk-forecast.cjs',runs),
   sdk('visible-window','tests/test-round9-sdk-generations.cjs','--window-proof'),
   sdk('window-before-connect','tests/test-round9-sdk-generations.cjs','--window-proof','before-connect'),
   sdk('window-before-ready','tests/test-round9-sdk-generations.cjs','--window-proof','before-ready'),
   sdk('window-observer-failure','tests/test-round9-sdk-generations.cjs','--window-proof','observer-failure'),
   sdk('sdk-generations','tests/test-round9-sdk-generations.cjs',runs),
   sdk('sdk-acceptance','tests/test-round9-sdk-generations.cjs',runs,'--acceptance'),
   sdk('sdk-retry','tests/test-round9-sdk-retry.cjs',runs),
   sdk('sdk-cli-provider','tests/test-round9-sdk-retry.cjs',runs,'--cli-provider'),
   sdk('sdk-bounded-repair','tests/test-round9-sdk-retry.cjs',runs,'--bounded-repair'),
   sdk('sdk-verifier-retry','tests/test-round9-sdk-retry.cjs',runs,'--verifier'),
   sdk('sdk-continue-mixed-policy','tests/test-round9-sdk-retry.cjs',runs,'--verifier','--mixed-policy'),
   sdk('sdk-verify-only-mixed-policy','tests/test-round9-sdk-retry.cjs',runs,'--verify-only','--mixed-policy'),
   sdk('sdk-verify-only-retry','tests/test-round9-sdk-retry.cjs',runs,'--verify-only'),
   sdk('sdk-cap','tests/test-round9-sdk-retry.cjs',runs,'--cap-three'),
   sdk('sdk-tree-cap','tests/test-round9-sdk-generations.cjs',runs,'--cap-three'),
   sdk('typecheck',path.join(require('./round9-runtime.cjs').modules,'typescript/bin/tsc'),'-p',path.join(scratch,'product-typecheck.json'),'--noEmit','--incremental','false'),
   sdk('scheduler-typecheck',path.join(require('./round9-runtime.cjs').modules,'typescript/bin/tsc'),'-p',path.join(scratch,'scheduler-typecheck.json'),'--noEmit','--incremental','false'),
   {name:'headless-launch-syntax',args:['--check',path.join(ROOT,'../agent/skills/headless-orchestration/scripts/launch.mjs')]},
   {name:'headless-host-syntax',args:['--check',path.join(ROOT,'../agent/skills/headless-orchestration/scripts/orchestrate-host.mjs')]},
  ];
  // Reconcile generations only AFTER this aggregate/its wrapper return. The
  // caller must run the existing cleanup checker with --outside, even on FAIL.
  fs.writeFileSync(path.join(logRoot,'expected-commands.json'),JSON.stringify({runRoot:runs,aggregateEnvironment:process.env.ROUND9_OWNED_RUNTIME,commands:commands.map(c=>({name:c.name,expectedCommand:expectedCommand(process.execPath,commandArgs(c)),requiresProof:['missed-generation','output-boundaries','sdk-forecast','sdk-generations','sdk-acceptance','sdk-retry','sdk-cli-provider','sdk-bounded-repair','sdk-verifier-retry','sdk-continue-mixed-policy','sdk-verify-only-mixed-policy','sdk-verify-only-retry','sdk-cap','sdk-tree-cap'].includes(c.name)}))},null,2));
  const coverage=[],knownGenerations=new Map(),independentAbsence=new Map();
  const retainAbsence=rows=>{for(const g of knownGenerations.values())if(!rows.some(r=>r.pid===g.pid))independentAbsence.set(g.pid+':'+g.born,{...g,at:new Date().toISOString()});};
  const proofFiles=()=>{const found=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())walk(file);else if(['process-proof.json','cleanup-observed.json','sdk-forecast-process-proof.json'].includes(e.name))found.push(file);}}walk(runs);const extra=path.join(process.env.ROUND9_OWNED_RUNTIME,'command-proofs');if(fs.existsSync(extra))walk(extra);for(const name of fs.readdirSync(PARENT).filter(n=>n.startsWith('environment-'))){const dir=path.join(PARENT,name),start=path.join(dir,'started.public.json');if(fs.existsSync(start)&&within(scratch,JSON.parse(fs.readFileSync(start)).cwd)){const proofs=path.join(dir,'command-proofs');if(fs.existsSync(proofs))walk(proofs);}}return found;};
  const initial=inventory(),testIdentity=initial.find(p=>p.pid===process.pid),wrapperIdentity=initial.find(p=>p.pid===testIdentity.parentPid),records=[],results=[];
  async function run(command){
   const prior=new Set(proofFiles());
   const log=path.join(logRoot,command.name+'.log'),output=fs.createWriteStream(log,{flags:'wx'});
   const child=cp.spawn(process.execPath,['--require',preload,physical(WRAPPER),'--cwd',ROOT,'--',physical(process.execPath),...commandArgs(command)],{cwd:ROOT,stdio:['ignore','pipe','pipe'],windowsHide:true});
   const stdoutRedactor=new WithheldOutputStream(),stderrRedactor=new WithheldOutputStream();
   const record={pid:child.pid,expectedCommand:expectedCommand(process.execPath,['--require',preload,physical(WRAPPER),'--cwd',ROOT,'--',physical(process.execPath),...commandArgs(command)])};records.push(record);let environmentMarker='',environment;
   child.stdout.on('data',chunk=>{output.write(stdoutRedactor.push(chunk));// Retain only a bounded marker candidate, never the full raw stream.
    for(const character of chunk.toString('utf8')){if(character==='\n'||character==='\r'){const match=/^TEST_ENVIRONMENT ([^\r\n]{1,2048})$/.exec(environmentMarker);environmentMarker='';if(match&&!environment){environment=physical(match[1]);const rows=inventory();record.identity=rows.find(p=>p.pid===child.pid);record.descendants=descendants(rows,child.pid);}}else{environmentMarker=(environmentMarker+character).slice(-2070);}}});child.stderr.on('data',chunk=>output.write(stderrRedactor.push(chunk)));
   let ended,spawnFailed=false;
   try{ended=await new Promise(resolve=>{child.once('error',()=>{spawnFailed=true;});child.once('close',(code,signal)=>resolve({code,signal}));});Object.assign(record,ended,{completedAt:new Date().toISOString()});}
   finally{output.write(stdoutRedactor.finish());output.write(stderrRedactor.finish());await new Promise(resolve=>output.end(resolve));}
   assert.ok(!spawnFailed,'aggregate command spawn failed after native closure');assert.equal(ended.signal,null);
   assert.ok(environment,'fresh allowlisted wrapper environment');const root=JSON.parse(fs.readFileSync(path.join(environment,'started.public.json'))),settled=JSON.parse(fs.readFileSync(path.join(environment,'settled.public.json')));assert.equal(settled.signal,null);assert.equal(settled.pid,root.pid);
   // Native waits prove root completion. Independently retained inventories
   // below, and the generation checker, cover descendants/helpers/windows.
   const ownProof=findCommandProof(path.join(process.env.ROUND9_OWNED_RUNTIME,'command-proofs'),record);
   if(ownProof){record.identity??=ownProof.identity;record.descendants??=ownProof.descendants;}
   // The public settlement is a real wait for the inner command, not the
   // command's own beforeExit claim. Retain its creation-bound completion too.
   const directCommand=expectedCommand(process.execPath,commandArgs(command));
   const directProof=findCommandProof(path.join(environment,'command-proofs'),{pid:root.pid,expectedCommand:directCommand});
   const directIdentity=directProof?.identity??record.descendants?.find(g=>g.pid===root.pid&&Date.parse(g.born)<=Date.parse(root.at));
   if(directIdentity)records.push({pid:root.pid,identity:directIdentity,descendants:directProof?.descendants??[],expectedCommand:directCommand,code:settled.code,signal:settled.signal,completedAt:settled.at});
   const rows=inventory();
   // A nested command's final observer cannot prove its own helper absent.
   // Reconcile its exported generations in this existing post-wait sample,
   // retaining absence now rather than waiting until PID reuse at suite end.
   for(const file of proofFiles()){
    let proof;try{proof=JSON.parse(fs.readFileSync(file));}catch{continue;} // outside checker still refuses malformed evidence
    const generations=[...(proof.fixtures??[]),...(proof.hosts??[]),...(proof.hostProof??[]).flatMap(p=>[...(p.children??[]),...(p.syncCommands??[]),...(p.observers??[])].flatMap(r=>[r.identity,...(r.descendants??[])])),...(proof.observers??[]).flatMap(r=>[r.identity,...(r.descendants??[])])];
    for(const g of generations)if(g&&Number.isSafeInteger(g.pid)&&typeof g.born==='string')knownGenerations.set(g.pid+':'+g.born,g);
   }
   for(const r of observers)for(const g of [r.identity,...(r.descendants??[])].filter(Boolean))knownGenerations.set(g.pid+':'+g.born,g);
   retainAbsence(rows);
   assertExpectedCommands([record]);
   for(const g of [record.identity,...(record.descendants??[])]){
    assert.ok(g,'missing expected generation identity');const current=rows.find(p=>p.pid===g.pid);
    const waitedRoot=g.pid===record.pid&&record.signal===null&&Number.isInteger(record.code)
      || g.pid===root.pid&&settled.signal===null&&Number.isInteger(settled.code);
    assert.ok(!current||current.born!==g.born&&waitedRoot,'generation requires independent absence or creation-bound native wait; PID reuse alone is not proof');
   }
   coverage.push({name:command.name,environment,expectedCommand:expectedCommand(process.execPath,commandArgs(command)),root:record,proofs:proofFiles().filter(f=>!prior.has(f))});
   fs.writeFileSync(path.join(logRoot,'command-coverage.json'),JSON.stringify(coverage,null,2));
   results.push({name:command.name,code:settled.code,signal:settled.signal});console.log((settled.code===0?'PASS ':'FAIL ')+command.name);
  }
  let failure;
  try{sourceEquality();for(const command of commands)await run(command);}catch(error){failure=error;}finally{
   let sourceEqual=false,rows=[];const cleanupIssues=[];
   try{sourceEquality();sourceEqual=true;}catch(error){failure??=error;cleanupIssues.push('source_equality_failed');}
   try{rows=inventory();}catch(error){failure??=error;cleanupIssues.push('outside_inventory_unknown');}
   const generations=records.flatMap(r=>[r.identity,...(r.descendants??[])]).filter(Boolean);
   for(const g of [...generations,...observers.flatMap(r=>[r.identity,...(r.descendants??[])]).filter(Boolean)])knownGenerations.set(g.pid+':'+g.born,g);retainAbsence(rows);
   fs.writeFileSync(path.join(runs,'process-proof.json'),JSON.stringify({testIdentity,wrapperIdentity,hostProof:[{children:records,syncCommands:[],observers}],hosts:[],fixtures:[],observers,independentlyAbsentGenerations:[...independentAbsence.values()]},null,2));
   try{assertExpectedCommands([...records,...observers]);}catch(error){failure??=error;cleanupIssues.push('command_proof_unknown');}
   fs.writeFileSync(path.join(logRoot,'results.json'),JSON.stringify({results,sourceEquality:sourceEqual,cleanupIssues,cleanup:'pending_required_post_return_outside_check',scope:'Retained round9 deterministic current-source checks; original item3 takeover deferred to ROUND10 under owner tg-<owner-message>, with refusal/no-replay coverage retained. Required --outside cleanup must ALSO pass after aggregate return. Approved manual renewal/KL-01/KL-02 and deferred real-model/owner-use proof remain explicit'},null,2));
  }
  if(failure)throw failure;if(results.some(r=>r.code!==0))process.exitCode=1;
 }
 main().catch(()=>{console.error('ROUND9_AGGREGATE_FAILED; inspect safe per-check labels and results in owned scratch');process.exitCode=1;});
}
