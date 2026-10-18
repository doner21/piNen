'use strict';
// Test dependency resolution only. No SDK/source/dependency copies or transforms.
const fs=require('node:fs'),path=require('node:path'),{registerHooks,createRequire,isBuiltin}=require('node:module'),{pathToFileURL,fileURLToPath}=require('node:url');
const frozen='C:/Users/you/pi-headless-runs/round9-repair-6772b2ed-847b-4581-ae1b-958bed54ac2d/frozen';
const modules=path.join(frozen,'node_modules');
for(let p=frozen;;p=path.dirname(p)){if(fs.lstatSync(p).isSymbolicLink())throw Error('TEST_DEPENDENCY_LINK');if(p===path.dirname(p))break;}
if(fs.realpathSync.native(frozen)!==path.resolve(frozen))throw Error('TEST_DEPENDENCY_NONCANONICAL');
const nativeRequire=createRequire(path.join(frozen,'package.json'));
process.env.JITI_ALIAS=JSON.stringify(Object.fromEntries([['@earendil-works/pi-coding-agent','@earendil-works/pi-coding-agent/dist/index.js'],['@earendil-works/pi-ai','@earendil-works/pi-ai/dist/compat.js'],['typebox','typebox/build/index.mjs']].map(([name,file])=>[name,path.join(modules,file)])));
process.env.JITI_NATIVE_MODULES=JSON.stringify(['@earendil-works/pi-coding-agent','@earendil-works/pi-ai','@earendil-works/pi-agent-core','@earendil-works/pi-tui','typebox','chalk']);
let resolving=false;
function resolveNative(specifier){resolving=true;try{return nativeRequire.resolve(specifier);}finally{resolving=false;}}
registerHooks({resolve(specifier,context,next){
 if(resolving)return next(specifier,context);
 if(isBuiltin(specifier))return next(specifier,context);
 let file=specifier.startsWith('file:')?fileURLToPath(specifier):specifier;
 const normalized=file.replaceAll('\\','/'),marker='/node_modules/';
 if(normalized.includes(marker)&&!normalized.startsWith(modules.replaceAll('\\','/')+'/')){
  let relative=normalized.slice(normalized.indexOf(marker)+marker.length);
  if(relative==='@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs')relative='jiti/lib/jiti.cjs';
  file=resolveNative(path.join(modules,relative));return {url:pathToFileURL(file).href,shortCircuit:true};
 }
 if(!specifier.startsWith('.')&&!specifier.startsWith('node:')&&!specifier.startsWith('file:')&&!path.isAbsolute(specifier)){
  try{return {url:pathToFileURL(resolveNative(specifier)).href,shortCircuit:true};}catch(error){if(error.code!=='MODULE_NOT_FOUND'&&error.code!=='ERR_PACKAGE_PATH_NOT_EXPORTED')throw error;}
 }
 return next(specifier,context);
}});
module.exports={frozen,modules};
