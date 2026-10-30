import { dist, type LatLon, type Vec2 } from '../geo';

/** Belag eines Streckenstücks – bestimmt, wie weit die Kugel rollt. */
export type Surface = 'asphalt' | 'paved' | 'gravel' | 'dirt';

/** Was neben der Straße liegt: ein Graben (Sloot) auf dem Land, sonst Gehweg/Garten. */
export type Roadside = 'ditch' | 'town';

export type RoofShape = 'flat' | 'gabled' | 'hipped';

export interface Building {
  footprint: Vec2[];
  /** Höhe bis zur Traufe. */
  height: number;
  roof?: RoofShape;
  /** Firsthöhe über der Traufe. */
  roofHeight?: number;
  material?: 'brick' | 'plaster';
  wallColor?: string;
  roofColor?: string;
}

export type TreeKind = 'birch' | 'round' | 'poplar' | 'oak' | 'bush';

export interface Tree {
  p: Vec2;
  kind: TreeKind;
  scale: number;
}

export type AreaKind = 'forest' | 'farmland' | 'meadow' | 'grass' | 'residential' | 'farmyard' | 'orchard' | 'scrub';

export interface Area {
  kind: AreaKind;
  poly: Vec2[];
}

export interface Waterway {
  line: Vec2[];
  width: number;
}

/** Kulisse aus OSM: alles außer der Straße selbst. Ältere gespeicherte Strecken haben nur Teile davon. */
export interface Scenery {
  buildings: Building[];
  water: Vec2[][];
  trees?: Tree[];
  areas?: Area[];
  hedges?: Vec2[][];
  waterways?: Waterway[];
}

/**
 * Eine spielbare Strecke in lokalen Metern. `points` sind gleichmäßig verteilt
 * (Abstand `STEP`), alle Arrays haben dieselbe Länge.
 */
export interface Course extends Scenery {
  name: string;
  origin: LatLon;
  points: Vec2[];
  /** Zurückgelegter Weg bis zu jedem Punkt. */
  cum: number[];
  /** Halbe Fahrbahnbreite je Punkt. */
  halfWidth: number[];
  surface: Surface[];
  roadside: Roadside[];
  length: number;
}

export const STEP = 2;
/** Bankette zwischen Fahrbahnrand und Graben bzw. Gehweg. */
export const VERGE = 1.5;
/** Breite des Grabens hinter der Bankette. */
export const DITCH = 2;

export interface RawRoute {
  points: Vec2[];
  halfWidth: number[];
  surface: Surface[];
  roadside: Roadside[];
}

/**
 * Macht aus einer groben Wegpunktliste (z. B. OSM-Knoten) eine gleichmäßig abgetastete,
 * leicht geglättete Strecke. Eckige Kreuzungen werden so zu Kurven, die man auch mit der Kugel
 * „nehmen“ kann.
 */
export function buildCourse(
  name: string,
  origin: LatLon,
  raw: RawRoute,
  scenery: Scenery = { buildings: [], water: [] },
): Course {
  const n = raw.points.length;
  if (n < 2) throw new Error('Strecke braucht mindestens zwei Punkte');

  // 1. gleichmäßig abtasten, Attribute vom jeweiligen Segment übernehmen
  const pts: Vec2[] = [];
  const hw: number[] = [];
  const surf: Surface[] = [];
  const side: Roadside[] = [];
  pts.push({ ...raw.points[0] });
  hw.push(raw.halfWidth[0]);
  surf.push(raw.surface[0]);
  side.push(raw.roadside[0]);
  let carry = 0;
  for (let i = 0; i < n - 1; i++) {
    const a = raw.points[i];
    const b = raw.points[i + 1];
    const len = dist(a, b);
    if (len < 1e-6) continue;
    let t = STEP - carry;
    while (t <= len) {
      const f = t / len;
      pts.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
      hw.push(raw.halfWidth[i]);
      surf.push(raw.surface[i]);
      side.push(raw.roadside[i]);
      t += STEP;
    }
    carry = len - (t - STEP);
  }
  const last = raw.points[n - 1];
  if (dist(pts[pts.length - 1], last) > 0.1) {
    pts.push({ ...last });
    hw.push(raw.halfWidth[n - 2]);
    surf.push(raw.surface[n - 2]);
    side.push(raw.roadside[n - 2]);
  }

  // 2. glätten (gleitender Mittelwert, Enden bleiben fest), Breite ebenfalls weich überblenden
  const smoothed = smooth(pts, 4);
  const smoothHw = smoothNumbers(hw, 6);

  // 3. nach dem Glätten neu abtasten, damit die Abstände wieder genau STEP sind
  return { ...resample(name, origin, smoothed, smoothHw, surf, side), ...scenery };
}

function smooth(pts: Vec2[], radius: number): Vec2[] {
  return pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return p;
    const r = Math.min(radius, i, pts.length - 1 - i);
    let x = 0;
    let y = 0;
    for (let k = -r; k <= r; k++) {
      x += pts[i + k].x;
      y += pts[i + k].y;
    }
    return { x: x / (2 * r + 1), y: y / (2 * r + 1) };
  });
}

function smoothNumbers(v: number[], radius: number): number[] {
  return v.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, i - radius); k <= Math.min(v.length - 1, i + radius); k++) {
      sum += v[k];
      count++;
    }
    return sum / count;
  });
}

function resample(
  name: string,
  origin: LatLon,
  pts: Vec2[],
  hw: number[],
  surf: Surface[],
  side: Roadside[],
): Omit<Course, keyof Scenery> {
  const points: Vec2[] = [pts[0]];
  const halfWidth = [hw[0]];
  const surface = [surf[0]];
  const roadside = [side[0]];
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = dist(a, b);
    if (len < 1e-6) continue;
    let t = STEP - carry;
    while (t <= len) {
      const f = t / len;
      points.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
      halfWidth.push(hw[i] + (hw[i + 1] - hw[i]) * f);
      surface.push(surf[i]);
      roadside.push(side[i]);
      t += STEP;
    }
    carry = len - (t - STEP);
  }
  const end = pts[pts.length - 1];
  if (dist(points[points.length - 1], end) > 0.5) {
    points.push(end);
    halfWidth.push(hw[hw.length - 1]);
    surface.push(surf[surf.length - 1]);
    roadside.push(side[side.length - 1]);
  }
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + dist(points[i - 1], points[i]));
  return {
    name,
    origin,
    points,
    cum,
    halfWidth,
    surface,
    roadside,
    length: cum[cum.length - 1],
  };
}

export interface CoursePos {
  /** Index des Segments (Punkt i → i+1). */
  idx: number;
  /** Weg entlang der Strecke. */
  s: number;
  /** Seitlicher Abstand zur Mittellinie, positiv = links in Laufrichtung. */
  d: number;
  /** Lotfußpunkt auf der Mittellinie. */
  foot: Vec2;
}

/**
 * Projiziert einen Punkt auf die Strecke. Mit `hint` wird nur in der Nähe gesucht – so
 * verwechselt die Kugel keine Straßenstücke, die nah beieinander liegen (Schleifen).
 */
export function project(course: Course, p: Vec2, hint?: number, window = 40): CoursePos {
  const { points, cum } = course;
  const from = hint === undefined ? 0 : Math.max(0, hint - window);
  const to = hint === undefined ? points.length - 1 : Math.min(points.length - 1, hint + window);
  let best: CoursePos = { idx: 0, s: 0, d: 0, foot: points[0] };
  let bestDist = Infinity;
  for (let i = from; i < to; i++) {
    const a = points[i];
    const b = points[i + 1];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len2 = ex * ex + ey * ey;
    let t = len2 > 0 ? ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const fx = a.x + ex * t;
    const fy = a.y + ey * t;
    const dd = Math.hypot(p.x - fx, p.y - fy);
    if (dd < bestDist) {
      bestDist = dd;
      const len = Math.sqrt(len2);
      const cross = len > 0 ? (ex * (p.y - a.y) - ey * (p.x - a.x)) / len : 0;
      best = { idx: i, s: cum[i] + t * len, d: Math.sign(cross) * dd, foot: { x: fx, y: fy } };
    }
  }
  return best;
}

/** Punkt und Richtung (Einheitsvektor) bei Weg `s`. */
export function pointAt(course: Course, s: number): { p: Vec2; dir: Vec2; idx: number } {
  const { points, cum } = course;
  const clamped = Math.max(0, Math.min(course.length, s));
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= clamped) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const len = cum[hi] - cum[lo];
  const f = len > 0 ? (clamped - cum[lo]) / len : 0;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy) || 1;
  return { p: { x: a.x + dx * f, y: a.y + dy * f }, dir: { x: dx / l, y: dy / l }, idx: lo };
}

/** Mittlere Richtung über ein Stück Strecke – ruhiger als die Richtung eines einzelnen Segments. */
export function headingAt(course: Course, s: number, ahead = 12): Vec2 {
  const a = pointAt(course, s).p;
  const b = pointAt(course, Math.min(course.length, s + ahead)).p;
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (Math.hypot(dx, dy) < 0.5) {
    const d = pointAt(course, s).dir;
    dx = d.x;
    dy = d.y;
  }
  const l = Math.hypot(dx, dy);
  return { x: dx / l, y: dy / l };
}
