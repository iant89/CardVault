import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql, manualReviews, scans, games, sets, cards, identifications, researchJobs } from '@cardvault/database';
import { CONDITIONS, GAME_SLUGS, normalizeCollectorNumber } from '@cardvault/shared';
import { parseAttributes } from '@cardvault/card-model';
import type { AppContext } from '../context.js';
import { badRequest, forbidden, notFound, parse } from '../errors.js';
import { requireUser, user as currentUser } from '../auth/plugin.js';
import { addScanToCollection, enqueueResearch, ensureVariant } from '../services/pipeline.js';
import { getCard } from '../services/cards.js';
import { audit } from '../services/audit.js';

const uuid = z.string().uuid();
const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const resolveBody = z.union([
  z.object({ cardId: uuid, variant: z.string().max(32).optional(), condition: z.enum(CONDITIONS).optional(), notes: z.string().max(2000).optional() }),
  z.object({
    game: z.enum(GAME_SLUGS),
    name: z.string().min(1).max(200),
    setName: z.string().max(200).optional(),
    setCode: z.string().max(40).optional(),
    collectorNumber: z.string().max(40).default(''),
    variant: z.string().max(32).default('NORMAL'),
    rarity: z.string().max(64).optional(),
    condition: z.enum(CONDITIONS).optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    notes: z.string().max(2000).optional(),
  }),
]);

/** Find a catalog card matching manual input, or create one (e.g. sports cards not in any API). */
async function findOrCreateCard(ctx: AppContext, b: Extract<z.infer<typeof resolveBody>, { game: string }>): Promise<string> {
  const [game] = await ctx.db.select().from(games).where(eq(games.slug, b.game));
  if (!game) throw badRequest('Unknown game');
  let setId: string | null = null;
  if (b.setName) {
    const [s] = await ctx.db
      .insert(sets)
      .values({ gameId: game.id, name: b.setName, slug: slugify(b.setName), code: b.setCode ?? null })
      .onConflictDoUpdate({ target: [sets.gameId, sets.slug], set: { name: b.setName } })
      .returning({ id: sets.id });
    setId = s!.id;
  }
  const norm = normalizeCollectorNumber(b.collectorNumber);
  const existing = await ctx.db.execute(sql`
    SELECT id FROM cards WHERE game_id = ${game.id} AND lower(name) = lower(${b.name})
      AND ${setId ? sql`set_id = ${setId}` : sql`set_id IS NULL`} AND collector_number_norm = ${norm} LIMIT 1`);
  if (existing[0]) return String(existing[0].id);
  const [card] = await ctx.db
    .insert(cards)
    .values({
      gameId: game.id,
      setId,
      name: b.name,
      collectorNumber: b.collectorNumber,
      collectorNumberNorm: norm,
      rarity: b.rarity ?? null,
      metadata: parseAttributes(b.game, b.attributes ?? {}),
      externalIds: { manual: 'true' },
    })
    .returning({ id: cards.id });
  return card!.id;
}

export async function manualReviewRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/manual-review', { preHandler: requireUser }, async (req) => {
    const me = currentUser(req);
    const q = parse(z.object({ status: z.enum(['OPEN', 'RESOLVED', 'REJECTED']).default('OPEN'), scope: z.enum(['mine', 'all']).default('all') }), req.query);
    const rows = await ctx.db.execute(sql`
      SELECT r.*, s.image_path, s.thumbnail_path, s.user_id AS scan_user, s.confidence, s.game_hint, u.display_name AS owner_name
      FROM manual_reviews r JOIN scans s ON s.id = r.scan_id JOIN users u ON u.id = s.user_id
      WHERE r.status = ${q.status} ${q.scope === 'mine' ? sql`AND s.user_id = ${me.id}` : sql``}
      ORDER BY r.created_at ASC LIMIT 200`);
    // Candidate suggestions from the identifier
    const scanIds = rows.map((r) => String(r.scan_id));
    const cands = scanIds.length
      ? await ctx.db.execute(sql`
          SELECT i.scan_id, i.card_id, i.confidence, i.rank, i.raw_result->'ocr' AS ocr, c.name, c.collector_number, c.image_url, c.rarity, s.name AS set_name, g.slug AS game
          FROM identifications i LEFT JOIN cards c ON c.id = i.card_id LEFT JOIN sets s ON s.id = c.set_id LEFT JOIN games g ON g.id = c.game_id
          WHERE i.scan_id IN (${sql.join(scanIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY i.rank`)
      : [];
    return {
      reviews: rows.map((r) => ({
        id: r.id,
        scanId: r.scan_id,
        status: r.status,
        reason: r.reason,
        ownerName: r.owner_name,
        confidence: r.confidence,
        gameHint: r.game_hint,
        image: `/api/files/${r.image_path}`,
        thumbnail: r.thumbnail_path ? `/api/files/${r.thumbnail_path}` : null,
        original: r.original_identification,
        corrected: r.corrected_identification,
        createdAt: r.created_at,
        candidates: cands.filter((c) => c.scan_id === r.scan_id && c.card_id),
        ocr: cands.find((c) => c.scan_id === r.scan_id)?.ocr ?? null,
      })),
    };
  });

  app.post<{ Params: { id: string } }>('/api/manual-review/:id/resolve', { preHandler: requireUser }, async (req) => {
    parse(uuid, req.params.id);
    const me = currentUser(req);
    const [review] = await ctx.db.select().from(manualReviews).where(eq(manualReviews.id, req.params.id));
    if (!review) throw notFound();
    if (review.status !== 'OPEN') throw badRequest('Review already closed');
    const [scan] = await ctx.db.select().from(scans).where(eq(scans.id, review.scanId));
    if (!scan) throw notFound();
    if (scan.userId !== me.id && me.role !== 'ADMIN') throw forbidden('Only the scan owner or an admin can resolve this');
    const b = parse(resolveBody, req.body);
    const cardId = 'cardId' in b ? b.cardId : await findOrCreateCard(ctx, b);
    const card = await getCard(ctx, cardId);
    if (!card) throw badRequest('Unknown card');
    const variantType = b.variant ?? card.variants[0]?.type ?? 'NORMAL';
    const variantId = await ensureVariant(ctx, cardId, variantType);

    await ctx.db.transaction(async (tx) => {
      await tx
        .update(manualReviews)
        .set({
          status: 'RESOLVED',
          resolvedBy: me.id,
          completedAt: new Date(),
          notes: b.notes ?? null,
          correctedIdentification: { cardId, variant: variantType, input: b, by: me.username, at: new Date().toISOString() },
        })
        .where(eq(manualReviews.id, review.id));
      await tx.insert(identifications).values({ scanId: scan.id, cardId, variantId, confidence: 1, method: 'MANUAL', rank: -1, rawResult: { resolvedBy: me.id, reviewId: review.id } });
      await tx.update(scans).set({ status: 'RESEARCHING', cardId, variantId, confidence: 1, updatedAt: new Date() }).where(eq(scans.id, scan.id));
      await tx
        .update(researchJobs)
        .set({ status: 'COMPLETED', stage: 'Resolved manually', completedAt: new Date(), cardId })
        .where(and(eq(researchJobs.scanId, scan.id), eq(researchJobs.status, 'MANUAL_REVIEW')));
    });
    const itemId = await addScanToCollection(ctx, scan.id, cardId, variantId, { condition: b.condition });
    const jobId = await enqueueResearch(ctx, { cardId, scanId: scan.id, userId: scan.userId, priority: 2, reason: 'MANUAL' });
    await audit(ctx, req, 'manual_review.resolve', 'manual_review', review.id, { scanId: scan.id, cardId, original: review.originalIdentification });
    await ctx.events.publish({ type: 'IDENTIFICATION_COMPLETE', userId: scan.userId, scanId: scan.id, cardId, message: `Identified manually: ${card.name}` });
    return { ok: true, cardId, collectionItemId: itemId, researchJobId: jobId };
  });

  app.post<{ Params: { id: string } }>('/api/manual-review/:id/reject', { preHandler: requireUser }, async (req) => {
    parse(uuid, req.params.id);
    const me = currentUser(req);
    const b = parse(z.object({ notes: z.string().max(2000).optional() }).default({}), req.body ?? {});
    const [review] = await ctx.db.select().from(manualReviews).where(eq(manualReviews.id, req.params.id));
    if (!review) throw notFound();
    const [scan] = await ctx.db.select().from(scans).where(eq(scans.id, review.scanId));
    if (scan && scan.userId !== me.id && me.role !== 'ADMIN') throw forbidden();
    await ctx.db.update(manualReviews).set({ status: 'REJECTED', resolvedBy: me.id, completedAt: new Date(), notes: b.notes ?? null }).where(eq(manualReviews.id, review.id));
    await ctx.db.update(scans).set({ status: 'REJECTED', updatedAt: new Date() }).where(eq(scans.id, review.scanId));
    await ctx.db
      .update(researchJobs)
      .set({ status: 'CANCELLED', stage: 'Scan rejected', completedAt: new Date() })
      .where(and(eq(researchJobs.scanId, review.scanId), eq(researchJobs.status, 'MANUAL_REVIEW')));
    await audit(ctx, req, 'manual_review.reject', 'manual_review', review.id);
    return { ok: true };
  });
}
