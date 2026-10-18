// Cooperative deterministic worker shared by round9 public-lifecycle checks.
// No subprocesses, timers, signals or forced exits. EOF settles every launch.
'use strict';
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1];
const profile=path.basename(value('--append-system-prompt')||'unknown').replace(/-system-prompt\.txt$/,'');
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',text=>{prompt+=text;});
process.stdin.on('end',()=>{
 const config=JSON.parse(fs.readFileSync(process.env.ROUND9_WORKER_CONFIG,'utf8'));
 const role=profile==='planner'?'planner':profile==='reviewer'?'verifier':'builder';
 fs.appendFileSync(config.log,JSON.stringify({pid:process.pid,role,provider:value('--provider'),model:value('--model'),tools:args.includes('--tools')?value('--tools'):null})+'\n');
 if(args.includes('--extension')){
  process.stderr.write('NO_FORCE_KILL_GUARD_READY:v1\n');
  if(args.some(arg=>/worker-no-output-monitor\.ts$/.test(arg)))process.stderr.write('NO_OUTPUT_MONITOR_READY:v1\n');
 }
 const text=role==='planner'?JSON.stringify(config.plan):role==='verifier'?JSON.stringify({status:'pass',reasons:[]}):'Inspected the assigned fixture; no product mutation requested or performed.';
 const message={role:'assistant',content:[{type:'text',text}],stopReason:'stop',usage:{input:1,output:1,totalTokens:2,cost:{input:0,output:0,total:0}}};
 console.log(JSON.stringify({type:'message_end',message}));
 console.log(JSON.stringify({type:'agent_end',messages:[message]}));
});
