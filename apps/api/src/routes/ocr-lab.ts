import { existsSync, createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const TRAIN_KEY = 'ocr:train';
const TRAIN_CANCEL_KEY = 'ocr:train:cancel';
const PYTHON_KEY = 'ocr:python';

/** Training run in progress, mirroring apps/worker/src/processors/ocr-train.ts. */
interface TrainStatus {
  status: 'queued' | 'starting' | 'running' | 'done' | 'failed' | 'cancelled';
  requested?: string;
  dataset?: string;
  lines?: number;
  epochs?: number;
  epoch?: number;
  loss?: number;
  devName?: number | null;
  devNumber?: number | null;
  minutes?: number;
  synthetic?: number;
  modelId?: string;
  python?: string;
  error?: string;
  log: string[];
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

/** What the setup script does, in order — shown as a checklist while it runs. */
const PYTHON_STEPS = [
  'Virtual environment',
  'PyTorch (CPU build)',
  'Trainer packages',
];

interface TrainerPython {
  status: 'unknown' | 'missing' | 'ready' | 'installing' | 'failed';
  /** interpreter the app will use (or expects after setup) */
  python?: string;
  error?: string;
  /** 1-based step being installed */
  step?: number;
  steps: string[];
  venv: string;
  /** OCR_TRAIN_PYTHON pins an interpreter; the setup button then only checks it */
  configured: boolean;
  manual: string;
  setupScript: string | null;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  log: string[];
}

const readTraining = async (ctx: AppContext): Promise<TrainStatus | null> => {
  const raw = await ctx.redis.get(TRAIN_KEY);
  return raw ? (JSON.parse(raw) as TrainStatus) : null;
};

/** Find scripts/ocr-python.sh by walking up from this file (src/ or dist/ layouts). */
export function findSetupScript(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 7; i++) {
    const candidate = path.join(dir, 'scripts', 'ocr-python.sh');
    if (existsSync(candidate)) return candidate;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** The interpreter the app will use, from the same places the worker looks. */
const expectedPython = (ctx: AppContext, venv: string): string => {
  const explicit = ctx.config.OCR_TRAIN_PYTHON;
  if (explicit) return explicit;
  const candidates = [venv, path.join(homedir(), 'ocr-venv'), '/opt/cardvault/ocr-venv'].flatMap((v) => [path.join(v, 'bin', 'python'), path.join(v, 'bin', 'python3')]);
  return candidates.find((p) => existsSync(p)) ?? path.join(venv, 'bin', 'python');
};

/**
 * The trainer's Python, as the worker last saw it (ocr:python), plus the paths
 * the setup uses. OCR Lab offers "Set up the OCR trainer" when it is missing.
 * With no report yet (fresh install, worker not up), a configured interpreter
 * or an existing venv is shown as ready — the worker re-checks before training.
 */
const trainerPython = async (ctx: AppContext): Promise<TrainerPython> => {
  const raw = await ctx.redis.get(PYTHON_KEY);
  const stored = raw ? (JSON.parse(raw) as Partial<TrainerPython>) : null;
  const venv = ctx.config.OCR_TRAIN_VENV ?? path.join(ctx.storageDir, 'ocr', 'venv');
  const setupScript = findSetupScript();
  const python = expectedPython(ctx, venv);
  const status = stored?.status ?? (existsSync(python) ? 'ready' : 'unknown');
  return {
    status,
    python: stored?.python ?? python,
    error: stored?.error,
    step: stored?.step,
    steps: PYTHON_STEPS,
    venv,
    configured: !!ctx.config.OCR_TRAIN_PYTHON,
    /** what to run over SSH when the button cannot be used (no worker, no internet) */
    manual: `bash scripts/ocr-python.sh   # then restart the worker, or set OCR_TRAIN_PYTHON=${path.join(venv, 'bin', 'python')}`,
    setupScript,
    updatedAt: stored?.updatedAt,
    startedAt: stored?.startedAt,
    finishedAt: stored?.finishedAt,
    log: stored?.log ?? [],
  };
};

/**
 * Finished exports under <storage>/ocr/datasets: the same rule as the trainer's
 * 'latest' — a dataset counts only with both train.jsonl and info.json.
 */
const listDatasets = async (ctx: AppContext) => {
  const root = path.join(ctx.storageDir, 'ocr', 'datasets');
  const out: { id: string; rows: number; counts: Record<string, number>; createdAt: string | null }[] = [];
  for (const name of (await readdir(root, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!name.isDirectory()) continue;
    try {
      const info = JSON.parse(await readFile(path.join(root, name.name, 'info.json'), 'utf8')) as { rows?: number; counts?: Record<string, number>; createdAt?: string };
      out.push({ id: name.name, rows: info.rows ?? 0, counts: info.counts ?? {}, createdAt: info.createdAt ?? null });
    } catch {
      /* interrupted export or stray folder: not usable */
    }
  }
  return out;
};

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
      datasets: await listDatasets(ctx),
      training: await readTraining(ctx),
      python: await trainerPython(ctx),
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

  // ---------------------------------------------------------------- training

  /**
   * Start training a line reader on an exported dataset (tools/ocr-trainer).
   * The worker runs the trainer and streams its progress into OCR Lab; the
   * finished model is registered for scoring automatically.
   */
  app.post('/api/dev/ocr/train', guard, async (req) => {
    const b = z
      .object({
        dataset: z.string().regex(/^(latest|[A-Za-z0-9][A-Za-z0-9._-]*)$/).default('latest'),
        epochs: z.coerce.number().int().min(1).max(500).default(30),
        synthetic: z.coerce.number().int().min(0).max(200_000).default(20_000),
        maxMinutes: z.coerce.number().min(0).max(10_080).default(0),
      })
      .parse(req.body ?? {});
    const current = await readTraining(ctx);
    if (current && ['queued', 'starting', 'running'].includes(current.status)) throw badRequest('Training is already in progress.');
    const datasets = await listDatasets(ctx);
    if (b.dataset === 'latest') {
      if (!datasets.length) throw badRequest('No exported datasets yet. Press Export training data first.');
    } else if (!datasets.some((d) => d.id === b.dataset)) {
      throw badRequest(`No usable dataset ${b.dataset}. Export training data first.`);
    }
    const status: TrainStatus = { status: 'queued', requested: b.dataset, epochs: b.epochs, synthetic: b.synthetic, log: [], updatedAt: new Date().toISOString() };
    await ctx.redis.set(TRAIN_KEY, JSON.stringify(status), 'EX', 7 * 24 * 3600);
    await ctx.redis.del(TRAIN_CANCEL_KEY);
    await ctx.queues.maintenance.add('ocr-train-model', b, { removeOnComplete: 20, removeOnFail: 20 });
    req.log.info({ dataset: b.dataset, epochs: b.epochs }, 'OCR training queued');
    return { ok: true };
  });

  /** Ask the running trainer to stop (it exits at the next step). */
  app.post('/api/dev/ocr/train/cancel', guard, async () => {
    await ctx.redis.set(TRAIN_CANCEL_KEY, '1', 'EX', 300);
    return { ok: true };
  });

  /**
   * Install (or check) the Python the trainer runs on: scripts/ocr-python.sh
   * builds a venv under storage with CPU PyTorch and the trainer's packages.
   * Runs in the worker, like training itself; progress lands in `ocr:python`.
   */
  app.post('/api/dev/ocr/train/python', guard, async () => {
    const py = await trainerPython(ctx);
    if (!py.setupScript) throw badRequest('scripts/ocr-python.sh was not found on this server.');
    if (py.status === 'installing') throw badRequest('The trainer setup is already running.');
    const current = await readTraining(ctx);
    if (current && ['queued', 'starting', 'running'].includes(current.status)) throw badRequest('Training is running; stop it before changing the trainer’s Python.');
    await ctx.redis.del(PYTHON_KEY);
    await ctx.queues.maintenance.add('ocr-python-setup', {}, { removeOnComplete: 20, removeOnFail: 20 });
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
