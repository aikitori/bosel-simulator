import type { ThrowInput } from './physics';

/**
 * Wurf per Touch: Finger aufsetzen startet den Anlauf, im richtigen Moment nach oben schnippen
 * und loslassen. Tempo der Geste = Kraft, seitliche Abweichung = Richtung, Zeitpunkt des
 * Loslassens = Abwurfwinkel, gebogener Strich = Drall. Ausgewertet werden nur die letzten Millisekunden vor dem Loslassen.
 */

interface Sample {
  x: number;
  y: number;
  t: number;
}

const WINDOW_MS = 110;
/** Wie lange vor dem Loslassen der schnellste Moment der Geste noch zählt. */
const RECENT_MS = 300;
/** Bildschirmhöhen pro Sekunde für volle Kraft. */
const FULL_SPEED = 4.2;
const MIN_SPEED = 0.5;
const YAW_FACTOR = 0.45;
const MAX_YAW = 0.6;
/** Krümmung der Geste (Bogenmaß) für vollen Drall; kleinere Krümmungen sind Zittern. */
const FULL_BEND = 0.6;
const MIN_BEND = 0.08;

/** Aufwärtstempo (Bildschirmhöhen/s) zwischen einem Punkt und dem Punkt ~WINDOW_MS davor. */
function speedAt(samples: Sample[], j: number, screenHeight: number): number {
  let i = j;
  while (i > 0 && samples[j].t - samples[i].t < WINDOW_MS) i--;
  const dt = Math.max(1, samples[j].t - samples[i].t);
  return ((samples[i].y - samples[j].y) / dt) * (1000 / screenHeight);
}

/**
 * Kraft = schnellster Moment der Aufwärtsbewegung kurz vor dem Loslassen (ein kurzes Innehalten
 * vor dem Abheben kostet also nichts). Richtung = der ganze Aufwärtsstrich vom tiefsten Punkt
 * bis zum Loslassen – genau das, was der Vorschaupfeil zeigt.
 */
export function evaluate(samples: Sample[], screenHeight: number): ThrowInput | null {
  if (samples.length < 2) return null;
  const n = samples.length;
  const last = samples[n - 1];
  let up = 0;
  for (let j = n - 1; j > 0 && last.t - samples[j].t <= RECENT_MS; j--) up = Math.max(up, speedAt(samples, j, screenHeight));
  if (up < MIN_SPEED) return null;
  // Anfang des Aufwärtsstrichs: so weit zurück, wie der Finger nach oben (oder kaum nach unten) lief
  let s = n - 1;
  while (s > 0 && samples[s - 1].y >= samples[s].y - 3) s--;
  const dx = last.x - samples[s].x;
  const dy = last.y - samples[s].y;
  const power = Math.min(1, (up - MIN_SPEED) / (FULL_SPEED - MIN_SPEED));
  const yaw = dy < 0 ? Math.max(-MAX_YAW, Math.min(MAX_YAW, -Math.atan2(dx, -dy) * YAW_FACTOR)) : 0;
  return { yaw, power, spin: spinOf(samples.slice(s), screenHeight) };
}

/**
 * Drall aus der Krümmung des Strichs: Richtung der ersten Hälfte gegen die der zweiten.
 * Biegt die Geste nach rechts ab, zieht die Kugel nach rechts (negativer Drall).
 */
function spinOf(stroke: Sample[], screenHeight: number): number {
  if (stroke.length < 5) return 0;
  const a = stroke[0];
  const m = stroke[Math.floor(stroke.length / 2)];
  const b = stroke[stroke.length - 1];
  if (Math.hypot(b.x - a.x, b.y - a.y) < screenHeight * 0.08) return 0;
  const dir = (p: Sample, q: Sample) => Math.atan2(q.x - p.x, p.y - q.y); // 0 = nach oben, + = nach rechts
  let bend = dir(m, b) - dir(a, m);
  bend = Math.atan2(Math.sin(bend), Math.cos(bend));
  if (Math.abs(bend) < MIN_BEND) return 0;
  return Math.max(-1, Math.min(1, -(bend - Math.sign(bend) * MIN_BEND) / FULL_BEND));
}

export class SwipeInput {
  enabled = false;
  private samples: Sample[] = [];
  private active = -1;

  constructor(
    private readonly el: HTMLElement,
    private readonly onPreview: (aim: ThrowInput | null) => void,
    /** Finger aufgesetzt: Anlauf beginnt. */
    private readonly onStart: () => void,
    /** Finger losgelassen = Abwurf; `null`, wenn nicht nach oben gewischt wurde. */
    private readonly onRelease: (input: ThrowInput | null) => void,
    private readonly onTap: () => void,
  ) {
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.cancel);
  }

  dispose(): void {
    this.el.removeEventListener('pointerdown', this.down);
    this.el.removeEventListener('pointermove', this.move);
    this.el.removeEventListener('pointerup', this.up);
    this.el.removeEventListener('pointercancel', this.cancel);
  }

  private down = (e: PointerEvent) => {
    if (!this.enabled) {
      this.onTap();
      return;
    }
    this.active = e.pointerId;
    this.samples = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }];
    this.el.setPointerCapture(e.pointerId);
    this.onStart();
  };

  private move = (e: PointerEvent) => {
    if (e.pointerId !== this.active) return;
    this.samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    if (this.samples.length > 60) this.samples.shift();
    this.onPreview(evaluate(this.samples, this.el.clientHeight));
  };

  private up = (e: PointerEvent) => {
    if (e.pointerId !== this.active) return;
    this.active = -1;
    this.samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    const input = evaluate(this.samples, this.el.clientHeight);
    this.onPreview(null);
    if (this.enabled) this.onRelease(input);
  };

  private cancel = () => {
    if (this.active === -1) return;
    this.active = -1;
    this.onPreview(null);
    if (this.enabled) this.onRelease(null);
  };
}
