import { describe, expect, it } from 'vitest';
import { buildCourse } from '../src/osm/course';
import { simulateThrow } from '../src/game/physics';
import { angleForYaw, yawFromAngle } from '../src/game/SwipeInput';
import { mulberry32 } from '../src/random';

/**
 * Abstimmung des Abwurfs mit simulierten Spielern: Streuung bei Timing (s), Wischwinkel (Grad)
 * und Kraft. Sichert ab, dass ein normaler Wurf auf einer 5-m-Landstraße meist auf der Straße
 * bleibt und sich Können in Weite auszahlt. (Vor der Abstimmung: 98 % im Graben.)
 */

const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
const road = buildCourse('Landstraße', { lat: 53, lon: 7 }, {
  points: [{ x: 0, y: 0 }, { x: 0, y: 3000 }],
  halfWidth: [2.5],
  surface: ['asphalt'],
  roadside: ['ditch'],
});

function play(timing: number, angle: number, power: number, n = 40) {
  const r = mulberry32(7);
  let gained = 0;
  let ditch = 0;
  for (let i = 0; i < n; i++) {
    const deg = angleForYaw(0) + gauss(r) * angle;
    const res = simulateThrow(
      road,
      { s: 0, d: 0 },
      { yaw: yawFromAngle(deg), power: Math.max(0.1, Math.min(1, 0.85 + gauss(r) * power)), release: gauss(r) * timing },
      i + 1,
    );
    gained += res.gained;
    if (res.outcome === 'ditch') ditch++;
  }
  return { meters: gained / n, ditch: ditch / n };
}

describe('Abwurf-Abstimmung', () => {
  const good = play(0.04, 4, 0.06);
  const average = play(0.08, 8, 0.12);
  const novice = play(0.14, 14, 0.2);

  it('die meisten Würfe bleiben auf der Straße', () => {
    expect(good.ditch).toBeLessThan(0.1);
    expect(average.ditch).toBeLessThan(0.25);
    expect(novice.ditch).toBeLessThan(0.5);
  });

  it('Können zahlt sich in Weite aus', () => {
    expect(good.meters).toBeGreaterThan(average.meters);
    expect(average.meters).toBeGreaterThan(novice.meters);
    expect(average.meters).toBeGreaterThan(180);
  });
});
