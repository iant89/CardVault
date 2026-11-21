import { describe, expect, it } from 'vitest';
import { scoreCandidates, type Candidate } from './identify.js';
import { extractSignals } from './extract.js';

const cand = (id: string, name: string, num: string, total: number | null = null): Candidate => ({
  cardId: id,
  name,
  game: 'pokemon',
  collectorNumberNorm: num,
  setTotal: total,
  imageHash: null,
  sources: new Set(['test']),
});

describe('scoreCandidates', () => {
  const sig = extractSignals({ top: 'Pikachu 70 HP', full: 'Pikachu weakness resistance retreat', bottom: '025/198' });
  it('ranks name+number match first with high confidence', () => {
    const r = scoreCandidates([cand('a', 'Pichu', '24', 198), cand('b', 'Pikachu', '25', 198), cand('c', 'Pikachu', '58', 102)], sig, 'pikachu', null);
    expect(r[0]!.cardId).toBe('b');
    expect(r[0]!.confidence).toBeGreaterThan(0.95);
    expect(r[1]!.confidence).toBeLessThan(0.9);
  });
  it('caps confidence when ambiguous', () => {
    const r = scoreCandidates([cand('a', 'Pikachu', '25', 198), cand('b', 'Pikachu', '25', 198)], sig, 'pikachu', null);
    expect(r[0]!.confidence).toBeLessThan(0.95);
  });
});
