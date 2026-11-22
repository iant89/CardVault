import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, sql, scans, researchJobs } from '@cardvault/database';
import { ImageValidationError } from '@cardvault/imaging';
import { GAME_SLUGS } from '@cardvault/shared';
import type { AppContext } from '../context.js';
import { badRequest, forbidden, notFound, parse, HttpProblem } from '../errors.js';
import { requireUser, user as currentUser } from '../auth/plugin.js';
import { createScan, deleteScan, retakeScan } from '../services/pipeline.js';
import { audit } from '../services/audit.js';
import { getCard } from '../services/cards.js';

const fields = z.object({
  clientScanId: z.string().max(64).regex(/^[\w-]+$/).optional(),
  gameHint: z.enum(GAME_SLUGS).optional(),
  clientOcr: z.string().max(4000).optional(),
  capturedAt: z.coerce.date().optional(),
  allowDuplicate: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  quality: z.string().max(2000).optional(),
});

export async function scanRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post('/api/scans', { preHandler: requireUser, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const me = currentUser(req);
    const raw: Record<string, string> = {};
    let buffer: Buffer | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'image') throw badRequest('Unexpected file field');
        if (!/^image\/(jpeg|png|webp|heic|heif|avif)$/.test(part.mimetype)) throw badRequest('Only JPEG/PNG/WebP/HEIC images are accepted');
        buffer = await part.toBuffer();
      } else {
        raw[part.fieldname] = String(part.value);
      }
    }
    if (!buffer) throw badRequest('Missing image');
    const f = parse(fields, raw);
    let quality: Record<string, unknown> | undefined;
    try {
      quality = f.quality ? (JSON.parse(f.quality) as Record<string, unknown>) : undefined;
    } catch {
      quality = undefined;
    }
    try {
      const result = await createScan(ctx, me, {
        buffer,
        clientScanId: f.clientScanId,
        gameHint: f.gameHint,
        clientOcr: f.clientOcr,
        capturedAt: f.capturedAt,
        allowDuplicate: f.allowDuplicate,
        clientQuality: quality,
      });
      if (result.kind === 'duplicate') {
        reply.code(409);
        return { error: 'DUPLICATE_SCAN', message: 'You already scanned this card.', duplicate: result.duplicate };
      }
      reply.code(result.kind === 'created' ? 201 : 200);
      return { scanId: result.scanId, jobId: result.jobId, existing: result.kind === 'existing' };
    } catch (e) {
      if (e instanceof ImageValidationError) throw new HttpProblem(415, e.message);
      throw e;
    }
  });

  app.get('/api/scans', { preHandler: requireUser }, async (req) => {
    const me = currentUser(req);
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), status: z.string().optional() }), req.query);
    const rows = await ctx.db.execute(sql`
      SELECT s.id, s.status, s.confidence, s.thumbnail_path, s.created_at, s.card_id, s.collection_item_id, c.name AS card_name, c.image_url, c.image_path
      FROM scans s LEFT JOIN cards c ON c.id = s.card_id
      WHERE s.user_id = ${me.id} ${q.status ? sql`AND s.status = ${q.status}` : sql``}
      ORDER BY s.created_at DESC LIMIT ${q.limit}`);
    return {
      scans: rows.map((r) => ({
        id: r.id,
        status: r.status,
        confidence: r.confidence,
        thumbnail: r.thumbnail_path ? `/api/files/${r.thumbnail_path}` : null,
        createdAt: r.created_at,
        cardId: r.card_id,
        cardName: r.card_name,
        collectionItemId: r.collection_item_id,
        cardImage: r.image_path ? `/api/files/${r.image_path}` : r.image_url,
      })),
    };
  });

  app.get<{ Params: { id: string } }>('/api/scans/:id', { preHandler: requireUser }, async (req) => {
    const me = currentUser(req);
    const [scan] = await ctx.db.select().from(scans).where(eq(scans.id, req.params.id));
    if (!scan) throw notFound();
    if (scan.userId !== me.id && me.role !== 'ADMIN') throw forbidden();
    // candidates with their names so the UI can show "best guess" for unresolved scans
    const idents = await ctx.db.execute(sql`
      SELECT i.card_id AS "cardId", i.confidence, i.rank, i.method, i.raw_result->'ocr'->>'top' AS "ocrTop",
        c.name, c.collector_number AS "collectorNumber", s.name AS "setName"
      FROM identifications i LEFT JOIN cards c ON c.id = i.card_id LEFT JOIN sets s ON s.id = c.set_id
      WHERE i.scan_id = ${scan.id} ORDER BY i.created_at DESC, i.rank`);
    const jobs = await ctx.db.select().from(researchJobs).where(eq(researchJobs.scanId, scan.id)).orderBy(desc(researchJobs.createdAt));
    return {
      scan: {
        ...scan,
        image: `/api/files/${scan.imagePath}`,
        thumbnail: scan.thumbnailPath ? `/api/files/${scan.thumbnailPath}` : null,
      },
      card: scan.cardId ? await getCard(ctx, scan.cardId) : null,
      identifications: idents,
      jobs,
    };
  });

  /** Replace a scan's photo (see retakeScan for queue semantics). */
  app.post<{ Params: { id: string } }>('/api/scans/:id/retake', { preHandler: requireUser, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    parse(z.string().uuid(), req.params.id);
    const me = currentUser(req);
    const [scan] = await ctx.db.select().from(scans).where(eq(scans.id, req.params.id));
    if (!scan) throw notFound('This scan no longer exists');
    if (scan.userId !== me.id && me.role !== 'ADMIN') throw forbidden();
    let buffer: Buffer | null = null;
    let quality: Record<string, unknown> | undefined;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'image') throw badRequest('Unexpected file field');
        if (!/^image\/(jpeg|png|webp|heic|heif|avif)$/.test(part.mimetype)) throw badRequest('Only JPEG/PNG/WebP/HEIC images are accepted');
        buffer = await part.toBuffer();
      } else if (part.fieldname === 'quality') {
        try {
          quality = JSON.parse(String(part.value).slice(0, 2000)) as Record<string, unknown>;
        } catch {
          quality = undefined;
        }
      }
    }
    if (!buffer) throw badRequest('Missing image');
    try {
      const r = await retakeScan(ctx, scan.id, buffer, quality);
      await audit(ctx, req, 'scan.retake', 'scan', scan.id, { previousStatus: scan.status, previousCardId: scan.cardId, queue: r.requeued });
      return r;
    } catch (e) {
      if (e instanceof ImageValidationError) throw new HttpProblem(415, e.message);
      throw e;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/scans/:id', { preHandler: requireUser }, async (req) => {
    parse(z.string().uuid(), req.params.id);
    const me = currentUser(req);
    const [scan] = await ctx.db.select().from(scans).where(eq(scans.id, req.params.id));
    if (!scan) throw notFound('This scan no longer exists');
    if (scan.userId !== me.id && me.role !== 'ADMIN') throw forbidden();
    const r = await deleteScan(ctx, scan.id);
    await audit(ctx, req, 'scan.delete', 'scan', scan.id, { status: scan.status, cardId: scan.cardId, removedCopy: r.removedCopy });
    return { ok: true, ...r };
  });

  app.post<{ Params: { id: string } }>('/api/scans/:id/retry', { preHandler: requireUser }, async (req) => {
    const me = currentUser(req);
    const [scan] = await ctx.db.select().from(scans).where(eq(scans.id, req.params.id));
    if (!scan) throw notFound();
    if (scan.userId !== me.id && me.role !== 'ADMIN') throw forbidden();
    const [job] = await ctx.db
      .insert(researchJobs)
      .values({ scanId: scan.id, userId: scan.userId, queue: 'identification', label: 'Re-identify scan', stage: 'Queued for identification', priority: 2 })
      .returning();
    await ctx.db.update(researchJobs).set({ bullJobId: job!.id }).where(eq(researchJobs.id, job!.id));
    await ctx.db.update(scans).set({ status: 'UPLOADED', updatedAt: new Date() }).where(and(eq(scans.id, scan.id)));
    await ctx.queues.identification.add('identify', { scanId: scan.id, userId: scan.userId, gameHint: scan.gameHint ?? undefined, researchJobId: job!.id }, { jobId: job!.id, priority: 2 });
    await ctx.events.publish({ type: 'JOB_CREATED', userId: scan.userId, jobId: job!.id, scanId: scan.id, queue: 'identification', state: 'QUEUED' });
    return { jobId: job!.id };
  });
}
