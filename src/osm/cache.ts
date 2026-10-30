import { Projection, simplify, type LatLon, type Vec2 } from '../geo';
import type { OsmElement } from './overpass';

/**
 * Zwischenspeicher für Overpass-Kulisse im Gerät (IndexedDB). Gespeichert werden „Korridore“:
 * die abgefragten Linien samt Radius und den gelieferten Elementen. Für eine neue Route wird nur
 * der Teil nachgeladen, der noch nicht in einem Korridor liegt.
 */

const DB = 'bosel';
const STORE = 'corridors';
const MAX_AGE_MS = 60 * 24 * 3600 * 1000;
/** Abtastabstand der Route für die Abdeckungsprüfung. */
const SAMPLE = 15;
/** Liegt ein Routenpunkt so nah an einer schon geladenen Linie, gilt er als abgedeckt. */
const COVERED = 15;

interface Corridor {
  id?: number;
  lines: LatLon[][];
  radius: number;
  date: number;
  elements: OsmElement[];
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function loadAll(): Promise<Corridor[]> {
  const db = await open();
  const all = await request(db.transaction(STORE).objectStore(STORE).getAll() as IDBRequest<Corridor[]>);
  const old = all.filter((c) => Date.now() - c.date > MAX_AGE_MS);
  if (old.length) {
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    for (const c of old) store.delete(c.id!);
  }
  db.close();
  return all.filter((c) => Date.now() - c.date <= MAX_AGE_MS);
}

async function save(c: Corridor): Promise<void> {
  const db = await open();
  await request(db.transaction(STORE, 'readwrite').objectStore(STORE).add(c));
  db.close();
}

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const l2 = ex * ex + ey * ey;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / l2)) : 0;
  return Math.hypot(p.x - a.x - ex * t, p.y - a.y - ey * t);
}

function lineDist(p: Vec2, line: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) best = Math.min(best, segDist(p, line[i], line[i + 1]));
  if (line.length === 1) best = Math.hypot(p.x - line[0].x, p.y - line[0].y);
  return best;
}

/** Route in gleichmäßigen Abständen abtasten (mit Index zurück in die Originalpunkte). */
function sample(line: LatLon[], proj: Projection): { p: LatLon; v: Vec2 }[] {
  const out: { p: LatLon; v: Vec2 }[] = [];
  const loc = line.map((p) => proj.toLocal(p));
  for (let i = 0; i < line.length - 1; i++) {
    const n = Math.max(1, Math.ceil(Math.hypot(loc[i + 1].x - loc[i].x, loc[i + 1].y - loc[i].y) / SAMPLE));
    for (let k = 0; k < n; k++) {
      const f = k / n;
      const v = { x: loc[i].x + (loc[i + 1].x - loc[i].x) * f, y: loc[i].y + (loc[i + 1].y - loc[i].y) * f };
      out.push({ v, p: proj.toLatLon(v) });
    }
  }
  out.push({ v: loc[loc.length - 1], p: line[line.length - 1] });
  return out;
}

export interface CacheResult {
  elements: OsmElement[];
  /** Anteil der Route, der aus dem Speicher kam (0…1). */
  cached: number;
}

/**
 * Kulisse entlang `line` holen: Abgedecktes aus dem Speicher, der Rest über `fetchLines`
 * (eine Overpass-Abfrage für alle fehlenden Teilstücke). Neu Geladenes wird gespeichert.
 */
export async function cachedScenery(
  line: LatLon[],
  radius: number,
  fetchLines: (lines: LatLon[][]) => Promise<OsmElement[]>,
): Promise<CacheResult> {
  let corridors: Corridor[] = [];
  try {
    corridors = await loadAll();
  } catch {
    // ohne IndexedDB (privates Fenster o. Ä.) einfach immer laden
  }
  const proj = new Projection(line[0]);
  const samples = sample(line, proj);
  const near = corridors.filter((c) => c.radius >= radius && c.lines.some((l) => l.some((p) => samples.some((s) => Math.abs(p.lat - s.p.lat) < 0.01 && Math.abs(p.lon - s.p.lon) < 0.015))));
  const nearLines = near.flatMap((c) => c.lines.map((l) => l.map((p) => proj.toLocal(p))));
  const covered = samples.map((s) => nearLines.some((l) => lineDist(s.v, l) <= COVERED));

  // Lücken zu Linien zusammenfassen (je einen Punkt Überlappung, damit nichts fehlt)
  const gaps: LatLon[][] = [];
  for (let i = 0; i < samples.length; i++) {
    if (covered[i]) continue;
    const start = Math.max(0, i - 1);
    while (i < samples.length && !covered[i]) i++;
    const end = Math.min(samples.length - 1, i);
    gaps.push(simplify(samples.slice(start, end + 1), (s) => s.v, 3).map((s) => s.p));
  }

  const elements = new Map<string, OsmElement>();
  for (const c of near) for (const e of c.elements) elements.set(`${e.type}/${e.id}`, e);
  if (gaps.length) {
    const fresh = await fetchLines(gaps);
    for (const e of fresh) elements.set(`${e.type}/${e.id}`, e);
    try {
      await save({ lines: gaps, radius, date: Date.now(), elements: fresh });
    } catch {
      // Speicher voll oder gesperrt: dann eben nächstes Mal wieder laden
    }
  }
  const cachedShare = covered.filter(Boolean).length / covered.length;
  return { elements: [...elements.values()], cached: cachedShare };
}
