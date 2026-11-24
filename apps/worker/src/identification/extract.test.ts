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

describe('collector numbers from targeted readings', () => {
  it('drops symbols glued to the number and ranks the agreed reading first', () => {
    const s = extractSignals({ top: 'Fletchling', full: 'Fletchling 60 x\nweakness resistance retreat', bottom: 'E086/193\nGE086193 SRA\n3 006/193\nEN 086/193 S' }, 'pokemon');
    expect(s.numbers[0]).toMatchObject({ norm: '86', total: '193' });
  });
  it('reads a slash misread as 1', () => {
    const s = extractSignals({ top: 'Fletchling', full: '', bottom: 'E0861193 CS' }, 'pokemon');
    expect(s.numbers[0]).toMatchObject({ norm: '86', total: '193' });
  });
  it('keeps prefixed numbers with prefixed totals', () => {
    const s = extractSignals({ top: 'Pikachu', full: '', bottom: 'TG05/TG30' }, 'pokemon');
    expect(s.numbers[0]).toMatchObject({ norm: 'TG05', total: 'TG30' });
  });
});

describe('a card classifier\'s verdict', () => {
  it('leads the game guesses, so a visual verdict beats a keyword guess', () => {
    // no text at all: only the classifier can say what the card is
    const s = extractSignals({ top: '', full: '', bottom: '' }, undefined, { game: 'magic', confidence: 0.93 });
    expect(s.gameGuesses[0]).toEqual({ game: 'magic', score: 0.93 });
  });

  it('keeps the text guesses behind it, and its confidence as the score', () => {
    const s = extractSignals({ top: 'Pikachu 70 HP\nweakness retreat', full: '', bottom: '' }, undefined, { game: 'football', confidence: 0.51 });
    expect(s.gameGuesses[0]).toEqual({ game: 'football', score: 0.51 });
    expect(s.gameGuesses.some((g) => g.game === 'pokemon' && g.score > 0)).toBe(true);
  });

  it('never lets a weak verdict look like a certainty', () => {
    const s = extractSignals({ top: '', full: '', bottom: '' }, undefined, { game: 'yugioh', confidence: 0.2 });
    expect(s.gameGuesses[0]!.score).toBeGreaterThanOrEqual(0.34);
  });

  it('is ignored when the game was given, and when it says "other"', () => {
    expect(extractSignals({ top: '', full: '', bottom: '' }, 'pokemon', { game: 'magic', confidence: 1 }).gameGuesses).toEqual([{ game: 'pokemon', score: 1 }]);
    const s = extractSignals({ top: 'Creature — Dragon', full: '', bottom: '' }, undefined, { game: 'other', confidence: 1 });
    expect(s.gameGuesses[0]!.game).not.toBe('other');
  });

  it('uses the verdict to read collector numbers of that game', () => {
    const s = extractSignals({ top: '', full: '', bottom: 'LOB-001' }, undefined, { game: 'yugioh', confidence: 0.9 });
    expect(s.numbers.map((n) => n.raw)).toContain('LOB-001');
  });
});

describe('trimDebris on real misreads', () => {
  it.each([
    ['oasic Porygon', 'Porygon'],
    ['sraocz Arboliva', 'Arboliva'],
    ['Machoke w90', 'Machoke'],
    ['Lusamine Supporter TRAINER', 'Lusamine'],
    ['Supporter TRAINER', ''],
    ['Porygon2 80', 'Porygon2'],
  ])('%s → %s', async (inp, out) => {
    const { trimDebris } = await import('./extract.js');
    expect(trimDebris(inp)).toBe(out);
  });
});
