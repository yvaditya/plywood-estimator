// Baseline: bundle packRect.ts before editing to tests/_output/rip_before.mjs.
// Geometry input: node tests/step_bench.mjs <model.stp> 32.
// Run: node tests/rip_bench.mjs (any working directory).
import {readFileSync,readdirSync} from 'node:fs';
import {build} from '../app/node_modules/esbuild/lib/main.js';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('../',import.meta.url)));
await build({entryPoints:['app/src/packRect.ts'],bundle:true,format:'esm',platform:'node',outfile:'tests/_output/rip_after.mjs',logLevel:'silent'});
const before=await import('./_output/rip_before.mjs'),after=await import('./_output/rip_after.mjs');
function metrics(r,ms){const stats=r.sheets.map(s=>after.longRipStats(s.cuts));return {sheets:r.sheets.length,unplaced:r.unplaced.length,cuts:r.sheets.reduce((n,s)=>n+s.cuts.length,0),ripSettings:stats.reduce((n,s)=>n+s.settings,0),rips:stats.reduce((n,s)=>n+s.rips,0),largestOffcutM2:Math.max(0,...r.sheets.map(s=>s.largestFree?s.largestFree.w*s.largestFree.h/1e6:0)),ms:+ms.toFixed(1)}}
function compare(name,j,tries=32){const rows=[];for(const [version,lib] of [['before',before],['after',after]]){const t=performance.now(),r=lib.packMulti(j,tries);rows.push({name,tries,version,...metrics(r,performance.now()-t)});}rows.forEach(r=>console.log(JSON.stringify(r)));}
const input=JSON.parse(readFileSync('tests/_output/step_bench_input.json','utf8'));
for(const t of [...new Set(input.parts.map(p=>Math.round(p.thickness*2)/2))]){const items=input.parts.filter(p=>Math.round(p.thickness*2)/2===t).map(p=>({id:p.id,w:Math.max(...p.outer.map(v=>v[0]))-Math.min(...p.outer.map(v=>v[0])),h:Math.max(...p.outer.map(v=>v[1]))-Math.min(...p.outer.map(v=>v[1])),allowRotate:true}));for(const tries of [32,256])compare(input.name+' '+t+'mm',{sheetW:input.config.sheetL-2*input.config.margin,sheetH:input.config.sheetW-2*input.config.margin,kerf:input.config.kerf,cutStrategy:'repeated',items},tries);}
for(const file of readdirSync('tests/fixtures/nest')){const f=JSON.parse(readFileSync('tests/fixtures/nest/'+file,'utf8'));const parts=f.sheets.flatMap(s=>s.parts).map((p,i)=>({id:String(i),w:p.w,h:p.h,allowRotate:true}));const sh=f.sheets[0];compare(file,{sheetW:Math.max(sh.sheetW,sh.sheetL)-25.4,sheetH:Math.min(sh.sheetW,sh.sheetL)-25.4,kerf:f.kerfMm,cutStrategy:'repeated',items:parts});}

for(const n of [42,200,1000])for(const mix of ['same','mixed']){const job={sheetW:2400,sheetH:1200,kerf:2,cutStrategy:'repeated',items:Array.from({length:n},(_,i)=>({id:String(i),w:200+(i*137)%1900,h:mix==='same'?100:50+(i%12)*25,allowRotate:false}))};for(const [version,lib] of [['before',before],['after',after]]){const t=performance.now();lib.buildTrialSchedule(job,32);console.log(JSON.stringify({scheduleParts:n,widthMix:mix,version,ms:+(performance.now()-t).toFixed(1)}));}}

let summary={improved:0,equal:0,worse:0,before:0,after:0};
for(const n of [20,40,80,160])for(let seed=1;seed<=5;seed++){let s=seed*7919+n;const rnd=()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/2**32};const job={sheetW:2400,sheetH:1200,kerf:2,cutStrategy:'repeated',items:Array.from({length:n},(_,i)=>({id:String(i),w:200+Math.floor(rnd()*1900),h:[100,150,200,300][Math.floor(rnd()*4)],allowRotate:false}))};let a=before.packMulti(job,32).sheets.length,b=after.packMulti(job,32).sheets.length;summary.before+=a;summary.after+=b;summary[b<a?'improved':b>a?'worse':'equal']++;console.log(n,seed,a,b)}console.log(summary)
