import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { LatLon } from '../geo';
import type { Course, Tree } from '../osm/course';
import { bboxAround, fetchExtras, fetchRoads, type BBox, type LoadState, type OsmElement } from '../osm/overpass';
import { parseScenery } from '../osm/scenery';
import { tileElements, type TileProgress } from '../osm/tiles';
import { cachedScenery } from '../osm/cache';
import { routeOsrm } from '../osm/osrm';
import { buildGraph, courseFromRoute, route, type RoadGraph, type RoutedLine } from '../osm/routing';
import { haversine, Projection } from '../geo';

/**
 * Strecke auf der OSM-Karte wählen: Start und Ziel antippen (weitere Punkte = Umweg über
 * diese Stelle). Die Route folgt den Straßen aus OpenStreetMap.
 */

export interface Extras {
  trees: Tree[];
  hedges: Course['points'][];
}

const MIN_LENGTH = 150;
const MAX_LENGTH = 15000;
const MAX_SPAN = 12000;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const contains = (outer: BBox, inner: BBox) =>
  inner.south >= outer.south && inner.north <= outer.north && inner.west >= outer.west && inner.east <= outer.east;

export class MapPicker {
  private readonly root: HTMLElement;
  private readonly map: L.Map;
  private readonly status: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly waypoints: L.Marker[] = [];
  private routeLine: L.Polyline | null = null;
  private routed: RoutedLine | null = null;
  private graph: { bbox: BBox; g: RoadGraph } | null = null;
  private abort: AbortController | null = null;
  private placeName = '';

  constructor(
    host: HTMLElement,
    private readonly onDone: (course: Course, extras: Promise<Extras>) => void,
    private readonly onCancel: () => void,
  ) {
    this.root = el('div', 'picker');
    const mapEl = el('div', 'picker-map');
    const bar = el('form', 'picker-search');
    const search = el('input');
    search.type = 'search';
    search.placeholder = 'Ort suchen …';
    const locate = el('button', 'btn icon', '◎');
    locate.type = 'button';
    locate.title = 'Mein Standort';
    bar.append(search, locate);
    const panel = el('div', 'picker-panel');
    this.status = el('div', 'picker-status', 'Tippe auf eine Straße für den Start, dann fürs Ziel.');
    const buttons = el('div', 'picker-buttons');
    const back = el('button', 'btn', 'Zurück');
    const undo = el('button', 'btn', 'Rückgängig');
    this.playBtn = el('button', 'btn primary', 'Spielen');
    this.playBtn.disabled = true;
    buttons.append(back, undo, this.playBtn);
    panel.append(this.status, buttons);
    this.root.append(mapEl, bar, panel);
    host.append(this.root);

    this.map = L.map(mapEl, { zoomControl: false }).setView([53.42, 7.6], 11);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(this.map);
    this.map.on('click', (e: L.LeafletMouseEvent) => this.addPoint(e.latlng));

    back.addEventListener('click', () => this.onCancel());
    undo.addEventListener('click', () => {
      const m = this.waypoints.pop();
      if (m) this.map.removeLayer(m);
      this.renumber();
      this.update();
    });
    this.playBtn.addEventListener('click', () => this.finish());
    bar.addEventListener('submit', (e) => {
      e.preventDefault();
      this.search(search.value.trim());
      search.blur();
    });
    locate.addEventListener('click', () => this.locate());
  }

  dispose(): void {
    this.abort?.abort();
    this.stopProgress();
    this.map.remove();
    this.root.remove();
  }

  private ticker: ReturnType<typeof setInterval> | undefined;

  private setStatus(text: string, error = false, busy = false): void {
    if (!busy) this.stopProgress();
    this.status.textContent = text;
    this.status.classList.toggle('error', error);
    this.status.classList.toggle('busy', busy);
  }

  /**
   * Laufende Anzeige während einer Overpass-Abfrage: Schritt, Sekunden, Server und
   * empfangene Datenmenge. Liefert den Fortschritts-Callback für die Abfrage.
   */
  private progress(step: string): (s: LoadState) => void {
    this.stopProgress();
    const started = performance.now();
    let state: LoadState | null = null;
    const render = () => {
      const sec = Math.round((performance.now() - started) / 1000);
      let detail = '';
      if (state && state.bytes > 0) detail = ` · ${(state.bytes / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB empfangen`;
      else if (state) detail = state.server > 1 ? ` · Ausweichserver ${state.server - 1} von ${state.servers - 1}` : ' · Server rechnet';
      if (sec >= 20 && (!state || state.bytes === 0)) detail += ' – Overpass ist gerade stark ausgelastet';
      this.setStatus(`${step} ${sec} s${detail}`, false, true);
    };
    render();
    this.ticker = setInterval(render, 500);
    return (s) => {
      state = s;
      render();
    };
  }

  private stopProgress(): void {
    clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private async search(q: string): Promise<void> {
    if (!q) return;
    this.setStatus('Suche …');
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
      const hits = (await res.json()) as { lat: string; lon: string }[];
      if (!hits.length) return this.setStatus(`„${q}“ nicht gefunden.`, true);
      this.map.setView([+hits[0].lat, +hits[0].lon], 15);
      this.placeName = q;
      this.setStatus('Tippe auf eine Straße für den Start, dann fürs Ziel.');
    } catch {
      this.setStatus('Suche gerade nicht erreichbar.', true);
    }
  }

  private locate(): void {
    if (!navigator.geolocation) return this.setStatus('Standort wird nicht unterstützt.', true);
    this.setStatus('Suche Standort …');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        this.map.setView([p.coords.latitude, p.coords.longitude], 16);
        this.setStatus('Tippe auf eine Straße für den Start, dann fürs Ziel.');
      },
      () => this.setStatus('Standort nicht verfügbar.', true),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  private addPoint(at: L.LatLng): void {
    const marker = L.marker(at, { draggable: true, icon: this.icon(this.waypoints.length) });
    marker.on('dragend', () => this.update());
    marker.addTo(this.map);
    this.waypoints.push(marker);
    this.renumber();
    this.update();
  }

  private icon(i: number): L.DivIcon {
    const last = i === this.waypoints.length - 1 && i > 0;
    const label = i === 0 ? 'S' : last ? 'Z' : String(i);
    return L.divIcon({ className: `wp ${i === 0 ? 'start' : last ? 'end' : 'via'}`, html: label, iconSize: [28, 28] });
  }

  private renumber(): void {
    this.waypoints.forEach((m, i) => m.setIcon(this.icon(i)));
  }

  private async update(): Promise<void> {
    this.abort?.abort();
    this.routed = null;
    this.playBtn.disabled = true;
    if (this.routeLine) this.map.removeLayer(this.routeLine);
    this.routeLine = null;
    const pts: LatLon[] = this.waypoints.map((m) => ({ lat: m.getLatLng().lat, lon: m.getLatLng().lng }));
    if (pts.length < 2) {
      this.setStatus(pts.length ? 'Jetzt das Ziel antippen.' : 'Tippe auf eine Straße für den Start, dann fürs Ziel.');
      return;
    }
    const need = bboxAround(pts, 250);
    const span = Math.max(
      haversine({ lat: need.south, lon: need.west }, { lat: need.north, lon: need.west }),
      haversine({ lat: need.south, lon: need.west }, { lat: need.south, lon: need.east }),
    );
    if (span > MAX_SPAN) return this.setStatus('Die Punkte liegen zu weit auseinander (höchstens etwa 10 km).', true);

    const abort = new AbortController();
    this.abort = abort;
    try {
      const r = await this.findRoute(pts, need, abort.signal);
      if ('error' in r) return this.setStatus(r.error, true);
      this.routed = r;
      this.routeLine = L.polyline(
        r.line.map((p) => [p.lat, p.lon] as [number, number]),
        { color: '#c8102e', weight: 6, opacity: 0.85 },
      ).addTo(this.map);
      const km = (r.length / 1000).toLocaleString('de-DE', { maximumFractionDigits: 2 });
      if (r.length < MIN_LENGTH) return this.setStatus(`Nur ${Math.round(r.length)} m – die Strecke sollte länger sein.`, true);
      if (r.length > MAX_LENGTH) return this.setStatus(`${km} km – das ist zu lang (höchstens 15 km).`, true);
      this.setStatus(`Strecke: ${km} km · weitere Punkte = Umweg`);
      this.playBtn.disabled = false;
    } catch (e) {
      if (abort.signal.aborted) return;
      this.setStatus('Straßen konnten nicht geladen werden. Internet da?', true);
      console.error(e);
    }
  }

  /**
   * Route suchen: zuerst über OSRM (schnell, keine großen Datenmengen); nur wenn das nicht
   * klappt, Straßen über Overpass laden und selbst routen.
   */
  private async findRoute(pts: LatLon[], need: BBox, signal: AbortSignal): Promise<RoutedLine | { error: string }> {
    this.setStatus('Suche Route …', false, true);
    try {
      return await routeOsrm(pts, signal);
    } catch (e) {
      if (signal.aborted) throw e;
      console.warn('OSRM nicht erreichbar, weiche auf Overpass aus', e);
    }
    if (!this.graph || !contains(this.graph.bbox, need)) {
      const bbox = bboxAround(pts, 500);
      const ways = await fetchRoads(bbox, signal, this.progress('Routendienst nicht erreichbar – lade Straßen aus OpenStreetMap …'));
      this.setStatus(`${ways.length} Straßenstücke geladen – berechne Route …`, false, true);
      await new Promise((r) => setTimeout(r, 0)); // Anzeige erst zeichnen lassen
      this.graph = { bbox, g: buildGraph(ways) };
    }
    return route(this.graph.g, pts);
  }

  private async finish(): Promise<void> {
    const r = this.routed;
    if (!r) return;
    this.playBtn.disabled = true;
    const started = performance.now();
    const label = (p: TileProgress) => `Lade Kartenkacheln ${p.done} von ${p.total} … ${Math.round((performance.now() - started) / 1000)} s`;
    this.setStatus('Lade Kartenkacheln …', false, true);
    let elements: OsmElement[] = [];
    let failed = false;
    const [, place] = await Promise.all([
      tileElements(r.line, 160, AbortSignal.timeout(30000), (p) => this.setStatus(label(p), false, true)).then(
        (e) => (elements = e),
        (e) => {
          // ohne Kulisse spielbar, nur kahler
          console.error(e);
          failed = true;
        },
      ),
      this.placeName ? Promise.resolve(this.placeName) : reverseName(r.line[0]),
    ]);
    this.setStatus('Baue die Landschaft …', false, true);
    await new Promise((res) => setTimeout(res, 0));
    const km = (r.length / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 });
    const course = courseFromRoute(`${place || 'Eigene Strecke'} (${km} km)`, r, elements);
    if (failed) {
      this.setStatus('Kartenkacheln nicht erreichbar – Strecke ohne Häuser.', true);
      await new Promise((res) => setTimeout(res, 2500));
    }
    this.onDone(course, loadExtras(course, r.line));
  }
}

/**
 * Einzelbäume, Baumreihen und Hecken (nicht in den Vektorkacheln) im Hintergrund von Overpass
 * holen – gecacht, und wenn es nicht klappt, fehlen eben nur diese Details.
 */
export async function loadExtras(course: Course, line: LatLon[]): Promise<Extras> {
  const res = await cachedScenery(line, 120, (gaps) => fetchExtras(gaps, 120, AbortSignal.timeout(45000)));
  const wanted = res.elements.filter((e) => e.tags?.natural === 'tree' || e.tags?.natural === 'tree_row' || e.tags?.barrier === 'hedge');
  const proj = new Projection(course.origin);
  const s = parseScenery(wanted, proj, course.points);
  return { trees: s.trees ?? [], hedges: s.hedges ?? [] };
}

async function reverseName(p: LatLon): Promise<string> {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=14&lat=${p.lat}&lon=${p.lon}`);
    const json = (await res.json()) as { address?: Record<string, string> };
    const a = json.address ?? {};
    return a.village ?? a.town ?? a.city ?? a.suburb ?? a.hamlet ?? '';
  } catch {
    return '';
  }
}
