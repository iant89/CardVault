import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, collectionItems, cards, sql } from '@cardvault/database';
import { CONDITIONS, GRADING_COMPANIES, GRADING_STATUS } from '@cardvault/shared';
import type { AppContext } from '../context.js';
import { badRequest, forbidden, notFound, parse } from '../errors.js';
import { requireUser, user as currentUser } from '../auth/plugin.js';
import { duplicates, getItem, listCollection, valueByGame, valueBySet, valueHistory } from '../services/collection.js';
import { enqueueResearch, ensureVariant } from '../services/pipeline.js';
import { audit } from '../services/audit.js';

const uuid = z.string().uuid();
const grading = z
  .object({
    status: z.enum(GRADING_STATUS),
    company: z.enum(GRADING_COMPANIES).optional(),
    grade: z.string().max(10).optional(),
    certNumber: z.string().max(40).optional(),
  })
  .partial({ status: true });

const itemBody = z.object({
  cardId: uuid,
  variantId: uuid.nullish(),
  variantType: z.string().max(32).optional(),
  condition: z.enum(CONDITIONS).default('NM'),
  grading: grading.optional(),
  quantity: z.number().int().min(1).max(9999).default(1),
  purchasePrice: z.number().min(0).max(10_000_000).nullish(),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  source: z.string().max(100).nullish(),
  notes: z.string().max(2000).nullish(),
  favorite: z.boolean().optional(),
});

const listQ = z.object({
  user: z.union([uuid, z.literal('all')]).optional(),
  q: z.string().max(200).optional(),
  game: z.string().max(32).optional(),
  setId: uuid.optional(),
  rarity: z.string().max(64).optional(),
  variant: z.string().max(32).optional(),
  condition: z.enum(CONDITIONS).optional(),
  minPrice: z.coerce.number().optional(),
  maxPrice: z.coerce.number().optional(),
  minTrend: z.coerce.number().optional(),
  year: z.coerce.number().int().optional(),
  favorite: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  sort: z.enum(['recent', 'value', 'name', 'trend', 'number']).default('recent'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(60),
});

async function assertOwner(ctx: AppContext, id: string, me: { id: string; role: string }) {
  const [row] = await ctx.db.select().from(collectionItems).where(eq(collectionItems.id, id));
  if (!row) throw notFound();
  if (row.userId !== me.id && me.role !== 'ADMIN') throw forbidden('You can only edit your own collection');
  return row;
}

export async function collectionRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Family members may browse each other's collections; editing is owner/admin only. */
  app.get('/api/collection', { preHandler: requireUser }, async (req) => {
    const me = currentUser(req);
    const { page, pageSize, user, ...f } = parse(listQ, req.query);
    return listCollection(ctx, { ...f, userId: user === 'all' ? undefined : (user ?? me.id) }, page, pageSize);
  });

  app.get('/api/collection/summary', { preHandler: requireUser }, async (req) => {
    const me = currentUser(req);
    const { user } = parse(z.object({ user: uuid.optional() }), req.query);
    const uid = user ?? me.id;
    const byGame = await valueByGame(ctx, uid);
    const total = byGame.reduce((a, g) => a + g.value, 0);
    const history = await valueHistory(ctx, uid);
    const at = (days: number) => {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
      const past = [...history].reverse().find((h) => h.day <= cutoff);
      return past?.value ?? null;
    };
    const monthAgo = at(30);
    const jobs = await ctx.db.execute(sql`
      SELECT status, count(*)::int AS n FROM research_jobs
      WHERE user_id = ${uid} AND created_at > now() - interval '7 days' GROUP BY status`);
    const recent = await ctx.db.execute(sql`
      SELECT s.id, s.status, s.thumbnail_path, s.created_at, c.id AS card_id, c.name, c.image_url, c.image_path
      FROM scans s LEFT JOIN cards c ON c.id = s.card_id WHERE s.user_id = ${uid}
      ORDER BY s.created_at DESC LIMIT 10`);
    const sets = await valueBySet(ctx, uid);
    return {
      totalValue: Math.round(total * 100) / 100,
      changeMonth: monthAgo == null ? null : Math.round((total - monthAgo) * 100) / 100,
      historical: { today: total, d7: at(7), d30: monthAgo, d90: at(90) },
      byGame,
      sets,
      history,
      jobs: Object.fromEntries(jobs.map((j) => [String(j.status), Number(j.n)])),
      recentScans: recent.map((r) => ({
        id: r.id,
        status: r.status,
        createdAt: r.created_at,
        cardId: r.card_id,
        name: r.name,
        image: r.image_path ? `/api/files/${r.image_path}` : (r.image_url ?? (r.thumbnail_path ? `/api/files/${r.thumbnail_path}` : null)),
      })),
    };
  });

  app.get('/api/collection/value-by-user', { preHandler: requireUser }, async () => {
    const rows = await ctx.db.execute(sql`SELECT id, display_name FROM users WHERE active ORDER BY created_at`);
    const out = [];
    for (const r of rows) {
      const byGame = await valueByGame(ctx, String(r.id));
      out.push({ userId: r.id, displayName: r.display_name, byGame, total: byGame.reduce((a, g) => a + g.value, 0) });
    }
    return { users: out };
  });

  app.get('/api/collection/duplicates', { preHandler: requireUser }, async (req) => ({ duplicates: await duplicates(ctx, currentUser(req).id) }));

  app.get<{ Params: { id: string } }>('/api/collection/:id', { preHandler: requireUser }, async (req) => {
    parse(uuid, req.params.id);
    const item = await getItem(ctx, req.params.id);
    if (!item) throw notFound();
    return { item };
  });

  app.post('/api/collection', { preHandler: requireUser }, async (req) => {
    const me = currentUser(req);
    const b = parse(itemBody, req.body);
    const [card] = await ctx.db.select({ id: cards.id }).from(cards).where(eq(cards.id, b.cardId));
    if (!card) throw badRequest('Unknown card');
    const variantId = b.variantId ?? (b.variantType ? await ensureVariant(ctx, card.id, b.variantType) : null);
    const [row] = await ctx.db
      .insert(collectionItems)
      .values({
        userId: me.id,
        cardId: card.id,
        variantId,
        condition: b.condition,
        grading: b.grading ?? { status: 'RAW' },
        quantity: b.quantity,
        purchasePrice: b.purchasePrice ?? null,
        purchaseDate: b.purchaseDate ?? null,
        source: b.source ?? 'manual',
        notes: b.notes ?? null,
        favorite: b.favorite ?? false,
      })
      .returning();
    await audit(ctx, req, 'collection.add', 'collection_item', row!.id, { cardId: card.id });
    await enqueueResearch(ctx, { cardId: card.id, userId: me.id, reason: 'MANUAL' });
    return { item: await getItem(ctx, row!.id) };
  });

  app.patch<{ Params: { id: string } }>('/api/collection/:id', { preHandler: requireUser }, async (req) => {
    parse(uuid, req.params.id);
    const me = currentUser(req);
    const existing = await assertOwner(ctx, req.params.id, me);
    const b = parse(itemBody.omit({ cardId: true }).partial(), req.body);
    const patch: Partial<typeof collectionItems.$inferInsert> = { updatedAt: new Date() };
    if (b.variantType) patch.variantId = await ensureVariant(ctx, existing.cardId, b.variantType);
    else if (b.variantId !== undefined) patch.variantId = b.variantId;
    for (const k of ['condition', 'grading', 'quantity', 'purchasePrice', 'purchaseDate', 'source', 'notes', 'favorite'] as const) {
      if (b[k] !== undefined) (patch as Record<string, unknown>)[k] = b[k];
    }
    await ctx.db.update(collectionItems).set(patch).where(eq(collectionItems.id, existing.id));
    await audit(ctx, req, 'collection.update', 'collection_item', existing.id, { fields: Object.keys(b) });
    return { item: await getItem(ctx, existing.id) };
  });

  app.delete<{ Params: { id: string } }>('/api/collection/:id', { preHandler: requireUser }, async (req) => {
    parse(uuid, req.params.id);
    const existing = await assertOwner(ctx, req.params.id, currentUser(req));
    await ctx.db.execute(sql`UPDATE scans SET collection_item_id = NULL WHERE collection_item_id = ${existing.id}`);
    await ctx.db.delete(collectionItems).where(eq(collectionItems.id, existing.id));
    await audit(ctx, req, 'collection.delete', 'collection_item', existing.id, { cardId: existing.cardId });
    return { ok: true };
  });
}
