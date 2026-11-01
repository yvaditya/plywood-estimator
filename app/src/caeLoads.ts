/** Consistent Q4 patch loads, integrated over the material under a footprint.
 * Equal forces per node bias pressure toward densely sampled curved edges.
 * These positive shape-function weights preserve force and first moments.
 */
import type { Vec2 } from './geometry';
import { quadGeometry } from './caeElements';

interface Footprint { x: number; y: number; size: number; shape: 'square' | 'round' }
const signs = [[-1,-1],[1,-1],[1,1],[-1,1]] as const;
const gauss = [-1/Math.sqrt(3),1/Math.sqrt(3)];
const shape = (xi: number, eta: number) => signs.map(([x,y]) => (1+x*xi)*(1+y*eta)/4);
const cross = (a: Vec2,b: Vec2,p: Vec2) => (b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);

/** Clip a convex polygon to another CCW convex polygon. */
function clip(subject: Vec2[], boundary: Vec2[]): Vec2[] {
  let result = subject;
  for(let i=0;i<boundary.length && result.length;i++) {
    const a=boundary[i],b=boundary[(i+1)%boundary.length],input=result;
    result=[];
    let last=input[input.length-1],lastD=cross(a,b,last);
    for(const p of input) {
      const d=cross(a,b,p);
      if((d>=0)!==(lastD>=0)) {
        const t=lastD/(lastD-d);
        result.push([last[0]+t*(p[0]-last[0]),last[1]+t*(p[1]-last[1])]);
      }
      if(d>=0) result.push(p);
      last=p;lastD=d;
    }
  }
  return result;
}

/** Invert a convex bilinear Q4 map at an interior quadrature point. */
function shapeAt(q: Vec2[],p: Vec2): number[] {
  const local=q.map(v=>[v[0]-q[0][0],v[1]-q[0][1]]);
  const target=[p[0]-q[0][0],p[1]-q[0][1]];
  const tol=Math.max(...local.map(v=>Math.hypot(...v)),1)*1e-11;
  let xi=0,eta=0;
  for(let it=0;it<40;it++) {
    const N=shape(xi,eta);
    let rx=-target[0],ry=-target[1],xx=0,xe=0,yx=0,ye=0;
    for(let i=0;i<4;i++) {
      const [sx,sy]=signs[i],dx=sx*(1+sy*eta)/4,de=sy*(1+sx*xi)/4;
      rx+=N[i]*local[i][0];ry+=N[i]*local[i][1];
      xx+=dx*local[i][0];xe+=de*local[i][0];yx+=dx*local[i][1];ye+=de*local[i][1];
    }
    if(Math.hypot(rx,ry)<=tol) return N;
    const det=xx*ye-xe*yx,dx=(ye*rx-xe*ry)/det,de=(-yx*rx+xx*ry)/det;
    // Remain in the valid natural domain, including highly skewed elements.
    let step=1;
    if(Math.abs(xi-dx)>1) step=Math.min(step,.99*(1+Math.sign(dx)*xi)/Math.abs(dx));
    if(Math.abs(eta-de)>1) step=Math.min(step,.99*(1+Math.sign(de)*eta)/Math.abs(de));
    xi-=step*dx;eta-=step*de;
  }
  throw new Error('Could not integrate the load on a distorted element. Refine the mesh.');
}

export function patchNodalWeights(uv: Vec2[],quads: number[][],load: Footprint): Float64Array {
  if(![load.x,load.y,load.size].every(Number.isFinite) || load.size<0)
    throw new Error('Load coordinates and footprint size must be finite, with a nonnegative size.');
  const weights=new Float64Array(uv.length);
  if(load.size===0) {
    // Explicit point loads retain the documented nearest active node rule.
    let nearest=-1,distance=Infinity;
    for(const n of new Set(quads.flat())) {
      const d=Math.hypot(uv[n][0]-load.x,uv[n][1]-load.y);
      if(d<distance) {nearest=n;distance=d;}
    }
    if(nearest>=0) weights[nearest]=1;
    return weights;
  }
  const r=load.size/2,x0=load.x-r,x1=load.x+r,y0=load.y-r,y1=load.y+r;
  // A regular 128-gon gives <0.041% circle-area error, independent of size.
  // Both clipping and weighting use this same footprint approximation.
  const footprint: Vec2[]=load.shape==='square' ? [[x0,y0],[x1,y0],[x1,y1],[x0,y1]] :
    Array.from({length:128},(_,i)=>[load.x+r*Math.cos(2*Math.PI*i/128),load.y+r*Math.sin(2*Math.PI*i/128)]);
  const inside=(p: Vec2)=>load.shape==='round'
    ? Math.hypot(p[0]-load.x,p[1]-load.y)<=r*Math.cos(Math.PI/128)
    : p[0]>=x0 && p[0]<=x1 && p[1]>=y0 && p[1]<=y1;
  for(const ids of quads) {
    const q=ids.map(i=>uv[i]);
    if(q.every(p=>p[0]<x0) || q.every(p=>p[0]>x1) || q.every(p=>p[1]<y0) || q.every(p=>p[1]>y1)) continue;
    if(q.every(inside)) {
      // Full-element 2x2 Gauss integration is exact for N_i det(J).
      for(const xi of gauss) for(const eta of gauss) {
        const {N,det}=quadGeometry(q,xi,eta);
        for(let i=0;i<4;i++) weights[ids[i]]+=N[i]*det;
      }
    } else {
      // Clip the footprint against only four element edges, including when a
      // small patch lies entirely between nodes. Holes have no elements.
      const polygon=clip(footprint,q);
      for(let i=1;i+1<polygon.length;i++) {
        const a=polygon[0],b=polygon[i],c=polygon[i+1],area=Math.abs(cross(a,b,c))/2;
        if(area<=0) continue;
        // Three positive triangle quadrature points. Partition of unity and
        // Q4 linear completeness preserve the clipped area's exact centroid.
        for(const bary of [[2/3,1/6,1/6],[1/6,2/3,1/6],[1/6,1/6,2/3]]) {
          const p: Vec2=[bary[0]*a[0]+bary[1]*b[0]+bary[2]*c[0],bary[0]*a[1]+bary[1]*b[1]+bary[2]*c[1]];
          const N=shapeAt(q,p);
          for(let j=0;j<4;j++) weights[ids[j]]+=N[j]*area/3;
        }
      }
    }
  }
  const total=weights.reduce((a,b)=>a+b,0);
  if(!(total>0)) throw new Error('Load footprint does not overlap panel material. Move it onto the panel.');
  for(let i=0;i<weights.length;i++) weights[i]/=total;
  return weights;
}
