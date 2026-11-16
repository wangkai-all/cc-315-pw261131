import { gridKey } from './geometry.js';
import { versionOf } from './versioning.js';

/**
 * Road network with Dijkstra routing. Nodes are addressed by stable string ids.
 * Routing cost is travel TIME (seconds), so a long motorway edge can be cheaper
 * than a short congested street. `distanceM` is reported alongside.
 */

const TURN_PENALTY_S = 6;

export class RoadNetwork {
  constructor(nodes, edges, meta = {}) {
    this.nodes = nodes; // {id,x,y,name?,kind?}
    this.edges = edges; // {from,to,distanceM,speedKmh,class}
    this.meta = meta;
    this.adj = new Map();
    this.nodeById = new Map();
    for (const node of nodes) {
      this.nodeById.set(node.id, node);
      this.adj.set(node.id, []);
    }
    for (const edge of edges) {
      if (!this.nodeById.has(edge.from) || !this.nodeById.has(edge.to)) {
        throw new Error(`edge references unknown node: ${edge.from} -> ${edge.to}`);
      }
      const seconds = (edge.distanceM / 1000 / edge.speedKmh) * 3600;
      const fwd = { to: edge.to, seconds, distanceM: edge.distanceM, cls: edge.class, edge };
      const rev = { to: edge.from, seconds, distanceM: edge.distanceM, cls: edge.class, edge };
      this.adj.get(edge.from).push(fwd);
      if (!edge.oneway) this.adj.get(edge.to).push(rev);
    }
    this.version = versionOf(this.serializable(), 'net');
  }

  serializable() {
    return {
      nodes: this.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, name: n.name ?? null, kind: n.kind ?? null })),
      edges: this.edges.map((e) => ({ from: e.from, to: e.to, distanceM: e.distanceM, speedKmh: e.speedKmh, class: e.class, oneway: !!e.oneway })),
      meta: this.meta,
    };
  }

  /** Single-source shortest paths. Returns Map nodeId -> {seconds, distanceM, path}. */
  shortestPaths(sourceId, { cutoffSeconds = Infinity } = {}) {
    const result = new Map();
    if (!this.nodeById.has(sourceId)) return result;
    const dist = new Map([[sourceId, 0]]);
    const metres = new Map([[sourceId, 0]]);
    const prev = new Map();
    const visited = new Set();
    // Binary heap of [seconds, node]
    const heap = new MinHeap();
    heap.push([0, sourceId]);
    while (heap.size) {
      const [d, id] = heap.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      if (d > cutoffSeconds) continue;
      result.set(id, { seconds: d, distanceM: metres.get(id) ?? 0, previous: prev.get(id) ?? null });
      for (const link of this.adj.get(id)) {
        const nd = d + link.seconds + (prev.has(id) ? TURN_PENALTY_S : 0);
        if (nd < (dist.get(link.to) ?? Infinity) && nd <= cutoffSeconds) {
          dist.set(link.to, nd);
          metres.set(link.to, (metres.get(id) ?? 0) + link.distanceM);
          prev.set(link.to, id);
          heap.push([nd, link.to]);
        }
      }
    }
    return result;
  }

  /** One-to-one route with path reconstruction; used for sanity checks. */
  route(sourceId, targetId) {
    const paths = this.shortestPaths(sourceId);
    const hit = paths.get(targetId);
    if (!hit) return null;
    const path = [targetId];
    let cur = targetId;
    while (hit.previous !== null && cur !== sourceId) {
      cur = paths.get(cur).previous;
      path.push(cur);
    }
    return { ...hit, path: path.reverse() };
  }

  nodeAtGrid(x, y, cell = 25) {
    return this.gridIndex?.get(gridKey(x, y, cell)) ?? null;
  }

  buildGridIndex(cell = 25) {
    this.gridIndex = new Map();
    for (const node of this.nodes) {
      const key = gridKey(node.x, node.y, cell);
      if (!this.gridIndex.has(key)) this.gridIndex.set(key, []);
      this.gridIndex.get(key).push(node);
    }
    this.gridCell = cell;
  }

  nearestNode(x, y) {
    if (!this.gridIndex) this.buildGridIndex();
    const cell = this.gridCell;
    const cx = Math.round(x / cell);
    const cy = Math.round(y / cell);
    for (let ring = 0; ring < 80; ring++) {
      let best = null;
      let bestD = Infinity;
      for (let ix = cx - ring; ix <= cx + ring; ix++) {
        for (let iy = cy - ring; iy <= cy + ring; iy++) {
          if (ring > 0 && Math.abs(ix - cx) !== ring && Math.abs(iy - cy) !== ring) continue;
          const bucket = this.gridIndex.get(`${ix}:${iy}`);
          if (!bucket) continue;
          for (const node of bucket) {
            const d = Math.hypot(node.x - x, node.y - y);
            if (d < bestD) { bestD = d; best = node; }
          }
        }
      }
      if (best) return { node: best, snapM: bestD };
    }
    throw new Error(`no road node near (${x.toFixed(1)}, ${y.toFixed(1)})`);
  }

  /**
   * Cost surface from a point: snapped origin + walk metres.
   * Returns `accessSeconds(nodeId)` closure and `origin` metadata.
   */
  accessFrom(x, y, { walkSpeedKmh = 4.8 } = {}) {
    const { node, snapM } = this.nearestNode(x, y);
    const walkSecondsPerM = 3600 / (walkSpeedKmh * 1000);
    const paths = this.shortestPaths(node.id);
    const access = (nodeId) => {
      const p = paths.get(nodeId);
      if (!p) return Infinity;
      return snapM * walkSecondsPerM + p.seconds;
    };
    return { originNode: node.id, snapM, walkSeconds: snapM * walkSecondsPerM, paths, access };
  }
}

class MinHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length && last) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let s = i;
        if (l < a.length && a[l][0] < a[s][0]) s = l;
        if (r < a.length && a[r][0] < a[s][0]) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top;
  }
}
