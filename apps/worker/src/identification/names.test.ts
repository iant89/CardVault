import { describe, expect, it } from 'vitest';
import { NameIndex } from './names.js';

const idx = new NameIndex(['Porygon', 'Porygon2', 'Porygon-Z', 'Nidoran♂', 'Nidoran♀', 'Jolteon', 'Jolteon ex', 'Mew', 'Mewtwo', 'Fletchling', 'Fletchinder', 'Snorlax', 'Lusamine', 'Potion']);

describe('NameIndex', () => {
  it.each([
    ['JPorygoniiie', 'Porygon'],
    ['Nidorand', 'Nidoran♂'],
    ['sas ISnorlax', 'Snorlax'],
    ['Fletchlinq', 'Fletchling'],
    ['5 Fletchling 60', 'Fletchling'],
    ['Jolteon ex', 'Jolteon ex'],
    ['Mew', 'Mew'],
  ])('%s → %s', (ocr, name) => {
    expect(idx.correct([ocr])[0]?.name).toBe(name);
  });
  it('does not invent names from unrelated text', () => {
    expect(idx.correct(['Flip a coin. If tails, this attack does nothing.', 'weakness retreat'])).toEqual([]);
  });
  it('prefers the title line on ties', () => {
    expect(idx.correct(['Lusamine', 'Snorlax'])[0]!.name).toBe('Lusamine');
  });
});
