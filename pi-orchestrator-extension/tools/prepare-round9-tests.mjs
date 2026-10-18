// Builtins-only physical preparation. Invoke through the NEW test wrapper.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const candidate=path.resolve(process.argv[2]),scratch=path.resolve(process.argv[3]);
const parent=path.resolve('C:/Users/you/pi-headless-runs/round9-final-task-bfe0e1c9-be36-4ac1-870e-bb14bd87234a/repair-after-review/coordinator/tests');
const within=(a,b)=>{const r=path.relative(a,b);return !r||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
function physical(p){assert.ok(path.isAbsolute(p));for(let q=p;;q=path.dirname(q)){const s=fs.lstatSync(q,{bigint:true});assert.ok(!s.isSymbolicLink());if(s.isFile())assert.equal(s.nlink,1n);if(q===path.dirname(q))break;}assert.equal(fs.realpathSync.native(p),path.resolve(p));}
physical(candidate);physical(parent);assert.ok(within(parent,scratch)&&scratch!==parent&&!within(candidate,scratch)&&!within(scratch,candidate));
const mode=process.argv[4];
assert.ok(!mode || ['--tests-only','--source-only'].includes(mode));
const roots=mode==='--tests-only'?['pi-orchestrator-extension/tests']:['pi-orchestrator-extension/src','pi-orchestrator-extension/tests','pi-orchestrator-extension/tools','agent/extensions/agent-scheduler','agent/skills/headless-orchestration'];
function validate(p){physical(p);if(fs.lstatSync(p).isDirectory())for(const n of fs.readdirSync(p))validate(path.join(p,n));}
for(const root of roots)validate(path.join(candidate,root));
if(!fs.existsSync(scratch))fs.mkdirSync(scratch);physical(scratch);
const copy=path.join(scratch,'copy');if(!fs.existsSync(copy))fs.mkdirSync(copy);
function copyTree(a,b){physical(a);if(fs.lstatSync(a).isDirectory()){if(!fs.existsSync(b))fs.mkdirSync(b,{recursive:true});physical(b);for(const n of fs.readdirSync(a))copyTree(path.join(a,n),path.join(b,n));}else{if(fs.existsSync(b))physical(b);else fs.mkdirSync(path.dirname(b),{recursive:true});fs.copyFileSync(a,b);physical(b);const x=fs.statSync(a,{bigint:true}),y=fs.statSync(b,{bigint:true});assert.ok(x.dev!==y.dev||x.ino!==y.ino);assert.ok(fs.readFileSync(a).equals(fs.readFileSync(b)));}}
for(const root of roots)copyTree(path.join(candidate,root),path.join(copy,root));
// Preserve the shared launch module and package boundaries, not dependency trees.
copyTree(path.join(candidate,'agent/extensions/lib/pi-child-launch.ts'),path.join(copy,'agent/extensions/lib/pi-child-launch.ts'));
for(const name of fs.readdirSync(path.join(candidate,'pi-orchestrator-extension')).filter(n=>/^(?:package.*\.json|tsconfig.*\.json|README\.md)$/.test(n)))copyTree(path.join(candidate,'pi-orchestrator-extension',name),path.join(copy,'pi-orchestrator-extension',name));
if(!fs.existsSync(path.join(scratch,'runs')))fs.mkdirSync(path.join(scratch,'runs'));
// The scheduler is a sibling package: resolve its type-only dependencies from
// this physical SDK copy rather than the owner's installation or global cache.
const extension=path.join(copy,'pi-orchestrator-extension'),schedulerConfig=path.join(scratch,'scheduler-typecheck.json');
const modules='C:/Users/you/pi-headless-runs/round9-repair-6772b2ed-847b-4581-ae1b-958bed54ac2d/frozen/node_modules';physical(modules);
const compilerOptions={paths:{'*':[path.join(modules,'*')]},typeRoots:[path.join(modules,'@types')]};
fs.writeFileSync(path.join(scratch,'product-typecheck.json'),JSON.stringify({extends:path.join(extension,'tsconfig.next.json'),compilerOptions}));
if(fs.existsSync(schedulerConfig))physical(schedulerConfig);
fs.writeFileSync(schedulerConfig,JSON.stringify({extends:path.join(extension,'tsconfig.next.json'),compilerOptions,include:[path.join(copy,'agent/extensions/agent-scheduler/index.ts')]}));
fs.writeFileSync(path.join(scratch,'prepared.json'),JSON.stringify({candidate,copy,at:new Date().toISOString()}));
console.log('PASS physical independent current-source test copy; existing frozen dependencies are read in place');
