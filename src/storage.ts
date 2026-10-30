import type { Course } from './osm/course';
import type { Order, TeamSetup } from './game/rules';

/** Einstellungen und gespeicherte Strecken im Browser (localStorage). */

export interface Settings {
  teams: [TeamSetup, TeamSetup];
  order: Order;
}

export const TEAM_COLORS = ['#d7263d', '#1b6ee6', '#f2a900', '#2a9d4b', '#8e44ad', '#111111'];

const DEFAULTS: Settings = {
  teams: [
    { name: 'Team Rot', color: TEAM_COLORS[0], players: [] },
    { name: 'Team Blau', color: TEAM_COLORS[1], players: [] },
  ],
  order: 'alternate',
};

const KEY_SETTINGS = 'bosel.settings';
const KEY_COURSES = 'bosel.courses';
const MAX_COURSES = 8;

function read<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // voll oder gesperrt: dann eben nicht merken
  }
}

export function loadSettings(): Settings {
  const s = read<Settings>(KEY_SETTINGS);
  return s?.teams?.length === 2 ? s : structuredClone(DEFAULTS);
}

export function saveSettings(s: Settings): void {
  write(KEY_SETTINGS, s);
}

export interface SavedCourse {
  id: string;
  name: string;
  length: number;
  course: Course;
}

export function loadCourses(): SavedCourse[] {
  return read<SavedCourse[]>(KEY_COURSES) ?? [];
}

const round = (v: number) => Math.round(v * 100) / 100;

export function saveCourse(course: Course): void {
  const compact: Course = {
    ...course,
    points: course.points.map((p) => ({ x: round(p.x), y: round(p.y) })),
    cum: course.cum.map(round),
    halfWidth: course.halfWidth.map(round),
    buildings: course.buildings.map((b) => ({ height: b.height, footprint: b.footprint.map((p) => ({ x: round(p.x), y: round(p.y) })) })),
    water: course.water.map((w) => w.map((p) => ({ x: round(p.x), y: round(p.y) }))),
  };
  const list = loadCourses().filter((c) => c.name !== course.name || Math.abs(c.length - course.length) > 1);
  list.unshift({ id: String(Date.now()), name: course.name, length: course.length, course: compact });
  // Wenn der Speicher voll ist, die ältesten Strecken opfern
  while (list.length) {
    try {
      localStorage.setItem(KEY_COURSES, JSON.stringify(list.slice(0, MAX_COURSES)));
      return;
    } catch {
      list.pop();
    }
  }
}

export function deleteCourse(id: string): void {
  write(
    KEY_COURSES,
    loadCourses().filter((c) => c.id !== id),
  );
}
