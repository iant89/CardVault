import type { CardProvider } from '@cardvault/provider-sdk';
import type { NormalizedCard } from '@cardvault/card-model';
import type { VariantType } from '@cardvault/shared';
import { similarity, normalizeCollectorNumber } from '@cardvault/shared';
import { isoDate } from './util.js';

/** TCGdex — free, open Pokémon card database (no key). Used for identity data. */
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
  capabilities: { identify: true, search: true, prices: false, sales: false, images: true },
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
};
