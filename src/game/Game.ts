import type { Course } from '../osm/course';
import { pointAt } from '../osm/course';
import { OBSTACLE_NAME, placeObstacles, type Obstacle } from './obstacles';
import { gradeTiming, simulateThrow, type Outcome, type ThrowInput, type TimingGrade } from './physics';
import { addPenalty, currentPlayer, isOver, newMatch, recordThrow, winner, type Match, type Order, type TeamSetup } from './rules';
import type { Assets } from './assets';
import type { Extras } from '../map/MapPicker';
import { saveCourse } from '../storage';
import { sound } from './audio';
import { kescher } from './Kescher';
import { IDEAL_RELEASE, Scene3D } from './Scene3D';
import { SwipeInput } from './SwipeInput';

export interface GameEnd {
  rematch: () => void;
  menu: () => void;
}

const OUTCOME_TEXT: Record<Outcome, string> = {
  road: '',
  verge: 'auf der Bankette',
  ditch: 'Kloot in de Sloot!',
  out: 'Im Aus! Weiter, wo sie die Straße verlassen hat.',
  finish: 'Im Ziel!',
};

const TIMING_TEXT: Record<TimingGrade, string> = {
  perfect: 'perfekt abgeworfen',
  good: '',
  early: 'zu früh – Aufsetzer',
  late: 'zu spät – Bogenlampe',
};
/** So weit läuft der Timing-Balken über den idealen Moment hinaus (Sekunden). */
const TIMING_AFTER = 0.45;

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
  private readonly obstacles: Obstacle[];
  private readonly timingBar: HTMLElement;
  private lastAim: ThrowInput | null = null;
  private readonly onResize = () => {
    this.scene.resize();
    this.drawMinimap();
  };

  constructor(
    host: HTMLElement,
    private readonly course: Course,
    teams: [TeamSetup, TeamSetup],
    order: Order,
    assets: Assets,
    private readonly end: GameEnd,
    extras?: Promise<Extras>,
  ) {
    this.match = newMatch(teams, order);
    // Im Dev-Modus lässt sich die Dichte per ?hindernisse=200 hochdrehen (zum Ansehen)
    const density = import.meta.env.DEV ? Number(new URLSearchParams(location.search).get('hindernisse')) || undefined : undefined;
    this.obstacles = placeObstacles(course, (Math.random() * 2 ** 31) | 0, density);
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
    this.hint = el('div', 'hint', 'Halten = Anlauf · im Grünen hochwischen');
    this.toast = el('div', 'toast');
    this.minimap = el('canvas', 'minimap');
    // Timing-Balken: Marker läuft beim Anlauf durch, grün = idealer Abwurfmoment
    this.timingBar = el('div', 'timing');
    this.timingBar.append(el('div', 'timing-zone'), el('div', 'timing-marker'));
    this.timingBar.style.setProperty('--ideal', String(IDEAL_RELEASE / (IDEAL_RELEASE + TIMING_AFTER)));
    this.root.append(this.turnLabel, this.hint, this.toast, this.minimap, this.timingBar);
    host.append(this.root);

    this.scene = new Scene3D(canvas, course, assets, [teams[0].color, teams[1].color]);
    this.scene.setObstacles(this.obstacles);
    this.scene.hideBall(0, true);
    this.scene.hideBall(1, true);
    this.input = new SwipeInput(
      canvas,
      (aim) => {
        this.scene.preview(aim);
        if (aim) this.lastAim = aim;
      },
      () => this.startRunup(),
      (input) => this.onRelease(input),
      () => this.scene.fastForward(),
    );
    window.addEventListener('resize', this.onResize);
    // Für automatische Tests: Wurf ohne Wischgeste auslösen
    if (import.meta.env.DEV) {
      const w = window as unknown as { boselThrow: (i: ThrowInput) => void; boselKescher: () => Promise<boolean> };
      w.boselThrow = (i) => this.input.enabled && this.throwBall(i);
      w.boselKescher = () => kescher(this.root, teams[0].color);
    }
    this.updateHud();
    canvas.addEventListener('pointerdown', () => sound.unlock());
    // Bäume und Hecken kommen im Hintergrund nach – dann wachsen sie in die Landschaft
    extras?.then(
      ({ trees, hedges }) => {
        if (this.disposed || (!trees.length && !hedges.length)) return;
        this.scene.addExtras(trees, hedges);
        course.trees = [...(course.trees ?? []), ...trees];
        course.hedges = [...(course.hedges ?? []), ...hedges];
        saveCourse(course);
      },
      (e) => console.warn('Bäume/Hecken nicht geladen', e),
    );
    this.turnLabel.innerHTML = '';
    this.turnLabel.append(course.name, el('small', '', ' · antippen zum Starten'));
    this.drawMinimap();
    this.turnLabel.classList.add('show');
    this.scene.intro(() => this.nextTurn());
  }

  private disposed = false;

  dispose(): void {
    this.disposed = true;
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

  private startRunup(): void {
    this.lastAim = null;
    this.turnLabel.classList.remove('show');
    this.hint.classList.remove('show');
    this.scene.startRunup(() => this.onRelease(this.lastAim ?? { yaw: 0, power: 0.15 }));
    this.timingBar.classList.add('show');
    const tick = () => {
      const t = this.scene.releaseTiming();
      if (t === null || !this.timingBar.classList.contains('show')) return;
      // Anzeige von Anlaufbeginn bis kurz nach dem Schwung
      const k = Math.max(0, Math.min(1, (t + IDEAL_RELEASE) / (IDEAL_RELEASE + TIMING_AFTER)));
      (this.timingBar.lastElementChild as HTMLElement).style.left = `${k * 100}%`;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** Finger los (oder zu lange gehalten): jetzt wird geworfen – oder abgebrochen. */
  private onRelease(input: ThrowInput | null): void {
    const timing = this.scene.releaseTiming();
    // Kein gültiges Wischen beim Loslassen, aber vorher gezielt: dann gilt der gezeigte Pfeil
    input ??= this.lastAim;
    this.timingBar.classList.remove('show');
    if (timing === null) return;
    // Losgelassen, bevor überhaupt ausgeholt wurde und ohne Wischen: zurück an den Start
    if (!input && timing < -0.35) {
      this.scene.cancelRunup();
      this.turnLabel.classList.add('show');
      this.hint.classList.add('show');
      return;
    }
    this.throwBall(input ?? { yaw: 0, power: 0.15 }, timing);
  }

  private throwBall(input: ThrowInput, timing = 0): void {
    const m = this.match;
    const team = m.current;
    const t = m.teams[team];
    this.input.enabled = false;
    this.turnLabel.classList.remove('show');
    this.hint.classList.remove('show');
    const grade = gradeTiming(timing);
    const result = simulateThrow(this.course, t, { ...input, release: timing }, (Math.random() * 2 ** 31) | 0, this.obstacles);
    const done = () => {
      recordThrow(m, result.rest, result.gained, result.outcome);
      this.scene.setBall(team, result.rest);
      this.scene.hideBall(team, false);
      const meters = `${Math.round(result.gained)} m`;
      const kinds = [...new Set(result.hits.map((h) => OBSTACLE_NAME[h.kind]))];
      const extra = [TIMING_TEXT[grade], kinds.join(', '), OUTCOME_TEXT[result.outcome]].filter(Boolean).join(' · ');
      this.showToast(result.outcome === 'finish' ? `Im Ziel nach ${t.throws} Würfen!` : extra ? `${meters} · ${extra}` : meters, result.outcome);
      this.updateHud();
      const next = () => {
        this.updateHud();
        if (isOver(m)) setTimeout(() => this.showResult(), 1800);
        else setTimeout(() => this.nextTurn(), 1500);
      };
      if (result.outcome === 'finish') sound.fanfare();
      if (result.outcome !== 'ditch') return next();
      // Kugel im Graben: rausfischen oder Strafwurf
      setTimeout(async () => {
        const caught = await kescher(this.root, t.setup.color);
        if (!caught) {
          addPenalty(m, team);
          this.showToast(`Strafwurf für ${t.setup.name}`, 'ditch');
        }
        next();
      }, 1400);
    };
    // Dev-Hook: ohne Finger läuft der Anlauf von selbst bis zum idealen Moment
    if (this.scene.releaseTiming() === null) this.scene.playThrow(result, input.power, done);
    else this.scene.release(result, input.power, done);
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
    const mute = el('button', 'btn', sound.enabled ? 'Ton aus' : 'Ton an');
    mute.addEventListener('click', () => {
      sound.setEnabled(!sound.enabled);
      mute.textContent = sound.enabled ? 'Ton aus' : 'Ton an';
    });
    const restart = el('button', 'btn', 'Neu starten');
    restart.addEventListener('click', () => this.end.rematch());
    const quit = el('button', 'btn', 'Zum Hauptmenü');
    quit.addEventListener('click', () => this.end.menu());
    box.append(resume, mute, restart, quit);
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
    row('Strafwürfe', (i) => `${m.teams[i].penalties}`);
    box.append(el('p', 'muted', `${this.course.name} · ${(this.course.length / 1000).toFixed(2)} km`), table);
    const again = el('button', 'btn primary', 'Revanche');
    again.addEventListener('click', () => this.end.rematch());
    const menu = el('button', 'btn', 'Hauptmenü');
    menu.addEventListener('click', () => this.end.menu());
    box.append(again, menu);
    o.append(box);
  }
}
