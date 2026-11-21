import { and, eq, sql, isNull, priceSnapshots } from '@cardvault/database';
import { summarize, type PricePoint } from '@cardvault/shared';
import type { WorkerContext } from '../context.js';

/**
 * Recompute price snapshots for a card: one per variant plus a card-level
 * aggregate. At most one snapshot per (card, variant, day) — re-runs on the
 * same day replace it, so history stays one point per day.
 */
export async function computeSnapshots(ctx: WorkerContext, cardId: string): Promise<number | null> {
  const rows = await ctx.db.execute(sql`
    SELECT variant_id, price, shipping, sale_type, observed_at FROM price_observations
    WHERE card_id = ${cardId} AND observed_at > now() - interval '400 days'`);
  const byVariant = new Map<string | null, PricePoint[]>([[null, []]]);
  for (const r of rows) {
    const p: PricePoint = { price: Number(r.price), shipping: r.shipping == null ? 0 : Number(r.shipping), saleType: String(r.sale_type), observedAt: r.observed_at as string };
    byVariant.get(null)!.push(p);
    const v = (r.variant_id as string) ?? null;
    if (v) {
      if (!byVariant.has(v)) byVariant.set(v, []);
      byVariant.get(v)!.push(p);
    }
  }
  let cardMarket: number | null = null;
  for (const [variantId, points] of byVariant) {
    if (!points.length) continue;
    const s = summarize(points);
    await ctx.db
      .delete(priceSnapshots)
      .where(and(eq(priceSnapshots.cardId, cardId), variantId ? eq(priceSnapshots.variantId, variantId) : isNull(priceSnapshots.variantId), sql`${priceSnapshots.createdAt} >= date_trunc('day', now())`));
    const all = [...s.sold.count ? [s.sold] : [], s.listed];
    await ctx.db.insert(priceSnapshots).values({
      cardId,
      variantId,
      marketPrice: s.marketPrice,
      medianPrice: s.recentSoldMedian ?? s.sold.median ?? s.listed.median,
      averagePrice: s.recentSoldAverage ?? s.sold.average ?? s.listed.average,
      minPrice: Math.min(...all.map((x) => x.min ?? Infinity)) === Infinity ? null : Math.min(...all.map((x) => x.min ?? Infinity)),
      maxPrice: Math.max(...all.map((x) => x.max ?? -Infinity)) === -Infinity ? null : Math.max(...all.map((x) => x.max ?? -Infinity)),
      soldMedian: s.sold.median,
      soldAverage: s.sold.average,
      listedMedian: s.listed.median,
      avg30d: s.avg30d,
      avg90d: s.avg90d,
      avg1y: s.avg1y,
      trend30d: s.trend30d,
      volatility: s.volatility,
      observationCount: points.length,
    });
    if (variantId === null) cardMarket = s.marketPrice;
  }
  return cardMarket;
}

/** Daily per-user collection value snapshot (for "7 / 30 / 90 days ago"). */
export async function snapshotCollectionValues(ctx: WorkerContext): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO collection_value_snapshots (user_id, day, total_value, by_game, item_count)
    SELECT t.user_id, current_date, COALESCE(sum(t.v), 0), COALESCE(jsonb_object_agg(t.slug, t.v) FILTER (WHERE t.slug IS NOT NULL), '{}'), COALESCE(sum(t.n), 0)
    FROM (
      SELECT u.id AS user_id, g.slug, sum(ci.quantity * COALESCE(pv.market_price, ps.market_price, 0)) AS v, sum(ci.quantity)::int AS n
      FROM users u
      LEFT JOIN collection_items ci ON ci.user_id = u.id
      LEFT JOIN cards c ON c.id = ci.card_id
      LEFT JOIN games g ON g.id = c.game_id
      LEFT JOIN LATERAL (SELECT market_price FROM price_snapshots WHERE card_id = c.id AND variant_id IS NULL ORDER BY created_at DESC LIMIT 1) ps ON true
      LEFT JOIN LATERAL (SELECT market_price FROM price_snapshots WHERE card_id = c.id AND variant_id = ci.variant_id ORDER BY created_at DESC LIMIT 1) pv ON true
      WHERE u.active
      GROUP BY u.id, g.slug
    ) t
    GROUP BY t.user_id
    ON CONFLICT (user_id, day) DO UPDATE SET total_value = excluded.total_value, by_game = excluded.by_game, item_count = excluded.item_count`);
}
