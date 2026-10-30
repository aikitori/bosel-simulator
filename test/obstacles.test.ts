import { describe, expect, it } from 'vitest';
import { buildCourse } from '../src/osm/course';
import { placeObstacles } from '../src/game/obstacles';

const road = (halfWidth: number) =>
  buildCourse('g', { lat: 53, lon: 7 }, { points: [{ x: 0, y: 0 }, { x: 0, y: 5000 }], halfWidth: [halfWidth], surface: ['gravel'], roadside: ['ditch'] });

describe('Hindernisse', () => {
  it('auf schmalen Wegen liegen anteilig weniger, und keins sperrt den ganzen Weg', () => {
    const wide = placeObstacles(road(2.5), 1, 8);
    const narrow = placeObstacles(road(1), 1, 8);
    expect(narrow.length).toBeLessThan(wide.length * 0.6);
    for (const o of narrow) {
      const across = o.kind === 'puddle' ? o.r * 0.6 : o.r;
      expect(Math.abs(o.d) + across).toBeLessThanOrEqual(1);
      expect(across).toBeLessThan(1);
    }
  });

  it('hält Abstand zueinander', () => {
    const list = placeObstacles(road(2.5), 2);
    for (let i = 1; i < list.length; i++) expect(list[i].s - list[i - 1].s).toBeGreaterThan(6);
  });
});
