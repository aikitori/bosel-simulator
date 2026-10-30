import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { cachedScenery } from '../src/osm/cache';
import type { LatLon } from '../src/geo';
import type { OsmElement } from '../src/osm/overpass';

const tree = (id: number): OsmElement => ({ type: 'node', id, lat: 53, lon: 7, tags: { natural: 'tree' } });
// ~1,1 km nach Norden, danach weitere ~1,1 km
const a: LatLon[] = [{ lat: 53.0, lon: 7.0 }, { lat: 53.01, lon: 7.0 }];
const ab: LatLon[] = [{ lat: 53.0, lon: 7.0 }, { lat: 53.02, lon: 7.0 }];

describe('Kulissen-Cache', () => {
  it('lädt beim ersten Mal alles, danach nichts mehr und später nur das neue Stück', async () => {
    const calls: LatLon[][][] = [];
    const fetcher = (id: number) => async (lines: LatLon[][]) => {
      calls.push(lines);
      return [tree(id)];
    };
    const first = await cachedScenery(a, 120, fetcher(1));
    expect(calls).toHaveLength(1);
    expect(first.cached).toBe(0);

    const again = await cachedScenery(a, 120, fetcher(2));
    expect(calls).toHaveLength(1);
    expect(again.cached).toBe(1);
    expect(again.elements.map((e) => e.id)).toEqual([1]);

    const longer = await cachedScenery(ab, 120, fetcher(3));
    expect(calls).toHaveLength(2);
    // nur der neue nördliche Teil wurde abgefragt
    const asked = calls[1].flat();
    expect(Math.min(...asked.map((p) => p.lat))).toBeGreaterThan(53.009);
    expect(longer.elements.map((e) => e.id).sort()).toEqual([1, 3]);
  });
});
