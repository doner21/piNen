#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.resolve(__dirname,'..'),ts=require(path.join(ROOT,'node_modules/typescript'));
const file=path.join(ROOT,'../agent/extensions/agent-scheduler/index.ts'),text=fs.readFileSync(file,'utf8'),ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
const names=['emptyStore','normalizeStore','resolveScheduleId','cancelSchedule','deliveryTargetSessionFile','normalizeSessionFileKey','scheduleMatchesSession','textResult','registerAgentScheduler'];
const declarations=ast.statements.filter(n=>names.includes(n.name?.text)).map(n=>n.getText(ast).replace(/^export\s+/, '')).join('\n');
const cls=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.members.some(m=>m.name?.text==='claimDeliver'));
const methods=cls.members.filter(n=>['claimDeliver','executeTool','actionCancel'].includes(n.name?.text)).map(n=>n.getText(ast)).join('\n');
let store,commands={},tool,seq=0,calls=0;
const context=vm.createContext({Error,Date,Map,Promise,process,resolve:path.resolve,AgentSchedulerParams:{},randomHex:()=>String(++seq),mutateStore:async fn=>fn(store),sessionFileOf:ctx=>ctx.session,buildWakeEnvelope:r=>JSON.stringify(r)});
vm.runInContext(ts.transpileModule(declarations+'\nclass SchedulerRuntime {'+methods+'}\nglobalThis.api={normalizeStore,scheduleMatchesSession,SchedulerRuntime,registerAgentScheduler};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
const {api}=context;
const fixture=()=>({nextSeq:3,schedules:{first:{id:'first',message:'check',dueAt:1,createdAt:0,status:'failed',failureReason:'authentication failed',originCwdKey:'owned',originSessionFile:'A',successorId:'backup'},backup:{id:'backup',message:'backup',dueAt:2,createdAt:0,status:'pending',originCwdKey:'owned',originSessionFile:'A',predecessorId:'first'}}});
const failures=[];async function check(name,fn){try{await fn();console.log('PASS '+name);}catch(e){failures.push(name+': '+e.message);console.log('RED '+failures.at(-1));}}
(async()=>{
  for(const value of [0,121,'10',NaN,{},null])await check('malformed successor delay '+JSON.stringify(value),()=>{
    const f=fixture();f.schedules.first.status='pending';delete f.schedules.first.successorId;f.schedules.first.successorInMinutes=value;
    assert.equal(api.normalizeStore(f).schedules.first.status,'failed','malformed persisted successor must refuse delivery, not silently lose backup');
  });
  await check('malformed successor identity',()=>{const f=fixture();f.schedules.first.status='pending';f.schedules.first.successorId={};assert.equal(api.normalizeStore(f).schedules.first.status,'failed');});
  await check('exact session routing',()=>{const r=fixture().schedules.backup;assert.equal(api.scheduleMatchesSession(r,'owned','B'),false);assert.equal(api.scheduleMatchesSession(r,'owned','A'),true);});
  const runtime=new api.SchedulerRuntime();Object.assign(runtime,{pendingConfirmations:new Map(),canInjectAtBoundary:()=>true,matchesCurrentSession:r=>api.scheduleMatchesSession(r,'owned',runtime.sessionFile),contextIsIdle:()=>true,releaseUnsentClaim:async()=>{},failClaim:async()=>{},safeAsync:()=>{},armTimer:async()=>{},notify:()=>{},rearm:()=>{},pi:{sendUserMessage(){calls++;}}});
  const ctx={cwd:'owned',session:'A',ui:{notify(){}}};
  await check('tool cancellation includes backup and preserves diagnostic',async()=>{store=fixture();await runtime.executeTool({action:'cancel',id:'first'},ctx);assert.equal(store.schedules.backup.status,'cancelled');assert.equal(store.schedules.first.failureReason,'authentication failed');});
  // Register the real command body while keeping timers and session-start drains inert.
  context.SchedulerRuntime=function(){return runtime;};
  // The lexical class binding is replaced only in the extracted factory test.
  const registration=ast.statements.find(n=>n.name?.text==='registerAgentScheduler').getText(ast).replace('new SchedulerRuntime(pi, resolvedDependencies)','globalThis.fixtureRuntime');
  context.fixtureRuntime=runtime;vm.runInContext(ts.transpileModule(registration+'\nglobalThis.register=registerAgentScheduler;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  context.register({on(){},registerTool(t){tool=t;},registerCommand(n,c){commands[n]=c;}},{});
  await check('foreign successor pointer cannot cancel unrelated wake',async()=>{store=fixture();store.schedules.backup.predecessorId='other';await runtime.executeTool({action:'cancel',id:'first'},ctx);assert.equal(store.schedules.backup.status,'pending');});
  await check('command cancellation includes backup',async()=>{store=fixture();await commands['cancel-schedule'].handler('first',ctx);assert.equal(store.schedules.backup.status,'cancelled');});
  await check('session change cannot deliver backup',async()=>{store=fixture();runtime.sessionFile='B';assert.equal(await runtime.claimDeliver('backup',false),false);assert.equal(calls,0);runtime.sessionFile='A';await runtime.claimDeliver('backup',false);await runtime.claimDeliver('backup',false);assert.equal(calls,1);});
  assert.equal(failures.length,0,failures.join('\n'));
})().catch(error=>{console.error(error);process.exitCode=1;});
