// Offline protocol worker. EOF dispatch and IPC release only; no process control.
'use strict';
const fs=require('node:fs'),path=require('node:path');
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
const guard='NO_FORCE_KILL_GUARD_READY:v1',monitor='NO_OUTPUT_MONITOR_READY:v1';
process.stderr.write(guard+'\n'+monitor+'\n');
let task='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>task+=s);
process.stdin.on('end',()=>{
 const cfg=JSON.parse(fs.readFileSync(process.env.ROUND9_OUTPUT_CONFIG,'utf8'));
 const systemIndex=process.argv.indexOf('--append-system-prompt');
 const system=systemIndex>=0?path.basename(process.argv[systemIndex+1]):'';
 const role=/planner/i.test(system)?'planner':/reviewer|verifier/i.test(system)?'verifier':'writer';
 fs.appendFileSync(cfg.launchLog,JSON.stringify({pid:process.pid,role})+'\n');
 const secret=cfg.secret;
 const body='x-api-key: '+secret+'\nclient_secret='+secret+'\n';
 emit({type:'agent_start'});
 // Each line is valid JSON. The key/value boundary crosses protocol records.
 process.stderr.write(secret.slice(0,17));process.stderr.write(secret.slice(17)+' '+'.'.repeat(2200)+'\nclient_secret='+secret+'\n'+secret+'\n');
 const delta=value=>emit({type:'message_update',message:{role:'assistant',content:[]},assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:value}});
 // Every possible credential split, including echoes before their first label.
 for(const value of [secret,'x-api-key: '+secret,secret]){
  for(let split=1;split<value.length;split++){delta(value.slice(0,split));delta(value.slice(split));delta('\n');}
  delta(' '+'.'.repeat(2200)+'\n');
 }
 if(process.send){process.send({ready:true});process.once('message',finish);}else finish();
 function finish(){
  emit({type:'tool_execution_start',toolCallId:'output-action',toolName:'bash',args:{command:'echo '+secret+'; client_secret='+secret+'; echo useful-command'}});
  emit({type:'tool_execution_end',toolCallId:'output-action',toolName:'bash',isError:cfg.error,result:{content:[{type:'text',text:'echo '+secret+'; client_secret='+secret+'; useful-complete-output'}]}});
  let text='```json\n'+JSON.stringify({headers:{'x-api-key':secret,'x-goog-api-key':secret},client_secret:secret,private_key:secret,echo:secret,findings:[{criterion:'AC-1',observation:'complete useful finding'}],binding:'original-task'})+'\n```';
  if(role==='planner')text=JSON.stringify({tasks:[{id:'output-task',description:'Inspect only',dependsOn:[],expectsFileChange:false}],predicted_write_set:['product.txt'],protected_areas_needed:[]});
  if(role==='verifier')text=JSON.stringify({status:'pass',reasons:[]});
  emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason:cfg.error?'error':'stop',...(cfg.error?{errorMessage:'diagnostic '+cfg.errorSecret+' {"\\u0061ccess":"'+cfg.errorSecret+'" malformed echo '+cfg.errorSecret,error:{headers:{'x-api-key':secret}}}:{})}});
  process.stderr.write('client_secret='+secret+'\n');
  emit({type:'agent_end'});
  if(process.connected)process.disconnect();
 }
});
