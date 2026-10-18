// Real SDK lifecycle and both production launchers. All fixture closure is pipe/EOF.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),cp=require('node:child_process'),net=require('node:net'),crypto=require('node:crypto'),{pathToFileURL}=require('node:url');
const ROOT=path.resolve(__dirname,'..'),PS='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const {observeSync,expectedCommand,assertExpectedCommands,bindSync,processInventoryRows}=require('./fixtures/round9-command-proof.cjs');
const nativeSync=cp.spawnSync,originalSync=bindSync(nativeSync);
const descendants=(rows,pid)=>{const ids=new Set([pid]);let added=true;while(added){added=false;for(const row of rows){const parent=rows.find(p=>p.pid===row.parentPid);if(parent&&ids.has(parent.pid)&&Date.parse(row.born)>=Date.parse(parent.born)&&!ids.has(row.pid)){ids.add(row.pid);added=true;}}}return rows.filter(row=>row.pid!==pid&&ids.has(row.pid));};
const observationCommands=[],independentAbsence=new Map();let hostCommands=()=>[];
function retainAbsence(rows,at){for(const record of [...hostCommands(),...observationCommands])for(const g of [record.identity,...(record.descendants??[])].filter(Boolean))if(!rows.some(r=>r.pid===g.pid))independentAbsence.set(g.pid+':'+g.born,{...g,at});}
function snapshot(){
 const r=originalSync(PS,['-NoProfile','-NonInteractive','-Command',"$r=@(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -gt 0} | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='parentPid';e={[int]$_.ParentProcessId}},@{n='born';e={$_.CreationDate.ToUniversalTime().ToString('o')}},@{n='window';e={try{[Diagnostics.Process]::GetProcessById($_.ProcessId).MainWindowHandle.ToInt64()}catch{0}}}); ConvertTo-Json -Compress -InputObject $r"],{encoding:'utf8',windowsHide:true});
 assert.equal(r.status,0);assert.equal(r.signal,null);const rows=JSON.parse(r.stdout);
 observationCommands.push({pid:r.pid,expectedCommand:r.expectedCommand,identity:rows.find(row=>row.pid===r.pid),descendants:descendants(rows,r.pid),code:r.status,signal:r.signal,completedAt:r.completedAt});retainAbsence(rows,r.completedAt);return rows;
}
async function observeWindow(pid,handle,failReadiness=false){
 assert.ok(Number.isSafeInteger(Number(handle))&&Number(handle)>0);
 // Keep this independent observer alive across the existing production sample.
 // Otherwise its own short-lived creator can leave an ambiguous console helper.
 const inventory="$r=@(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -gt 0} | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='parentPid';e={[int]$_.ParentProcessId}},@{n='born';e={$_.CreationDate.ToUniversalTime().ToString('o')}});";
 const args=['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes; $e=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${Number(handle)}); $c=$e.Current; $w=@{pid=$c.ProcessId;visible=(-not $c.IsOffscreen);handle=$c.NativeWindowHandle;name=$c.Name}; ${inventory} ConvertTo-Json -Depth 6 -Compress @{kind='ready';window=$w;rows=$r}; $null=[Console]::In.ReadLine(); ${inventory} ConvertTo-Json -Depth 6 -Compress @{kind='closing';rows=$r}`];
 if(failReadiness)args[args.length-1]=`$ErrorActionPreference='Stop'; ${inventory} ConvertTo-Json -Depth 6 -Compress @{kind='failed';rows=$r}; $null=[Console]::In.ReadLine(); ${inventory} ConvertTo-Json -Depth 6 -Compress @{kind='closing';rows=$r}`;
 const child=cp.spawn(PS,args,{stdio:['pipe','pipe','pipe'],windowsHide:true});child.stderr.resume();child.stdin.on('error',()=>{});
 const record={pid:child.pid,expectedCommand:expectedCommand(PS,args),descendants:[]};observationCommands.push(record);
 let resolveReady,rejectReady,closing;
 const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
 const reader=require('node:readline').createInterface({input:child.stdout});
 reader.on('line',line=>{try{const frame=JSON.parse(line),identity=frame.rows.find(row=>row.pid===child.pid);assert.ok(identity,'observer kernel identity present');if(record.identity)assert.equal(record.identity.born,identity.born);record.identity=identity;record.descendants=[...new Map([...record.descendants,...descendants(frame.rows,child.pid)].map(row=>[row.pid+':'+row.born,row])).values()];retainAbsence(frame.rows,new Date().toISOString());if(frame.kind==='closing')record.closingObserved=true;if(frame.kind==='failed')rejectReady(Error('injected observer readiness failure'));if(frame.kind==='ready')resolveReady(frame.window);}catch{record.coverageError='observer_inventory_unavailable';rejectReady(Error('independent observer inventory unavailable'));}});
 const ended=new Promise(resolve=>child.once('close',(code,signal)=>{Object.assign(record,{code,signal,settled:true,completedAt:new Date().toISOString()});rejectReady(Error('observer ended before readiness'));resolve();}));child.once('error',rejectReady);
 const close=()=>closing??=(async()=>{if(!record.settled)child.stdin.end('finish\n');await ended;reader.close();assert.equal(record.code,0);assert.equal(record.signal,null);assert.ok(record.identity&&record.closingObserved&&!record.coverageError,'complete observer generation inventory retained');})();
 try{const window=await ready;assert.equal(window.pid,pid);assert.equal(window.visible,true,'independent UI Automation sees a visible owned window');assert.ok(window.name==='Round9 owned cooperative cleanup fixture','owned window title');return {window,close};}catch(error){await close();throw error;}
}
async function windowCheck(){
 const mode=process.argv[3]??'normal';assert.ok(['normal','before-connect','before-ready','observer-failure'].includes(mode));
 const pipe='round9-window-'+crypto.randomUUID();let peer,readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 const server=net.createServer(socket=>{peer=socket;let frame='';socket.on('error',readyReject);socket.on('data',chunk=>{frame+=chunk;const n=frame.indexOf('\n');if(n>=0){try{readyResolve(JSON.parse(frame.slice(0,n)));}catch{readyReject(Error('invalid window readiness frame'));}}});if(mode==='before-ready')readyReject(Error('injected failure before window readiness'));});
 await new Promise(resolve=>server.listen('\\\\.\\pipe\\'+pipe,resolve));
 const child=cp.spawn(PS,['-NoProfile','-NonInteractive','-STA','-File',path.join(__dirname,'fixtures/round9-owned-window.ps1'),pipe],{stdio:['pipe','pipe','pipe'],windowsHide:true});child.stdout.resume();child.stderr.resume();child.stdin.on('error',()=>{});child.once('error',readyReject);
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>{readyReject(Error('window closed before readiness'));resolve({code,signal});}));
 let generations=[],failure,window,observer;
 child.once('spawn',()=>{const rows=snapshot();generations=[rows.find(row=>row.pid===child.pid),...descendants(rows,child.pid)];console.log('WINDOW_STAGE spawned '+mode);if(mode==='before-connect'){child.stdin.end();readyReject(Error('injected failure before connection'));}});
 try{const message=await ready;console.log('WINDOW_STAGE fixture_ready '+mode);const rows=snapshot();generations=[...new Map([...generations,rows.find(row=>row.pid===child.pid),...descendants(rows,child.pid)].filter(Boolean).map(g=>[g.pid+':'+g.born,g])).values()];observer=await observeWindow(message.pid,message.handle,mode==='observer-failure');console.log('WINDOW_STAGE observer_ready '+mode);window=observer.window;}catch(error){failure=error;}finally{
  try{await observer?.close();}catch(error){failure??=error;}
  peer?.end('close\n');child.stdin.end();console.log('WINDOW_STAGE closure_requested '+mode);
  const ended=await closed;console.log('WINDOW_STAGE native_close '+mode);assert.equal(ended.code,0);assert.equal(ended.signal,null);
  await new Promise(resolve=>server.close(resolve));const rows=snapshot();assert.ok(generations.length&&generations.every(Boolean),'every owned window root inventoried');assert.ok(generations.every(g=>!rows.some(row=>row.pid===g.pid)));
  fs.writeFileSync(path.join(process.env.ROUND9_OWNED_RUNTIME,'window-proof.json'),JSON.stringify({generations,window,observers:observationCommands,expectedCommand:expectedCommand(PS,['-NoProfile','-NonInteractive','-STA','-File',path.join(__dirname,'fixtures/round9-owned-window.ps1'),pipe])}));
 }
 if(mode==='normal'){if(failure)throw failure;}else assert.ok(failure&&String(failure.message).includes('injected'),'injected early failure actually exercised');
 console.log('PASS independent owned window/helper cooperative closure '+mode);
}
async function host(){
 const incoming=messages(); // own close messages even during SDK/readiness startup
 const cfg=JSON.parse(fs.readFileSync(process.env.ROUND9_TREE_CONFIG,'utf8')),initial=snapshot(),children=[],syncCommands=[];
 const spawn=cp.spawn;cp.spawn=(...args)=>{const child=spawn(...args),r={pid:child.pid,child,settled:false,expectedCommand:expectedCommand(args[0],args[1])};children.push(r);const end=child.stdin?.end.bind(child.stdin);let pending;
  if(end)child.stdin.end=(...a)=>{if(!r.identity){pending=a;return child.stdin;}return end(...a);};
  child.once('spawn',()=>{const rows=snapshot();r.identity=rows.find(row=>row.pid===child.pid);r.descendants=descendants(rows,child.pid);if(pending)end(...pending);});child.once('close',(code,signal)=>Object.assign(r,{settled:true,code,signal,completedAt:new Date().toISOString()}));return child;};
 // Retain exact-birth helper absence at existing production sample boundaries,
 // before a later PID reuse can make the last shutdown snapshot inconclusive.
 hostCommands=()=>[...children,...syncCommands];
 cp.spawnSync=(...args)=>{const result=observeSync(originalSync,syncCommands,...args);try{const rows=processInventoryRows(JSON.parse(String(result.stdout)));if(rows&&!result.error&&result.status===0&&result.signal===null)retainAbsence(rows,new Date().toISOString());}catch{}return result;};
 require('node:module').syncBuiltinESMExports();
 const sdk=await import(pathToFileURL(path.join(ROOT,'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href),settingsManager=sdk.SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false,maxRetries:0},cacheWarming:'off'});
 if(cfg.retry){sdk.ModelRuntime.prototype.completeSimple=async function(model,context){const current=JSON.parse(fs.readFileSync(process.env.ROUND9_TREE_CONFIG));fs.appendFileSync(cfg.probeLog,JSON.stringify({pid:process.pid,provider:model.provider,model:model.id})+'\n');if(!current.restored)throw Error('offline restoration refused');return {stopReason:'stop',content:[{type:'text',text:context.messages[0].content.replace('Reply with exactly ','')}]};};}
 const modelRuntime=await sdk.ModelRuntime.create({allowModelNetwork:false,refreshOnCreate:false,authPath:path.join(process.env.PI_CODING_AGENT_DIR,'auth.json'),modelsPath:path.join(process.env.PI_CODING_AGENT_DIR,'models.json'),modelsStorePath:path.join(process.env.PI_CODING_AGENT_DIR,'models-store.json')});
 const resourceLoader=new sdk.DefaultResourceLoader({cwd:cfg.cwd,agentDir:process.env.PI_CODING_AGENT_DIR,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,additionalExtensionPaths:[path.join(ROOT,'src/index.ts')],systemPrompt:'Offline public lifecycle host; never make a model request.'});
 await resourceLoader.reload();assert.deepEqual(resourceLoader.getExtensions().errors,[]);
 const {session}=await sdk.createAgentSession({cwd:cfg.cwd,agentDir:process.env.PI_CODING_AGENT_DIR,modelRuntime,model:modelRuntime.getModel('openai-codex','gpt-6-astra'),resourceLoader,settingsManager,tools:['orchestrate'],sessionManager:sdk.SessionManager.inMemory(cfg.cwd)});
 await session.bindExtensions({mode:'json',uiContext:{notify(){},setWidget(){},setStatus(){},setEditorText(){},onTerminalInput:()=>()=>{}}});
 const tool=session.agent.state.tools.find(t=>t.name==='orchestrate');
 let latestCommand;session.subscribe(e=>{if(e.type==='message_end'&&e.message?.role==='custom'&&e.message.customType==='orchestrate-result')latestCommand=e.message.details;});
 process.send({ready:true,identity:initial.find(row=>row.pid===process.pid)});
 for await(const message of incoming){
  if(message.close)break;
  let restoreIO=()=>{};
  try{
   if(message.reuse){
    const sync=cp.spawnSync,probe=process.kill,row=message.reuse;
    cp.spawnSync=(...args)=>{const r=sync(...args);if(String(args[0]).toLowerCase().endsWith('powershell.exe')&&args[1]?.some(a=>String(a).includes('Get-CimInstance Win32_Process'))){const rows=JSON.parse(r.stdout);if(processInventoryRows(rows))r.stdout=JSON.stringify([...rows.filter(p=>p.pid!==row.pid),row]);}return r;};
    process.kill=function(pid,...args){return pid===row.pid?true:probe.call(this,pid,...args);};require('node:module').syncBuiltinESMExports();
    restoreIO=()=>{cp.spawnSync=sync;process.kill=probe;require('node:module').syncBuiltinESMExports();};
   }
   let result;
   if(message.command){latestCommand=undefined;await session.prompt(message.command);process.send({ok:Boolean(latestCommand),result:latestCommand});continue;}
   if(message.probe){
    const jiti=require(path.join(ROOT,'node_modules/jiti'))(__filename,{interopDefault:true,fsCache:false});const sub=await jiti.import(path.join(ROOT,'src/substrate.ts'));
    result=await sub.withSubagentPhaseLogging(message.runId,()=>sub.spawnSubagent('planner','Inspect only; do not edit',{cwd:cfg.cwd,agents:new Map([['planner',{name:'planner',provider:'openai-codex',model:'gpt-6-astra',tools:['read','grep','find','ls']}]]),readOnly:true,workerExecutionConstraints:{noForceKill:true}}),3);
   }else if(message.standalone){
    const jiti=require(path.join(ROOT,'node_modules/jiti'))(__filename,{interopDefault:true,fsCache:false});const {spawnSubagent}=await jiti.import(path.join(ROOT,'src/substrate.ts'));
    result=await spawnSubagent('coder','Create product.txt containing settled writer bytes',{cwd:cfg.cwd,agents:new Map([['coder',{name:'coder',provider:'openai-codex',model:'gpt-6.1-sol'}]]),workerExecutionConstraints:{noForceKill:true},phaseLogFile:path.join(cfg.runtime,'standalone.log'),phaseResultFile:path.join(cfg.runtime,'standalone.result.json')});
   }else if(message.race){
    const run=path.join(process.env.PI_ORCHESTRATOR_RUNS_ROOT,message.params.runId),stateFile=path.join(run,'supervision.json'),originalState=fs.readFileSync(stateFile),originalOpen=fs.openSync;
    const phase=fs.readdirSync(run).find(n=>/^phase-.*\.result\.json$/.test(n)),phaseFile=path.join(run,phase),originalPhase=fs.readFileSync(phaseFile);let injected=false;
    fs.openSync=function(file,...args){if(String(file)===stateFile+'.approval.lock'&&!injected){injected=true;if(message.race==='owner'){const v=JSON.parse(originalState);v.runtime.hostInstanceId='800001:100000';fs.writeFileSync(stateFile,JSON.stringify(v));}else{const v=JSON.parse(originalPhase);const tree=v.processTree??v.processTrees?.[0];assert.ok(tree,'real phase inventory exists for fenced evidence control');if(message.race==='settled-evidence')v.heartbeatSequence=99;else tree.unknown.push('injected_fence_gap');fs.writeFileSync(phaseFile,JSON.stringify(v));}}return originalOpen.call(this,file,...args);};
    try{result=await tool.execute('generation-fenced',message.params);}finally{fs.openSync=originalOpen;fs.writeFileSync(stateFile,originalState);fs.writeFileSync(phaseFile,originalPhase);}
   }else result=await tool.execute('generation-fixture',message.params);
   process.send({ok:true,result:message.standalone||message.probe?result:result.details});
  }catch(error){process.send({ok:false,error:'PUBLIC_LIFECYCLE_REFUSED',...(String(error.message).startsWith('ADOPT_REFUSED:')?{adoptRefusal:String(error.message).slice(0,160)}:{})});}finally{restoreIO();}
 }
 session.dispose();cp.spawn=spawn;cp.spawnSync=nativeSync;require('node:module').syncBuiltinESMExports();
 for(const r of children)if(!r.settled)await new Promise(resolve=>r.child.once('close',resolve));
 let cleanupError,cleanupFailure,cleanupStage='command_coverage';
 try{const rows=snapshot();
  const records=[...children,...syncCommands,...observationCommands];assertExpectedCommands(records);
  // This final observer's own snapshot precedes its native return. Export its
  // helpers for the outer host's existing post-close snapshot, not self-proof.
  cleanupStage='nested_generation_comparison';
  for(const r of records.filter(r=>r!==observationCommands.at(-1)))for(const g of [r.identity,...(r.descendants??[])]){
   const current=rows.find(p=>p.pid===g.pid),waitedRoot=g.pid===r.pid&&r.signal===null&&Number.isInteger(r.code);
   const clean=!current||current.born!==g.born&&(independentAbsence.has(g.pid+':'+g.born)||waitedRoot);
   if(!clean)cleanupFailure={stage:cleanupStage,assertion:'nested_generation_requires_absence_or_bound_native_completion',generation:g,comparedObservation:current??null,priorAbsence:independentAbsence.get(g.pid+':'+g.born)??null,nativeRootCompletion:{pid:r.pid,identity:r.identity,code:r.code,signal:r.signal,completedAt:r.completedAt,appliesToComparedGeneration:waitedRoot}};
   assert.ok(clean,'nested helper requires independent absence/completion before reuse');
  }
 }catch{cleanupError='nested_generation_evidence_unresolved';cleanupFailure??={stage:cleanupStage,assertion:'expected_command_creation_and_natural_completion'};}
 // Always return owned shutdown evidence and release IPC, even on a failed
 // cleanup assertion. The caller and outside checker still refuse that proof.
 process.send({closed:true,cleanupError,cleanupFailure,children:children.map(({child,...r})=>r),syncCommands,observers:observationCommands,independentlyAbsentGenerations:[...independentAbsence.values()]});process.disconnect();
}
function messages(){const queue=[];let wake;const listener=m=>{queue.push(m);wake?.();};process.on('message',listener);return {async *[Symbol.asyncIterator](){try{while(true){if(!queue.length)await new Promise(resolve=>wake=resolve);wake=undefined;while(queue.length)yield queue.shift();}}finally{process.off('message',listener);}}};}
function assertFixtureGenerationsEnded(generations,rows,absence){
 // A root's native completion never proves that its descendants ended.
 // Reuse alone is not cleanup, but cannot undo exact kernel absence already
 // retained by the independent observer at an earlier sample boundary.
 for(const generation of generations){const current=rows.find(row=>row.pid===generation.pid);assert.ok(!current||current.born!==generation.born&&absence.has(generation.pid+':'+generation.born),'fixture generation requires independent absence before reuse');}
}
function assertFixtureReuseControls(generations,rows,absence){
 const generation=generations.find(g=>absence.has(g.pid+':'+g.born));
 assert.ok(generation,'full lifecycle independently observed fixture absence');
 const at=absence.get(generation.pid+':'+generation.born).at;
 const reused={...generation,born:new Date(Date.parse(at)+1).toISOString()};
 // Deterministic reuse at the final observation seam, after REAL cooperative
 // closure/absence. Do not rely on the allocator happening to reuse a PID.
 assertFixtureGenerationsEnded([generation],[reused],absence);
 assert.throws(()=>assertFixtureGenerationsEnded([generation],[generation],absence));
 assert.throws(()=>assertFixtureGenerationsEnded([generation],[reused],new Map()));
 assert.throws(()=>assertFixtureGenerationsEnded([generation],[reused],new Map([[reused.pid+':'+reused.born,{...reused,at}]])));
}
async function main(){
 const parent=process.argv[2];assert.ok(parent&&path.isAbsolute(parent));for(let q=parent;;q=path.dirname(q)){assert.ok(!fs.lstatSync(q).isSymbolicLink());if(path.dirname(q)===q)break;}assert.equal(fs.realpathSync(parent),path.resolve(parent));
 const external=path.join(parent,'g-'+crypto.randomBytes(4).toString('hex'));assert.ok(!external.startsWith(path.dirname(ROOT)+path.sep)&&!fs.existsSync(external));fs.mkdirSync(external);
 const roots=[],fixtures=[],allProof=[],initial=snapshot(),testIdentity=initial.find(row=>row.pid===process.pid),wrapperIdentity=initial.find(row=>row.pid===testIdentity.parentPid);
 hostCommands=()=>[...fixtures.map(identity=>({identity})),...roots.map(r=>({identity:r.identity})),...allProof.flatMap(p=>[...p.children,...p.syncCommands,...p.observers])];
 const launcher=await import(pathToFileURL(path.join(ROOT,'../agent/skills/headless-orchestration/scripts/launch.mjs')).href);
 assert.equal(launcher.adoptionCommand,undefined,'headless takeover not exported');assert.equal(launcher.continuationCommand('orc-fixture'),'/orchestrate continue --run-id orc-fixture');assert.throws(()=>launcher.continuationCommand('orc-fixture --replacement'),/VALID_RUN_ID/);
 let failure,stage='start';
 try{for(const mode of (process.argv.includes('--cap-three')||process.argv.includes('--acceptance')?['clean']:process.argv[3]==='--substrate-only'?['substrate-survivor']:process.argv[3]==='--survivor-only'?['survivor']:['clean','survivor','substrate-survivor'])){
  const shortMode={clean:'c',survivor:'s','substrate-survivor':'t'}[mode];
  const cwd=path.join(external,shortMode),runtime=path.join(external,shortMode+'r');fs.mkdirSync(cwd);fs.mkdirSync(runtime);
  const env=launcher.childEnvironment({cwd,runDir:runtime,piCli:path.join(__dirname,'fixtures/round9-tree-worker.cjs')});
  for(const dir of ['agent','runs','next-runs','user-workflows','project-workflows','tmp','cache'])fs.mkdirSync(path.join(runtime,'runtime',dir),{recursive:true});fs.mkdirSync(path.join(runtime,'sessions'));require('./fixtures/round8-models.cjs')(env.PI_CODING_AGENT_DIR);
  const cfg={mode,acceptance:process.argv.includes('--acceptance'),cwd,runtime,pipe:'round9-generation-'+crypto.randomUUID(),log:path.join(runtime,'launches.jsonl')},config=path.join(runtime,'fixture.json');fs.writeFileSync(config,JSON.stringify(cfg));env.ROUND9_TREE_CONFIG=config;
  const peers=new Map(),sockets=new Set(),pending=[],windowObservers=[];let rootReadyResolve,rootReadyReject;const rootReady=new Promise((resolve,reject)=>{rootReadyResolve=resolve;rootReadyReject=reject;});
  const server=net.createServer(socket=>{sockets.add(socket);socket.on('error',()=>rootReadyReject(Error('fixture pipe failed')));let text='';socket.setEncoding('utf8');socket.on('data',chunk=>{text+=chunk;let n;while((n=text.indexOf('\n'))>=0){let record;try{record=JSON.parse(text.slice(0,n));}catch{rootReadyReject(Error('invalid fixture protocol'));return;}text=text.slice(n+1);if(record.role==='fixture-error'){rootReadyReject(Error('owned window/helper startup failed'));continue;}if(peers.has(record.role))continue;peers.set(record.role,{socket,...record});if(peers.size===3)rootReadyResolve();}});});
  await new Promise(resolve=>server.listen('\\\\.\\pipe\\'+cfg.pipe,resolve));
  const startHost=async()=>{
   const child=cp.spawn(process.execPath,['--require',path.join(__dirname,'fixtures/round9-command-preload.cjs'),__filename,'--host'],{cwd,env,stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});child.stderr.resume();child.stdout.resume();
   const queue=[],waiters=[];let settled=false,closing;
   child.on('message',m=>{if(waiters.length)waiters.shift()(m);else queue.push(m);});
   const ended=new Promise(resolve=>child.once('close',()=>{settled=true;const frame={ended:true};while(waiters.length)waiters.shift()(frame);queue.push(frame);resolve();}));
   child.on('error',()=>{});
   const next=()=>queue.length?Promise.resolve(queue.shift()):settled?Promise.resolve({ended:true}):new Promise(resolve=>waiters.push(resolve));
   const r={child,next};roots.push(r);child.once('spawn',()=>{const rows=snapshot();r.identity=rows.find(row=>row.pid===child.pid);});
   r.ask=async message=>{if(!child.connected)return {ended:true};child.send(message);return next();};
   r.close=()=>closing??=(async()=>{if(child.connected){child.send({close:true});let result;do{result=await next();}while(!result.closed&&!result.ended);if(result.closed){allProof.push(result);for(const g of result.independentlyAbsentGenerations??[])independentAbsence.set(g.pid+':'+g.born,g);await ended;snapshot();assert.ok(!result.cleanupError,result.cleanupError);}}await ended;})();
   try{const ready=await next();assert.ok(ready.ready,'SDK host ready');r.identity=ready.identity;return r;}catch(error){await r.close();throw error;}
  };
  let owner;
  try{
   stage='run-'+mode;owner=await startHost();
   const params={action:'run',cwd,supervision:'visible-main',paradigm:'plan-execute-verify',adaptiveSupervision:'off',plannerProvider:'openai-codex',plannerModel:'gpt-6-astra',executorProvider:'openai-codex',executorModel:'gpt-6.1-sol',verifierProvider:'openai-codex',verifierModel:'gpt-6.1-sol',plannerCount:1,executorConcurrency:1,verifierCount:1,maxRetries:mode==='survivor'?1:0,maxSubagents:process.argv.includes('--cap-three')?3:5,noForceKill:true,preflight:false,automaticPlanApproval:true,predictedWriteSet:'product.txt',task:'Create product.txt containing settled writer bytes. Review independently without replay.'};
   if(cfg.acceptance)params.task+=' The measured duration must be <= 1 s.';
   const standalone=mode==='substrate-survivor';const running=owner.ask(standalone?{standalone:true}:{params});await Promise.race([rootReady,running.then(()=>{throw Error('worker settled before owned fixtures became ready');})]);
   const readyRows=snapshot();fixtures.push(...descendants(readyRows,peers.get('root').pid));for(const role of ['window','helper']){const peer=peers.get(role),identity=readyRows.find(row=>row.pid===peer.pid);assert.ok(identity);if(role==='window'){const observer=await observeWindow(peer.pid,peer.handle);windowObservers.push(observer);identity.windowObservation=observer.window;}}
   peers.get('root').socket.write('observe\n');
   // Event-driven durable publication, not a polling/sleep loop. Hold the
   // independent observer through a fresh sample after the read marker; an old
   // helper inventory is not proof that this observer's ancestry was seen.
   // The separate missed-intermediary production test deliberately has NO such barrier.
   await new Promise((resolve,reject)=>{let observedReadSample,watch,done=false;const finish=error=>{if(done)return;done=true;watch?.close();error?reject(error):resolve();};running.then(()=>finish(Error('worker settled before generation readiness')),()=>finish(Error('worker failed before generation readiness')));const runs=standalone?runtime:env.PI_ORCHESTRATOR_RUNS_ROOT;const scan=()=>{try{const files=standalone?[path.join(runtime,'standalone.result.json')]:fs.readdirSync(runs).flatMap(dir=>fs.readdirSync(path.join(runs,dir)).filter(n=>/^phase-.*\.result\.json$/.test(n)).map(n=>path.join(runs,dir,n)));for(const file of files){let r;try{r=JSON.parse(fs.readFileSync(file));}catch{continue;}if(['window','helper'].every(role=>r.processTree?.members.some(m=>m.pid===peers.get(role).pid))&&r.commandTimes?.entries.some(entry=>entry.tool==='read')){if(observedReadSample===undefined){observedReadSample=r.processTree.observedAt;continue;}if(r.processTree.observedAt===observedReadSample)continue;finish();return;}}}catch(e){finish(e);}};watch=fs.watch(runs,{recursive:true},scan);scan();});
   for(const observer of windowObservers)await observer.close();
   if(mode==='clean'){
    for(const role of ['window','helper']){const peer=peers.get(role);pending.push(new Promise(resolve=>peer.socket.once('close',resolve)));peer.socket.end('close\n');}await Promise.all(pending);
    const rows=snapshot();const closedGenerations=['window','helper'].flatMap(role=>{const pid=peers.get(role).pid;return [readyRows.find(r=>r.pid===pid),...descendants(readyRows,pid)];});
    assert.ok(closedGenerations.every(g=>!rows.some(r=>r.pid===g.pid)),'positive window/helper generations ended before writer settlement');
   }
   peers.get('root').socket.write('settle\n');const started=await running;assert.ok(started.ok,'writer reaches checkpoint');if(standalone){
    assert.equal(started.result.processTree.status,'survivors','substrate retains live descendants after root death');
    for(const role of ['window','helper'])assert.ok(started.result.processTree.survivors.some(m=>m.pid===peers.get(role).pid));
    const publication=JSON.parse(fs.readFileSync(path.join(runtime,'standalone.result.json')));assert.equal(publication.status,'complete');assert.equal(publication.processTree.status,'survivors');
    await owner.close();owner=undefined;continue;
   }
   const runId=started.result.runId;assert.equal(started.result.status,'awaiting_supervisor','settled writer checkpoint survives blocked approval issuance');
   if(mode==='survivor'){
    assert.equal(started.result.approvalToken,undefined,'surviving descendants cannot mint dispatch authority');
    assert.ok(!started.result.allowedNextActions.includes('continue'),'checkpoint projects the settlement refusal rather than cancellation');
    const saved=JSON.parse(fs.readFileSync(path.join(env.PI_ORCHESTRATOR_RUNS_ROOT,runId,'supervision.json')));
    assert.equal(saved.checkpoints.at(-1).kind,'executor');assert.equal(saved.checkpoints.at(-1).outcome,'settled');assert.equal(saved.runtime.executorOutputs.length,1,'blocked authority cannot erase settled output');assert.equal(saved.runtime.cursor.stage,'verifier');assert.equal(saved.audit.infrastructureFailures.length,0,'cleanup refusal is not a new worker failure');
   }
   const run=path.join(env.PI_ORCHESTRATOR_RUNS_ROOT,runId),state=JSON.parse(fs.readFileSync(path.join(run,'supervision.json'))),writer=state.runtime.executorOutputs[0];assert.ok(writer.processTree?.members.some(m=>m.pid===peers.get('window').pid),'settled output carries cumulative tree');
   const calls=()=>fs.readFileSync(cfg.log,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls().filter(c=>c.role==='writer').length,1);const bytes=fs.readFileSync(path.join(cwd,'product.txt'));
   const inspected=await owner.ask({params:{action:'inspect',runId}});assert.ok(inspected.ok);assert.equal(inspected.result.liveStatus.processTrees.status,mode==='clean'?'clean':'survivors');
   const reusedRoot={pid:writer.processTree.rootPid,parentPid:1,born:new Date(Date.now()+1000).toISOString()};
   if(mode==='clean'){const before=fs.readFileSync(path.join(run,'supervision.json'));const reused=await owner.ask({reuse:reusedRoot,params:{action:'inspect',runId}});assert.ok(reused.ok);assert.equal(reused.result.liveStatus.going,'not going','public inspection consumes exact settlement despite unrelated root PID reuse');assert.equal(reused.result.liveStatus.activeWorkers.length,0);assert.deepEqual(fs.readFileSync(path.join(run,'supervision.json')),before);}
   const inspectedCommand=await owner.ask({...(mode==='clean'?{reuse:reusedRoot}:{}),command:'/orchestrate inspect --run-id '+runId});assert.ok(inspectedCommand.ok);assert.deepEqual(inspectedCommand.result.allowedNextActions,inspected.result.allowedNextActions,'tool and command enforce identical lifecycle actions');
   if(cfg.acceptance){
    const reviewed=await owner.ask({params:{action:'continue',runId,approvalToken:started.result.approvalToken}});assert.ok(reviewed.ok);assert.equal(reviewed.result.status,'awaiting_supervisor','unconfigured owner numeric target stops at explicit supervisor judgment');assert.ok(reviewed.result.allowedNextActions.includes('accept'),'public acceptance is conditionally available after settled review');
    const token=reviewed.result.approvalToken,accept={action:'accept',runId,approvalToken:token,reason:'Owner disposition for the explicitly unavailable measurement'},before=fs.readFileSync(path.join(run,'supervision.json')),count=calls().length;
    const foreign=await startHost();try{assert.equal((await foreign.ask({params:accept})).ok,false,'public acceptance cannot steal live foreign ownership');assert.equal((await foreign.ask({command:'/orchestrate accept --run-id '+runId+' --approval-token '+token+' --reason "bounded disposition"'})).ok,false,'command acceptance cannot steal ownership');assert.deepEqual(fs.readFileSync(path.join(run,'supervision.json')),before);}finally{await foreign.close();}
    for(const race of ['owner','evidence','settled-evidence']){assert.equal((await owner.ask({race,params:accept})).ok,false,'public locked acceptance refuses changed '+race);assert.deepEqual(fs.readFileSync(path.join(run,'supervision.json')),before);assert.equal(calls().length,count,'acceptance fences dispatch nothing');}
    const accepted=await owner.ask({command:'/orchestrate accept --run-id '+runId+' --approval-token '+token+' --reason "bounded owner disposition"'});assert.ok(accepted.ok);assert.equal(accepted.result.terminalOutcome,'accepted_with_reason');assert.equal(calls().length,count);assert.equal((await owner.ask({params:{action:'continue',runId,approvalToken:token}})).ok,false,'accepted authority cannot be replayed');
    assert.equal(calls().filter(c=>c.role==='writer').length,1);assert.deepEqual(fs.readFileSync(path.join(cwd,'product.txt')),bytes);await owner.close();owner=undefined;continue;
   }
   if(mode==='clean'){
    for(const race of ['owner','evidence'])for(const consume of [false,true]){const count=calls().length,before=fs.readFileSync(path.join(run,'supervision.json'));const reply=await owner.ask({race,params:{action:'continue',runId,...(consume?{approvalToken:started.result.approvalToken}:{})}});assert.equal(reply.ok,false,'public '+(consume?'locked consumption':'approval issuance')+' refuses changed '+race);assert.deepEqual(fs.readFileSync(path.join(run,'supervision.json')),before);assert.equal(calls().length,count,'refused fence dispatches nothing');}
    {const count=calls().length,before=fs.readFileSync(path.join(run,'supervision.json'));const reply=await owner.ask({race:'settled-evidence',params:{action:'continue',runId,approvalToken:started.result.approvalToken}});assert.equal(reply.ok,false,'even still-clean changed evidence invalidates issued authority under consumption lock');assert.deepEqual(fs.readFileSync(path.join(run,'supervision.json')),before);assert.equal(calls().length,count);}
    const foreign=await startHost();try{const original=fs.readFileSync(path.join(run,'supervision.json')),count=calls().length;assert.equal((await foreign.ask({params:{action:'continue',runId}})).ok,false,'live foreign host cannot issue approval');assert.equal((await foreign.ask({command:'/orchestrate continue --run-id '+runId})).ok,false,'command cannot steal live ownership');assert.deepEqual(fs.readFileSync(path.join(run,'supervision.json')),original);assert.equal(calls().length,count);}finally{await foreign.close();}
   }
   if(process.argv.includes('--cap-three')){const probe=await owner.ask({probe:true,runId});assert.ok(probe.ok,'ordinary read-only probe launches through the same durable budget');assert.equal(calls().length,3,'probe is an actual third dispatch before replacement host');}
   if(mode==='clean'){
    const reviewed=await owner.ask({params:{action:'continue',runId,approvalToken:started.result.approvalToken}});
    if(process.argv.includes('--cap-three')){assert.ok(!reviewed.ok||reviewed.result.terminalOutcome!=='pass');assert.equal(calls().length,3,'same-owner probe consumes durable budget; no fourth worker');}
    else {assert.ok(reviewed.ok,'same-owner review dispatch');assert.equal(reviewed.result.terminalOutcome,'pass');assert.equal(JSON.parse(fs.readFileSync(path.join(run,'spawn-budget.json'))).reserved,3);}
   }
   assert.equal(calls().filter(c=>c.role==='writer').length,1,'settled writer never replayed');assert.deepEqual(fs.readFileSync(path.join(cwd,'product.txt')),bytes);
   await owner.close();owner=undefined;
   owner=await startHost();const before=fs.readFileSync(path.join(run,'supervision.json')),count=calls().length;
   assert.equal((await owner.ask({params:{action:'adopt',runId}})).ok,false,'public tool takeover deferred');
   assert.equal((await owner.ask({command:'/orchestrate adopt --run-id '+runId})).ok,false,'public command takeover deferred');
   assert.equal((await owner.ask({params:{action:'continue',runId}})).ok,false,'new host cannot transfer ownership');
   assert.equal((await owner.ask({params:{action:'accept',runId,reason:'not takeover'}})).ok,false,'accept cannot transfer ownership');
   const fresh=await owner.ask({params:{action:'inspect',runId}});assert.ok(fresh.ok);assert.ok(!fresh.result.allowedNextActions.includes('adopt'));
   assert.deepEqual(fs.readFileSync(path.join(run,'supervision.json')),before);assert.equal(calls().length,count,'deferred takeover dispatches nothing');
  }finally{
   // Negative fixtures and independent observers close by EOF even on failure.
   let observerFailure;for(const observer of windowObservers)try{await observer.close();}catch(error){observerFailure??=error;}
   for(const socket of sockets)if(!socket.destroyed)socket.end('close\n');
   await new Promise(resolve=>server.close(resolve));if(owner)await owner.close();
   if(observerFailure)throw observerFailure;
  }
 }}catch(error){failure=error;console.error('SDK_GENERATION_STAGE_FAILED '+stage+' '+String(error.message).replace(/[\r\n]+/g,' ').slice(0,180));}finally{
  const rows=snapshot();
  const recorded=[...fixtures,...roots.map(r=>r.identity),...allProof.flatMap(p=>[...p.children,...p.syncCommands,...p.observers].flatMap(r=>[r.identity,...(r.descendants??[])]))].filter(Boolean);
  const cleanupProof={fixtures,hosts:roots.map(r=>r.identity),hostProof:allProof,observers:observationCommands,currentRecorded:rows.filter(row=>recorded.some(g=>g.pid===row.pid)),testIdentity,wrapperIdentity};
  const cleanupFile=path.join(external,'cleanup-observed.json');fs.writeFileSync(cleanupFile,JSON.stringify(cleanupProof,null,2));
  let finalAssertion='expected_command_coverage';
  try{
  for(const proof of allProof)assertExpectedCommands([...proof.children,...proof.syncCommands,...proof.observers]);
  assertExpectedCommands(observationCommands);
  finalAssertion='fixture_generation_absence';assertFixtureGenerationsEnded(fixtures,rows,independentAbsence);
  finalAssertion='fixture_reuse_controls';if(!failure)assertFixtureReuseControls(fixtures,rows,independentAbsence);
  finalAssertion='host_generation_absence';for(const generation of roots.map(r=>r.identity))assert.ok(!rows.some(row=>row.pid===generation.pid&&row.born===generation.born),'independent generation cleanup including negative path');
  finalAssertion='retained_command_generation_absence';for(const proof of allProof)for(const command of [...proof.children,...proof.syncCommands,...proof.observers]){assert.equal(command.signal,null);for(const generation of [command.identity,...(command.descendants??[])].filter(Boolean)){const current=rows.find(row=>row.pid===generation.pid),waitedRoot=generation.pid===command.pid&&command.signal===null&&Number.isInteger(command.code);assert.ok(!current||current.born!==generation.born&&(waitedRoot||(proof.independentlyAbsentGenerations??[]).some(g=>g.pid===generation.pid&&g.born===generation.born)),'retained independent generation requires absence/completion: '+generation.pid);}}
  const allGenerations=[...fixtures,...roots.map(r=>r.identity),...allProof.flatMap(p=>[...p.children,...p.syncCommands,...p.observers].flatMap(r=>[r.identity,...(r.descendants??[])])),...observationCommands.flatMap(r=>[r.identity,...(r.descendants??[])])].filter(Boolean);
  for(const proof of allProof)for(const g of proof.independentlyAbsentGenerations??[])independentAbsence.set(g.pid+':'+g.born,g);
  for(const g of allGenerations)if(!rows.some(r=>r.pid===g.pid))independentAbsence.set(g.pid+':'+g.born,{...g,at:new Date().toISOString()});
  const independentlyAbsentGenerations=[...independentAbsence.values()];
  finalAssertion='process_proof_publication';fs.writeFileSync(path.join(external,'process-proof.json'),JSON.stringify({testIdentity,wrapperIdentity,fixtures,hosts:roots.map(r=>r.identity),hostProof:allProof,observers:observationCommands,independentlyAbsentGenerations},null,2));
  }catch(error){cleanupProof.failure={stage:'finalization',assertion:finalAssertion};fs.writeFileSync(cleanupFile,JSON.stringify(cleanupProof,null,2));throw error;}
 }
 if(failure)throw failure;
 console.log('PASS public same-owner review/acceptance and survivor refusal, deferred takeover/no replay; both launchers, cooperative window/helper closure');
}
(process.argv[2]==='--host'?host():process.argv[2]==='--window-proof'?windowCheck():main()).catch(error=>{console.error('GENERATION_CHECK_FAILED '+error.name+' '+String(error.message).replace(/[\r\n]+/g,' ').slice(0,200));process.exitCode=1;});
