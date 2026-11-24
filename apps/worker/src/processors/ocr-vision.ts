import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { WorkerContext } from '../context.js';
import { ensureTask, saveTask, taskProgress } from '@cardvault/jobs';
import { percent } from '@cardvault/shared';

/**
 * CardVault-Vision training bridge (OCR Lab → Train with the `vision` trainer).
 *
 * The lab can train a line reader with either trainer:
 *
 *  - `ocr-train.ts` — tools/ocr-trainer, CardVault's own single-head CRNN. It
 *    writes `ocr/models/crnn-<stamp>/{model.onnx, card.json}` and is the older
 *    path, still fully supported.
 *  - this file — the `vision` CLI from CardVault-Vision. It trains *separate*
 *    heads (`name-ocr`, `number-ocr`) and the whole-card `card-classifier`,
 *    records reproducible run metadata, and exports a versioned ONNX artifact
 *    bundle that the worker runs directly (see identification/vision.ts).
 *
 * So the pipeline becomes: export (JSONL + a CardVault-Vision manifest) →
 * `vision train` → `vision export` → the artifact is registered for scoring,
 * then trial and promotion — the same gates either way.
 *
 * Everything here is a child process of the worker: Python and PyTorch are
 * never imported by CardVault, and the artifact directory is the only handoff.
 */

export const VISION_KEY = 'ocr:vision';
export const VISION_CANCEL_KEY = 'ocr:vision:cancel';
export const VISION_TASK_KEY = 'ocr-vision-train';

const LOG_TAIL = 120;

/** Which head a run trains. */
export type VisionTrainTask = 'name-ocr' | 'number-ocr' | 'card-classifier';

/** The two OCR heads as one run: what a scan actually needs. */
export type VisionRunKind = VisionTrainTask | 'ocr-pair' | 'all';

export const VISION_RUN_KINDS: readonly VisionRunKind[] = ['ocr-pair', 'name-ocr', 'number-ocr', 'card-classifier', 'all'];

export interface VisionStage {
  /** name-ocr · number-ocr · card-classifier */
  task: VisionTrainTask;
  state: 'queued' | 'training' | 'exporting' | 'done' | 'failed' | 'skipped';
  /** held-out CER (OCR) or macro F1 (classifier) of the best epoch */
  bestMetric?: number | null;
  metricName?: string | null;
  epochs?: number;
  /** 0..1, the best held-out score so far */
  best?: number | null;
  /** `exports/<task>/<version>` once exported */
  exportDir?: string;
  /** the registered OCR Lab model id (e.g. vision-name-ocr-1.0.0) */
  modelId?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface VisionStatus {
  status: 'queued' | 'starting' | 'running' | 'exporting' | 'done' | 'failed' | 'cancelled';
  kind: VisionRunKind;
  /** dataset id the run trains on */
  dataset: string;
  /** the CardVault-Vision manifest it reads (storage-relative) */
  manifest?: string;
  /** where checkpoints and exports are written (storage-relative) */
  runDir?: string;
  /** version recorded on every exported artifact */
  version?: string;
  epochs?: number;
  architecture?: string;
  device?: string;
  /** one entry per head the run trains, in order */
  stages: VisionStage[];
  /** the head being trained now */
  task?: VisionTrainTask;
  /** the current epoch, from the trainer's own log lines */
  epoch?: number;
  /** held-out CER/F1 of the last finished epoch */
  cer?: number | null;
  macroF1?: number | null;
  /** history of the training head, for the curve */
  history?: { epoch: number; loss: number; cer?: number | null; macroF1?: number | null }[];
  /** absolute steps through the whole run */
  step?: number;
  steps?: number;
  etaSeconds?: number | null;
  python?: string;
  error?: string;
  log: string[];
  requestedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

// ------------------------------------------------------------------ trainer discovery

/**
 * Where the `vision` package lives: `CARDVAULT_VISION_DIR` when set, otherwise a
 * checkout or installed copy near the repository (`vendor/CardVault-Vision`,
 * `../CardVault-Vision`), mirroring how tools/ocr-trainer is found.
 */
export function findVisionDir(configured?: string, startDirs: string[] = []): string | null {
  const looksRight = (dir: string) => existsSync(path.join(dir, 'src', 'cardvault_vision', 'cli', 'main.py')) || existsSync(path.join(dir, 'cardvault_vision', 'cli', 'main.py'));
  if (configured) return looksRight(path.resolve(configured)) ? path.resolve(configured) : null;
  for (const start of startDirs) {
    let dir = path.resolve(start);
    for (let i = 0; i < 8; i++) {
      for (const candidate of ['vendor/CardVault-Vision', '../CardVault-Vision', 'CardVault-Vision']) {
        const full = path.join(dir, candidate);
        if (looksRight(full)) return full;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

/** Is `vision` importable by this interpreter? (`python -c "import cardvault_vision"`) */
export function visionPythonReady(python: string, visionDir: string | null): boolean {
  const env = pythonEnv(visionDir);
  const probe = spawnSync(python, ['-c', 'import cardvault_vision, numpy, PIL'], { timeout: 60_000, windowsHide: true, stdio: 'ignore', env: { ...process.env, ...env } });
  return !probe.error && probe.status === 0;
}

/** The module invocation for the CLI, from a checkout (src layout) or an install. */
export function visionCommand(visionDir: string | null): { args: string[]; cwd: string | null } {
  if (visionDir && existsSync(path.join(visionDir, 'src', 'cardvault_vision'))) {
    return { args: ['-m', 'cardvault_vision'], cwd: visionDir };
  }
  return { args: ['-m', 'cardvault_vision'], cwd: null };
}

/** Environment for a `vision` run: the checkout on PYTHONPATH, UTF-8, no buffering. */
export function pythonEnv(visionDir: string | null, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'TZ', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']) if (process.env[k]) env[k] = process.env[k];
  env.PYTHONUNBUFFERED = '1';
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONPATH = [visionDir ? path.join(visionDir, 'src') : null, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  return { ...env, ...extra };
}

// ------------------------------------------------------------------ progress parsing

export interface VisionEvent {
  kind: 'epoch' | 'best' | 'collapsed' | 'training' | 'exported' | 'wrote';
  epoch?: number;
  epochs?: number;
  loss?: number;
  cer?: number | null;
  macroF1?: number | null;
  task?: string;
  exportDir?: string;
  modelId?: string;
}

/**
 * Read one line of the trainer's console output.
 *
 * The `vision` CLI logs through Python's `logging`, one line per epoch:
 *
 *   OCR:        12:03:04 | INFO    | cardvault_vision.training.trainer | epoch 3/20  loss=0.4123  cer=0.0812 em=42.00%
 *   classifier: 12:03:04 | INFO    | … | epoch 3/20  loss=0.2211  val_loss=0.2010  acc=88.00%  macroF1=0.8710
 *
 * and the exporter logs where it wrote the artifact:
 *
 *   cardvault_vision.export | Exported name-ocr 1.0.0 -> /…/exports/name-ocr/1.0.0
 *
 * Parsing defensively matters: a run that silently reports no progress looks
 * hung, and the epoch numbers are the only thing that makes an ETA possible.
 */
export function parseVisionLine(line: string): VisionEvent | null {
  const text = line.replace(/\x1b\[[0-9;]*m/g, '');
  let m = /epoch\s+(\d+)\/(\d+)\s+loss=([0-9.]+)\s+cer=([0-9.]+)/.exec(text);
  if (m) return { kind: 'epoch', epoch: Number(m[1]), epochs: Number(m[2]), loss: Number(m[3]), cer: Number(m[4]) };
  m = /epoch\s+(\d+)\/(\d+)\s+loss=([0-9.]+)\s+val_loss=([0-9.]+)\s+acc=([0-9.]+)%\s+macroF1=([0-9.]+)/.exec(text);
  if (m) return { kind: 'epoch', epoch: Number(m[1]), epochs: Number(m[2]), loss: Number(m[3]), macroF1: Number(m[6]) };
  // older/alternate form: "epoch 4/20 loss=0.99" with the metric on the same line
  m = /epoch\s+(\d+)\/(\d+)\s+loss=([0-9.]+)(?:\s+(?:cer=([0-9.]+)|.*macroF1=([0-9.]+)))?/.exec(text);
  if (m) return { kind: 'epoch', epoch: Number(m[1]), epochs: Number(m[2]), loss: Number(m[3]), ...(m[4] ? { cer: Number(m[4]) } : {}), ...(m[5] ? { macroF1: Number(m[5]) } : {}) };
  if (/best_checkpoint/.test(text)) return { kind: 'best', ...(/:?\s*epoch=(\d+)/.test(text) ? { epoch: Number(/:?\s*epoch=(\d+)/.exec(text)![1]) } : {}) };
  if (/Collapsed predictions/.test(text)) return { kind: 'collapsed' };
  m = /Training\s+(\S+)\s+on field/.exec(text) ?? /Training card classifier/.exec(text);
  if (m) return { kind: 'training', ...(m[1] ? { task: m[1] } : {}) };
  m = /Training finished: (\S+) \/ (\S+)/.exec(text);
  if (m) return { kind: 'training', task: m[1] };
  m = /Exported (\S+) (\S+) -> (\S+)/.exec(text);
  if (m) return { kind: 'exported', task: m[1], exportDir: m[3] };
  return null;
}

// ------------------------------------------------------------------ status storage

const readStatus = async (ctx: WorkerContext): Promise<VisionStatus | null> => {
  const raw = await ctx.redis.get(VISION_KEY).catch(() => null);
  return raw ? (JSON.parse(raw) as VisionStatus) : null;
};

/** The last run, as OCR Lab shows it. */
export const visionStatus = (ctx: WorkerContext) => readStatus(ctx);

/** Ask the running bridge to stop after the current step (and export nothing more). */
export async function cancelVisionRun(ctx: WorkerContext): Promise<void> {
  await ctx.redis.set(VISION_CANCEL_KEY, '1', 'EX', 600).catch(() => undefined);
}

// ------------------------------------------------------------------ the run

export interface VisionTrainRequest {
  /** dataset id; `latest` is resolved by the caller */
  dataset: string;
  kind: VisionRunKind;
  epochs?: number;
  architecture?: string;
  device?: 'auto' | 'cpu' | 'cuda';
  /** version recorded on the exported artifacts (default: date-based) */
  version?: string;
  /** train on at most this many samples per split (smoke runs) */
  maxTrain?: number;
}

/** The tasks a run trains, in order. A pair is two runs sharing a version. */
export function tasksFor(kind: VisionRunKind): VisionTrainTask[] {
  switch (kind) {
    case 'name-ocr':
      return ['name-ocr'];
    case 'number-ocr':
      return ['number-ocr'];
    case 'card-classifier':
      return ['card-classifier'];
    case 'all':
      return ['name-ocr', 'number-ocr', 'card-classifier'];
    case 'ocr-pair':
    default:
      return ['name-ocr', 'number-ocr'];
  }
}

/** A version string from the run's start time: `2026.11.24-1530`. */
export const versionStamp = (now = new Date()) =>
  `${now.getUTCFullYear()}.${String(now.getUTCMonth() + 1).padStart(2, '0')}.${String(now.getUTCDate()).padStart(2, '0')}-${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}`;

export const safeVersion = (v: string | undefined): string => (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(v ?? '')) ? String(v) : versionStamp());

/**
 * Train (and export) with the `vision` CLI on a dataset CardVault exported.
 *
 * One run can train both OCR heads — the pair a scan uses — and the
 * classifier, each as its own `vision train` + `vision export`, with the same
 * version. Progress goes to `ocr:vision` (what OCR Lab shows) and to the
 * queue's `ocr-vision-train` task on every epoch, so a run that takes hours is
 * visible, stoppable, and reports an ETA from the epoch pace.
 */
export async function trainWithVision(ctx: WorkerContext, req: VisionTrainRequest): Promise<VisionStatus> {
  const tasks = tasksFor(req.kind);
  const epochs = Math.min(500, Math.max(1, Math.round(Number(req.epochs ?? 30) || 30)));
  const version = safeVersion(req.version);
  const datasetId = req.dataset;
  const datasetDir = path.join(ctx.storageDir, 'ocr', 'datasets', datasetId, 'vision');
  const runRoot = path.join(ctx.storageDir, 'ocr', 'vision');
  const exportsRoot = path.join(runRoot, 'exports');
  const experiments = path.join(runRoot, 'experiments');

  let status: VisionStatus = {
    status: 'starting',
    kind: req.kind,
    dataset: datasetId,
    manifest: path.relative(ctx.storageDir, path.join(datasetDir, 'manifest.json')),
    runDir: path.relative(ctx.storageDir, runRoot),
    version,
    epochs,
    architecture: req.architecture,
    device: req.device ?? 'auto',
    stages: tasks.map((task) => ({ task, state: 'queued' as const })),
    history: [],
    log: [],
    etaSeconds: null,
    updatedAt: new Date().toISOString(),
    requestedAt: new Date().toISOString(),
  };
  const task = await ensureTask(ctx.redis, {
    key: VISION_TASK_KEY,
    kind: 'train',
    name: 'Train with CardVault-Vision',
    detail: 'Starting the vision trainer…',
    state: 'running',
  });
  const save = async (patch: Partial<VisionStatus>) => {
    status = { ...status, ...patch, log: patch.log ?? status.log, updatedAt: new Date().toISOString() };
    await ctx.redis.set(VISION_KEY, JSON.stringify(status), 'EX', 7 * 24 * 3600).catch(() => undefined);
    return status;
  };
  const finish = (state: 'done' | 'failed' | 'cancelled', error: string | null, result?: string | null) =>
    void saveTask(ctx.redis, { key: task.key, kind: 'train', name: task.name, state, error, result: result ?? null, progress: state === 'done' ? 100 : Math.min(99, percent(status.step ?? 0, status.steps ?? 0)) });

  const fail = async (error: string) => {
    await save({ status: 'failed', error, finishedAt: new Date().toISOString() });
    await finish('failed', error);
    return status;
  };

  // ---- what the run needs: a manifest, the vision package, and a Python with torch
  const manifest = path.join(datasetDir, 'manifest.json');
  if (!existsSync(manifest)) {
    return fail(`Dataset ${datasetId} has no CardVault-Vision manifest (${path.relative(ctx.storageDir, manifest)}). Export training data again to write one.`);
  }
  const visionDir = findVisionDir(ctx.config.CARDVAULT_VISION_DIR, [path.dirname(new URL(import.meta.url).pathname), process.cwd()]);
  const python = ctx.config.OCR_TRAIN_PYTHON || path.join(ctx.config.OCR_TRAIN_VENV || path.join(ctx.storageDir, 'ocr', 'venv'), 'bin', 'python');
  if (!existsSync(python)) {
    return fail(`No trainer Python at ${python}. Press “Set up the OCR trainer” first (it installs CPU PyTorch), or set OCR_TRAIN_PYTHON.`);
  }
  if (!visionPythonReady(python, visionDir)) {
    return fail(
      `The trainer Python at ${python} cannot import cardvault_vision. Install it (${visionDir ? `pip install -e ${visionDir}` : 'pip install cardvault-vision'} in that environment), or set CARDVAULT_VISION_DIR to a CardVault-Vision checkout.`,
    );
  }
  await save({ python, startedAt: new Date().toISOString() });
  await ctx.redis.del(VISION_CANCEL_KEY).catch(() => undefined);

  const { args: moduleArgs, cwd } = visionCommand(visionDir);
  const stepsPerTask = 2; // train + export
  const steps = tasks.length * stepsPerTask;
  await save({ steps, step: 0 });
  await taskProgress(ctx.redis, task.key, {
    progress: 0,
    progressLabel: `0 / ${steps} steps`,
    detail: `${tasks.length} head${tasks.length > 1 ? 's' : ''} · ${epochs} epochs each · dataset ${datasetId}`,
    etaSeconds: null,
  });

  const run = (argv: string[]) =>
    new Promise<{ code: number | null; lines: string[] }>((resolve) => {
      const child = spawn(python, [...moduleArgs, ...argv], {
        cwd: cwd ?? undefined,
        env: pythonEnv(visionDir),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const lines: string[] = [];
      let pending = '';
      let cancelled = false;
      const killTimer = setInterval(() => {
        void ctx.redis.get(VISION_CANCEL_KEY).then((v) => {
          if (v !== '1' || cancelled) return;
          cancelled = true;
          void taskProgress(ctx.redis, task.key, { detail: 'Stopping after this step…' });
          child.kill('SIGTERM');
          setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 8_000).unref?.();
        });
      }, 2_000);
      const consume = (chunk: Buffer) => {
        pending += chunk.toString('utf8');
        const parts = pending.split('\n');
        pending = parts.pop() ?? '';
        for (const raw of parts) {
          const line = raw.replace(/\r$/, '');
          if (!line.trim()) continue;
          lines.push(line);
          void handleLine(line);
        }
      };
      child.stdout.on('data', consume);
      child.stderr.on('data', consume);
      child.on('close', (code) => {
        if (pending.trim()) {
          lines.push(pending);
          void handleLine(pending);
        }
        clearInterval(killTimer);
        resolve({ code, lines });
      });
      child.on('error', (e) => {
        lines.push(String(e.message));
        clearInterval(killTimer);
        resolve({ code: -1, lines });
      });
    });

  let cancelled = false;
  const checkCancel = () => ctx.redis.get(VISION_CANCEL_KEY).then((v) => (cancelled = cancelled || v === '1'));

  const handleLine = async (line: string) => {
    const log = [...status.log, line.slice(0, 500)].slice(-LOG_TAIL);
    const ev = parseVisionLine(line);
    if (ev?.kind === 'epoch' && ev.epoch != null && ev.epochs != null) {
      const history = [...(status.history ?? []), { epoch: ev.epoch, loss: ev.loss ?? 0, ...(ev.cer != null ? { cer: ev.cer } : {}), ...(ev.macroF1 != null ? { macroF1: ev.macroF1 } : {}) }];
      const stages = status.stages.map((s) => (s.task === status.task ? { ...s, epochs: ev.epoch, ...(ev.cer != null ? { bestMetric: ev.cer, metricName: 'cer' } : {}), ...(ev.macroF1 != null ? { bestMetric: ev.macroF1, metricName: 'macro F1' } : {}) } : s));
      const startedAt = status.startedAt ? new Date(status.startedAt).getTime() : null;
      const elapsed = startedAt ? Date.now() - startedAt : 0;
      await save({ log, status: 'running', epoch: ev.epoch, epochs: ev.epochs, cer: ev.cer ?? status.cer ?? null, macroF1: ev.macroF1 ?? status.macroF1 ?? null, history, stages });
      const done = (status.step ?? 0);
      await taskProgress(ctx.redis, task.key, {
        progress: percent(done, steps),
        progressLabel: `${done} / ${steps} steps`,
        detail: `${status.task ?? 'training'} · epoch ${ev.epoch} of ${ev.epochs}${ev.cer != null ? ` · held-out CER ${(ev.cer * 100).toFixed(2)}%` : ''}${ev.macroF1 != null ? ` · macro F1 ${ev.macroF1.toFixed(4)}` : ''}`,
        etaSeconds: ev.epoch > 0 && ev.epochs > ev.epoch && elapsed ? Math.round((elapsed / ev.epoch) * (ev.epochs - ev.epoch) / 1000) : null,
      });
    } else await save({ log });
  };

  // ---- each head: train, then export
  let exported = 0;
  for (const [i, head] of tasks.entries()) {
    if (await checkCancel()) break;
    const stages = status.stages.map((s) => (s.task === head ? { ...s, state: 'training' as const, startedAt: new Date().toISOString() } : s));
    await save({
      status: 'running',
      task: head,
      stages,
      epoch: 0,
      cer: null,
      macroF1: null,
      history: [],
      step: i * stepsPerTask,
    });
    await taskProgress(ctx.redis, task.key, {
      progress: percent(i * stepsPerTask, steps),
      progressLabel: `${i * stepsPerTask} / ${steps} steps`,
      detail: `Training ${head} · ${epochs} epochs on ${datasetId}`,
      etaSeconds: null,
    });
    const curriculumArg = head === 'card-classifier' ? ['classifier'] : [head];
    const trainOut = path.join(experiments, version, head);
    const train = await run([
      '--log-level', 'INFO',
      'train', ...curriculumArg,
      '--dataset', manifest,
      '--epochs', String(epochs),
      '--out', trainOut,
      ...(req.architecture ? ['--architecture', req.architecture] : []),
      ...(req.device && req.device !== 'auto' ? ['--device', req.device] : []),
      ...(req.maxTrain ? ['--max-train', String(req.maxTrain)] : []),
      '--json',
    ]);
    if (await checkCancel()) {
      cancelled = true;
      break;
    }
    if (train.code !== 0) {
      const tail = train.lines.slice(-10).join('\n');
      const error = `vision train ${head} exited with code ${train.code}.${tail ? `\n${tail}` : ''}`;
      await save({ stages: status.stages.map((s) => (s.task === head ? { ...s, state: 'failed' as const, error, finishedAt: new Date().toISOString() } : s)), error });
      // one head failing does not throw away the others: keep training the rest
      continue;
    }
    const summary = parseTrainJson(train.lines);
    await save({
      step: i * stepsPerTask + 1,
      stages: status.stages.map((s) =>
        s.task === head
          ? {
              ...s,
              state: 'exporting' as const,
              ...(summary?.best_metric != null ? { bestMetric: summary.best_metric, metricName: summary.metric_name ?? null } : {}),
              ...(summary?.best_checkpoint ? { error: undefined } : {}),
            }
          : s,
      ),
    });
    await taskProgress(ctx.redis, task.key, {
      progress: percent(i * stepsPerTask + 1, steps),
      progressLabel: `${i * stepsPerTask + 1} / ${steps} steps`,
      detail: `Exporting ${head} to ONNX…`,
    });

    const checkpoint = summary?.best_checkpoint ?? path.join(trainOut, 'best.pt');
    const exportTask = head;
    const exp = await run([
      '--log-level', 'INFO',
      'export', 'export',
      '--checkpoint', checkpoint,
      '--version', version,
      '--task', exportTask,
      '--out', exportsRoot,
      '--register',
      '--json',
    ]);
    const artifactDir = path.join(exportsRoot, exportTask, version);
    if (exp.code !== 0 || !existsSync(path.join(artifactDir, 'model.onnx'))) {
      const tail = exp.lines.slice(-10).join('\n');
      const error = exp.code !== 0
        ? `vision export ${head} exited with code ${exp.code}.${tail ? `\n${tail}` : ''}`
        : `vision export ${head} reported success but ${artifactDir} has no model.onnx.${tail ? `\n${tail}` : ''}`;
      await save({ stages: status.stages.map((s) => (s.task === head ? { ...s, state: 'failed' as const, error, finishedAt: new Date().toISOString() } : s)) });
      continue;
    }
    exported++;
    await save({
      step: i * stepsPerTask + 2,
      stages: status.stages.map((s) => (s.task === head ? { ...s, state: 'done' as const, exportDir: path.relative(ctx.storageDir, artifactDir), finishedAt: new Date().toISOString() } : s)),
    });
  }

  // ---- register what was exported so OCR Lab can score, trial and promote it
  // Runs before the cancel check on purpose: heads that finished exporting before
  // a stop are real artifacts, and throwing their registration away would leave
  // models on disk that OCR Lab shows as nothing at all.
  const registerExports = async () => {
    if (!exported) return [] as string[];
    const { scanVisionModels } = await import('../processors/ocr-lab-vision.js');
    const registered = await scanVisionModels(ctx).catch((e: Error) => {
      ctx.log.warn({ err: e.message }, 'could not register Vision artifacts');
      return { models: [] as string[], errors: [{ dir: exportsRoot, error: e.message }] };
    });
    if (registered.models.length) {
      // the queue's "Look for new models" entry, so the Models tab refreshes too
      await ctx.queues.maintenance.add('ocr-scan-models', {}, { removeOnComplete: 10, removeOnFail: 10 }).catch(() => undefined);
      const byHead = new Map<string, string>();
      for (const id of registered.models) byHead.set(id.includes('card-classifier') ? 'card-classifier' : id.includes('number-ocr') ? 'number-ocr' : 'name-ocr', id);
      await save({
        stages: status.stages.map((s) => (byHead.has(s.task) ? { ...s, modelId: byHead.get(s.task)! } : s)),
      });
    }
    return registered.models;
  };

  const registeredModels = await registerExports();
  if (cancelled) {
    await save({ status: 'cancelled', error: 'Stopped on request.', finishedAt: new Date().toISOString() });
    await finish('cancelled', 'Stopped on request.');
    return status;
  }
  if (exported) {
    await save({ status: 'done', finishedAt: new Date().toISOString(), etaSeconds: 0, step: steps });
    await finish('done', null, registeredModels.join(', ') || null);
    return status;
  }
  return fail(`Nothing was exported. See the log for what the trainer reported.`);
}

/** `vision train --json` prints one JSON object; find it in the captured output. */
export function parseTrainJson(lines: string[]): { best_checkpoint?: string; best_metric?: number; metric_name?: string; architecture?: string } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.best_checkpoint === 'string' || typeof parsed.best_metric === 'number') {
        return {
          ...(typeof parsed.best_checkpoint === 'string' ? { best_checkpoint: parsed.best_checkpoint } : {}),
          ...(typeof parsed.best_metric === 'number' ? { best_metric: parsed.best_metric } : {}),
          ...(typeof parsed.metric_name === 'string' ? { metric_name: parsed.metric_name } : {}),
          ...(typeof parsed.architecture === 'string' ? { architecture: parsed.architecture } : {}),
        };
      }
    } catch {
      /* a log line that happens to start with { */
    }
  }
  return null;
}

/** Artifacts a models root holds, for the API's "where do models come from" view. */
export async function exportsOnDisk(root: string): Promise<{ dir: string; bytes: number }[]> {
  const out: { dir: string; bytes: number }[] = [];
  const walk = async (dir: string, depth: number) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const model = await stat(path.join(full, 'model.onnx')).catch(() => null);
      if (model?.isFile()) out.push({ dir: path.relative(root, full), bytes: model.size });
      else if (depth < 2) await walk(full, depth + 1);
    }
  };
  await walk(root, 0);
  return out;
}

/** Read the registry CardVault-Vision writes, for OCR Lab's provenance view. */
export async function readVisionRegistry(root: string): Promise<Record<string, unknown> | null> {
  const raw = await readFile(path.join(root, 'registry.json'), 'utf8').catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
