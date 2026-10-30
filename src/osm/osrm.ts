import type { LatLon } from '../geo';

/**
 * Schnelle Wegsuche über den OSRM-Dienst der FOSSGIS (routing.openstreetmap.de), Fahrrad-Profil:
 * bevorzugt ruhige Straßen und Wirtschaftswege – genau das, worauf geboßelt wird.
 */

const URL = 'https://routing.openstreetmap.de/routed-bike/route/v1/driving/';

interface OsrmResponse {
  code: string;
  message?: string;
  routes?: { distance: number; geometry: { coordinates: [number, number][] } }[];
}

export async function routeOsrm(waypoints: LatLon[], signal?: AbortSignal): Promise<{ line: LatLon[]; length: number }> {
  const coords = waypoints.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const timeout = AbortSignal.timeout(10000);
  const res = await fetch(`${URL}${coords}?overview=full&geometries=geojson&radiuses=${waypoints.map(() => 200).join(';')}`, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const json = (await res.json()) as OsrmResponse;
  if (json.code !== 'Ok' || !json.routes?.length) throw new Error(json.message ?? json.code);
  const r = json.routes[0];
  return { line: r.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })), length: r.distance };
}
