import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from '../app/node_modules/esbuild/lib/main.js';
import {fileURLToPath} from 'node:url';
await build({entryPoints:['app/src/caeFieldRaster.ts'],outfile:'tests/_output/cae_field_raster.mjs',absWorkingDir:fileURLToPath(new URL('../',import.meta.url)),bundle:true,format:'esm',platform:'node',logLevel:'silent'});
const {rasterizeQuadField}=await import('./_output/cae_field_raster.mjs');
test('nonrectangular result overlay follows actual elements and interpolates an affine field',()=>{
  const uv=[[0,0],[10,0],[8,10],[2,10]];
  const values=Float32Array.from(uv,([x,y])=>x+2*y);
  const {nx,ny,field}=rasterizeQuadField(uv,[[0,1,2,3]],values,10);
  assert.equal(nx,10);assert.equal(ny,10);
  assert.ok(Number.isNaN(field[9*nx]));
  assert.ok(Math.abs(field[5*nx+5]-16.5)<1e-6);
});
