import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Projection } from '../src/geo';
import { parseScenery } from '../src/osm/scenery';
import { tileElements, tilesFor } from '../src/osm/tiles';

// Kachel 14/8544/5305 (Wiesmoor) von VersaTiles, © OpenStreetMap-Mitwirkende
const tile = readFileSync(new URL('./fixtures/tile-14-8544-5305.pbf', import.meta.url));

describe('Vektorkacheln', () => {
  it('findet die Kacheln entlang einer Route', () => {
    const t = tilesFor([{ lat: 53.4125, lon: 7.74 }, { lat: 53.4125, lon: 7.745 }], 50);
    expect(t).toContainEqual([8544, 5305]);
  });

  it('übersetzt Häuser, Flächen, Gewässer und Straßen in OSM-artige Elemente', async () => {
    const fetch = vi.fn(async () => new Response(tile));
    vi.stubGlobal('fetch', fetch);
    const line = [{ lat: 53.4125, lon: 7.738 }, { lat: 53.4125, lon: 7.742 }];
    const els = await tileElements(line, 30);
    expect(fetch).toHaveBeenCalled();
    const ways = els.filter((e) => e.type === 'way');
    expect(ways.filter((e) => e.tags?.building).length).toBeGreaterThan(1000);
    expect(ways.some((e) => e.tags?.highway)).toBe(true);
    expect(ways.some((e) => e.tags?.waterway)).toBe(true);
    const s = parseScenery(els, new Projection(line[0]), line.map((p) => new Projection(line[0]).toLocal(p)));
    expect(s.buildings.length).toBeGreaterThan(50);
    expect(s.buildings.some((b) => b.roof === 'gabled')).toBe(true);

    // zweites Mal kommt die Kachel aus dem Speicher
    fetch.mockClear();
    await tileElements(line, 30);
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
