import { describe, expect, it } from 'vitest';
import { addPenalty, currentPlayer, decidedEarly, isOver, newMatch, recordThrow, winner, type TeamSetup } from '../src/game/rules';

const teams = (): [TeamSetup, TeamSetup] => [
  { name: 'Rot', color: '#d33', players: ['Anna', 'Ben'] },
  { name: 'Blau', color: '#33d', players: [] },
];

describe('Spielregeln', () => {
  it('wechselt ab und reicht die Kugel innerhalb der Mannschaft weiter', () => {
    const m = newMatch(teams(), 'alternate');
    expect(currentPlayer(m)).toBe('Anna');
    recordThrow(m, { s: 80, d: 0 }, 80, 'road');
    expect(m.current).toBe(1);
    expect(currentPlayer(m)).toBe('Blau');
    recordThrow(m, { s: 120, d: 0 }, 120, 'road');
    expect(currentPlayer(m)).toBe('Ben');
  });

  it('traditionell wirft, wer hinten liegt', () => {
    const m = newMatch(teams(), 'behind');
    recordThrow(m, { s: 80, d: 0 }, 80, 'road');
    recordThrow(m, { s: 50, d: 0 }, 50, 'ditch');
    expect(m.current).toBe(1);
    expect(m.teams[1].ditches).toBe(1);
  });

  it('wer im Ziel ist, setzt aus; weniger Würfe gewinnt', () => {
    const m = newMatch(teams(), 'alternate');
    recordThrow(m, { s: 100, d: 0 }, 100, 'finish');
    recordThrow(m, { s: 60, d: 0 }, 60, 'road');
    expect(m.current).toBe(1);
    recordThrow(m, { s: 100, d: 0 }, 40, 'finish');
    expect(isOver(m)).toBe(true);
    expect(winner(m)).toBe(0);
  });

  it('endet vorzeitig, wenn die zweite Mannschaft nicht mehr gewinnen kann', () => {
    const m = newMatch(teams(), 'alternate');
    recordThrow(m, { s: 100, d: 0 }, 100, 'finish');
    expect(isOver(m)).toBe(false);
    recordThrow(m, { s: 40, d: 0 }, 40, 'road');
    // Gleich viele Würfe, aber noch nicht im Ziel: verloren, ohne weiterwerfen zu müssen
    expect(isOver(m)).toBe(true);
    expect(decidedEarly(m)).toBe(true);
    expect(winner(m)).toBe(0);
  });

  it('ein Strafwurf kann die Partie entscheiden', () => {
    const m = newMatch(teams(), 'alternate');
    recordThrow(m, { s: 50, d: 0 }, 50, 'road');
    recordThrow(m, { s: 30, d: 0 }, 30, 'ditch');
    recordThrow(m, { s: 100, d: 0 }, 50, 'finish');
    expect(isOver(m)).toBe(false);
    addPenalty(m, 1);
    expect(isOver(m)).toBe(true);
  });
});
