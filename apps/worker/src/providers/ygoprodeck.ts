import type { CardProvider } from '@cardvault/provider-sdk';
import type { NormalizedCard, PriceObservationInput } from '@cardvault/card-model';
import { similarity } from '@cardvault/shared';
import { dayStamp, toNum } from './util.js';

/**
 * YGOPRODeck — Yu-Gi-Oh!. Their guidelines ask clients to cache data and
 * download images rather than hot-link; the image queue stores them locally.
 */
interface YgoCard {
  id: number;
  name: string;
  type: string;
  desc: string;
  atk?: number;
  def?: number;
  level?: number;
  race?: string;
  attribute?: string;
  archetype?: string;
  card_sets?: { set_name: string; set_code: string; set_rarity: string; set_price?: string }[];
  card_images?: { image_url: string; image_url_small: string }[];
  card_prices?: { tcgplayer_price?: string; cardmarket_price?: string; ebay_price?: string }[];
}

const BASE = 'https://db.ygoprodeck.com/api/v7';

function normalize(c: YgoCard, setCode?: string): NormalizedCard {
  const set = (setCode && c.card_sets?.find((s) => s.set_code.toUpperCase() === setCode.toUpperCase())) || c.card_sets?.[0];
  return {
    game: 'yugioh',
    set: { code: set ? set.set_code.split('-')[0]! : 'unknown', name: set?.set_name ?? 'Unknown Set' },
    name: c.name,
    collectorNumber: set?.set_code ?? String(c.id),
    rarity: set?.set_rarity ?? null,
    imageUrl: c.card_images?.[0]?.image_url ?? null,
    imageUrlSmall: c.card_images?.[0]?.image_url_small ?? null,
    variants: ['FIRST_EDITION', 'UNLIMITED'],
    attributes: { attribute: c.attribute, level: c.level, race: c.race, type: c.type, attack: c.atk, defense: c.def, effect: c.desc, archetype: c.archetype },
    externalIds: { ygoprodeck: String(c.id), ...(set ? { ygoSetCode: set.set_code } : {}) },
  };
}

export const ygoprodeckProvider: CardProvider = {
  id: 'ygoprodeck',
  name: 'YGOPRODeck',
  type: 'CARD_DATABASE',
  games: ['yugioh'],
  capabilities: { identify: true, search: true, prices: true, sales: false, images: true },
  rateLimit: { requests: 10, intervalMs: 1000 },
  allowedHosts: ['db.ygoprodeck.com', 'images.ygoprodeck.com'],
  isConfigured: () => true,

  async search(query, ctx) {
    let data: YgoCard[] = [];
    try {
      if (query.collectorNumber && /-/.test(query.collectorNumber)) {
        // exact print lookup by set code (e.g. LOB-001)
        const info = await ctx.http.getJson<{ id: number }>(`${BASE}/cardsetsinfo.php?setcode=${encodeURIComponent(query.collectorNumber)}`).catch(() => null);
        if (info?.id) data = (await ctx.http.getJson<{ data: YgoCard[] }>(`${BASE}/cardinfo.php?id=${info.id}`)).data;
      }
      if (!data.length && query.name) data = (await ctx.http.getJson<{ data: YgoCard[] }>(`${BASE}/cardinfo.php?fname=${encodeURIComponent(query.name)}`)).data;
    } catch (e) {
      if ((e as { status?: number }).status === 400) return [];
      throw e;
    }
    return data.slice(0, query.limit ?? 10).map((c) => ({
      providerId: 'ygoprodeck',
      externalId: String(c.id),
      card: normalize(c, query.collectorNumber),
      score: query.name ? similarity(query.name, c.name) : 0.6,
    }));
  },

  async getCard(externalId, ctx) {
    try {
      const r = await ctx.http.getJson<{ data: YgoCard[] }>(`${BASE}/cardinfo.php?id=${encodeURIComponent(externalId)}`);
      return r.data[0] ? normalize(r.data[0]) : null;
    } catch (e) {
      if ((e as { status?: number }).status === 400) return null;
      throw e;
    }
  },

  async getPrices(card, ctx) {
    const id = card.externalIds.ygoprodeck;
    if (!id) return [];
    const r = await ctx.http.getJson<{ data: YgoCard[] }>(`${BASE}/cardinfo.php?id=${encodeURIComponent(id)}`);
    const c = r.data[0];
    if (!c) return [];
    const day = dayStamp();
    const d = day.toISOString().slice(0, 10);
    const out: PriceObservationInput[] = [];
    const setPrice = toNum(c.card_sets?.find((s) => s.set_code === card.externalIds.ygoSetCode)?.set_price);
    if (setPrice) out.push({ source: 'ygoprodeck-set', sourceItemId: `${id}:${card.externalIds.ygoSetCode}:${d}`, price: setPrice, currency: 'USD', saleType: 'MARKET', observedAt: day.toISOString() });
    const tcg = toNum(c.card_prices?.[0]?.tcgplayer_price);
    if (tcg && !setPrice) out.push({ source: 'tcgplayer-via-ygoprodeck', sourceItemId: `${id}:tcg:${d}`, price: tcg, currency: 'USD', saleType: 'MARKET', observedAt: day.toISOString() });
    return out;
  },
};
