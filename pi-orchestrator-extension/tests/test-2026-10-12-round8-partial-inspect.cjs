const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const jiti=require(path.join(root,'node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs'))(__filename,{interopDefault:true,fsCache:false});
const {captureContentSignatureSnapshot:capture,diffContentSignatureSnapshots:diff}=jiti(path.join(root,'src/write-set.ts'));
const temp=require('./fixtures/round8-owned-temp.cjs')('partial-inspect');
try {
 fs.mkdirSync(path.join(temp,'graphify'));fs.mkdirSync(path.join(temp,'pi-orchestrator-extension'));
 fs.writeFileSync(path.join(temp,'graphify','b.md'),'unchanged');fs.writeFileSync(path.join(temp,'graphify','c.md'),'unchanged');
 fs.writeFileSync(path.join(temp,'pi-orchestrator-extension','index.ts'),'before');
 const before=capture(temp,{maxFiles:2});
 const scopedBefore=capture(temp,{scope:['pi-orchestrator-extension/'],maxFiles:2});
 fs.writeFileSync(path.join(temp,'graphify','a.md'),'new cutoff shifter');
 fs.writeFileSync(path.join(temp,'pi-orchestrator-extension','index.ts'),'after');
 const after=capture(temp,{maxFiles:2});
 assert.equal(before.truncated,true);assert.equal(after.truncated,true);
 assert.deepEqual(diff(before,after),[],'unobserved paths are not confirmed additions/deletions');
 assert.equal(fs.readFileSync(path.join(temp,'graphify','c.md'),'utf8'),'unchanged');
 const scopedAfter=capture(temp,scopedBefore.limits);
 assert.equal(scopedBefore.truncated,false,'scope must not be starved by unrelated Graphify artifacts');
 assert.deepEqual(diff(scopedBefore,scopedAfter).map(c=>[c.path,c.kind]),[['pi-orchestrator-extension/index.ts','modified']]);
 fs.unlinkSync(path.join(temp,'pi-orchestrator-extension','index.ts'));
 assert.equal(diff(scopedAfter,capture(temp,scopedAfter.limits))[0].kind,'deleted','complete scope still confirms actual deletion');
 console.log('PASS cutoff shift honesty and approved-scope byte changes');
}finally{fs.rmSync(temp,{recursive:true,force:true})}
