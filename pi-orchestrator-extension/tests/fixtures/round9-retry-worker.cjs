// Separate from task1's settled fixture. Cooperative EOF; no subprocesses.
'use strict';
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1];
const profile=path.basename(value('--append-system-prompt')||'unknown').replace(/-system-prompt\.txt$/,'');
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>prompt+=s);
process.stdin.on('end',()=>{
 const cfg=JSON.parse(fs.readFileSync(process.env.ROUND9_RETRY_CONFIG,'utf8'));
 const role=profile==='planner'?'planner':profile==='reviewer'?'verifier':'builder';
 const prior=fs.existsSync(cfg.log)?fs.readFileSync(cfg.log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 fs.appendFileSync(cfg.log,JSON.stringify({pid:process.pid,role,provider:value('--provider'),model:value('--model')})+'\n');
 if(args.includes('--extension')){process.stderr.write('NO_FORCE_KILL_GUARD_READY:v1\n');process.stderr.write('NO_OUTPUT_MONITOR_READY:v1\n');}
 process.stdout.write(JSON.stringify({type:'agent_start'})+'\n');
 const mixed=cfg.mixedPolicy&&role==='verifier';
 const attempt=prior.filter(c=>c.role===role).length;
 const failing=mixed||prior.filter(c=>c.role===role).length<(role==='builder'?cfg.failBuilders:role==='verifier'?cfg.failVerifiers??0:0);
 const text=role==='planner'?JSON.stringify({tasks:[{id:'only',description:'Inspect only; do not edit.',dependsOn:[],expectsFileChange:false}],predicted_write_set:['product.txt'],protected_areas_needed:[]}):role==='verifier'?JSON.stringify(prior.filter(c=>c.role===role).length<(cfg.malformedVerifiers??0)?{}:{status:'pass',reasons:[]}):'Settled fixture result';
 const message={role:'assistant',content:[{type:'text',text:failing?'':text}],stopReason:failing?'error':'stop',...(failing?{errorMessage:mixed&&attempt!==1?'provider policy refused; try rephrasing':'authentication token expired',provider:{access:cfg.secret,refresh:cfg.secret,accountId:cfg.secret}}:{}),usage:{input:1,output:1,totalTokens:2,cost:{input:0,output:0,total:0}}};
 if(failing&&!mixed){process.stderr.write('{"refresh_');process.stderr.write('token":"'+cfg.secret+'"}\n');}
 process.stdout.write(JSON.stringify({type:'message_end',message})+'\n');
 process.stdout.write(JSON.stringify({type:'agent_end',messages:[message]})+'\n');
});
