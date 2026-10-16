const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
module.exports=function ownedTemp(label){
 const owner=process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER;
 if(!owner?.trim()||!path.isAbsolute(owner)||fs.realpathSync.native(owner)!==path.resolve(owner))throw Error('Run through tests/run-isolated.cjs with an owned external temp');
 for(let p=owner;;p=path.dirname(p)){if(fs.lstatSync(p).isSymbolicLink())throw Error('linked scratch refused');if(path.dirname(p)===p)break;}
 const externalTemp=path.join(owner,label+'-'+randomUUID());
 const inside=(a,b)=>{const r=path.relative(path.resolve(a),b);return !r||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};
 for(const excluded of [path.resolve(__dirname,'../..'),'C:/Users/you/pi-orch-round8','C:/Users/you/.pi','C:/Users/you/AppData/Local/Temp/orch-r8-cc1444b3-23c7-4da1-a52f-7903a2c9d2ea'])if(inside(excluded,externalTemp))throw Error('scratch overlaps workspace/frozen/inputs');
 if(!externalTemp.trim()||!path.isAbsolute(externalTemp)||path.resolve(externalTemp)!==externalTemp||fs.existsSync(externalTemp))throw Error('new canonical externalTemp required');
 fs.mkdirSync(externalTemp);
 return externalTemp;
};
