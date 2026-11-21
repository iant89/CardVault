import { sql, type SQL } from '@cardvault/database';
import type { AppContext } from '../context.js';

export interface CardDTO {
  id: string;
  game: { slug: string; name: string };
  set: { id: string; name: string; code: string | null; releaseDate: string | null; totalCards: number | null } | null;
  name: string;
  collectorNumber: string;
  rarity: string | null;
  artist: string | null;
  releaseDate: string | null;
  imageUrl: string | null;
  metadata: Record<string, unknown>;
  externalIds: Record<string, string>;
  variants: { id: string; type: string; description: string | null }[];
  price: { market: number | null; soldMedian: number | null; trend30d: number | null; updatedAt: string | null } | null;
  lastResearchedAt: string | null;
}

/** Prefer a locally cached image; fall back to the provider URL. */
export const imageUrlFor = (imagePath: string | null, imageUrl: string | null) =>
  imagePath ? `/api/files/${imagePath}` : imageUrl;

const num = (v: unknown) => (v == null ? null : Number(v));

export const CARD_SELECT = sql`
  c.id, c.name, c.collector_number, c.rarity, c.artist, c.release_date, c.image_url, c.image_path,
  c.metadata, c.external_ids, c.last_researched_at,
  g.slug AS game_slug, g.name AS game_name,
  s.id AS set_id, s.name AS set_name, s.code AS set_code, s.release_date AS set_release, s.total_cards AS set_total,
  ps.market_price, ps.sold_median, ps.trend_30d, ps.created_at AS price_at,
  COALESCE((SELECT json_agg(json_build_object('id', v.id, 'type', v.type, 'description', v.description) ORDER BY v.type)
            FROM card_variants v WHERE v.card_id = c.id), '[]') AS variants`;

export const CARD_FROM = sql`
  FROM cards c
  JOIN games g ON g.id = c.game_id
  LEFT JOIN sets s ON s.id = c.set_id
  LEFT JOIN LATERAL (
    SELECT market_price, sold_median, trend_30d, created_at FROM price_snapshots
    WHERE card_id = c.id AND variant_id IS NULL ORDER BY created_at DESC LIMIT 1
  ) ps ON true`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapCard(r: any): CardDTO {
  return {
    id: r.id,
    game: { slug: r.game_slug, name: r.game_name },
    set: r.set_id ? { id: r.set_id, name: r.set_name, code: r.set_code, releaseDate: r.set_release, totalCards: r.set_total } : null,
    name: r.name,
    collectorNumber: r.collector_number,
    rarity: r.rarity,
    artist: r.artist,
    releaseDate: r.release_date,
    imageUrl: imageUrlFor(r.image_path, r.image_url),
    metadata: r.metadata ?? {},
    externalIds: r.external_ids ?? {},
    variants: r.variants ?? [],
    price:
      r.price_at != null
        ? { market: num(r.market_price), soldMedian: num(r.sold_median), trend30d: num(r.trend_30d), updatedAt: new Date(r.price_at).toISOString() }
        : null,
    lastResearchedAt: r.last_researched_at ? new Date(r.last_researched_at).toISOString() : null,
  };
}

export async function getCard(ctx: AppContext, id: string): Promise<CardDTO | null> {
  const rows = await ctx.db.execute(sql`SELECT ${CARD_SELECT} ${CARD_FROM} WHERE c.id = ${id}`);
  return rows[0] ? mapCard(rows[0]) : null;
}

export interface CardFilters {
  q?: string;
  game?: string;
  setId?: string;
  rarity?: string;
  variant?: string;
  minPrice?: number;
  maxPrice?: number;
  minTrend?: number;
  year?: number;
  owner?: string;
  needsResearch?: boolean;
}

export function cardWhere(f: CardFilters): SQL {
  const parts: SQL[] = [sql`true`];
  if (f.q) {
    const like = `%${f.q.replace(/[%_\\]/g, '\\$&')}%`;
    parts.push(sql`(c.name ILIKE ${like} OR c.collector_number ILIKE ${like} OR s.name ILIKE ${like} OR similarity(c.name, ${f.q}) > 0.35
      OR c.metadata->>'player' ILIKE ${like})`);
  }
  if (f.game) parts.push(sql`g.slug = ${f.game}`);
  if (f.setId) parts.push(sql`c.set_id = ${f.setId}`);
  if (f.rarity) parts.push(sql`c.rarity ILIKE ${f.rarity}`);
  if (f.variant) parts.push(sql`EXISTS (SELECT 1 FROM card_variants v WHERE v.card_id = c.id AND v.type = ${f.variant})`);
  if (f.minPrice != null) parts.push(sql`ps.market_price >= ${f.minPrice}`);
  if (f.maxPrice != null) parts.push(sql`ps.market_price <= ${f.maxPrice}`);
  if (f.minTrend != null) parts.push(sql`ps.trend_30d >= ${f.minTrend}`);
  if (f.year) parts.push(sql`EXTRACT(YEAR FROM COALESCE(c.release_date, s.release_date)) = ${f.year}`);
  if (f.owner) parts.push(sql`EXISTS (SELECT 1 FROM collection_items ci WHERE ci.card_id = c.id AND ci.user_id = ${f.owner})`);
  if (f.needsResearch) parts.push(sql`(c.last_researched_at IS NULL OR ps.created_at IS NULL)`);
  return sql.join(parts, sql` AND `);
}

export async function searchCards(ctx: AppContext, f: CardFilters, page = 1, pageSize = 48) {
  const where = cardWhere(f);
  const order = f.q ? sql`similarity(c.name, ${f.q}) DESC, c.name` : sql`c.name, c.collector_number`;
  const rows = await ctx.db.execute(
    sql`SELECT ${CARD_SELECT} ${CARD_FROM} WHERE ${where} ORDER BY ${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
  );
  const total = await ctx.db.execute(sql`SELECT count(*)::int AS n ${CARD_FROM} WHERE ${where}`);
  return { items: rows.map(mapCard), total: Number(total[0]?.n ?? 0), page, pageSize };
}
