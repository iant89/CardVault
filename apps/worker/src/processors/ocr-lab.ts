import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { desc, eq, inArray, ocrEvaluations, ocrExams, ocrSamples, sql, and, ne } from '@cardvault/database';
import { GAME_MODULES } from '@cardvault/card-model';
import { cropRegion, resolveStoragePath, simulateCapture, writeFileSafe } from '@cardvault/imaging';
import { normalizeCollectorNumber, type GameSlug } from '@cardvault/shared';
import type { WorkerContext } from '../context.js';
import { ENGINE_ID, readLine } from '../identification/ocr.js';
import { cer, eraOf, fnv1a, metrics, namePrediction, nameNorm, numberPrediction, sliceReport, splitFor, type ScoredItem } from '../identification/ocr-data.js';
import { labelScanSamples } from '../identification/samples.js';
import { nameIndex } from '../identification/dictionary.js';

type Sample = typeof ocrSamples.$inferSelect;

// ------------------------------------------------------------------ labelling after review

export async function labelReviewed(ctx: WorkerContext, data: { scanId: string; cardId: string }) {
  return { labelled: await labelScanSamples(ctx, data.scanId, data.cardId, 'review') };
}

// ------------------------------------------------------------------ evaluation

/**
 * Score the current engine on the frozen exam and on the regression set.
 * Names are scored per line; numbers per scan (whatever its number spots
 * agree on), exactly as identification uses them.
 */
export async function evaluate(ctx: WorkerContext, data: { evaluationId: string }) {
  const started = Date.now();
  const [ev] = await ctx.db.select().from(ocrEvaluations).where(eq(ocrEvaluations.id, data.evaluationId));
  if (!ev) return null;
  const fail = async (error: string) => {
    await ctx.db.update(ocrEvaluations).set({ status: 'failed', error, completedAt: new Date() }).where(eq(ocrEvaluations.id, ev.id));
    return { error };
  };
  try {
    const [exam] = ev.examId
      ? await ctx.db.select().from(ocrExams).where(eq(ocrExams.id, ev.examId))
      : await ctx.db.select().from(ocrExams).orderBy(desc(ocrExams.version)).limit(1);
    if (!exam) return await fail('No exam has been frozen yet.');
    const examIds = new Set(exam.sampleIds);
    const examRows = exam.sampleIds.length ? await ctx.db.select().from(ocrSamples).where(inArray(ocrSamples.id, exam.sampleIds)) : [];
    const regressionRows = await ctx.db.select().from(ocrSamples).where(and(eq(ocrSamples.regression, true), eq(ocrSamples.labelSource, 'review')));
    const byId = new Map<string, Sample>();
    for (const r of [...examRows, ...regressionRows]) if (r.labelNorm) byId.set(r.id, r);

    // scoring units: one per name line, one per number group
    const units: { field: 'name' | 'number'; rows: Sample[] }[] = [];
    const numberGroups = new Map<string, Sample[]>();
    for (const r of byId.values()) {
      if (r.field === 'name') units.push({ field: 'name', rows: [r] });
      else (numberGroups.get(r.groupKey) ?? numberGroups.set(r.groupKey, []).get(r.groupKey)!).push(r);
    }
    for (const rows of numberGroups.values()) units.push({ field: 'number', rows: rows.sort((a, b) => a.region - b.region) });
    units.sort((a, b) => fnv1a(a.rows[0]!.groupKey) - fnv1a(b.rows[0]!.groupKey));

    await ctx.db.update(ocrEvaluations).set({ status: 'running', engine: ENGINE_ID, examId: exam.id, examVersion: exam.version, progress: { done: 0, total: units.length } }).where(eq(ocrEvaluations.id, ev.id));

    const items: ScoredItem[] = [];
    const misses: Record<string, unknown>[] = [];
    let missing = 0, lines = 0, readMs = 0;
    const dictionaries = new Map<string, Awaited<ReturnType<typeof nameIndex>>>();
    for (const [i, u] of units.entries()) {
      const first = u.rows[0]!;
      const game = first.game;
      const layout = GAME_MODULES[game as GameSlug]?.ocrLayout;
      const texts: string[] = [];
      let conf = 0;
      let ok = true;
      for (const r of u.rows) {
        const crop = await readFile(resolveStoragePath(ctx.storageDir, r.cropPath)).catch(() => null);
        if (!crop) {
          ok = false;
          break;
        }
        const t0 = Date.now();
        const reading = await readLine(crop, u.field, { numberChars: layout?.numberChars, log: ctx.log, langPath: ctx.config.OCR_LANG_PATH });
        readMs += Date.now() - t0;
        lines++;
        texts.push(reading.text);
        conf += reading.confidence / u.rows.length;
      }
      if (!ok) {
        missing++;
        continue;
      }
      const label = first.labelNorm!;
      let predicted: string;
      let correctWithDictionary: boolean | undefined;
      if (u.field === 'name') {
        predicted = namePrediction(texts[0] ?? '');
        if (!dictionaries.has(game)) dictionaries.set(game, await nameIndex(ctx, game as GameSlug));
        const fixed = dictionaries.get(game)?.correct([texts[0] ?? ''])[0]?.name;
        correctWithDictionary = (fixed ? nameNorm(fixed) : predicted) === label;
      } else {
        predicted = numberPrediction(texts.join('\n'), game)?.norm ?? '';
      }
      const inExam = u.rows.some((r) => examIds.has(r.id));
      const regression = u.rows.some((r) => r.regression);
      const item: ScoredItem = {
        field: u.field,
        game,
        source: first.labelSource,
        era: String((first.meta as { era?: string }).era ?? 'unknown'),
        correct: predicted === label,
        ...(correctWithDictionary !== undefined ? { correctWithDictionary } : {}),
        cer: cer(predicted, label),
        confidence: conf,
        regression,
        exam: inExam,
      };
      items.push(item);
      if (!item.correct && misses.length < 120) {
        misses.push({ field: u.field, game, source: first.labelSource, regression, predicted, raw: texts.join(' | ').slice(0, 120), label: first.labelText ?? label, samples: u.rows.map((r) => r.id) });
      }
      if (i % 10 === 9) await ctx.db.update(ocrEvaluations).set({ progress: { done: i + 1, total: units.length } }).where(eq(ocrEvaluations.id, ev.id));
    }

    const slices = sliceReport(items);
    const pick = (slice: string) => slices.find((s) => s.slice === slice) ?? null;
    // compare with the last finished run on the same exam version
    const [prev] = await ctx.db
      .select()
      .from(ocrEvaluations)
      .where(and(eq(ocrEvaluations.examVersion, exam.version), eq(ocrEvaluations.status, 'done'), ne(ocrEvaluations.id, ev.id)))
      .orderBy(desc(ocrEvaluations.completedAt))
      .limit(1);
    const summary = {
      engine: ENGINE_ID,
      examVersion: exam.version,
      units: items.length,
      exam: items.filter((x) => x.exam).length,
      missingCrops: missing,
      name: pick('all · name'),
      number: pick('all · number'),
      regression: { name: pick('regression set · name'), number: pick('regression set · number') },
      msPerLine: lines ? Math.round(readMs / lines) : null,
      durationMs: Date.now() - started,
      comparedTo: prev ? { id: prev.id, engine: prev.engine, completedAt: prev.completedAt, name: (prev.summary as { name?: unknown }).name ?? null, number: (prev.summary as { number?: unknown }).number ?? null } : null,
    };
    await ctx.db
      .update(ocrEvaluations)
      .set({ status: 'done', summary, slices: slices as unknown as Record<string, unknown>[], misses, progress: { done: units.length, total: units.length }, completedAt: new Date() })
      .where(eq(ocrEvaluations.id, ev.id));
    ctx.log.info({ evaluation: ev.id, name: summary.name?.accuracy, number: summary.number?.accuracy }, 'OCR evaluation finished');
    return { ok: true };
  } catch (e) {
    return fail((e as Error).message);
  }
}

// ------------------------------------------------------------------ harvested TCGdex cards

export const IMPORT_KEY = 'ocr:import-harvest';

interface HarvestCard {
  id: string;
  set: string;
  localId: string;
  name: string;
  data?: string;
  image?: string;
}

/**
 * Turn TCGdex Harvester downloads into labelled samples: each official image
 * is made to look like a capture (rescaled to a random camera size, softened,
 * JPEG-compressed, stored at 750px like the scanner does), then its title and
 * number spots are cut out. Labels come from TCGdex, so they are correct, but
 * the images aren't real photos: they form a separate 'harvest' slice.
 */
export async function importHarvest(ctx: WorkerContext, data: { limit?: number; lang?: string }) {
  const lang = data.lang ?? 'en';
  const root = path.resolve(ctx.config.HARVESTER_OUT_DIR ?? path.join(ctx.config.STORAGE_DIR, 'tcgdex-data'));
  const status = async (s: Record<string, unknown>) => ctx.redis.set(IMPORT_KEY, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }), 'EX', 7 * 24 * 3600);
  const cards = JSON.parse(await readFile(path.join(root, lang, 'cards.json'), 'utf8').catch(() => 'null')) as HarvestCard[] | null;
  if (!cards) {
    await status({ status: 'failed', error: `No ${lang}/cards.json in ${root}. Run the TCGdex Harvester (Developer menu) first.` });
    return { error: 'no harvest' };
  }
  const usable = cards.filter((c) => c.image && c.data);
  const layout = GAME_MODULES.pokemon.ocrLayout!;
  const existing = new Set(
    (await ctx.db.execute(sql`SELECT DISTINCT group_key FROM ocr_samples WHERE group_key LIKE ${`harvest:${lang}:%`}`)).map((r) => String(r.group_key)),
  );
  const todo = usable.filter((c) => !existing.has(`harvest:${lang}:${c.id}`)).slice(0, data.limit || undefined);
  const sets = new Map<string, { official?: number; release?: string } | null>();
  let added = 0, skipped = 0;
  await status({ status: 'running', done: 0, total: todo.length, added, skipped, alreadyImported: existing.size });
  for (const [i, c] of todo.entries()) {
    try {
      const setFile = path.join(root, path.dirname(path.dirname(c.data!)), 'set.json');
      if (!sets.has(setFile)) {
        const sj = JSON.parse(await readFile(setFile, 'utf8').catch(() => 'null')) as { cardCount?: { official?: number }; releaseDate?: string } | null;
        sets.set(setFile, sj ? { official: sj.cardCount?.official, release: sj.releaseDate } : null);
      }
      const set = sets.get(setFile);
      const original = await readFile(path.join(root, c.image!));
      // a camera-like copy, the same for every import of this card
      const { image: capture, cameraWidth: camW } = await simulateCapture(original, fnv1a(c.id));
      const group = `harvest:${lang}:${c.id}`;
      const split = splitFor(`harvest:${c.id}`);
      const era = eraOf(set?.release);
      const rows = [];
      const spots: ['name' | 'number', number, { left: number; top: number; width: number; height: number }][] = [
        ...layout.name.map((r, k) => ['name', k, r] as ['name', number, typeof r]),
        ...layout.number.map((r, k) => ['number', k, r] as ['number', number, typeof r]),
      ];
      for (const [field, region, r] of spots) {
        const crop = await cropRegion(capture, r);
        const id = crypto.randomUUID();
        const cropPath = await writeFileSafe(ctx.storageDir, `ocr/harvest/${id}.png`, crop);
        const number = normalizeCollectorNumber(c.localId);
        rows.push({
          id,
          groupKey: group,
          game: 'pokemon',
          field,
          region,
          cropPath,
          engine: 'none',
          labelText: field === 'name' ? c.name : set?.official ? `${c.localId}/${set.official}` : c.localId,
          labelNorm: field === 'name' ? nameNorm(c.name) : number,
          labelSource: 'harvest',
          split,
          meta: { era, set: c.set, source: 'harvest', camW },
          labeledAt: new Date(),
        });
      }
      await ctx.db.insert(ocrSamples).values(rows).onConflictDoNothing();
      added++;
    } catch (e) {
      skipped++;
      ctx.log.warn({ card: c.id, err: (e as Error).message }, 'harvest import: card skipped');
    }
    if (i % 25 === 24) await status({ status: 'running', done: i + 1, total: todo.length, added, skipped, alreadyImported: existing.size });
  }
  await status({ status: 'done', done: todo.length, total: todo.length, added, skipped, alreadyImported: existing.size });
  return { added, skipped };
}

export { ENGINE_ID, metrics };
