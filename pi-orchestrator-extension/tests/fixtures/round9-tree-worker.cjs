'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),cp=require('node:child_process');
const args=process.argv.slice(2),cfg=JSON.parse(fs.readFileSync(process.env.ROUND9_TREE_CONFIG,'utf8'));
const connect=role=>{const socket=net.connect('\\\\.\\pipe\\'+cfg.pipe);socket.on('connect',()=>socket.write(JSON.stringify({role,pid:process.pid})+'\n'));return socket;};
if(args.includes('--helper')){
 const socket=connect('helper');let released=false;
 // Detached Node owns the ordinary PowerShell child until that child's normal
 // return, avoiding both ConsoleHost's detached startup failure and libuv's
 // job-close cleanup on writer death. The controller closes the window by pipe.
 const window=cp.spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-STA','-File',path.join(__dirname,'round9-owned-window.ps1'),cfg.pipe],{stdio:['pipe','ignore','ignore'],windowsHide:true});
 window.stdin.on('error',()=>{});
 const release=()=>{released=true;window.stdin.end();};
 socket.once('data',release);socket.once('end',release);socket.once('error',()=>{released=true;window.stdin.end();});
 const fail=()=>{if(!released){released=true;socket.write(JSON.stringify({role:'fixture-error',pid:process.pid})+'\n');socket.end();}};
 window.once('close',()=>{fail();socket.end();});window.once('error',fail);
}else{
 const val=flag=>args[args.indexOf(flag)+1],profile=path.basename(val('--append-system-prompt')||'').replace(/-system-prompt\.txt$/,'');
 const role=profile==='planner'?'planner':profile==='reviewer'?'verifier':'writer';
 let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>prompt+=s);
 process.stdin.on('end',()=>{
  fs.appendFileSync(cfg.log,JSON.stringify({pid:process.pid,role,provider:val('--provider'),model:val('--model')})+'\n');
  process.stderr.write('NO_FORCE_KILL_GUARD_READY:v1\nNO_OUTPUT_MONITOR_READY:v1\n');
  const emit=o=>console.log(JSON.stringify(o));emit({type:'agent_start'});
  const finish=()=>{
   let text;
   if(role==='planner')text=JSON.stringify({protected_areas_needed:[],predicted_write_set:['product.txt'],tasks:[{id:'task-1',description:'Create product.txt containing settled writer bytes',dependsOn:[],expectsFileChange:true,outputType:'file_change'}],notes:'One writer then independent review'});
   else if(role==='writer'){
    emit({type:'tool_execution_start',toolName:'write',toolCallId:'write-product',args:{path:'product.txt',content:'settled writer bytes'}});
    fs.writeFileSync(path.join(process.cwd(),'product.txt'),'settled writer bytes');
    emit({type:'tool_execution_end',toolName:'write',toolCallId:'write-product',result:{content:[{type:'text',text:'written'}]},isError:false});
    text='Created product.txt with settled writer bytes.';
   }else {
    emit({type:'tool_execution_start',toolName:'read',toolCallId:'review-product',args:{path:'product.txt'}});
    const matches=!cfg.negativeReview&&fs.readFileSync(path.join(process.cwd(),'product.txt'),'utf8')==='settled writer bytes';
    emit({type:'tool_execution_end',toolName:'read',toolCallId:'review-product',result:{content:[{type:'text',text:matches?'settled bytes verified':'wrong bytes'}]},isError:!matches});
    text=JSON.stringify({status:matches?'pass':'fail',reasons:matches?[]:['settled bytes changed'],criterionFindings:[{criterionId:'AC-01',status:matches?'pass':'fail',evidence:[{kind:'test',observed:'independently read product.txt',exitCode:matches?0:1}]}]});
   }
   const message={role:'assistant',content:[{type:'text',text}],stopReason:'stop',usage:{input:1,output:1,totalTokens:2,cost:{input:0,output:0,total:0}}};
   emit({type:'message_end',message});emit({type:'agent_end',messages:[message]});
  };
  if(role!=='writer'||cfg.mode==='plain')return finish();
  const helper=cp.spawn(process.execPath,[__filename,'--helper'],{env:process.env,stdio:'ignore',windowsHide:true,detached:true});helper.unref();
  let settled=false;
  const socket=connect('root');
  const cancelled=()=>{if(settled)return;settled=true;emit({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'Owned fixture controller closed before settlement'}});emit({type:'agent_end'});socket.end();};
  socket.once('end',cancelled);socket.once('error',cancelled);
  socket.once('data',()=>{
   emit({type:'tool_execution_start',toolName:'read',toolCallId:'tree-ready',args:{path:'product.txt'}});
   socket.once('data',()=>{if(settled)return;settled=true;socket.end();finish();});
  });
 });
}
