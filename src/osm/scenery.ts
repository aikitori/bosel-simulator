import { dist, pointInPolygon, type Projection, type Vec2 } from '../geo';
import { mulberry32 } from '../random';
import type { AreaKind, Building, RoofShape, Scenery, Tree, TreeKind, Waterway } from './course';
import type { OsmElement } from './overpass';

/**
 * Wandelt OSM-Elemente in die Kulisse einer Strecke um: Häuser mit Dachform und Material,
 * Einzelbäume, Baumreihen, Wälder, Hecken, Flächennutzung und Gewässer. Behalten wird nur,
 * was in Sichtweite der Strecke liegt.
 */

/** Wie weit neben der Strecke noch etwas aufgebaut wird. */
const RANGE = 160;
/** Bäume im Wald werden dichter an der Strecke gepflanzt als weit weg. */
const FOREST_RANGE = 130;
const MAX_TREES = 3000;
/** Abstand, den Bäume von der Fahrbahnmitte mindestens halten (Straße, Bankette, Graben). */
const CLEARANCE = 8;

const AREA_KIND: Record<string, AreaKind> = {
  forest: 'forest',
  wood: 'forest',
  farmland: 'farmland',
  meadow: 'meadow',
  grass: 'grass',
  village_green: 'grass',
  residential: 'residential',
  farmyard: 'farmyard',
  orchard: 'orchard',
  scrub: 'scrub',
};

const SMALL_BUILDINGS = /^(garage|garages|shed|carport|container|roof|kiosk|hut)$/;
const FLAT_BUILDINGS = /^(industrial|commercial|retail|warehouse|supermarket|office|hospital|school)$/;
const ROOF_COLORS = ['#8a3324', '#3a3d42', '#6b2a20', '#4b4f56', '#9a4a2e'];

type LL = { lat: number; lon: number };

/** Abstand eines Punktes zur Strecke, über eine grob abgetastete Mittellinie. */
class RouteIndex {
  private readonly samples: Vec2[];

  constructor(readonly line: Vec2[]) {
    const s: Vec2[] = [];
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      const n = Math.max(1, Math.ceil(dist(a, b) / 8));
      for (let k = 0; k < n; k++) s.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
    }
    s.push(line[line.length - 1]);
    this.samples = s;
  }

  distance(p: Vec2): number {
    let best = Infinity;
    for (const q of this.samples) {
      const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  /** Liegt ein Polygon in Sichtweite – oder führt die Strecke hindurch? */
  touches(poly: Vec2[], range: number): boolean {
    if (poly.some((p) => this.distance(p) < range)) return true;
    for (let i = 0; i < this.samples.length; i += 10) if (pointInPolygon(this.samples[i], poly)) return true;
    return false;
  }

  bbox(margin: number) {
    const xs = this.samples.map((p) => p.x);
    const ys = this.samples.map((p) => p.y);
    return { minX: Math.min(...xs) - margin, maxX: Math.max(...xs) + margin, minY: Math.min(...ys) - margin, maxY: Math.max(...ys) + margin };
  }
}

const num = (v: string | undefined) => {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : undefined;
};

function polyArea(p: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j].x + p[i].x) * (p[j].y - p[i].y);
  return Math.abs(a / 2);
}

/** Ring ohne doppelten Schlusspunkt. */
function ring(proj: Projection, geom: LL[]): Vec2[] {
  const pts = geom.map((g) => proj.toLocal(g));
  if (pts.length > 1 && dist(pts[0], pts[pts.length - 1]) < 0.01) pts.pop();
  return pts;
}

/**
 * Rechteck entlang der längsten Kante. Fast-rechteckige Grundrisse bekommen so ein ordentliches
 * Satteldach; bei verwinkelten Häusern bleibt es beim Flachdach.
 */
export function orientedRect(poly: Vec2[]): Vec2[] | undefined {
  let best = 0;
  let ax = 1;
  let ay = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const l = dist(a, b);
    if (l > best) {
      best = l;
      ax = (b.x - a.x) / l;
      ay = (b.y - a.y) / l;
    }
  }
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const p of poly) {
    const u = p.x * ax + p.y * ay;
    const v = -p.x * ay + p.y * ax;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  const rectArea = (maxU - minU) * (maxV - minV);
  if (rectArea <= 0 || polyArea(poly) / rectArea < 0.85) return undefined;
  const at = (u: number, v: number): Vec2 => ({ x: u * ax - v * ay, y: u * ay + v * ax });
  return [at(minU, minV), at(maxU, minV), at(maxU, maxV), at(minU, maxV)];
}

function building(tags: Record<string, string>, footprint: Vec2[], rand: () => number): Building {
  const kind = tags.building;
  const levels = num(tags['building:levels']);
  const total = num(tags.height);
  const shapeTag = tags['roof:shape'];
  let roof: RoofShape = 'gabled';
  if (shapeTag === 'flat' || SMALL_BUILDINGS.test(kind) || FLAT_BUILDINGS.test(kind) || (levels ?? 0) >= 4) roof = 'flat';
  if (/hipped|pyramidal|half-hipped/.test(shapeTag ?? '')) roof = 'hipped';
  if (/gabled|gambrel|mansard|saltbox/.test(shapeTag ?? '')) roof = 'gabled';

  let fp = footprint;
  if (roof !== 'flat') {
    const rect = orientedRect(footprint);
    if (rect) fp = rect;
    else roof = 'flat';
  }
  const short = Math.min(dist(fp[0], fp[1]), dist(fp[1], fp[2] ?? fp[0]));
  const roofHeight = roof === 'flat' ? 0 : (num(tags['roof:height']) ?? Math.min(short * 0.5, 7));

  let eaves: number;
  if (total !== undefined) eaves = Math.max(2.5, total - roofHeight);
  else if (levels !== undefined) eaves = levels * 2.8 + 0.4;
  else if (SMALL_BUILDINGS.test(kind)) eaves = 2.6;
  else if (/barn|farm_auxiliary|stable|cowshed/.test(kind)) eaves = 4.5;
  else if (roof === 'flat') eaves = 6;
  else eaves = 3.2;

  const mat = tags['building:material'] ?? '';
  const colour = tags['building:colour'];
  const plaster = /plaster|concrete|stone|wood/.test(mat) || /white|#f|#e/i.test(colour ?? '') || (!mat && !colour && rand() < 0.2);
  return {
    footprint: fp,
    height: Math.min(eaves, 60),
    roof,
    roofHeight,
    material: plaster ? 'plaster' : 'brick',
    wallColor: colour,
    roofColor: tags['roof:colour'] ?? ROOF_COLORS[Math.floor(rand() * ROOF_COLORS.length)],
  };
}

function treeKind(tags: Record<string, string>, rand: () => number): TreeKind {
  const t = `${tags.genus ?? ''} ${tags.species ?? ''} ${tags['species:de'] ?? ''} ${tags.taxon ?? ''}`.toLowerCase();
  if (/betula|birke/.test(t)) return 'birch';
  if (/populus|pappel/.test(t)) return 'poplar';
  if (/quercus|eiche/.test(t)) return 'oak';
  const r = rand();
  return r < 0.45 ? 'round' : r < 0.8 ? 'oak' : 'birch';
}

export function parseScenery(elements: OsmElement[], proj: Projection, centerline: Vec2[]): Scenery {
  const route = new RouteIndex(centerline);
  const scenery: Required<Scenery> = { buildings: [], water: [], trees: [], areas: [], hedges: [], waterways: [] };
  const clear = (p: Vec2) => route.distance(p) > CLEARANCE;
  const addTree = (t: Tree) => {
    if (scenery.trees.length < MAX_TREES && clear(t.p)) scenery.trees.push(t);
  };
  const forests: Vec2[][] = [];
  const orchards: Vec2[][] = [];
  const scrubs: Vec2[][] = [];

  const addArea = (kind: AreaKind | 'water', poly: Vec2[]) => {
    if (poly.length < 3 || !route.touches(poly, RANGE)) return;
    if (kind === 'water') return scenery.water.push(poly);
    scenery.areas.push({ kind, poly });
    if (kind === 'forest') forests.push(poly);
    if (kind === 'orchard') orchards.push(poly);
    if (kind === 'scrub') scrubs.push(poly);
  };
  const areaKindOf = (tags: Record<string, string>): AreaKind | 'water' | undefined => {
    if (tags.natural === 'water' || /^(basin|reservoir)$/.test(tags.landuse ?? '')) return 'water';
    return AREA_KIND[tags.landuse ?? ''] ?? AREA_KIND[tags.natural ?? ''];
  };

  for (const e of elements) {
    const tags = e.tags ?? {};
    const rand = mulberry32(e.id);
    if (e.type === 'node') {
      if (tags.natural !== 'tree') continue;
      const p = proj.toLocal(e);
      if (route.distance(p) > RANGE) continue;
      const h = num(tags.height);
      addTree({ p, kind: treeKind(tags, rand), scale: h ? Math.max(0.4, Math.min(2, h / 11)) : 0.8 + rand() * 0.4 });
      continue;
    }
    if (e.type === 'relation') {
      const kind = areaKindOf(tags);
      if (!kind) continue;
      for (const m of e.members) {
        if (m.role !== 'outer' || !m.geometry || m.geometry.length < 4) continue;
        const g = m.geometry;
        if (g[0].lat !== g[g.length - 1].lat || g[0].lon !== g[g.length - 1].lon) continue;
        addArea(kind, ring(proj, g));
      }
      continue;
    }

    if (tags.highway) continue; // Straßen liefern nur Belag und Breite (routing.ts)
    if (tags.building) {
      const fp = ring(proj, e.geometry);
      if (fp.length >= 3 && route.distance(fp[0]) < RANGE) scenery.buildings.push(building(tags, fp, rand));
      continue;
    }
    if (tags.natural === 'tree_row') {
      const line = e.geometry.map((g) => proj.toLocal(g));
      if (!line.some((p) => route.distance(p) < RANGE)) continue;
      const kind = treeKind(tags, rand);
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i];
        const b = line[i + 1];
        const n = Math.max(1, Math.round(dist(a, b) / 8));
        for (let k = 0; k <= n; k++) {
          if (k === n && i < line.length - 2) continue;
          addTree({ p: { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n }, kind, scale: 0.85 + rand() * 0.3 });
        }
      }
      continue;
    }
    if (tags.barrier === 'hedge') {
      const line = e.geometry.map((g) => proj.toLocal(g));
      if (line.some((p) => route.distance(p) < RANGE)) scenery.hedges.push(line);
      continue;
    }
    if (tags.waterway) {
      const line = e.geometry.map((g) => proj.toLocal(g));
      if (!line.some((p) => route.distance(p) < RANGE * 2)) continue;
      const width = num(tags.width) ?? { ditch: 1.2, drain: 1.5, stream: 2.5, canal: 8, river: 15 }[tags.waterway] ?? 2;
      scenery.waterways.push({ line, width } satisfies Waterway);
      continue;
    }
    const kind = areaKindOf(tags);
    if (kind) addArea(kind, ring(proj, e.geometry));
  }

  // Wälder, Obstwiesen und Gebüsch mit Bäumen füllen – nur in Sichtweite der Strecke
  const fill = (polys: Vec2[][], step: number, pick: (r: () => number) => Tree['kind'], range: number, scale: [number, number]) => {
    const box = route.bbox(range);
    polys.forEach((poly, idx) => {
      const rand = mulberry32(1000 + idx);
      const xs = poly.map((p) => p.x);
      const ys = poly.map((p) => p.y);
      const x0 = Math.max(box.minX, Math.min(...xs));
      const x1 = Math.min(box.maxX, Math.max(...xs));
      const y0 = Math.max(box.minY, Math.min(...ys));
      const y1 = Math.min(box.maxY, Math.max(...ys));
      for (let x = x0; x < x1; x += step) {
        for (let y = y0; y < y1; y += step) {
          const p = { x: x + (rand() - 0.5) * step * 0.8, y: y + (rand() - 0.5) * step * 0.8 };
          if (route.distance(p) > range || !pointInPolygon(p, poly)) continue;
          addTree({ p, kind: pick(rand), scale: scale[0] + rand() * (scale[1] - scale[0]) });
        }
      }
    });
  };
  fill(forests, 7, (r) => (r() < 0.3 ? 'birch' : r() < 0.6 ? 'oak' : 'round'), FOREST_RANGE, [0.8, 1.25]);
  fill(orchards, 9, () => 'round', 80, [0.45, 0.6]);
  fill(scrubs, 4, () => 'bush', 80, [0.8, 1.4]);

  // Bäume nicht in Häuser stellen
  scenery.trees = scenery.trees.filter((t) => !scenery.buildings.some((b) => dist(b.footprint[0], t.p) < 40 && pointInPolygon(t.p, b.footprint)));
  return scenery;
}
