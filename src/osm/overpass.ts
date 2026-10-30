import type { LatLon } from '../geo';

/** Daten aus OpenStreetMap über die Overpass-API. */

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export interface OsmWay {
  type: 'way';
  id: number;
  nodes: number[];
  geometry: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

export interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

export interface OsmRelation {
  type: 'relation';
  id: number;
  members: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
  tags?: Record<string, string>;
}

export type OsmElement = OsmNode | OsmWay | OsmRelation;

interface OverpassResponse {
  elements: OsmElement[];
}

/** Straßen, auf denen man boßeln kann – keine Autobahnen, keine Treppen. */
const HIGHWAYS =
  'primary|secondary|tertiary|unclassified|residential|living_street|service|track|road|cycleway|path|footway|pedestrian|bridleway';

async function query(ql: string, signal?: AbortSignal): Promise<OsmElement[]> {
  let lastError: unknown;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(ql),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });
      if (!res.ok) throw new Error(`Overpass antwortet mit ${res.status}`);
      const json = (await res.json()) as OverpassResponse;
      return json.elements;
    } catch (e) {
      if (signal?.aborted) throw e;
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Overpass nicht erreichbar');
}

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Umgebendes Rechteck um Punkte, mit Rand in Metern. */
export function bboxAround(points: LatLon[], marginMeters: number): BBox {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const dLat = marginMeters / 111_320;
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const dLon = marginMeters / (111_320 * Math.cos((midLat * Math.PI) / 180));
  return {
    south: Math.min(...lats) - dLat,
    west: Math.min(...lons) - dLon,
    north: Math.max(...lats) + dLat,
    east: Math.max(...lons) + dLon,
  };
}

const bboxString = (b: BBox) => `${b.south},${b.west},${b.north},${b.east}`;

export async function fetchRoads(bbox: BBox, signal?: AbortSignal): Promise<OsmWay[]> {
  const all = await query(`[out:json][timeout:30];way["highway"~"^(${HIGHWAYS})$"](${bboxString(bbox)});out geom;`, signal);
  return all.filter((e): e is OsmWay => e.type === 'way' && 'geometry' in e);
}

/**
 * Alles, was neben der Straße steht: Häuser, Bäume, Hecken, Wald, Weiden, Äcker, Gewässer –
 * im Umkreis der gewählten Strecke (Linie mit Puffer).
 */
export function fetchScenery(line: LatLon[], radius: number, signal?: AbortSignal): Promise<OsmElement[]> {
  const coords = line.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join(',');
  const a = `(around:${radius},${coords})`;
  return query(
    `[out:json][timeout:60];(` +
      `way["building"]${a};` +
      `node["natural"="tree"]${a};` +
      `way["natural"~"^(tree_row|wood|scrub|water)$"]${a};` +
      `relation["natural"~"^(wood|water)$"]${a};` +
      `way["landuse"~"^(forest|farmland|meadow|grass|residential|farmyard|orchard|village_green|basin|reservoir)$"]${a};` +
      `relation["landuse"~"^(forest|farmland|meadow|residential)$"]${a};` +
      `way["barrier"="hedge"]${a};` +
      `way["waterway"~"^(ditch|drain|stream|canal|river)$"]${a};` +
      `);out geom;`,
    signal,
  );
}
