import { describe, expect, it } from 'vitest';
import { gates, type EvalLike, type SliceLike } from './ocr-gates.js';

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
