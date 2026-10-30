import type { Course } from '../osm/course';
import { pointAt } from '../osm/course';
import { simulateThrow, type Outcome, type ThrowInput } from './physics';
import { currentPlayer, isOver, newMatch, recordThrow, winner, type Match, type Order, type TeamSetup } from './rules';
import { Scene3D } from './Scene3D';
import { SwipeInput } from './SwipeInput';

export interface GameEnd {
  rematch: () => void;
  menu: () => void;
}

const OUTCOME_TEXT: Record<Outcome, string> = {
  road: '',
  verge: 'auf der Bankette',
  ditch: 'Im Graben! Weiter, wo sie die Straße verlassen hat.',
  out: 'Im Aus! Weiter, wo sie die Straße verlassen hat.',
  finish: 'Im Ziel!',
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Eine Partie auf einer Strecke: 3D-Ansicht, Anzeige, Minikarte und Wurfsteuerung. */
export class Game {
  private readonly root: HTMLElement;
  private readonly scene: Scene3D;
  private readonly input: SwipeInput;
  private readonly match: Match;
  private readonly teamCards: HTMLElement[] = [];
  private readonly turnLabel: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly minimap: HTMLCanvasElement;
  private readonly onResize = () => {
    this.scene.resize();
    this.drawMinimap();
  };

  constructor(
    host: HTMLElement,
    private readonly course: Course,
    teams: [TeamSetup, TeamSetup],
    order: Order,
    private readonly end: GameEnd,
  ) {
    this.match = newMatch(teams, order);
    this.root = el('div', 'game');
    const canvas = el('canvas', 'game-canvas');
    this.root.append(canvas);

    const top = el('div', 'hud-top');
    for (const t of this.match.teams) {
      const card = el('div', 'team-card');
      card.style.setProperty('--team', t.setup.color);
      top.append(card);
      this.teamCards.push(card);
    }
    const menu = el('button', 'hud-menu', '☰');
    menu.title = 'Menü';
    menu.addEventListener('click', () => this.openMenu());
    top.append(menu);
    this.root.append(top);

    this.turnLabel = el('div', 'turn-label');
    this.hint = el('div', 'hint', 'Nach oben wischen zum Werfen');
    this.toast = el('div', 'toast');
    this.minimap = el('canvas', 'minimap');
    this.root.append(this.turnLabel, this.hint, this.toast, this.minimap);
    host.append(this.root);

    this.scene = new Scene3D(canvas, course, [teams[0].color, teams[1].color]);
    this.scene.hideBall(0, true);
    this.scene.hideBall(1, true);
    this.input = new SwipeInput(
      canvas,
      (aim) => this.scene.preview(aim),
      (input) => this.throwBall(input),
      () => this.scene.fastForward(),
    );
    window.addEventListener('resize', this.onResize);
    // Für automatische Tests: Wurf ohne Wischgeste auslösen
    if (import.meta.env.DEV) (window as unknown as { boselThrow: (i: ThrowInput) => void }).boselThrow = (i) => this.input.enabled && this.throwBall(i);
    this.updateHud();
    this.nextTurn();
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    this.scene.dispose();
    this.root.remove();
  }

  private nextTurn(): void {
    const m = this.match;
    const t = m.teams[m.current];
    this.scene.aim(m.current, t.setup.color, t);
    this.turnLabel.innerHTML = '';
    const dot = el('span', 'dot');
    dot.style.background = t.setup.color;
    this.turnLabel.append(dot, `${currentPlayer(m)} wirft`);
    if (t.setup.players.length) this.turnLabel.append(el('small', '', ` · ${t.setup.name}`));
    this.turnLabel.classList.add('show');
    this.hint.classList.toggle('show', m.history.length < 2);
    this.input.enabled = true;
    this.drawMinimap();
  }

  private throwBall(input: ThrowInput): void {
    const m = this.match;
    const team = m.current;
    const t = m.teams[team];
    this.input.enabled = false;
    this.turnLabel.classList.remove('show');
    this.hint.classList.remove('show');
    const result = simulateThrow(this.course, t, input, (Math.random() * 2 ** 31) | 0);
    this.scene.playThrow(result, () => {
      recordThrow(m, result.rest, result.gained, result.outcome);
      this.scene.setBall(team, result.rest);
      this.scene.hideBall(team, false);
      const meters = `${Math.round(result.gained)} m`;
      const extra = OUTCOME_TEXT[result.outcome];
      this.showToast(result.outcome === 'finish' ? `Im Ziel nach ${t.throws} Würfen!` : extra ? `${meters} · ${extra}` : meters, result.outcome);
      this.updateHud();
      if (isOver(m)) setTimeout(() => this.showResult(), 1800);
      else setTimeout(() => this.nextTurn(), 1500);
    });
  }

  private showToast(text: string, outcome: Outcome): void {
    this.toast.textContent = text;
    this.toast.className = `toast show ${outcome}`;
    clearTimeout((this.toast as HTMLElement & { timer?: number }).timer);
    (this.toast as HTMLElement & { timer?: number }).timer = window.setTimeout(() => this.toast.classList.remove('show'), 2200);
  }

  private updateHud(): void {
    const m = this.match;
    const [a, b] = m.teams;
    m.teams.forEach((t, i) => {
      const card = this.teamCards[i];
      const left = Math.max(0, Math.round(this.course.length - t.s));
      const other = m.teams[1 - i];
      const lead = Math.round(t.s - other.s);
      card.innerHTML = '';
      card.append(
        el('div', 'team-name', t.setup.name),
        el('div', 'team-throws', `${t.throws}`),
        el('div', 'team-sub', t.finished ? 'im Ziel' : `noch ${left} m`),
      );
      if (!t.finished && !other.finished && lead > 0 && (a.throws || b.throws)) card.append(el('div', 'team-lead', `+${lead} m`));
      card.classList.toggle('active', m.current === i && !isOver(m));
    });
  }

  private drawMinimap(): void {
    const c = this.minimap;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const size = c.clientWidth || 140;
    c.width = c.height = size * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const pts = this.course.points;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const pad = 10;
    const scale = (size - 2 * pad) / Math.max(maxX - minX, maxY - minY, 1);
    const ox = pad + (size - 2 * pad - (maxX - minX) * scale) / 2;
    const oy = pad + (size - 2 * pad - (maxY - minY) * scale) / 2;
    const tx = (x: number) => ox + (x - minX) * scale;
    const ty = (y: number) => size - (oy + (y - minY) * scale);
    ctx.clearRect(0, 0, size, size);
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(tx(p.x), ty(p.y)) : ctx.moveTo(tx(p.x), ty(p.y))));
    ctx.stroke();
    const end = pts[pts.length - 1];
    ctx.fillStyle = '#c8102e';
    ctx.fillRect(tx(end.x) - 4, ty(end.y) - 4, 8, 8);
    this.match.teams.forEach((t) => {
      const p = pointAt(this.course, t.s).p;
      ctx.fillStyle = t.setup.color;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(tx(p.x), ty(p.y), 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
  }

  private overlay(): HTMLElement {
    const o = el('div', 'overlay');
    this.root.append(o);
    return o;
  }

  private openMenu(): void {
    const o = this.overlay();
    const box = el('div', 'panel');
    box.append(el('h2', '', 'Pause'));
    const resume = el('button', 'btn primary', 'Weiterspielen');
    resume.addEventListener('click', () => o.remove());
    const restart = el('button', 'btn', 'Neu starten');
    restart.addEventListener('click', () => this.end.rematch());
    const quit = el('button', 'btn', 'Zum Hauptmenü');
    quit.addEventListener('click', () => this.end.menu());
    box.append(resume, restart, quit);
    o.append(box);
  }

  private showResult(): void {
    const m = this.match;
    const w = winner(m);
    const o = this.overlay();
    const box = el('div', 'panel result');
    box.append(el('h2', '', w === null ? 'Unentschieden!' : `${m.teams[w].setup.name} gewinnt!`));
    const table = el('table');
    const row = (label: string, f: (i: number) => string) => {
      const tr = el('tr');
      tr.append(el('th', '', label), el('td', '', f(0)), el('td', '', f(1)));
      table.append(tr);
    };
    const head = el('tr');
    head.append(el('th'));
    m.teams.forEach((t) => {
      const th = el('th', '', t.setup.name);
      th.style.color = t.setup.color;
      head.append(th);
    });
    table.append(head);
    row('Würfe', (i) => `${m.teams[i].throws}`);
    row('Weitester Wurf', (i) => `${Math.round(m.teams[i].longest)} m`);
    row('Im Graben', (i) => `${m.teams[i].ditches}`);
    box.append(el('p', 'muted', `${this.course.name} · ${(this.course.length / 1000).toFixed(2)} km`), table);
    const again = el('button', 'btn primary', 'Revanche');
    again.addEventListener('click', () => this.end.rematch());
    const menu = el('button', 'btn', 'Hauptmenü');
    menu.addEventListener('click', () => this.end.menu());
    box.append(again, menu);
    o.append(box);
  }
}
