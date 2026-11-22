import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerContext } from '../context.js';

/**
 * Training runs tools/ocr-trainer/train.py as a child process (CPU PyTorch) and
 * reports its progress into redis (`ocr:train`), the same pattern as the
 * harvest import: OCR Lab shows the live status and the trainer's log tail,
 * and the finished model is registered for scoring automatically.
 */

export const TRAIN_KEY = 'ocr:train';
export const TRAIN_CANCEL_KEY = 'ocr:train:cancel';

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
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export type TrainEvent =
  | { type: 'dataset'; id: string; lines: number }
  | { type: 'epoch'; epoch: number; loss: number; devName: number | null; devNumber: number | null; minutes: number }
  | { type: 'wrote'; modelId: string }
  | { type: 'dev'; dev: unknown };

/** One line of train.py stdout → a progress event (or null for plain log). */
export function parseTrainerLine(line: string): TrainEvent | null {
  let m = /^dataset (\S+): (\d+) lines/.exec(line);
  if (m) return { type: 'dataset', id: m[1]!, lines: Number(m[2]) };
  m = /^epoch\s+(\d+)\s+loss\s+([0-9.]+)\s+dev name\s+(\S+)\s+number\s+(\S+)\s+\(([0-9.]+) min\)/.exec(line);
  if (m) {
    const num = (s: string) => (s === 'None' ? null : Number(s));
    return { type: 'epoch', epoch: Number(m[1]), loss: Number(m[2]), devName: num(m[3]!), devNumber: num(m[4]!), minutes: Number(m[5]) };
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
 * set, otherwise the README's ~/ocr-venv, then python3/python on PATH.
 */
export function findTrainPython(configured?: string): { python: string; error?: string } {
  const candidates = configured
    ? [configured]
    : [path.join(homedir(), 'ocr-venv', 'bin', 'python'), path.join(homedir(), 'ocr-venv', 'bin', 'python3'), 'python3', 'python'];
  for (const c of candidates) {
    const probe = spawnSync(c, ['-c', 'import torch, PIL'], { timeout: 60_000, windowsHide: true, stdio: 'ignore' });
    if (!probe.error && probe.status === 0) return { python: c };
  }
  return {
    python: '',
    error: configured
      ? `${configured} cannot import torch and pillow. Install tools/ocr-trainer/requirements.txt into it.`
      : 'No Python with torch and pillow found (tried ~/ocr-venv/bin/python, python3, python). Install tools/ocr-trainer/requirements.txt (see its README) or set OCR_TRAIN_PYTHON.',
  };
}

const LOG_TAIL = 80;
const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};

export async function trainModel(
  ctx: WorkerContext,
  data: { dataset?: string; epochs?: number; synthetic?: number; maxMinutes?: number },
): Promise<TrainStatus> {
  const requested = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(data.dataset ?? '')) ? String(data.dataset) : 'latest';
  const epochs = clamp(data.epochs, 1, 500, 30);
  const synthetic = clamp(data.synthetic, 0, 200_000, 20_000);
  const maxMinutes = clamp(data.maxMinutes, 0, 10_080, 0);

  let status: TrainStatus = { status: 'starting', requested, epochs, synthetic, log: [], updatedAt: new Date().toISOString() };
  const save = async (patch: Partial<TrainStatus>) => {
    status = { ...status, ...patch, log: patch.log ?? status.log, updatedAt: new Date().toISOString() };
    await ctx.redis.set(TRAIN_KEY, JSON.stringify(status), 'EX', 7 * 24 * 3600);
    return status;
  };

  const trainerDir = findTrainerDir(ctx.config.OCR_TRAIN_DIR);
  if (!trainerDir) {
    return save({ status: 'failed', error: 'tools/ocr-trainer/train.py was not found on this server.', finishedAt: new Date().toISOString() });
  }
  const { python, error: pyError } = findTrainPython(ctx.config.OCR_TRAIN_PYTHON);
  if (!python) return save({ status: 'failed', error: pyError, finishedAt: new Date().toISOString() });
  await save({ python, startedAt: new Date().toISOString() });

  const args = [
    '-u',
    path.join(trainerDir, 'train.py'),
    '--storage', ctx.storageDir,
    '--dataset', requested,
    '--epochs', String(epochs),
    '--synthetic', String(synthetic),
    '--max-minutes', String(maxMinutes),
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
      if (ev?.type === 'dataset') void save({ log, dataset: ev.id, lines: ev.lines });
      else if (ev?.type === 'epoch') void save({ log, epoch: ev.epoch, loss: ev.loss, devName: ev.devName, devNumber: ev.devNumber, minutes: ev.minutes, status: 'running' });
      else if (ev?.type === 'wrote') void save({ log, modelId: ev.modelId });
      else if (ev?.type === 'dev') void save({ log, dev: ev.dev });
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
    ctx.log.info({ dataset: status.dataset }, 'OCR trainer cancelled');
    return s;
  }
  if (exited !== 0) {
    const s = await save({ status: 'failed', error: `The trainer exited with code ${exited}.${tail ? `\n${tail}` : ''}`, finishedAt });
    ctx.log.warn({ code: exited, dataset: status.dataset }, 'OCR trainer failed');
    return s;
  }
  if (!status.modelId) {
    return save({ status: 'failed', error: `The trainer finished but reported no model.${tail ? `\n${tail}` : ''}`, finishedAt });
  }
  ctx.log.info({ model: status.modelId, dataset: status.dataset, minutes: status.minutes }, 'OCR trainer finished');
  // register the model so OCR Lab can score, trial and promote it
  await ctx.queues.maintenance.add('ocr-scan-models', {}, { removeOnComplete: 10, removeOnFail: 10 });
  return save({ status: 'done', finishedAt });
}
