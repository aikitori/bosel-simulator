import { VectorTile, type VectorTileFeature } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { Projection, type LatLon } from '../geo';
import { tileGet, tilePut } from './cache';
import type { OsmElement } from './overpass';

/**
 * Grundlandschaft aus Vektorkacheln von VersaTiles (Shortbread-Schema, OSM-Daten): Häuser,
 * Flächen, Gewässer, Gräben und Straßen mit Art und Belag. Kacheln sind fertige Dateien auf
 * einem CDN – schnell, zuverlässig und gut zu cachen. Die Merkmale werden in OSM-artige
 * Elemente übersetzt, damit der restliche Aufbau (scenery.ts, routing.ts) unverändert bleibt.
 */

const URL = 'https://tiles.versatiles.org/tiles/osm/';
const Z = 14;

export interface TileProgress {
  done: number;
  total: number;
}

const n = 2 ** Z;
const tileX = (lon: number) => Math.floor(((lon + 180) / 360) * n);
const tileY = (lat: number) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
};

/** Kachelpunkt (0…extent) → Länge/Breite. */
function toLatLon(x: number, y: number, px: number, py: number, extent: number): LatLon {
  const lon = ((x + px / extent) / n) * 360 - 180;
  const yy = (y + py / extent) / n;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * yy))) * 180) / Math.PI;
  return { lat, lon };
}

/** Alle Kacheln, die näher als `radius` an der Route liegen. */
export function tilesFor(line: LatLon[], radius: number): [number, number][] {
  const proj = new Projection(line[0]);
  const keys = new Set<string>();
  const loc = line.map((p) => proj.toLocal(p));
  for (let i = 0; i < loc.length; i++) {
    const a = loc[i];
    const b = loc[Math.min(i + 1, loc.length - 1)];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 50));
    for (let k = 0; k <= steps; k++) {
      const c = { x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps };
      for (const [dx, dy] of [[0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius]]) {
        const p = proj.toLatLon({ x: c.x + dx, y: c.y + dy });
        keys.add(`${tileX(p.lon)},${tileY(p.lat)}`);
      }
    }
  }
  return [...keys].map((k) => k.split(',').map(Number) as [number, number]);
}

async function loadTile(x: number, y: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  const key = `${Z}/${x}/${y}`;
  const cached = await tileGet(key).catch(() => undefined);
  if (cached) return cached;
  const res = await fetch(`${URL}${key}`, { signal });
  if (!res.ok) throw new Error(`Kachel ${key}: ${res.status}`);
  const buf = await res.arrayBuffer();
  await tilePut(key, buf).catch(() => undefined);
  return buf;
}

// ------------------------------------------------------------ Übersetzung in OSM-Tags

const LAND: Record<string, Record<string, string>> = {
  forest: { landuse: 'forest' },
  wood: { natural: 'wood' },
  farmland: { landuse: 'farmland' },
  meadow: { landuse: 'meadow' },
  grass: { landuse: 'grass' },
  grassland: { landuse: 'meadow' },
  village_green: { landuse: 'village_green' },
  park: { landuse: 'grass' },
  recreation_ground: { landuse: 'grass' },
  allotments: { landuse: 'grass' },
  garden: { landuse: 'grass' },
  residential: { landuse: 'residential' },
  farmyard: { landuse: 'farmyard' },
  orchard: { landuse: 'orchard' },
  vineyard: { landuse: 'orchard' },
  scrub: { natural: 'scrub' },
  heath: { natural: 'scrub' },
};

const STREET_KINDS = /^(primary|secondary|tertiary|unclassified|residential|living_street|service|track|cycleway|footway|path|pedestrian|bridleway)$/;

function tagsOf(layer: string, p: Record<string, unknown>): Record<string, string> | undefined {
  const kind = String(p.kind ?? '');
  switch (layer) {
    case 'buildings': {
      const tags: Record<string, string> = { building: 'yes' };
      // 5 m ist der Platzhalter für „unbekannt“ – dann schätzt scenery.ts selbst
      const h = Number(p.height);
      if (Number.isFinite(h) && h !== 5) tags.height = String(h);
      return tags;
    }
    case 'land':
      return LAND[kind];
    case 'water_polygons':
      return { natural: 'water' };
    case 'water_lines':
      return /^(ditch|drain|stream|canal|river)$/.test(kind) ? { waterway: kind } : undefined;
    case 'streets': {
      if (!STREET_KINDS.test(kind)) return undefined;
      const tags: Record<string, string> = { highway: kind };
      if (p.surface === 'paved') tags.surface = 'asphalt';
      if (p.surface === 'unpaved') tags.surface = 'unpaved';
      if (p.tracktype) tags.tracktype = String(p.tracktype);
      if (p.service) tags.service = String(p.service);
      return tags;
    }
  }
  return undefined;
}

/** Polygon am Kachelrand abschneiden (Sutherland-Hodgman), damit Häuser aus Nachbarkacheln nicht doppelt stehen. */
function clipRing(ring: { x: number; y: number }[], extent: number): { x: number; y: number }[] {
  let out = ring;
  const edges: [(p: { x: number; y: number }) => boolean, (a: { x: number; y: number }, b: { x: number; y: number }) => { x: number; y: number }][] = [
    [(p) => p.x >= 0, (a, b) => ({ x: 0, y: a.y + ((b.y - a.y) * (0 - a.x)) / (b.x - a.x) })],
    [(p) => p.x <= extent, (a, b) => ({ x: extent, y: a.y + ((b.y - a.y) * (extent - a.x)) / (b.x - a.x) })],
    [(p) => p.y >= 0, (a, b) => ({ x: a.x + ((b.x - a.x) * (0 - a.y)) / (b.y - a.y), y: 0 })],
    [(p) => p.y <= extent, (a, b) => ({ x: a.x + ((b.x - a.x) * (extent - a.y)) / (b.y - a.y), y: extent })],
  ];
  for (const [inside, cut] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i];
      const b = input[(i + 1) % input.length];
      if (inside(a)) {
        out.push(a);
        if (!inside(b)) out.push(cut(a, b));
      } else if (inside(b)) out.push(cut(a, b));
    }
    if (!out.length) break;
  }
  return out;
}

/** Ring-Umlaufsinn (Fläche mit Vorzeichen) – äußere Ringe und Löcher unterscheiden. */
const signedArea = (r: { x: number; y: number }[]) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j].x - r[i].x) * (r[j].y + r[i].y);
  return a / 2;
};

function decode(buf: ArrayBuffer, x: number, y: number, idBase: number): OsmElement[] {
  const tile = new VectorTile(new PbfReader(new Uint8Array(buf)));
  const out: OsmElement[] = [];
  let next = 0;
  for (const name of ['buildings', 'land', 'water_polygons', 'water_lines', 'streets']) {
    const layer = tile.layers[name];
    if (!layer) continue;
    for (let i = 0; i < layer.length; i++) {
      const f: VectorTileFeature = layer.feature(i);
      const tags = tagsOf(name, f.properties as Record<string, unknown>);
      if (!tags) continue;
      const rings = f.loadGeometry();
      if (f.type === 3) {
        // Polygone: nur äußere Ringe (Umlaufsinn wie der erste Ring), Löcher weglassen
        const outerSign = Math.sign(signedArea(rings[0] ?? []));
        for (const ring of rings) {
          if (ring.length < 4 || Math.sign(signedArea(ring)) !== outerSign) continue;
          const clipped = clipRing(ring, layer.extent);
          if (clipped.length < 3) continue;
          const geometry = clipped.map((p) => toLatLon(x, y, p.x, p.y, layer.extent));
          geometry.push(geometry[0]);
          out.push({ type: 'way', id: -(idBase + next++), nodes: [], geometry, tags });
        }
      } else if (f.type === 2) {
        for (const line of rings) {
          if (line.length < 2) continue;
          out.push({ type: 'way', id: -(idBase + next++), nodes: [], geometry: line.map((p) => toLatLon(x, y, p.x, p.y, layer.extent)), tags });
        }
      }
    }
  }
  return out;
}

/** Kacheln entlang der Route laden (parallel, gecacht) und als OSM-artige Elemente liefern. */
export async function tileElements(line: LatLon[], radius: number, signal?: AbortSignal, onProgress?: (p: TileProgress) => void): Promise<OsmElement[]> {
  const tiles = tilesFor(line, radius);
  let done = 0;
  onProgress?.({ done, total: tiles.length });
  const parts = await Promise.all(
    tiles.map(async ([x, y]) => {
      const buf = await loadTile(x, y, signal);
      onProgress?.({ done: ++done, total: tiles.length });
      // eindeutige Kennungen je Kachel, damit nichts kollidiert
      return decode(buf, x, y, ((x % 4096) * 4096 + (y % 4096)) * 100000);
    }),
  );
  return parts.flat();
}
