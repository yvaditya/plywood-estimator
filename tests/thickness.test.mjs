import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from '../app/node_modules/esbuild/lib/main.js';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const outfile = resolve(root, 'tests/_output/thickness_test.mjs');
await build({ entryPoints: [resolve(root, 'app/src/thicknessCorrection.ts')], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
const { correctThickness, correctionStepParts, correctedPanelAnalysis } = await import(pathToFileURL(outfile));

// Six independently triangulated outward faces; realistic STEP face vertices.
function box(id, min, max) {
  const positions = [], indices = [];
  for (let axis = 0; axis < 3; axis++) for (const side of [0, 1]) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    const start = positions.length / 3;
    for (const [a, b] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const p = [...min]; p[axis] = side ? max[axis] : min[axis];
      p[u] = a ? max[u] : min[u]; p[v] = b ? max[v] : min[v]; positions.push(...p);
    }
    const face = side ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
    indices.push(...face.map(n => n + start));
  }
  return { id, name: `Board ${id}`, mesh: { name: `Board ${id}`, brep_faces: [],
    attributes: { position: { array: positions } }, index: { array: indices } } };
}
function frame(t = 19.05) {
  return [box(0, [0, 0, 0], [t, 600, 100]), box(1, [1000-t, 0, 0], [1000, 600, 100]),
    box(2, [t, 0, 0], [1000-t, t, 100]), box(3, [t, 600-t, 0], [1000-t, 600, 100])];
}
const near = (actual, want) => assert.ok(Math.abs(actual-want) < 1e-6, `${actual} != ${want}`);
const options = { sourceThickness: 19.05, targetThickness: 18 };

test('thinner stock keeps exterior faces fixed and extends the intervening boards by 2.10 mm', () => {
  const inputs = frame(), snapshot = structuredClone(inputs);
  const p = correctThickness(inputs, options);
  assert.equal(p.ok, true, JSON.stringify(p.issues));
  assert.equal(p.contacts.length, 4);
  near(p.panels[0].after.min[0], 0); near(p.panels[0].after.max[0], 18);
  near(p.panels[1].after.min[0], 982); near(p.panels[1].after.max[0], 1000);
  near(p.panels[2].after.max[0] - p.panels[2].after.min[0], 964);
  near(p.panels[2].after.max[1], 18);
  near(p.validation.maxJointGapError, 0); near(p.validation.perimeterError, 0);
  assert.deepEqual(inputs, snapshot, 'analysis must not mutate imported geometry');
  assert.deepEqual(correctThickness(inputs, options), p, 'a repeated correction starts from the baseline');
});

test('fixed top stays at the same height while its supports grow by 1.05 mm', () => {
  const inputs = frame();
  inputs.push(box(4, [0, 0, 100], [1000, 600, 119.05]));
  const p = correctThickness(inputs, options);
  assert.equal(p.ok, true, JSON.stringify(p.issues));
  near(p.panels[4].after.max[2], 119.05);
  near(p.panels[4].after.min[2], 101.05);
  for (const b of p.panels.slice(0, 4)) near(b.after.max[2], 101.05);
});

test('invalid stock dimensions fail explicitly', () => {
  for (const targetThickness of [0, -1, NaN, Infinity]) {
    assert.equal(correctThickness(frame(), { ...options, targetThickness }).ok, false);
  }
});

test('open surfaces are disclosed and a non-prismatic solid blocks correction', () => {
  const inputs = frame();
  inputs.push(box(10, [0, 0, 0], [100, 0, 100]));
  const p = correctThickness(inputs, options);
  assert.equal(p.ok, true, JSON.stringify(p.issues));
  assert.equal(p.excluded.length, 1);
  const bad = box(11, [200, 200, 0], [219.05, 300, 100]);
  bad.mesh.attributes.position.array[0] += 1;
  assert.equal(correctThickness([...frame(), bad], options).ok, false);
});

test('nearby separated boards do not become invented joints', () => {
  const inputs = frame();
  inputs.push(box(10, [400, 21.05, 0], [419.05, 578.95, 100]));
  const p = correctThickness(inputs, options);
  assert.equal(p.contacts.filter(c => c.a === 10 || c.b === 10).length, 0);
});

test('a pre-existing overlapping solid prevents correction', () => {
  const inputs = frame();
  inputs.push(box(10, [0, 0, 0], [19.05, 200, 100]));
  const p = correctThickness(inputs, options);
  assert.equal(p.ok, false);
  assert.ok(p.issues.some(i => /overlap/i.test(i.message)));
});

test('mixed thickness changes only the matching group', () => {
  const inputs = frame();
  inputs.push(box(4, [0, 0, 100], [1000, 600, 112]));
  const p = correctThickness(inputs, options);
  assert.equal(p.ok, true, JSON.stringify(p.issues));
  near(p.panels[4].after.max[2] - p.panels[4].after.min[2], 12);
});

test('a global rotation and translation preserve the same assembly correction', () => {
  const inputs = frame(); const angle = 0.4, c = Math.cos(angle), s = Math.sin(angle);
  for (const b of inputs) {
    const a = b.mesh.attributes.position.array;
    for (let i=0;i<a.length;i+=3) { const x=a[i], y=a[i+1]; a[i]=c*x-s*y-7000; a[i+1]=s*x+c*y+2000; a[i+2]+=55; }
  }
  const p = correctThickness(inputs, options);
  assert.equal(p.ok, true, JSON.stringify(p.issues));
  for (const b of p.panels) near(b.thickness, 18);
  near(p.validation.maxJointGapError, 0);
});

test('separate cabinets in one file preserve each outside perimeter even when projections overlap', () => {
  const inputs = frame();
  for (const b of frame()) {
    b.id += 20;
    const p=b.mesh.attributes.position.array;
    for(let i=0;i<p.length;i+=3){p[i]+=400;p[i+1]+=200;p[i+2]+=500;}
    inputs.push(b);
  }
  const p=correctThickness(inputs,options);
  assert.equal(p.ok,true,JSON.stringify(p.issues));
  near(p.panels[4].after.min[0],400);near(p.panels[5].after.max[0],1400);
  near(p.panels[6].after.min[1],200);near(p.panels[7].after.max[1],800);
});

test('assembly export removes display offsets and uses right-handed local panel frames', () => {
  const inputs=frame(), offset=[500,900,-20];
  for(const b of inputs){const a=b.mesh.attributes.position.array;for(let i=0;i<a.length;i++)a[i]+=offset[i%3];}
  const p=correctThickness(inputs,options);
  assert.equal(p.ok,true,JSON.stringify(p.issues));
  const parts=correctionStepParts(p,offset);
  assert.equal(parts.length,4);
  assert.deepEqual(parts[0].origin,[0,0,0]);
  near(parts[0].thickness,18);
  assert.deepEqual(parts[0].outer,[[0,0],[600,0],[600,100],[0,100]]);
  assert.throws(()=>correctionStepParts({...p,ok:false},offset),/valid/i);
});

test('a disconnected frame inside another opening keeps its own outside dimensions', () => {
  const outer=frame();
  for(const b of outer){const a=b.mesh.attributes.position.array;for(let i=2;i<a.length;i+=3)a[i]*=5;}
  const inputs=[...outer,box(4,[0,0,500],[1000,600,519.05]),
    box(10,[300,200,200],[319.05,400,300]),box(11,[680.95,200,200],[700,400,300]),
    box(12,[319.05,200,200],[680.95,219.05,300]),box(13,[319.05,380.95,200],[680.95,400,300])];
  const p=correctThickness(inputs,options);
  assert.equal(p.ok,true,JSON.stringify(p.issues));
  near(p.panels.find(b=>b.id===10).after.min[0],300);
  near(p.panels.find(b=>b.id===11).after.max[0],700);
});

test('non-sheet source solids cannot be silently changed only in the CAD download', () => {
  const block=box(10,[400,200,0],[500,300,100]);
  block.editable=false;
  const p=correctThickness([...frame(),block],options);
  assert.equal(p.ok,false);
  assert.ok(p.issues.some(i=>i.bodyIds.includes(10)&&/unsupported|non-sheet/i.test(i.message)));
});

test('corrected geometry supplies panel analysis even outside the nominal importer thickness range', () => {
  const p=correctThickness(frame(),{...options,targetThickness:30});
  assert.equal(p.ok,true,JSON.stringify(p.issues));
  const analysis=correctedPanelAnalysis(p.panels[0],p.frame);
  near(analysis.thickness,30);near(analysis.length,600);near(analysis.width,100);
  assert.deepEqual(analysis.centerWorld,[15,300,50]);
  assert.deepEqual(analysis.faceCenter,[30,300,50]);
  near(analysis.outline.area,60000);
});

test('a slanted reference surface cannot choose the assembly axes or block correction', () => {
  const surface={id:99,name:'Slanted construction face',editable:false,mesh:{name:'face',brep_faces:[],
    attributes:{position:{array:[-50,50,0,50,-50,0,50,-50,100,-50,50,100]}},index:{array:[0,1,2,0,2,3]}}};
  for(const inputs of [[surface,...frame()],[...frame(),surface]]){
    const p=correctThickness(inputs,options);
    assert.equal(p.ok,true,JSON.stringify(p.issues));
    assert.equal(p.panels.length,4);assert.deepEqual(p.excluded.map(e=>e.id),[99]);
    near(p.panels[0].thickness,18);
  }
});

test('a recessed toe face keeps its setback even when hidden in the overall projections', () => {
  const inputs=[box(0,[0,0,0],[19.05,600,700]),box(1,[980.95,0,0],[1000,600,700]),
    box(2,[0,0,700],[1000,600,719.05]),box(3,[19.05,0,100],[980.95,600,119.05]),
    box(4,[19.05,100,0],[980.95,119.05,100])];
  const p=correctThickness(inputs,options);
  assert.equal(p.ok,true,JSON.stringify(p.issues));
  near(p.panels[4].after.min[1],100);
  near(p.panels[4].after.max[1],118);
});

test('an exposed recessed face stays fixed even behind the cabinet centre or exactly on it', () => {
  for(const y of [400,290.475]){
    const inputs=[box(0,[0,0,0],[19.05,600,700]),box(1,[980.95,0,0],[1000,600,700]),
      box(2,[0,0,700],[1000,600,719.05]),box(3,[19.05,0,100],[980.95,580.95,119.05]),
      box(4,[19.05,y,0],[980.95,y+19.05,100]),box(5,[19.05,580.95,0],[980.95,600,700])];
    const p=correctThickness(inputs,options);
    assert.equal(p.ok,true,JSON.stringify(p.issues));
    near(p.panels[4].after.min[1],y);near(p.panels[4].after.max[1],y+18);
  }
});
