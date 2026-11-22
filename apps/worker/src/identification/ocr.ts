import { createRequire } from 'node:module';
import path from 'node:path';
import { cropRegion, prepareForOcr, prepareLine } from '@cardvault/imaging';
import { GAME_MODULES, guessGameFromText } from '@cardvault/card-model';
import type { Logger } from 'pino';

type TWorker = {
  recognize: (b: Buffer) => Promise<{ data: { text: string; confidence: number } }>;
  setParameters: (p: Record<string, string>) => Promise<unknown>;
  terminate: () => Promise<unknown>;
};

let workerPromise: Promise<TWorker> | null = null;

/** Bundled English model (offline; no CDN download on a home server). */
function bundledLangPath(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    return path.join(path.dirname(req.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
  } catch {
    return undefined;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

async function getWorker(log: Logger, langPath?: string): Promise<TWorker> {
  workerPromise ??= (async () => {
    const { createWorker } = await import('tesseract.js');
    const lp = langPath ?? bundledLangPath();
    log.info({ langPath: lp ?? 'cdn' }, 'starting OCR engine');
    return (await createWorker('eng', 1, lp ? { langPath: lp, gzip: true, cacheMethod: 'none' } : {})) as unknown as TWorker;
  })();
  try {
    return await withTimeout(workerPromise, 60_000, 'OCR engine start');
  } catch (e) {
    workerPromise = null;
    throw e;
  }
}

export interface OcrResult {
  full: string;
  /** title band; a targeted title-line read, when available, comes first */
  top: string;
  /** collector-number readings (targeted spots, or the whole footer) */
  bottom: string;
  confidence: number;
  /** the game whose layout was used for the targeted reads */
  layoutGame?: string;
  /** each targeted line with its crop: the raw material for the exam and training */
  lines?: OcrLine[];
}

export type LineField = 'name' | 'number';

export interface OcrLine {
  field: LineField;
  /** index of the spot in the game's layout */
  region: number;
  crop: Buffer;
  text: string;
  readings: string[];
  confidence: number;
  /** the engine that produced this reading */
  engine: string;
}

/** Reads one line: a trained model, or Tesseract (see engines.ts). */
export interface LineReader {
  id: string;
  read(crop: Buffer, field: LineField, opts: { numberChars?: string }): Promise<LineReading>;
}

/** Identifies what read a line: stored with every sample and every score. */
export const ENGINE_ID = 'tesseract-5/lines-v1';

export interface LineReading {
  text: string;
  readings: string[];
  /** 0–1 */
  confidence: number;
}

/** Page-segmentation modes: 3 = automatic layout, 6 = one block, 7 = one line. */
const PSM = { auto: '3', block: '6', line: '7' } as const;

// Tesseract parameters live on the shared worker, so each read sets the full
// set it needs, and reads are serialized so they can't interleave.
let queue: Promise<unknown> = Promise.resolve();
function read(w: TWorker, img: Buffer, psm: string, chars = ''): Promise<{ text: string; confidence: number }> {
  const job = queue.then(async () => {
    await w.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: chars, user_defined_dpi: '300' });
    const r = await withTimeout(w.recognize(img), 45_000, 'OCR');
    return { text: r.data.text, confidence: r.data.confidence };
  });
  queue = job.catch(() => undefined);
  return job;
}

/**
 * Read one cropped line, the way live scans do: the title as a single line;
 * a number spot twice (block and line modes) with only number characters
 * allowed. Used by scans and by the exam, so the exam measures exactly what
 * scans experience.
 */
export async function readLine(crop: Buffer, field: LineField, opts: { numberChars?: string; log: Logger; langPath?: string }): Promise<LineReading> {
  const w = await getWorker(opts.log, opts.langPath);
  const img = await prepareLine(crop, 110);
  if (field === 'name') {
    const t = await read(w, img, PSM.line);
    return { text: t.text.trim(), readings: [t.text.trim()], confidence: t.confidence / 100 };
  }
  const readings: string[] = [];
  let conf = 0;
  for (const psm of [PSM.block, PSM.line]) {
    const t = await read(w, img, psm, opts.numberChars ?? '');
    readings.push(t.text.trim());
    conf += t.confidence / 100 / 2;
  }
  return { text: readings.filter(Boolean).join('\n'), readings, confidence: conf };
}

/**
 * Two passes. First the whole card and its title band, as before (any game).
 * Then, once the game is known (given, or guessed from the first pass), the
 * spots where that game prints the name and collector number are cropped,
 * enlarged and read on their own. Without a known layout every game's title
 * spot is tried and the footer is read in two magnified halves.
 */
export async function ocrCard(image: Buffer, log: Logger, langPath?: string, gameHint?: string, reader?: LineReader): Promise<OcrResult> {
  const w = await getWorker(log, langPath);
  const [fullImg, topImg] = await Promise.all([prepareForOcr(image), prepareForOcr(image, { top: 0, height: 0.18 })]);
  const a = await read(w, fullImg, PSM.auto);
  const b = await read(w, topImg, PSM.auto);

  let game = gameHint && gameHint in GAME_MODULES ? gameHint : undefined;
  if (!game) {
    const g = guessGameFromText(`${b.text}\n${a.text}`)[0];
    if (g && g.score >= 0.34) game = g.game;
  }
  const layout = game ? GAME_MODULES[game as keyof typeof GAME_MODULES].ocrLayout : undefined;

  const names: string[] = [];
  const numbers: string[] = [];
  const lines: OcrLine[] = [];
  if (layout) {
    for (const [i, r] of layout.name.entries()) {
      const crop = await cropRegion(image, r);
      const t = reader ? await reader.read(crop, 'name', {}) : await readLine(crop, 'name', { log, langPath });
      if (t.text) names.push(t.text);
      lines.push({ field: 'name', region: i, crop, engine: reader?.id ?? ENGINE_ID, ...t });
    }
    for (const [i, r] of layout.number.entries()) {
      const crop = await cropRegion(image, r);
      const t = reader ? await reader.read(crop, 'number', { numberChars: layout.numberChars }) : await readLine(crop, 'number', { numberChars: layout.numberChars, log, langPath });
      numbers.push(...t.readings);
      lines.push({ field: 'number', region: i, crop, engine: reader?.id ?? ENGINE_ID, ...t });
    }
  } else {
    // the game couldn't be told: try every game's title spot (no samples kept)
    for (const r of Object.values(GAME_MODULES).flatMap((m) => m.ocrLayout?.name ?? [])) {
      const t = await readLine(await cropRegion(image, r), 'name', { log, langPath });
      if (t.text) names.push(t.text);
    }
    const [footL, footR] = await Promise.all([
      prepareForOcr(image, { top: 0.86, height: 0.14, left: 0, width: 0.55 }),
      prepareForOcr(image, { top: 0.86, height: 0.14, left: 0.45, width: 0.55 }),
    ]);
    numbers.push((await read(w, footL, PSM.auto)).text, (await read(w, footR, PSM.auto)).text);
  }
  return {
    full: a.text,
    top: [...names, b.text].join('\n'),
    bottom: numbers.filter(Boolean).join('\n'),
    confidence: a.confidence / 100,
    layoutGame: layout ? game : undefined,
    lines,
  };
}

export async function shutdownOcr(): Promise<void> {
  if (workerPromise) await (await workerPromise).terminate();
  workerPromise = null;
}
