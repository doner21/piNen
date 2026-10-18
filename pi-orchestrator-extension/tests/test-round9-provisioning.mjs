import runtime from '../tools/round9-runtime.cjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { provisionIsolatedLogin, validateIsolatedLogin } from '../../agent/skills/headless-orchestration/scripts/launch.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function canonical(p) {
  assert.ok(p && path.isAbsolute(p),'absolute externalTemp required');
  for(let q=p;;q=path.dirname(q)){const s=fs.lstatSync(q);assert.ok(!s.isSymbolicLink(),'no linked ancestors');if(s.isFile())assert.equal(s.nlink,1);if(path.dirname(q)===q)break;}
  assert.equal(fs.realpathSync(p),path.resolve(p));return p;
}
const parent=canonical(process.argv[2]),externalTemp=path.join(parent,'provision-'+randomBytes(8).toString('hex'));
const relative=path.relative(path.dirname(ROOT),externalTemp);assert.ok(relative==='..'||relative.startsWith('..'+path.sep));
assert.ok(path.isAbsolute(externalTemp)&&!fs.existsSync(externalTemp));fs.mkdirSync(externalTemp);canonical(externalTemp);
const runDir=path.join(externalTemp,'run'),cwd=path.join(externalTemp,'candidate');
fs.mkdirSync(cwd);fs.mkdirSync(runDir);
for(const name of ['sessions','runtime','runtime/agent','runtime/runs','runtime/next-runs','runtime/user-workflows','runtime/project-workflows','runtime/tmp','runtime/cache'])fs.mkdirSync(path.join(runDir,name),{recursive:true});
const packageRoot=canonical(path.join(runtime.modules,'@earendil-works/pi-coding-agent'));
const cfg={nodeExe:process.execPath,cwd,frozenRoot:runtime.frozen,extension:path.join(runtime.frozen,'pi-orchestrator-extension/src/index.ts'),sdkEntry:canonical(path.join(packageRoot,'dist/index.js')),piCli:canonical(path.join(packageRoot,'dist/cli.js')),runDir,systemFile:path.join(runDir,'system.md'),commandFile:path.join(runDir,'command.txt'),supervisorFile:path.join(runDir,'supervisor.md'),evidenceRoots:[],provider:'openai-codex',model:'gpt-6-astra',credentialRenewalOwner:'independent-runtime-login'};
const command='/orchestrate run --supervision visible-main --adaptive-supervision off --planner-provider openai-codex --planner-model gpt-6-astra --executor-provider openai-codex --executor-model gpt-6.1-sol --verifier-provider openai-codex --verifier-model gpt-6.1-sol --planner-count 1 --executor-concurrency 1 --verifier-count 1 --max-retries 0 --paradigm plan-execute-verify --no-force-kill -- inspect fixture';
fs.writeFileSync(cfg.systemFile,'Fixture only');fs.writeFileSync(cfg.supervisorFile,'Fixture only');fs.writeFileSync(cfg.commandFile,command);
const config=path.join(runDir,'config.json');fs.writeFileSync(config,JSON.stringify(cfg));
const source=path.join(runDir,'supplied.json'),target=path.join(runDir,'runtime/agent/auth.json');
const credential=()=>({type:'oauth',access:randomBytes(24).toString('hex'),refresh:randomBytes(24).toString('hex'),accountId:'fixture',expires:Date.now()+3600000});
const one=credential(),two=credential(),other={type:'api_key',key:randomBytes(24).toString('hex')};
const put=x=>fs.writeFileSync(source,JSON.stringify(x),{mode:0o600});
const failures=[];async function check(name,fn){try{await fn();console.log('PASS '+name);}catch(error){failures.push(name);console.log('RED '+name+' ['+(String(error.message).match(/^[A-Z_]+(?=:|$)/)?.[0]??error.name)+']');}}
await check('missing source refuses',async()=>assert.rejects(()=>provisionIsolatedLogin(config,source)));
await check('malformed source refuses without creating target',async()=>{fs.writeFileSync(source,'{');await assert.rejects(()=>provisionIsolatedLogin(config,source),/LOGIN_MALFORMED/);assert.ok(!fs.existsSync(target));});
await check('expired source refuses',async()=>{put({'openai-codex':{...one,expires:0}});await assert.rejects(()=>provisionIsolatedLogin(config,source),/LOGIN_MALFORMED_OR_EXPIRED/);});
put({'openai-codex':one});
await check('SDK private provisioning preserves unrelated providers',async()=>{fs.writeFileSync(target,JSON.stringify({unrelated:other}),{mode:0o600});const status=await provisionIsolatedLogin(config,source);const saved=JSON.parse(fs.readFileSync(target,'utf8'));assert.ok(JSON.stringify(saved.unrelated)===JSON.stringify(other));assert.ok(JSON.stringify(saved['openai-codex'])===JSON.stringify(one));assert.equal(status.remoteValidity,'unverified');});
await check('safe replacement uses supported provider store',async()=>{put({'openai-codex':two});await provisionIsolatedLogin(config,source);const saved=JSON.parse(fs.readFileSync(target,'utf8'));assert.ok(JSON.stringify(saved['openai-codex'])===JSON.stringify(two));assert.ok(JSON.stringify(saved.unrelated)===JSON.stringify(other));});
await check('malformed target is refused unchanged',async()=>{for(const raw of ['[]','"malformed"','null','{']){fs.writeFileSync(target,raw);await assert.rejects(()=>provisionIsolatedLogin(config,source));assert.ok(fs.readFileSync(target,'utf8')===raw);}});
fs.writeFileSync(target,JSON.stringify({unrelated:other,'openai-codex':two}));
// Forbidden topology is injected, never created on disk.
const original=fs.lstatSync;
for(const [name,file,patch] of [['source hardlink',source,{nlink:2}],['target hardlink',target,{nlink:2}],['source symlink',source,{isSymbolicLink:()=>true}],['runtime junction',path.join(runDir,'runtime'),{isSymbolicLink:()=>true}]])await check(name+' refuses',async()=>{
  fs.lstatSync=function(p,...args){const stat=original.call(fs,p,...args);if(path.resolve(String(p))!==file)return stat;return new Proxy(stat,{get:(o,k)=>k in patch?patch[k]:typeof o[k]==='function'?o[k].bind(o):o[k]});};
  try{await assert.rejects(()=>provisionIsolatedLogin(config,source));}finally{fs.lstatSync=original;}
  assert.ok(JSON.parse(fs.readFileSync(target,'utf8')).unrelated.key===other.key);
});
assert.equal(validateIsolatedLogin(cfg).sharedRenewal,'unavailable-manual-reprovisioning');
assert.equal(failures.length,0,failures.join('; '));
console.log('PASS real filesystem and owned SDK credential-store tests; no network or live login used');
