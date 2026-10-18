// Builtins-only current-source equality and physical-copy check.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const scratch=fs.realpathSync(process.argv[2]),prepared=JSON.parse(fs.readFileSync(path.join(scratch,'prepared.json'))),copy=path.join(scratch,'copy');
const roots=['pi-orchestrator-extension/src','pi-orchestrator-extension/tests','pi-orchestrator-extension/tools','pi-orchestrator-extension/package.json','pi-orchestrator-extension/README.md','agent/skills/headless-orchestration','agent/extensions/agent-scheduler'];
function compare(a,b){for(const p of [a,b]){const s=fs.lstatSync(p,{bigint:true});assert.ok(!s.isSymbolicLink());if(s.isFile())assert.equal(s.nlink,1n);assert.equal(fs.realpathSync.native(p),path.resolve(p));}
 if(fs.lstatSync(a).isDirectory()){const names=fs.readdirSync(a);assert.deepEqual(fs.readdirSync(b),names);for(const n of names)compare(path.join(a,n),path.join(b,n));}
 else{assert.ok(fs.readFileSync(a).equals(fs.readFileSync(b)),'current tested bytes differ: '+path.relative(prepared.candidate,a));const x=fs.statSync(a,{bigint:true}),y=fs.statSync(b,{bigint:true});assert.ok(x.dev!==y.dev||x.ino!==y.ino);}}
for(const root of roots)compare(path.join(prepared.candidate,root),path.join(copy,root));
console.log('PASS current-source byte equality and independent physical tested source');
