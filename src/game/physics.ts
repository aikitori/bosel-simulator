import { headingAt, pointAt, project, VERGE, type Course, type Surface } from '../osm/course';
import { inside as insideObstacle, type Obstacle, type ObstacleKind } from './obstacles';
import { mulberry32 } from '../random';
import type { Vec2 } from '../geo';

/** Straßenboßel-Kugel: Gummi, 10 cm Durchmesser. */
export const BALL_RADIUS = 0.05;
const G = 9.81;
const DT = 1 / 240;
const FRAME_EVERY = 4; // → 60 Bilder pro Sekunde
const MAX_TIME = 45;
const RELEASE_HEIGHT = 0.35;
/** Rollwiderstand als Anteil von g je Belag, Bankette ist Gras. */
const ROLL: Record<Surface | 'verge', number> = {
  asphalt: 0.075,
  paved: 0.1,
  gravel: 0.16,
  dirt: 0.22,
  verge: 0.32,
};
/** Dachprofil der Fahrbahn: die Kugel driftet zu den Rändern. */
const CAMBER = 0.012;
/** Seitliche Beschleunigung durch vollen Drall (m/s²) und wie schnell er nachlässt (s). */
const SPIN_ACCEL = 0.09;
const SPIN_DECAY = 6;
/** Höhe der Bordsteinkante; flacher fliegende oder rollende Kugeln prallen ab. */
const CURB_HEIGHT = 0.12;
/** Anteil der Quergeschwindigkeit, der beim Abprall am Bordstein erhalten bleibt. */
const CURB_BOUNCE = 0.45;
/** Zusätzliches Bremsen im Wasser einer Pfütze (Anteil von g). */
const PUDDLE_DRAG = 1.1;
/** Bankette fällt zum Graben hin ab. */
const VERGE_SLOPE = 0.06;

export interface ThrowInput {
  /** Abweichung von der Straßenrichtung im Bogenmaß, positiv = nach links. */
  yaw: number;
  /** Wurfkraft 0…1. */
  power: number;
  /**
   * Zeitpunkt des Loslassens relativ zum idealen Moment (Sekunden, negativ = zu früh).
   * Ohne Angabe: idealer Abwurf.
   */
  release?: number;
  /** Drall −1…1, positiv = Kugel zieht beim Rollen nach links. */
  spin?: number;
}

/** Flacher Abwurf, bei dem die Kugel am weitesten rollt. */
export function idealPitch(power: number): number {
  return 0.09 + 0.06 * power;
}

/**
 * Abwurfwinkel aus dem Zeitpunkt des Loslassens (Sekunden relativ zum idealen Moment):
 * zu früh → Kugel wird in den Boden geschlagen, zu spät → hoher Bogen, der kaum rollt.
 */
export function pitchFromTiming(timing: number, power: number): number {
  return idealPitch(power) + Math.max(-0.2, Math.min(0.6, timing * 1.1));
}

/** Zu früh hat der Arm noch nicht durchgezogen, zu spät bremst er schon: weniger Tempo. */
export function speedFromTiming(timing: number): number {
  return timing < 0 ? Math.max(0.6, 1 - 1.1 * -timing) : Math.max(0.75, 1 - 0.4 * timing);
}

export type TimingGrade = 'perfect' | 'good' | 'early' | 'late';

export function gradeTiming(timing: number): TimingGrade {
  if (Math.abs(timing) < 0.06) return 'perfect';
  if (Math.abs(timing) < 0.14) return 'good';
  return timing < 0 ? 'early' : 'late';
}

export interface Frame {
  x: number;
  y: number;
  z: number;
}

export type Outcome = 'road' | 'verge' | 'ditch' | 'out' | 'finish';

export interface ThrowResult {
  frames: Frame[];
  outcome: Outcome;
  /** Wo es weitergeht (bei Graben/Aus: wo die Kugel die Straße verlassen hat). */
  rest: { s: number; d: number; p: Vec2 };
  /** Wo die Kugel tatsächlich liegt (für die Darstellung). */
  final: Frame;
  /** Gutgeschriebener Weg entlang der Strecke. */
  gained: number;
  /** Erster Bodenkontakt (für Staub/Geräusch). */
  firstBounce: number;
  /** Getroffene Hindernisse in Reihenfolge, mit Bildnummer (für Spritzer und Anzeige). */
  hits: { kind: ObstacleKind | 'curb'; frame: number }[];
}

export function launchSpeed(power: number): number {
  return 8 + 18 * Math.max(0, Math.min(1, power));
}

/**
 * Simuliert einen Wurf von Position (`s`, `d`) aus. Die Kugel fliegt flach, springt ein paar Mal
 * auf und rollt dann. Verlässt sie die Straße über die Bankette hinaus, landet sie im Graben
 * (Land) bzw. im Aus (Ort); weiter geht es dort, wo sie die Straße verlassen hat.
 */
export function simulateThrow(
  course: Course,
  start: { s: number; d: number },
  input: ThrowInput,
  seed = 1,
  obstacles: Obstacle[] = [],
): ThrowResult {
  const rand = mulberry32(seed);
  const base = pointAt(course, start.s);
  const heading = headingAt(course, start.s);
  const left = { x: -heading.y, y: heading.x };
  const origin = { x: base.p.x + left.x * start.d, y: base.p.y + left.y * start.d };

  const timing = input.release ?? 0;
  const speed = launchSpeed(input.power) * speedFromTiming(timing);
  const pitch = pitchFromTiming(timing, input.power);
  const cos = Math.cos(input.yaw);
  const sin = Math.sin(input.yaw);
  const dir = { x: heading.x * cos + left.x * sin, y: heading.y * cos + left.y * sin };

  let x = origin.x;
  let y = origin.y;
  let z = RELEASE_HEIGHT;
  let vx = dir.x * speed * Math.cos(pitch);
  let vy = dir.y * speed * Math.cos(pitch);
  let vz = speed * Math.sin(pitch);
  let rolling = false;
  let hint = base.idx;
  let lastInside = { x, y };
  let firstBounce = -1;
  let noise = 0;
  let outcome: Outcome = 'road';
  const frames: Frame[] = [{ x, y, z }];
  const hits: ThrowResult['hits'] = [];
  const touched = new Set<Obstacle>();
  let lastCurb = -100;
  const hit = (o: Obstacle) => {
    if (touched.has(o)) return false;
    touched.add(o);
    hits.push({ kind: o.kind, frame: frames.length });
    return true;
  };

  for (let step = 1; step * DT < MAX_TIME; step++) {
    const pos = project(course, { x, y }, hint);
    hint = pos.idx;
    const hw = course.halfWidth[pos.idx];
    const ad = Math.abs(pos.d);
    const onRoad = ad <= hw;
    const inside = ad <= hw + VERGE;
    if (inside) lastInside = { x, y };

    if (pos.s >= course.length - 0.3 && pos.idx >= course.points.length - 3) {
      outcome = 'finish';
      break;
    }

    // Hindernisse wirken nur dicht am Boden
    let inPuddle = false;
    if (z < 0.25) {
      for (const o of obstacles) {
        if (o.s < pos.s - 4) continue;
        if (o.s > pos.s + 4) break;
        if (o.kind === 'stone') {
          const dx = x - o.x;
          const dy = y - o.y;
          const dd = Math.hypot(dx, dy);
          const min = o.r + BALL_RADIUS;
          if (dd >= min || z > o.r * 1.5) continue;
          const nx = dx / (dd || 1);
          const ny = dy / (dd || 1);
          const vn = vx * nx + vy * ny;
          if (vn >= 0) continue;
          // Abprall am Stein, die Kugel hüpft dabei ein wenig
          vx -= 1.5 * vn * nx;
          vy -= 1.5 * vn * ny;
          x = o.x + nx * min;
          y = o.y + ny * min;
          if (rolling) {
            rolling = false;
            vz = Math.min(2, -vn * 0.3);
          }
          hit(o);
        } else if (insideObstacle(o, x, y) < 1) {
          if (o.kind === 'puddle') {
            inPuddle = true;
            hit(o);
          } else if (rolling && hit(o)) {
            // Schlagloch: Kugel verliert Tempo, springt heraus und wird seitlich versetzt
            const v = Math.hypot(vx, vy);
            const kick = (rand() < 0.5 ? -1 : 1) * (0.6 + rand() * 0.9) * Math.min(1, v / 6);
            const [ux, uy] = [vx / (v || 1), vy / (v || 1)];
            vx = vx * 0.78 - uy * kick;
            vy = vy * 0.78 + ux * kick;
            vz = 0.8 + rand() * 0.6;
            rolling = false;
          }
        }
      }
    }

    // Bordstein: im Ort prallt eine flache Kugel von der Kante ab, statt auf den Gehweg zu rollen
    if (course.roadside[pos.idx] === 'town' && ad > hw && ad < hw + 0.3 && z < CURB_HEIGHT) {
      const seg = course.points[Math.min(pos.idx + 1, course.points.length - 1)];
      const a0 = course.points[pos.idx];
      const sl = Math.hypot(seg.x - a0.x, seg.y - a0.y) || 1;
      const side = Math.sign(pos.d);
      // Normale nach außen (links = positiv)
      const nx = (-(seg.y - a0.y) / sl) * side;
      const ny = ((seg.x - a0.x) / sl) * side;
      const vn = vx * nx + vy * ny;
      if (vn > 0) {
        vx -= (1 + CURB_BOUNCE) * vn * nx;
        vy -= (1 + CURB_BOUNCE) * vn * ny;
        // zurück an die Kante setzen
        x = pos.foot.x + nx * (hw - 0.02);
        y = pos.foot.y + ny * (hw - 0.02);
        if (vn > 0.3 && frames.length - lastCurb > 8) {
          hits.push({ kind: 'curb', frame: frames.length });
          lastCurb = frames.length;
        }
      }
    }

    if (!rolling) {
      // Flug mit etwas Luftwiderstand
      const v = Math.hypot(vx, vy, vz);
      const drag = 0.0012 * v;
      vx -= vx * drag * DT;
      vy -= vy * drag * DT;
      vz -= (G + vz * drag) * DT;
      x += vx * DT;
      y += vy * DT;
      z += vz * DT;
      if (z <= 0) {
        z = 0;
        if (firstBounce < 0) firstBounce = frames.length;
        if (!inside) {
          outcome = course.roadside[pos.idx] === 'ditch' ? 'ditch' : 'out';
          break;
        }
        const soft = !onRoad || inPuddle; // Gras und Wasser schlucken den Aufprall
        vz = -vz * (soft ? 0.25 : 0.66);
        const keep = inPuddle ? 0.5 : soft ? 0.8 : 0.975;
        vx *= keep;
        vy *= keep;
        if (vz < 0.35) {
          vz = 0;
          rolling = true;
        }
      }
    } else {
      if (!inside) {
        outcome = course.roadside[pos.idx] === 'ditch' ? 'ditch' : 'out';
        break;
      }
      const v = Math.hypot(vx, vy);
      if (v < 0.05) break;
      const mu = (onRoad ? ROLL[course.surface[pos.idx]] : ROLL.verge) + (inPuddle ? PUDDLE_DRAG : 0);
      // Querneigung: auf der Fahrbahn leicht, auf der Bankette stärker nach außen
      const seg = course.points[Math.min(pos.idx + 1, course.points.length - 1)];
      const a0 = course.points[pos.idx];
      const sl = Math.hypot(seg.x - a0.x, seg.y - a0.y) || 1;
      const nx = -(seg.y - a0.y) / sl;
      const ny = (seg.x - a0.x) / sl;
      const side = Math.sign(pos.d) || 1;
      const tilt = (onRoad ? CAMBER * (ad / Math.max(hw, 0.5)) : VERGE_SLOPE) * G * side;
      // Unebenheiten: alle 0,2 s ein neuer kleiner seitlicher Schubs
      if (step % 48 === 0) noise = (rand() - 0.5) * 0.2;
      // Drall: Kraft quer zur Laufrichtung, lässt mit der Zeit nach
      const curl = (input.spin ?? 0) * SPIN_ACCEL * Math.exp(-(step * DT) / SPIN_DECAY);
      const ax = (-vx / v) * mu * G + nx * (tilt + noise) + (-vy / v) * curl;
      const ay = (-vy / v) * mu * G + ny * (tilt + noise) + (vx / v) * curl;
      const nvx = vx + ax * DT;
      const nvy = vy + ay * DT;
      // Reibung darf die Kugel nicht rückwärts rollen lassen
      if (nvx * vx + nvy * vy <= 0) break;
      vx = nvx;
      vy = nvy;
      x += vx * DT;
      y += vy * DT;
    }
    if (step % FRAME_EVERY === 0) frames.push({ x, y, z });
  }

  frames.push({ x, y, z });
  const final = { x, y, z };

  // Liegt die Kugel neben der Straße, rutscht sie sichtbar in den Graben
  if (outcome === 'ditch' || outcome === 'out') {
    const sink = outcome === 'ditch' ? -0.55 : 0;
    // nach außen bis zur Grabensohle rollen
    const pos = project(course, { x, y }, hint);
    const at = pointAt(course, pos.s);
    const h = headingAt(course, pos.s);
    const side = Math.sign(pos.d) || 1;
    const target = course.halfWidth[pos.idx] + VERGE + 1;
    const shift = Math.max(0, target - Math.abs(pos.d));
    for (let i = 1; i <= 12; i++) {
      const d = side * (Math.abs(pos.d) + shift * (i / 12));
      frames.push({ x: at.p.x - h.y * d, y: at.p.y + h.x * d, z: z + (sink - z) * (i / 12) });
    }
    Object.assign(final, frames[frames.length - 1]);
  }

  let rest: ThrowResult['rest'];
  if (outcome === 'finish') {
    const end = pointAt(course, course.length);
    rest = { s: course.length, d: 0, p: end.p };
  } else {
    const restFrom = outcome === 'ditch' || outcome === 'out' ? lastInside : { x, y };
    const pos = project(course, restFrom, hint);
    const hw = course.halfWidth[pos.idx];
    // weitergespielt wird immer von der Fahrbahn (Bankette: an den Rand gelegt)
    const limit = Math.max(0, hw - 0.3);
    const d = Math.max(-limit, Math.min(limit, pos.d));
    if (outcome === 'road' && Math.abs(pos.d) > hw) outcome = 'verge';
    const at = pointAt(course, pos.s);
    const h = headingAt(course, pos.s);
    rest = { s: pos.s, d, p: { x: at.p.x - h.y * d, y: at.p.y + h.x * d } };
  }

  return { frames, outcome, rest, final, gained: rest.s - start.s, firstBounce: Math.max(0, firstBounce), hits };
}
