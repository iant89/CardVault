import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { desc, eq, ocrEvaluations, ocrExams, ocrSamples, sql } from '@cardvault/database';
import { resolveStoragePath } from '@cardvault/imaging';
import type { AppContext } from '../context.js';
import { requireAdmin, user as currentUser } from '../auth/plugin.js';
import { badRequest, notFound } from '../errors.js';

/** Most groups (a scan's lines, or a harvested card's) an exam takes from each kind of source. */
const EXAM_CAP = { real: 1500, harvest: 500 };
const TRUSTED = sql`('review', 'corroborated', 'harvest')`;
const IMPORT_KEY = 'ocr:import-harvest';

/**
 * OCR Lab (admins): the data collected from scans, the frozen exam, and
 * engine evaluations. Heavy work (reading crops, importing) runs in the worker.
 */
export async function ocrLabRoutes(app: FastifyInstance, ctx: AppContext) {
  if (!ctx.config.DEV_TOOLS) return;
  const guard = { preHandler: requireAdmin };

  app.get('/api/dev/ocr', guard, async () => {
    const counts = await ctx.db.execute(sql`
      SELECT label_source AS source, field, COALESCE(split, '-') AS split, count(*)::int AS n
      FROM ocr_samples GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`);
    const [totals] = await ctx.db.execute(sql`
      SELECT count(*)::int AS samples,
             count(*) FILTER (WHERE regression)::int AS regression,
             count(DISTINCT card_id)::int AS cards,
             count(DISTINCT group_key) FILTER (WHERE split = 'exam' AND label_source IN ${TRUSTED} AND label_norm IS NOT NULL)::int AS exam_groups,
             count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS last7days
      FROM ocr_samples`);
    const [exam] = await ctx.db.select().from(ocrExams).orderBy(desc(ocrExams.version)).limit(1);
    let newSinceExam = 0;
    if (exam) {
      const [r] = await ctx.db.execute(sql`
        SELECT count(DISTINCT group_key)::int AS n FROM ocr_samples
        WHERE split = 'exam' AND label_source IN ${TRUSTED} AND label_norm IS NOT NULL
          AND NOT (id::text = ANY (SELECT jsonb_array_elements_text(${JSON.stringify(exam.sampleIds)}::jsonb)))`);
      newSinceExam = Number(r?.n ?? 0);
    }
    const evaluations = await ctx.db
      .select({
        id: ocrEvaluations.id,
        engine: ocrEvaluations.engine,
        examVersion: ocrEvaluations.examVersion,
        status: ocrEvaluations.status,
        progress: ocrEvaluations.progress,
        summary: ocrEvaluations.summary,
        error: ocrEvaluations.error,
        createdAt: ocrEvaluations.createdAt,
        completedAt: ocrEvaluations.completedAt,
      })
      .from(ocrEvaluations)
      .orderBy(desc(ocrEvaluations.createdAt))
      .limit(20);
    const imp = await ctx.redis.get(IMPORT_KEY);
    return {
      counts,
      totals,
      exam: exam ? { id: exam.id, version: exam.version, size: exam.sampleIds.length, counts: exam.counts, note: exam.note, createdAt: exam.createdAt } : null,
      newSinceExam,
      import: imp ? JSON.parse(imp) : null,
      evaluations,
    };
  });

  /** Freeze a new exam version from every trusted sample on the exam side (capped, chosen by a stable hash). */
  app.post('/api/dev/ocr/exams', guard, async (req) => {
    const b = z.object({ note: z.string().max(500).optional() }).parse(req.body ?? {});
    const rows = await ctx.db.execute(sql`
      WITH eligible AS (
        SELECT id, group_key, label_source, field FROM ocr_samples
        WHERE split = 'exam' AND label_source IN ${TRUSTED} AND label_norm IS NOT NULL
      ), groups AS (
        SELECT group_key, CASE WHEN bool_or(label_source = 'harvest') THEN 'harvest' ELSE 'real' END AS kind, md5(group_key) AS h
        FROM eligible GROUP BY group_key
      ), chosen AS (
        SELECT group_key FROM (SELECT group_key, kind, row_number() OVER (PARTITION BY kind ORDER BY h) AS rn FROM groups) g
        WHERE (kind = 'real' AND rn <= ${EXAM_CAP.real}) OR (kind = 'harvest' AND rn <= ${EXAM_CAP.harvest})
      )
      SELECT e.id, e.label_source AS source, e.field FROM eligible e JOIN chosen USING (group_key) ORDER BY e.id`);
    if (!rows.length) throw badRequest('No labelled exam samples yet. Scan and confirm some cards, or import harvested cards first.');
    const counts: Record<string, number> = {};
    for (const r of rows) counts[`${r.source} · ${r.field}`] = (counts[`${r.source} · ${r.field}`] ?? 0) + 1;
    const [last] = await ctx.db.select({ v: ocrExams.version }).from(ocrExams).orderBy(desc(ocrExams.version)).limit(1);
    const [exam] = await ctx.db
      .insert(ocrExams)
      .values({ version: (last?.v ?? 0) + 1, sampleIds: rows.map((r) => String(r.id)), counts, note: b.note ?? null, createdBy: currentUser(req).id })
      .returning();
    return { exam: { id: exam!.id, version: exam!.version, size: exam!.sampleIds.length, counts } };
  });

  app.post('/api/dev/ocr/evaluations', guard, async (req) => {
    const [exam] = await ctx.db.select({ id: ocrExams.id, version: ocrExams.version }).from(ocrExams).orderBy(desc(ocrExams.version)).limit(1);
    if (!exam) throw badRequest('Freeze an exam first.');
    const running = await ctx.db.execute(sql`SELECT 1 FROM ocr_evaluations WHERE status IN ('queued', 'running') LIMIT 1`);
    if (running.length) throw badRequest('An evaluation is already running.');
    const [ev] = await ctx.db
      .insert(ocrEvaluations)
      .values({ examId: exam.id, examVersion: exam.version, engine: 'current', requestedBy: currentUser(req).id })
      .returning({ id: ocrEvaluations.id });
    await ctx.queues.maintenance.add('ocr-evaluate', { evaluationId: ev!.id }, { removeOnComplete: 50, removeOnFail: 50 });
    return { id: ev!.id };
  });

  app.get<{ Params: { id: string } }>('/api/dev/ocr/evaluations/:id', guard, async (req) => {
    const id = z.string().uuid().parse(req.params.id);
    const [ev] = await ctx.db.select().from(ocrEvaluations).where(eq(ocrEvaluations.id, id));
    if (!ev) throw notFound();
    return ev;
  });

  app.post('/api/dev/ocr/import-harvest', guard, async (req) => {
    const b = z.object({ limit: z.number().int().min(0).max(100_000).optional() }).parse(req.body ?? {});
    await ctx.redis.set(IMPORT_KEY, JSON.stringify({ status: 'queued', updatedAt: new Date().toISOString() }), 'EX', 7 * 24 * 3600);
    await ctx.queues.maintenance.add('ocr-import-harvest', { limit: b.limit ?? 0 }, { removeOnComplete: 20, removeOnFail: 20 });
    return { ok: true };
  });

  app.get('/api/dev/ocr/samples', guard, async (req) => {
    const q = z
      .object({
        source: z.string().max(20).optional(),
        field: z.enum(['name', 'number']).optional(),
        regression: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(60),
      })
      .parse(req.query);
    const where = [
      q.source ? sql`label_source = ${q.source}` : sql`true`,
      q.field ? sql`field = ${q.field}` : sql`true`,
      q.regression ? sql`regression = ${q.regression === 'true'}` : sql`true`,
    ];
    const rows = await ctx.db.execute(sql`
      SELECT id, field, game, region, predicted, label_text AS "labelText", label_norm AS "labelNorm",
             label_source AS source, split, regression, meta->>'era' AS era, engine, created_at AS "createdAt"
      FROM ocr_samples WHERE ${sql.join(where, sql` AND `)} ORDER BY created_at DESC LIMIT ${q.limit}`);
    return { samples: rows };
  });

  app.get<{ Params: { id: string } }>('/api/dev/ocr/samples/:id/crop', guard, async (req, reply) => {
    const id = z.string().uuid().parse(req.params.id);
    const [s] = await ctx.db.select({ path: ocrSamples.cropPath }).from(ocrSamples).where(eq(ocrSamples.id, id));
    if (!s) throw notFound();
    const abs = resolveStoragePath(ctx.storageDir, s.path);
    if (!(await stat(abs).catch(() => null))?.isFile()) throw notFound();
    reply.header('content-type', 'image/png');
    reply.header('cache-control', 'private, max-age=86400');
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(createReadStream(abs));
  });
}
