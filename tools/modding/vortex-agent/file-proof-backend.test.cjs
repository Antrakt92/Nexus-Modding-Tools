'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {getBackend,_kindForTests:kind}=require('./file-proof-backend.cjs');
test('standalone uses fixed node filesystem and exact admitted Windows Electron uses physical original-fs',()=>{
 assert.equal(getBackend().name,'node:fs');assert.equal(getBackend().fs,require('node:fs'));
 assert.equal(kind({platform:'win32',electron:'44.2.0',node:'24.20.0'}),'original-fs');
 assert.equal(kind({platform:'linux',electron:undefined,node:'24.20.0'}),'node:fs');
});
test('unsupported Electron runtimes never fall back to node filesystem',()=>{
 for(const runtime of [{platform:'linux',electron:'44.2.0',node:'24.20.0'},
 {platform:'win32',electron:'44.2.1',node:'24.20.0'},{platform:'win32',electron:'44.2.0',node:'24.20.1'},
 {platform:'win32',electron:'',node:'24.20.0'}])assert.throws(()=>kind(runtime),/FILE_PROOF_ELECTRON_UNVERIFIED/);
});
test('missing or invalid original filesystem is refused rather than replaced',()=>{
 const Module=require('node:module'),load=Module._load;
 const platform=Object.getOwnPropertyDescriptor(process,'platform');
 const descriptor=Object.getOwnPropertyDescriptor(process.versions,'electron'),node=Object.getOwnPropertyDescriptor(process.versions,'node');
 Object.defineProperty(process,'platform',{...platform,value:'win32'});
 Object.defineProperty(process.versions,'electron',{configurable:true,value:'44.2.0'});
 Object.defineProperty(process.versions,'node',{configurable:true,value:'24.20.0'});
 try{
  for(const value of [null,{}]){
   Module._load=function(name,...args){if(name==='original-fs'){if(value===null)throw Error('private');return value;}return load.call(this,name,...args);};
   assert.throws(()=>getBackend(),/FILE_PROOF_PHYSICAL_BACKEND_UNAVAILABLE/);
  }
 }finally{Module._load=load;Object.defineProperty(process,'platform',platform);if(descriptor)Object.defineProperty(process.versions,'electron',descriptor);else delete process.versions.electron;Object.defineProperty(process.versions,'node',node);}
});
