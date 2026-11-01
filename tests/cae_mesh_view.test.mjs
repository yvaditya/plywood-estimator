import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from '../app/node_modules/esbuild/lib/main.js';
await build({entryPoints:['app/src/caeMeshEdges.ts'],outfile:'tests/_output/cae_mesh_edges.mjs',bundle:true,format:'esm',platform:'node',logLevel:'silent',absWorkingDir:fileURLToPath(new URL('../',import.meta.url))});
const {elementEdges}=await import('./_output/cae_mesh_edges.mjs');
test('Q4 edges have no display triangle diagonals and deduplicate shared edges',()=>{
  const edges=elementEdges(Int32Array.from([0,1,4,3,1,2,5,4]),4);
  assert.equal(edges.length/2,7);
  const keys=new Set(Array.from({length:edges.length/2},(_,i)=>[edges[i*2],edges[i*2+1]].sort((a,b)=>a-b).join(',')));
  assert.ok(!keys.has('0,4'));
});
test('H8 volume wireframe retains edges at the interior node',()=>{
  const id=(x,y,z)=>x+3*y+9*z, elems=[];
  for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<2;x++) elems.push(id(x,y,z),id(x+1,y,z),id(x+1,y+1,z),id(x,y+1,z),id(x,y,z+1),id(x+1,y,z+1),id(x+1,y+1,z+1),id(x,y+1,z+1));
  const edges=elementEdges(Int32Array.from(elems),8);
  assert.equal(edges.length/2,54);
  assert.equal(Array.from(edges).filter(i=>i===13).length,6);
});

await build({entryPoints:['app/src/viewer.ts'],outfile:'tests/_output/cae_mesh_viewer.mjs',bundle:true,format:'esm',platform:'node',logLevel:'silent',absWorkingDir:fileURLToPath(new URL('../',import.meta.url))});
const {Viewer}=await import('./_output/cae_mesh_viewer.mjs');
test('renderer uses solver coordinates and full H8 connectivity without filled faces',()=>{
  const nodes=Float32Array.from([0,0,0, 1,0,0, 1,1,0, 0,1,0, 0,0,1, 1,0,1, 1,1,1, 0,1,1]);
  const data={nodes,elems:Int32Array.from([0,1,2,3,4,5,6,7]),nodesPerElem:8,nodeCount:8,elemCount:1};
  const fake={clearCaeMesh(){},caeGroup:{add(){}},caeMeshGroup:null};
  Viewer.prototype.showCaeMesh.call(fake,data,{faces:false,volumeEdges:true,points:true,disp:new Float32Array(24).fill(9),dispScale:0});
  const [lines,points]=fake.caeMeshGroup.children;
  assert.equal(fake.caeMeshGroup.children.length,2);
  assert.ok(lines.isLineSegments && points.isPoints);
  assert.deepEqual(lines.geometry.getAttribute('position').array,nodes);
  assert.deepEqual(lines.geometry.index.array,elementEdges(data.elems,8));
  assert.equal(points.geometry.getAttribute('position').count,8);
  assert.deepEqual(data.nodes,nodes);
  const original=new Float32Array(nodes);
  Viewer.prototype.showCaeMesh.call(fake,data,{faces:false,volumeEdges:true,disp:new Float32Array(24).fill(2),dispScale:5,field:Float32Array.from([0,1,2,3,4,5,6,7]),fieldMin:0,fieldMax:7});
  const contour=fake.caeMeshGroup.children[0];
  assert.deepEqual(contour.geometry.getAttribute('position').array,Float32Array.from(original,v=>v+10));
  assert.deepEqual(data.nodes,original,'Exaggeration must never change solver coordinates');
  assert.ok(contour.material.vertexColors && contour.geometry.getAttribute('color'));
});
