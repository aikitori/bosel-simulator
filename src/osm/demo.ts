import type { Vec2 } from '../geo';
import { buildCourse, type Building, type Course, type RawRoute } from './course';

/**
 * Eingebaute Übungsstrecke ohne Internet: ein Landweg mit Kurven, einem Hof und einem
 * Dorfstück. Liegt (gedanklich) in Ostfriesland, damit Kartenkoordinaten plausibel sind.
 */
export function demoCourse(): Course {
  const origin = { lat: 53.4, lon: 7.5 };
  const raw: RawRoute = { points: [], halfWidth: [], surface: [], roadside: [] };
  let p: Vec2 = { x: 0, y: 0 };
  let heading = Math.PI / 2; // nach Norden
  const add = (len: number, turnDeg: number, hw: number, town = false, surface: RawRoute['surface'][number] = 'asphalt') => {
    const steps = Math.max(1, Math.round(len / 10));
    const dTurn = ((turnDeg * Math.PI) / 180) / steps;
    for (let i = 0; i < steps; i++) {
      raw.points.push({ ...p });
      raw.halfWidth.push(hw);
      raw.surface.push(surface);
      raw.roadside.push(town ? 'town' : 'ditch');
      heading += dTurn;
      p = { x: p.x + Math.cos(heading) * (len / steps), y: p.y + Math.sin(heading) * (len / steps) };
    }
  };
  add(260, 0, 2.2);
  add(140, 25, 2.2);
  add(200, 0, 2.2);
  add(120, -60, 2.2);
  add(180, 0, 2.0, false, 'gravel');
  add(60, 80, 2.4);
  add(220, 0, 2.6, true);
  add(150, -20, 2.6, true);
  add(200, 0, 2.2);
  raw.points.push({ ...p });

  const buildings: Building[] = [];
  const house = (cx: number, cy: number, w: number, d: number, rot: number, height: number) => {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const corner = (u: number, v: number): Vec2 => ({ x: cx + u * c - v * s, y: cy + u * s + v * c });
    buildings.push({
      footprint: [corner(-w / 2, -d / 2), corner(w / 2, -d / 2), corner(w / 2, d / 2), corner(-w / 2, d / 2)],
      height,
    });
  };
  const course = buildCourse('Übungsstrecke', origin, raw, buildings);
  // Häuser neben das Dorfstück und einen Hof an die Kurve setzen
  const placeAlong = (s: number, side: number, offset: number, w: number, dd: number, h: number) => {
    const i = Math.min(course.points.length - 2, Math.round(s / 2));
    const a = course.points[i];
    const b = course.points[i + 1];
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    house(a.x - Math.sin(ang) * offset * side, a.y + Math.cos(ang) * offset * side, w, dd, ang, h);
  };
  placeAlong(640, -1, 22, 30, 16, 8);
  placeAlong(690, -1, 30, 14, 10, 6);
  for (let s = 880; s < 1230; s += 32) {
    placeAlong(s, 1, 14, 11, 9, 7);
    placeAlong(s + 16, -1, 15, 10, 10, 6);
  }
  return course;
}
