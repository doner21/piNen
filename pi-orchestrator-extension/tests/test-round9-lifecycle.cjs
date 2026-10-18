// Focused causal regressions; no child creation, credentials, or process control.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),parent=fs.realpathSync(process.argv[2]);
assert.ok(path.isAbsolute(parent)&&!parent.startsWith(ROOT+path.sep));
const scratch=path.join(parent,'lifecycle-'+crypto.randomUUID());fs.mkdirSync(scratch);
const jiti=require(path.join(ROOT,'node_modules/jiti'))(__filename,{interopDefault:true,fsCache:false});
const failures=[];async function test(label,fn){try{await fn();console.log('PASS '+label);}catch{failures.push(label);console.log('FAIL '+label);}}
(async()=>{
 await test('durable launch reservations survive a new module/host and never replenish',async()=>{
  const file=path.join(ROOT,'src/spawn-budget.ts');const a=await jiti.import(file);const dir=path.join(scratch,'budget');fs.mkdirSync(dir);
  assert.equal(a.reserveRunSpawn(dir,3),1);assert.equal(a.reserveRunSpawn(dir,3),2);
  const fresh=require(path.join(ROOT,'node_modules/jiti'))(__filename,{interopDefault:true,fsCache:false,moduleCache:false});const b=await fresh.import(file);
  assert.equal(b.readRunSpawnCount(dir),2);assert.equal(b.reserveRunSpawn(dir,3),3);
  assert.throws(()=>b.reserveRunSpawn(dir,3));assert.throws(()=>b.reserveRunSpawn(dir,9));assert.throws(()=>b.reserveRunSpawn(dir,9,true));assert.equal(b.readRunSpawnCount(dir),3);
 });
 await test('cleanup requires every expected command identity and never filters missing ones',()=>{
  const {assertExpectedCommands,assertExpectedCoverage}=require('./fixtures/round9-command-proof.cjs');
  const good={pid:123,identity:{pid:123,born:'2026-10-17T01:00:00.0000000Z'},expectedCommand:{executable:'git.exe',argvSha256:'0'.repeat(64)},creationBinding:'waited-process-handle',executable:'C:/Program Files/Git/cmd/git.exe',code:0,signal:null};
  assertExpectedCommands([good]);assert.throws(()=>assertExpectedCommands([good,{...good,identity:undefined}]));assert.throws(()=>assertExpectedCommands([{...good,expectedCommand:undefined}]));
  const expected=[{name:'sdk',expectedCommand:good.expectedCommand,requiresProof:true}],coverage=[{name:'sdk',root:good,expectedCommand:good.expectedCommand,proofs:['owned-worker-proof']}];
  assertExpectedCoverage(expected,coverage);assert.throws(()=>assertExpectedCoverage([...expected,{...expected[0],name:'missing'}],coverage));assert.throws(()=>assertExpectedCoverage(expected,[{...coverage[0],proofs:[]}]));
 });
 await test('command proof keeps reused PID generations; ambiguous lookup is unknown',()=>{
  const api=require('./fixtures/round9-command-proof.cjs'),{findCommandProof}=api;
  const owned=path.join(scratch,'preload');fs.mkdirSync(owned);
  let born='2026-10-17T01:00:00.000Z';const proc={pid:456,execPath:process.execPath,execArgv:[],argv:[process.execPath,'fixture.cjs'],env:{ROUND9_OWNED_RUNTIME:owned},once(){}};
  const cp={spawnSync:()=>({pid:888,status:0,signal:null,stdout:JSON.stringify([{pid:456,parentPid:1,born},{pid:888,parentPid:456,born}])})};
  const source=fs.readFileSync(path.join(__dirname,'fixtures/round9-command-preload.cjs'),'utf8');
  const modules={'../../tools/round9-runtime.cjs':require('../tools/round9-runtime.cjs'),'node:fs':fs,'node:path':path,'node:child_process':cp,'node:module':{syncBuiltinESMExports(){}},'node:crypto':crypto,'./round9-command-proof.cjs':api};
  const load=()=>new Function('require','process',source)(name=>{if(!modules[name])throw Error('unexpected fixture import');return modules[name];},proc);
  load();born='2026-10-17T02:00:00.000Z';load();assert.equal(fs.readdirSync(path.join(owned,'command-proofs')).length,2,'actual preload must retain both same-PID generation starts');
  const root=path.join(scratch,'command-proofs');fs.mkdirSync(root);
  const expectedCommand={executable:'node.exe',argvSha256:'1'.repeat(64)},record={pid:456,expectedCommand};
  for(const [name,born] of [['456-first','2026-10-17T01:00:00.000Z'],['456-second','2026-10-17T02:00:00.000Z']]){const dir=path.join(root,name);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'started.json'),JSON.stringify({pid:456,identity:{pid:456,born},expectedCommand}));}
  assert.equal(findCommandProof(root,record),undefined);assert.equal(findCommandProof(root,{...record,identity:{pid:456,born:'2026-10-17T01:00:00.000Z'}}).identity.born,'2026-10-17T01:00:00.000Z');assert.equal(fs.readdirSync(root).length,2);
 });
 await test('actual SDK observer rejects reused creator PIDs without dropping real descendants',()=>{
  const ts=require(path.join(ROOT,'node_modules/typescript')),vm=require('node:vm'),source=fs.readFileSync(path.join(__dirname,'test-round9-sdk-forecast.cjs'),'utf8'),ast=ts.createSourceFile('forecast.cjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  let declaration;function visit(n){if(ts.isVariableDeclaration(n)&&n.name.text==='descendants')declaration=n;ts.forEachChild(n,visit);}visit(ast);assert.ok(declaration);
  const collect=vm.runInNewContext('('+declaration.initializer.getText(ast)+')',{Set,Date});
  const rows=[{ProcessId:1,ParentProcessId:0,created:'2026-10-17T01:00:00.0001000Z'},{ProcessId:2,ParentProcessId:1,created:'2026-10-17T01:00:00.0003000Z'},{ProcessId:3,ParentProcessId:2,created:'2026-10-17T01:00:00.0002000Z'},{ProcessId:4,ParentProcessId:2,created:'2026-10-17T01:00:00.0004000Z'}];
  assert.deepEqual(collect(rows,1).map(row=>row.ProcessId),[2,4],'native creator ordering, not PID reuse or millisecond rounding');
 });
 const generations=await jiti.import(path.join(ROOT,'src/process-generation.ts'));
 const root={pid:123,parentPid:122,born:'2026-10-17T01:00:00.0000000Z'},tree={schemaVersion:1,rootPid:123,rootBorn:root.born,observedAt:root.born,members:[root],status:'clean',survivors:[],unknown:[]};
 await test('legacy takeover charges every observed attempt and refuses historical unknown',async()=>{
  const budget=await jiti.import(path.join(ROOT,'src/spawn-budget.ts'));
  const known=path.join(scratch,'legacy-known'),unknown=path.join(scratch,'legacy-unknown');fs.mkdirSync(known);fs.mkdirSync(unknown);
  fs.writeFileSync(path.join(known,'phase-0-worker.result.json'),JSON.stringify({pid:124,processTrees:[tree,{...tree,rootPid:124}]}));
  assert.equal(budget.reserveRunSpawn(known,3),3);assert.throws(()=>budget.reserveRunSpawn(known,3));
  fs.writeFileSync(path.join(unknown,'phase-0-worker.result.json'),JSON.stringify({status:'incomplete',eventCount:0}));assert.throws(()=>budget.reserveRunSpawn(unknown,3));
  fs.writeFileSync(path.join(unknown,'phase-0-worker.result.json'),JSON.stringify({status:'complete',pid:123}));assert.throws(()=>budget.reserveRunSpawn(unknown,3));
  fs.writeFileSync(path.join(unknown,'phase-0-worker.result.json'),JSON.stringify({status:'complete',pid:123,processTree:{...tree,rootBorn:undefined}}));assert.throws(()=>budget.reserveRunSpawn(unknown,3));
  const automatic=path.join(scratch,'automatic');fs.mkdirSync(automatic);assert.equal(budget.reserveRunSpawn(automatic,2,true),1);assert.equal(budget.reserveRunSpawn(automatic,4,true),2);assert.equal(budget.readRunSpawnCount(automatic),2);
 });
 const run=path.join(scratch,'phases');fs.mkdirSync(run);fs.writeFileSync(path.join(run,'state.json'),JSON.stringify({phases:[]}));
 const file=path.join(run,'phase-0-verifier.result.json');const write=r=>fs.writeFileSync(file,JSON.stringify({schemaVersion:1,kind:'subagent-phase-result',launchId:'fixture-phase',...r,...(r.processTree?{processTree:{...r.processTree,launchId:'fixture-phase',phaseId:file}}:{})}));
 await test('positive NEVER_DISPATCHED is not missing cleanup',()=>{
  write({status:'incomplete',settlement:'never_dispatched',eventCount:0});assert.equal(generations.readRunProcessTrees(run,()=>({status:'dead',evidence:'ESRCH'})).status,'clean');
  write({status:'incomplete',eventCount:0});assert.equal(generations.readRunProcessTrees(run,()=>({status:'dead',evidence:'ESRCH'})).status,'unknown');
  write({status:'incomplete',settlement:'never_dispatched',pid:root.pid,eventCount:0});assert.notEqual(generations.readRunProcessTrees(run,()=>({status:'dead',evidence:'ESRCH'})).status,'clean');
 });
 await test('settled exhausted attempts remain observable and unknown is never clean',()=>{
  write({status:'incomplete',settlement:'closed',pid:root.pid,processTree:tree});assert.equal(generations.readRunProcessTrees(run,()=>({status:'dead',evidence:'ESRCH'})).status,'clean');
  assert.equal(generations.readRunProcessTrees(run,()=>({status:'unknown'})).status,'unknown');
  assert.equal(generations.readRunProcessTrees(run,()=>({status:'alive',startedAt:Date.parse(root.born),birthIdentity:root.born})).status,'survivors');
 });
 await test('role recovery preserves every exhausted/planner/shard generation',async()=>{
  const r=await jiti.import(path.join(ROOT,'src/role-recovery.ts'));
  const request=r.createRoleRecoveryRequest({role:'verifier',prompt:'Verify all existing evidence',acceptanceCriteria:['check'],allowReplan:false});
  let n=0;const result=await r.runRoleWithRecovery(request,{launch:async()=>{n++;const candidate={agentName:'verifier',provider:'fixed',model:'fixed',text:n===1?'unfinished':JSON.stringify({status:'pass',reasons:[],criterionFindings:[{criterionId:'RC-1',status:'pass',evidence:[{kind:'test',observed:'checked',exitCode:0}]}]}),events:1,toolCalls:0,exitCode:0,durationMs:0,processTree:{...tree,rootPid:123+n,rootBorn:root.born,members:[{...root,pid:123+n}]}};if(n===1)throw new r.RoleContextExhaustionError(candidate);return candidate;}});
  assert.equal(result.processTrees.length,2);assert.deepEqual(result.processTrees.map(t=>t.rootPid),[124,125]);
 });
 if(failures.length)process.exitCode=1;
})().finally(()=>fs.rmSync(scratch,{recursive:true,force:true}));
