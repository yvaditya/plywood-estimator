/** Joint-aware stock correction for verified rectangular panel assemblies.
 * All edits are proposals built from immutable, double-precision source meshes.
 * The viewer is deliberately not involved in geometry inference or validation.
 */
import clip from 'polygon-clipping';
import type { MultiPolygon, Polygon } from 'polygon-clipping';
import type { Vec3, BodyAnalysis } from './geometry';
import type { OcctMesh } from './stepLoader';
import type { PlacedStepPart } from './stepExport';

export interface CorrectionInput { id: number; name: string; mesh: OcctMesh; editable?: boolean }
export interface CorrectionOptions { sourceThickness: number; targetThickness: number; tolerance?: number }
export interface Bounds { min: Vec3; max: Vec3 }
export interface CorrectionIssue { severity: 'error' | 'warning'; message: string; bodyIds: number[] }
export interface PanelContact {
  a: number; b: number; axis: number; sideA: number; sideB: number;
  gap: number; area: number; kind: 'end-to-face' | 'end-to-end' | 'face-to-face';
}
export interface CorrectedPanel extends CorrectionInput {
  before: Bounds; after: Bounds; thicknessAxis: number; originalThickness: number; thickness: number;
}
export interface CorrectionChange {
  id: number; name: string; before: Vec3; after: Vec3; translation: Vec3; reasons: string[];
}
export interface FaceReference { id: number; axis: number; side: number }
export interface CorrectionProposal {
  ok: boolean; sourceThickness: number; targetThickness: number;
  frame: [Vec3, Vec3, Vec3]; panels: CorrectedPanel[]; contacts: PanelContact[];
  changes: CorrectionChange[]; issues: CorrectionIssue[]; references: FaceReference[];
  excluded: { id: number; name: string; reason: string }[];
  validation: { maxJointGapError: number; perimeterError: number; collisionCount: number };
}
const EPS = 1e-6;
const dot = (a: Vec3, b: Vec3) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(...a); return a.map(v => v/l) as Vec3; };
const size = (b: Bounds): Vec3 => sub(b.max, b.min);
const at = (b: Bounds, axis: number, side: number) => (side ? b.max : b.min)[axis];
const world = (p: Vec3, frame: Vec3[]): Vec3 => [0,1,2].map(i => p[0]*frame[0][i]+p[1]*frame[1][i]+p[2]*frame[2][i]) as Vec3;
const canonical = (v: Vec3): Vec3 => {
  const sign = v.find(n => Math.abs(n)>EPS)! < 0 ? -1 : 1;
  return v.map(n => n*sign) as Vec3;
};

function vertices(mesh: OcctMesh, frame: Vec3[]): Vec3[] {
  const a = mesh.attributes.position.array, out: Vec3[] = [];
  for (let i=0;i<a.length;i+=3) {
    const p: Vec3 = [a[i],a[i+1],a[i+2]];
    out.push(frame.map(ax => dot(p,ax)) as Vec3);
  }
  return out;
}
function bounds(points: Vec3[]): Bounds {
  const b: Bounds = { min: [Infinity,Infinity,Infinity], max: [-Infinity,-Infinity,-Infinity] };
  for (const p of points) for (let k=0;k<3;k++) { b.min[k]=Math.min(b.min[k],p[k]); b.max[k]=Math.max(b.max[k],p[k]); }
  return b;
}
function isPlanar(mesh: OcctMesh): boolean {
  const p=vertices(mesh,[[1,0,0],[0,1,0],[0,0,1]]),origin=p[0];
  let longest:Vec3=[0,0,0],normal:Vec3=[0,0,0];
  for(const v of p){const d=sub(v,origin);if(Math.hypot(...d)>Math.hypot(...longest))longest=d;}
  for(const v of p){const n=cross(longest,sub(v,origin));if(Math.hypot(...n)>Math.hypot(...normal))normal=n;}
  if(Math.hypot(...normal)<EPS)return true;
  normal=unit(normal);
  return p.every(v=>Math.abs(dot(sub(v,origin),normal))<EPS);
}
function commonFrame(inputs: CorrectionInput[]): [Vec3,Vec3,Vec3] {
  const axes: Vec3[] = [];
  for (const {mesh} of inputs) {
    const p = vertices(mesh, [[1,0,0],[0,1,0],[0,0,1]]), ids=mesh.index.array;
    for (let i=0;i<ids.length;i+=3) {
      if (!p[ids[i]] || !p[ids[i+1]] || !p[ids[i+2]]) continue;
      const n=cross(sub(p[ids[i+1]],p[ids[i]]),sub(p[ids[i+2]],p[ids[i]]));
      if (Math.hypot(...n)<EPS) continue;
      const u=canonical(unit(n));
      if (!axes.length) axes.push(u);
      else if (Math.abs(dot(axes[0],u))<EPS) return [axes[0],u,unit(cross(axes[0],u))];
    }
  }
  return [[1,0,0],[0,1,0],[0,0,1]];
}

/** Reject pockets, holes, missing faces, overlaps, and malformed triangles.
 * A bounding rectangle alone is not evidence of a solid rectangular board. */
function prismProblem(mesh: OcctMesh, p: Vec3[], b: Bounds): string | null {
  const s=size(b), ids=mesh.index.array, faceAreas=new Float64Array(6);
  const edges=new Map<string,{count:number;sense:number}>();
  const key=(v:Vec3) => v.map((x,k)=>Math.round((x-b.min[k])*1e5)).join(',');
  let volume=0;
  if (ids.length%3) return 'Incomplete triangle data.';
  for (let i=0;i<ids.length;i+=3) {
    const a=p[ids[i]], c=p[ids[i+1]], d=p[ids[i+2]];
    if (!a || !c || !d) return 'Invalid triangle indices.';
    const normal=cross(sub(c,a),sub(d,a)), area=Math.hypot(...normal)/2;
    if (area<EPS) continue;
    let face=-1;
    for (let k=0;k<3;k++) for (const side of [0,1]) {
      if ([a,c,d].every(v=>Math.abs(v[k]-at(b,k,side))<1e-4)) face=2*k+side;
    }
    if (face<0) return 'Shaped joinery or a non-rectangular face needs manual CAD editing.';
    if (normal[Math.floor(face/2)]*(face%2 ? 1 : -1)<=0) return 'Inconsistent solid face orientation.';
    faceAreas[face]+=area;
    volume+=dot(sub(a,b.min),cross(sub(c,b.min),sub(d,b.min)))/6;
    const v=[key(a),key(c),key(d)];
    for (let k=0;k<3;k++) {
      const x=v[k],y=v[(k+1)%3],forward=x<y, edgeKey=forward ? `${x}/${y}` : `${y}/${x}`;
      const e=edges.get(edgeKey)??{count:0,sense:0}; e.count++; e.sense+=forward?1:-1; edges.set(edgeKey,e);
    }
  }
  for (let k=0;k<3;k++) for (const side of [0,1]) {
    const expected=s[(k+1)%3]*s[(k+2)%3];
    if (Math.abs(faceAreas[k*2+side]-expected)>Math.max(0.01,expected*1e-5)) return 'A face is missing, pocketed, or overlaps another face.';
  }
  if ([...edges.values()].some(e=>e.count!==2||e.sense!==0)) return 'The mesh is not a closed manifold rectangular solid.';
  const expected=s[0]*s[1]*s[2];
  if (Math.abs(volume-expected)>Math.max(0.01,expected*1e-5)) return 'The solid volume does not match a rectangular board.';
  return null;
}

function contactsFor(panels: CorrectedPanel[], tolerance: number): PanelContact[] {
  const out: PanelContact[]=[];
  for (let i=0;i<panels.length;i++) for (let j=i+1;j<panels.length;j++) {
    const a=panels[i],b=panels[j];
    for (let axis=0;axis<3;axis++) {
      const others=[0,1,2].filter(k=>k!==axis);
      const overlap=others.map(k=>Math.min(a.before.max[k],b.before.max[k])-Math.max(a.before.min[k],b.before.min[k]));
      if (overlap.some(x=>x<=EPS)) continue;
      for (const sideA of [0,1]) {
        const sideB=1-sideA;
        const gap=(at(b.before,axis,sideB)-at(a.before,axis,sideA))*(sideA?1:-1);
        if (Math.abs(gap)>tolerance) continue;
        const faces=Number(a.thicknessAxis===axis)+Number(b.thicknessAxis===axis);
        out.push({a:a.id,b:b.id,axis,sideA,sideB,gap,area:overlap[0]*overlap[1],
          kind:faces===2?'face-to-face':faces===1?'end-to-face':'end-to-end'});
      }
    }
  }
  return out;
}

// Projection exterior rings deliberately exclude internal openings. Coordinate
// snapping only suppresses importer roundoff; it never closes a design gap.
const snap=(n:number)=>Math.round(n*1e5)/1e5;
function exterior(panels: CorrectedPanel[], a:number,b:number, after=false): MultiPolygon {
  const polys: Polygon[]=panels.map(p=> {
    const box=after?p.after:p.before, x=snap(box.min[a]),y=snap(box.min[b]),X=snap(box.max[a]),Y=snap(box.max[b]);
    return [[[x,y],[X,y],[X,Y],[x,Y],[x,y]]];
  });
  return polys.length ? clip.union(polys[0],...polys.slice(1)).map(poly=>[poly[0]]) : [];
}
function exteriorReferences(panels: CorrectedPanel[]): FaceReference[] {
  const refs=new Map<string,FaceReference>();
  for (const [a,b] of [[0,1],[0,2],[1,2]]) {
    for (const poly of exterior(panels,a,b)) {
      const ring=poly[0];
      for (let i=1;i<ring.length;i++) {
        const u=ring[i-1],v=ring[i];
        const coord=Math.abs(u[0]-v[0])<EPS?0:1, axis=coord===0?a:b, along=coord===0?b:a;
        const low=Math.min(u[1-coord],v[1-coord]),high=Math.max(u[1-coord],v[1-coord]);
        for (const p of panels) for (const side of [0,1]) {
          if (Math.abs(at(p.before,axis,side)-u[coord])>2e-5) continue;
          if (Math.min(p.before.max[along],high)-Math.max(p.before.min[along],low)<=EPS) continue;
          refs.set(`${p.id}/${axis}/${side}`,{id:p.id,axis,side});
        }
      }
    }
  }
  return [...refs.values()];
}

/** A projection can hide a recessed front behind tall side walls. Anchor the
 * outward-facing broad side when it has an unobstructed path to outside air.
 * The inward face is allowed to move, as required by the stock correction. */
function recessedReferences(panels: CorrectedPanel[], ambiguous: (id:number)=>void): FaceReference[] {
  const result:FaceReference[]=[],all=bounds(panels.flatMap(p=>[p.before.min,p.before.max]));
  for(const p of panels) {
    const axis=p.thicknessAxis,others=[0,1,2].filter(k=>k!==axis),[u,v]=others;
    const relative=(p.before.min[axis]+p.before.max[axis]-all.min[axis]-all.max[axis])/2;
    const b=p.before;
    const face:Polygon=[[[b.min[u],b.min[v]],[b.max[u],b.min[v]],[b.max[u],b.max[v]],[b.min[u],b.max[v]],[b.min[u],b.min[v]]]];
    const exposedSides=[0,1].filter(side=>{
      const coord=at(p.before,axis,side);
      const blockers:Polygon[]=panels.filter(q=>q!==p && (side?q.before.min[axis]>=coord-EPS:q.before.max[axis]<=coord+EPS))
        .map(q=>{const a=q.before;return [[[a.min[u],a.min[v]],[a.max[u],a.min[v]],[a.max[u],a.max[v]],[a.min[u],a.max[v]],[a.min[u],a.min[v]]]];});
      return polygonArea(blockers.length?clip.difference(face,...blockers):[face])>EPS;
    });
    if(exposedSides.length===1)result.push({id:p.id,axis,side:exposedSides[0]});
    else if(exposedSides.length===2) {
      if(Math.abs(relative)<EPS) {
        if(Math.abs(p.thickness-p.originalThickness)>EPS)ambiguous(p.id);
        else result.push({id:p.id,axis,side:0},{id:p.id,axis,side:1});
      } else result.push({id:p.id,axis,side:relative>0?1:0});
    }
  }
  return result;
}

function connectedGroups(panels: CorrectedPanel[], contacts: PanelContact[]): CorrectedPanel[][] {
  const neighbours=new Map(panels.map(p=>[p.id,[] as number[]]));
  for(const c of contacts){neighbours.get(c.a)!.push(c.b);neighbours.get(c.b)!.push(c.a);}
  const byId=new Map(panels.map(p=>[p.id,p])),seen=new Set<number>(),groups:CorrectedPanel[][]=[];
  for(const p of panels) {
    if(seen.has(p.id))continue;
    const stack=[p.id],group:CorrectedPanel[]=[];seen.add(p.id);
    while(stack.length){const id=stack.pop()!;group.push(byId.get(id)!);
      for(const n of neighbours.get(id)!)if(!seen.has(n)){seen.add(n);stack.push(n);}}
    groups.push(group);
  }
  return groups;
}

/** Difference constraints x[a]-x[b]=offset. Each connected set has only a
 * translation left; contradictory contact/exterior constraints are explicit. */
class Differences {
  parent:number[]; delta:number[];
  constructor(n:number) { this.parent=Array.from({length:n},(_,i)=>i); this.delta=Array(n).fill(0); }
  root(a:number):number {
    if(this.parent[a]!==a) {const p=this.parent[a];this.parent[a]=this.root(p);this.delta[a]+=this.delta[p];}
    return this.parent[a];
  }
  equal(a:number,b:number,offset:number):boolean {
    const A=this.root(a),B=this.root(b),d=offset-this.delta[a]+this.delta[b];
    if(A===B) return Math.abs(d)<EPS;
    this.parent[A]=B;this.delta[A]=d;return true;
  }
  values(anchor:number):number[] {
    const sums=new Map<number,{sum:number;n:number}>();
    for(let i=0;i<anchor;i++){const r=this.root(i),s=sums.get(r)??{sum:0,n:0};s.sum+=this.delta[i];s.n++;sums.set(r,s);}
    const root=this.root(anchor),ref=-this.delta[anchor];
    return Array.from({length:anchor},(_,i)=>{
      const r=this.root(i),s=sums.get(r)!;return this.delta[i]+(r===root?ref:-s.sum/s.n);
    });
  }
}

function remapMesh(input: OcctMesh, before: Bounds, after: Bounds, frame: Vec3[]): OcctMesh {
  const out=structuredClone(input), p=vertices(input,frame), a=out.attributes.position.array;
  for(let i=0;i<p.length;i++) {
    const q=p[i].map((x,k)=>after.min[k]+(x-before.min[k])*(after.max[k]-after.min[k])/(before.max[k]-before.min[k])) as Vec3;
    const w=world(q,frame); for(let k=0;k<3;k++)a[i*3+k]=w[k];
  }
  return out; // An orthogonal box stretch leaves the face normals unchanged.
}
function polygonArea(polys: MultiPolygon): number {
  let total=0;
  for(const poly of polys) poly.forEach((ring,index)=>{
    let a=0; for(let i=1;i<ring.length;i++)a+=ring[i-1][0]*ring[i][1]-ring[i][0]*ring[i-1][1];
    total+=(index?-1:1)*Math.abs(a)/2;
  });
  return total;
}

export function correctThickness(inputs: CorrectionInput[], options: CorrectionOptions): CorrectionProposal {
  const {sourceThickness,targetThickness}=options,tolerance=options.tolerance??0.05;
  const out:CorrectionProposal={ok:false,sourceThickness,targetThickness,frame:[[1,0,0],[0,1,0],[0,0,1]],
    panels:[],contacts:[],changes:[],issues:[],references:[],excluded:[],
    validation:{maxJointGapError:0,perimeterError:0,collisionCount:0}};
  const issue=(message:string,bodyIds:number[]=[],severity:'error'|'warning'='error')=>out.issues.push({message,bodyIds,severity});
  if (![sourceThickness,targetThickness,tolerance].every(n=>Number.isFinite(n)&&n>0) || tolerance>0.5) {
    issue('Enter positive finite stock thicknesses and a contact tolerance no greater than 0.5 mm.'); return out;
  }
  if(!inputs.length){issue('Load a cabinet before analysing thickness correction.');return out;}
  if(new Set(inputs.map(i=>i.id)).size!==inputs.length){issue('Duplicate source body identities.');return out;}
  if(inputs.some(i=>!i.mesh?.attributes?.position?.array?.length || i.mesh.attributes.position.array.length%3 ||
    i.mesh.attributes.position.array.some(v=>!Number.isFinite(v)) || !i.mesh.index?.array?.length)) {
    issue('The cabinet contains invalid or empty mesh geometry.');return out;
  }
  const references=new Set(inputs.filter(i=>isPlanar(i.mesh)).map(i=>i.id));
  out.frame=commonFrame(inputs.filter(i=>!references.has(i.id)&&i.editable!==false));
  for(const input of inputs) {
    if(references.has(input.id)){out.excluded.push({id:input.id,name:input.name,reason:'Zero-thickness reference surface; excluded from panel-solid STEP export.'});continue;}
    const p=vertices(input.mesh,out.frame),b=bounds(p),s=size(b),thin=s.indexOf(Math.min(...s));
    if(input.editable===false){issue(`${input.name}: unsupported non-sheet solid. Correct this body in the source CAD before automatic panel correction.`,[input.id]);continue;}
    const problem=prismProblem(input.mesh,p,b);
    if(problem){issue(`${input.name}: ${problem}`,[input.id]);continue;}
    out.panels.push({...input,mesh:structuredClone(input.mesh),before:b,after:structuredClone(b),thicknessAxis:thin,
      originalThickness:s[thin],thickness:Math.abs(s[thin]-sourceThickness)<=tolerance?targetThickness:s[thin]});
  }
  if(out.excluded.length)issue(`${out.excluded.length} zero-thickness reference surface(s) will not be included in the panel-solid STEP.`,out.excluded.map(x=>x.id),'warning');
  if(out.issues.some(i=>i.severity==='error'))return out;
  const panels=out.panels,byId=new Map(panels.map(p=>[p.id,p])),indices=new Map(panels.map((p,i)=>[p.id,i]));
  if(!panels.some(p=>Math.abs(p.originalThickness-sourceThickness)<=tolerance)){issue('No rectangular panels match the source thickness.');return out;}
  for(let i=0;i<panels.length;i++)for(let j=i+1;j<panels.length;j++) {
    if([0,1,2].every(k=>Math.min(panels[i].before.max[k],panels[j].before.max[k])-Math.max(panels[i].before.min[k],panels[j].before.min[k])>EPS))
      issue(`Existing solids overlap: ${panels[i].name} and ${panels[j].name}.`,[panels[i].id,panels[j].id]);
  }
  if(out.issues.some(i=>i.severity==='error'))return out;
  out.contacts=contactsFor(panels,tolerance);
  const groups=connectedGroups(panels,out.contacts);
  out.references=groups.flatMap(group=>[...exteriorReferences(group),...recessedReferences(group,id=>
    issue(`${byId.get(id)!.name}: both broad faces are exposed and centred. An outside anchor is ambiguous; review this board in the source CAD.`,[id]))]);
  if(out.issues.some(i=>i.severity==='error'))return out;
  for(let axis=0;axis<3;axis++) {
    const anchor=panels.length*2,ds=new Differences(anchor+1);
    const eq=(a:number,b:number,d:number,reason:string,ids:number[])=>{if(!ds.equal(a,b,d))issue(reason,ids);};
    for(const [i,p] of panels.entries()) if(p.thicknessAxis===axis)
      eq(2*i+1,2*i,p.thickness-p.originalThickness,`${p.name}: stock thickness conflicts with its joint constraints.`,[p.id]);
    for(const c of out.contacts.filter(c=>c.axis===axis))
      eq(2*indices.get(c.a)!+c.sideA,2*indices.get(c.b)!+c.sideB,0,
        `Joint between ${byId.get(c.a)!.name} and ${byId.get(c.b)!.name} cannot keep both stock thickness and contact.`,[c.a,c.b]);
    for(const r of out.references.filter(r=>r.axis===axis))
      eq(2*indices.get(r.id)!+r.side,anchor,0,`${byId.get(r.id)!.name}: preserving this exterior face conflicts with the new thickness. Review its outside anchor.`,[r.id]);
    if(out.issues.some(i=>i.severity==='error'))return out;
    // Preserve unconstrained board lengths before resolving remaining freedom
    // by minimum translation. Hard joint and exterior equalities always win.
    for(const [i,p] of panels.entries())if(p.thicknessAxis!==axis)ds.equal(2*i+1,2*i,0);
    const delta=ds.values(anchor);
    panels.forEach((p,i)=>{p.after.min[axis]+=delta[2*i];p.after.max[axis]+=delta[2*i+1];});
  }
  for(const p of panels) {
    if(size(p.after).some(n=>n<=EPS)){issue(`${p.name}: correction would produce a non-positive board dimension.`,[p.id]);continue;}
    const before=size(p.before),after=size(p.after),move=world(before.map((_,k)=>(p.after.min[k]+p.after.max[k]-p.before.min[k]-p.before.max[k])/2) as Vec3,out.frame);
    p.mesh=remapMesh(p.mesh,p.before,p.after,out.frame);
    if(after.some((n,k)=>Math.abs(n-before[k])>EPS)||move.some(n=>Math.abs(n)>EPS)) {
      const neighbours=out.contacts.filter(c=>c.a===p.id||c.b===p.id).map(c=>byId.get(c.a===p.id?c.b:c.a)!.name);
      const reasons=[...(Math.abs(p.thickness-p.originalThickness)>EPS?['Measured stock thickness']:[]),
        ...(neighbours.length?[`Keep joints with ${[...new Set(neighbours)].join(', ')}`]:[]),
        ...(out.references.some(r=>r.id===p.id)?['Preserve outside reference faces']:[])];
      out.changes.push({id:p.id,name:p.name,before,after,translation:move,reasons});
    }
  }
  for(const c of out.contacts) {
    const a=byId.get(c.a)!.after,b=byId.get(c.b)!.after;
    const gap=(at(b,c.axis,c.sideB)-at(a,c.axis,c.sideA))*(c.sideA?1:-1);
    out.validation.maxJointGapError=Math.max(out.validation.maxJointGapError,Math.abs(gap-c.gap));
    if(Math.abs(gap-c.gap)>EPS || [0,1,2].filter(k=>k!==c.axis).some(k=>Math.min(a.max[k],b.max[k])-Math.max(a.min[k],b.min[k])<=EPS))
      issue('A corrected joint has lost face contact.',[c.a,c.b]);
  }
  for(let i=0;i<panels.length;i++)for(let j=i+1;j<panels.length;j++) {
    if([0,1,2].every(k=>Math.min(panels[i].after.max[k],panels[j].after.max[k])-Math.max(panels[i].after.min[k],panels[j].after.min[k])>EPS)) {
      out.validation.collisionCount++;issue(`Correction creates an overlap: ${panels[i].name} and ${panels[j].name}.`,[panels[i].id,panels[j].id]);
    }
  }
  for(const group of groups)for(const [a,b] of [[0,1],[0,2],[1,2]]) {
    const old=exterior(group,a,b),next=exterior(group,a,b,true);
    const mismatch=polygonArea(clip.xor(old,next));
    const span=Math.sqrt(Math.max(1,polygonArea(old)));
    out.validation.perimeterError=Math.max(out.validation.perimeterError,mismatch/span);
  }
  for(const ref of out.references){
    const p=byId.get(ref.id)!;
    out.validation.perimeterError=Math.max(out.validation.perimeterError,Math.abs(at(p.after,ref.axis,ref.side)-at(p.before,ref.axis,ref.side)));
  }
  if(out.validation.perimeterError>tolerance)issue('The corrected outside outline would change. Review the exterior anchors.');
  out.ok=!out.issues.some(i=>i.severity==='error');
  return out;
}

/** Export in source coordinates, undoing only the UI's import translation. */
export function correctionStepParts(proposal: CorrectionProposal, sourceOffset: Vec3 = [0,0,0]): PlacedStepPart[] {
  if(!proposal.ok)throw new Error('A valid correction is required before STEP export.');
  if(sourceOffset.some(n=>!Number.isFinite(n)))throw new Error('Invalid source coordinate offset.');
  return proposal.panels.map(p=>{
    const n=p.thicknessAxis,u=(n+1)%3,v=(n+2)%3,s=size(p.after);
    const origin=sub(world(p.after.min,proposal.frame),sourceOffset);
    return {name:p.name,origin,uAxis:proposal.frame[u],vAxis:proposal.frame[v],normal:proposal.frame[n],
      outer:[[0,0],[s[u],0],[s[u],s[v]],[0,s[v]]],holes:[],thickness:s[n],
      color:p.mesh.color ? [...p.mesh.color] : undefined};
  });
}

/** The corrected board is already a verified prism with a known thickness
 * axis. Do not reclassify it using the importer's nominal-stock size limits. */
export function correctedPanelAnalysis(panel: CorrectedPanel, frame: [Vec3,Vec3,Vec3]): BodyAnalysis {
  const s=size(panel.after),n=panel.thicknessAxis;
  const plane=[0,1,2].filter(k=>k!==n).sort((a,b)=>s[b]-s[a]),[l,w]=plane;
  const center=panel.after.min.map((v,k)=>(v+panel.after.max[k])/2) as Vec3;
  const face=[...center] as Vec3;face[n]=panel.after.max[n];
  const centerWorld=world(center,frame),faceCenter=world(face,frame);
  let topZ=-Infinity;
  for(const x of [0,1])for(const y of [0,1])for(const z of [0,1])
    topZ=Math.max(topZ,world([at(panel.after,0,x),at(panel.after,1,y),at(panel.after,2,z)],frame)[2]);
  return {thickness:s[n],length:s[l],width:s[w],volume:s[0]*s[1]*s[2],centerWorld,faceCenter,topZ,
    faceNormal:frame[n],lengthDir:frame[l],widthDir:frame[w],lengthAxisIsX:Math.abs(frame[l][0])>0.5,
    outline:{outer:[[0,0],[s[l],0],[s[l],s[w]],[0,s[w]]],holes:[],bbox:{w:s[l],h:s[w]},area:s[l]*s[w]}};
}
