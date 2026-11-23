import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerContext } from '../context.js';
import { etaFromEpochs, percent } from '@cardvault/shared';
import { ensureTask, saveTask, taskProgress } from '@cardvault/jobs';

const LOG_TAIL = 80;

/**
 * Training runs tools/ocr-trainer/train.py as a child process (CPU PyTorch) and
 * reports its progress into redis (`ocr:train`), the same pattern as the
 * harvest import: OCR Lab shows the live status and the trainer's log tail,
 * and the finished model is registered for scoring automatically.
 */

export const TRAIN_KEY = 'ocr:train';
export const TRAIN_CANCEL_KEY = 'ocr:train:cancel';
/** Whether a Python that can train exists here, and the last setup run. */
export const PYTHON_KEY = 'ocr:python';

export interface TrainStatus {
  status: 'queued' | 'starting' | 'running' | 'done' | 'failed' | 'cancelled';
  /** requested dataset id, or 'latest' */
  requested?: string;
  /** dataset the trainer resolved (from its output) */
  dataset?: string;
  lines?: number;
  epochs?: number;
  epoch?: number;
  loss?: number;
  /** held-out accuracy of the current epoch, 0..1 */
  devName?: number | null;
  devNumber?: number | null;
  minutes?: number;
  synthetic?: number;
  /** trained model id (crnn-…), registered for scoring when done */
  modelId?: string;
  dev?: unknown;
  python?: string;
  error?: string;
  log: string[];
  /** absolute step through the whole run (epoch × steps-per-epoch + step) */
  step?: number;
  steps?: number;
  /** batch work inside the current epoch: how many of how many */
  batch?: number;
  batches?: number;
  /** seconds until the run is expected to finish, from the pace so far */
  etaSeconds?: number | null;
  /** seconds an epoch takes, from the pace so far */
  secondsPerEpoch?: number | null;
  /** dev accuracy of the best epoch so far (the checkpoint that will be kept) */
  bestEpoch?: number;
  bestName?: number | null;
  bestNumber?: number | null;
  /** held-out accuracy, one entry per epoch: the chart in OCR Lab */
  history?: { epoch: number; loss: number; devName: number | null; devNumber: number | null; minutes: number }[];
  /** the most recent held-out lines read: what the model gets right, wrong and how sure it is */
  recent?: TrainSample[];
  requestedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

/** One held-out line as the trainer read it at the last checkpoint. */
export interface TrainSample {
  /** stable per line: a later epoch's reading replaces the earlier one */
  id: number;
  field: 'name' | 'number';
  truth: string;
  predicted: string;
  /** 0..1, the decoder's confidence (geometric mean of the characters' probabilities) */
  confidence: number;
  correct: boolean;
  /** the crop, relative to the storage folder (shown next to the reading) */
  crop: string | null;
  epoch: number;
}

export type TrainEvent =
  | { type: 'dataset'; id: string; lines: number }
  | { type: 'plan'; epochs: number; epochsSteps: number; stepsPerEpoch: number; train: number; dev: number; batch: number }
  | { type: 'batch'; epoch: number; step: number; steps: number; loss: number }
  | { type: 'epoch'; epoch: number; loss: number; devName: number | null; devNumber: number | null; minutes: number; seconds?: number }
  | {
      type: 'sample';
      id: number;
      field: 'name' | 'number';
      truth: string;
      predicted: string;
      confidence: number;
      correct: boolean;
      crop: string | null;
      epoch: number;
    }
  | { type: 'wrote'; modelId: string }
  | { type: 'dev'; dev: unknown };

/** One line of train.py stdout → a progress event (or null for plain log). */
export function parseTrainerLine(line: string): TrainEvent | null {
  let m = /^dataset (\S+): (\d+) lines/.exec(line);
  if (m) return { type: 'dataset', id: m[1]!, lines: Number(m[2]) };
  m = /^plan epochs (\d+) steps (\d+) × (\d+) train (\d+) dev (\d+) batch (\d+)/.exec(line);
  if (m) {
    return {
      type: 'plan',
      epochs: Number(m[1]),
      // "steps 12 × 30": 12 batches per epoch × 30 epochs
      stepsPerEpoch: Number(m[2]),
      epochsSteps: Number(m[2]) * Number(m[3]),
      train: Number(m[4]),
      dev: Number(m[5]),
      batch: Number(m[6]),
    };
  }
  m = /^step\s+(\d+)\/(\d+)\s+loss\s+([0-9.]+)\s+\(([0-9.]+) min\)/.exec(line);
  if (m) return { type: 'batch', epoch: 0, step: Number(m[1]), steps: Number(m[2]), loss: Number(m[3]) };
  m = /^sample\s+(\d+)\s+(name|number)\s+conf\s+([0-9.]+)\s+(ok|miss)\s+(\S+)\s+(.*)$/.exec(line);
  if (m) {
    const rest = m[6]!;
    const sep = rest.indexOf(' → ');
    const truth = sep >= 0 ? rest.slice(0, sep) : rest;
    const predicted = sep >= 0 ? rest.slice(sep + 3) : '';
    return {
      type: 'sample',
      id: Number(m[1]),
      field: m[2] as 'name' | 'number',
      confidence: Number(m[3]),
      correct: m[4] === 'ok',
      crop: m[5] === '-' ? null : m[5]!,
      truth,
      predicted: predicted === '(nothing)' ? '' : predicted,
      epoch: 0,
    };
  }
  m = /^epoch\s+(\d+)\s+loss\s+([0-9.]+)\s+dev name\s+(\S+)\s+number\s+(\S+)\s+\(([0-9.]+) min\)(?:\s+epoch ([0-9.]+) s)?/.exec(line);
  if (m) {
    const num = (s: string) => (s === 'None' ? null : Number(s));
    return {
      type: 'epoch',
      epoch: Number(m[1]),
      loss: Number(m[2]),
      devName: num(m[3]!),
      devNumber: num(m[4]!),
      minutes: Number(m[5]),
      ...(m[6] ? { seconds: Number(m[6]) } : {}),
    };
  }
  m = /^wrote (\S+)/.exec(line);
  if (m) return { type: 'wrote', modelId: path.basename(m[1]!) };
  m = /^\s*dev: (\{.*\})\s*$/.exec(line);
  if (m) {
    try {
      return { type: 'dev', dev: JSON.parse(m[1]!) };
    } catch {
      return null;
    }
  }
  return null;
}

/** Find tools/ocr-trainer by walking up from this file (src/ or dist/ layouts). */
export function findTrainerDir(configured?: string): string | null {
  if (configured) return existsSync(path.join(configured, 'train.py')) ? path.resolve(configured) : null;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 7; i++) {
    const candidate = path.join(dir, 'tools', 'ocr-trainer');
    if (existsSync(path.join(candidate, 'train.py'))) return candidate;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * A Python interpreter that can import torch and pillow: OCR_TRAIN_PYTHON when
 * set, otherwise the venv this project's setup creates (OCR_TRAIN_VENV, then
 * ~/ocr-venv — scripts/ocr-python.sh installs it there), then a virtualenv
 * inside the storage folder (what the Docker image uses), then python3/python
 * on PATH.
 */
export function findTrainPython(configured?: string, storageDir?: string, venv?: string): { python: string; error?: string } {
  const homes = [path.join(homedir(), 'ocr-venv'), '/opt/cardvault/ocr-venv'];
  const venvDirs = [...new Set([venv, ...homes, storageDir ? path.join(storageDir, 'ocr', 'venv') : undefined].filter((v): v is string => !!v))];
  const candidates = configured
    ? [configured]
    : [...venvDirs.flatMap((v) => [path.join(v, 'bin', 'python'), path.join(v, 'bin', 'python3')]), 'python3', 'python'];
  for (const c of candidates) {
    const probe = spawnSync(c, ['-c', 'import torch, PIL'], { timeout: 60_000, windowsHide: true, stdio: 'ignore' });
    if (!probe.error && probe.status === 0) return { python: c };
  }
  return {
    python: '',
    error: configured
      ? `${configured} cannot import torch and pillow. Install tools/ocr-trainer/requirements.txt into it, or clear OCR_TRAIN_PYTHON to let CardVault set it up.`
      : 'No Python with torch and pillow found (tried the trainer venv, python3, python). Press “Set up the OCR trainer” above, run bash scripts/ocr-python.sh on this server, or set OCR_TRAIN_PYTHON.',
  };
}

/** The path scripts/ocr-python.sh builds (and the app's setup button reports). */
export function trainVenvDir(config: { OCR_TRAIN_VENV?: string }, storageDir: string): string {
  return config.OCR_TRAIN_VENV || path.join(storageDir, 'ocr', 'venv');
}

/** Path of the setup script, found the same way as the trainer itself. */
export function findSetupScript(trainerDir: string): string {
  return path.join(path.dirname(trainerDir), '..', 'scripts', 'ocr-python.sh');
}

export interface PythonStatus {
  status: 'unknown' | 'missing' | 'ready' | 'installing' | 'failed';
  python?: string;
  error?: string;
  /** line of setup output being run now (install only) */
  step?: number;
  venv?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  log: string[];
}

/** Store the last interpreter check / setup run for OCR Lab. */
export async function savePythonStatus(ctx: WorkerContext, patch: Partial<PythonStatus>): Promise<PythonStatus> {
  const raw = await ctx.redis.get(PYTHON_KEY).catch(() => null);
  const before = raw ? (JSON.parse(raw) as PythonStatus) : ({ status: 'unknown', log: [], updatedAt: '' } as PythonStatus);
  const status: PythonStatus = { ...before, ...patch, updatedAt: new Date().toISOString() };
  await ctx.redis.set(PYTHON_KEY, JSON.stringify(status), 'EX', 7 * 24 * 3600).catch(() => undefined);
  return status;
}

/** The task-queue entry the trainer's Python setup writes its progress into. */
export const PYTHON_TASK_KEY = 'ocr-python';

/** What each setup phase does, in order (the API shows the same labels). */
export const SETUP_STEPS_LABELS = ['Virtual environment', 'PyTorch (CPU build)', 'Trainer packages'];

const SETUP_STEPS: { at: RegExp; step: number }[] = [
  { at: /^==> creating/, step: 1 },
  { at: /^==> reusing/, step: 1 },
  { at: /^==> installing PyTorch/, step: 2 },
  { at: /^==> the CPU index/, step: 2 },
  { at: /^==> installing the trainer/, step: 3 },
];

/** Which phase of the setup a script line belongs to (0 = not a phase line). */
export function setupStep(line: string): number {
  return SETUP_STEPS.find((s) => s.at.test(line))?.step ?? 0;
}

/** pip's progress bars are one long line with carriage returns: keep only the tail. */
export const shortenLine = (line: string) => {
  const parts = line.split(/\r+/).map((x) => x.trim()).filter(Boolean);
  const last = parts.at(-1) ?? line;
  return last.length > 300 ? `…${last.slice(-300)}` : last;
};

/**
 * Run scripts/ocr-python.sh: creates the venv, installs CPU PyTorch and the
 * trainer's requirements, and reports each phase into OCR Lab. Idempotent — a
 * healthy environment finishes in a second, so the same job also serves as the
 * "check" the Train button runs before starting.
 */
export async function setupOcrPython(ctx: WorkerContext): Promise<PythonStatus> {
  const trainerDir = findTrainerDir(ctx.config.OCR_TRAIN_DIR);
  const venv = trainVenvDir(ctx.config, ctx.storageDir);
  const configured = ctx.config.OCR_TRAIN_PYTHON;
  // a task in the queue like everything else: it can take minutes and it can fail
  const task = await ensureTask(ctx.redis, {
    key: PYTHON_TASK_KEY,
    kind: 'python',
    name: 'Set up the trainer’s Python',
    detail: 'Checking the trainer’s environment…',
    state: 'running',
  });
  const report = (progress: number, detail: string, label: string | null = null) =>
    void taskProgress(ctx.redis, task.key, { progress, detail, progressLabel: label });
  const done = (state: 'done' | 'failed', error: string | null, detail?: string) =>
    void saveTask(ctx.redis, { key: task.key, kind: 'python', name: 'Set up the trainer’s Python', state, error, progress: state === 'done' ? 100 : 0, detail: detail ?? undefined });
  const stepProgress = (step: number) => percent(step, SETUP_STEPS.length);

  if (!trainerDir) {
    await done('failed', 'tools/ocr-trainer/train.py was not found on this server.');
    return savePythonStatus(ctx, { status: 'failed', error: 'tools/ocr-trainer/train.py was not found on this server.', finishedAt: new Date().toISOString() });
  }

  // an explicitly configured interpreter is never replaced: only report on it
  if (configured) {
    const { python, error } = findTrainPython(configured, ctx.storageDir, venv);
    if (python) await done('done', null, `Using the interpreter in OCR_TRAIN_PYTHON (${python}).`);
    else await done('failed', error ?? 'The configured interpreter cannot import torch and pillow.');
    return savePythonStatus(ctx, python ? { status: 'ready', python, error: undefined } : { status: 'failed', error });
  }

  const script = findSetupScript(trainerDir);
  if (!existsSync(script)) {
    await done('failed', `The setup script ${script} was not found on this server.`);
    return savePythonStatus(ctx, { status: 'failed', venv, error: `The setup script ${script} was not found on this server.` });
  }

  await savePythonStatus(ctx, { status: 'installing', step: 0, venv, log: [], startedAt: new Date().toISOString(), error: undefined, python: undefined });
  report(0, 'Creating the virtual environment (a few hundred MB downloads once)…', 'Step 0 / ' + SETUP_STEPS.length);
  ctx.log.info({ venv, script }, 'OCR trainer Python setup starting');

  // a minimal environment: setup needs no CardVault secrets. HOME picks up
  // ~/ocr-venv for people following the README; the venv itself lives under storage.
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'TZ', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL']) if (process.env[k]) env[k] = process.env[k];
  env.OCR_TRAIN_VENV = venv;

  return new Promise<PythonStatus>((resolve) => {
    const child = spawn('/bin/bash', [script], { cwd: path.dirname(path.dirname(script)), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let log: string[] = [];
    let step = 0;
    let pending = '';
    const push = (raw: string) => {
      const line = shortenLine(raw);
      if (!line) return;
      log = [...log, line].slice(-LOG_TAIL);
      const found = setupStep(line);
      if (found > step) {
        step = found;
        void savePythonStatus(ctx, { status: 'installing', step, log });
        report(stepProgress(step), `Step ${step} of ${SETUP_STEPS.length}: ${SETUP_STEPS_LABELS[step - 1] ?? line}`, `Step ${step} / ${SETUP_STEPS.length}`);
      } else void savePythonStatus(ctx, { log });
    };
    const consume = (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      for (const p of parts) push(p.replace(/\r$/, ''));
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.on('error', (e) => {
      void done('failed', `Could not run the setup script: ${e.message}`);
      void savePythonStatus(ctx, { status: 'failed', venv, error: `Could not run the setup script: ${e.message}`, finishedAt: new Date().toISOString() }).then(resolve);
    });
    child.on('exit', (code) => {
      if (pending) push(pending);
      const finishedAt = new Date().toISOString();
      if (code === 0) {
        const python = path.join(venv, 'bin', 'python');
        ctx.log.info({ venv }, 'OCR trainer Python ready');
        void done('done', null, `Ready: ${python}`);
        void savePythonStatus(ctx, { status: 'ready', python, step: 3, log, finishedAt }).then(resolve);
        return;
      }
      const tail = log.slice(-12).join('\n');
      const hint =
        code === 2
          ? 'Python 3 is not installed on this server.'
          : 'The setup could not finish. The log above shows why (no internet access to PyPI, python3-venv missing, disk space…).';
      ctx.log.warn({ code, venv }, 'OCR trainer Python setup failed');
      void done('failed', hint);
      void savePythonStatus(ctx, { status: 'failed', venv, error: `${hint}\n${tail}`, finishedAt, log }).then(resolve);
    });
  });
}

const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};

/** The task-queue entry training writes its progress into. */
export const TRAIN_TASK_KEY = 'ocr-train';
const RECENT_SAMPLES = 12;

/**
 * Run tools/ocr-trainer/train.py on an exported dataset.
 *
 * Progress is written to `ocr:train` (what OCR Lab reads) and mirrored into the
 * task queue (`ocr:train`) on every batch, epoch and held-out sample, so the
 * queue can show a percentage, a runtime and a time until finished without
 * polling the trainer itself. The trainer prints its plan first ("plan epochs
 * 30 steps 12 × 41 …"), which is what makes the ETA possible: steps in, steps
 * done, pace out.
 */
export async function trainModel(
  ctx: WorkerContext,
  data: { dataset?: string; epochs?: number; synthetic?: number; maxMinutes?: number },
): Promise<TrainStatus> {
  const requested = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(data.dataset ?? '')) ? String(data.dataset) : 'latest';
  const epochs = clamp(data.epochs, 1, 500, 30);
  const synthetic = clamp(data.synthetic, 0, 200_000, 20_000);
  const maxMinutes = clamp(data.maxMinutes, 0, 10_080, 0);

  let status: TrainStatus = {
    status: 'starting',
    requested,
    epochs,
    synthetic,
    log: [],
    history: [],
    recent: [],
    etaSeconds: null,
    secondsPerEpoch: null,
    updatedAt: new Date().toISOString(),
  };
  const task = await ensureTask(ctx.redis, {
    key: TRAIN_TASK_KEY,
    kind: 'train',
    name: 'Train a line reader',
    detail: 'Starting the trainer…',
    state: 'running',
  });
  const save = async (patch: Partial<TrainStatus>) => {
    status = { ...status, ...patch, log: patch.log ?? status.log, updatedAt: new Date().toISOString() };
    await ctx.redis.set(TRAIN_KEY, JSON.stringify(status), 'EX', 7 * 24 * 3600);
    return status;
  };
  const finish = (state: 'done' | 'failed' | 'cancelled', error: string | null, result?: string | null) =>
    void saveTask(ctx.redis, {
      key: task.key,
      kind: 'train',
      name: 'Train a line reader',
      state,
      error,
      result: result ?? null,
      progress: state === 'done' ? 100 : Math.min(99, percent(status.step ?? 0, status.steps ?? 0)),
    });

  const trainerDir = findTrainerDir(ctx.config.OCR_TRAIN_DIR);
  if (!trainerDir) {
    await finish('failed', 'tools/ocr-trainer/train.py was not found on this server.');
    return save({ status: 'failed', error: 'tools/ocr-trainer/train.py was not found on this server.', finishedAt: new Date().toISOString() });
  }
  const { python, error: pyError } = findTrainPython(ctx.config.OCR_TRAIN_PYTHON, ctx.storageDir, ctx.config.OCR_TRAIN_VENV);
  if (!python) {
    // OCR Lab asks the admin to press "Set up the OCR trainer" and offers the
    // manual command; keep the interpreter report in step with what we saw.
    await savePythonStatus(ctx, { status: 'missing', error: pyError });
    await finish('failed', pyError ?? 'No Python with torch and pillow found.');
    return save({ status: 'failed', error: pyError, finishedAt: new Date().toISOString() });
  }
  await save({ python, startedAt: new Date().toISOString() });
  await savePythonStatus(ctx, { status: 'ready', python, error: undefined });

  const args = [
    '-u',
    path.join(trainerDir, 'train.py'),
    '--storage', ctx.storageDir,
    '--dataset', requested,
    '--epochs', String(epochs),
    '--synthetic', String(synthetic),
    '--max-minutes', String(maxMinutes),
    // a time limit set in the lab's form is a deliberate cut-off: keep the best
    // epoch instead of discarding the run that hit it
    ...(maxMinutes ? ['--time-limit-danger'] : []),
    '--progress-every', '1',
    '--samples', String(RECENT_SAMPLES),
  ];
  ctx.log.info({ python, dataset: requested, epochs, synthetic }, 'OCR trainer starting');
  await ctx.redis.del(TRAIN_CANCEL_KEY);

  // a minimal environment: python needs no CardVault secrets; UTF-8 output is forced
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'TZ', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']) if (process.env[k]) env[k] = process.env[k];
  env.PYTHONUNBUFFERED = '1';
  env.PYTHONIOENCODING = 'utf-8';

  const child = spawn(python, args, { cwd: trainerDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  let cancelled = false;
  let exited: number | null = null;
  child.on('exit', (code) => (exited = code ?? -1));
  const kill = (sig: NodeJS.Signals) => {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  };

  // keep the status fresh even between epochs, and honour cancel requests
  const heartbeat = setInterval(() => void save({}), 30_000);
  const cancelPoll = setInterval(() => {
    void ctx.redis.get(TRAIN_CANCEL_KEY).then((v) => {
      if (v !== '1') return;
      cancelled = true;
      void ctx.redis.del(TRAIN_CANCEL_KEY);
      void taskProgress(ctx.redis, TRAIN_TASK_KEY, { detail: 'Stopping after this step…' });
      kill('SIGTERM');
      setTimeout(() => exited === null && kill('SIGKILL'), 8_000);
    });
  }, 2_000);

  const consume = (chunk: Buffer) => {
    for (const raw of chunk.toString('utf8').split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) continue;
      const ev = parseTrainerLine(line);
      const log = [...status.log, line].slice(-LOG_TAIL);
      if (ev?.type === 'dataset') {
        void save({ log, dataset: ev.id, lines: ev.lines });
        void taskProgress(ctx.redis, TRAIN_TASK_KEY, { detail: `Loaded ${ev.lines.toLocaleString()} lines from ${ev.id}` });
      } else if (ev?.type === 'plan') {
        const history: TrainStatus['history'] = [];
        void save({ log, epochs: ev.epochs, batches: ev.stepsPerEpoch, steps: ev.epochsSteps, history });
        void taskProgress(ctx.redis, TRAIN_TASK_KEY, {
          progress: 0,
          progressLabel: `0 / ${ev.epochsSteps} steps`,
          detail: `${ev.epochs} epochs × ${ev.stepsPerEpoch} steps · ${ev.train.toLocaleString()} train / ${ev.dev.toLocaleString()} held-out lines`,
          etaSeconds: null,
        });
      } else if (ev?.type === 'batch') {
        const plan = status.steps ?? 0;
        const epoch = status.epoch ?? 0;
        const epochsTotal = status.epochs ?? 0;
        const stepsPer = status.batches ?? ev.steps;
        const step = stepAt(epoch, stepsPer, ev.step);
        const startedAt = status.startedAt ? new Date(status.startedAt).getTime() : null;
        const elapsed = startedAt ? Date.now() - startedAt : 0;
        const p = plan ? Math.min(99, percent(step, plan)) : 0;
        void save({ log, status: 'running', step, batch: ev.step, loss: ev.loss });
        void taskProgress(ctx.redis, TRAIN_TASK_KEY, {
          progress: p,
          progressLabel: `${step.toLocaleString()} / ${plan.toLocaleString()} steps`,
          detail: `Epoch ${epoch + 1} of ${epochsTotal || '?'} · loss ${ev.loss.toFixed(3)}`,
          etaSeconds: etaFromEpochs(step, plan, elapsed),
        });
      } else if (ev?.type === 'epoch') {
        const startedAt = status.startedAt ? new Date(status.startedAt).getTime() : null;
        const elapsed = startedAt ? Date.now() - startedAt : 0;
        const history = [...(status.history ?? []), { epoch: ev.epoch, loss: ev.loss, devName: ev.devName, devNumber: ev.devNumber, minutes: ev.minutes }];
        const bestSoFar = [...history].sort((a, b) => scoreOf(b) - scoreOf(a))[0];
        const step = ev.epoch * (status.batches ?? 0);
        const plan = status.steps ?? 0;
        const secondsPerEpoch = ev.seconds ?? (elapsed ? Math.round(elapsed / ev.epoch / 1000) : null);
        void save({
          log,
          epoch: ev.epoch,
          loss: ev.loss,
          devName: ev.devName,
          devNumber: ev.devNumber,
          minutes: ev.minutes,
          history,
          status: 'running',
          secondsPerEpoch,
          bestEpoch: bestSoFar?.epoch,
          bestName: bestSoFar?.devName ?? null,
          bestNumber: bestSoFar?.devNumber ?? null,
          etaSeconds: etaFromEpochs(ev.epoch, status.epochs ?? 0, elapsed),
        });
        void taskProgress(ctx.redis, TRAIN_TASK_KEY, {
          progress: plan ? Math.min(99, percent(step, plan)) : percent(ev.epoch, status.epochs ?? 0),
          progressLabel: plan ? `${Math.min(step, plan).toLocaleString()} / ${plan.toLocaleString()} steps` : `epoch ${ev.epoch} / ${status.epochs ?? '?'}`,
          detail: `Epoch ${ev.epoch} of ${status.epochs ?? '?'} · loss ${ev.loss.toFixed(3)} · held out: names ${fmtPct(ev.devName)}, numbers ${fmtPct(ev.devNumber)}`,
          etaSeconds: etaFromEpochs(ev.epoch, status.epochs ?? 0, elapsed),
        });
      } else if (ev?.type === 'sample') {
        // the trainer re-reads a handful of held-out lines each epoch: the
        // queue of what it gets right, wrong and how sure it was
        const epoch = status.epoch ?? ev.epoch ?? 0;
        const pool = (status.recent ?? []).filter((x) => x.id !== ev.id);
        const { type: _type, ...sample } = ev;
        const recent = [{ ...sample, epoch }, ...pool].slice(0, RECENT_SAMPLES);
        void save({ log, recent });
      } else if (ev?.type === 'wrote') {
        void save({ log, modelId: ev.modelId });
        void taskProgress(ctx.redis, TRAIN_TASK_KEY, { progress: 99, detail: `Writing ${ev.modelId}…` });
      } else if (ev?.type === 'dev') void save({ log, dev: ev.dev });
      else void save({ log, status: status.status === 'starting' ? 'running' : status.status });
    }
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', consume); // warnings and tracebacks end up in the log tail

  while (exited === null) await new Promise((r) => setTimeout(r, 250));
  clearInterval(heartbeat);
  clearInterval(cancelPoll);

  const tail = status.log.slice(-8).join('\n');
  const finishedAt = new Date().toISOString();
  if (cancelled) {
    const s = await save({ status: 'cancelled', error: 'Stopped on request.', finishedAt });
    await finish('cancelled', 'Stopped on request.');
    ctx.log.info({ dataset: status.dataset }, 'OCR trainer cancelled');
    return s;
  }
  if (exited !== 0) {
    const s = await save({ status: 'failed', error: `The trainer exited with code ${exited}.${tail ? `\n${tail}` : ''}`, finishedAt });
    await finish('failed', `The trainer exited with code ${exited}.`);
    ctx.log.warn({ code: exited, dataset: status.dataset }, 'OCR trainer failed');
    return s;
  }
  if (!status.modelId) {
    await finish('failed', 'The trainer finished but reported no model.');
    return save({ status: 'failed', error: `The trainer finished but reported no model.${tail ? `\n${tail}` : ''}`, finishedAt });
  }
  ctx.log.info({ model: status.modelId, dataset: status.dataset, minutes: status.minutes }, 'OCR trainer finished');
  // register the model so OCR Lab can score, trial and promote it
  await ctx.queues.maintenance.add('ocr-scan-models', {}, { removeOnComplete: 10, removeOnFail: 10 });
  await finish('done', null, status.modelId);
  return save({ status: 'done', finishedAt, etaSeconds: 0, step: status.steps ?? status.step });
}

/** The overall step a batch finishes at: epoch × steps-per-epoch + batch. */
export function stepAt(epoch: number, stepsPerEpoch: number, batch: number): number {
  return Math.max(0, epoch * stepsPerEpoch + batch);
}

/** How good an epoch is: the held-out accuracy of the checkpoint the trainer keeps. */
export function scoreOf(e: { devName: number | null; devNumber: number | null }): number {
  const vals = [e.devName, e.devNumber].filter((v): v is number => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

const fmtPct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
