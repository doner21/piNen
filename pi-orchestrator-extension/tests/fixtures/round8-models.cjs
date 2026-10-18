// Model-free launcher metadata only. fake-pi.cjs handles workers; no model call or credential is used.
const fs=require('node:fs'),path=require('node:path');
module.exports=function prepareModels(agentDir){
  const root=path.resolve(agentDir);
  if(!path.isAbsolute(agentDir)||!agentDir.trim())throw Error('owned absolute agentDir required');
  fs.mkdirSync(root,{recursive:true});
  fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({defaultProjectTrust:'never',retry:{enabled:false,maxRetries:0,provider:{maxRetries:0}},cacheWarming:'off',compaction:{enabled:false}}));
  fs.writeFileSync(path.join(root,'models.json'),JSON.stringify({providers:{'openai-codex':{
    baseUrl:'http://127.0.0.1:9/v1',api:'openai-completions',apiKey:'model-free-fixture',
    models:['gpt-6-astra','gpt-6.1-sol'].map(id=>({id,name:'Model-free fixture '+id,reasoning:false,input:['text'],contextWindow:200000,maxTokens:16000}))
  }}}));
};
