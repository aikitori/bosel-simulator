import type { LatLon } from '../geo';

/** Daten aus OpenStreetMap über die Overpass-API. */

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
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

/**
 * Straßen, auf denen man boßeln kann – keine Autobahnen, keine Fuß- und Trampelpfade
 * (die machen in Städten den Großteil der Daten aus).
 */
const HIGHWAYS = 'primary|secondary|tertiary|unclassified|residential|living_street|service|track|road|cycleway';

/** Was gerade beim Laden passiert – für die Anzeige. */
export interface LoadState {
  /** Server, der gerade antwortet bzw. zuletzt gefragt wurde (1-basiert). */
  server: number;
  servers: number;
  /** Bereits empfangene Bytes; 0 = Server rechnet noch. */
  bytes: number;
}

export type OnProgress = (state: LoadState) => void;

/** Nach dieser Zeit ohne Antwort wird zusätzlich der nächste Server gefragt. */
const HEDGE_MS = 7000;
/** Einzelne Anfrage spätestens hier abbrechen. */
const TIMEOUT_MS = 45000;

/**
 * Overpass-Abfrage mit Ausweichen: Antwortet ein Server nicht zügig oder mit Fehler, wird der
 * nächste gefragt; die erste vollständige Antwort gewinnt, alle anderen werden abgebrochen.
 */
async function query(ql: string, signal?: AbortSignal, onProgress?: OnProgress): Promise<OsmElement[]> {
  const controllers: AbortController[] = [];
  const abortAll = () => controllers.forEach((c) => c.abort());
  signal?.addEventListener('abort', abortAll);
  const state: LoadState = { server: 1, servers: ENDPOINTS.length, bytes: 0 };
  const report = () => onProgress?.({ ...state });

  const attempt = async (i: number): Promise<OsmElement[]> => {
    const ctrl = new AbortController();
    controllers.push(ctrl);
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(ENDPOINTS[i], {
        method: 'POST',
        body: 'data=' + encodeURIComponent(ql),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Overpass antwortet mit ${res.status}`);
      // Antwort stückweise lesen, um den Fortschritt anzuzeigen
      const reader = res.body?.getReader();
      if (!reader) return ((await res.json()) as OverpassResponse).elements;
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        bytes += value.length;
        if (bytes >= state.bytes) {
          state.server = i + 1;
          state.bytes = bytes;
          report();
        }
      }
      const all = new Uint8Array(bytes);
      let off = 0;
      for (const c of chunks) {
        all.set(c, off);
        off += c.length;
      }
      return (JSON.parse(new TextDecoder().decode(all)) as OverpassResponse).elements;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await new Promise<OsmElement[]>((resolve, reject) => {
      let next = 0;
      let running = 0;
      let settled = false;
      let lastError: unknown;
      let hedge: ReturnType<typeof setTimeout> | undefined;
      const launch = () => {
        if (settled || next >= ENDPOINTS.length) return;
        const i = next++;
        running++;
        if (state.bytes === 0) {
          state.server = i + 1;
          report();
        }
        clearTimeout(hedge);
        hedge = setTimeout(() => state.bytes === 0 && launch(), HEDGE_MS);
        attempt(i).then(
          (elements) => {
            if (settled) return;
            settled = true;
            clearTimeout(hedge);
            resolve(elements);
          },
          (e) => {
            running--;
            lastError = e;
            if (settled) return;
            if (signal?.aborted) {
              settled = true;
              reject(e);
            } else if (next < ENDPOINTS.length) launch();
            else if (running === 0) {
              settled = true;
              reject(lastError instanceof Error ? lastError : new Error('Overpass nicht erreichbar'));
            }
          },
        );
      };
      launch();
    });
  } finally {
    abortAll();
    signal?.removeEventListener('abort', abortAll);
  }
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

export async function fetchRoads(bbox: BBox, signal?: AbortSignal, onProgress?: OnProgress): Promise<OsmWay[]> {
  const all = await query(
    `[out:json][timeout:30];way["highway"~"^(${HIGHWAYS})$"]["service"!~"^(parking_aisle|driveway|drive-through)$"]["access"!~"^(private|no)$"](${bboxString(bbox)});out geom qt;`,
    signal,
    onProgress,
  );
  return all.filter((e): e is OsmWay => e.type === 'way' && 'geometry' in e);
}

/**
 * Nur die relevante Umgebung der fertigen Route: die befahrenen Straßen selbst (schmaler
 * Streifen, für Belag und Breite) und alles, was daneben steht – Häuser, Bäume, Hecken, Wald,
 * Weiden, Äcker, Gewässer – im Umkreis `radius`.
 */
export function fetchScenery(lines: LatLon[][], radius: number, signal?: AbortSignal, onProgress?: OnProgress): Promise<OsmElement[]> {
  const parts = lines.map((line) => {
    const coords = line.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join(',');
    const a = `(around:${radius},${coords})`;
    return (
      `way["highway"](around:12,${coords});` +
      `way["building"]${a};` +
      `node["natural"="tree"]${a};` +
      `way["natural"~"^(tree_row|wood|scrub|water)$"]${a};` +
      `relation["natural"~"^(wood|water)$"]${a};` +
      `way["landuse"~"^(forest|farmland|meadow|grass|residential|farmyard|orchard|village_green|basin|reservoir)$"]${a};` +
      `relation["landuse"~"^(forest|farmland|meadow|residential)$"]${a};` +
      `way["barrier"="hedge"]${a};` +
      `way["waterway"~"^(ditch|drain|stream|canal|river)$"]${a};`
    );
  });
  return query(`[out:json][timeout:40];(${parts.join('')});out geom qt;`, signal, onProgress);
}
