import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { eq, ocrModels } from '@cardvault/database';
import { classifierTensor, lineTensor, type LineTensorSpec } from '@cardvault/imaging';
import type { WorkerContext } from '../context.js';
import { ENGINE_ID as TESSERACT_ID, readLine, type LineField, type LineReading } from './ocr.js';
import {
  CLASSIFIER_MIN_CONFIDENCE,
  decodeClassifier,
  decodeCtc,
  gameForClass,
  loadVisionArtifact,
  type ClassGuess,
  type VisionArtifact,
} from './vision.js';

/** Something that reads one cropped text line. Tesseract and trained models both are. */
export interface LineEngine {
  id: string;
  read(crop: Buffer, field: LineField, opts: { numberChars?: string }): Promise<LineReading>;
}

/**
 * Reads a card's game, from the whole card. A CardVault-Vision `card-classifier`
 * artifact answers in milliseconds on CPU, which is what lets a scan skip the
 * two full-card Tesseract passes that used to be needed just to guess a game.
 */
export interface CardClassifier {
  id: string;
  /** a CardVault game slug, or null when it declines (OTHER/UNKNOWN/unsure) */
  classify(card: Buffer): Promise<{ game: string; guess: ClassGuess } | null>;
}

export function tesseractEngine(ctx: WorkerContext): LineEngine {
  return {
    id: TESSERACT_ID,
    read: (crop, field, opts) => readLine(crop, field, { numberChars: opts.numberChars, log: ctx.log, langPath: ctx.config.OCR_LANG_PATH }),
  };
}

// ------------------------------------------------------------------ the model card

/**
 * What OCR Lab stores in `ocr_models.card` for a model. Legacy models (written
 * by tools/ocr-trainer) carry a `charset` and an `input` spec; CardVault-Vision
 * exports carry their task, version, contract and checksum. One row can also
 * stand for a *pair* of Vision heads (`name-ocr` + `number-ocr`), because that
 * is how a scan uses them.
 */
export interface ModelCard {
  /** absent for a tools/ocr-trainer model: it reads every field */
  kind?: 'trainer' | 'vision';
  id: string;
  /** legacy: the label set, index 0 = blank, charset[i] at i + 1 */
  charset?: string;
  /** legacy: input size the trainer baked into the export */
  input?: { height: number; maxWidth: number };
  task?: 'name-ocr' | 'number-ocr' | 'card-classifier';
  version?: string;
  architecture?: string;
  /** `<task>/<version>` under the models root, per head */
  heads?: { name?: string; number?: string };
  /** the export a card classifier came from */
  dir?: string;
  /** the artifact the registry should run, if several share a task */
  checksum?: string;
  metrics?: Record<string, unknown>;
  dataset?: unknown;
  training?: unknown;
  dev?: unknown;
}

type Ort = typeof import('onnxruntime-node');
let ortPromise: Promise<Ort> | null = null;
const ort = () => (ortPromise ??= import('onnxruntime-node'));

/** One loaded ONNX session plus the artifact JSON it was verified against. */
async function openSession(absoluteDir: string, intraOpNumThreads = Number(process.env.OCR_INTRA_OP_THREADS) || 2) {
  const [o, artifact] = await Promise.all([ort(), loadVisionArtifact(absoluteDir, absoluteDir)]);
  const modelPath = path.join(absoluteDir, 'model.onnx');
  const provider = process.env.OCR_EXECUTION_PROVIDER ?? 'auto';
  const options = { intraOpNumThreads, interOpNumThreads: 1 };
  let session: import('onnxruntime-node').InferenceSession;
  if (provider === 'cpu') {
    session = await o.InferenceSession.create(modelPath, { ...options, executionProviders: ['cpu'] });
  } else {
    try {
      session = await o.InferenceSession.create(modelPath, { ...options, executionProviders: ['cuda', 'cpu'] });
    } catch (error) {
      if (provider === 'cuda') throw new Error(`CUDA inference requested but unavailable: ${(error as Error).message}`);
      session = await o.InferenceSession.create(modelPath, { ...options, executionProviders: ['cpu'] });
    }
  }
  return { o, artifact, session };
}

// ------------------------------------------------------------------ OCR heads

/**
 * One CardVault-Vision OCR head (`name-ocr` or `number-ocr`): a CRNN exported to
 * ONNX that returns time-major logits over its CTC label set. The artifact's own
 * preprocessing and contract drive the tensor and the decode.
 */
export class VisionLineHead {
  private session: Promise<{ o: Ort; artifact: VisionArtifact; session: import('onnxruntime-node').InferenceSession }> | null = null;
  private readonly spec: LineTensorSpec;

  constructor(
    readonly absoluteDir: string,
    readonly artifact: VisionArtifact,
  ) {
    this.spec = artifact.lineSpec ?? { height: 32, minWidth: 32, maxWidth: 1600, range: 'unit' };
  }

  private load() {
    this.session ??= openSession(this.absoluteDir);
    return this.session;
  }

  async read(crop: Buffer, field: LineField, opts: { numberChars?: string }): Promise<LineReading> {
    const { o, artifact, session } = await this.load();
    const { data, width, height } = await lineTensor(crop, this.spec);
    const out = await session.run({ [artifact.inputName]: new o.Tensor('float32', data, [1, 1, height, width]) });
    const tensor = out[artifact.outputName] ?? out[session.outputNames[0]!]!;
    const dims = tensor.dims as number[];
    // contract: [T, N, C] (time-major). Accept [N, T, C] from a hand-made
    // export too, so a model that decodes is never rejected over axis order.
    const [d0, d1, d2] = dims as [number, number, number];
    const timeMajor = dims.length === 3 && d1 === 1;
    const T = timeMajor ? d0 : d1;
    const C = d2;
    const v = tensor.data as Float32Array;
    // [N, T, C] → [T, C] for the decoder (batch is always 1 here)
    const logits = timeMajor ? v : transposeTimeMajor(v, T, C);
    const allowed = field === 'number' && opts.numberChars ? new Set(opts.numberChars) : null;
    const reading = decodeCtc(logits, T, C, {
      labels: artifact.labels,
      indexOffset: artifact.indexOffset,
      blankIndex: artifact.blankIndex,
      padIndex: artifact.padIndex,
      allowed,
    });
    return { text: reading.text, readings: [reading.text], confidence: reading.confidence };
  }
}

/** `[N=1, T, C]` → `[T, C]` (a copy: the decoder reads it time-major). */
export function transposeTimeMajor(v: Float32Array, T: number, C: number): Float32Array {
  const out = new Float32Array(T * C);
  for (let t = 0; t < T; t++) for (let c = 0; c < C; c++) out[t * C + c] = v[t * C + c]!;
  return out;
}

/**
 * A scan's line reader backed by CardVault-Vision export(s): `name` reads go to
 * `name-ocr`, `number` reads to `number-ocr`. With one head only, that head
 * serves both fields (and the other field's lines keep whatever the live engine
 * falls back to) rather than refusing to load.
 */
export class VisionLineEngine implements LineEngine {
  readonly id: string;
  private readonly heads: { name?: VisionLineHead; number?: VisionLineHead };

  constructor(readonly absoluteDirs: { name?: { dir: string; artifact: VisionArtifact }; number?: { dir: string; artifact: VisionArtifact } }) {
    this.heads = {
      ...(absoluteDirs.name ? { name: new VisionLineHead(absoluteDirs.name.dir, absoluteDirs.name.artifact) } : {}),
      ...(absoluteDirs.number ? { number: new VisionLineHead(absoluteDirs.number.dir, absoluteDirs.number.artifact) } : {}),
    };
    const versions = [absoluteDirs.name?.artifact.metadata.version, absoluteDirs.number?.artifact.metadata.version].filter(Boolean);
    this.id = `vision:${versions.join('+') || 'ocr'}`;
  }

  async read(crop: Buffer, field: LineField, opts: { numberChars?: string }): Promise<LineReading> {
    const head = this.heads[field] ?? this.heads.name ?? this.heads.number;
    if (!head) throw new Error('no OCR head loaded');
    return head.read(crop, field, opts);
  }
}

// ------------------------------------------------------------------ card classifier

/** A CardVault-Vision `card-classifier` artifact, run on every scan before OCR crops. */
export class VisionClassifier implements CardClassifier {
  private session: Promise<{ o: Ort; artifact: VisionArtifact; session: import('onnxruntime-node').InferenceSession }> | null = null;
  readonly id: string;

  constructor(
    readonly absoluteDir: string,
    readonly artifact: VisionArtifact,
  ) {
    this.id = `classifier:${artifact.metadata.version ?? path.basename(absoluteDir)}`;
  }

  private load() {
    this.session ??= openSession(this.absoluteDir, 1);
    return this.session;
  }

  async classify(card: Buffer): Promise<{ game: string; guess: ClassGuess } | null> {
    const { o, artifact, session } = await this.load();
    const size = artifact.classifierSize ?? 160;
    const { data } = await classifierTensor(card, size);
    const out = await session.run({ [artifact.inputName]: new o.Tensor('float32', data, [1, 3, size, size]) });
    const tensor = out[artifact.outputName] ?? out[session.outputNames[0]!]!;
    const guess = decodeClassifier(tensor.data as Float32Array, artifact.labels);
    if (guess.confidence < CLASSIFIER_MIN_CONFIDENCE) return null;
    const game = gameForClass(guess.label);
    return game ? { game, guess } : null;
  }
}

/** Legacy tools/ocr-trainer model: single-file card.json + model.onnx. */
export class OnnxLineEngine implements LineEngine {
  readonly id: string;
  private session: Promise<import('onnxruntime-node').InferenceSession> | null = null;
  private readonly chars: string[];
  private readonly spec: LineTensorSpec;

  constructor(
    readonly dir: string,
    card: ModelCard,
  ) {
    this.id = `model:${card.id}`;
    this.chars = ['', ...Array.from(card.charset ?? '')];
    this.spec = {
      height: card.input?.height ?? 32,
      minWidth: 8,
      maxWidth: card.input?.maxWidth ?? 512,
      range: 'signed',
    };
  }

  private load() {
    this.session ??= ort().then(async (o) => {
      const modelPath = path.join(this.dir, 'model.onnx');
      const intraOpNumThreads = Number(process.env.OCR_INTRA_OP_THREADS) || 2;
      const provider = process.env.OCR_EXECUTION_PROVIDER ?? 'auto';
      const options = { intraOpNumThreads, interOpNumThreads: 1 };
      if (provider === 'cpu') return o.InferenceSession.create(modelPath, { ...options, executionProviders: ['cpu'] });
      try {
        return await o.InferenceSession.create(modelPath, { ...options, executionProviders: ['cuda', 'cpu'] });
      } catch (error) {
        if (provider === 'cuda') throw new Error(`CUDA inference requested but unavailable: ${(error as Error).message}`);
        return o.InferenceSession.create(modelPath, { ...options, executionProviders: ['cpu'] });
      }
    });
    return this.session;
  }

  async read(crop: Buffer, field: LineField, opts: { numberChars?: string }): Promise<LineReading> {
    const [o, session] = await Promise.all([ort(), this.load()]);
    const { data, width, height } = await lineTensor(crop, this.spec);
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

// ------------------------------------------------------------------ registry

const engines = new Map<string, Promise<LineEngine>>();
const classifiers = new Map<string, Promise<CardClassifier | null>>();

/** Absolute path of a model directory stored relative to the storage folder. */
export const modelDir = (ctx: WorkerContext, relative: string) => path.resolve(ctx.storageDir, relative);

/**
 * Load the engine a registered model describes. Vision rows load their declared
 * heads (`name-ocr` / `number-ocr`); a legacy row loads its single ONNX file.
 * Rejects with ArtifactError when the files on disk are missing or disagree
 * with their contracts.
 */
export async function engineForModel(ctx: WorkerContext, m: { id: string; dir: string; card: unknown }): Promise<LineEngine> {
  const card = (m.card ?? {}) as ModelCard;
  if (card.kind === 'vision') {
    const heads: { name?: { dir: string; artifact: VisionArtifact }; number?: { dir: string; artifact: VisionArtifact } } = {};
    for (const field of ['name', 'number'] as const) {
      const rel = card.heads?.[field];
      if (!rel) continue;
      const abs = modelDir(ctx, rel);
      heads[field] = { dir: abs, artifact: await loadVisionArtifact(abs, rel) };
    }
    if (!heads.name && !heads.number) throw new Error(`${m.id} declares no OCR heads`);
    return new VisionLineEngine(heads);
  }
  const dir = modelDir(ctx, m.dir);
  // the trainer writes the model card beside the graph; the row's copy is the
  // fallback when the file has been removed but the model is still registered
  const legacy = (await readFile(path.join(dir, 'card.json'), 'utf8').then((raw) => JSON.parse(raw) as Partial<ModelCard>).catch(() => null)) ?? card;
  return new OnnxLineEngine(dir, { ...legacy, id: legacy.id ?? m.id });
}

/** An engine by id: 'tesseract…' or 'model:<id>' (a registered model, either kind). */
export function engineFor(ctx: WorkerContext, spec: string): Promise<LineEngine> {
  if (!spec.startsWith('model:')) return Promise.resolve(tesseractEngine(ctx));
  let e = engines.get(spec);
  if (!e) {
    e = (async () => {
      const id = spec.slice('model:'.length);
      const [m] = await ctx.db.select().from(ocrModels).where(eq(ocrModels.id, id));
      if (!m) throw new Error(`unknown model ${id}`);
      return engineForModel(ctx, { id: m.id, dir: m.dir, card: m.card });
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
    // a classifier row can also be 'active': it runs beside the line reader and
    // must never be picked here, or its game labels would be read as text
    const rows = await ctx.db.select({ id: ocrModels.id, card: ocrModels.card }).from(ocrModels).where(eq(ocrModels.status, 'active'));
    const m = rows.find((r) => (r.card as { task?: string } | null)?.task !== 'card-classifier');
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
  classifiers.clear();
}

let shadow: { at: number; engine: LineEngine | null } = { at: 0, engine: null };

/** The model on live trial, if any (no Tesseract fallback: it is judged as it is). */
export async function shadowEngine(ctx: WorkerContext): Promise<LineEngine | null> {
  if (Date.now() - shadow.at < 30_000) return shadow.engine;
  let engine: LineEngine | null = null;
  try {
    const rows = await ctx.db.select({ id: ocrModels.id, card: ocrModels.card }).from(ocrModels).where(eq(ocrModels.status, 'shadow'));
    const m = rows.find((r) => (r.card as { task?: string } | null)?.task !== 'card-classifier');
    if (m) engine = await engineFor(ctx, `model:${m.id}`);
  } catch (e) {
    ctx.log.warn({ err: (e as Error).message }, 'OCR trial model unavailable');
  }
  shadow = { at: Date.now(), engine };
  return engine;
}

let classifierCache: { at: number; classifier: CardClassifier | null } = { at: 0, classifier: null };

/**
 * The game classifier that reads live scans, if one is promoted.
 *
 * It is independent of the line reader: the OCR model (a pair of Vision heads
 * or a legacy trainer model) decides how a line is read, while the classifier
 * decides *which game's layout* to crop. Re-read every 30 seconds like the
 * engines, so promoting one takes effect without a restart.
 */
export async function liveClassifier(ctx: WorkerContext): Promise<CardClassifier | null> {
  if (Date.now() - classifierCache.at < 30_000) return classifierCache.classifier;
  let classifier: CardClassifier | null = null;
  try {
    const rows = await ctx.db.select({ id: ocrModels.id, dir: ocrModels.dir, card: ocrModels.card }).from(ocrModels).where(eq(ocrModels.status, 'active'));
    for (const m of rows) {
      const card = (m.card ?? {}) as unknown as ModelCard;
      if (card.kind !== 'vision' || card.task !== 'card-classifier') continue;
      const abs = modelDir(ctx, m.dir);
      classifier = new VisionClassifier(abs, await loadVisionArtifact(abs, m.dir));
      break;
    }
  } catch (e) {
    ctx.log.warn({ err: (e as Error).message }, 'game classifier unavailable; guessing the game from text');
  }
  classifierCache = { at: Date.now(), classifier };
  return classifier;
}

// ------------------------------------------------------------------ cached artifacts

const artifactCache = new Map<string, Promise<VisionArtifact>>();

/**
 * A verified artifact by path, cached by path + mtime. Loading re-hashes
 * model.onnx, which is right for a promotion and wasteful for every read, so
 * callers that only need the JSON contracts use this.
 */
export async function cachedArtifact(absoluteDir: string): Promise<VisionArtifact> {
  const stamp = await import('node:fs/promises').then((fs) => fs.stat(path.join(absoluteDir, 'model.onnx')).then((s) => `${s.size}:${s.mtimeMs}`, () => 'missing'));
  const key = `${absoluteDir}:${stamp}`;
  let a = artifactCache.get(key);
  if (!a) {
    for (const k of artifactCache.keys()) if (k.startsWith(`${absoluteDir}:`)) artifactCache.delete(k);
    a = loadVisionArtifact(absoluteDir, absoluteDir);
    a.catch(() => artifactCache.delete(key));
    artifactCache.set(key, a);
  }
  return a;
}

export async function classifierFor(ctx: WorkerContext, m: { id: string; dir: string; card: unknown }): Promise<CardClassifier> {
  let c = classifiers.get(m.id);
  if (!c) {
    c = (async () => {
      const abs = modelDir(ctx, m.dir);
      return new VisionClassifier(abs, await loadVisionArtifact(abs, m.dir));
    })();
    c.catch(() => classifiers.delete(m.id));
    classifiers.set(m.id, c);
  }
  const loaded = await c;
  if (!loaded) throw new Error(`${m.id} is not a card classifier`);
  return loaded;
}
