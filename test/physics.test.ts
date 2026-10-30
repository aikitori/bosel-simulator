import { describe, expect, it } from 'vitest';
import { demoCourse } from '../src/osm/demo';
import { buildCourse, project } from '../src/osm/course';
import { simulateThrow } from '../src/game/physics';

const straight = () =>
  buildCourse('gerade', { lat: 53, lon: 7 }, {
    points: [{ x: 0, y: 0 }, { x: 0, y: 2000 }],
    halfWidth: [2.5],
    surface: ['asphalt'],
    roadside: ['ditch'],
  });

describe('Strecke', () => {
  it('tastet gleichmäßig ab und projiziert seitlich', () => {
    const c = straight();
    expect(c.length).toBeCloseTo(2000, 0);
    const p = project(c, { x: -1, y: 500 });
    expect(p.s).toBeCloseTo(500, 1);
    expect(p.d).toBeCloseTo(1, 3); // x = -1 liegt links bei Blick nach Norden
  });
});

describe('Wurf', () => {
  it('ein voller Wurf geradeaus rollt weit und bleibt auf der Straße', () => {
    const r = simulateThrow(straight(), { s: 0, d: 0 }, { yaw: 0, power: 1 });
    expect(['road', 'verge']).toContain(r.outcome);
    expect(r.gained).toBeGreaterThan(120);
    expect(r.gained).toBeLessThan(320);
  });

  it('ein schwacher Wurf kommt nicht so weit', () => {
    const c = straight();
    const weak = simulateThrow(c, { s: 0, d: 0 }, { yaw: 0, power: 0.2 }).gained;
    const strong = simulateThrow(c, { s: 0, d: 0 }, { yaw: 0, power: 0.8 }).gained;
    expect(weak).toBeLessThan(strong);
    expect(weak).toBeGreaterThan(10);
  });

  it('schräg geworfen landet die Kugel im Graben, weiter geht es am Straßenrand', () => {
    const r = simulateThrow(straight(), { s: 100, d: 0 }, { yaw: 0.4, power: 0.7 });
    expect(r.outcome).toBe('ditch');
    expect(Math.abs(r.rest.d)).toBeLessThanOrEqual(2.5);
    expect(r.rest.s).toBeGreaterThan(100);
    expect(r.final.z).toBeLessThan(0);
  });

  it('ist deterministisch', () => {
    const c = demoCourse();
    const a = simulateThrow(c, { s: 0, d: 0 }, { yaw: 0.02, power: 0.9 }, 7);
    const b = simulateThrow(c, { s: 0, d: 0 }, { yaw: 0.02, power: 0.9 }, 7);
    expect(a.rest).toEqual(b.rest);
  });

  it('erreicht das Ziel', () => {
    const c = straight();
    const r = simulateThrow(c, { s: c.length - 30, d: 0 }, { yaw: 0, power: 0.8 });
    expect(r.outcome).toBe('finish');
    expect(r.rest.s).toBe(c.length);
  });
});
