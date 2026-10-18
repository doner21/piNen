const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const temp=require('./fixtures/round8-owned-temp.cjs')('fixture-dispatch');
try {
 const fake=path.join(__dirname,'fake-pi.cjs');
 const invoke=(prompt,env)=>{const r=spawnSync(process.execPath,[fake],{cwd:temp,input:prompt,encoding:'utf8',env:{...process.env,...env}});assert.equal(r.status,0,r.stderr);return r.stdout.trim().split('\n').map(JSON.parse)};
 for(const style of ['round8-missing','round8-outside','round8-protected']) {
  const events=invoke('Plan the following task',{FAKE_PI_PLAN_STYLE:style});
  assert.ok(events.some(e=>e.type==='message_end'),'fixture must deliver planner response, not a transport exception');
 }
 for(const file of ['one.txt','two.txt']) {
  const events=invoke(`You are executing declarative workflow "test", phase "build", iteration 1/1.\n\nOriginal task:\nCREATE file wrong.txt\n\nPhase instructions:\nCREATE file ${file}\n\nExpected output:\nCREATE file also-wrong.txt`,{FAKE_PI_EXECUTOR_STYLE:'write-summary-table'});
  assert.ok(fs.existsSync(path.join(temp,file)),'assigned phase must write its own file');
  const bash=events.find(e=>e.toolName==='bash'&&e.input?.command);
  assert.ok(bash,'command timing needs an actual command event');
  assert.equal(bash.input.command,'node -e '+JSON.stringify(`require('node:fs').statSync(${JSON.stringify(file)})`),'recorded command must match the dispatched script, with replayable quoting');
 }
 const verification=invoke('You are executing declarative workflow "test", phase "verify", iteration 1/1.\n\nPhase instructions:\nVerify missing.txt without file changes.',{});
 const report=verification.find(e=>e.type==='message_end').message.content[0].text;
 assert.match(report,/fail/i,'independent verifier must notice missing phase artifact');
 assert.equal(fs.existsSync(path.join(temp,'wrong.txt')),false);
 assert.equal(fs.existsSync(path.join(temp,'also-wrong.txt')),false);
 console.log('PASS refusal response protocol and assigned phase writes');
} finally {fs.rmSync(temp,{recursive:true,force:true})}
