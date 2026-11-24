import { existsSync, createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, auditLog, desc, eq, inArray, ocrEvaluations, ocrExams, ocrModels, ocrSamples, sql } from '@cardvault/database';
import { resolveStoragePath } from '@cardvault/imaging';
import type { AppContext } from '../context.js';
import { requireAdmin, user as currentUser } from '../auth/plugin.js';
import { badRequest, notFound } from '../errors.js';
import { classifierGates, gates, trialGate, type EvalLike, type TrialLike } from '../services/ocr-gates.js';
import {
  forgetTask,
  listTasks,
  saveTask,
  TASK_KEY,
  taskKeyOf,
  taskProgress,
  toLabTask,
  type TaskRecord,
} from '@cardvault/jobs';
import { etaFromEpochs, etaFromPace, percent, summarizeQueue } from '@cardvault/shared';

/** Most groups (a scan's lines, or a harvested card's) an exam takes from each kind of source. */
const EXAM_CAP = { real: 1500, harvest: 500 };
const TRUSTED = sql`('review', 'corroborated', 'harvest')`;
const IMPORT_KEY = 'ocr:import-harvest';
const DATASET_KEY = 'ocr:dataset';
const TRAIN_KEY = 'ocr:train';
const TRAIN_CANCEL_KEY = 'ocr:train:cancel';
const PYTHON_KEY = 'ocr:python';
const VISION_KEY = 'ocr:vision';
const VISION_CANCEL_KEY = 'ocr:vision:cancel';

/** Is an `ocr_models.card` a whole-card game classifier rather than a line reader? */
const isClassifierCard = (card: unknown): boolean => (card as { task?: string } | null)?.task === 'card-classifier';

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
  /** overall step through the run, and the run's total (for the bar and the ETA) */
  step?: number;
  steps?: number;
  batch?: number;
  batches?: number;
  etaSeconds?: number | null;
  secondsPerEpoch?: number | null;
  bestEpoch?: number;
  bestName?: number | null;
  bestNumber?: number | null;
  history?: { epoch: number; loss: number; devName: number | null; devNumber: number | null; minutes: number }[];
  recent?: TrainSample[];
  requestedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

/** A CardVault-Vision run (`vision train` + `vision export` per head). */
interface VisionStatus {
  status: 'queued' | 'starting' | 'running' | 'exporting' | 'done' | 'failed' | 'cancelled';
  kind: string;
  dataset: string;
  manifest?: string;
  version?: string;
  epochs?: number;
  device?: string;
  stages: { task: string; state: string; bestMetric?: number | null; metricName?: string | null; epochs?: number; exportDir?: string; modelId?: string; error?: string }[];
  task?: string;
  epoch?: number;
  cer?: number | null;
  macroF1?: number | null;
  history?: { epoch: number; loss: number; cer?: number | null; macroF1?: number | null }[];
  step?: number;
  steps?: number;
  etaSeconds?: number | null;
  python?: string;
  error?: string;
  log: string[];
  startedAt?: string;
  finishedAt?: string;
  updatedAt?: string;
}

/** One held-out line as the trainer read it (see TrainStatus.recent). */
export interface TrainSample {
  id: number;
  field: 'name' | 'number';
  truth: string;
  predicted: string;
  /** 0..1 — the decoder's confidence in what it read */
  confidence: number;
  correct: boolean;
  /** crop, relative to the storage folder */
  crop: string | null;
  epoch: number;
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

/** The CardVault-Vision run in progress (mirrors apps/worker/src/processors/ocr-vision.ts). */
const readVision = async (ctx: AppContext): Promise<VisionStatus | null> => {
  const raw = await ctx.redis.get(VISION_KEY);
  return raw ? (JSON.parse(raw) as VisionStatus) : null;
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
  const out: { id: string; rows: number; counts: Record<string, number>; createdAt: string | null; vision: { samples: number; cards: number; fields: Record<string, number> } | null }[] = [];
  for (const name of (await readdir(root, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!name.isDirectory()) continue;
    try {
      const info = JSON.parse(await readFile(path.join(root, name.name, 'info.json'), 'utf8')) as {
        rows?: number;
        counts?: Record<string, number>;
        createdAt?: string;
        vision?: { samples: number; cards: number; fields: Record<string, number> } | null;
      };
      // an older export has no Vision manifest; the folder may still hold one
      // written by hand, so look rather than assume
      let vision = info.vision ?? null;
      if (!vision) {
        const manifest = await readFile(path.join(root, name.name, 'vision', 'manifest.json'), 'utf8').catch(() => null);
        if (manifest) {
          try {
            const m = JSON.parse(manifest) as { samples?: unknown[]; counts?: { cards?: number } };
            const fields: Record<string, number> = {};
            for (const s of (m.samples ?? []) as { annotation?: { fields?: Record<string, unknown> } }[]) for (const f of Object.keys(s.annotation?.fields ?? {})) fields[f] = (fields[f] ?? 0) + 1;
            vision = { samples: (m.samples ?? []).length, cards: m.counts?.cards ?? 0, fields };
          } catch {
            vision = null;
          }
        }
      }
      out.push({ id: name.name, rows: info.rows ?? 0, counts: info.counts ?? {}, createdAt: info.createdAt ?? null, vision });
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
      vision: await readVision(ctx),
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
    if (running.length) throw badRequest('An evaluation is already running. Follow it in the queue (top right), or stop it there first.');
    const [ev] = await ctx.db.insert(ocrEvaluations).values({ examId: exam.id, examVersion: exam.version, engine, requestedBy: userId }).returning({ id: ocrEvaluations.id });
    const engineLabel = engine.startsWith('model:') ? engine.slice('model:'.length) : 'Tesseract';
    // in the queue straight away, so pressing the button visibly does something
    await saveTask(ctx.redis, {
      key: `ocr-evaluate:${ev!.id}`,
      kind: 'evaluation',
      name: `Score ${engineLabel} on exam v${exam.version}`,
      state: 'queued',
      progress: 0,
      detail: 'Waiting for the worker…',
      retry: { path: engine.startsWith('model:') ? `/api/dev/ocr/models/${engine.slice('model:'.length)}/evaluate` : '/api/dev/ocr/evaluations', label: 'Score again' },
    });
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
    await saveTask(ctx.redis, {
      key: 'ocr-import',
      kind: 'import',
      name: 'Import harvested cards',
      state: 'queued',
      progress: 0,
      detail: b.limit ? `Up to ${b.limit.toLocaleString()} cards` : 'Every harvested card not imported yet',
      retry: { path: '/api/dev/ocr/import-harvest', body: { limit: b.limit ?? 0 }, label: 'Import again' },
    });
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

  /**
   * The crop of a held-out training line, by its path in the storage folder.
   * Training reads lines from an exported dataset, not from ocr_samples, so it
   * has no sample id to ask with; the path is checked to stay inside storage.
   */
  app.get('/api/dev/ocr/training/crop', guard, async (req, reply) => {
    const q = z.object({ path: z.string().min(3).max(400) }).parse(req.query);
    if (q.path.includes('..') || path.isAbsolute(q.path)) throw badRequest('Bad crop path.');
    const abs = resolveStoragePath(ctx.storageDir, q.path);
    if (!(await stat(abs).catch(() => null))?.isFile()) throw notFound();
    reply.header('content-type', 'image/png');
    reply.header('cache-control', 'private, max-age=86400');
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(createReadStream(abs));
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

  // ---------------------------------------------------------------- task queue

  /**
   * The queue as the page shows it: every task the lab has run, newest first.
   *
   * Most tasks are written by the worker as it works (packages/jobs tasks.ts).
   * The stores that predate the queue — a training run's `ocr:train`, the
   * Python setup's `ocr:python`, the harvest import, an evaluation row —
   * are folded in here, so the queue is the one place to see what the lab is
   * doing even when a worker restarted mid-task and never marked it finished.
   */
  app.get('/api/dev/ocr/queue', guard, async () => {
    const records = new Map<string, TaskRecord>();
    for (const t of await listTasks(ctx.redis)) records.set(t.key, t);

    // ---- stores written before the queue existed: fold them in when the queue
    // has nothing (or something older) to say about the same work
    const upsert = (t: TaskRecord) => {
      const before = records.get(t.key);
      if (before && new Date(before.createdAt) >= new Date(t.createdAt)) return;
      records.set(t.key, t);
    };

    const train = await readTraining(ctx);
    if (train) {
      const run = train;
      const state = run.status === 'queued' ? 'queued' : run.status === 'starting' || run.status === 'running' ? 'running' : run.status;
      const stepTotal = run.steps ?? 0;
      const stepDone = run.step ?? 0;
      upsert({
        key: 'ocr-train',
        kind: 'train',
        name: 'Train a line reader',
        state,
        progress: state === 'done' ? 100 : state === 'queued' ? 0 : percent(stepDone, stepTotal),
        progressLabel: stepTotal ? `${stepDone.toLocaleString()} / ${stepTotal.toLocaleString()} steps` : run.epochs ? `epoch ${run.epoch ?? 0} / ${run.epochs}` : null,
        detail:
          state === 'running'
            ? `Epoch ${run.epoch ?? 0} of ${run.epochs ?? '?'}${run.loss != null ? ` · loss ${run.loss.toFixed(3)}` : ''}${run.devName != null ? ` · held out: names ${(run.devName * 100).toFixed(1)}%` : ''}`
            : state === 'queued'
              ? 'Waiting for the worker…'
              : (run.error ?? `Finished ${run.modelId ?? ''}`.trim()),
        etaSeconds: run.etaSeconds ?? null,
        step: null,
        createdAt: run.requestedAt ?? run.startedAt ?? run.updatedAt,
        startedAt: run.startedAt ?? null,
        finishedAt: run.finishedAt ?? null,
        runtimeMs: run.startedAt && run.finishedAt ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime() : null,
        error: state === 'failed' ? (run.error ?? 'The trainer failed.') : state === 'cancelled' ? 'Stopped.' : null,
        result: run.modelId ?? null,
        retry: {
          path: '/api/dev/ocr/train',
          body: { dataset: run.requested ?? 'latest', epochs: run.epochs ?? 30, synthetic: run.synthetic ?? 20_000 },
          label: 'Train again',
        },
      });
    }

    const py = await trainerPython(ctx);
    if (py.status === 'installing' || py.status === 'failed') {
      const total = py.steps.length || 3;
      const step = py.step ?? 0;
      upsert({
        key: 'ocr-python',
        kind: 'python',
        name: 'Set up the trainer’s Python',
        state: py.status === 'installing' ? 'running' : 'failed',
        progress: percent(step, total),
        progressLabel: `Step ${step} / ${total}`,
        detail: py.status === 'installing' ? (py.steps[step - 1] ?? 'Creating the environment…') : (py.error ?? 'The setup could not finish.'),
        etaSeconds: null,
        step: step ? { index: step, total, label: py.steps[step - 1] ?? '' } : null,
        createdAt: py.startedAt ?? py.updatedAt ?? new Date().toISOString(),
        startedAt: py.startedAt ?? null,
        finishedAt: py.finishedAt ?? null,
        runtimeMs: py.startedAt && py.finishedAt ? new Date(py.finishedAt).getTime() - new Date(py.startedAt).getTime() : null,
        error: py.status === 'failed' ? (py.error ?? 'The setup failed.') : null,
        result: py.status === 'installing' ? null : (py.python ?? null),
        retry: py.status === 'failed' ? { path: '/api/dev/ocr/train/python', label: 'Try again' } : null,
      });
    }

    const imp = await ctx.redis.get(IMPORT_KEY);
    if (imp) {
      const i = JSON.parse(imp) as { status: string; done?: number; total?: number; added?: number; skipped?: number; error?: string; updatedAt?: string };
      upsert({
        key: 'ocr-import',
        kind: 'import',
        name: 'Import harvested cards',
        state: i.status === 'queued' ? 'queued' : i.status === 'running' ? 'running' : i.status === 'done' ? 'done' : 'failed',
        progress: percent(i.done ?? 0, i.total ?? 0),
        progressLabel: i.total ? `${(i.done ?? 0).toLocaleString()} / ${i.total.toLocaleString()} cards` : null,
        detail: i.error ?? `${(i.added ?? 0).toLocaleString()} cards added${i.skipped ? ` · ${i.skipped} skipped` : ''}`,
        etaSeconds: null,
        step: null,
        createdAt: i.updatedAt ?? new Date().toISOString(),
        startedAt: null,
        finishedAt: i.status === 'done' || i.status === 'failed' ? (i.updatedAt ?? null) : null,
        runtimeMs: null,
        error: i.status === 'failed' ? (i.error ?? 'The import failed.') : null,
        result: null,
        retry: i.status === 'failed' ? { path: '/api/dev/ocr/import-harvest', body: { limit: 500 }, label: 'Import again' } : null,
      });
    }

    // evaluations have a row each (the worker keeps it up to date)
    const evals = await ctx.db
      .select({
        id: ocrEvaluations.id,
        engine: ocrEvaluations.engine,
        examVersion: ocrEvaluations.examVersion,
        status: ocrEvaluations.status,
        progress: ocrEvaluations.progress,
        error: ocrEvaluations.error,
        createdAt: ocrEvaluations.createdAt,
        completedAt: ocrEvaluations.completedAt,
        summary: ocrEvaluations.summary,
      })
      .from(ocrEvaluations)
      .orderBy(desc(ocrEvaluations.createdAt))
      .limit(12);
    for (const e of evals) {
      const engineLabel = e.engine.startsWith('model:') ? e.engine.slice('model:'.length) : 'Tesseract';
      const s = e.summary as { name?: { accuracy?: number | null }; number?: { accuracy?: number | null } };
      const pctText = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
      const done = e.progress?.done ?? 0;
      const total = e.progress?.total ?? 0;
      upsert({
        key: `ocr-evaluate:${e.id}`,
        kind: 'evaluation',
        name: `Score ${engineLabel} on exam v${e.examVersion ?? '?'}`,
        state: e.status === 'queued' ? 'queued' : e.status === 'running' ? 'running' : e.status === 'done' ? 'done' : 'failed',
        progress: e.status === 'done' ? 100 : percent(done, total),
        progressLabel: total ? `${done.toLocaleString()} / ${total.toLocaleString()} groups` : null,
        detail:
          e.status === 'done'
            ? `Names ${pctText(s.name?.accuracy)} · numbers ${pctText(s.number?.accuracy)}`
            : e.status === 'failed'
              ? (e.error ?? 'The score failed.')
              : e.status === 'queued'
                ? 'Waiting for the worker…'
                : `${engineLabel} is reading the frozen exam…`,
        etaSeconds: null,
        step: null,
        createdAt: e.createdAt.toISOString(),
        startedAt: e.status === 'queued' ? null : e.createdAt.toISOString(),
        finishedAt: e.completedAt?.toISOString() ?? null,
        runtimeMs: e.completedAt && e.status !== 'queued' ? e.completedAt.getTime() - e.createdAt.getTime() : null,
        error: e.status === 'failed' ? (e.error ?? 'The score failed.') : null,
        result: null,
        retry: {
          path: e.engine.startsWith('model:') ? `/api/dev/ocr/models/${e.engine.slice('model:'.length)}/evaluate` : '/api/dev/ocr/evaluations',
          label: 'Score again',
        },
      });
    }

    const tasks = [...records.values()]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((t) => toLabTask(t));
    // one rule for counts, the active task and its progress, shared with the app
    return { ...summarizeQueue(tasks), updatedAt: new Date().toISOString() };
  });

  /** Stop a task: training exits at the next step; a Python setup cancels like any job. */
  app.post<{ Params: { id: string } }>('/api/dev/ocr/queue/:id/cancel', guard, async (req) => {
    const raw = await ctx.redis.get(TASK_KEY(req.params.id));
    if (!raw) throw notFound();
    const task = JSON.parse(raw) as TaskRecord;
    if (!['running', 'queued'].includes(task.state)) throw badRequest('That task has already finished.');
    if (task.kind === 'train') {
      // the trainer checks this between steps and stops cleanly, keeping nothing
      await ctx.redis.set(TRAIN_CANCEL_KEY, '1', 'EX', 300);
      await taskProgress(ctx.redis, task.key, { detail: 'Stopping after this step…' });
      return { ok: true, stopping: true };
    }
    if (task.kind === 'evaluation') {
      // mark the row too, so a running or queued evaluation stops wrapping up as
      // 'done' after a cancel (it reports 'failed — cancelled' and is labelled)
      const id = task.key.slice('ocr-evaluate:'.length);
      await ctx.db
        .update(ocrEvaluations)
        .set({ status: 'failed', error: 'Cancelled.', completedAt: new Date() })
        .where(and(eq(ocrEvaluations.id, id), inArray(ocrEvaluations.status, ['queued', 'running'])));
    }
    const queue = ctx.queues.maintenance;
    const job = await queue.getJobs(['active', 'waiting', 'delayed', 'prioritized']).then((jobs) => jobs.find((j) => taskKeyOf(j.name, j.data as Record<string, unknown>) === task.key));
    if (job) {
      // an active job cannot be removed: discard it (it stops at the next await)
      try {
        await job.remove();
      } catch {
        await Promise.resolve(job.discard()).catch(() => undefined);
      }
    }
    await saveTask(ctx.redis, { key: task.key, kind: task.kind, name: task.name, state: 'cancelled', error: 'Cancelled.', detail: 'Cancelled before it finished.' });
    return { ok: true };
  });

  /** Queue the same request again (failed, cancelled, or to compare two runs). */
  app.post<{ Params: { id: string } }>('/api/dev/ocr/queue/:id/retry', guard, async (req) => {
    const raw = await ctx.redis.get(TASK_KEY(req.params.id));
    if (!raw) throw notFound();
    const task = JSON.parse(raw) as TaskRecord;
    if (!task.retry) throw badRequest('This task cannot be repeated from the queue.');
    await forgetTask(ctx.redis, task.key);
    const r = await app.inject({ method: 'POST', url: task.retry.path, payload: task.retry.body ?? {}, headers: req.headers as Record<string, string> });
    if (r.statusCode >= 400) {
      const why = String((JSON.parse(r.body) as { error?: string }).error ?? 'Could not repeat the task.');
      throw badRequest(`${why} The finished entry has been cleared, so it is no longer in the queue list.`);
    }
    return { ok: true, queued: task.retry.label };
  });

  /** Drop a finished entry from the queue. */
  app.delete<{ Params: { id: string } }>('/api/dev/ocr/queue/:id', guard, async (req) => {
    const raw = await ctx.redis.get(TASK_KEY(req.params.id));
    if (raw) {
      const task = JSON.parse(raw) as TaskRecord;
      if (['running', 'queued'].includes(task.state)) throw badRequest('Stop the task before removing it.');
    }
    await forgetTask(ctx.redis, req.params.id);
    return { ok: true };
  });

  /** Clear every finished entry (done, failed, cancelled). */
  app.post('/api/dev/ocr/queue/clear', guard, async () => {
    const tasks = await listTasks(ctx.redis);
    const finished = tasks.filter((t) => ['done', 'failed', 'cancelled'].includes(t.state));
    await Promise.all(finished.map((t) => forgetTask(ctx.redis, t.key)));
    return { ok: true, removed: finished.length };
  });

  // ---------------------------------------------------------------- training data & models

  app.post('/api/dev/ocr/export', guard, async () => {
    await saveTask(ctx.redis, {
      key: 'ocr-export',
      kind: 'export',
      name: 'Export training data',
      state: 'queued',
      progress: 0,
      detail: 'Waiting for the worker…',
      retry: { path: '/api/dev/ocr/export', label: 'Export again' },
    });
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
    const status: TrainStatus = {
      status: 'queued',
      requested: b.dataset,
      epochs: b.epochs,
      synthetic: b.synthetic,
      log: [],
      history: [],
      recent: [],
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await ctx.redis.set(TRAIN_KEY, JSON.stringify(status), 'EX', 7 * 24 * 3600);
    await ctx.redis.del(TRAIN_CANCEL_KEY);
    await saveTask(ctx.redis, {
      key: 'ocr-train',
      kind: 'train',
      name: 'Train a line reader',
      state: 'queued',
      progress: 0,
      detail: `${b.epochs} epochs · ${b.synthetic.toLocaleString()} synthetic lines per epoch`,
      retry: { path: '/api/dev/ocr/train', body: b, label: 'Train again' },
    });
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
    await saveTask(ctx.redis, {
      key: 'ocr-python',
      kind: 'python',
      name: 'Set up the trainer’s Python',
      state: 'queued',
      progress: 0,
      detail: 'Waiting for the worker…',
      retry: { path: '/api/dev/ocr/train/python', label: 'Run again' },
    });
    await ctx.queues.maintenance.add('ocr-python-setup', {}, { removeOnComplete: 20, removeOnFail: 20 });
    return { ok: true };
  });

  app.post('/api/dev/ocr/models/rescan', guard, async () => {
    await saveTask(ctx.redis, { key: 'ocr-rescan', kind: 'rescan', name: 'Look for new models', state: 'queued', progress: 0, detail: 'Waiting for the worker…' });
    await ctx.queues.maintenance.add('ocr-scan-models', {}, { removeOnComplete: 20, removeOnFail: 20 });
    return { ok: true };
  });

  // ---------------------------------------------------------------- CardVault-Vision

  /**
   * Train and export with CardVault-Vision's `vision` CLI, on the dataset the
   * Export button wrote (it now writes the whole-card manifest beside the JSONL
   * lines). One run can train both OCR heads — the pair a scan uses — and the
   * card classifier; each is exported as a versioned ONNX artifact and
   * registered for scoring automatically.
   */
  app.post('/api/dev/ocr/vision/train', guard, async (req) => {
    const b = z
      .object({
        dataset: z.string().regex(/^(latest|[A-Za-z0-9][A-Za-z0-9._-]*)$/).default('latest'),
        kind: z.enum(['ocr-pair', 'name-ocr', 'number-ocr', 'card-classifier', 'all']).default('ocr-pair'),
        epochs: z.coerce.number().int().min(1).max(500).default(30),
        architecture: z.string().max(40).optional(),
        device: z.enum(['auto', 'cpu', 'cuda']).default('auto'),
        version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).max(48).optional(),
        maxTrain: z.coerce.number().int().min(1).max(1_000_000).optional(),
      })
      .parse(req.body ?? {});
    const current = await readVision(ctx);
    if (current && ['queued', 'starting', 'running', 'exporting'].includes(current.status)) throw badRequest('A CardVault-Vision run is already in progress.');
    const legacy = await readTraining(ctx);
    if (legacy && ['queued', 'starting', 'running'].includes(legacy.status)) throw badRequest('The other trainer is running; stop it before starting a CardVault-Vision run.');
    const datasets = await listDatasets(ctx);
    // 'latest' means the newest export the factory can actually read, not the
    // newest export overall: a dataset without the whole-card manifest would
    // only fail later, inside `vision train`.
    const requested = b.dataset === 'latest' ? [...datasets].reverse().find((d) => d.vision)?.id : b.dataset;
    if (!requested) throw badRequest('No exported datasets yet. Press Export training data first.');
    if (!datasets.some((d) => d.id === requested)) throw badRequest(`No usable dataset ${requested}. Export training data first.`);
    const dataset = datasets.find((d) => d.id === requested)!;
    if (!dataset.vision) throw badRequest(`Dataset ${requested} has no CardVault-Vision manifest. Export training data again to write one.`);
    await saveTask(ctx.redis, {
      key: 'ocr-vision-train',
      kind: 'train',
      name: 'Train with CardVault-Vision',
      state: 'queued',
      progress: 0,
      detail: `${b.kind} · ${b.epochs} epochs on ${requested}`,
      retry: { path: '/api/dev/ocr/vision/train', body: { ...b, dataset: requested }, label: 'Train again' },
    });
    await ctx.queues.maintenance.add('ocr-vision-train', { ...b, dataset: requested }, { removeOnComplete: 20, removeOnFail: 20 });
    req.log.info({ dataset: requested, kind: b.kind, epochs: b.epochs }, 'CardVault-Vision training queued');
    return { ok: true, dataset: requested };
  });

  /** Stop a CardVault-Vision run (it stops after the current step and exports nothing more). */
  app.post('/api/dev/ocr/vision/cancel', guard, async () => {
    await ctx.redis.set(VISION_CANCEL_KEY, '1', 'EX', 600);
    return { ok: true };
  });

  /**
   * Register CardVault-Vision exports found on disk, and say what was found,
   * including each export that failed verification and why. The same scan runs
   * on worker start and after every training run.
   */
  app.post('/api/dev/ocr/vision/rescan', guard, async () => {
    await saveTask(ctx.redis, { key: 'ocr-rescan', kind: 'rescan', name: 'Look for new models', state: 'queued', progress: 0, detail: 'Waiting for the worker…' });
    await ctx.queues.maintenance.add('ocr-scan-models', {}, { removeOnComplete: 20, removeOnFail: 20 });
    return { ok: true };
  });

  /** Where a CardVault-Vision export is looked for, and what is there now. */
  app.get('/api/dev/ocr/vision', guard, async () => {
    const roots = [path.join(ctx.storageDir, 'ocr', 'vision', 'exports')];
    if (ctx.config.VISION_MODELS_DIR) roots.push(...ctx.config.VISION_MODELS_DIR.split(path.delimiter).map((d) => path.resolve(ctx.storageDir, d.trim())).filter(Boolean));
    const exports = [];
    for (const root of roots) {
      for (const task of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!task.isDirectory()) continue;
        for (const version of await readdir(path.join(root, task.name), { withFileTypes: true }).catch(() => [])) {
          if (!version.isDirectory()) continue;
          const files = await readdir(path.join(root, task.name, version.name)).catch(() => []);
          exports.push({ root: path.relative(ctx.storageDir, root), task: task.name, version: version.name, files: files.length });
        }
      }
    }
    const production: Record<string, unknown> = {};
    for (const task of ['name-ocr', 'number-ocr', 'card-classifier']) {
      const raw = await readFile(path.join(roots[0]!, task, 'production.json'), 'utf8').catch(() => null);
      if (raw) production[task] = JSON.parse(raw);
    }
    return {
      status: await readVision(ctx),
      roots: roots.map((r) => path.relative(ctx.storageDir, r) || r),
      configuredDir: ctx.config.CARDVAULT_VISION_DIR ?? null,
      python: ctx.config.OCR_TRAIN_PYTHON ?? path.join(ctx.config.OCR_TRAIN_VENV ?? path.join(ctx.storageDir, 'ocr', 'venv'), 'bin', 'python'),
      exports,
      production,
    };
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

  /**
   * The line reader reading live scans now, and its score on the exam version.
   * A game classifier is active independently of the line reader (one decides
   * the layout, the other reads the lines), so it is never the line champion.
   */
  const champion = async (examVersion: number) => {
    const activeRows = await ctx.db.select({ id: ocrModels.id, card: ocrModels.card }).from(ocrModels).where(eq(ocrModels.status, 'active'));
    const active = activeRows.find((r) => !isClassifierCard(r.card));
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
    const activeClassifier = models.find((m) => m.status === 'active' && isClassifierCard(m.card));
    const classifierChamp = exam && activeClassifier ? await latestEval(`model:${activeClassifier.id}`, exam.version) : null;
    const rows = [];
    for (const m of models) {
      const ev = exam ? await latestEval(`model:${m.id}`, exam.version) : null;
      const card = m.card as Record<string, unknown>;
      const classifier = isClassifierCard(card);
      const g = classifier
        ? m.status !== 'active' ? classifierGates(ev, classifierChamp) : []
        : ev && m.status !== 'active' ? gates(ev, champ?.eval ?? null) : [];
      const tg = !classifier && ev && m.status !== 'active' ? trialGate(m.trial as TrialLike | null, ctx.config.OCR_TRIAL_MIN_LINES) : null;
      if (tg) g.push(tg);
      rows.push({
        id: m.id,
        status: m.status,
        kind: classifier ? 'card-classifier' : card.kind === 'vision' ? 'vision-ocr' : 'trainer',
        task: card.task ?? 'ocr',
        version: card.version ?? null,
        heads: card.heads ?? null,
        exportedAt: card.exportedAt ?? null,
        validation: card.validation ?? null,
        gitCommit: card.gitCommit ?? null,
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
        canTrial: !classifier,
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
      classifierChampion: activeClassifier ? { engine: `model:${activeClassifier.id}`, evaluationId: classifierChamp?.id ?? null } : null,
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
    // Only rows of the same kind are replaced: promoting a game classifier must
    // not stop the line reader, and vice versa. They run side by side.
    const classifier = m.kind === 'card-classifier';
    const activeRows = await ctx.db.select({ id: ocrModels.id, card: ocrModels.card }).from(ocrModels).where(eq(ocrModels.status, 'active'));
    const current = activeRows.find((r) => isClassifierCard(r.card) === classifier);
    await ctx.db.transaction(async (tx) => {
      if (classifier) {
        const ids = activeRows.filter((r) => isClassifierCard(r.card)).map((r) => r.id);
        if (ids.length) await tx.update(ocrModels).set({ status: 'retired', retiredAt: new Date(), retiredReason: `replaced by ${m.id}` }).where(inArray(ocrModels.id, ids));
      } else {
        // ...and promoting a line reader must leave the game classifier alone
        const ids = activeRows.filter((r) => !isClassifierCard(r.card)).map((r) => r.id);
        if (ids.length) await tx.update(ocrModels).set({ status: 'retired', retiredAt: new Date(), retiredReason: `replaced by ${m.id}` }).where(inArray(ocrModels.id, ids));
      }
      await tx
        .update(ocrModels)
        // the classifier has no line engine to fall back to, so its "previous" is
        // either another classifier or nothing (Tesseract never routed games)
        .set({ status: 'active', activatedAt: new Date(), activatedBy: currentUser(req).id, previousEngine: current ? `model:${current.id}` : classifier ? 'none' : 'tesseract', watch: null, retiredAt: null, retiredReason: null })
        .where(eq(ocrModels.id, m.id));
      await tx.insert(auditLog).values({ userId: currentUser(req).id, action: 'ocr.promote', entity: 'ocr_model', entityId: m.id, metadata: { previous: current ? current.id : 'tesseract', kind: m.kind } });
    });
    req.log.info({ model: m.id }, 'OCR model promoted');
    return { ok: true };
  });

  /** Stop using the active model: live scans go back to the previous engine (a model, or Tesseract) within 30 seconds. */
  app.post('/api/dev/ocr/models/rollback', guard, async (req) => {
    const activeRows = await ctx.db.select().from(ocrModels).where(eq(ocrModels.status, 'active'));
    const kind = z.object({ kind: z.enum(['ocr', 'card-classifier']).optional() }).parse(req.body ?? {}).kind ?? 'ocr';
    const m = activeRows.find((r) => isClassifierCard(r.card) === (kind === 'card-classifier'));
    if (!m) return { ok: true, restored: kind === 'card-classifier' ? 'none' : 'tesseract' };
    const prev = m.previousEngine?.startsWith('model:') ? m.previousEngine.slice('model:'.length) : null;
    await ctx.db.transaction(async (tx) => {
      await tx.update(ocrModels).set({ status: 'retired', retiredAt: new Date(), retiredReason: 'rolled back by hand' }).where(eq(ocrModels.id, m.id));
      if (prev) await tx.update(ocrModels).set({ status: 'active', activatedAt: new Date(), retiredReason: null }).where(eq(ocrModels.id, prev));
      // the classifier runs beside the line reader: rolling one back leaves the
      // other reading scans unless it was asked for explicitly
      await tx.insert(auditLog).values({ userId: currentUser(req).id, action: 'ocr.rollback', entity: 'ocr_model', entityId: m.id, metadata: { restored: prev ?? 'tesseract', kind } });
    });
    const restored = prev ?? (kind === 'card-classifier' ? 'none' : 'tesseract');
    req.log.info({ model: m.id, restored, kind }, 'OCR model rolled back');
    return { ok: true, retired: m.id, restored };
  });

  /** Start a live trial: the model reads every new scan alongside the live engine, recorded only. */
  app.post<{ Params: { id: string } }>('/api/dev/ocr/models/:id/trial', guard, async (req) => {
    const [m] = await ctx.db.select().from(ocrModels).where(eq(ocrModels.id, req.params.id));
    if (!m) throw notFound();
    if (m.status === 'active') throw badRequest('This model is already reading live scans.');
    if (isClassifierCard(m.card)) throw badRequest('A game classifier runs beside the line reader and is promoted on its exam score; it has no live trial.');
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
    await saveTask(ctx.redis, { key: 'ocr-watch', kind: 'watch', name: 'Refresh trials & live watch', state: 'queued', progress: 0, detail: 'Waiting for the worker…' });
    await ctx.queues.maintenance.add('ocr-watch', {}, { removeOnComplete: 20, removeOnFail: 20 });
    return { ok: true };
  });
}
