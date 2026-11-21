import type { CardProvider, ProviderContext } from '@cardvault/provider-sdk';
import type { NormalizedCard, PriceObservationInput } from '@cardvault/card-model';
import type { GameSlug } from '@cardvault/shared';
import { isSportsGame, normalizeText, normalizeCollectorNumber } from '@cardvault/shared';
import { dayStamp, toNum } from './util.js';

/**
 * eBay Browse API (official, OAuth client-credentials). Returns ACTIVE
 * listings → stored as LISTING / AUCTION-bid observations. Sold-price data
 * on eBay requires the restricted Marketplace Insights API; if you are
 * granted it, add a getSales() here — nothing else needs to change.
 */
const API = 'https://api.ebay.com';
const CATEGORY: Partial<Record<GameSlug, string>> = {
  pokemon: '183454', // CCG Individual Cards
  magic: '183454',
  yugioh: '183454',
  football: '261328', // Sports Trading Card Singles
  baseball: '261328',
  basketball: '261328',
  hockey: '261328',
};
const NOISE = /\b(lot|bundle|proxy|custom|fan ?art|orica|replica|digital|code card|empty|case only|sleeve|binder|choose|pick|you pick|mystery|repack)\b/i;
const GRADED = /\b(psa|bgs|cgc|sgc|beckett|graded)\s*\d/i;

let token: { value: string; exp: number } | null = null;

async function getToken(ctx: ProviderContext): Promise<string> {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const basic = Buffer.from(`${ctx.env.EBAY_CLIENT_ID}:${ctx.env.EBAY_CLIENT_SECRET}`).toString('base64');
  const res = await ctx.http.request(`${API}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
    retries: 1,
  });
  const j = res.json<{ access_token: string; expires_in: number }>();
  token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return token.value;
}

export function buildQuery(card: NormalizedCard): string {
  const num = card.collectorNumber.split('/')[0]!.trim();
  const a = card.attributes as Record<string, unknown>;
  if (isSportsGame(card.game)) {
    return [a.season ?? '', card.set.name, a.player ?? card.name, num ? `#${num}` : ''].filter(Boolean).join(' ');
  }
  return [card.name, num, card.set.name].filter(Boolean).join(' ');
}

/** Keep only listings whose title plausibly refers to this exact card (raw, single). */
export function relevant(title: string, card: NormalizedCard): boolean {
  if (NOISE.test(title) || GRADED.test(title)) return false;
  const t = normalizeText(title);
  const nameTokens = normalizeText(card.name).split(' ').filter((w) => w.length > 2);
  if (!nameTokens.every((w) => t.includes(w))) return false;
  const num = normalizeCollectorNumber(card.collectorNumber);
  if (num && !new RegExp(`(^|[^0-9a-z])0*${num.toLowerCase()}([^0-9]|$)`).test(t)) return false;
  return true;
}

interface ItemSummary {
  itemId: string;
  title: string;
  price?: { value: string; currency: string };
  currentBidPrice?: { value: string; currency: string };
  buyingOptions?: string[];
  condition?: string;
  shippingOptions?: { shippingCost?: { value: string } }[];
  itemWebUrl?: string;
}

export const ebayProvider: CardProvider = {
  id: 'ebay',
  name: 'eBay Browse API',
  type: 'MARKETPLACE_API',
  games: ['pokemon', 'magic', 'yugioh', 'football', 'baseball', 'basketball', 'hockey', 'other'],
  capabilities: { identify: false, search: false, prices: true, sales: false, images: false },
  rateLimit: { requests: 1, intervalMs: 1000 },
  allowedHosts: ['api.ebay.com'],
  isConfigured: (ctx) => Boolean(ctx.env.EBAY_CLIENT_ID && ctx.env.EBAY_CLIENT_SECRET),

  async search() {
    return [];
  },
  async getCard() {
    return null;
  },

  async getPrices(card, ctx) {
    const access = await getToken(ctx);
    const params = new URLSearchParams({ q: buildQuery(card), limit: '50', filter: 'buyingOptions:{FIXED_PRICE|AUCTION},priceCurrency:USD' });
    const cat = CATEGORY[card.game];
    if (cat) params.set('category_ids', cat);
    const res = await ctx.http.getJson<{ itemSummaries?: ItemSummary[] }>(`${API}/buy/browse/v1/item_summary/search?${params}`, {
      headers: { authorization: `Bearer ${access}`, 'x-ebay-c-marketplace-id': ctx.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US' },
    });
    const day = dayStamp().toISOString();
    const out: PriceObservationInput[] = [];
    for (const it of res.itemSummaries ?? []) {
      if (!relevant(it.title, card)) continue;
      const auction = it.buyingOptions?.includes('AUCTION') && !it.buyingOptions.includes('FIXED_PRICE');
      const price = toNum(auction ? it.currentBidPrice?.value : it.price?.value);
      if (!price) continue;
      out.push({
        source: 'ebay',
        sourceItemId: it.itemId,
        price,
        shipping: toNum(it.shippingOptions?.[0]?.shippingCost?.value) ?? 0,
        currency: it.price?.currency ?? 'USD',
        condition: it.condition ?? null,
        // An open auction's current bid is not a sale; we keep it as a listing.
        saleType: auction ? 'LISTING' : 'BUY_IT_NOW',
        observedAt: day,
        url: it.itemWebUrl ?? null,
        title: it.title.slice(0, 300),
      });
    }
    return out;
  },
};
