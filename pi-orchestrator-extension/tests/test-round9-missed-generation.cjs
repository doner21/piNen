// Real Windows production inventory: an intermediary is born and gone between tracker samples.
'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),net=require('node:net'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),{observeSync,expectedCommand,descendants,assertExpectedCommands}=require('./fixtures/round9-command-proof.cjs');
(async()=>{
 const sync=cp.spawnSync,observers=[];
 cp.spawnSync=(...args)=>observeSync(sync,observers,...args);require('node:module').syncBuiltinESMExports();
 const {ProcessGenerationTracker,snapshotProcesses,assessProcessTree,assessTreeWithObserver}=await require(path.join(ROOT,'node_modules/jiti'))(__filename,{interopDefault:true,fsCache:false}).import(path.join(ROOT,'src/process-generation.ts'));
 const snap=()=>{const s=snapshotProcesses();assert.equal(s.error,undefined);return s.rows;};
 const initial=snap(),testIdentity=initial.find(r=>r.pid===process.pid),wrapperIdentity=initial.find(r=>r.pid===testIdentity.parentPid);
 const pipe='\\\\.\\pipe\\round9-missed-'+crypto.randomUUID();let peer,middlePeer,connectedResolve,middleResolve;
 const connected=new Promise(resolve=>connectedResolve=resolve),middleReady=new Promise(resolve=>middleResolve=resolve);
 const server=net.createServer(socket=>socket.once('data',data=>{const record=JSON.parse(data);if(record.role==='middle'){middlePeer=socket;middleResolve(record);}else{peer=socket;connectedResolve(record);}}));
 await new Promise(resolve=>server.listen(pipe,resolve));
 const grandchild=`const s=require('net').connect(${JSON.stringify(pipe)});s.on('connect',()=>s.write(JSON.stringify({role:'grandchild',pid:process.pid,parentPid:process.ppid})));s.on('end',()=>s.end());`;
 const middle=`const s=require('net').connect(${JSON.stringify(pipe)});s.on('connect',()=>s.write(JSON.stringify({role:'middle',pid:process.pid})));s.once('data',()=>{const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore'});c.unref();s.end();});`;
 const rootCode=`let started=false;process.stdin.on('data',()=>{if(started)return;started=true;const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:'ignore'});c.on('close',()=>console.log('middle-ended'));});process.stdin.resume();`;
 const root=cp.spawn(process.execPath,['-e',rootCode],{stdio:['pipe','pipe','pipe'],windowsHide:true});root.stderr.resume();
 const rootClosed=new Promise(resolve=>root.once('close',(code,signal)=>resolve({code,signal,completedAt:new Date().toISOString()})));
 const middleEnded=new Promise(resolve=>root.stdout.once('data',resolve));
 await new Promise((resolve,reject)=>{root.once('spawn',resolve);root.once('error',reject);});
 const tracker=new ProcessGenerationTracker(root.pid),rootIdentity=tracker.current().members.find(r=>r.pid===root.pid);
 let identities=[rootIdentity],failure,ended;
 try{
  root.stdin.write('start\n');const intermediary=await middleReady;
  // External cleanup proof observes this helper; the PRODUCTION tracker does
  // not sample it. No fixture waits for the product's inventory publication.
  const before=snap();identities.push(before.find(r=>r.pid===intermediary.pid),...descendants(before,root.pid));
  middlePeer.end('go\n');const grand=await connected;await middleEnded;
  const live=snap(),identity=live.find(r=>r.pid===grand.pid);assert.ok(identity);assert.ok(!live.some(r=>r.pid===grand.parentPid),'intermediary already ended before next production sample');identities.push(identity,...descendants(live,grand.pid));
  root.stdin.end();ended=await rootClosed;assert.equal(ended.code,0);assert.equal(ended.signal,null);
  const tree=tracker.sample();
  assert.notEqual(tree.status,'clean','living grandchild with missed intermediary must not appear clean');
  assert.notEqual(assessProcessTree(tree,{rows:snap()}).status,'clean','inspection/acceptance cannot erase ambiguity');
  assert.notEqual(assessTreeWithObserver(tree,()=>({status:'dead',evidence:'ESRCH'})).status,'clean','adoption cannot erase missing ancestry');
 }catch(error){failure=error;}finally{
  // Also release an intermediary if setup failed before its ordinary handoff.
  if(middlePeer&&!middlePeer.destroyed)middlePeer.end('go\n');
  root.stdin.end();ended=await rootClosed;
  if(peer&&!peer.destroyed){const closed=new Promise(resolve=>peer.once('close',resolve));peer.end();await closed;}
  await new Promise(resolve=>server.close(resolve));
  const rows=snap();cp.spawnSync=sync;require('node:module').syncBuiltinESMExports();
  assert.ok(identities.every(Boolean),'all fixture generation identities independently observed');
  assert.ok(!rows.some(r=>identities.some(g=>g.pid===r.pid)),'all owned root/helper generations independently absent after cooperative EOF');
  assertExpectedCommands(observers);
  const parent=process.argv[2]??process.env.ROUND9_OWNED_RUNTIME;
  for(let p=parent;;p=path.dirname(p)){assert.ok(!fs.lstatSync(p).isSymbolicLink());if(p===path.dirname(p))break;}assert.equal(fs.realpathSync.native(parent),path.resolve(parent));
  const dir=path.join(parent,'m-'+crypto.randomBytes(4).toString('hex'));fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir,'process-proof.json'),JSON.stringify({testIdentity,wrapperIdentity,fixtures:identities,hosts:[],hostProof:[{children:[{pid:root.pid,identity:rootIdentity,expectedCommand:expectedCommand(process.execPath,['-e',rootCode]),...ended}],syncCommands:[],observers}],observers,independentlyAbsentGenerations:[...identities,...observers.flatMap(r=>[r.identity,...r.descendants])].filter(g=>!rows.some(r=>r.pid===g.pid))}));
 }
 if(failure)throw failure;
 console.log('PASS missed intermediary remains non-clean in production inspection/adoption/acceptance; cooperative EOF cleanup independently observed');
})().catch(error=>{console.error('MISSED_GENERATION_CHECK_FAILED '+error.name+' '+error.message);process.exitCode=1;});
