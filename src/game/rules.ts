import type { Outcome } from './physics';

/**
 * Spielstand eines Boßel-Duells: zwei Mannschaften, jede mit eigener Kugel. Wer mit weniger
 * Würfen ins Ziel kommt, gewinnt.
 */

export type Order = 'alternate' | 'behind';

export interface TeamSetup {
  name: string;
  color: string;
  players: string[];
}

export interface TeamState {
  setup: TeamSetup;
  s: number;
  d: number;
  throws: number;
  nextPlayer: number;
  finished: boolean;
  ditches: number;
  penalties: number;
  longest: number;
}

export interface ThrowRecord {
  team: number;
  player: string;
  gained: number;
  outcome: Outcome;
}

export interface Match {
  teams: [TeamState, TeamState];
  order: Order;
  current: number;
  history: ThrowRecord[];
}

export function newMatch(teams: [TeamSetup, TeamSetup], order: Order): Match {
  const team = (setup: TeamSetup): TeamState => ({
    setup,
    s: 0,
    d: 0,
    throws: 0,
    nextPlayer: 0,
    finished: false,
    ditches: 0,
    penalties: 0,
    longest: 0,
  });
  return { teams: [team(teams[0]), team(teams[1])], order, current: 0, history: [] };
}

export function currentPlayer(m: Match): string {
  const t = m.teams[m.current];
  const players = t.setup.players.length ? t.setup.players : [t.setup.name];
  return players[t.nextPlayer % players.length];
}

export function isOver(m: Match): boolean {
  return m.teams.every((t) => t.finished);
}

/** Trägt einen Wurf ein und bestimmt, wer als Nächstes dran ist. */
export function recordThrow(m: Match, rest: { s: number; d: number }, gained: number, outcome: Outcome): void {
  const t = m.teams[m.current];
  m.history.push({ team: m.current, player: currentPlayer(m), gained, outcome });
  t.throws++;
  t.nextPlayer++;
  t.s = rest.s;
  t.d = rest.d;
  if (outcome === 'ditch' || outcome === 'out') t.ditches++;
  t.longest = Math.max(t.longest, gained);
  if (outcome === 'finish') t.finished = true;
  m.current = nextTeam(m);
}

function nextTeam(m: Match): number {
  const [a, b] = m.teams;
  if (a.finished && b.finished) return m.current;
  if (a.finished) return 1;
  if (b.finished) return 0;
  if (m.order === 'alternate') return 1 - m.current;
  // Traditionell: wer hinten liegt, wirft; bei Gleichstand die andere Mannschaft
  if (a.s === b.s) return 1 - m.current;
  return a.s < b.s ? 0 : 1;
}

/** Strafwurf, z. B. wenn die Kugel nicht aus dem Graben gefischt wurde. */
export function addPenalty(m: Match, team: number): void {
  m.teams[team].throws++;
  m.teams[team].penalties++;
}

/** Sieger-Index oder `null` bei Gleichstand. */
export function winner(m: Match): number | null {
  const [a, b] = m.teams;
  if (a.throws === b.throws) return null;
  return a.throws < b.throws ? 0 : 1;
}
