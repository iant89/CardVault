import { describe, expect, it } from 'vitest';
import { extractSignals } from './extract.js';

describe('extractSignals', () => {
  it('finds pokemon name, number and game', () => {
    const s = extractSignals({
      top: 'BASIC\nPikachu 70 HP\n',
      full: 'Pikachu\nThunder Shock 20\nweakness resistance retreat\nIllus. Atsuko',
      bottom: 'SVI EN 025/198 ●',
    });
    expect(s.gameGuesses[0]!.game).toBe('pokemon');
    expect(s.nameCandidates[0]).toBe('Pikachu');
    expect(s.numbers[0]).toMatchObject({ norm: '25', total: '198' });
  });
  it('finds yugioh set codes and 1st edition', () => {
    const s = extractSignals({ top: 'Blue-Eyes White Dragon', full: 'Dragon Normal ATK/3000 DEF/2500 1st Edition', bottom: 'LOB-001' }, 'yugioh');
    expect(s.numbers.map((n) => n.raw)).toContain('LOB-001');
    expect(s.variantHints).toContain('FIRST_EDITION');
  });
});
