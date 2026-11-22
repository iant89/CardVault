import { createRequire } from 'node:module';
import path from 'node:path';
import { prepareForOcr } from '@cardvault/imaging';
import type { Logger } from 'pino';

type TWorker = { recognize: (b: Buffer) => Promise<{ data: { text: string; confidence: number } }>; terminate: () => Promise<unknown> };

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
  top: string;
  bottom: string;
  confidence: number;
}

/**
 * OCR the whole card, the title band (top 18%) and the footer (bottom 14%),
 * where collector numbers / set codes live. The footer is read as two
 * overlapping halves so each is magnified twice as much: the number on newer
 * Pokémon cards is only a few pixels tall at full-footer scale.
 */
export async function ocrCard(image: Buffer, log: Logger, langPath?: string): Promise<OcrResult> {
  const w = await getWorker(log, langPath);
  const [full, top, footL, footR] = await Promise.all([
    prepareForOcr(image),
    prepareForOcr(image, { top: 0, height: 0.18 }),
    prepareForOcr(image, { top: 0.86, height: 0.14, left: 0, width: 0.55 }),
    prepareForOcr(image, { top: 0.86, height: 0.14, left: 0.45, width: 0.55 }),
  ]);
  const rec = (b: Buffer) => withTimeout(w.recognize(b), 45_000, 'OCR');
  const a = await rec(full);
  const b = await rec(top);
  const c = await rec(footL);
  const d = await rec(footR);
  return { full: a.data.text, top: b.data.text, bottom: `${c.data.text}\n${d.data.text}`, confidence: a.data.confidence / 100 };
}

export async function shutdownOcr(): Promise<void> {
  if (workerPromise) await (await workerPromise).terminate();
  workerPromise = null;
}
