#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.resolve(__dirname,'..'),ts=require(path.join(ROOT,'node_modules/typescript'));
function find(file,name){const ast=ts.createSourceFile(file,fs.readFileSync(path.join(ROOT,file),'utf8'),ts.ScriptTarget.Latest,true);let found;function walk(n){if(n.name?.text===name)found=n;ts.forEachChild(n,walk);}walk(ast);return found?.getText(ast).replace(/^export\s+/,'');}
const failures=[];
for(const file of ['src/index.ts','src/substrate.ts']) {
  for(const [name,tools,complete,expected] of [['no-tools-auth',{total:0,mutating:0},true,'worker_infrastructure'],['mutating-auth',{total:1,mutating:1},true,'RESULT_LOST_AFTER_MUTATION'],['unknown-telemetry',{total:0,mutating:0},false,'RESULT_LOST_AFTER_MUTATION']]) {
    const context=vm.createContext({Error,options:{phaseMutates:true},toolCalls:tools,toolTelemetryComplete:complete,sawAgentStart:complete,agentEnded:complete,assistantFailures:['assistant errorMessage=Your authentication token has expired'],lastAssistantText:'',profile:{name:'same-role'},exitCode:0,stderr:'',phaseResult:{incomplete(){},infrastructureFailure(){}},SubagentTerminalAmbiguousError:class extends Error{constructor(_name,info){super(info.code);this.info={...info,retryAllowed:false};}}});
    const extra=['SubagentInfrastructureError','isInfrastructureFailure','isNoToolInfrastructureFailure'].map(n=>find('src/substrate.ts',n)).filter(Boolean).join('\n');
    vm.runInContext(ts.transpileModule(extra+'\nconst '+find(file,'throwAmbiguousIfMutating')+';\nglobalThis.api=throwAmbiguousIfMutating;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
    let error;try{context.api('authentication token expired');}catch(e){error=e;}
    try{assert.equal(error?.info?.code,expected);assert.equal(error.info.retryAllowed,expected==='worker_infrastructure');console.log('PASS '+file+'/'+name);}catch(e){failures.push(file+'/'+name+': '+e.message);console.log('RED '+failures.at(-1));}
  }
}
assert.equal(failures.length,0,failures.join('\n'));
// Use the production executor catch clauses themselves: typed refusals must
// propagate before any repair, split, ordinary failure output or writer replay.
(async()=>{
 for(const file of ['src/index.ts','src/shapes/plan-execute-verify.ts']){
  const ast=ts.createSourceFile(file,fs.readFileSync(path.join(ROOT,file),'utf8'),ts.ScriptTarget.Latest,true),clauses=[];
  function walk(n){if(ts.isCatchClause(n)&&/spawn failed —|handoff continuation spawn failed —|subtask.*spawn failed —/.test(n.block.getText(ast)))clauses.push(n.getText(ast));ts.forEachChild(n,walk);}walk(ast);
  assert.equal(clauses.length,3,'normal/continue/split executor catches covered');
  for(const [index,clause] of clauses.entries())for(const type of ['SubagentInfrastructureError','RetryCleanupError']){
   let repairs=0;
   const context=vm.createContext({Error,emit(){repairs++;throw Error('ORDINARY_REPAIR_REACHED');},SubagentDetachedError:class extends Error{},SubagentTerminalAmbiguousError:class extends Error{},ConfirmedSupervisedAbandonError:class extends Error{}});
   const types=find('src/substrate.ts','SubagentInfrastructureError')+'\n'+find('src/process-generation.ts','RetryCleanupError');
   vm.runInContext(ts.transpileModule(types+`\nglobalThis.refusal=new ${type}();globalThis.check=async()=>{for(const once of [1]){try{throw refusal;} ${clause}}};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
   await assert.rejects(context.check(),error=>error===context.refusal);assert.equal(repairs,0,'no ordinary repair/replay path');console.log('PASS typed executor refusal '+file+'/'+index+'/'+type);
  }
 }
})().catch(()=>{console.error('TYPED_EXECUTOR_REFUSAL_CHECK_FAILED');process.exitCode=1;});
