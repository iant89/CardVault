import { eq, sql, games, sets, cards, cardVariants } from '@cardvault/database';
import { parseAttributes, type NormalizedCard } from '@cardvault/card-model';
import { normalizeCollectorNumber } from '@cardvault/shared';
import type { WorkerContext } from './context.js';

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Insert or enrich a catalog card from a provider's normalized data.
 * Match order: any shared external id → (game, set, collector number).
 * Existing values are only filled in, never blanked by a sparser provider.
 */
export async function upsertCatalogCard(ctx: WorkerContext, n: NormalizedCard, targetId?: string): Promise<string> {
  const [game] = await ctx.db.select().from(games).where(eq(games.slug, n.game));
  if (!game) throw new Error(`unknown game ${n.game}`);

  const [set] = await ctx.db
    .insert(sets)
    .values({ gameId: game.id, name: n.set.name, slug: slugify(n.set.name), code: n.set.code, series: n.set.series ?? null, totalCards: n.set.total ?? null, releaseDate: n.set.releaseDate ?? null })
    .onConflictDoUpdate({
      target: [sets.gameId, sets.slug],
      set: {
        code: sql`COALESCE(${sets.code}, excluded.code)`,
        totalCards: sql`COALESCE(${sets.totalCards}, excluded.total_cards)`,
        releaseDate: sql`COALESCE(${sets.releaseDate}, excluded.release_date)`,
        series: sql`COALESCE(${sets.series}, excluded.series)`,
      },
    })
    .returning({ id: sets.id });

  const norm = normalizeCollectorNumber(n.collectorNumber);
  const ext = Object.entries(n.externalIds);
  let existing: { id: string } | undefined = targetId ? { id: targetId } : undefined;
  for (const [k, v] of existing ? [] : ext) {
    const r = await ctx.db.execute(sql`SELECT id FROM cards WHERE external_ids->>${k} = ${v} LIMIT 1`);
    if (r[0]) {
      existing = { id: String(r[0].id) };
      break;
    }
  }
  if (!existing) {
    const r = await ctx.db.execute(sql`SELECT id FROM cards WHERE game_id = ${game.id} AND set_id = ${set!.id} AND collector_number_norm = ${norm} AND lower(name) = lower(${n.name}) LIMIT 1`);
    if (r[0]) existing = { id: String(r[0].id) };
  }
  const attrs = parseAttributes(n.game, Object.fromEntries(Object.entries(n.attributes).filter(([, v]) => v !== undefined && v !== null)));

  let id: string;
  if (existing) {
    id = existing.id;
    await ctx.db.execute(sql`
      UPDATE cards SET
        rarity = COALESCE(rarity, ${n.rarity ?? null}),
        artist = COALESCE(artist, ${n.artist ?? null}),
        release_date = COALESCE(release_date, ${n.releaseDate ?? null}),
        image_url = COALESCE(image_url, ${n.imageUrl ?? null}),
        metadata = ${JSON.stringify(attrs)}::jsonb || metadata,
        external_ids = external_ids || ${JSON.stringify(n.externalIds)}::jsonb,
        updated_at = now()
      WHERE id = ${id}`);
  } else {
    const [row] = await ctx.db
      .insert(cards)
      .values({
        gameId: game.id,
        setId: set!.id,
        name: n.name,
        collectorNumber: n.collectorNumber,
        collectorNumberNorm: norm,
        rarity: n.rarity ?? null,
        artist: n.artist ?? null,
        releaseDate: n.releaseDate ?? null,
        imageUrl: n.imageUrl ?? null,
        metadata: attrs,
        externalIds: n.externalIds,
      })
      .returning({ id: cards.id });
    id = row!.id;
    // fetch & hash the catalog image so future scans can match visually
    if (n.imageUrl) await ctx.queues.image.add('catalog-image', { kind: 'CATALOG_HASH', cardId: id }, { jobId: `img:${id}`, priority: 5 });
  }
  for (const v of n.variants.length ? n.variants : ['NORMAL']) {
    await ctx.db.insert(cardVariants).values({ cardId: id, type: v }).onConflictDoNothing();
  }
  return id;
}

export async function loadNormalized(ctx: WorkerContext, cardId: string): Promise<NormalizedCard | null> {
  const r = await ctx.db.execute(sql`
    SELECT c.*, g.slug AS game, s.name AS set_name, s.code AS set_code, s.release_date AS set_release, s.total_cards,
      COALESCE((SELECT array_agg(type) FROM card_variants WHERE card_id = c.id), '{}') AS variants
    FROM cards c JOIN games g ON g.id = c.game_id LEFT JOIN sets s ON s.id = c.set_id WHERE c.id = ${cardId}`);
  const c = r[0];
  if (!c) return null;
  return {
    game: c.game as NormalizedCard['game'],
    set: { code: (c.set_code as string) ?? '', name: (c.set_name as string) ?? '', releaseDate: c.set_release as string | null, total: c.total_cards as number | null },
    name: c.name as string,
    collectorNumber: c.collector_number as string,
    rarity: c.rarity as string | null,
    artist: c.artist as string | null,
    releaseDate: c.release_date as string | null,
    imageUrl: c.image_url as string | null,
    variants: c.variants as NormalizedCard['variants'],
    attributes: (c.metadata as Record<string, unknown>) ?? {},
    externalIds: (c.external_ids as Record<string, string>) ?? {},
  };
}
