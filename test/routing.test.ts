import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildGraph, courseFromRoute, route } from '../src/osm/routing';
import type { OsmWay } from '../src/osm/overpass';

// Straßen um Wiesmoor (© OpenStreetMap-Mitwirkende, ODbL)
const ways = JSON.parse(readFileSync(new URL('./fixtures/roads.json', import.meta.url), 'utf8')).elements as OsmWay[];

describe('Routing auf OSM-Daten', () => {
  const g = buildGraph(ways);

  it('findet einen Weg zwischen zwei Punkten und baut eine Strecke daraus', () => {
    const r = route(g, [
      { lat: 53.415, lon: 7.733 },
      { lat: 53.406, lon: 7.75 },
    ]);
    if ('error' in r) throw new Error(r.error);
    expect(r.length).toBeGreaterThan(1000);
    expect(r.length).toBeLessThan(5000);
    const c = courseFromRoute('Test', r, []);
    expect(c.length).toBeGreaterThan(900);
    expect(c.points.length).toBe(c.halfWidth.length);
    expect(c.points.length).toBe(c.roadside.length);
  });

  it('meldet Punkte fernab jeder Straße', () => {
    const r = route(g, [
      { lat: 53.415, lon: 7.733 },
      { lat: 54.5, lon: 7.75 },
    ]);
    expect('error' in r).toBe(true);
  });
});
