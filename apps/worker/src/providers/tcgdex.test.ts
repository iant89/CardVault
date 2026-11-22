import { describe, expect, it } from 'vitest';
import { parseTcgdexPricing } from './tcgdex.js';

const day = new Date('2026-11-22T00:00:00Z');

// Real response from api.tcgdex.net/v2/en/cards/sv01-025 (pricing block), captured 2026-11-21
const REAL_SV01_025 = {
  cardmarket: {
    updated: '2026-11-21T22:16:19.019Z', unit: 'EUR', idProduct: 702321, avg: 0.04, low: 0.02, trend: 0.03, avg1: 0.03, avg7: 0.03, avg30: 0.04,
    'avg-holo': 0.09, 'low-holo': 0.02, 'trend-holo': 0.1, 'avg1-holo': 0.07, 'avg7-holo': 0.12, 'avg30-holo': 0.09,
  },
  tcgplayer: {
    unit: 'USD',
    updated: '2026-11-21T22:16:32.492Z',
    normal: { productId: 487862, lowPrice: 0.01, midPrice: 0.17, highPrice: 20, marketPrice: 0.11, directLowPrice: null },
    'reverse-holofoil': { productId: 487862, lowPrice: 0.05, midPrice: 0.22, highPrice: 19.66, marketPrice: 0.19, directLowPrice: null },
  },
};

describe('parseTcgdexPricing', () => {
  it('parses the real TCGdex response (sv01-025)', () => {
    const out = parseTcgdexPricing('sv01-025', REAL_SV01_025, day);
    expect(out.map((o) => [o.variant, o.price, o.currency])).toEqual([
      ['NORMAL', 0.11, 'USD'],
      ['REVERSE_HOLO', 0.19, 'USD'],
    ]);
  });

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
