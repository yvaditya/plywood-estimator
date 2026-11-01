/** Actual finite-element edges, without the triangle diagonals used for rendering faces. */
export function elementEdges(elems: Int32Array, nodesPerElem: 4 | 8): Uint32Array {
  const pairs = nodesPerElem === 8
    ? [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]]
    : [[0,1],[1,2],[2,3],[3,0]];
  const seen = new Set<string>();
  const edges: number[] = [];
  for (let base = 0; base < elems.length; base += nodesPerElem) {
    for (const [a,b] of pairs) {
      const i = elems[base+a], j = elems[base+b];
      const key = `${Math.min(i,j)},${Math.max(i,j)}`;
      if (!seen.has(key)) { seen.add(key); edges.push(i,j); }
    }
  }
  return Uint32Array.from(edges);
}
