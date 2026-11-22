import { describe, expect, it } from 'vitest';
import { parseTcgdexPricing } from './tcgdex.js';

const day = new Date('2026-11-22T00:00:00Z');

describe('parseTcgdexPricing', () => {
  it('reads TCGplayer market prices per variant (TCGdex naming)', () => {
    const out = parseTcgdexPricing('sv01-025', {
      tcgplayer: {
        updated: '2026-11-21T00:00:00Z',
        unit: 'USD',
        normal: { productId: 1, lowPrice: 0.05, midPrice: 0.2, highPrice: 2, marketPrice: 0.12 },
        'reverse-holofoil': { lowPrice: 0.3, midPrice: 0.6, marketPrice: 0.55 },
        holofoil: { midPrice: 1.5 }, // no market price → falls back to mid
      },
      cardmarket: { unit: 'EUR', avg: 0.1, trend: 0.1 },
    }, day);
    expect(out.map((o) => [o.variant, o.price])).toEqual([
      ['NORMAL', 0.12],
      ['REVERSE_HOLO', 0.55],
      ['HOLO', 1.5],
    ]);
    expect(out.every((o) => o.currency === 'USD' && o.saleType === 'MARKET' && o.source === 'tcgplayer-via-tcgdex')).toBe(true);
    expect(out[0]!.sourceItemId).toBe('sv01-025:normal:2026-11-22'); // one observation per variant per day
  });

  it('accepts alternative key spellings', () => {
    const out = parseTcgdexPricing('base1-4', { tcgplayer: { '1stEditionHolofoil': { market: 400 }, unlimitedHolofoil: { mid: 150 } } }, day);
    expect(out.map((o) => [o.variant, o.price])).toEqual([
      ['FIRST_EDITION', 400],
      ['UNLIMITED', 150],
    ]);
  });

  it('never mixes currencies and tolerates missing data', () => {
    expect(parseTcgdexPricing('x', { tcgplayer: { unit: 'EUR', normal: { marketPrice: 1 } } }, day)).toEqual([]);
    expect(parseTcgdexPricing('x', { cardmarket: { unit: 'EUR', avg: 1 } }, day)).toEqual([]);
    expect(parseTcgdexPricing('x', undefined, day)).toEqual([]);
    expect(parseTcgdexPricing('x', null, day)).toEqual([]);
    expect(parseTcgdexPricing('x', { tcgplayer: { normal: { marketPrice: null, midPrice: 0 } } }, day)).toEqual([]);
  });
});
