import type { CardProvider } from '@cardvault/provider-sdk';
import type { NormalizedCard, PriceObservationInput } from '@cardvault/card-model';
import type { VariantType } from '@cardvault/shared';
import { similarity } from '@cardvault/shared';
import { dayStamp, q, toNum } from './util.js';

/** Scryfall — Magic: The Gathering. Asks for 50–100ms between requests; we use 8/s. */
interface ScryCard {
  id: string;
  name: string;
  set: string;
  set_name: string;
  collector_number: string;
  rarity: string;
  artist?: string;
  released_at?: string;
  image_uris?: { normal?: string; small?: string; large?: string };
  card_faces?: { image_uris?: { normal?: string; small?: string }; mana_cost?: string; type_line?: string; oracle_text?: string }[];
  mana_cost?: string;
  colors?: string[];
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  finishes?: string[];
  prices?: { usd?: string | null; usd_foil?: string | null; usd_etched?: string | null };
  scryfall_uri?: string;
  promo?: boolean;
  full_art?: boolean;
}

const BASE = 'https://api.scryfall.com';
const FINISH: Record<string, VariantType> = { nonfoil: 'NON_FOIL', foil: 'FOIL', etched: 'ETCHED_FOIL' };

function normalize(c: ScryCard): NormalizedCard {
  const face = c.card_faces?.[0];
  const variants = (c.finishes ?? ['nonfoil']).map((f) => FINISH[f]).filter(Boolean) as VariantType[];
  if (c.promo) variants.push('PROMO');
  if (c.full_art) variants.push('FULL_ART');
  return {
    game: 'magic',
    set: { code: c.set, name: c.set_name, releaseDate: c.released_at ?? null },
    name: c.name,
    collectorNumber: c.collector_number,
    rarity: c.rarity,
    artist: c.artist ?? null,
    releaseDate: c.released_at ?? null,
    imageUrl: c.image_uris?.large ?? c.image_uris?.normal ?? face?.image_uris?.normal ?? null,
    imageUrlSmall: c.image_uris?.small ?? face?.image_uris?.small ?? null,
    variants,
    attributes: {
      manaCost: c.mana_cost ?? face?.mana_cost,
      colors: c.colors,
      typeLine: c.type_line ?? face?.type_line,
      oracleText: c.oracle_text ?? c.card_faces?.map((f) => f.oracle_text).filter(Boolean).join('\n//\n'),
      power: c.power,
      toughness: c.toughness,
      loyalty: c.loyalty,
      finishes: c.finishes,
    },
    externalIds: { scryfall: c.id },
  };
}

const headers = { accept: 'application/json' };

export const scryfallProvider: CardProvider = {
  id: 'scryfall',
  name: 'Scryfall',
  type: 'CARD_DATABASE',
  games: ['magic'],
  capabilities: { identify: true, search: true, prices: true, sales: false, images: true },
  rateLimit: { requests: 8, intervalMs: 1000 },
  allowedHosts: ['api.scryfall.com', 'cards.scryfall.io'],
  isConfigured: () => true,

  async search(query, ctx) {
    const parts: string[] = [];
    if (query.name) parts.push(`!"${q(query.name)}"`);
    if (query.setCode) parts.push(`set:${q(query.setCode)}`);
    if (query.collectorNumber) parts.push(`cn:${q(query.collectorNumber.split('/')[0]!)}`);
    if (!parts.length) return [];
    const run = async (qs: string) => {
      try {
        const r = await ctx.http.getJson<{ data: ScryCard[] }>(`${BASE}/cards/search?unique=prints&q=${encodeURIComponent(qs)}`, { headers });
        return r.data;
      } catch (e) {
        if ((e as { status?: number }).status === 404) return [];
        throw e;
      }
    };
    let data = await run(parts.join(' '));
    // fall back to fuzzy name when OCR'd name isn't exact
    if (!data.length && query.name) {
      try {
        const c = await ctx.http.getJson<ScryCard>(`${BASE}/cards/named?fuzzy=${encodeURIComponent(query.name)}`, { headers });
        data = [c];
      } catch {
        data = [];
      }
    }
    return data.slice(0, query.limit ?? 20).map((c) => ({ providerId: 'scryfall', externalId: c.id, card: normalize(c), score: query.name ? similarity(query.name, c.name) : 0.5 }));
  },

  async getCard(externalId, ctx) {
    try {
      return normalize(await ctx.http.getJson<ScryCard>(`${BASE}/cards/${encodeURIComponent(externalId)}`, { headers }));
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  },

  async getPrices(card, ctx) {
    const id = card.externalIds.scryfall;
    if (!id) return [];
    const c = await ctx.http.getJson<ScryCard>(`${BASE}/cards/${encodeURIComponent(id)}`, { headers });
    const day = dayStamp();
    const out: PriceObservationInput[] = [];
    const add = (key: 'usd' | 'usd_foil' | 'usd_etched', variant: VariantType) => {
      const price = toNum(c.prices?.[key]);
      if (price)
        out.push({ source: 'scryfall', sourceItemId: `${id}:${key}:${day.toISOString().slice(0, 10)}`, variant, price, currency: 'USD', saleType: 'MARKET', observedAt: day.toISOString(), url: c.scryfall_uri ?? null });
    };
    add('usd', 'NON_FOIL');
    add('usd_foil', 'FOIL');
    add('usd_etched', 'ETCHED_FOIL');
    return out;
  },
};
