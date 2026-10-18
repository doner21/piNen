// Execute the bundled host's publication/notification/stdout/error paths in-process.
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),ts=require(path.join(ROOT,'node_modules/typescript')),redactor=require(path.join(ROOT,'src/streaming-redactor.cjs'));
const check=(ok,label)=>{if(!ok)throw Object.assign(Error(label),{safeLabel:true});};
const assert=require('node:assert/strict');
(async()=>{
 const host=path.join(ROOT,'../agent/skills/headless-orchestration/scripts/orchestrate-host.mjs');let source=fs.readFileSync(host,'utf8');
 const ast=ts.createSourceFile(host,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 source=ast.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(ast)).join('\n');
 const importExpression='await import(pathToFileURL(cfg.sdkEntry).href)';check(source.includes(importExpression),'host SDK import seam');source=source.replace(importExpression,'sdk');
 // Both actual script dispatches reject takeover BEFORE config/auth/SDK I/O.
 const denied=()=>{throw Error('unexpected takeover I/O');};
 await assert.rejects(vm.runInNewContext('(async()=>{'+source+'})()',{process:{argv:['node','host','config','--adopt','run']},validateConfig:denied}),/deferred to round10/);
 const launch=path.join(path.dirname(host),'launch.mjs'),launchAst=ts.createSourceFile(launch,fs.readFileSync(launch,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const launchSource=launchAst.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(launchAst)).join('\n').replace(/\bexport /g,'').replaceAll('import.meta.url','launchUrl');
 await assert.rejects(vm.runInNewContext('(async()=>{'+launchSource+'})()',{path,process:{argv:['node',launch,'--adopt','config','run']},fileURLToPath:()=>launch,launchUrl:'fixture',spawn:denied,fs:new Proxy({},{get:()=>denied})}),/deferred to round10/);
 const secret=crypto.randomBytes(24).toString('hex'),approval=crypto.randomBytes(24).toString('hex');
 const payload={error:{access:secret,refresh:secret,accountId:secret},content:[{type:'thinking',thinkingSignature:secret}],approvalToken:approval,errorMessage:'authentication expired '+secret};
 for(const failed of [false,true]){
  const dir=path.join(process.env.ROUND9_OWNED_RUNTIME,'host-'+failed);fs.mkdirSync(dir);for(const f of ['command.txt','system.md','supervisor.md'])fs.writeFileSync(path.join(dir,f),'fixture');
  const cfg={runDir:dir,cwd:dir,provider:'openai-codex',model:'gpt-6-astra',extension:path.join(ROOT,'src/index.ts'),sdkEntry:'fixture',commandFile:path.join(dir,'command.txt'),systemFile:path.join(dir,'system.md'),supervisorFile:path.join(dir,'supervisor.md')};
  const output=[];let subscriber;
  const session={model:{provider:cfg.provider,id:cfg.model},sessionFile:'isolated-session',messages:[{role:'assistant',stopReason:'error',errorMessage:secret}],getActiveToolNames:()=>['orchestrate'],subscribe:fn=>subscriber=fn,
   bindExtensions:async options=>{options.uiContext.notify(JSON.stringify(payload),'error');options.uiContext.input(JSON.stringify(payload));},prompt:async()=>{
    subscriber({type:'message_end',message:{role:'custom',customType:'orchestrate-result',details:payload}});subscriber({type:'tool_execution_end',toolName:'orchestrate',result:payload});
    fakeProcess.stdout.write('{"refresh_');fakeProcess.stdout.write('token":"'+secret+'"}\n');fakeProcess.stderr.write(secret);
   },waitForIdle:async()=>{},getLastAssistantText:()=>JSON.stringify(payload),dispose(){}};
  const fakeProcess={argv:['node','host','config'],env:{},pid:1,stdout:{write:text=>{output.push(String(text));return true;}},stderr:{write:text=>{output.push(String(text));return true;}}};
  const sdk={ModelRuntime:{create:async()=>{if(failed)throw Error(JSON.stringify(payload));return {getModel:()=>({provider:cfg.provider,id:cfg.model})};}},DefaultResourceLoader:class{async reload(){}getExtensions(){return {errors:[]};}},SessionManager:{create:()=>({})},SettingsManager:{inMemory:()=>({})},createAgentSession:async()=>({session})};
  const context=vm.createContext({fs,path,process:fakeProcess,sdk,validateConfig:()=>({cfg}),childEnvironment:()=>({PI_CODING_AGENT_DIR:dir}),safeHostFailure:()=> 'HEADLESS_HOST_FAILED',continuationCommand:()=>'',createRequire:()=>()=>redactor,console:{error:text=>fakeProcess.stderr.write(text)}});
  await vm.runInContext('(async()=>{'+source+'})()',context);
  for(const name of fs.readdirSync(dir))check(!fs.readFileSync(path.join(dir,name),'utf8').includes(secret)&&!fs.readFileSync(path.join(dir,name),'utf8').includes(approval),'headless persisted output redacted: '+name);
  check(!output.join('').includes(secret)&&!output.join('').includes(approval),'headless streaming stdout/stderr redacted');
 }
 console.log('PASS actual bundled host notifications/results/reports/errors and split stdout/stderr BEFORE shared IO; approval authority not exported');
})().catch(error=>{console.error('HEADLESS_REDACTION_CHECK_FAILED '+(error.safeLabel?error.message:error.name));process.exitCode=1;});
