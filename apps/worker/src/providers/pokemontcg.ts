import type { CardProvider, CardSearchResult } from '@cardvault/provider-sdk';
import type { NormalizedCard, PriceObservationInput } from '@cardvault/card-model';
import type { VariantType } from '@cardvault/shared';
import { similarity, normalizeCollectorNumber } from '@cardvault/shared';
import { dayStamp, isoDate, q, toNum } from './util.js';

/**
 * Pokémon TCG API (api.pokemontcg.io v2). NOTE: being deprecated — existing
 * keys stop working after 2027-03-01. Kept behind the provider interface so it
 * can be dropped without touching the rest of the system. Works without a key
 * at a lower rate limit.
 */
interface PtcgCard {
  id: string;
  name: string;
  supertype?: string;
  subtypes?: string[];
  hp?: string;
  types?: string[];
  evolvesFrom?: string;
  abilities?: { name: string; text?: string; type?: string }[];
  attacks?: { name: string; cost?: string[]; damage?: string; text?: string }[];
  weaknesses?: { type: string; value?: string }[];
  resistances?: { type: string; value?: string }[];
  retreatCost?: string[];
  number: string;
  artist?: string;
  rarity?: string;
  set: { id: string; name: string; series?: string; printedTotal?: number; total?: number; releaseDate?: string };
  images?: { small?: string; large?: string };
  tcgplayer?: { url?: string; updatedAt?: string; prices?: Record<string, { low?: number; mid?: number; high?: number; market?: number }> };
  cardmarket?: { url?: string; updatedAt?: string; prices?: { averageSellPrice?: number; trendPrice?: number; avg30?: number } };
}

const PRICE_VARIANT: Record<string, VariantType> = {
  normal: 'NORMAL',
  holofoil: 'HOLO',
  reverseHolofoil: 'REVERSE_HOLO',
  '1stEditionHolofoil': 'FIRST_EDITION',
  '1stEditionNormal': 'FIRST_EDITION',
  '1stEdition': 'FIRST_EDITION',
  unlimitedHolofoil: 'UNLIMITED',
  unlimited: 'UNLIMITED',
};

function normalize(c: PtcgCard): NormalizedCard {
  const variants = Object.keys(c.tcgplayer?.prices ?? {}).map((k) => PRICE_VARIANT[k]).filter(Boolean) as VariantType[];
  return {
    game: 'pokemon',
    set: { code: c.set.id, name: c.set.name, releaseDate: isoDate(c.set.releaseDate), total: c.set.printedTotal ?? c.set.total ?? null, series: c.set.series ?? null },
    name: c.name,
    collectorNumber: c.set.printedTotal ? `${c.number}/${c.set.printedTotal}` : c.number,
    rarity: c.rarity ?? null,
    artist: c.artist ?? null,
    releaseDate: isoDate(c.set.releaseDate),
    imageUrl: c.images?.large ?? null,
    imageUrlSmall: c.images?.small ?? null,
    variants: variants.length ? [...new Set(variants)] : ['NORMAL'],
    attributes: {
      hp: c.hp,
      types: c.types,
      supertype: c.supertype,
      subtypes: c.subtypes,
      abilities: c.abilities,
      attacks: c.attacks,
      weaknesses: c.weaknesses,
      resistances: c.resistances,
      retreatCost: c.retreatCost,
      evolvesFrom: c.evolvesFrom,
      illustrator: c.artist,
    },
    externalIds: { pokemontcg: c.id },
  };
}

const BASE = 'https://api.pokemontcg.io/v2';

export const pokemonTcgProvider: CardProvider & { _raw?: PtcgCard } = {
  id: 'pokemontcg',
  name: 'Pokémon TCG API',
  type: 'CARD_DATABASE',
  games: ['pokemon'],
  capabilities: { identify: true, search: true, prices: true, sales: false, images: true },
  rateLimit: { requests: 20, intervalMs: 60_000 },
  allowedHosts: ['api.pokemontcg.io', 'images.pokemontcg.io'],
  isConfigured: () => true,

  async search(query, ctx) {
    const parts: string[] = [];
    if (query.name) parts.push(`name:"${q(query.name)}"`);
    if (query.collectorNumber) parts.push(`number:${q(normalizeCollectorNumber(query.collectorNumber).toLowerCase())}`);
    if (query.setCode) parts.push(`set.id:${q(query.setCode)}`);
    if (!parts.length) return [];
    const url = `${BASE}/cards?q=${encodeURIComponent(parts.join(' '))}&pageSize=${query.limit ?? 20}`;
    const headers: Record<string, string> = ctx.env.POKEMONTCG_API_KEY ? { 'X-Api-Key': ctx.env.POKEMONTCG_API_KEY } : {};
    const res = await ctx.http.getJson<{ data: PtcgCard[] }>(url, { headers });
    return res.data.map<CardSearchResult>((c) => ({
      providerId: 'pokemontcg',
      externalId: c.id,
      card: normalize(c),
      score: query.name ? similarity(query.name, c.name) : 0.5,
    }));
  },

  async getCard(externalId, ctx) {
    const headers: Record<string, string> = ctx.env.POKEMONTCG_API_KEY ? { 'X-Api-Key': ctx.env.POKEMONTCG_API_KEY } : {};
    try {
      const res = await ctx.http.getJson<{ data: PtcgCard }>(`${BASE}/cards/${encodeURIComponent(externalId)}`, { headers });
      return normalize(res.data);
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  },

  /** TCGplayer market + Cardmarket trend prices embedded in the card payload (aggregates, not individual sales). */
  async getPrices(card, ctx) {
    const id = card.externalIds.pokemontcg;
    if (!id) return [];
    const headers: Record<string, string> = ctx.env.POKEMONTCG_API_KEY ? { 'X-Api-Key': ctx.env.POKEMONTCG_API_KEY } : {};
    const { data } = await ctx.http.getJson<{ data: PtcgCard }>(`${BASE}/cards/${encodeURIComponent(id)}`, { headers });
    const out: PriceObservationInput[] = [];
    const day = dayStamp();
    for (const [key, p] of Object.entries(data.tcgplayer?.prices ?? {})) {
      const price = toNum(p.market) ?? toNum(p.mid);
      if (!price) continue;
      out.push({
        source: 'tcgplayer-via-pokemontcg',
        sourceItemId: `${id}:${key}:${day.toISOString().slice(0, 10)}`,
        variant: PRICE_VARIANT[key] ?? null,
        price,
        currency: 'USD',
        saleType: 'MARKET',
        observedAt: day.toISOString(),
        url: data.tcgplayer?.url ?? null,
      });
    }
    return out;
  },
};
