import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { eq, ocrModels } from '@cardvault/database';
import { lineTensor } from '@cardvault/imaging';
import type { WorkerContext } from '../context.js';
import { ENGINE_ID as TESSERACT_ID, readLine, type LineField, type LineReading } from './ocr.js';

/** Something that reads one cropped text line. Tesseract and trained models both are. */
export interface LineEngine {
  id: string;
  read(crop: Buffer, field: LineField, opts: { numberChars?: string }): Promise<LineReading>;
}

export function tesseractEngine(ctx: WorkerContext): LineEngine {
  return {
    id: TESSERACT_ID,
    read: (crop, field, opts) => readLine(crop, field, { numberChars: opts.numberChars, log: ctx.log, langPath: ctx.config.OCR_LANG_PATH }),
  };
}

interface ModelCard {
  id: string;
  charset: string;
  input?: { height: number; maxWidth: number };
}

type Ort = typeof import('onnxruntime-node');
let ortPromise: Promise<Ort> | null = null;
const ort = () => (ortPromise ??= import('onnxruntime-node'));

/**
 * A line reader trained by tools/ocr-trainer: a CRNN exported to ONNX that
 * outputs per-column character probabilities (CTC, index 0 = blank). Number
 * spots may only produce characters a collector number can contain.
 */
export class OnnxLineEngine implements LineEngine {
  readonly id: string;
  private session: Promise<import('onnxruntime-node').InferenceSession> | null = null;
  private readonly chars: string[];

  constructor(
    readonly dir: string,
    card: ModelCard,
  ) {
    this.id = `model:${card.id}`;
    this.chars = ['', ...Array.from(card.charset)];
  }

  private load() {
    this.session ??= ort().then((o) => o.InferenceSession.create(path.join(this.dir, 'model.onnx'), { intraOpNumThreads: 2 }));
    return this.session;
  }

  async read(crop: Buffer, field: LineField, opts: { numberChars?: string }): Promise<LineReading> {
    const [o, session] = await Promise.all([ort(), this.load()]);
    const { data, width, height } = await lineTensor(crop);
    const out = await session.run({ image: new o.Tensor('float32', data, [1, 1, height, width]) });
    const logp = out[session.outputNames[0]!]!;
    const [, T, C] = logp.dims as number[];
    const v = logp.data as Float32Array;
    const allowed = field === 'number' && opts.numberChars ? new Set(opts.numberChars) : null;
    return decode(v, T!, C!, this.chars, allowed);
  }
}

/**
 * Greedy CTC decoding of log-probabilities [T, C]. Disallowed characters are
 * skipped when choosing each column's best class. Confidence is the geometric
 * mean of the best probability of every emitted character (or of the blanks,
 * for an empty reading).
 */
export function decode(v: Float32Array, T: number, C: number, chars: string[], allowed: Set<string> | null): LineReading {
  let text = '';
  let prev = 0;
  let logConf = 0, n = 0, runBest = -Infinity, blankLog = 0;
  for (let t = 0; t < T; t++) {
    let best = 0, bestV = -Infinity;
    for (let c = 0; c < C; c++) {
      if (c > 0 && allowed && !allowed.has(chars[c] ?? '')) continue;
      const x = v[t * C + c]!;
      if (x > bestV) (bestV = x), (best = c);
    }
    if (best === 0) blankLog += bestV;
    if (best !== 0 && best !== prev) {
      if (runBest > -Infinity) (logConf += runBest), n++;
      text += chars[best] ?? '';
      runBest = bestV;
    } else if (best !== 0 && best === prev) runBest = Math.max(runBest, bestV);
    prev = best;
  }
  if (runBest > -Infinity) (logConf += runBest), n++;
  const confidence = n ? Math.exp(logConf / n) : Math.exp(blankLog / Math.max(1, T));
  const t = text.trim();
  return { text: t, readings: [t], confidence };
}

const engines = new Map<string, Promise<LineEngine>>();

/** An engine by id: 'tesseract…' or 'model:<id>' (a registered model). */
export function engineFor(ctx: WorkerContext, spec: string): Promise<LineEngine> {
  if (!spec.startsWith('model:')) return Promise.resolve(tesseractEngine(ctx));
  let e = engines.get(spec);
  if (!e) {
    e = (async () => {
      const id = spec.slice('model:'.length);
      const [m] = await ctx.db.select().from(ocrModels).where(eq(ocrModels.id, id));
      if (!m) throw new Error(`unknown model ${id}`);
      const dir = path.resolve(ctx.storageDir, m.dir);
      const card = JSON.parse(await readFile(path.join(dir, 'card.json'), 'utf8')) as ModelCard;
      return new OnnxLineEngine(dir, card);
    })();
    e.catch(() => engines.delete(spec));
    engines.set(spec, e);
  }
  return e;
}

/** Below this, a model's reading of a live scan is replaced by Tesseract's. */
export const FALLBACK_CONFIDENCE = 0.5;

let active: { at: number; engine: LineEngine | null } = { at: 0, engine: null };

/**
 * The engine that reads live scans: the active model with Tesseract as a
 * safety net for lines it isn't sure of, or Tesseract alone. Re-checked every
 * 30 seconds, so a promotion or rollback takes effect without a restart.
 */
export async function liveEngine(ctx: WorkerContext): Promise<LineEngine | null> {
  if (Date.now() - active.at < 30_000) return active.engine;
  let engine: LineEngine | null = null;
  try {
    const [m] = await ctx.db.select({ id: ocrModels.id }).from(ocrModels).where(eq(ocrModels.status, 'active')).limit(1);
    if (m) {
      const model = await engineFor(ctx, `model:${m.id}`);
      const tess = tesseractEngine(ctx);
      engine = {
        id: `${model.id}+fallback`,
        async read(crop, field, opts) {
          const r = await model.read(crop, field, opts).catch(() => null);
          if (r && r.confidence >= FALLBACK_CONFIDENCE) return r;
          return tess.read(crop, field, opts);
        },
      };
    }
  } catch (e) {
    ctx.log.warn({ err: (e as Error).message }, 'active OCR model unavailable; using Tesseract');
  }
  active = { at: Date.now(), engine };
  return engine;
}

/** Forget the cached choice (after a promotion or rollback). */
export function resetLiveEngine() {
  active = { at: 0, engine: null };
}

let shadow: { at: number; engine: LineEngine | null } = { at: 0, engine: null };

/** The model on live trial, if any (no Tesseract fallback: it is judged as it is). */
export async function shadowEngine(ctx: WorkerContext): Promise<LineEngine | null> {
  if (Date.now() - shadow.at < 30_000) return shadow.engine;
  let engine: LineEngine | null = null;
  try {
    const [m] = await ctx.db.select({ id: ocrModels.id }).from(ocrModels).where(eq(ocrModels.status, 'shadow')).limit(1);
    if (m) engine = await engineFor(ctx, `model:${m.id}`);
  } catch (e) {
    ctx.log.warn({ err: (e as Error).message }, 'OCR trial model unavailable');
  }
  shadow = { at: Date.now(), engine };
  return engine;
}
