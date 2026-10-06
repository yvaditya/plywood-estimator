// node tests/thickness_bench.mjs "path/to/assembly.stp" [target-mm=18]
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from '../app/node_modules/esbuild/lib/main.js';
const root=fileURLToPath(new URL('../',import.meta.url)),out=resolve(root,'tests/_output');
mkdirSync(out,{recursive:true});
const file=process.argv[2],targetThickness=Number(process.argv[3]||18);
if(!file)throw new Error('Pass a STEP file path.');
const require=createRequire(new URL('../app/package.json',import.meta.url));
async function bundle(name){
  const outfile=resolve(out,`${name}_thickness_bench.mjs`);
  await build({entryPoints:[resolve(root,`app/src/${name}.ts`)],outfile,bundle:true,format:'esm',platform:'node',logLevel:'silent'});
  return import(pathToFileURL(outfile));
}
const {correctThickness,correctionStepParts}=await bundle('thicknessCorrection');
const {buildAssemblyStep}=await bundle('stepExport');
const {restoreStepBodyColors}=await bundle('stepColors');
const {analyzeBody}=await bundle('geometry');
const {runNest}=await bundle('nest');
const occt=await require('occt-import-js')();
const parse=bytes=>occt.ReadStepFile(bytes,{linearUnit:'millimeter',linearDeflectionType:'absolute_value',linearDeflection:.1,angularDeflection:.2});
const sourceBytes=new Uint8Array(readFileSync(file));
const original=parse(sourceBytes);
assert.equal(original.success,true);
restoreStepBodyColors(sourceBytes,original,parse);
const inputs=original.meshes.map((mesh,id)=>({mesh,id,name:mesh.name||`Board ${id+1}`}));
const start=performance.now();
const proposal=correctThickness(inputs,{sourceThickness:19.05,targetThickness});
const elapsedMs=performance.now()-start;
assert.equal(proposal.ok,true,JSON.stringify(proposal.issues));
const base=basename(file).replace(/\.(step|stp)$/i,''),stepPath=resolve(out,`${base}-${targetThickness}mm.step`);
const step=buildAssemblyStep(correctionStepParts(proposal),new Date().toISOString(),`${base} - ${targetThickness} mm`);
writeFileSync(stepPath,step);
const imported=parse(new TextEncoder().encode(step));
assert.equal(imported.success,true);
assert.equal(imported.meshes.length,proposal.panels.length);
function meshBounds(mesh,frame=[[1,0,0],[0,1,0],[0,0,1]]){
  const b={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]},p=mesh.attributes.position.array;
  for(let i=0;i<p.length;i+=3)for(let k=0;k<3;k++){
    const v=p[i]*frame[k][0]+p[i+1]*frame[k][1]+p[i+2]*frame[k][2];
    b.min[k]=Math.min(b.min[k],v);b.max[k]=Math.max(b.max[k],v);
  }return b;
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-4,`${a} != ${b}`);
const actualBounds=new Map();
const parts=imported.meshes.map((mesh,index)=>{
  const p=proposal.panels[index],a=analyzeBody(mesh),actual=meshBounds(mesh,proposal.frame);
  assert.ok(a);near(a.thickness,p.thickness);
  if(p.mesh.color){
    assert.ok(mesh.color,`Panel ${index} lost its imported colour`);
    p.mesh.color.forEach((channel,k)=>near(mesh.color[k],channel));
  } else assert.equal(mesh.color,undefined,'uncoloured source panels stay uncoloured');
  for(let k=0;k<3;k++){near(actual.min[k],p.after.min[k]);near(actual.max[k],p.after.max[k]);}
  actualBounds.set(p.id,actual);
  return {id:String(p.id),name:p.name,thickness:a.thickness,qty:1,grain:'free',rotation:'lock',outer:a.outline.outer,holes:a.outline.holes,color:'#888'};
});
// Verify the contacts again against re-imported CAD, not the proposed meshes.
for(const c of proposal.contacts){
  const a=actualBounds.get(c.a),b=actualBounds.get(c.b);
  near(((c.sideB?b.max:b.min)[c.axis]-(c.sideA?a.max:a.min)[c.axis])*(c.sideA?1:-1),c.gap);
  for(let k=0;k<3;k++)if(k!==c.axis)assert.ok(Math.min(a.max[k],b.max[k])-Math.max(a.min[k],b.min[k])>0);
}
for(const r of proposal.references){
  const p=proposal.panels.find(p=>p.id===r.id),b=actualBounds.get(r.id);
  near((r.side?b.max:b.min)[r.axis],(r.side?p.before.max:p.before.min)[r.axis]);
}
if(base==='FULL TOE KICK' && targetThickness===18){
  assert.equal(parts.length,42);assert.equal(proposal.contacts.length,126);
  const extent=id=>{const b=actualBounds.get(id);return b.max.map((n,k)=>n-b.min[k]);};
  const old2=meshBounds(original.meshes[2]),old8=meshBounds(original.meshes[8]);
  // STEP coordinates contain ~0.0002 mm design rounding; assert the exact
  // required allowances against the original CAD, not rounded display sizes.
  near(extent(2)[1]-(old2.max[1]-old2.min[1]),2.10);
  near(extent(8)[1]-(old8.max[1]-old8.min[1]),4.20);
  near(extent(8)[2]-(old8.max[2]-old8.min[2]),1.05);
}
const nest=runNest(parts,{sheetW:1219.2,sheetL:2438.4,margin:12.7,kerf:1.8,resolution:5,restarts:256,cutStrategy:'repeated'});
const summary={model:basename(file),sourceThickness:19.05,targetThickness,panels:parts.length,contacts:proposal.contacts.length,
  changes:proposal.changes.length,excluded:proposal.excluded,validation:proposal.validation,elapsedMs:Math.round(elapsedMs),
  reimportedCadVerified:true,bodyColorsVerified:true,coloredPanels:proposal.panels.filter(p=>p.mesh.color).length,
  sheets:nest.totalSheets,unplaced:nest.groups.reduce((n,g)=>n+g.unplaced.length,0),stepPath,
  dimensions:proposal.changes};
writeFileSync(resolve(out,'thickness_bench_summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify({...summary,dimensions:undefined},null,2));
