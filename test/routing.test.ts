import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildGraph, courseFromRoute, route } from '../src/osm/routing';
import type { OsmElement, OsmWay } from '../src/osm/overpass';
import { orientedRect } from '../src/osm/scenery';

// Straßen um Wiesmoor (© OpenStreetMap-Mitwirkende, ODbL)
const ways = JSON.parse(readFileSync(new URL('./fixtures/roads.json', import.meta.url), 'utf8')).elements as OsmWay[];
const scenery = JSON.parse(readFileSync(new URL('./fixtures/scenery.json', import.meta.url), 'utf8')).elements as OsmElement[];

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

  it('übernimmt Häuser, Bäume und Gewässer aus OSM', () => {
    const r = route(g, [
      { lat: 53.415, lon: 7.733 },
      { lat: 53.406, lon: 7.75 },
    ]);
    if ('error' in r) throw new Error(r.error);
    const c = courseFromRoute('Test', r, scenery);
    expect(c.buildings.length).toBeGreaterThan(100);
    expect(c.buildings.filter((b) => b.roof === 'gabled').length).toBeGreaterThan(50);
    expect(c.trees!.length).toBeGreaterThan(20);
    expect(c.areas!.some((a) => a.kind === 'meadow')).toBe(true);
    expect(c.waterways!.length).toBeGreaterThan(0);
    expect(c.hedges!.length).toBeGreaterThan(0);
    // kein Baum steht auf der Straße
    for (const t of c.trees!) {
      const nearest = Math.min(...c.points.map((p) => Math.hypot(p.x - t.p.x, p.y - t.p.y)));
      expect(nearest).toBeGreaterThan(7);
    }
  });
});

describe('Hausgrundrisse', () => {
  it('macht aus einem fast rechteckigen Grundriss ein Rechteck', () => {
    const rect = orientedRect([
      { x: 0, y: 0 },
      { x: 10, y: 0.2 },
      { x: 10, y: 6 },
      { x: 5, y: 6.1 },
      { x: 0, y: 6 },
    ]);
    expect(rect).toHaveLength(4);
  });

  it('lässt L-förmige Häuser beim Flachdach', () => {
    const l = orientedRect([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ]);
    expect(l).toBeUndefined();
  });
});
