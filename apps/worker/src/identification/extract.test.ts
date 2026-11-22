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

describe('name cleanup', () => {
  it('drops a stray badge digit and an HP whose "HP" was too small to read', () => {
    const s = extractSignals({ top: '5 Fletchling 60\n', full: 'BAS : : \nFletchling 60 x\nSurprise Attack 30', bottom: '' });
    expect(s.nameCandidates[0]).toBe('Fletchling');
  });
  it('keeps name suffixes and inner numbers', () => {
    const s = extractSignals({ top: 'BASIC Pikachu ex 200\n', full: '', bottom: '' }, 'pokemon');
    expect(s.nameCandidates[0]).toBe('Pikachu ex');
    const y = extractSignals({ top: 'Number 39: Utopia\n', full: '', bottom: '' }, 'yugioh');
    expect(y.nameCandidates[0]).toBe('Number 39: Utopia');
  });
});

describe('trimDebris', () => {
  it('keeps short capitalised words', async () => {
    const { trimDebris } = await import('./extract.js');
    expect(trimDebris('Mr Mime 70')).toBe('Mr Mime');
    expect(trimDebris('x Charizard VMAX 330 .')).toBe('Charizard VMAX');
  });
});
