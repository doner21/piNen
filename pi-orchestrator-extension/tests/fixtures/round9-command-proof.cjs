// Shared expected-command coverage. Missing identities stay in the proof and FAIL.
'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const expectedCommand=(executable,args)=>({executable:String(executable),argvSha256:crypto.createHash('sha256').update(JSON.stringify(args??[])).digest('hex')});
function descendants(rows,pid){const ids=new Set([pid]);let added=true;while(added){added=false;for(const row of rows){const parent=rows.find(p=>p.pid===row.parentPid);if(parent&&ids.has(parent.pid)&&Date.parse(row.born)>=Date.parse(parent.born)&&!ids.has(row.pid)){ids.add(row.pid);added=true;}}}return rows.filter(r=>r.pid!==pid&&ids.has(r.pid));}
const bindSync=original=>{const bound=(executable,args,options)=>{const result=original(executable,args,options);return {...result,completedAt:new Date().toISOString(),expectedCommand:expectedCommand(executable,args)};};bound.__round9NativeSync=original.__round9NativeSync??original;return bound;};
function assertExpectedCommands(records){
 for(const r of records){
  assert.ok(r&&r.identity&&Number.isSafeInteger(r.pid)&&r.identity.pid===r.pid&&Number.isFinite(Date.parse(r.identity.born)),'expected command creation identity missing');
  assert.ok(r.expectedCommand?.executable&&/^[a-f0-9]{64}$/.test(r.expectedCommand.argvSha256),'expected command binding missing');
  assert.ok(r.signal===null&&Number.isInteger(r.code??r.status),'expected command did not complete naturally');
  if(r.creationBinding||/(?:^|[\\/])git(?:\.exe)?$/i.test(r.expectedCommand.executable))assert.ok(r.creationBinding==='waited-process-handle'&&path.basename(r.executable).toLowerCase()==='git.exe'&&/(?:^|[\\/])git(?:\.exe)?$/i.test(r.expectedCommand.executable),'creation-bound expected Git executable mismatch');
  if(r.coverageError)assert.fail('expected command observation failed');
 }
}
function findCommandProof(root,record){
 const fs=require('node:fs');if(!fs.existsSync(root))return undefined;
 const matches=[];
 for(const name of fs.readdirSync(root).filter(n=>n===String(record.pid)||n.startsWith(record.pid+'-'))){
  const file=path.join(root,name,'started.json');if(!fs.existsSync(file))continue;
  const proof=JSON.parse(fs.readFileSync(file));
  if(proof.pid===record.pid&&proof.identity?.pid===record.pid
   &&proof.expectedCommand?.executable===record.expectedCommand?.executable
   &&proof.expectedCommand?.argvSha256===record.expectedCommand?.argvSha256
   &&(!record.identity||proof.identity.born===record.identity.born))matches.push(proof);
 }
 return matches.length===1?matches[0]:undefined; // ambiguity is missing proof, never latest-PID wins
}
function assertExpectedCoverage(expected,coverage){
 for(const command of expected){const found=coverage.filter(r=>r.name===command.name);assert.equal(found.length,1,'missing/duplicate expected aggregate command');const proof=found[0];assert.deepEqual(proof.expectedCommand,command.expectedCommand);assertExpectedCommands([proof.root]);if(command.requiresProof)assert.ok(proof.proofs?.length,'expected SDK command has no retained proof');}
 assert.ok(coverage.every(r=>expected.some(c=>c.name===r.name)),'unexpected aggregate command');
}
/** Execute SDK synchronous Git through a waited .NET process handle. That handle
 * supplies creation time even for a fast Git generation that is gone before a
 * later PID enumeration. No shell, console, signal, timeout or owner action. */
function observeSync(original,records,executable,args=[],options={}){
 original=original.__round9NativeSync??original;
 const expected=expectedCommand(executable,args);
 if(!/(?:^|[\\/])git(?:\.exe)?$/i.test(String(executable))){
  const result=original(executable,args,options),completedAt=new Date().toISOString();let rows=[];try{const v=JSON.parse(String(result.stdout));if(Array.isArray(v))rows=v;}catch{}
  records.push({pid:result.pid,identity:rows.find(r=>r.pid===result.pid),descendants:descendants(rows,result.pid),code:result.status,signal:result.signal,completedAt,expectedCommand:expected});return result;
 }
 const quote=s=>'"'+String(s).replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')+'"';
 const request={executable:String(executable),arguments:args.map(quote).join(' '),cwd:options.cwd??process.cwd()};
 const wrapped=original('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'round9-git-observe.ps1')],{cwd:request.cwd,env:options.env,encoding:'utf8',input:JSON.stringify(request),windowsHide:true,maxBuffer:Math.max(options.maxBuffer??0,16*1024*1024)});
 let proof;
 try{assert.equal(wrapped.status,0);assert.equal(wrapped.signal,null);proof=JSON.parse(wrapped.stdout);assert.ok(proof.git&&proof.wrapper);}catch{
  records.push({pid:wrapped.pid,code:wrapped.status,signal:wrapped.signal,expectedCommand:expected,coverageError:'git_creation_observation_failed'});
  throw Error('GIT_CREATION_OBSERVATION_FAILED');
 }
 records.push({...proof.wrapper,completedAt:new Date().toISOString(),expectedCommand:expectedCommand('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'round9-git-observe.ps1')])});
 records.push({...proof.git,completedAt:new Date().toISOString(),expectedCommand:expected});
 const stdout=Buffer.from(proof.stdout??'','base64'),stderr=Buffer.from(proof.stderr??'','base64');
 const encoding=options.encoding;
 return {pid:proof.git.pid,status:proof.git.code,signal:null,stdout:encoding?stdout.toString(encoding):stdout,stderr:encoding?stderr.toString(encoding):stderr,output:[null,encoding?stdout.toString(encoding):stdout,encoding?stderr.toString(encoding):stderr]};
}
module.exports={expectedCommand,assertExpectedCommands,assertExpectedCoverage,findCommandProof,observeSync,bindSync,descendants,processInventoryRows:require('../../src/process-inventory.cjs').processInventoryRows};
