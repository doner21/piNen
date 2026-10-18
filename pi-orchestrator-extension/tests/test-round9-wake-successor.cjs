#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.resolve(__dirname,'..'),ts=require(path.join(ROOT,'node_modules/typescript'));
const file=path.join(ROOT,'../agent/extensions/agent-scheduler/index.ts'),text=fs.readFileSync(file,'utf8'),ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
const cls=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.members.some(m=>m.name?.text==='claimDeliver'));
const method=cls.members.find(n=>n.name?.text==='claimDeliver').getText(ast);
const store={nextSeq:2,schedules:{first:{id:'first',message:'Check current run; report previous failure',status:'pending',dueAt:1,createdAt:0,originCwdKey:'owned',originSessionFile:'session-A',targetSessionFile:'session-A',successorInMinutes:10}}};
let calls=0,seq=0;
const context=vm.createContext({Error,Map,Date,Promise,deliveryTargetSessionFile:r=>r.targetSessionFile??r.originSessionFile,randomHex:()=>String(++seq),mutateStore:async fn=>fn(store),buildWakeEnvelope:r=>JSON.stringify(r)});
vm.runInContext(ts.transpileModule('class Runtime {'+method+'}\nglobalThis.api=Runtime;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
const runtime=new context.api();
Object.assign(runtime,{pendingConfirmations:new Map(),canInjectAtBoundary:()=>true,matchesCurrentSession:r=>r.targetSessionFile==='session-A',contextIsIdle:()=>true,releaseUnsentClaim:async()=>{},failClaim:async(id,token,error)=>{store.schedules[id].status='failed';store.schedules[id].failureReason='authentication failed';},pi:{sendUserMessage(){calls++;if(calls===1){assert.equal(Object.values(store.schedules).filter(r=>r.status==='pending').length,1,'successor persisted BEFORE failed auth/wake turn');throw Error('authentication failed');}}}});
(async()=>{
  await runtime.claimDeliver('first',false);
  const successors=Object.values(store.schedules).filter(r=>r.status==='pending');
  assert.equal(successors.length,1,'one persisted backup survives failure');
  const next=successors[0];assert.equal(next.targetSessionFile,'session-A');assert.equal(next.originCwdKey,'owned');
  assert.ok(next.message.includes('first'),'next wake can inspect prior failure by identity');
  await runtime.claimDeliver(next.id,false);await runtime.claimDeliver(next.id,false);
  assert.equal(calls,2,'backup wake delivered once through original claim fence');
  assert.equal(Object.values(store.schedules).filter(r=>r.status==='pending').length,0,'workaround is one backup, not an unbounded loop');
  console.log('PASS successor persisted first, auth failure retained, next wake exactly once, session fencing');
})().catch(error=>{console.error(error);process.exitCode=1;});
