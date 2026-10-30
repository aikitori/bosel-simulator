import type { ThrowInput } from './physics';

/**
 * Wurf per Touch: Finger aufsetzen startet den Anlauf, im richtigen Moment nach oben schnippen
 * und loslassen. Tempo der Geste = Kraft, seitliche Abweichung = Richtung, Zeitpunkt des
 * Loslassens = Abwurfwinkel. Ausgewertet werden nur die letzten Millisekunden vor dem Loslassen.
 */

interface Sample {
  x: number;
  y: number;
  t: number;
}

const WINDOW_MS = 110;
/** Bildschirmhöhen pro Sekunde für volle Kraft. */
const FULL_SPEED = 4.2;
const MIN_SPEED = 0.5;
const YAW_FACTOR = 0.32;
const MAX_YAW = 0.6;

export function evaluate(samples: Sample[], screenHeight: number): ThrowInput | null {
  if (samples.length < 2) return null;
  const last = samples[samples.length - 1];
  let first = samples[samples.length - 2];
  for (let i = samples.length - 2; i >= 0; i--) {
    first = samples[i];
    if (last.t - samples[i].t >= WINDOW_MS) break;
  }
  const dt = Math.max(1, last.t - first.t);
  const vx = (last.x - first.x) / dt;
  const vy = (last.y - first.y) / dt;
  const up = (-vy * 1000) / screenHeight;
  if (up < MIN_SPEED) return null;
  const power = Math.min(1, (up - MIN_SPEED) / (FULL_SPEED - MIN_SPEED));
  const yaw = Math.max(-MAX_YAW, Math.min(MAX_YAW, -Math.atan2(vx, -vy) * YAW_FACTOR));
  return { yaw, power };
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
