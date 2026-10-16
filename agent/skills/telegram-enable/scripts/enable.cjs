'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
async function enable({agentDir,core}){
 const base=path.join(agentDir,'telegram-pi'),selected=core.selectRuntime(base);
 if(selected.mode!=='topics')throw Error('Topics deployment required; legacy polling was not changed');
 const client=new core.Client({dir:selected.dir,identity:{id:'automatic-logon-setting-check'},onDelivery:()=>false});
 try{const status=await client.request('status');if(status.mode!=='topics'||!status.polling||status.lastError)throw Error('Topic router is not healthy; automatic logon setting was not changed');}
 finally{await client.close();}
 const file=path.join(selected.dir,'session-settings.json');let settings={};
 try{settings=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('Session settings unreadable; no changes made');}
 if(!settings||typeof settings!=='object'||Array.isArray(settings))throw Error('Invalid session settings; no changes made');
 await core.atomic(file,{...settings,autoLogon:true});
 const check=JSON.parse(await fs.readFile(file,'utf8'));if(check.autoLogon!==true)throw Error('Automatic logon write could not be verified');
 return{ok:true,automaticLogon:true,appliesTo:'future interactive/RPC Pi sessions',currentWindowLoggedOnByThisCommand:false};
}
if(require.main===module){
 if(process.argv[2]!=='--enable'){console.error('Explicit --enable required; no settings changed');process.exitCode=1;}
 else{const agentDir=process.env.PI_CODING_AGENT_DIR||path.join(os.homedir(),'.pi','agent');let core;
  try{core=require(path.join(agentDir,'extensions','telegram-pi','multi-session.cjs'));}catch{console.error('Installed topic bridge unavailable; no settings changed');process.exitCode=1;}
  if(core)enable({agentDir,core}).then(value=>console.log(JSON.stringify(value))).catch(()=>{console.error('Automatic logon could not be verified. No Pi window was restarted or logged on.');process.exitCode=1;});
 }
}
module.exports={enable};
