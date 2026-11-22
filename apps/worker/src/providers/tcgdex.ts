import type { CardProvider } from '@cardvault/provider-sdk';
import type { NormalizedCard, PriceObservationInput } from '@cardvault/card-model';
import type { VariantType } from '@cardvault/shared';
import { similarity, normalizeCollectorNumber } from '@cardvault/shared';
import { dayStamp, isoDate, toNum } from './util.js';

/** TCGdex — free, open Pokémon card database (no key). Identity data and TCGplayer market prices. */
interface TcgdexBrief {
  id: string;
  localId: string;
  name: string;
  image?: string;
}
interface TcgdexCard extends TcgdexBrief {
  category?: string;
  illustrator?: string;
  rarity?: string;
  hp?: number;
  types?: string[];
  evolveFrom?: string;
  stage?: string;
  attacks?: { name: string; cost?: string[]; damage?: string | number; effect?: string }[];
  abilities?: { name: string; effect?: string; type?: string }[];
  weaknesses?: { type: string; value?: string }[];
  resistances?: { type: string; value?: string }[];
  retreat?: number;
  variants?: { normal?: boolean; reverse?: boolean; holo?: boolean; firstEdition?: boolean };
  set: { id: string; name: string; cardCount?: { official?: number; total?: number } };
  /** market data TCGdex mirrors from TCGplayer (USD) and Cardmarket (EUR) */
  pricing?: { tcgplayer?: Record<string, unknown> | null; cardmarket?: Record<string, unknown> | null } | null;
}

/** TCGplayer price-group keys → CardVault variants. Keys are compared lowercased with separators removed. */
const TCGPLAYER_VARIANT: Record<string, VariantType> = {
  normal: 'NORMAL',
  holofoil: 'HOLO',
  holo: 'HOLO',
  reverseholofoil: 'REVERSE_HOLO',
  reverse: 'REVERSE_HOLO',
  '1steditionholofoil': 'FIRST_EDITION',
  '1steditionnormal': 'FIRST_EDITION',
  '1stedition': 'FIRST_EDITION',
  firsteditionholofoil: 'FIRST_EDITION',
  firstedition: 'FIRST_EDITION',
  unlimitedholofoil: 'UNLIMITED',
  unlimited: 'UNLIMITED',
};

const pick = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) {
    const v = toNum(o[k]);
    if (v != null) return v;
  }
  return null;
};

/**
 * TCGplayer market prices from a TCGdex card's `pricing.tcgplayer` block.
 * Written defensively: each price group (normal, holofoil, reverse-holofoil…)
 * is an object holding market/mid prices, under camelCase or plain names.
 * Cardmarket (EUR) is deliberately ignored so currencies never mix.
 */
export function parseTcgdexPricing(cardId: string, pricing: TcgdexCard['pricing'], day = dayStamp()): PriceObservationInput[] {
  const tp = pricing?.tcgplayer;
  if (!tp || typeof tp !== 'object') return [];
  const unit = typeof tp.unit === 'string' ? tp.unit.toUpperCase() : 'USD';
  if (unit !== 'USD') return [];
  const date = day.toISOString().slice(0, 10);
  const out: PriceObservationInput[] = [];
  for (const [key, group] of Object.entries(tp)) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
    const g = group as Record<string, unknown>;
    const price = pick(g, 'marketPrice', 'market', 'midPrice', 'mid');
    if (!price) continue;
    const norm = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    out.push({
      source: 'tcgplayer-via-tcgdex',
      sourceItemId: `${cardId}:${norm}:${date}`,
      variant: TCGPLAYER_VARIANT[norm] ?? null,
      price,
      currency: 'USD',
      saleType: 'MARKET',
      observedAt: day.toISOString(),
    });
  }
  return out;
}

const BASE = 'https://api.tcgdex.net/v2/en';

function normalize(c: TcgdexCard): NormalizedCard {
  const v: VariantType[] = [];
  if (c.variants?.normal) v.push('NORMAL');
  if (c.variants?.holo) v.push('HOLO');
  if (c.variants?.reverse) v.push('REVERSE_HOLO');
  if (c.variants?.firstEdition) v.push('FIRST_EDITION');
  const official = c.set.cardCount?.official;
  return {
    game: 'pokemon',
    set: { code: c.set.id, name: c.set.name, total: official ?? null },
    name: c.name,
    collectorNumber: official ? `${c.localId}/${official}` : c.localId,
    rarity: c.rarity ?? null,
    artist: c.illustrator ?? null,
    imageUrl: c.image ? `${c.image}/high.webp` : null,
    imageUrlSmall: c.image ? `${c.image}/low.webp` : null,
    variants: v.length ? v : ['NORMAL'],
    attributes: {
      hp: c.hp != null ? String(c.hp) : undefined,
      types: c.types,
      supertype: c.category,
      subtypes: c.stage ? [c.stage] : undefined,
      abilities: c.abilities?.map((a) => ({ name: a.name, text: a.effect, type: a.type })),
      attacks: c.attacks?.map((a) => ({ name: a.name, cost: a.cost, damage: a.damage != null ? String(a.damage) : undefined, text: a.effect })),
      weaknesses: c.weaknesses,
      resistances: c.resistances,
      retreatCost: c.retreat ? Array.from({ length: c.retreat }, () => 'Colorless') : undefined,
      evolvesFrom: c.evolveFrom,
      illustrator: c.illustrator,
    },
    externalIds: { tcgdex: c.id },
  };
}

export const tcgdexProvider: CardProvider = {
  id: 'tcgdex',
  name: 'TCGdex',
  type: 'CARD_DATABASE',
  games: ['pokemon'],
  capabilities: { identify: true, search: true, prices: true, sales: false, images: true },
  rateLimit: { requests: 2, intervalMs: 1000 },
  allowedHosts: ['api.tcgdex.net', 'assets.tcgdex.net'],
  isConfigured: () => true,

  async search(query, ctx) {
    if (!query.name) return [];
    const params = new URLSearchParams({ name: query.name });
    if (query.collectorNumber) params.set('localId', normalizeCollectorNumber(query.collectorNumber));
    let briefs = await ctx.http.getJson<TcgdexBrief[]>(`${BASE}/cards?${params}`).catch(() => [] as TcgdexBrief[]);
    if (!briefs.length && query.collectorNumber) {
      briefs = await ctx.http.getJson<TcgdexBrief[]>(`${BASE}/cards?${new URLSearchParams({ name: query.name })}`).catch(() => []);
    }
    const top = briefs
      .map((b) => ({ b, s: similarity(query.name!, b.name) + (query.collectorNumber && normalizeCollectorNumber(b.localId) === normalizeCollectorNumber(query.collectorNumber) ? 0.5 : 0) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, Math.min(query.limit ?? 8, 8));
    const out = [];
    for (const { b, s } of top) {
      const card = await this.getCard(b.id, ctx);
      if (card) out.push({ providerId: 'tcgdex', externalId: b.id, card, score: Math.min(1, s) });
    }
    return out;
  },

  async getCard(externalId, ctx) {
    try {
      return normalize(await ctx.http.getJson<TcgdexCard>(`${BASE}/cards/${encodeURIComponent(externalId)}`));
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  },

  /** TCGplayer market prices mirrored by TCGdex (a second Pokémon price source besides pokemontcg.io). */
  async getPrices(card, ctx) {
    const id = card.externalIds.tcgdex;
    if (!id) return [];
    try {
      const c = await ctx.http.getJson<TcgdexCard>(`${BASE}/cards/${encodeURIComponent(id)}`);
      const prices = parseTcgdexPricing(id, c.pricing);
      if (!prices.length) ctx.log.info({ provider: 'tcgdex', card: id, hasPricing: !!c.pricing }, 'no TCGplayer prices on TCGdex card');
      return prices;
    } catch (e) {
      if ((e as { status?: number }).status === 404) return [];
      throw e;
    }
  },
};
