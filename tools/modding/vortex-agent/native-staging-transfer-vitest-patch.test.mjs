import fs from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {applyExact, hunks} from './native-patch-test-fixture.mjs';
const base=new URL('./native-patches/vortex-tests-2.9.1/',import.meta.url);
const manifest=JSON.parse(fs.readFileSync(new URL('staging-transfer-vitest.json',base)));
const patch=fs.readFileSync(new URL('staging-transfer-vitest.patch',base),'utf8');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
test('upstream transfer adapter is separately pinned, test-only and insertion-only',()=>{
  assert.equal(manifest.upstreamPath,'src/renderer/src/util/transferPath.test.ts');
  assert.equal(manifest.testOnly,true);assert.equal(manifest.installed,false);
  assert.equal(sha(patch),manifest.patchSHA256);
  const blocks=hunks(patch,manifest.upstreamPath);assert.equal(blocks.length,1);
  assert(!blocks.some(block=>block.body.some(line=>line.startsWith('-'))));
});
test('copy callback adapter preserves every original byte and assertion outside its mock insertion',{
  skip:process.env.VORTEX_NATIVE_TRANSFER_TEST ? false : 'Provide independently pinned original upstream transfer test',
},()=>{
  const original=fs.readFileSync(process.env.VORTEX_NATIVE_TRANSFER_TEST,'utf8');
  assert.equal(sha(original),manifest.inputSHA256);
  const changed=applyExact(original,patch,manifest.upstreamPath);
  assert.equal(sha(changed),manifest.outputSHA256);
  const marker='vi.mock("fs", () => ({\n',offset=original.indexOf(marker)+marker.length;
  assert(offset>=marker.length);assert.equal(original.indexOf(marker,offset),-1);
  const inserted=hunks(patch,manifest.upstreamPath)[0].body.filter(line=>line.startsWith('+')).map(line=>line.slice(1)).join('\n')+'\n';
  assert.equal(changed,original.slice(0,offset)+inserted+original.slice(offset));
});
