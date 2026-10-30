import test from 'node:test';
import assert from 'node:assert/strict';
import { clientRemote, remote } from './bridge.mjs';
const health = () => ({name:'health',description:'Read active host context.',
 inputSchema:{type:'object',properties:{},additionalProperties:false},
 annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}});
const inventory = () => ({tools:[health(),{name:'get_mods',description:'Read mods',inputSchema:{type:'object'}},{name:'install_download'}],nextCursor:'existing'});
function check(result, original) {
 const updated=result.tools.find(t=>t.name==='health');
 assert.match(updated.description,/docs\/AUTHORIZED-RESTART\.md/);
 assert.match(updated.description,/MainWindowHandle/);assert.match(updated.description,/WM_CLOSE/);
 assert.match(updated.description,/PID/);assert.match(updated.description,/force/i);
 assert.deepEqual({...updated,description:original.description},original);
 assert.deepEqual(result.tools.find(t=>t.name==='get_mods'),{name:'get_mods',description:'Read mods',inputSchema:{type:'object'}});
 assert.equal(result.nextCursor,'existing');assert(!result.tools.some(t=>t.name==='install_download'));
 assert(!result.tools.some(t=>/quit|shutdown|restart/.test(t.name)));
}
test('tools/list advertises authorized maintenance without adding a shutdown capability or mutating source metadata',async()=>{
 const source=inventory(),before=structuredClone(source),calls=[];
 const result=await clientRemote('tools/list',{},async(method,params)=>{calls.push({method,params});return source;});
 check(result,before.tools[0]);assert.deepEqual(source,before);assert.deepEqual(calls,[{method:'tools/list',params:{}}]);
});
test('HTTP metadata guidance survives client composition once and retains unsupported-install filtering',async()=>{
 const source=inventory();let fetchCalls=0;
 const transport=(method,params)=>remote(method,params,async()=>{fetchCalls++;return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:source}),{headers:{'content-type':'application/json'}});},async()=> 'fixture-token');
 const direct=await transport('tools/list',{});check(direct,source.tools[0]);
 const composed=await clientRemote('tools/list',{},transport);check(composed,source.tools[0]);
 assert.equal(composed.tools.find(t=>t.name==='health').description,direct.tools.find(t=>t.name==='health').description);
 assert.equal(fetchCalls,2);
});
test('health and other safe reads are forwarded unchanged; refused installation never reaches transport',async()=>{
 const response={content:[{type:'text',text:'{"protocol":"vortex-agent/1"}'}]},calls=[];
 const transport=async(method,params)=>{calls.push({method,params});return response;};
 for(const name of ['health','get_mods']){
  const args={name,arguments:{}};assert.equal(await clientRemote('tools/call',args,transport),response);
  assert.deepEqual(calls.at(-1),{method:'tools/call',params:args});
 }
 let invoked=false;
 await assert.rejects(remote('tools/call',{name:'install_download',arguments:{}},async()=>{invoked=true;},async()=>{invoked=true;}),/unsupported/);
 assert.equal(invoked,false);
});
