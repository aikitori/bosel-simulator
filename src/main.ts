import './style.css';
import { loadAssets } from './game/assets';
import { Game } from './game/Game';
import { MapPicker } from './map/MapPicker';
import type { Course } from './osm/course';
import { demoCourse } from './osm/demo';
import { deleteCourse, loadCourses, loadSettings, saveCourse, saveSettings, TEAM_COLORS, type Settings } from './storage';

const app = document.getElementById('app')!;
let current: { dispose(): void } | null = null;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function clear(): void {
  current?.dispose();
  current = null;
  app.innerHTML = '';
}

async function play(course: Course): Promise<void> {
  clear();
  const loading = el('div', 'loading', 'Lade Landschaft …');
  app.append(loading);
  let assets;
  try {
    assets = await loadAssets();
  } catch (e) {
    console.error(e);
    loading.textContent = 'Modelle konnten nicht geladen werden.';
    return;
  }
  loading.remove();
  const s = loadSettings();
  current = new Game(app, course, s.teams, s.order, assets, {
    rematch: () => play(course),
    menu: () => home(),
  });
}

function pick(): void {
  clear();
  current = new MapPicker(
    app,
    (course) => {
      saveCourse(course);
      play(course);
    },
    () => home(),
  );
}

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
  const settings = loadSettings();
  const page = el('div', 'home');
  const head = el('header');
  head.append(el('div', 'logo', '●'), el('h1', '', 'Boßel-Simulator'), el('p', 'muted', 'Zwei Teams, eine Straße, so wenig Würfe wie möglich.'));
  page.append(head);

  const start = el('section', 'card');
  const mapBtn = el('button', 'btn primary big', 'Strecke auf der Karte wählen');
  mapBtn.addEventListener('click', pick);
  const demoBtn = el('button', 'btn big', 'Übungsstrecke');
  demoBtn.addEventListener('click', () => play(demoCourse()));
  start.append(mapBtn, demoBtn);
  page.append(start);

  const saved = loadCourses();
  if (saved.length) {
    const list = el('section', 'card');
    list.append(el('h2', '', 'Gespeicherte Strecken'));
    for (const c of saved) {
      const row = el('div', 'course-row');
      const go = el('button', 'btn course', c.name);
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
    'Schräg wischen lenkt die Kugel. In Kurven rollt sie geradeaus weiter – Vorsicht, Graben!',
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
