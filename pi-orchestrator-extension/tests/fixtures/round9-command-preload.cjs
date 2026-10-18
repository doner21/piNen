// One-shot creation-bound command/Git observation, including failed assertions.
// beforeExit does only synchronous observation; it never schedules an observer loop.
'use strict';
require("../../tools/round9-runtime.cjs");
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),{syncBuiltinESMExports}=require('node:module');
const {observeSync,expectedCommand,bindSync,descendants}=require('./round9-command-proof.cjs');
const parent=process.env.ROUND9_OWNED_RUNTIME;
if(!parent||!path.isAbsolute(parent)||!parent.includes(path.join('repair-after-review','coordinator','tests')))throw Error('OWNED_COMMAND_PROOF_ROOT_REQUIRED');
for(let p=parent;;p=path.dirname(p)){if(fs.lstatSync(p).isSymbolicLink())throw Error('LINKED_COMMAND_PROOF_ROOT');if(path.dirname(p)===p)break;}
const original=cp.spawnSync,sync=bindSync(original),records=[],observers=[];
const snapshot=()=>{const r=sync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-Command',"$r=@(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -gt 0} | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='parentPid';e={[int]$_.ParentProcessId}},@{n='born';e={$_.CreationDate.ToUniversalTime().ToString('o')}}); ConvertTo-Json -Compress -InputObject $r"],{encoding:'utf8',windowsHide:true});const rows=JSON.parse(r.stdout);observers.push({pid:r.pid,identity:rows.find(p=>p.pid===r.pid),descendants:descendants(rows,r.pid),expectedCommand:r.expectedCommand,code:r.status,signal:r.signal,completedAt:r.completedAt});return rows;};
const rows=snapshot(),identity=rows.find(p=>p.pid===process.pid),wrapperIdentity=rows.find(p=>p.pid===identity?.parentPid),members=descendants(rows,process.pid);
cp.spawnSync=(...args)=>/(?:^|[\\/])git(?:\.exe)?$/i.test(String(args[0]))?observeSync(original,records,...args):original(...args);
cp.spawnSync.__round9NativeSync=original.__round9NativeSync??original;syncBuiltinESMExports();
const dir=path.join(parent,'command-proofs',process.pid+'-'+require('node:crypto').randomUUID());fs.mkdirSync(dir,{recursive:true});
const own={pid:process.pid,identity,descendants:members,expectedCommand:expectedCommand(process.execPath,process.execArgv.concat(process.argv.slice(1)))};
fs.writeFileSync(path.join(dir,'started.json'),JSON.stringify(own));
process.once('beforeExit',code=>{
 const current=snapshot();
 const generations=[...members,...records.flatMap(r=>[r.identity,...(r.descendants??[])]),...observers.flatMap(r=>[r.identity,...(r.descendants??[])])];
 fs.writeFileSync(path.join(dir,'process-proof.json'),JSON.stringify({testIdentity:identity,wrapperIdentity,hostProof:[{children:[{...own,code,signal:null}],syncCommands:records,observers}],observers,independentlyAbsentGenerations:generations.filter(g=>g&&!current.some(p=>p.pid===g.pid))},null,2));
});
