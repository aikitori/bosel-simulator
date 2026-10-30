/** Geografische Hilfen: WGS84 ↔ lokale Meter (x = Osten, y = Norden). */

export interface LatLon {
  lat: number;
  lon: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

const EARTH_RADIUS = 6371008.8;
const RAD = Math.PI / 180;

/** Abstand zweier Punkte auf der Erde in Metern (Haversine). */
export function haversine(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(h));
}

/**
 * Gleichabstandsprojektion um einen Ursprung. Für Strecken von ein paar Kilometern ist der
 * Fehler weit unter einem Meter – genau genug fürs Boßeln.
 */
export class Projection {
  private readonly kx: number;
  private readonly ky: number;

  constructor(readonly origin: LatLon) {
    this.ky = EARTH_RADIUS * RAD;
    this.kx = EARTH_RADIUS * RAD * Math.cos(origin.lat * RAD);
  }

  toLocal(p: LatLon): Vec2 {
    return { x: (p.lon - this.origin.lon) * this.kx, y: (p.lat - this.origin.lat) * this.ky };
  }

  toLatLon(v: Vec2): LatLon {
    return { lat: this.origin.lat + v.y / this.ky, lon: this.origin.lon + v.x / this.kx };
  }
}

export const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

/** Punkt-in-Polygon (Strahlverfahren). */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Linie vereinfachen (Douglas-Peucker), Toleranz in Metern. */
export function simplify<T>(pts: T[], toLocal: (p: T) => Vec2, tolerance: number): T[] {
  if (pts.length < 3) return pts.slice();
  const loc = pts.map(toLocal);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const a = loc[i];
    const b = loc[j];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const l = Math.hypot(ex, ey) || 1;
    let worst = -1;
    let worstD = tolerance;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs(ex * (loc[k].y - a.y) - ey * (loc[k].x - a.x)) / l;
      if (d > worstD) {
        worstD = d;
        worst = k;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([i, worst], [worst, j]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
