import type { Vec2 } from '../geo';
import { mulberry32 } from '../random';
import { buildCourse, DITCH, VERGE, type Area, type Building, type Course, type RawRoute, type Tree } from './course';

/**
 * Eingebaute Übungsstrecke ohne Internet: ein Landweg mit Kurven, einem Hof, einem
 * Dorfstück, Weiden, Äckern und einem Wäldchen. Liegt (gedanklich) in Ostfriesland.
 */
export function demoCourse(): Course {
  const origin = { lat: 53.4, lon: 7.5 };
  const raw: RawRoute = { points: [], halfWidth: [], surface: [], roadside: [] };
  let p: Vec2 = { x: 0, y: 0 };
  let heading = Math.PI / 2; // nach Norden
  const add = (len: number, turnDeg: number, hw: number, town = false, surface: RawRoute['surface'][number] = 'asphalt') => {
    const steps = Math.max(1, Math.round(len / 10));
    const dTurn = (turnDeg * Math.PI) / 180 / steps;
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
  add(220, 0, 2.6, true, 'paved');
  add(150, -20, 2.6, true, 'paved');
  add(200, 0, 2.2);
  raw.points.push({ ...p });

  const base = buildCourse('Übungsstrecke', origin, raw);
  const rand = mulberry32(5);
  const frame = (s: number) => {
    const i = Math.min(base.points.length - 2, Math.round(s / 2));
    const a = base.points[i];
    const b = base.points[i + 1];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    const t = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
    return { a, t, n: { x: -t.y, y: t.x }, ang: Math.atan2(t.y, t.x), hw: base.halfWidth[i] };
  };
  /** Punkt neben der Strecke: `side` +1 = links, Abstand ab Fahrbahnmitte. */
  const beside = (s: number, side: number, off: number, along = 0): Vec2 => {
    const f = frame(s);
    return { x: f.a.x + f.n.x * off * side + f.t.x * along, y: f.a.y + f.n.y * off * side + f.t.y * along };
  };
  const rect = (c: Vec2, w: number, d: number, ang: number): Vec2[] => {
    const cs = Math.cos(ang);
    const sn = Math.sin(ang);
    return [
      [-w / 2, -d / 2],
      [w / 2, -d / 2],
      [w / 2, d / 2],
      [-w / 2, d / 2],
    ].map(([u, v]) => ({ x: c.x + u * cs - v * sn, y: c.y + u * sn + v * cs }));
  };

  const buildings: Building[] = [];
  const house = (s: number, side: number, off: number, w: number, d: number, eaves: number, brick = true) =>
    buildings.push({
      footprint: rect(beside(s, side, off), w, d, frame(s).ang),
      height: eaves,
      roof: 'gabled',
      roofHeight: Math.min(w, d) * 0.5,
      material: brick ? 'brick' : 'plaster',
      roofColor: rand() < 0.5 ? '#8a3324' : '#3a3d42',
    });
  // Gulfhof an der Kurve: großes Wirtschaftsgebäude, davor das Wohnhaus
  house(640, -1, 26, 34, 18, 4.5);
  house(690, -1, 30, 14, 10, 3.2);
  for (let s = 880; s < 1230; s += 32) {
    house(s, 1, 14, 11, 9, 3.2, rand() < 0.8);
    house(s + 16, -1, 15, 10, 10, 3.2, rand() < 0.8);
  }

  const trees: Tree[] = [];
  const kinds: Tree['kind'][] = ['round', 'oak', 'birch'];
  // Baumreihen an der Landstraße, je Abschnitt eine Baumart
  for (let s = 10; s < base.length - 10; s += 9) {
    const town = base.roadside[Math.round(s / 2)] === 'town';
    if (town || (s > 600 && s < 760)) continue;
    const kind = s < 400 ? 'oak' : s < 800 ? 'poplar' : kinds[Math.floor(s / 150) % 3];
    for (const side of [1, -1]) {
      if (rand() < 0.25) continue;
      trees.push({ p: beside(s, side, frame(s).hw + VERGE + DITCH + 2.5), kind, scale: 0.85 + rand() * 0.3 });
    }
  }
  // Wäldchen links hinter der Kurve
  const areas: Area[] = [];
  const wood = rect(beside(460, 1, 70), 140, 90, frame(460).ang);
  areas.push({ kind: 'forest', poly: wood });
  for (let i = 0; i < 160; i++) {
    const q = beside(395 + rand() * 130, 1, 32 + rand() * 75);
    trees.push({ p: q, kind: rand() < 0.3 ? 'birch' : 'round', scale: 0.8 + rand() * 0.4 });
  }
  // Weiden und Äcker in Streifen links und rechts
  for (let s = 0; s < base.length; s += 150) {
    for (const side of [1, -1]) {
      if (side === 1 && s >= 380 && s < 540) continue;
      const kind = rand() < 0.55 ? 'meadow' : 'farmland';
      areas.push({ kind, poly: rect(beside(s + 75, side, 70), 140, 120, frame(s + 75).ang) });
    }
  }
  const hedges = [[beside(250, -1, 30), beside(350, -1, 30)]];
  const waterways = [{ line: [beside(0, -1, 40), beside(200, -1, 40), beside(380, -1, 45)], width: 3 }];
  return { ...base, buildings, trees, areas, hedges, waterways, water: [] };
}
