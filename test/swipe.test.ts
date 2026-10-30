import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/game/SwipeInput';

/** Gerader Strich von (x0,y0) nach (x1,y1) in `ms` Millisekunden, danach `pause` ms stillhalten. */
const stroke = (x0: number, y0: number, x1: number, y1: number, ms: number, pause = 0) => {
  const out = [];
  for (let i = 0; i <= 10; i++) out.push({ x: x0 + ((x1 - x0) * i) / 10, y: y0 + ((y1 - y0) * i) / 10, t: (ms * i) / 10 });
  if (pause) out.push({ x: x1, y: y1, t: ms + pause });
  return out;
};

describe('Wischgeste', () => {
  it('schräg nach rechts oben wirft nach rechts (negativer Winkel)', () => {
    const r = evaluate(stroke(200, 800, 300, 500, 150), 900)!;
    expect(r.yaw).toBeLessThan(-0.1);
    expect(r.power).toBeGreaterThan(0.3);
  });

  it('kurzes Innehalten vor dem Loslassen kostet weder Kraft noch Richtung', () => {
    const quick = evaluate(stroke(200, 800, 120, 500, 150), 900)!;
    const paused = evaluate(stroke(200, 800, 120, 500, 150, 120), 900)!;
    expect(paused.yaw).toBeCloseTo(quick.yaw, 5);
    expect(paused.power).toBeCloseTo(quick.power, 1);
    expect(paused.yaw).toBeGreaterThan(0.1);
  });

  it('langsames Schieben ist kein Wurf', () => {
    expect(evaluate(stroke(200, 800, 200, 780, 600), 900)).toBeNull();
  });

  it('ein nach rechts gebogener Strich gibt Rechtsdrall', () => {
    // erst gerade hoch, dann nach rechts abbiegen
    const pts = [];
    for (let i = 0; i <= 10; i++) pts.push({ x: 200, y: 800 - i * 20, t: i * 8 });
    for (let i = 1; i <= 10; i++) pts.push({ x: 200 + i * 12, y: 600 - i * 16, t: 80 + i * 8 });
    const r = evaluate(pts, 900)!;
    expect(r.spin).toBeLessThan(-0.2);
  });

  it('ein gerader Strich hat keinen Drall', () => {
    expect(evaluate(stroke(200, 800, 260, 450, 150), 900)!.spin).toBe(0);
  });
});
