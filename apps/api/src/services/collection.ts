import { sql, type SQL } from '@cardvault/database';
import type { AppContext } from '../context.js';
import { CARD_SELECT, mapCard, type CardDTO } from './cards.js';

export interface CollectionItemDTO {
  id: string;
  userId: string;
  ownerName: string;
  card: CardDTO;
  variant: { id: string; type: string } | null;
  condition: string;
  grading: Record<string, unknown>;
  quantity: number;
  purchasePrice: number | null;
  purchaseDate: string | null;
  source: string | null;
  notes: string | null;
  favorite: boolean;
  scanThumbnail: string | null;
  /** value of one copy */
  unitValue: number | null;
  totalValue: number | null;
  trend30d: number | null;
  createdAt: string;
}

/** Item value: variant-level snapshot if present, else card-level. */
const ITEM_FROM = sql`
  FROM collection_items ci
  JOIN users u ON u.id = ci.user_id
  JOIN cards c ON c.id = ci.card_id
  JOIN games g ON g.id = c.game_id
  LEFT JOIN sets s ON s.id = c.set_id
  LEFT JOIN card_variants cv ON cv.id = ci.variant_id
  LEFT JOIN scans sc ON sc.id = ci.scan_id
  LEFT JOIN LATERAL (
    SELECT market_price, sold_median, trend_30d, created_at FROM price_snapshots
    WHERE card_id = c.id AND variant_id IS NULL ORDER BY created_at DESC LIMIT 1
  ) ps ON true
  LEFT JOIN LATERAL (
    SELECT market_price, trend_30d FROM price_snapshots
    WHERE card_id = c.id AND variant_id = ci.variant_id ORDER BY created_at DESC LIMIT 1
  ) pv ON true`;

const ITEM_SELECT = sql`ci.id AS item_id, ci.user_id, u.display_name AS owner_name, ci.condition, ci.grading, ci.quantity,
  ci.purchase_price, ci.purchase_date, ci.source, ci.notes, ci.favorite, ci.created_at AS item_created,
  cv.id AS variant_id, cv.type AS variant_type, sc.thumbnail_path,
  COALESCE(pv.market_price, ps.market_price) AS unit_value,
  COALESCE(pv.trend_30d, ps.trend_30d) AS item_trend,
  ${CARD_SELECT}`;

export interface CollectionFilters {
  userId?: string;
  q?: string;
  game?: string;
  setId?: string;
  rarity?: string;
  variant?: string;
  condition?: string;
  minPrice?: number;
  maxPrice?: number;
  minTrend?: number;
  year?: number;
  favorite?: boolean;
  sort?: 'recent' | 'value' | 'name' | 'trend' | 'number';
}

function where(f: CollectionFilters): SQL {
  const p: SQL[] = [sql`true`];
  if (f.userId) p.push(sql`ci.user_id = ${f.userId}`);
  if (f.q) {
    const like = `%${f.q.replace(/[%_\\]/g, '\\$&')}%`;
    p.push(sql`(c.name ILIKE ${like} OR s.name ILIKE ${like} OR c.collector_number ILIKE ${like} OR similarity(c.name, ${f.q}) > 0.35 OR ci.notes ILIKE ${like})`);
  }
  if (f.game) p.push(f.game === 'sports' ? sql`g.slug IN ('football','baseball','basketball','hockey')` : sql`g.slug = ${f.game}`);
  if (f.setId) p.push(sql`c.set_id = ${f.setId}`);
  if (f.rarity) p.push(sql`c.rarity ILIKE ${f.rarity}`);
  if (f.variant) p.push(sql`cv.type = ${f.variant}`);
  if (f.condition) p.push(sql`ci.condition = ${f.condition}`);
  if (f.minPrice != null) p.push(sql`COALESCE(pv.market_price, ps.market_price) >= ${f.minPrice}`);
  if (f.maxPrice != null) p.push(sql`COALESCE(pv.market_price, ps.market_price) <= ${f.maxPrice}`);
  if (f.minTrend != null) p.push(sql`COALESCE(pv.trend_30d, ps.trend_30d) >= ${f.minTrend}`);
  if (f.year) p.push(sql`EXTRACT(YEAR FROM COALESCE(c.release_date, s.release_date)) = ${f.year}`);
  if (f.favorite) p.push(sql`ci.favorite`);
  return sql.join(p, sql` AND `);
}

const ORDER: Record<NonNullable<CollectionFilters['sort']>, SQL> = {
  recent: sql`ci.created_at DESC`,
  value: sql`COALESCE(pv.market_price, ps.market_price) DESC NULLS LAST`,
  name: sql`c.name ASC`,
  trend: sql`COALESCE(pv.trend_30d, ps.trend_30d) DESC NULLS LAST`,
  number: sql`s.name, c.collector_number_norm`,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapItem(r: any): CollectionItemDTO {
  const unit = r.unit_value == null ? null : Number(r.unit_value);
  return {
    id: r.item_id,
    userId: r.user_id,
    ownerName: r.owner_name,
    card: mapCard(r),
    variant: r.variant_id ? { id: r.variant_id, type: r.variant_type } : null,
    condition: r.condition,
    grading: r.grading ?? {},
    quantity: r.quantity,
    purchasePrice: r.purchase_price == null ? null : Number(r.purchase_price),
    purchaseDate: r.purchase_date,
    source: r.source,
    notes: r.notes,
    favorite: r.favorite,
    scanThumbnail: r.thumbnail_path ? `/api/files/${r.thumbnail_path}` : null,
    unitValue: unit,
    totalValue: unit == null ? null : Math.round(unit * r.quantity * 100) / 100,
    trend30d: r.item_trend == null ? null : Number(r.item_trend),
    createdAt: new Date(r.item_created).toISOString(),
  };
}

export async function listCollection(ctx: AppContext, f: CollectionFilters, page = 1, pageSize = 60) {
  const w = where(f);
  const rows = await ctx.db.execute(
    sql`SELECT ${ITEM_SELECT} ${ITEM_FROM} WHERE ${w} ORDER BY ${ORDER[f.sort ?? 'recent']}, ci.id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
  );
  const agg = await ctx.db.execute(
    sql`SELECT count(*)::int AS n, COALESCE(sum(ci.quantity * COALESCE(pv.market_price, ps.market_price)), 0) AS value ${ITEM_FROM} WHERE ${w}`,
  );
  return { items: rows.map(mapItem), total: Number(agg[0]?.n ?? 0), totalValue: Number(agg[0]?.value ?? 0), page, pageSize };
}

export async function getItem(ctx: AppContext, id: string): Promise<CollectionItemDTO | null> {
  const rows = await ctx.db.execute(sql`SELECT ${ITEM_SELECT} ${ITEM_FROM} WHERE ci.id = ${id}`);
  return rows[0] ? mapItem(rows[0]) : null;
}

/** Current value grouped by game for a user (or everyone when userId null). */
export async function valueByGame(ctx: AppContext, userId: string | null) {
  const w = userId ? sql`ci.user_id = ${userId}` : sql`true`;
  const rows = await ctx.db.execute(sql`
    SELECT g.slug, g.name, count(*)::int AS items, COALESCE(sum(ci.quantity),0)::int AS copies,
      COALESCE(sum(ci.quantity * COALESCE(pv.market_price, ps.market_price)), 0) AS value
    ${ITEM_FROM} WHERE ${w} GROUP BY g.slug, g.name, g.sort_order ORDER BY g.sort_order`);
  return rows.map((r) => ({ slug: String(r.slug), name: String(r.name), items: Number(r.items), copies: Number(r.copies), value: Number(r.value) }));
}

export async function valueBySet(ctx: AppContext, userId: string) {
  const rows = await ctx.db.execute(sql`
    SELECT s.id, s.name, g.slug AS game, s.total_cards, count(DISTINCT c.id)::int AS owned_unique,
      COALESCE(sum(ci.quantity * COALESCE(pv.market_price, ps.market_price)), 0) AS value
    ${ITEM_FROM} WHERE ci.user_id = ${userId} AND s.id IS NOT NULL
    GROUP BY s.id, s.name, g.slug, s.total_cards ORDER BY value DESC LIMIT 50`);
  return rows.map((r) => ({
    setId: String(r.id),
    name: String(r.name),
    game: String(r.game),
    ownedUnique: Number(r.owned_unique),
    totalCards: r.total_cards == null ? null : Number(r.total_cards),
    completion: r.total_cards ? Math.round((Number(r.owned_unique) / Number(r.total_cards)) * 1000) / 10 : null,
    value: Number(r.value),
  }));
}

/** Historical total from daily snapshots (written by the worker) + today live. */
export async function valueHistory(ctx: AppContext, userId: string) {
  const rows = await ctx.db.execute(
    sql`SELECT day, total_value FROM collection_value_snapshots WHERE user_id = ${userId} AND day > now() - interval '400 days' ORDER BY day`,
  );
  return rows.map((r) => ({ day: String(r.day), value: Number(r.total_value) }));
}

export async function duplicates(ctx: AppContext, userId: string) {
  const rows = await ctx.db.execute(sql`
    SELECT c.id AS card_id, c.name, s.name AS set_name, c.collector_number, cv.type AS variant, sum(ci.quantity)::int AS copies
    FROM collection_items ci JOIN cards c ON c.id = ci.card_id LEFT JOIN sets s ON s.id = c.set_id
    LEFT JOIN card_variants cv ON cv.id = ci.variant_id
    WHERE ci.user_id = ${userId}
    GROUP BY c.id, c.name, s.name, c.collector_number, cv.type HAVING sum(ci.quantity) > 1 ORDER BY copies DESC`);
  return rows;
}
