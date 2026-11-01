import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from '../app/node_modules/esbuild/lib/main.js';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));

const outfile = resolve(root, 'tests/_output/package_test.mjs');
await build({ absWorkingDir:root, entryPoints: ['app/src/packageData.ts'], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
const { buildPackageData, encodeArray, decodeArray } = await import(pathToFileURL(outfile));
const htmlfile = resolve(root, 'tests/_output/package_html_test.mjs');
await build({ absWorkingDir:root, entryPoints: ['app/src/packageHtml.ts'], outfile: htmlfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
const { buildPackageHtml } = await import(pathToFileURL(htmlfile));
const rect = [[0,0],[100,0],[100,80],[0,80]];
const body = (id, fileTag = 'Cabinet') => ({ id: String(id), name: `Panel ${id}`, fileTag, color: '#bb7744', length: 100, width: 80, thickness: 18,
  positions: [0,0,0,100,0,0,100,80,0,0,80,0], indices: [0,1,2,0,2,3] });
const part = (partId, instance, label, x=0) => ({ partId, instance, panelLabel: label, partName: `Panel ${partId}`, rotation: 0, x, y: 0, w:100, h:80, color:'#bb7744',outer:rect,holes:[],separatedAt:0 });
function input() {
  return { jobName: 'Cabinet', units: 'mm', createdAt: '2026-10-06T12:00:00Z', margin:0,kerf:3,kerfRef:'keeper',sequenceStyle:'optimized',strategy:'guillotine',
    bodies: [body(1), body(2, 'Other cabinet')], segments: new Map([['1-seg', {parentId:'1', segIndex:1,segCount:2,outer:rect,holes:[],thickness:18}]]),
    nest: { groups: [{ thickness:18, sheets:[{index:1,globalIndex:1,thickness:18,sheetW:500,sheetL:500,parts:[part('1',0,'a'),part('1',1,'b',103),part('1-seg',0,'c',206)],cuts:[],usedArea:24000,largestFree:null}], unplaced:[{partId:'2',partName:'Panel 2',instance:0}]}],totalSheets:1,totalPartArea:24000,totalSheetArea:250000,yield:.096 } };
}
test('preserves occurrence codes, duplicate quantities, split provenance and unplaced rows', () => {
  const p = buildPackageData(input());
  assert.equal(p.parts.length, 4);
  assert.equal(new Set(p.parts.map(p=>p.key)).size, 4);
  assert.deepEqual(p.parts.slice(0,3).map(p=>p.code), ['1a','1b','1c']);
  assert.equal(p.parts[2].bodyId, '1');
  assert.match(p.parts[2].segment, /1 of 2/);
  assert.equal(p.parts[3].sheet, null);
  assert.equal(p.parts[3].fileTag, 'Other cabinet');
  assert.equal(p.models.length, 2);
});
test('snapshots own their data and keys change when geometry or cut layout changes', () => {
  const a = input(), first = buildPackageData(a);
  assert.equal(first.id, buildPackageData({...a,createdAt:'tomorrow'}).id);
  a.nest.groups[0].sheets[0].parts[0].outer[0] = [7,9];
  assert.deepEqual(first.sheets[0].parts[0].outer[0], [0,0]);
  assert.notEqual(first.id, buildPackageData(a).id);
  a.bodies[0].positions[0] = 30;
  assert.notEqual(first.id, buildPackageData(a).id);
});
test('missing body references are rejected instead of silently losing 3D links', () => {
  const a=input(); a.bodies=[];
  assert.throws(()=>buildPackageData(a), /source body/i);
});
test('typed geometry survives compact encoding', () => {
  assert.deepEqual(Array.from(decodeArray(encodeArray(new Float32Array([1,-2.5,300])), 'float')), [1,-2.5,300]);
  assert.deepEqual(Array.from(decodeArray(encodeArray(new Uint32Array([0,65536,2])), 'index')), [0,65536,2]);
});
test('cut-list dimensions are physical part sizes, not the rotated nesting bounding box', () => {
  const a=input();
  Object.assign(a.nest.groups[0].sheets[0].parts[0],{rotation:45,w:127.3,h:127.3});
  const p=buildPackageData(a).parts[0];
  assert.equal(p.length,100); assert.equal(p.width,80);
});
test('inventory thickness belongs to the completed estimate, even if current stock settings changed',()=>{
  const a=input();a.bodies[0].thickness=19.05;
  assert.equal(buildPackageData(a).parts[0].thickness,18);
});
test('manual cut sequence survives the snapshot', async () => {
  const a=input();
  const override = {axis:'rip',distance:40,parentX:0,parentY:0,parentW:500,parentH:500,depth:0,index:1,fromFar:true,isDatum:true};
  // This is the documented layout signature, including a sheet without auto cuts.
  const parts = a.nest.groups[0].sheets[0].parts.map(p=>`${p.x},${p.y},${p.w},${p.h}`).sort().join(';');
  a.overrides = { [`500x500x180#${parts}#`]: {customSteps:[override]} };
  const p=buildPackageData(a);
  assert.ok(p.sheets[0].steps.some(s=>s.distance===40 && s.fromFar && s.isDatum));
});
test('both HTML variants safely embed hostile names and runtime script terminators', () => {
  const a=input(); a.jobName='</script><img src=x onerror=alert(1)>';
  const p=buildPackageData(a);
  for (const mode of ['pc','phone']) {
    const html=buildPackageHtml(p,mode,'console.log("</script>")','body{margin:0}');
    assert.ok(html.includes(`data-layout="${mode}"`));
    assert.equal((html.match(/<\/script>/g)||[]).length,2);
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!/<script[^>]+src=|<link[^>]+href=/.test(html));
    const embedded=html.match(/id="package-data"[^>]*>(.*?)<\/script>/s)[1];
    assert.equal(JSON.parse(embedded).jobName, a.jobName);
  }
});
test('the saved HTML contains every sheet and inventory item before scripts run', () => {
  const p=buildPackageData(input());
  p.sheets.push({...p.sheets[0],number:2,parts:[],steps:[]});
  const html=buildPackageHtml(p,'phone','','');
  const readable=html.replace(/<script\b[^>]*>.*?<\/script>/gs,'');
  assert.match(readable,/Part inventory/);
  for (const text of ['1a','1b','1c','100.0 mm','80.0 mm','18.0 mm','Other cabinet','Unplaced','Segment 1 of 2','Sheet 1','Sheet 2']) {
    assert.ok(readable.includes(text),`Missing readable build information: ${text}`);
  }
  assert.doesNotMatch(readable,/Opening your build package/);
});
test('preview markup escapes part names and displays jobs with only unplaced pieces', () => {
  const p=buildPackageData(input());
  p.sheets=[];
  p.parts=[{...p.parts[3],name:'<img src=x onerror=alert(1)>',fileTag:'Cabinet & shelves',segment:'<b>Segment</b>'}];
  const html=buildPackageHtml(p,'phone','','').replace(/<script\b[^>]*>.*?<\/script>/gs,'');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('Cabinet &amp; shelves'));
  assert.ok(html.includes('&lt;b&gt;Segment&lt;/b&gt;'));
  assert.ok(html.includes('Unplaced'));
  assert.doesNotMatch(html,/<img|<b>Segment/);
});
const cutfile=resolve(root,'tests/_output/package_cuts_test.mjs');
await build({absWorkingDir:root,entryPoints:['app/src/packageCuts.ts'],outfile:cutfile,bundle:true,format:'esm',platform:'node',logLevel:'silent'});
const {cutMeasurement}=await import(pathToFileURL(cutfile));
test('trim measurements identify the near or far physical edge in either sheet orientation',()=>{
  const cases=[
    [500,1000,'rip',25,'left edge'],[500,1000,'rip',475,'right edge'],
    [500,1000,'cross',25,'top edge'],[500,1000,'cross',975,'bottom edge'],
    [1000,500,'cross',25,'left edge'],[1000,500,'cross',975,'right edge'],
    [1000,500,'rip',25,'top edge'],[1000,500,'rip',475,'bottom edge'],
  ];
  for(const [width,length,axis,distance,edge] of cases){
    const sheet={width,length,steps:[]};
    const step={axis,distance,parentX:0,parentY:0,parentW:width,parentH:length,index:1,depth:0,isTrim:true};
    const result=cutMeasurement(step,sheet,{kerf:3,kerfRef:'keeper'});
    assert.equal(result.distance,25);
    assert.equal(result.from,edge,`${width}x${length} ${axis} at ${distance}`);
  }
});

test('cutting dimensions respect kerf, far edges, trims and chained references',()=>{
  const s={width:500,length:1000,steps:[]};
  const c={axis:'rip',distance:100,parentX:0,parentY:0,parentW:500,parentH:1000,index:1,depth:0};
  assert.equal(cutMeasurement(c,s,{kerf:3,kerfRef:'keeper'}).distance,97);
  assert.equal(cutMeasurement(c,s,{kerf:3,kerfRef:'spacing'}).distance,98.5);
  assert.equal(cutMeasurement(c,s,{kerf:3,kerfRef:'center'}).distance,100);
  assert.equal(cutMeasurement({...c,fromFar:true},s,{kerf:3,kerfRef:'keeper'}).distance,397);
  assert.equal(cutMeasurement({...c,isTrim:true,distance:490},s,{kerf:3,kerfRef:'keeper'}).distance,10);
  s.steps=[c];
  const chained=cutMeasurement({...c,distance:200,measureFromCut:'rip|0,0,500,1000|100'},s,{kerf:3,kerfRef:'keeper'});
  assert.equal(chained.distance,97); assert.equal(chained.from,'cut 1');
});
