import { dist, haversine, Projection, type LatLon, type Vec2 } from '../geo';
import { buildCourse, type Building, type Course, type RawRoute, type Roadside, type Surface } from './course';
import type { OsmWay } from './overpass';

/**
 * Wegsuche auf den OSM-Straßen: kürzester Weg durch alle angetippten Punkte. Kleine Straßen
 * werden bevorzugt – geboßelt wird auf ruhigen Landstraßen, nicht auf der Bundesstraße.
 */

const COST: Record<string, number> = {
  primary: 4,
  secondary: 2.5,
  tertiary: 1.4,
  unclassified: 1,
  residential: 1.1,
  living_street: 1.2,
  service: 1.3,
  track: 1.2,
  road: 1.2,
  cycleway: 1.4,
  path: 2,
  footway: 2.5,
  pedestrian: 2,
  bridleway: 2.5,
};

/** Halbe Fahrbahnbreite nach Straßenart, wenn OSM keine Breite kennt. */
const HALF_WIDTH: Record<string, number> = {
  primary: 3.5,
  secondary: 3.25,
  tertiary: 2.9,
  unclassified: 2.3,
  residential: 2.6,
  living_street: 2.4,
  service: 1.8,
  track: 1.5,
  road: 2.3,
  cycleway: 1.25,
  path: 1,
  footway: 1,
  pedestrian: 2,
  bridleway: 1,
};

const TOWN = new Set(['residential', 'living_street', 'pedestrian', 'service', 'footway']);

interface EdgeInfo {
  halfWidth: number;
  surface: Surface;
  roadside: Roadside;
}

interface Edge {
  to: number;
  cost: number;
  info: EdgeInfo;
}

export interface RoadGraph {
  coords: Map<number, LatLon>;
  adj: Map<number, Edge[]>;
}

function surfaceOf(tags: Record<string, string>): Surface {
  const s = tags.surface ?? '';
  if (/asphalt|concrete/.test(s)) return 'asphalt';
  if (/paving_stones|sett|cobblestone|paved/.test(s)) return 'paved';
  if (/gravel|compacted|fine_gravel|pebblestone/.test(s)) return 'gravel';
  if (/dirt|ground|grass|earth|mud|sand|unpaved/.test(s)) return 'dirt';
  if (tags.highway === 'track') {
    const g = tags.tracktype ?? 'grade3';
    return g === 'grade1' ? 'asphalt' : g === 'grade2' ? 'gravel' : 'dirt';
  }
  if (tags.highway === 'path' || tags.highway === 'bridleway') return 'dirt';
  return 'asphalt';
}

function infoOf(tags: Record<string, string>): EdgeInfo {
  const hw = tags.highway;
  const width = parseFloat(tags.width ?? tags['est_width'] ?? '');
  return {
    halfWidth: Number.isFinite(width) && width > 1 && width < 20 ? width / 2 : (HALF_WIDTH[hw] ?? 2),
    surface: surfaceOf(tags),
    roadside: TOWN.has(hw) ? 'town' : 'ditch',
  };
}

export function buildGraph(ways: OsmWay[]): RoadGraph {
  const coords = new Map<number, LatLon>();
  const adj = new Map<number, Edge[]>();
  const link = (a: number, b: number, cost: number, info: EdgeInfo) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push({ to: b, cost, info });
  };
  for (const w of ways) {
    const tags = w.tags ?? {};
    if (tags.highway === undefined || tags.area === 'yes') continue;
    if (tags.access === 'private' || tags.access === 'no') continue;
    const factor = COST[tags.highway] ?? 2;
    const info = infoOf(tags);
    for (let i = 0; i < w.nodes.length; i++) coords.set(w.nodes[i], w.geometry[i]);
    for (let i = 0; i < w.nodes.length - 1; i++) {
      const a = w.nodes[i];
      const b = w.nodes[i + 1];
      const cost = haversine(w.geometry[i], w.geometry[i + 1]) * factor;
      link(a, b, cost, info);
      link(b, a, cost, info);
    }
  }
  return { coords, adj };
}

export function nearestNode(g: RoadGraph, p: LatLon): number | undefined {
  let best: number | undefined;
  let bestD = Infinity;
  for (const [id, c] of g.coords) {
    if (!g.adj.has(id)) continue;
    const d = haversine(p, c);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return bestD < 300 ? best : undefined;
}

/** Dijkstra mit Binärheap. Liefert Knotenfolge und die Kanten-Infos dazwischen. */
function shortestPath(g: RoadGraph, from: number, to: number): { nodes: number[]; infos: EdgeInfo[] } | undefined {
  const distTo = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, { node: number; info: EdgeInfo }>();
  const heap: [number, number][] = [[0, from]];
  const push = (item: [number, number]) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, node] = pop();
    if (node === to) break;
    if (d > (distTo.get(node) ?? Infinity)) continue;
    for (const e of g.adj.get(node) ?? []) {
      const nd = d + e.cost;
      if (nd < (distTo.get(e.to) ?? Infinity)) {
        distTo.set(e.to, nd);
        prev.set(e.to, { node, info: e.info });
        push([nd, e.to]);
      }
    }
  }
  if (!distTo.has(to)) return undefined;
  const nodes = [to];
  const infos: EdgeInfo[] = [];
  let cur = to;
  while (cur !== from) {
    const p = prev.get(cur)!;
    infos.unshift(p.info);
    nodes.unshift(p.node);
    cur = p.node;
  }
  return { nodes, infos };
}

export interface RoutedLine {
  line: LatLon[];
  infos: EdgeInfo[];
  length: number;
}

/** Route durch alle Wegpunkte; `undefined`, wenn ein Punkt nicht an einer Straße liegt. */
export function route(g: RoadGraph, waypoints: LatLon[]): RoutedLine | { error: string } {
  const ids: number[] = [];
  for (const [i, w] of waypoints.entries()) {
    const id = nearestNode(g, w);
    if (id === undefined) return { error: `Punkt ${i + 1} liegt nicht an einer Straße.` };
    ids.push(id);
  }
  const line: LatLon[] = [g.coords.get(ids[0])!];
  const infos: EdgeInfo[] = [];
  for (let i = 0; i < ids.length - 1; i++) {
    if (ids[i] === ids[i + 1]) continue;
    const part = shortestPath(g, ids[i], ids[i + 1]);
    if (!part) return { error: `Zwischen Punkt ${i + 1} und ${i + 2} gibt es keinen Weg.` };
    for (let k = 1; k < part.nodes.length; k++) {
      line.push(g.coords.get(part.nodes[k])!);
      infos.push(part.infos[k - 1]);
    }
  }
  let length = 0;
  for (let i = 1; i < line.length; i++) length += haversine(line[i - 1], line[i]);
  return { line, infos, length };
}

function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const len2 = ex * ex + ey * ey;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2)) : 0;
  return dist(p, { x: a.x + ex * t, y: a.y + ey * t });
}

/** Häuser und Wasser aus OSM in lokale Meter, nur was nah genug an der Strecke liegt. */
function scenery(ways: OsmWay[], proj: Projection, centerline: Vec2[]): { buildings: Building[]; water: Vec2[][] } {
  const buildings: Building[] = [];
  const water: Vec2[][] = [];
  const near = (poly: Vec2[]) => {
    const c = poly[0];
    for (let i = 0; i < centerline.length - 1; i++) if (segmentDistance(c, centerline[i], centerline[i + 1]) < 160) return true;
    return false;
  };
  for (const w of ways) {
    const tags = w.tags ?? {};
    const poly = w.geometry.map((p) => proj.toLocal(p));
    if (poly.length < 4 || !near(poly)) continue;
    poly.pop(); // geschlossener Ring: letzter Punkt = erster
    if (tags.building) {
      const levels = parseFloat(tags['building:levels'] ?? '');
      const h = parseFloat(tags.height ?? '');
      const height = Number.isFinite(h) ? h : Number.isFinite(levels) ? levels * 3 + 2 : /garage|shed|carport/.test(tags.building) ? 3 : 7;
      buildings.push({ footprint: poly, height: Math.min(height, 60) });
    } else {
      water.push(poly);
    }
  }
  return { buildings, water };
}

export function courseFromRoute(name: string, r: RoutedLine, sceneryWays: OsmWay[]): Course {
  const proj = new Projection(r.line[0]);
  const points = r.line.map((p) => proj.toLocal(p));
  const raw: RawRoute = {
    points,
    halfWidth: r.infos.map((i) => i.halfWidth),
    surface: r.infos.map((i) => i.surface),
    roadside: r.infos.map((i) => i.roadside),
  };
  const { buildings, water } = scenery(sceneryWays, proj, points);
  return buildCourse(name, r.line[0], raw, buildings, water);
}
