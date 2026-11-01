import type { Vec2 } from './geometry';

/** Rasterize the same two triangles per Q4 used by the mesh viewer. NaN leaves
 * holes and space outside the element mesh transparent in the CAD overlay. */
export function rasterizeQuadField(uv: Vec2[], quads: [number,number,number,number][], values: Float32Array, resolution = 256) {
  let w=0,h=0;
  for(const [x,y] of uv) { w=Math.max(w,x); h=Math.max(h,y); }
  const longest=Math.max(w,h,1);
  const nx=Math.max(2,Math.ceil(resolution*w/longest)), ny=Math.max(2,Math.ceil(resolution*h/longest));
  const field=new Float32Array(nx*ny).fill(NaN);
  if(!(w>0 && h>0)) return {nx,ny,field};
  for(const q of quads) for(const ids of [[q[0],q[1],q[2]],[q[0],q[2],q[3]]]) {
    const [a,b,c]=ids.map(i=>uv[i]), [va,vb,vc]=ids.map(i=>values[i]);
    if(![va,vb,vc].every(Number.isFinite)) continue;
    const det=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    if(!(det>0)) continue;
    const x0=Math.max(0,Math.floor(Math.min(a[0],b[0],c[0])/w*nx));
    const x1=Math.min(nx-1,Math.floor(Math.max(a[0],b[0],c[0])/w*nx));
    const y0=Math.max(0,Math.floor(Math.min(a[1],b[1],c[1])/h*ny));
    const y1=Math.min(ny-1,Math.floor(Math.max(a[1],b[1],c[1])/h*ny));
    for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++) {
      const px=(x+.5)*w/nx-a[0], py=(y+.5)*h/ny-a[1];
      const u=(px*(c[1]-a[1])-py*(c[0]-a[0]))/det;
      const v=((b[0]-a[0])*py-(b[1]-a[1])*px)/det;
      if(u>=-1e-9 && v>=-1e-9 && u+v<=1+1e-9) field[y*nx+x]=va*(1-u-v)+vb*u+vc*v;
    }
  }
  return {nx,ny,field};
}
