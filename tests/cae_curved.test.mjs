import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from '../app/node_modules/esbuild/lib/main.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const outfile=resolve(root,'tests/_output/cae_curved.mjs');
await build({entryPoints:[resolve(root,'app/src/cae.ts')],outfile,bundle:true,format:'esm',platform:'node',logLevel:'silent'});
const {previewAssembly,solveAssembly,serializeAssembly,detectJoints,MATERIALS}=await import(pathToFileURL(outfile));
const circle=(cx,cy,r,n=24)=>Array.from({length:n},(_,i)=>[cx+r*Math.cos(2*Math.PI*i/n),cy+r*Math.sin(2*Math.PI*i/n)]);
const profile={outer:[[0,0],[100,0],[100,80],[90,94],[70,100],[30,100],[10,94],[0,80]],holes:[circle(50,55,12)],bbox:{w:100,h:100},area:0};
const options=(meshKind='shell',size=25)=>({panels:[{id:1,label:'Curved board',outline:profile,thicknessMm:10,material:MATERIALS[0],grainAlongLength:true,origin:[0,0,0],uAxis:[1,0,0],vAxis:[0,0,1],normal:[0,-1,0]}],joints:[],loads:[{panelId:1,x:50,y:90,N:1,shape:'square',size:10}],tolMm:.001,elementSizeMm:size,maxDof:60000,meshKind,solidLayers:2});
for(const kind of ['shell','solid']) test(`${kind}: curved hole preview and solve use identical boundary mesh`,()=>{
  const opts=options(kind),preview=previewAssembly(opts);
  assert.ok(preview.ok,preview.message);
  assert.ok(preview.mesh.boundaryConforming);
  assert.ok(preview.mesh.areaErrorMm2<1e-5);
  assert.ok(preview.mesh.minScaledJacobian>0);
  assert.equal(preview.mesh.unstructuredPanels,1);
  assert.ok(preview.mesh.maxEdgeMm<=25+1e-6);
  const solved=solveAssembly(opts);
  assert.ok(solved.ok,solved.message);
  assert.ok(solved.converged && solved.maxDisp>0);
  assert.ok(Number.isFinite(solved.maxVm));
  assert.deepEqual(solved.mesh.nodes,preview.mesh.nodes);
  assert.deepEqual(solved.mesh.elems,preview.mesh.elems);
  assert.ok(solved.panels[0].uv.length>0 && solved.panels[0].quads.length>0);
});
test('curved shell sidecar receives the exact preview connectivity',()=>{
  const opts=options(),preview=previewAssembly(opts),serialized=serializeAssembly(opts);
  assert.ok(serialized.ok,serialized.message);
  assert.deepEqual(serialized.model.quads.flatMap(q=>q.n),Array.from(preview.mesh.elems));
  assert.equal(serialized.model.nodes.length,preview.mesh.nodeCount);
});
test('curved boundary detail cannot silently bypass the DOF cap',()=>{
  const preview=previewAssembly({...options(),maxDof:60});
  assert.equal(preview.ok,false);
  assert.match(preview.message,/cap|DOF|resource/i);
});
test('curved board bounding-box corners cannot create phantom assembly joints',()=>{
  const a={...options().panels[0],outline:{outer:circle(50,50,50,64),holes:[],bbox:{w:100,h:100},area:0},origin:[0,0,0],uAxis:[1,0,0],vAxis:[0,1,0],normal:[0,0,1]};
  const b={...a,id:2,outline:{outer:[[0,0],[20,0],[20,20],[0,20]],holes:[],bbox:{w:20,h:20},area:400},thicknessMm:1,origin:[0,0,-10],uAxis:[0,1,0],vAxis:[0,0,1],normal:[1,0,0]};
  assert.deepEqual(detectJoints([a,b],.01),[]);
});

function polygonCentroid(ring) {
  let a=0,x=0,y=0;
  for(let i=0;i<ring.length;i++) {
    const p=ring[i],q=ring[(i+1)%ring.length],c=p[0]*q[1]-q[0]*p[1];
    a+=c;x+=(p[0]+q[0])*c;y+=(p[1]+q[1])*c;
  }
  return [x/(3*a),y/(3*a)];
}
function loadCentroid(preview) {
  assert.ok(preview.ok,preview.message);
  let force=0,x=0,z=0;
  for(const l of preview.constraints.loads) {force+=l.f[1];x+=l.at[0]*l.f[1];z+=l.at[2]*l.f[1];}
  return [force,x/force,z/force];
}
test('uniform curved patch pressure preserves total force and both first moments under refinement',()=>{
  for(const [samples,size] of [[24,30],[96,30],[96,10]]) {
    const arc=Array.from({length:samples},(_,i)=>{const a=-Math.PI/2+(i+1)*Math.PI/samples;return [100+50*Math.cos(a),50+50*Math.sin(a)];});
    const outer=[[0,0],[100,0],...arc,[0,100]],expected=polygonCentroid(outer);
    const opts=options('shell',size);
    opts.panels[0].outline={outer,holes:[],bbox:{w:150,h:100},area:0};
    opts.loads=[{panelId:1,x:75,y:50,N:100,shape:'square',size:200}];
    const [force,x,y]=loadCentroid(previewAssembly(opts));
    assert.ok(Math.abs(force-100)<1e-9);
    assert.ok(Math.abs(x-expected[0])<1e-6,`resultant x=${x}, expected ${expected[0]}, samples=${samples}, size=${size}`);
    assert.ok(Math.abs(y-expected[1])<1e-6);
  }
});
test('small footprint between nodes retains its position and signed force',()=>{
  const opts=options('shell',30);
  opts.panels[0].outline={outer:[[0,0],[100,0],[100,100],[0,100]],holes:[],bbox:{w:100,h:100},area:10000};
  opts.loads=[{panelId:1,x:47,y:58,N:-100,shape:'square',size:.5}];
  const [force,x,y]=loadCentroid(previewAssembly(opts));
  assert.ok(Math.abs(force+100)<1e-9);
  assert.ok(Math.abs(x-47)<1e-7 && Math.abs(y-58)<1e-7,`${x}, ${y}`);
});
test('round patch clipped by the material edge retains its covered-area centroid',()=>{
  const opts=options('shell',30);
  opts.panels[0].outline={outer:[[0,0],[100,0],[100,100],[0,100]],holes:[],bbox:{w:100,h:100},area:10000};
  opts.loads=[{panelId:1,x:0,y:50,N:100,shape:'round',size:30}];
  const [force,x,y]=loadCentroid(previewAssembly(opts));
  assert.ok(Math.abs(force-100)<1e-9);
  assert.ok(Math.abs(x-4*15/(3*Math.PI))<.01,`${x}`);
  assert.ok(Math.abs(y-50)<1e-7);
});
test('a footprint wholly inside a hole is refused instead of moved onto material',()=>{
  const opts=options();opts.loads=[{panelId:1,x:50,y:55,N:100,shape:'round',size:5}];
  const p=previewAssembly(opts);
  assert.equal(p.ok,false);
  assert.match(p.message,/load.*(touch|overlap|material)/i);
});
