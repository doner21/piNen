// Process-free causal retry state/probe checks. No credentials/provider payloads printed.
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.resolve(__dirname,'..'),ts=require(path.join(ROOT,'node_modules/typescript'));
const check=(ok,label)=>{if(!ok)throw Error(label);};
(async()=>{
 const dir=path.join(process.env.ROUND9_OWNED_RUNTIME,'retry-unit');fs.mkdirSync(dir);process.env.PI_CODING_AGENT_DIR=dir;
 const auth=()=>fs.writeFileSync(path.join(dir,'auth.json'),JSON.stringify({'fixture':{type:'api_key',key:'not-a-real-key'}}));auth();
 let restored=false,probes=0;
 const runtime={getModel:(provider,id)=>({provider,id}),completeSimple:async(_model,ctx,opts)=>{probes++;check(Object.keys(opts.env).length===0&&opts.maxRetries===0,'no ambient auth or provider retry');if(!restored)throw Error('remote refused');return {stopReason:'stop',content:[{type:'thinking',thinking:'opaque fixture reasoning',thinkingSignature:'not-published'},{type:'text',text:ctx.messages[0].content.replace('Reply with exactly ','')}]};}};
 const context=vm.createContext({exports:{},require:name=>name==='@earendil-works/pi-coding-agent'?{ModelRuntime:{create:async()=>runtime}}:name==='./run-state'?{atomicWriteJsonSync:(file,v)=>fs.writeFileSync(file,JSON.stringify(v))}:require(name),process,structuredClone});
 vm.runInContext(ts.transpileModule(fs.readFileSync(path.join(ROOT,'src/infrastructure-retry.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText,context);
 const api=context.exports.withInfrastructureRetry,route=async()=>({provider:'fixture',model:'exact'});let launches=0,reserves=0;
 // Controller-only assessment seam; complete-launcher regressions use the real
 // recorder and generation gate, including refusal of legacy unpinned claims.
 const file=path.join(dir,'phase.retry.json'),input={identity:'original run/role/task',route,options:{file,reserve:()=>reserves++},launch:async(_retry,_evidence,budget)=>{budget.beforeDispatch();launches++;if(launches===1)throw {eligible:true};return 'settled';},assess:()=>{},blocked:()=>false,eligible:e=>e?.eligible===true,refused:attempted=>Object.assign(Error('infrastructure unavailable'),{attempted})};
 const refusal=async(op,label)=>{let rejected=false;try{await op();}catch{rejected=true;}check(rejected,label);};
 await refusal(()=>api(input),'failed remote restoration refuses');check(launches===1&&reserves===0,'no dispatch on refusal');
 auth();await refusal(()=>api(input),'new bytes alone refuse');check(launches===1,'continuation skips original dispatch');
 restored=true;check(await api(input)==='settled','restored route retries');check(launches===2&&reserves===1,'single retry budget');
 await refusal(()=>api(input),'fresh-host repeated call refuses');check(launches===2,'durable consumed retry never resets');
 let duplicate;try{await api(input);}catch(error){duplicate=error;}
 check(duplicate&&duplicate.attempted===undefined,'settled/uncertain dispatch cannot invent zero-tool infrastructure telemetry');
 const saved=JSON.parse(fs.readFileSync(file));check(saved.status==='settled'&&saved.restoration==='confirmed','durable settlement');
 const unknown=path.join(dir,'unknown.retry.json');fs.writeFileSync(unknown,JSON.stringify({...saved,status:'waiting',policyRetryConsumed:'unknown'}));
 const beforeUnknown={launches,probes};await refusal(()=>api({...input,options:{...input.options,file:unknown}}),'unknown policy consumption refuses');check(launches===beforeUnknown.launches&&probes===beforeUnknown.probes,'unknown durable policy state cannot probe or dispatch');
 const legacy=path.join(dir,'legacy.retry.json'),original=path.join(dir,'legacy.result.json');fs.writeFileSync(original.replace(/\.result\.json$/,'-policy-retry.result.json'),'{}');
 fs.writeFileSync(legacy,JSON.stringify({...saved,status:'waiting',policyRetryConsumed:undefined,predecessors:undefined,originalEvidence:{phaseResultFile:original}}));
 check(await api({...input,options:{...input.options,file:legacy},originalEvidence:{phaseResultFile:original},launch:async(_retry,_evidence,budget)=>{check(budget.used,'legacy policy sidecar consumption retained');return 'legacy settled';}})==='legacy settled','older waiting operation cannot replenish policy allowance');
 const failed={...input,options:{file:path.join(dir,'failed.retry.json'),reserve:()=>{}},launch:async()=>{throw {eligible:true};}};
 await refusal(()=>api(failed),'retry failure remains failure');check(JSON.parse(fs.readFileSync(failed.options.file)).status==='failed','failed retry consumed');
 let capLaunch=0;const cap={...input,options:{file:path.join(dir,'cap.retry.json'),reserve:()=>{throw Error('cap');}},launch:async(_retry,_evidence,budget)=>{budget.beforeDispatch();capLaunch++;throw {eligible:true};}};
 await refusal(()=>api(cap),'cap refuses retry');check(capLaunch===1,'cap cannot dispatch retry');
 let mutationLaunch=0;const mutating={...input,options:{file:path.join(dir,'mutating.retry.json'),reserve:()=>{}},launch:async()=>{mutationLaunch++;throw {eligible:false};}};
 await refusal(()=>api(mutating),'mutating/unknown telemetry refuses');check(mutationLaunch===1&&JSON.parse(fs.readFileSync(mutating.options.file)).status==='failed','ambiguous execution never retries');
 fs.writeFileSync(file+'.lock','');await refusal(()=>api(input),'competing ownership refuses');fs.unlinkSync(file+'.lock');
 check(probes>=4,'restoration really uses independent provider response');
 console.log('PASS durable retry refusal/success/reload, failed retry, exclusive claim, conservative telemetry and cap');
})().catch(error=>{console.error('RETRY_STATE_CHECK_FAILED '+String(error.message).slice(0,120));process.exitCode=1;});
