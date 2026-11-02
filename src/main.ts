import './style.css';
import type { Resume } from './game/Game';
import { isOver } from './game/rules';
import type { Extras } from './map/MapPicker';
import type { Course } from './osm/course';
import { demoCourse } from './osm/demo';
import {
  clearMatch,
  courseKey,
  deleteCourse,
  loadCourses,
  loadMatch,
  loadRecords,
  loadSettings,
  saveCourse,
  saveMatch,
  saveSettings,
  TEAM_COLORS,
  type Settings,
} from './storage';

// Three.js und Leaflet werden erst geladen, wenn sie gebraucht werden – die Startseite ist sofort da.

const app = document.getElementById('app')!;
let current: { dispose(): void; back?(): void } | null = null;
/** Zählt Bildschirmwechsel, damit ein noch ladender Bildschirm nicht über einem neueren erscheint. */
let screen = 0;

/**
 * Zurück-Taste (Android) bzw. Browser-Zurück: Solange Spiel oder Karte offen sind, liegt ein
 * zusätzlicher Verlaufseintrag oben, der sie abfängt – sonst würde die App einfach beendet.
 */
function trapBack(): void {
  if (!history.state?.bosel) history.pushState({ bosel: true }, '');
}

function releaseBack(): void {
  if (history.state?.bosel) history.back();
}

window.addEventListener('popstate', () => {
  if (!current?.back) return;
  history.pushState({ bosel: true }, '');
  current.back();
});

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function clear(): number {
  current?.dispose();
  current = null;
  app.innerHTML = '';
  return ++screen;
}

interface PlayOptions {
  demo?: boolean;
  extras?: Promise<Extras>;
  resume?: Resume;
}

async function play(course: Course, opts: PlayOptions = {}): Promise<void> {
  const me = clear();
  trapBack();
  const loading = el('div', 'loading', 'Lade Landschaft …');
  app.append(loading);
  current = { dispose: () => undefined, back: () => home() };
  let game;
  try {
    const [{ Game }, { loadAssets }] = await Promise.all([import('./game/Game'), import('./game/assets')]);
    game = { Game, assets: await loadAssets() };
  } catch (e) {
    console.error(e);
    loading.textContent = 'Modelle konnten nicht geladen werden.';
    return;
  }
  if (me !== screen) return;
  loading.remove();
  const s = loadSettings();
  current = new game.Game(
    app,
    course,
    s.teams,
    s.order,
    game.assets,
    {
      rematch: () => play(course, { demo: opts.demo }),
      menu: () => home(),
      progress: (match, seed) => {
        if (isOver(match)) clearMatch();
        else saveMatch({ course: courseKey(course), demo: !!opts.demo, match, seed });
      },
    },
    opts.extras,
    opts.resume,
  );
}

async function pick(): Promise<void> {
  const me = clear();
  trapBack();
  current = { dispose: () => undefined, back: () => home() };
  const { MapPicker } = await import('./map/MapPicker');
  if (me !== screen) return;
  current = new MapPicker(
    app,
    (course, extras) => {
      saveCourse(course);
      void play(course, { extras });
    },
    () => home(),
  );
  current.back = () => home();
}

/** Gespeicherte, noch nicht beendete Partie samt Strecke – sofern die Strecke noch da ist. */
function resumable(): { course: Course; demo: boolean; resume: Resume } | undefined {
  const saved = loadMatch();
  if (!saved || isOver(saved.match)) return undefined;
  const course = saved.demo ? demoCourse() : loadCourses().find((c) => courseKey(c) === saved.course)?.course;
  return course && { course, demo: saved.demo, resume: { match: saved.match, seed: saved.seed } };
}

/** Button mit zweiter, kleiner Zeile. */
function labeled(cls: string, title: string, sub?: string): HTMLButtonElement {
  const b = el('button', cls, title);
  if (sub) b.append(el('small', '', sub));
  return b;
}

const km = (m: number) => `${(m / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} km`;

function teamEditor(settings: Settings, i: 0 | 1): HTMLElement {
  const t = settings.teams[i];
  const box = el('div', 'team-edit');
  box.style.setProperty('--team', t.color);
  const name = el('input');
  name.value = t.name;
  name.maxLength = 20;
  name.addEventListener('input', () => {
    t.name = name.value.trim() || `Team ${i + 1}`;
    saveSettings(settings);
  });
  const colors = el('div', 'colors');
  for (const c of TEAM_COLORS) {
    const b = el('button', 'swatch');
    b.style.background = c;
    b.classList.toggle('on', c === t.color);
    b.addEventListener('click', () => {
      t.color = c;
      box.style.setProperty('--team', c);
      colors.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s === b));
      saveSettings(settings);
    });
    colors.append(b);
  }
  const players = el('input');
  players.placeholder = 'Spieler, durch Komma getrennt (optional)';
  players.value = t.players.join(', ');
  players.addEventListener('input', () => {
    t.players = players.value
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    saveSettings(settings);
  });
  box.append(name, colors, players);
  return box;
}

function home(): void {
  clear();
  releaseBack();
  const settings = loadSettings();
  const records = loadRecords();
  const record = (c: Course) => {
    const r = records[courseKey(c)];
    return r ? ` · Rekord ${r.throws} Würfe` : '';
  };
  const page = el('div', 'home');
  const head = el('header');
  head.append(el('div', 'logo', '●'), el('h1', '', 'Boßel-Simulator'), el('p', 'muted', 'Zwei Teams, eine Straße, so wenig Würfe wie möglich.'));
  page.append(head);

  const start = el('section', 'card');
  const open = resumable();
  if (open) {
    const [a, b] = open.resume.match.teams;
    const go = labeled('btn primary big', 'Partie fortsetzen', `${open.course.name} · ${a.setup.name} ${a.throws} : ${b.throws} ${b.setup.name}`);
    go.addEventListener('click', () => play(open.course, { demo: open.demo, resume: open.resume }));
    start.append(go);
  }
  const mapBtn = el('button', open ? 'btn big' : 'btn primary big', 'Strecke auf der Karte wählen');
  mapBtn.addEventListener('click', () => void pick());
  const demo = demoCourse();
  const demoBtn = labeled('btn big', 'Übungsstrecke', `${km(demo.length)}${record(demo)}`);
  demoBtn.addEventListener('click', () => play(demo, { demo: true }));
  start.append(mapBtn, demoBtn);
  page.append(start);

  const saved = loadCourses();
  if (saved.length) {
    const list = el('section', 'card');
    list.append(el('h2', '', 'Gespeicherte Strecken'));
    for (const c of saved) {
      const row = el('div', 'course-row');
      const go = labeled('btn course', c.name, `${km(c.length)}${record(c.course)}`);
      go.addEventListener('click', () => play(c.course));
      const del = el('button', 'btn icon', '✕');
      del.title = 'Löschen';
      del.addEventListener('click', () => {
        deleteCourse(c.id);
        row.remove();
      });
      row.append(go, del);
      list.append(row);
    }
    page.append(list);
  }

  const teams = el('section', 'card');
  teams.append(el('h2', '', 'Mannschaften'), teamEditor(settings, 0), teamEditor(settings, 1));
  const order = el('label', 'order');
  const select = el('select');
  for (const [v, label] of [
    ['alternate', 'Abwechselnd werfen'],
    ['behind', 'Wer hinten liegt, wirft (traditionell)'],
  ] as const) {
    const o = el('option', '', label);
    o.value = v;
    o.selected = settings.order === v;
    select.append(o);
  }
  select.addEventListener('change', () => {
    settings.order = select.value as Settings['order'];
    saveSettings(settings);
  });
  order.append('Reihenfolge', select);
  teams.append(order);
  page.append(teams);

  const how = el('section', 'card');
  how.append(el('h2', '', 'So geht’s'));
  const ul = el('ul');
  for (const t of [
    'Finger aufs Bild: Anlauf. Im grünen Bereich zügig nach oben wischen und loslassen – der Moment bestimmt den Abwurfwinkel, das Tempo die Weite.',
    'Schräg wischen lenkt die Kugel, ein gebogener Wisch gibt Drall. In Kurven rollt sie geradeaus weiter – Vorsicht, Graben!',
    'Landet die Kugel im Graben, geht es dort weiter, wo sie die Straße verlassen hat.',
    'Wer mit weniger Würfen ins Ziel kommt, gewinnt. Antippen spult den Wurf vor.',
  ])
    ul.append(el('li', '', t));
  how.append(ul);
  page.append(how);
  page.append(el('footer', 'muted', 'Kartendaten © OpenStreetMap-Mitwirkende'));
  app.append(page);
}

home();
