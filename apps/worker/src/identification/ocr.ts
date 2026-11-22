import { createRequire } from 'node:module';
import path from 'node:path';
import { prepareForOcr, prepareOcrRegion } from '@cardvault/imaging';
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
 * Two passes. First the whole card and its title band, as before (any game).
 * Then, once the game is known (given, or guessed from the first pass), the
 * spots where that game prints the name and collector number are cropped,
 * enlarged and read on their own: one line for the name, and the number with
 * only the characters a number can contain. Without a known layout the footer
 * is read in two magnified halves.
 */
export async function ocrCard(image: Buffer, log: Logger, langPath?: string, gameHint?: string): Promise<OcrResult> {
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
  // the title spot of the known game, or of every game with a layout when the
  // first pass couldn't tell (cards with little rules text)
  const nameSpots = layout ? layout.name : Object.values(GAME_MODULES).flatMap((m) => m.ocrLayout?.name ?? []);
  for (const r of nameSpots) {
    const t = await read(w, await prepareOcrRegion(image, r, 110), PSM.line);
    if (t.text.trim()) names.push(t.text.trim());
  }
  if (layout) {
    for (const r of layout.number) {
      const img = await prepareOcrRegion(image, r, 110);
      // two readings of the same spot; the number is taken from whichever agree
      for (const psm of [PSM.block, PSM.line]) numbers.push((await read(w, img, psm, layout.numberChars)).text.trim());
    }
  } else {
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
  };
}

export async function shutdownOcr(): Promise<void> {
  if (workerPromise) await (await workerPromise).terminate();
  workerPromise = null;
}
