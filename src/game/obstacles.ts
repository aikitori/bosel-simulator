import { headingAt, pointAt, type Course } from '../osm/course';
import { mulberry32 } from '../random';

/**
 * Zufällige Hindernisse auf der Fahrbahn: Schlaglöcher werfen die Kugel aus der Bahn,
 * Pfützen bremsen sie stark, Steine lenken sie ab. Werden je Partie neu verteilt.
 */

export type ObstacleKind = 'pothole' | 'puddle' | 'stone';

export interface Obstacle {
  kind: ObstacleKind;
  /** Lage entlang der Strecke und seitlich (positiv = links). */
  s: number;
  d: number;
  x: number;
  y: number;
  /** Radius in Metern (Pfützen: Längs-Halbachse, quer `r * 0.6`). */
  r: number;
  /** Ausrichtung entlang der Straße (Pfützen sind länglich). */
  angle: number;
}

export const OBSTACLE_NAME: Record<ObstacleKind, string> = {
  pothole: 'Schlagloch',
  puddle: 'Pfütze',
  stone: 'Stein',
};

/** Hindernisse verteilen; `perKm` = mittlere Anzahl je Kilometer. */
export function placeObstacles(course: Course, seed: number, perKm = 28): Obstacle[] {
  const rand = mulberry32(seed);
  const out: Obstacle[] = [];
  const count = Math.round((course.length / 1000) * perKm);
  for (let i = 0; i < count; i++) {
    const s = 20 + rand() * Math.max(0, course.length - 40);
    const at = pointAt(course, s);
    const hw = course.halfWidth[at.idx];
    const surface = course.surface[at.idx];
    // Auf Schotter und Erdwegen gibt es mehr Pfützen und Steine, auf Asphalt mehr Schlaglöcher
    const r0 = rand();
    const kind: ObstacleKind =
      surface === 'asphalt' ? (r0 < 0.45 ? 'pothole' : r0 < 0.75 ? 'puddle' : 'stone') : r0 < 0.2 ? 'pothole' : r0 < 0.65 ? 'puddle' : 'stone';
    const r = kind === 'pothole' ? 0.25 + rand() * 0.3 : kind === 'puddle' ? 0.8 + rand() * 1.2 : 0.08 + rand() * 0.1;
    const limit = Math.max(0, hw - (kind === 'puddle' ? r * 0.4 : r) - 0.1);
    const d = (rand() * 2 - 1) * limit;
    const h = headingAt(course, s, 4);
    if (out.some((o) => Math.abs(o.s - s) < o.r + r + 1)) continue;
    out.push({ kind, s, d, x: at.p.x - h.y * d, y: at.p.y + h.x * d, r, angle: Math.atan2(h.y, h.x) });
  }
  return out.sort((a, b) => a.s - b.s);
}

/** Abstand zum Hindernis-Mittelpunkt, bei Pfützen in Ellipsen-Maß (< 1 = drin). */
export function inside(o: Obstacle, x: number, y: number): number {
  const dx = x - o.x;
  const dy = y - o.y;
  if (o.kind !== 'puddle') return Math.hypot(dx, dy) / o.r;
  const c = Math.cos(o.angle);
  const s = Math.sin(o.angle);
  const u = (dx * c + dy * s) / o.r;
  const v = (-dx * s + dy * c) / (o.r * 0.6);
  return Math.hypot(u, v);
}
