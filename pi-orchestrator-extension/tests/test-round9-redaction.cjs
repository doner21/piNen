// Assertions deliberately never include payload values or sentinel diffs.
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
function check(ok,label){if(!ok)throw Object.assign(Error(label),{safeLabel:true});}
(async()=>{
 const jiti=require(path.join(ROOT,'node_modules/jiti'))(__filename,{interopDefault:true,fsCache:false,moduleCache:false});
 const {appendSubagentPhaseLog,SubagentPhaseResultRecorder}=await jiti.import(path.join(ROOT,'src/substrate.ts'));
 const redactor=require(path.join(ROOT,'src/streaming-redactor.cjs'));
 const secret=crypto.randomBytes(24).toString('hex'),fragments=Array.from({length:secret.length-7},(_,i)=>secret.slice(i,i+8)),dir=path.join(process.env.ROUND9_OWNED_RUNTIME,'redaction');fs.mkdirSync(dir);
 const payload=JSON.stringify({type:'message_end',message:{role:'assistant',error:{access:secret,refresh:secret,accountId:secret,nested:{reasoningSignature:secret}},errorMessage:'authentication token expired'}});
 const log=path.join(dir,'phase.log');appendSubagentPhaseLog(log,'stdout',payload);
 appendSubagentPhaseLog(log,'stdout',secret);appendSubagentPhaseLog(log,'stderr','refresh_');appendSubagentPhaseLog(log,'stderr','token='+secret);
 check(!fs.readFileSync(log,'utf8').includes(secret),'shared phase log redaction');
 const recorder=new SubagentPhaseResultRecorder(path.join(dir,'phase.result.json'),'worker','binding task',Date.now());
 recorder.complete({agentName:'worker',task:'binding task',text:payload,stderr:payload,exitCode:0,durationMs:0,events:0});
 check(!fs.readFileSync(recorder.file,'utf8').includes(secret),'shared phase result redaction');
 const saved=recorder.readComplete();check(saved?.task==='binding task'&&saved?.agentName==='worker','authoritative phase bindings preserved');
 const failed=new SubagentPhaseResultRecorder(path.join(dir,'failure.result.json'),'worker','binding task',Date.now());
 failed.incomplete('authentication failed');failed.infrastructureFailure();
 check(failed.readComplete()===undefined,'settled infrastructure is never a successful result');
 check(!redactor.sanitizeWorkerText('{"access":"'+secret+'" broken error echo '+secret).includes(secret),'malformed provider echo redaction');
 const escaped='diagnostic '+secret+' {"\\u0061ccess":"'+secret+'" broken error echo '+secret;
 check(!redactor.sanitizeWorkerText(escaped).includes(secret),'escaped malformed credential echo');
 appendSubagentPhaseLog(log,'stdout',JSON.stringify({type:'message_end',message:{role:'assistant',errorMessage:escaped}}));
 check(!fs.readFileSync(log,'utf8').includes(secret),'escaped malformed phase log');
 const fenced='```json\n'+JSON.stringify({client_secret:secret,echo:secret,findings:[{criterion:'AC-1',observation:'complete useful finding'}],binding:'original-task'})+'\n```';
 const safeFence=redactor.sanitizeWorkerText(fenced);let parsed;try{parsed=JSON.parse(safeFence.replace(/^```json\s*|\s*```$/g,''));}catch{}
 check(parsed?.findings?.[0]?.observation==='complete useful finding'&&parsed?.binding==='original-task'&&!safeFence.includes(secret),'fenced JSON structure and findings');
 const {redactActionText,ActionEvidenceCollector}=await jiti.import(path.join(ROOT,'src/action-evidence.ts'));
 const collector=new ActionEvidenceCollector();
 collector.observe({type:'tool_execution_start',toolCallId:'echo',toolName:'bash',args:{command:'echo '+secret+'; client_secret='+secret+'; useful-action'}});
 collector.observe({type:'tool_execution_end',toolCallId:'echo',toolName:'bash',isError:true,result:{content:[{type:'text',text:'diagnostic '+secret+'; client_secret='+secret+'; useful-error'}]}});
 const ledger=JSON.stringify(collector.finalize());check(!ledger.includes(secret)&&ledger.includes('useful-action')&&ledger.includes('useful-error'),'authoritative raw action ledger complete echo/error protection and preservation');
 check(!redactActionText('echo '+secret+'; client_secret='+secret+'; echo useful-command').includes(secret),'action echo before label');
 check(redactActionText('echo harmless-command').includes('harmless-command'),'positive action command retention');
 const action='echo '+secret+'; client_secret='+secret+'; echo useful-command';
 const once=redactor.sanitizeWorkerText(action);check(once===redactor.sanitizeWorkerText(once),'complete action sanitization is idempotent');
 check(!redactor.sanitizeWorkerText(secret+' Authorization: Bearer '+secret+'; useful').includes(secret),'authorization echo before label');
 const quotedSecret=secret+' private suffix';const quotedCommand=redactor.sanitizeWorkerText(quotedSecret+"; client_secret='"+quotedSecret+"'; useful-command");
 check(!quotedCommand.includes(secret)&&!quotedCommand.includes('private suffix')&&quotedCommand.includes('useful-command'),'complete quoted assignment value and preceding echo');
 const overlapping=redactor.sanitizeWorkerValue({access:secret.slice(0,12),refresh:secret,echo:secret});check(overlapping.echo==='[REDACTED]','complete structured credential values replaced before their prefixes');
 for(const key of ['x-api-key','x-goog-api-key','client_secret','client-secret','clientSecret','proxy-authorization','private_key','session_token','textSignature','thoughtSignature']){
  check(!redactor.sanitizeWorkerText(JSON.stringify({[key]:secret,echo:secret})).includes(secret),'credential object field');
  check(!redactor.sanitizeWorkerText(key+'='+secret).includes(secret),'credential text field');
 }
 for(const text of [payload,'Authorization: Bearer '+secret,'refresh_token='+secret,'x-api-key: '+secret,'client_secret='+secret,'{"access":"'+secret,'reasoningSignature='+secret]){
  for(let split=1;split<text.length;split++){
   const r=new redactor.StreamingSecretRedactor(),out=r.push(text.slice(0,split))+r.push(text.slice(split))+r.finish();
   check(!out.includes(secret),'split/malformed redaction');
  }
 }
 for(const key of ['\\u0061ccess','re\\u0066resh_token','\\u0070assword']){
  const text='{"'+key+'"'+' '.repeat(1800)+':"'+secret+'"}'+ ' '.repeat(1800);
  for(const split of [3,7,13,1805,1830]){
   const r=new redactor.StreamingSecretRedactor();
   const outputs=[r.push(text.slice(0,split)),r.push(text.slice(split)),r.finish()];
   for(const out of outputs)check(!out.includes(secret.slice(0,17))&&!out.includes(secret.slice(17))&&!fragments.some(s=>out.includes(s)),'escaped padded streaming key at every write');
  }
  const p=new redactor.WorkerProtocolSanitizer();
  for(let i=0;i<text.length;i+=17){const out=JSON.stringify(p.sanitize({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:text.slice(i,i+17)}}));check(!out.includes(secret.slice(0,17))&&!out.includes(secret.slice(17))&&!fragments.some(s=>out.includes(s)),'escaped JSON split protocol publication');}
 }
 const protocol=new redactor.WorkerProtocolSanitizer();
 for(const delta of ['x-api-','key: ',secret.slice(0,17),secret.slice(17),'\n']){
  const safe=protocol.sanitize({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta}});
  const published=JSON.stringify(safe);
  check(!published.includes(secret.slice(0,17))&&!published.includes(secret.slice(17)),'successive valid JSON delta redaction');
 }
 // Execute the production native-bash operations callback with only its local
 // I/O substituted. A rejected transport is not a complete output boundary.
 const ts=require(path.join(ROOT,'node_modules/typescript')),vm=require('node:vm');
 const source=fs.readFileSync(path.join(ROOT,'src/worker-no-output-monitor.ts'),'utf8'),ast=ts.createSourceFile('monitor.ts',source,ts.ScriptTarget.Latest,true);let operations;
 function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='operations'&&node.initializer?.getText(ast).includes('outputComplete'))operations=node.initializer;ts.forEachChild(node,visit);}visit(ast);check(operations,'production bash callback selected');
 for(const complete of [false,true]){
  let published='',cleared=false;
  const context={Buffer,path,process,performance:{now:()=>0},policy:{},shimDir:dir,completeOutput:[],lastOutput:0,fallbackAlarmSent:false,sanitizeWorkerText:redactor.sanitizeWorkerText,
   setInterval:()=>({unref(){}}),clearInterval:()=>{cleared=true;},local:{exec:async(_command,_cwd,opts)=>{opts.onData(Buffer.from(secret));if(!complete)throw Error('fixture transport lost');opts.onData(Buffer.from('; client_secret='+secret+'; useful-bash-result'));return {exitCode:0};}}};
  vm.runInNewContext(ts.transpileModule('globalThis.run='+operations.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  let rejected=false;try{await context.run.exec('fixture',dir,{onData:data=>published+=data});}catch{rejected=true;}
  check(cleared&&!published.includes(secret)&&context.completeOutput.length===0,'production bash output finalized safely');
  check(complete?!rejected&&published.includes('useful-bash-result'):rejected&&published.includes('withheld'),'complete useful bash output preserved; unsafe partial transport output withheld');
 }
 console.log('PASS shared log/result, nested provider payload, split/malformed/protocol streams, complete/partial bash output and authoritative bindings');
})().catch(error=>{console.error('REDACTION_CHECK_FAILED '+(error.safeLabel?error.message:error.name));process.exitCode=1;});
