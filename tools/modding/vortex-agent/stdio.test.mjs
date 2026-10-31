import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import * as bridge from './bridge.mjs';
import {createRequire} from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);

test('stdio stops consuming requests while the client is not reading answers', async () => {
  const output = new PassThrough({ highWaterMark: 32 });
  let consumed = 0;
  async function* input() {
    for (let id = 0; id < 40; id++) {
      consumed++;
      yield Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }) + '\n');
    }
  }
  const work = bridge.runStdio(input(), output, async request => ({ jsonrpc: '2.0', id: request.id, result: 'x'.repeat(4096) }), 4);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(consumed <= 4, `consumed ${consumed} requests with a blocked output`);
  let text = '';
  output.on('data', chunk => { text += chunk; });
  await work;
  assert.equal(text.trim().split('\n').map(JSON.parse).length, 40);
});

test('stdio parse errors also wait for output and a broken output rejects cleanly', async () => {
  const output = new PassThrough({ highWaterMark: 1 });
  let consumed = 0;
  async function* input() { for (let i = 0; i < 20; i++) { consumed++; yield Buffer.from('bad-json\n'); } }
  const work = bridge.runStdio(input(), output, async () => assert.fail('invalid input dispatched'));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(consumed, 1);
  output.resume();
  await work;
  const broken = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('synthetic pipe failure')); } });
  await assert.rejects(bridge.runStdio([Buffer.from('bad-json\n')], broken, async () => ({})), /synthetic pipe failure/);
});

test('stdio refuses malformed UTF-8 before dispatch and accepts split valid Unicode afterward', async () => {
  const invalid = Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"method":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
  const valid = Buffer.from('{"jsonrpc":"2.0","id":2,"method":"проверка"}\n');
  const output = new PassThrough(); let text = ''; const dispatched = [];
  output.on('data', chunk => { text += chunk; });
  const chunks = [invalid, ...Array.from(valid, byte => Buffer.from([byte]))];
  await bridge.runStdio(chunks, output, async request => {
    dispatched.push(request); return { jsonrpc: '2.0', id: request.id, result: {} };
  });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].method, 'проверка');
  const responses = text.trim().split('\n').map(JSON.parse);
  assert.equal(responses[0].error.code, -32700);
  assert.equal(responses[1].id, 2);
});

test('stdio lists and remotely forwards resident native preflight without a local shadow or empty-ID loss', async () => {
  const {readNativePreflight}=require('./native-preflight.cjs');
  const {safe}=require('./serialization.cjs');
  const root=path.resolve('.');
  const state={persistent:{profiles:{p:{gameId:'cyberpunk2077'}}},
    settings:{gameMode:{discovered:{cyberpunk2077:{path:root}}}}};
  const api={getState:()=>state};
  const selectors={activeGameId:()=> 'cyberpunk2077',activeProfileId:()=> 'p',installPathForGame:()=>root,downloadPathForGame:()=>root};
  const util={getGame:()=>({getModPaths:()=>({'':root,own_alias:root})})};
  const calls=[];
  const tool={name:'read_native_preflight',inputSchema:{type:'object',properties:{},additionalProperties:false}};
  const transport=async (method,params)=>{
    calls.push([method,params]);
    if(method==='tools/list')return {tools:[tool]};
    if(params.name==='health')return {content:[{type:'text',text:'{"protocol":"vortex-agent/1"}'}]};
    assert.equal(params.name,'read_native_preflight');
    const result=await readNativePreflight(api,selectors,util,{getWindow:()=>({api:{
      app:{getVersion:async()=> '2.9.1'},updater:{getStatus:async()=>({seq:3,snapshot:{state:{type:'idle'}}})},
    }})});
    return {content:[{type:'text',text:JSON.stringify(safe(result,api,'read_native_preflight'))}]};
  };
  const handle=bridge.handler(transport);
  await handle({jsonrpc:'2.0',id:'init',method:'initialize',params:{}});
  const output=new PassThrough();let text='';output.on('data',chunk=>{text+=chunk;});
  const input=[{jsonrpc:'2.0',id:1,method:'tools/list'},
    {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'read_native_preflight',arguments:{}}}];
  await bridge.runStdio(input.map(row=>Buffer.from(JSON.stringify(row)+'\n')),output,handle);
  const replies=text.trim().split('\n').map(JSON.parse);
  assert.equal(replies.find(row=>row.id===1).result.tools.filter(row=>row.name==='read_native_preflight').length,1);
  const result=JSON.parse(replies.find(row=>row.id===2).result.content[0].text);
  assert.deepEqual(result.deploymentTargets.map(row=>row.typeId),['','own_alias']);
  assert.equal(result.deploymentTargets[0].path,root);assert.equal(result.appVersion.value,'2.9.1');
  assert.equal(result.shutdownPermit,false);
  assert.equal(calls.filter(([method,params])=>method==='tools/call'&&params.name==='read_native_preflight').length,1);
});
