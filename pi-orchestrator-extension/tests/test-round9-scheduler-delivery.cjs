// Full production runtime/storage and registered tool/command, with an inert clock.
// Existing timer requests are captured, never scheduled. No new wake loop.
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{createRequire}=require('node:module');
const ROOT=path.resolve(__dirname,'..'),load=createRequire(path.join(ROOT,'package.json')),ts=load('typescript');
(async()=>{
 const dir=path.join(process.env.ROUND9_OWNED_RUNTIME,'scheduler');fs.mkdirSync(dir);
 const file=path.join(ROOT,'../agent/extensions/agent-scheduler/index.ts'),source=fs.readFileSync(file,'utf8');
 let now=Date.now();class Clock extends Date { static now(){return now;} }
 const requested=[];
 const capture=(fn,delay)=>{const request={fn,delay,unref(){}};requested.push(request);return request;};
 const context=vm.createContext({exports:{},require:name=>name==='@earendil-works/pi-ai'?{StringEnum:()=>({})}:name==='@earendil-works/pi-coding-agent'?{getAgentDir:()=>dir}:load(name),process,Date:Clock,setTimeout:capture,clearTimeout:()=>{},console});
 vm.runInContext(ts.transpileModule(source+'\nglobalThis.Runtime=SchedulerRuntime; globalThis.register=registerAgentScheduler;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
 const storeFile=path.join(dir,'scheduler.json'),read=()=>JSON.parse(fs.readFileSync(storeFile,'utf8'));
 const key=context.exports.normalizeCwdKey(dir),A=path.join(dir,'A.jsonl'),B=path.join(dir,'B.jsonl');fs.writeFileSync(A,'');fs.writeFileSync(B,'');
 const entries=[],ctx={cwd:dir,isIdle:()=>true,ui:{notify(){}},sessionManager:{getSessionFile:()=>A,getBranch:()=>entries,getEntries:()=>entries}};
 const secret=require('node:crypto').randomBytes(24).toString('hex');
 const queued=[];let delivered=0,first=true;
 const pi={sendUserMessage(envelope){delivered++;const s=read();if(first){first=false;assert.equal(Object.values(s.schedules).filter(r=>r.status==='pending').length,1,'backup durable BEFORE the failing model turn');throw Error(JSON.stringify({access:secret}));}entries.push({type:'message',message:{role:'user',content:envelope}});}};
 const deps={probeSessionFile:async()=> 'present',observeSessionProcesses:async()=>({certainty:'complete',observations:[]})};
 const runtime=new context.Runtime(pi,deps);runtime.safeAsync=(_label,fn)=>{queued.push(fn());};
 const settle=async()=>{for(let i=0;i<10&&queued.length;i++)await Promise.all(queued.splice(0));assert.equal(queued.length,0,'bounded production boundary work');};
 await runtime.onSessionStart({reason:'fork'},ctx);await settle();
 const seed=()=>fs.writeFileSync(storeFile,JSON.stringify({version:1,nextSeq:2,schedules:{first:{id:'first',message:'Report prior failure',originCwdKey:key,originCwd:dir,originSessionFile:A,targetSessionFile:A,status:'pending',createdAt:now,dueAt:now,successorInMinutes:10}}}));
 seed();runtime.onAgentSettled(ctx);await settle();let store=read(),backup=store.schedules.first.successorId;
 assert.ok([secret,secret.slice(0,17),secret.slice(17)].every(s=>!fs.readFileSync(storeFile,'utf8').includes(s)),'persisted scheduler delivery error never contains credential or fragments');
 assert.equal(store.schedules.first.status,'failed');assert.equal(store.schedules[backup].status,'pending');assert.equal(store.schedules[backup].successorInMinutes,undefined,'backup is not recurring');
 now=store.schedules[backup].dueAt+1;
 await runtime.onSessionShutdown();const foreign={...ctx,sessionManager:{...ctx.sessionManager,getSessionFile:()=>B}};await runtime.onSessionStart({reason:'fork'},foreign);await settle();runtime.onAgentSettled(foreign);await settle();assert.equal(delivered,1,'session change cannot inject predecessor backup');
 await runtime.onSessionShutdown();await runtime.onSessionStart({reason:'fork'},ctx);await settle();runtime.onAgentSettled(ctx);await settle();assert.equal(delivered,2,'booked successor actually delivered through settled boundary');
 await runtime.onContext(ctx);runtime.onAgentSettled(ctx);await settle();assert.equal(delivered,2,'no duplicate delivery or recurrence');
 // A successfully appended wake can fail LATER in its provider/model turn.
 // The scheduler confirms delivery at context, not semantic model success.
 seed();runtime.onAgentSettled(ctx);await settle();await runtime.onContext(ctx);
 store=read();backup=store.schedules.first.successorId;assert.equal(store.schedules.first.status,'delivered');
 assert.equal(store.schedules[backup].status,'pending','later provider failure cannot erase the already booked successor');
 await Promise.reject(Error('synthetic provider turn failed')).catch(()=>{});
 runtime.onAgentSettled(ctx);await settle();assert.equal(delivered,3,'failed settled turn does not duplicate a future backup');
 now=store.schedules[backup].dueAt+1;runtime.onAgentSettled(ctx);await settle();assert.equal(delivered,4,'backup arrives after the appended wake model turn fails');
 await runtime.onContext(ctx);runtime.onAgentSettled(ctx);await settle();assert.equal(delivered,4,'second path remains bounded');
 // Registered cancellation, not a replacement helper, cancels the matching backup.
 let tool,commands={};const events={};context.register({on:(n,fn)=>events[n]=fn,registerTool:t=>tool=t,registerCommand:(n,c)=>commands[n]=c,sendUserMessage(){}},deps);
 for(const command of [false,true]){
  store=read();store.schedules.first.status='failed';store.schedules[backup].status='pending';fs.writeFileSync(storeFile,JSON.stringify(store));
  if(command)await commands['cancel-schedule'].handler('first',ctx);else await tool.execute('cancel',{action:'cancel',id:'first'},undefined,undefined,ctx);
  assert.equal(read().schedules[backup].status,'cancelled','registered cancellation cancels matching booked successor');
 }
 await runtime.onSessionShutdown();await events.session_shutdown?.({},ctx);
 console.log('PASS production delivery/storage after failed turn, actual backup arrival, session fencing and registered tool/command cancellation; bounded nonrecurrence');
})().catch(error=>{console.error('SCHEDULER_DELIVERY_CHECK_FAILED '+String(error.message).slice(0,180));process.exitCode=1;});
