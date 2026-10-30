/**
 * Minispiel „Kloot in de Sloot“: Die Kugel liegt im Graben und treibt mit der Strömung.
 * Mit dem Kescher (Finger) folgen und loslassen, um zu fischen. Taucht die Kugel gerade ab,
 * geht der Kescher ins Leere. Drei Versuche, zehn Sekunden.
 */

const TIME = 10;
const TRIES = 3;
const NET_RADIUS = 46;
const BALL_RADIUS = 17;
/** Kescher sitzt etwas über dem Finger, damit man ihn sieht. */
const FINGER_OFFSET = 70;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

interface Weed {
  x: number;
  y: number;
  r: number;
}

/** Startet das Minispiel; liefert `true`, wenn die Kugel gefischt wurde. */
export function kescher(host: HTMLElement, ballColor: string): Promise<boolean> {
  return new Promise((resolve) => {
    const root = el('div', 'kescher');
    const head = el('div', 'kescher-head');
    head.append(el('h2', '', 'Kloot in de Sloot!'), el('p', '', 'Kescher mit dem Finger führen, loslassen zum Fischen.'));
    const status = el('div', 'kescher-status');
    const canvas = el('canvas', 'kescher-canvas');
    root.append(head, canvas, status);
    host.append(root);

    const ctx = canvas.getContext('2d')!;
    const dpr = Math.min(window.devicePixelRatio, 2);
    let W = 0;
    let H = 0;
    const resize = () => {
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    // Wasser liegt in der Mitte, Ufer oben und unten
    const bank = () => H * 0.16;
    const flow = 45 + Math.random() * 35;
    const ball = { x: W * 0.3, y: H * 0.5, vx: flow, vy: (Math.random() - 0.5) * 60, under: 0, nextDive: 1.5 + Math.random() * 1.5, phase: 0 };
    const weeds: Weed[] = Array.from({ length: 40 }, () => ({ x: Math.random() * W, y: bank() + Math.random() * (H - 2 * bank()), r: 2 + Math.random() * 4 }));
    const net = { x: W * 0.5, y: H * 0.7, down: false, dip: 0 };
    let tries = TRIES;
    let left = TIME;
    let done = false;
    let splash: { x: number; y: number; t: number }[] = [];

    const setStatus = () => {
      status.innerHTML = '';
      const bar = el('div', 'kescher-time');
      const fill = el('div');
      fill.style.width = `${(left / TIME) * 100}%`;
      bar.append(fill);
      status.append(bar, el('span', '', `Versuche: ${'●'.repeat(tries)}${'○'.repeat(TRIES - tries)}`));
    };
    setStatus();

    const finish = (caught: boolean) => {
      if (done) return;
      done = true;
      head.innerHTML = '';
      head.append(el('h2', '', caught ? 'Gefischt!' : 'Kugel verloren'), el('p', '', caught ? 'Weiter ohne Strafe.' : 'Das kostet einen Strafwurf.'));
      root.classList.add(caught ? 'won' : 'lost');
      setTimeout(() => {
        window.removeEventListener('resize', resize);
        root.remove();
        resolve(caught);
      }, 1500);
    };

    const pos = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      net.x = e.clientX - r.left;
      net.y = Math.max(NET_RADIUS, e.clientY - r.top - FINGER_OFFSET);
    };
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      net.down = true;
      pos(e);
    });
    canvas.addEventListener('pointermove', (e) => net.down && pos(e));
    canvas.addEventListener('pointerup', () => {
      if (!net.down || done) return;
      net.down = false;
      net.dip = 0.35;
      const d = Math.hypot(ball.x - net.x, ball.y - net.y);
      if (ball.under <= 0 && d < NET_RADIUS - BALL_RADIUS * 0.3) {
        ball.x = net.x;
        ball.y = net.y;
        finish(true);
        return;
      }
      splash.push({ x: net.x, y: net.y, t: 0 });
      tries--;
      setStatus();
      if (tries <= 0) finish(false);
    });

    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!done) {
        left -= dt;
        if (left <= 0) {
          left = 0;
          finish(false);
        }
        setStatusThrottled();
        // Strömung, Schaukeln, an den Ufern abprallen
        ball.phase += dt;
        ball.vy += Math.sin(ball.phase * 2.3) * 40 * dt;
        ball.x += ball.vx * dt;
        ball.y += ball.vy * dt;
        if (ball.y < bank() + BALL_RADIUS || ball.y > H - bank() - BALL_RADIUS) {
          ball.vy = -ball.vy * 0.8;
          ball.y = Math.max(bank() + BALL_RADIUS, Math.min(H - bank() - BALL_RADIUS, ball.y));
        }
        if (ball.x > W + BALL_RADIUS) ball.x = -BALL_RADIUS;
        // ab und zu abtauchen
        if (ball.under > 0) ball.under -= dt;
        else if ((ball.nextDive -= dt) <= 0) {
          ball.under = 0.6 + Math.random() * 0.6;
          ball.nextDive = 1.8 + Math.random() * 1.8;
        }
      }
      net.dip = Math.max(0, net.dip - dt);
      for (const w of weeds) {
        w.x += flow * 0.9 * dt;
        if (w.x > W + 5) w.x = -5;
      }
      splash = splash.filter((s) => (s.t += dt) < 0.6);
      draw();
      if (root.isConnected) requestAnimationFrame(tick);
    };
    let statusTimer = 0;
    const setStatusThrottled = () => {
      if (++statusTimer % 6 === 0) setStatus();
    };

    const draw = () => {
      const b = bank();
      ctx.fillStyle = '#6f9a4a';
      ctx.fillRect(0, 0, W, H);
      // Wasser mit dunklerer Mitte
      const g = ctx.createLinearGradient(0, b, 0, H - b);
      g.addColorStop(0, '#4f7a6c');
      g.addColorStop(0.5, '#2f5450');
      g.addColorStop(1, '#4f7a6c');
      ctx.fillStyle = g;
      ctx.fillRect(0, b, W, H - 2 * b);
      // Schilf an den Ufern
      ctx.strokeStyle = '#4c7a32';
      ctx.lineWidth = 2;
      for (let x = 4; x < W; x += 9) {
        ctx.beginPath();
        ctx.moveTo(x, b + 2);
        ctx.lineTo(x + 3, b - 14 - ((x * 7) % 10));
        ctx.moveTo(x + 4, H - b - 2);
        ctx.lineTo(x + 1, H - b + 14 + ((x * 5) % 10));
        ctx.stroke();
      }
      // Strömungslinien
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      const t = performance.now() / 1000;
      for (let i = 0; i < 8; i++) {
        const y = b + ((i + 0.5) / 8) * (H - 2 * b);
        const off = ((t * flow + i * 53) % 120) - 120;
        for (let x = off; x < W; x += 120) {
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + 40, y);
          ctx.stroke();
        }
      }
      // Entengrütze
      ctx.fillStyle = '#8fbf4a';
      for (const w of weeds) {
        ctx.beginPath();
        ctx.arc(w.x, w.y, w.r, 0, Math.PI * 2);
        ctx.fill();
      }
      // Kugel (abgetaucht: blass und kleiner)
      const sub = ball.under > 0 ? Math.min(1, ball.under * 4) : 0;
      ctx.globalAlpha = 1 - sub * 0.8;
      ctx.fillStyle = ballColor;
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, BALL_RADIUS * (1 - sub * 0.25), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath();
      ctx.arc(ball.x - 5, ball.y - 5, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      // Spritzer
      for (const s of splash) {
        ctx.strokeStyle = `rgba(220,240,255,${1 - s.t / 0.6})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 10 + s.t * 90, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Kescher: Stiel zur Ecke, Ring mit Netz
      const scale = 1 - net.dip * 0.6;
      const r = NET_RADIUS * scale;
      ctx.strokeStyle = '#8a6a3a';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(net.x + r * 0.7, net.y + r * 0.7);
      ctx.lineTo(W + 20, H + 20);
      ctx.stroke();
      ctx.save();
      ctx.beginPath();
      ctx.arc(net.x, net.y, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(net.x - r, net.y - r, 2 * r, 2 * r);
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      for (let k = -r; k < r; k += 8) {
        ctx.beginPath();
        ctx.moveTo(net.x + k, net.y - r);
        ctx.lineTo(net.x + k, net.y + r);
        ctx.moveTo(net.x - r, net.y + k);
        ctx.lineTo(net.x + r, net.y + k);
        ctx.stroke();
      }
      ctx.restore();
      ctx.strokeStyle = net.down ? '#ffd23f' : '#d8d2c0';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(net.x, net.y, r, 0, Math.PI * 2);
      ctx.stroke();
    };
    requestAnimationFrame(tick);
  });
}
