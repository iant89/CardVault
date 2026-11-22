import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, auditLog, desc, eq, ocrEvaluations, ocrExams, ocrModels, ocrSamples, sql } from '@cardvault/database';
import { resolveStoragePath } from '@cardvault/imaging';
import type { AppContext } from '../context.js';
import { requireAdmin, user as currentUser } from '../auth/plugin.js';
import { badRequest, notFound } from '../errors.js';
import { gates, trialGate, type EvalLike, type TrialLike } from '../services/ocr-gates.js';

/** Most groups (a scan's lines, or a harvested card's) an exam takes from each kind of source. */
const EXAM_CAP = { real: 1500, harvest: 500 };
const TRUSTED = sql`('review', 'corroborated', 'harvest')`;
const IMPORT_KEY = 'ocr:import-harvest';
const DATASET_KEY = 'ocr:dataset';

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
    const dataset = await ctx.redis.get(DATASET_KEY);
    return {
      counts,
      totals,
      exam: exam ? { id: exam.id, version: exam.version, size: exam.sampleIds.length, counts: exam.counts, note: exam.note, createdAt: exam.createdAt } : null,
      newSinceExam,
      import: imp ? JSON.parse(imp) : null,
      dataset: dataset ? JSON.parse(dataset) : null,
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

  /** Queue scoring of an engine ('tesseract' or 'model:<id>') on the latest exam. */
  const startEvaluation = async (engine: string, userId: string) => {
    const [exam] = await ctx.db.select({ id: ocrExams.id, version: ocrExams.version }).from(ocrExams).orderBy(desc(ocrExams.version)).limit(1);
    if (!exam) throw badRequest('Freeze an exam first.');
    const running = await ctx.db.execute(sql`SELECT 1 FROM ocr_evaluations WHERE status IN ('queued', 'running') LIMIT 1`);
    if (running.length) throw badRequest('An evaluation is already running.');
    const [ev] = await ctx.db.insert(ocrEvaluations).values({ examId: exam.id, examVersion: exam.version, engine, requestedBy: userId }).returning({ id: ocrEvaluations.id });
    await ctx.queues.maintenance.add('ocr-evaluate', { evaluationId: ev!.id }, { removeOnComplete: 50, removeOnFail: 50 });
    return { id: ev!.id };
  };

  app.post('/api/dev/ocr/evaluations', guard, async (req) => startEvaluation('tesseract', currentUser(req).id));

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

  // ---------------------------------------------------------------- training data & models

  app.post('/api/dev/ocr/export', guard, async () => {
    await ctx.queues.maintenance.add('ocr-export-dataset', {}, { removeOnComplete: 20, removeOnFail: 20 });
    return { ok: true };
  });

  app.post('/api/dev/ocr/models/rescan', guard, async () => {
    await ctx.queues.maintenance.add('ocr-scan-models', {}, { removeOnComplete: 20, removeOnFail: 20 });
    return { ok: true };
  });

  /** Latest finished evaluation of an engine on an exam version. */
  const latestEval = async (engine: string, examVersion: number) => {
    const [e] = await ctx.db
      .select()
      .from(ocrEvaluations)
      .where(and(eq(ocrEvaluations.engine, engine), eq(ocrEvaluations.examVersion, examVersion), eq(ocrEvaluations.status, 'done')))
      .orderBy(desc(ocrEvaluations.completedAt))
      .limit(1);
    return (e as unknown as EvalLike) ?? null;
  };

  /** The engine reading live scans now, and its score on the given exam version. */
  const champion = async (examVersion: number) => {
    const [active] = await ctx.db.select({ id: ocrModels.id }).from(ocrModels).where(eq(ocrModels.status, 'active')).limit(1);
    if (active) return { engine: `model:${active.id}`, eval: await latestEval(`model:${active.id}`, examVersion) };
    const tess = await ctx.db.execute(sql`
      SELECT engine FROM ocr_evaluations WHERE engine LIKE 'tesseract%' AND exam_version = ${examVersion} AND status = 'done'
      ORDER BY completed_at DESC LIMIT 1`);
    const engine = tess[0] ? String(tess[0].engine) : 'tesseract';
    return { engine, eval: await latestEval(engine, examVersion) };
  };

  const modelView = async () => {
    const [exam] = await ctx.db.select({ version: ocrExams.version }).from(ocrExams).orderBy(desc(ocrExams.version)).limit(1);
    const models = await ctx.db.select().from(ocrModels).orderBy(desc(ocrModels.createdAt));
    const champ = exam ? await champion(exam.version) : null;
    const rows = [];
    for (const m of models) {
      const ev = exam ? await latestEval(`model:${m.id}`, exam.version) : null;
      const g = ev && m.status !== 'active' ? gates(ev, champ?.eval ?? null) : [];
      const tg = ev && m.status !== 'active' ? trialGate(m.trial as TrialLike | null, ctx.config.OCR_TRIAL_MIN_LINES) : null;
      if (tg) g.push(tg);
      const card = m.card as Record<string, unknown>;
      rows.push({
        id: m.id,
        status: m.status,
        createdAt: m.createdAt,
        activatedAt: m.activatedAt,
        dataset: card.dataset ?? null,
        training: card.training ?? null,
        dev: card.dev ?? null,
        evaluation: ev ? { id: ev.id, examVersion: ev.examVersion, summary: ev.summary } : null,
        gates: g,
        canPromote: m.status !== 'active' && g.length > 0 && g.every((x) => x.pass),
        trial: m.trial ?? null,
        trialStartedAt: m.trialStartedAt,
        watch: m.watch ?? null,
        previousEngine: m.previousEngine,
        retiredAt: m.retiredAt,
        retiredReason: m.retiredReason,
      });
    }
    const events = await ctx.db
      .select({ action: auditLog.action, entityId: auditLog.entityId, metadata: auditLog.metadata, createdAt: auditLog.createdAt })
      .from(auditLog)
      .where(eq(auditLog.entity, 'ocr_model'))
      .orderBy(desc(auditLog.createdAt))
      .limit(10);
    return {
      examVersion: exam?.version ?? null,
      champion: champ ? { engine: champ.engine, evaluationId: champ.eval?.id ?? null } : null,
      trialMinLines: ctx.config.OCR_TRIAL_MIN_LINES,
      models: rows,
      events,
    };
  };

  app.get('/api/dev/ocr/models', guard, async () => modelView());

  app.post<{ Params: { id: string } }>('/api/dev/ocr/models/:id/evaluate', guard, async (req) => {
    const [m] = await ctx.db.select({ id: ocrModels.id }).from(ocrModels).where(eq(ocrModels.id, req.params.id));
    if (!m) throw notFound();
    return startEvaluation(`model:${m.id}`, currentUser(req).id);
  });

  /** Make a model read live scans. Refused unless every gate passes on the current exam. */
  app.post<{ Params: { id: string } }>('/api/dev/ocr/models/:id/promote', guard, async (req) => {
    const view = await modelView();
    const m = view.models.find((x) => x.id === req.params.id);
    if (!m) throw notFound();
    if (!m.canPromote) {
      const failed = m.gates.filter((g) => !g.pass).map((g) => `${g.label}: ${g.detail}`);
      throw badRequest(`Not promoted. ${failed.length ? failed.join(' · ') : 'Score it on the current exam first.'}`);
    }
    const [current] = await ctx.db.select({ id: ocrModels.id }).from(ocrModels).where(eq(ocrModels.status, 'active')).limit(1);
    await ctx.db.transaction(async (tx) => {
      await tx.update(ocrModels).set({ status: 'retired', retiredAt: new Date(), retiredReason: `replaced by ${m.id}` }).where(eq(ocrModels.status, 'active'));
      await tx
        .update(ocrModels)
        .set({ status: 'active', activatedAt: new Date(), activatedBy: currentUser(req).id, previousEngine: current ? `model:${current.id}` : 'tesseract', watch: null, retiredAt: null, retiredReason: null })
        .where(eq(ocrModels.id, m.id));
      await tx.insert(auditLog).values({ userId: currentUser(req).id, action: 'ocr.promote', entity: 'ocr_model', entityId: m.id, metadata: { previous: current ? current.id : 'tesseract' } });
    });
    req.log.info({ model: m.id }, 'OCR model promoted');
    return { ok: true };
  });

  /** Stop using the active model: live scans go back to the previous engine (a model, or Tesseract) within 30 seconds. */
  app.post('/api/dev/ocr/models/rollback', guard, async (req) => {
    const [m] = await ctx.db.select().from(ocrModels).where(eq(ocrModels.status, 'active')).limit(1);
    if (!m) return { ok: true, restored: 'tesseract' };
    const prev = m.previousEngine?.startsWith('model:') ? m.previousEngine.slice('model:'.length) : null;
    await ctx.db.transaction(async (tx) => {
      await tx.update(ocrModels).set({ status: 'retired', retiredAt: new Date(), retiredReason: 'rolled back by hand' }).where(eq(ocrModels.id, m.id));
      if (prev) await tx.update(ocrModels).set({ status: 'active', activatedAt: new Date(), retiredReason: null }).where(eq(ocrModels.id, prev));
      await tx.insert(auditLog).values({ userId: currentUser(req).id, action: 'ocr.rollback', entity: 'ocr_model', entityId: m.id, metadata: { restored: prev ?? 'tesseract' } });
    });
    req.log.info({ model: m.id, restored: prev ?? 'tesseract' }, 'OCR model rolled back');
    return { ok: true, retired: m.id, restored: prev ?? 'tesseract' };
  });

  /** Start a live trial: the model reads every new scan alongside the live engine, recorded only. */
  app.post<{ Params: { id: string } }>('/api/dev/ocr/models/:id/trial', guard, async (req) => {
    const [m] = await ctx.db.select().from(ocrModels).where(eq(ocrModels.id, req.params.id));
    if (!m) throw notFound();
    if (m.status === 'active') throw badRequest('This model is already reading live scans.');
    await ctx.db.transaction(async (tx) => {
      await tx.update(ocrModels).set({ status: 'candidate' }).where(eq(ocrModels.status, 'shadow'));
      await tx.update(ocrModels).set({ status: 'shadow', trialStartedAt: new Date(), trial: null }).where(eq(ocrModels.id, m.id));
      await tx.insert(auditLog).values({ userId: currentUser(req).id, action: 'ocr.trial_start', entity: 'ocr_model', entityId: m.id });
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/dev/ocr/models/:id/trial/stop', guard, async (req) => {
    await ctx.db.update(ocrModels).set({ status: 'candidate' }).where(and(eq(ocrModels.id, req.params.id), eq(ocrModels.status, 'shadow')));
    return { ok: true };
  });

  /** Recompute trial and watch statistics now (normally every 15 minutes). */
  app.post('/api/dev/ocr/models/watch', guard, async () => {
    await ctx.queues.maintenance.add('ocr-watch', {}, { removeOnComplete: 20, removeOnFail: 20 });
    return { ok: true };
  });
}
