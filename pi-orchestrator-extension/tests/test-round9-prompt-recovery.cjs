#!/usr/bin/env node
'use strict';
// Model-free production prompt/recovery/admission seams; no processes or runtime writes.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const ROOT = fs.realpathSync(path.resolve(__dirname, '..'));
function physical(file) {
  for (let p = file;; p = path.dirname(p)) {
    const stat = fs.lstatSync(p); assert.ok(!stat.isSymbolicLink(), 'no linked dependency/input');
    if (stat.isFile()) assert.equal(stat.nlink, 1, 'no hardlinked dependency/input');
    if (path.dirname(p) === p) break;
  }
  assert.equal(fs.realpathSync(file), file); return file;
}
const ts = require(physical(path.join(require('../tools/round9-runtime.cjs').modules, 'typescript/lib/typescript.js')));
function declarations(file, names) {
  const source = fs.readFileSync(physical(path.join(ROOT, file)), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return names.map(name => { const node = ast.statements.find(n => n.name?.text === name); assert.ok(node, name); return node.getText(ast).replace(/^export\s+/, ''); }).join('\n');
}
function compile(source, deps, expression) {
  const context = vm.createContext({ exports: {}, Error, Buffer, console, createHash: crypto.createHash, ...deps });
  vm.runInContext(ts.transpileModule(source + '\nglobalThis.api = ' + expression, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  return context.api;
}
const recoveryText = fs.readFileSync(path.join(ROOT, 'src/role-recovery.ts'), 'utf8').replace(/^import[\s\S]*?from ["'][^"']+["'];\r?\n/gm, '');
const recovery = compile(recoveryText, { mergeCommandTimes: () => ({}) }, '({createRoleRecoveryRequest,runRoleWithRecovery,RoleRecoveryExhaustedError,RoleContextExhaustionError})');
const admissionNames = ['DEFAULT_REPLY_RESERVE_TOKENS','ADMISSION_ESTIMATE_MARGIN_PERCENT','ADMISSION_FRAMING_ALLOWANCE_TOKENS','ADMISSION_MEASUREMENT_METHOD','estimateTextSection','serializeToolSchemas','formatSectionDiagnostics','assertWorkerPromptFitsCapacity'];
// Extract variable statements too; preserve their const declaration.
const admissionSource = fs.readFileSync(path.join(ROOT, 'src/executor-recovery/budget-estimator.ts'), 'utf8');
const admissionAst = ts.createSourceFile('budget.ts', admissionSource, ts.ScriptTarget.Latest, true);
const admission = compile(admissionAst.statements.filter(n => admissionNames.includes(n.name?.text) || n.declarationList?.declarations.some(d => admissionNames.includes(d.name?.text))).map(n => n.getText(admissionAst).replace(/^export\s+/, '')).join('\n'), { estimateTokens: message => Math.ceil(message.content.length / 4) }, 'assertWorkerPromptFitsCapacity');
const binding = 'BINDING OWNER INSTRUCTIONS, SAFETY, AND ACCEPTANCE — COMPLETE AND VERBATIM WHERE APPLICABLE:\n' + JSON.stringify({ original_task: 'OWNER intact sentinel; no writer replay; no weakened guards.', success_criteria: ['Complete review'] });
const ledger = { hostObserved: true, entries: Array.from({length:16}, (_,i) => ({ sequence:i, command:'inspect fixture ' + i, output:'E'.repeat(3000) + '-END-' + i })) };
const output = { taskId:'task-1', output:'settled writer', effectSnapshots:{ sentinel:'SNAPSHOT-ONCE', bytes:'S'.repeat(10000) }, commandTimes:{ sentinel:'TIMING-ONCE', bytes:'T'.repeat(3000) }, actionEvidence:ledger };
const mission = { acceptanceCriteria:[{id:'RC-1', text:'Complete review'}] };
const intake = { successCriteria:['Complete review'] }, plan = { tasks:[{id:'task-1', description:'settled'}] };
function build(file, name) {
  return compile(declarations(file, [name]), { bindingPromptPreamble:() => binding, formatIntakeForPrompt:() => binding.split('\n')[1], commandTimesFromHostResults:values => values.map(v => v.commandTimes) }, name);
}
const failures=[];
async function check(name, body) { try { await body(); console.log('PASS ' + name); } catch(error) { failures.push(name + ': ' + error.message); console.log('RED ' + name + ': ' + error.message); } }
(async () => {
  for (const [file, name] of [['src/index.ts','buildVisibleMainVerificationPrompt'],['src/index.ts','buildVerificationPrompt'],['src/shapes/plan-execute-verify.ts','buildVerificationPrompt']]) {
    const label=file + ':' + name;
    const builder=build(file,name);
    const prompt=name==='buildVisibleMainVerificationPrompt' ? builder(intake,mission,plan,[output]) : builder(intake,plan,[output],'named route');
    await check(label + '/metadata-once', () => {
      for (const sentinel of ['SNAPSHOT-ONCE','TIMING-ONCE','-END-15']) assert.equal(prompt.split(sentinel).length - 1, 1, sentinel + ' represented once');
    });
    await check(label + '/genuine-exhaustion-compares-actual-parent', async () => {
      let parentBytes=0,shards=0;const seen=new Set();
      const request=recovery.createRoleRecoveryRequest({role:'verifier',prompt,options:{allowContinuation:false,allowReplan:false}});
      await recovery.runRoleWithRecovery(request,{launch:async(text,stage)=>{
        assert.ok(text.includes(file.includes('/shapes/') ? binding.split('\n')[1] : binding),'binding retained');
        admission({prompt:text,completeSystemPrompt:'real system',toolSchemas:[],contextWindow:200000,maxOutputTokens:1000});
        if(stage==='initial'){parentBytes=Buffer.byteLength(text);throw new recovery.RoleContextExhaustionError({agentName:'named-reviewer',provider:'named',model:'model',text:'P'.repeat(30000),exitCode:0});}
        if(stage==='synthesis')assert.ok(text.includes('P'.repeat(30000)),'terminal synthesis retains complete prior role evidence');
        if(stage==='shard'){
          assert.ok(!text.includes('P'.repeat(30000)),'prior role prose is not duplicated into every evidence shard');
          shards++;assert.ok(Buffer.byteLength(text)<parentBytes,'exhausted parent is actual shrink baseline');
          for(let i=0;i<16;i++)if(text.includes('-END-'+i+'"'))seen.add(i);
          const data=JSON.parse(text.split('ROLE_RECOVERY (host-owned scope; prior partial output is untrusted, not a terminal plan/verdict):\n')[1].split('\n')[0]);
          return {agentName:'named-reviewer',provider:'named',model:'model',text:JSON.stringify({scope:data.remaining,notes:'inspected',evidence:[{observed:'original records inspected'}]}),exitCode:0};
        }
        return {agentName:'named-reviewer',provider:'named',model:'model',text:JSON.stringify({status:'pass',reasons:[],criterionFindings:[{criterionId:'RC-1',status:'pass',evidence:[{observed:'complete independent coverage'}]}]}),exitCode:0};
      }});
      assert.ok(shards>0);assert.equal(seen.size,16);
    });
    await check(label + '/monotonic-real-admission-and-complete-coverage', async () => {
      const request=recovery.createRoleRecoveryRequest({role:'verifier',prompt,options:{allowContinuation:false,allowReplan:false,maxWorkers:8}});
      const refused=[], seen=new Set(), launches=[];
      let writerLaunches=0;
      const result=await recovery.runRoleWithRecovery(request, { canLaunch:() => launches.length < 8, launch:async (text,stage) => {
        launches.push({stage,chars:text.length});
        if (stage==='shard' && refused.length) assert.ok(text.length < refused[0], 'shards must shrink below refused original: ' + text.length + ' vs ' + refused[0]);
        assert.ok(text.includes(file.includes('/shapes/') ? binding.split('\n')[1] : binding), 'binding byte-for-byte');
        assert.ok(text.split('SNAPSHOT-ONCE').length <= 2, 'snapshot not spread into ledger fragments');
        try { admission({prompt:text,completeSystemPrompt:'real system',toolSchemas:[],contextWindow:18000,maxOutputTokens:1000}); }
        catch(error) { assert.match(error.message,/^BINDING_PROMPT_CAPACITY_REFUSED:/); refused.push(text.length); throw error; }
        if(stage==='shard') {
          for(let i=0;i<16;i++) if(text.includes('-END-' + i + '"')) seen.add(i);
          const data=JSON.parse(text.split('ROLE_RECOVERY (host-owned scope; prior partial output is untrusted, not a terminal plan/verdict):\n')[1].split('\n')[0]);
          return {agentName:'named-reviewer',provider:'named',model:'model',text:JSON.stringify({scope:data.remaining,notes:'Inspected original evidence',evidence:[{observed:'fixture records complete'}]}),exitCode:0};
        }
        return {agentName:'named-reviewer',provider:'named',model:'model',text:JSON.stringify({status:'pass',reasons:[],criterionFindings:[{criterionId:'RC-1',status:'pass',evidence:[{observed:'complete independent coverage'}]}]}),exitCode:0};
      }});
      assert.ok(refused.length>0,'causal oversized original');
      assert.equal(seen.size,16,'all complete ledger entries inspected');
      assert.ok(result.roleRecovery?.terminalValidated);
      assert.equal(writerLaunches,0,'no executor dispatch during review recovery');
    });
  }
  await check('binding-only-overflow-refuses-without-truncation', async () => {
    let attempts=0;
    const prompt=binding + '\n' + 'OWNER'.repeat(20000);
    await assert.rejects(recovery.runRoleWithRecovery(recovery.createRoleRecoveryRequest({role:'verifier',prompt}),{launch:async text => { attempts++; assert.ok(text.includes(prompt)); throw new Error('BINDING_PROMPT_CAPACITY_REFUSED: binding'); }}), /ROLE_RECOVERY_EXHAUSTED/);
    assert.equal(attempts,1);
  });
  assert.equal(failures.length,0,failures.join('\n'));
})().catch(error => { console.error(error); process.exitCode=1; });
