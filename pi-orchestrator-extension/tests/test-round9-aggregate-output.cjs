// Execute the real aggregate stdout/stderr persistence callbacks at their write boundary.
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),ts=require(path.join(ROOT,'node_modules/typescript'));
const redactors=require(path.join(ROOT,'src/streaming-redactor.cjs'));
const {StreamingSecretRedactor}=redactors;
const source=fs.readFileSync(path.join(ROOT,'tools/check-round9.cjs'),'utf8'),ast=ts.createSourceFile('aggregate.cjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const secret=crypto.randomBytes(24).toString('hex'),fragments=Array.from({length:secret.length-7},(_,i)=>secret.slice(i,i+8));let tested=0;
function visit(node){
 if(ts.isCallExpression(node)&&/^child\.(?:stdout|stderr)\.on$/.test(node.expression.getText(ast))&&node.arguments[0]?.text==='data'){
  const writes=[],context=vm.createContext({...redactors,output:{write:v=>writes.push(String(v))},text:'',environmentMarker:'',environment:undefined,physical:v=>v,inventory:()=>[],record:{},child:{pid:1},descendants:()=>[]});
  const constructors=[];function setup(n){if(ts.isVariableDeclaration(n)&&['stdoutRedactor','stderrRedactor'].includes(n.name?.text))constructors.push('globalThis.'+n.name.text+'='+n.initializer.getText(ast));ts.forEachChild(n,setup);}setup(ast);vm.runInContext(constructors.join(';'),context);
  const callback=vm.runInContext('('+node.arguments[1].getText(ast)+')',context);
  const echoes=Array.from({length:secret.length-1},(_,i)=>[secret.slice(0,i+1),secret.slice(i+1),' '+'.'.repeat(2200)+'\n']).flat();
  for(const chunk of [...echoes,'{"\\u0061ccess"'+' '.repeat(1800)+':"',secret.slice(0,17),secret.slice(17),'"}'+' '.repeat(1800)+'\n',...echoes])callback(Buffer.from(chunk));
  assert.ok(context.environmentMarker.length<=2070,'environment parsing retains only a bounded marker candidate');
  writes.push(context.stdoutRedactor.finish(),context.stderrRedactor.finish());
  for(const write of writes)assert.ok(![secret,secret.slice(0,17),secret.slice(17),...fragments].some(s=>write.includes(s)),'aggregate persistence leaked a credential fragment');
  tested++;
 }
 ts.forEachChild(node,visit);
}
try{visit(ast);assert.equal(tested,2);console.log('PASS real aggregate stdout/stderr writes withhold arbitrary split echoes before/after escaped labels; marker buffer bounded');}catch{console.error('AGGREGATE_OUTPUT_CHECK_FAILED (safe label only)');process.exitCode=1;}
