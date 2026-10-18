const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const jiti=require(path.join(root,'node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs'))(__filename,{interopDefault:true,fsCache:false});
const {refreshLiveStatus}=jiti(path.join(root,'src/live-status.ts'));
const temp=require('./fixtures/round8-owned-temp.cjs')('phase-status');
try {
 const phases=[{index:0,name:'build-one',status:'done'},{index:1,name:'verify-one',status:'pending'}];
 fs.writeFileSync(path.join(temp,'state.json'),JSON.stringify({phases}));
 const observed=refreshLiveStatus(temp,{observeProcess:()=>({status:'dead',evidence:'ESRCH'})},{runId:'fixture-phases',status:'awaiting_supervisor',audit:{activeWorkers:[],detachedWorkers:[],infrastructureFailures:[]}});
 assert.deepEqual(observed.phases,phases,'settled/pending phases must be visible without pretending a stopped worker is active');
 assert.equal(observed.phase,null,'active phase remains absent at a settled checkpoint');
 console.log('PASS settled phase statuses with truthful stopped-phase label');
}finally{fs.rmSync(temp,{recursive:true,force:true})}
