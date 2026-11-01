import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from '../app/node_modules/esbuild/lib/main.js';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const output=resolve(root,'tests/_output/rip_improvements_test.mjs');
await build({entryPoints:[resolve(root,'app/src/packRect.ts')],bundle:true,format:'esm',platform:'node',outfile:output,logLevel:'silent'});
const rect=await import(pathToFileURL(output).href);
const sizes=[[54,15],[31,15],[79,20],[57,10],[39,20],[49,10],[48,10],[42,10],[46,10],[10,20],[18,15],[12,15],[67,20],[44,20],[41,20],[46,15],[43,15],[58,15],[48,15],[32,20],[12,15],[16,15],[69,20],[22,10],[65,20],[40,10],[26,10],[55,15],[84,10],[62,10]];
function job(transpose=false){return {sheetW:transpose?600:1000,sheetH:transpose?1000:600,kerf:2,cutStrategy:'repeated',items:sizes.map(([w,h],i)=>({id:String(i),w:(transpose?h:w)*10-2,h:(transpose?w:h)*10-2,allowRotate:false}))};}
function legal(job,result){
 assert.equal(result.unplaced.length,0);
 assert.equal(result.sheets.flatMap(s=>s.placements).length,job.items.length);
 for(const s of result.sheets){
  assert.equal(s.fullySeparated,s.placements.length);
  const axis=job.sheetW>=job.sheetH?'H':'V';
  for(const c of s.cuts.filter(c=>c.depth===0)){assert.equal(c.axis,axis);assert.equal(axis==='H'?c.parentW:c.parentH,Math.max(job.sheetW,job.sheetH));}
  const strips=new Map();
  for(const p of s.placements){assert.equal(p.rotated,false);const key=axis==='H'?p.y:p.x,width=axis==='H'?p.h:p.w; if(strips.has(key))assert.equal(width,strips.get(key));strips.set(key,width);assert.ok(p.x+p.w<=job.sheetW&&p.y+p.h<=job.sheetH);}
  for(let i=0;i<s.placements.length;i++)for(let j=i+1;j<s.placements.length;j++){const a=s.placements[i],b=s.placements[j];assert.ok(Math.max(b.x-a.x-a.w,a.x-b.x-b.w,b.y-a.y-a.h,a.y-b.y-b.h)>=job.kerf-1e-6);}
 }
}
for(const transpose of [false,true])test(`repeated rips combine matching strip lengths into four sheets (${transpose?'portrait':'landscape'})`,()=>{const j=job(transpose),r=rect.packMulti(j,32);assert.equal(r.sheets.length,4);legal(j,r);assert.deepEqual(rect.packMulti(j,32),r);});

test('small repeated budgets retain all four existing starters',()=>{const j=job();const short=rect.buildTrialSchedule(j,4);assert.deepEqual(rect.buildTrialSchedule(j,32).slice(0,4),short);for(const n of [1,2,3,4])assert.deepEqual(rect.buildTrialSchedule(j,n),short.slice(0,n));});
test('repeated subset trial is shared by animated and synchronous searches',async()=>{const j=job();const sync=rect.packMulti(j,32,3);assert.deepEqual(await rect.packMultiAnimated(j,32,()=>{},4,3),sync);});
