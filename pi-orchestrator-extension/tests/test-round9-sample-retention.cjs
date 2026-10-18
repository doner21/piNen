// Process-free causal check of the ACTUAL SDK collectors, not a substitute parser.
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),ts=require('typescript');
const born=n=>new Date(n).toISOString(),p=(pid,parentPid,t)=>({pid,parentPid,born:born(t)});
const root=p(10,1,10000),helper=p(11,10,11000),base=[p(1,0,1000),root,helper];
const zero={pid:0,parentPid:0,born:null};
let kernelRows=base;
const product={exports:{},process:{platform:'win32',env:{}},structuredClone,require:id=>id==='node:child_process'?{spawnSync:()=>({stdout:JSON.stringify(kernelRows),status:0,signal:null})}:require(id.startsWith('./')?path.join(ROOT,'src',id):id)};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(ROOT,'src/process-generation.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText,product);
const g=product.exports;
kernelRows=[zero,...base];assert.equal(g.snapshotProcesses().rows.length,base.length,'actual production snapshot accepts PID0');
kernelRows=[zero,...base,{pid:12,parentPid:1,born:null}];assert.ok(g.snapshotProcesses().error,'actual production snapshot rejects malformed positive row');
function collector(file){
 const source=fs.readFileSync(path.join(__dirname,file),'utf8'),retry=file.includes('retry');
 const start=source.indexOf(retry?'function retainSample(':'function retainAbsence('),end=source.indexOf('function snapshot(',start);
 const assignment=source.split('\n').find(line=>line.trimStart().startsWith('cp.spawnSync=(...args)=>{const result=observeSync('));
 assert.ok(start>=0&&end>start&&assignment,'existing production-boundary collector seam');
 const records=[{pid:10,identity:root,descendants:[helper]}],absence=new Map();let rows,resultFault={};
 const context={require,process:{argv:[]},Date,JSON,Map,processInventoryRows:require('../src/process-inventory.cjs').processInventoryRows,syncBuiltinESMExports(){},cp:{},observeSync:()=>({stdout:JSON.stringify(rows),status:0,signal:null,...resultFault}),originalSync(){throw Error('NO_OS');},syncCommands:[],children:records,observers:[],nestedRecords:()=>[],hostCommands:()=>records,observationCommands:[],independentAbsence:absence,absence,creatorSamples:[],previousSample:undefined};
 vm.createContext(context);vm.runInContext(source.slice(start,end)+'\n'+assignment,context);
 return {absence,collect(value,fault={}){rows=value;resultFault=fault;context.cp.spawnSync('inventory',[]);},get previous(){return context.previousSample;}};
}
for(const file of ['test-round9-sdk-generations.cjs','test-round9-sdk-retry.cjs']){
 const c=collector(file);c.collect(base);
 c.collect([zero,p(1,0,1000),root]); // helper genuinely absent in a valid production-shaped sample
 assert.ok(c.absence.has(helper.pid+':'+helper.born),file+' must retain PID0-containing absence BEFORE PID reuse');
 const t=new g.ProcessGenerationTracker(10,()=>({rows:base}),{launchId:'launch',phaseId:'phase'});
 // Feed exactly the retained collector fact into the ordinary durable assessment.
 const tree=t.current(),at=c.absence.get(helper.pid+':'+helper.born).at;
 tree.observedAt=at;tree.settledMembers=[{member:helper,launchId:'launch',phaseId:'phase',source:'kernel_absence',observedAt:at}];
 const later=[p(1,0,1000),p(11,1,Date.parse(at)+1000)];
 c.collect([zero,...later]);assert.equal(c.absence.get(helper.pid+':'+helper.born).at,at,'later reuse preserves the earlier real absence, not a new absence claim');
 assert.equal(g.assessProcessTree(tree,{rows:later}).status,'clean');
 for(const fault of ['missing-proof','birth','missing-birth','launch','missing-launch','phase','missing-phase']){
  const bad=structuredClone(tree),proof=bad.settledMembers[0];
  if(fault==='missing-proof')delete bad.settledMembers;
  if(fault==='birth')proof.member.born=born(1);
  if(fault==='missing-birth')delete proof.member.born;
  if(fault==='launch')proof.launchId+='wrong';if(fault==='missing-launch')delete proof.launchId;
  if(fault==='phase')proof.phaseId+='wrong';if(fault==='missing-phase')delete proof.phaseId;
  assert.equal(g.assessProcessTree(bad,{rows:later}).status,'unknown',fault);
 }
 assert.equal(g.assessProcessTree(tree,{rows:[p(1,0,1000),helper]}).status,'survivors','actual helper still alive cannot consume absence');
 for(const malformed of [{pid:12,parentPid:1,born:null},{pid:12,parentPid:1,born:'wrong'},{pid:12,parentPid:'1',born:born(1)},null]){
  const bad=collector(file);bad.collect([zero,p(1,0,1000),root,malformed]);assert.equal(bad.absence.size,0,'malformed positive sample cannot prove any absence');
 }
 for(const fault of [{status:1},{signal:'untrusted'},{error:{code:'unavailable'}}]){const bad=collector(file);bad.collect([zero,p(1,0,1000),root],fault);assert.equal(bad.absence.size,0,'unsuccessful inventory cannot prove absence');}
 const noProof=collector(file);noProof.collect(base);noProof.collect([zero,...later]);assert.equal(noProof.absence.has(helper.pid+':'+helper.born),false,'PID reuse itself is not absence');
 const unknown=new g.ProcessGenerationTracker(10,()=>({rows:base}));unknown.rootClosed();
 const unresolved=unknown.sample();assert.equal(unresolved.status,'survivors','native close is not helper completion');
 assert.equal(g.assessProcessTree(tree,{rows:[p(1,0,1000),p(50,49,12000)]}).status,'unknown','unresolved creator never exempted');
 if(file.includes('retry'))assert.equal(c.previous.rows.some(row=>row.pid===0),false,'creator history retains the same validated production inventory');
 console.log('PASS actual collector PID0 retention/reuse and conservative negative controls '+file);
}
