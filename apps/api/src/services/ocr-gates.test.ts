import { describe, expect, it } from 'vitest';
import { classifierGates, gates, trialGate, type EvalLike, type SliceLike } from './ocr-gates.js';

const s = (slice: string, accuracy: number, n = 100, confidentAccuracy: number | null = null, confident = 0): SliceLike => ({ slice, n, accuracy, confidentAccuracy, confident });
const ev = (slices: SliceLike[], o: Partial<EvalLike> = {}): EvalLike => ({ id: 'x', engine: 'e', examVersion: 3, status: 'done', summary: { msPerLine: 20 }, slices, ...o });

const champion = ev([
  s('all · name', 0.7), s('all · number', 0.6),
  s('game pokemon · name', 0.7), s('game magic · name', 0.8, 40),
  s('regression set · name', 0, 10), s('regression set · number', 0, 5),
], { summary: { msPerLine: 120 } });

const pass = (g: ReturnType<typeof gates>) => g.length > 0 && g.every((x) => x.pass);

describe('promotion gates', () => {
  it('a better engine on every count passes', () => {
    const c = ev([
      s('all · name', 0.9, 100, 0.99, 50), s('all · number', 0.85),
      s('game pokemon · name', 0.92), s('game magic · name', 0.82, 40),
      s('regression set · name', 0.8, 10), s('regression set · number', 0.6, 5),
    ]);
    expect(pass(gates(c, champion))).toBe(true);
  });

  it('better on average but worse on one game is refused', () => {
    const c = ev([s('all · name', 0.9), s('all · number', 0.85), s('game pokemon · name', 0.95), s('game magic · name', 0.7, 40), s('regression set · name', 0.5, 10), s('regression set · number', 0.5, 5)]);
    const g = gates(c, champion);
    expect(pass(g)).toBe(false);
    expect(g.find((x) => x.id === 'slices')!.detail).toMatch(/magic/);
  });

  it('losing a misread a person fixed is refused', () => {
    const champ2 = ev([s('all · name', 0.7), s('all · number', 0.6), s('regression set · name', 0.9, 10)], { summary: { msPerLine: 100 } });
    const c = ev([s('all · name', 0.9), s('all · number', 0.9), s('regression set · name', 0.8, 10)]);
    expect(gates(c, champ2).find((x) => x.id === 'regression-name')!.pass).toBe(false);
  });

  it('overconfident engines are refused', () => {
    const c = ev([s('all · name', 0.9, 100, 0.85, 60), s('all · number', 0.9), s('regression set · name', 1, 10), s('regression set · number', 1, 5)]);
    expect(gates(c, champion).find((x) => x.id === 'confidence-name')!.pass).toBe(false);
  });

  it('too slow is refused', () => {
    const c = ev([s('all · name', 0.9), s('all · number', 0.9), s('regression set · name', 1, 10), s('regression set · number', 1, 5)], { summary: { msPerLine: 400 } });
    expect(gates(c, champion).find((x) => x.id === 'speed')!.pass).toBe(false);
  });

  it('needs the current engine scored on the same exam version', () => {
    const c = ev([s('all · name', 0.99)]);
    expect(pass(gates(c, null))).toBe(false);
    expect(pass(gates(c, { ...champion, examVersion: 2 }))).toBe(false);
    expect(pass(gates({ ...c, status: 'running' }, champion))).toBe(false);
  });
});

describe('live trial gate', () => {
  const t = (lines: number, live: number, shadow: number, wins: number, losses: number) => ({ lines, liveAccuracy: live, shadowAccuracy: shadow, wins, losses });
  it('needs enough confirmed lines', () => {
    expect(trialGate(null, 40)!.pass).toBe(false);
    expect(trialGate(t(10, 0.5, 0.9, 4, 0), 40)!.pass).toBe(false);
  });
  it('passes when at least as good and not losing more than winning', () => {
    expect(trialGate(t(50, 0.7, 0.9, 12, 2), 40)!.pass).toBe(true);
  });
  it('fails when worse live, or losing more lines than it wins', () => {
    expect(trialGate(t(50, 0.9, 0.85, 3, 5), 40)!.pass).toBe(false);
    expect(trialGate(t(50, 0.8, 0.8, 2, 3), 40)!.pass).toBe(false);
  });
  it('can be turned off', () => {
    expect(trialGate(null, 0)).toBeNull();
  });
});

describe('game classifier gates', () => {
  const card = (accuracy: number, n = 100, o: Partial<EvalLike> = {}) => ev([s('all · game', accuracy, n)], o);

  it('passes a scored classifier when nothing is routing yet', () => {
    const g = classifierGates(card(0.88), null);
    expect(g.map((x) => x.id)).toEqual(['game-overall']);
    expect(g[0]!.pass).toBe(true);
    expect(g[0]!.detail).toContain('88.0% of 100 cards');
    expect(g[0]!.detail).toContain('nothing to compare with yet');
  });

  it('requires a score first', () => {
    expect(classifierGates(null, null)[0]).toMatchObject({ id: 'scored', pass: false });
    expect(classifierGates(card(0.9, 100, { status: 'running' }), null)[0]).toMatchObject({ id: 'scored', pass: false });
  });

  it('asks for a re-score when the row has no games slice (a line-reader score)', () => {
    const wrongKind = ev([s('all · name', 0.9), s('all · number', 0.8)]);
    expect(classifierGates(wrongKind, null)[0]).toMatchObject({ id: 'scored', pass: false });
  });

  it('lets half a point of noise through, not a real drop', () => {
    expect(classifierGates(card(0.875), card(0.88))[0]!.pass).toBe(true);
    expect(classifierGates(card(0.86), card(0.88))[0]!.pass).toBe(false);
  });

  it('says which exam it was scored on when it is not the active one', () => {
    const g = classifierGates(card(0.95, 100, { examVersion: 2 }), card(0.8, 100, { examVersion: 3 }));
    expect(g.map((x) => x.id)).toEqual(['game-overall', 'same-exam']);
    expect(g.every((x) => !x.pass)).toBe(false);
    expect(g.find((x) => x.id === 'same-exam')!.pass).toBe(false);
  });

  it('never asks for a live trial: a classifier runs beside the reader', () => {
    expect(classifierGates(card(0.9), null).map((x) => x.id)).not.toContain('trial');
  });
});
