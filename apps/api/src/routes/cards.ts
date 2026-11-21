import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '@cardvault/database';
import { summarize } from '@cardvault/shared';
import type { AppContext } from '../context.js';
import { notFound, parse } from '../errors.js';
import { requireUser, user as currentUser } from '../auth/plugin.js';
import { getCard, searchCards } from '../services/cards.js';
import { enqueueResearch } from '../services/pipeline.js';

const uuid = z.string().uuid();
const filters = z.object({
  q: z.string().max(200).optional(),
  game: z.string().max(32).optional(),
  setId: uuid.optional(),
  rarity: z.string().max(64).optional(),
  variant: z.string().max(32).optional(),
  minPrice: z.coerce.number().optional(),
  maxPrice: z.coerce.number().optional(),
  minTrend: z.coerce.number().optional(),
  year: z.coerce.number().int().optional(),
  owner: uuid.optional(),
  needsResearch: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(48),
});

const variantQ = z.object({ variantId: uuid.optional(), days: z.coerce.number().int().min(1).max(3650).default(365) });

export async function cardRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/cards', { preHandler: requireUser }, async (req) => {
    const { page, pageSize, ...f } = parse(filters, req.query);
    return searchCards(ctx, f, page, pageSize);
  });

  app.get<{ Params: { id: string } }>('/api/cards/:id', { preHandler: requireUser }, async (req) => {
    parse(uuid, req.params.id);
    const card = await getCard(ctx, req.params.id);
    if (!card) throw notFound();
    const owned = await ctx.db.execute(sql`
      SELECT ci.id, ci.user_id, u.display_name, ci.condition, ci.quantity, ci.purchase_price, cv.type AS variant
      FROM collection_items ci JOIN users u ON u.id = ci.user_id LEFT JOIN card_variants cv ON cv.id = ci.variant_id
      WHERE ci.card_id = ${card.id} ORDER BY u.display_name`);
    return { card, owners: owned };
  });

  /** Market summary computed live from raw observations (listed and sold kept separate). */
  app.get<{ Params: { id: string } }>('/api/cards/:id/prices', { preHandler: requireUser }, async (req) => {
    parse(uuid, req.params.id);
    const q = parse(variantQ, req.query);
    const rows = await ctx.db.execute(sql`
      SELECT price, shipping, sale_type, observed_at, source FROM price_observations
      WHERE card_id = ${req.params.id} ${q.variantId ? sql`AND (variant_id = ${q.variantId} OR variant_id IS NULL)` : sql``}
        AND observed_at > now() - make_interval(days => ${q.days})`);
    const points = rows.map((r) => ({ price: Number(r.price), shipping: r.shipping == null ? 0 : Number(r.shipping), saleType: String(r.sale_type), observedAt: r.observed_at as string }));
    const sources = [...new Set(rows.map((r) => String(r.source)))];
    return { summary: summarize(points), sources, observationCount: points.length };
  });

  app.get<{ Params: { id: string } }>('/api/cards/:id/sales', { preHandler: requireUser }, async (req) => {
    parse(uuid, req.params.id);
    const q = parse(variantQ.extend({ type: z.enum(['sold', 'listed', 'all']).default('all'), limit: z.coerce.number().int().max(500).default(100) }), req.query);
    const typeFilter =
      q.type === 'sold' ? sql`AND sale_type IN ('SOLD','AUCTION')` : q.type === 'listed' ? sql`AND sale_type IN ('LISTING','BUY_IT_NOW')` : sql``;
    const rows = await ctx.db.execute(sql`
      SELECT po.id, po.source, po.price, po.shipping, po.currency, po.condition, po.sale_type, po.title, po.url, po.observed_at, cv.type AS variant
      FROM price_observations po LEFT JOIN card_variants cv ON cv.id = po.variant_id
      WHERE po.card_id = ${req.params.id} ${typeFilter} ${q.variantId ? sql`AND po.variant_id = ${q.variantId}` : sql``}
      ORDER BY po.observed_at DESC LIMIT ${q.limit}`);
    return { sales: rows.map((r) => ({ ...r, price: Number(r.price), shipping: r.shipping == null ? null : Number(r.shipping) })) };
  });

  /** Daily price history series for charts. */
  app.get<{ Params: { id: string } }>('/api/cards/:id/history', { preHandler: requireUser }, async (req) => {
    parse(uuid, req.params.id);
    const q = parse(variantQ, req.query);
    const v = q.variantId ? sql`AND (variant_id = ${q.variantId} OR variant_id IS NULL)` : sql``;
    const rows = await ctx.db.execute(sql`
      SELECT date_trunc('day', observed_at)::date AS day,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY price + COALESCE(shipping,0)) FILTER (WHERE sale_type IN ('SOLD','AUCTION')) AS sold_median,
        avg(price + COALESCE(shipping,0)) FILTER (WHERE sale_type IN ('SOLD','AUCTION')) AS sold_avg,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY price + COALESCE(shipping,0)) FILTER (WHERE sale_type IN ('LISTING','BUY_IT_NOW')) AS listed_median,
        avg(price) FILTER (WHERE sale_type = 'MARKET') AS market,
        count(*)::int AS n
      FROM price_observations WHERE card_id = ${req.params.id} ${v} AND observed_at > now() - make_interval(days => ${q.days})
      GROUP BY 1 ORDER BY 1`);
    const r2 = (x: unknown) => (x == null ? null : Math.round(Number(x) * 100) / 100);
    return {
      history: rows.map((r) => ({ day: String(r.day), soldMedian: r2(r.sold_median), soldAverage: r2(r.sold_avg), listedMedian: r2(r.listed_median), market: r2(r.market), count: Number(r.n) })),
    };
  });

  app.post<{ Params: { id: string } }>('/api/cards/:id/research', { preHandler: requireUser }, async (req) => {
    parse(uuid, req.params.id);
    const card = await getCard(ctx, req.params.id);
    if (!card) throw notFound();
    const jobId = await enqueueResearch(ctx, { cardId: card.id, userId: currentUser(req).id, priority: 2, reason: 'MANUAL' });
    return { jobId };
  });
}
