import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { desc, eq, inArray, ocrEvaluations, ocrExams, ocrModels, ocrSamples, sql, and, ne } from '@cardvault/database';
import { GAME_MODULES } from '@cardvault/card-model';
import { cropRegion, resolveStoragePath, simulateCapture, writeFileSafe } from '@cardvault/imaging';
import { normalizeCollectorNumber, type GameSlug } from '@cardvault/shared';
import type { WorkerContext } from '../context.js';
import { ENGINE_ID } from '../identification/ocr.js';
import { engineFor } from '../identification/engines.js';
import { cer, eraOf, fnv1a, metrics, namePrediction, nameNorm, numberPrediction, sliceReport, splitFor, type ScoredItem } from '../identification/ocr-data.js';
import { labelScanSamples } from '../identification/samples.js';
import { nameIndex } from '../identification/dictionary.js';
import { etaFromPace, percent } from '@cardvault/shared';
import { ensureTask, saveTask, taskProgress } from '@cardvault/jobs';
import { writeVisionDataset, type VisionGroup } from '../identification/vision-dataset.js';
import { evaluateClassifier, isClassifierRow, scanVisionModels } from './ocr-lab-vision.js';

type Sample = typeof ocrSamples.$inferSelect;

// ------------------------------------------------------------------ labelling after review

export async function labelReviewed(ctx: WorkerContext, data: { scanId: string; cardId: string }) {
  return { labelled: await labelScanSamples(ctx, data.scanId, data.cardId, 'review') };
}

// ------------------------------------------------------------------ evaluation

/**
 * Score an engine (Tesseract, or a registered model) on the frozen exam and
 * on the regression set.
 * Names are scored per line; numbers per scan (whatever its number spots
 * agree on), exactly as identification uses them.
 */
export async function evaluate(ctx: WorkerContext, data: { evaluationId: string }) {
  const started = Date.now();
  const [ev] = await ctx.db.select().from(ocrEvaluations).where(eq(ocrEvaluations.id, data.evaluationId));
  if (!ev) return null;
  // the queue's entry for this run (the API created it with the evaluation)
  const taskKey = `ocr-evaluate:${ev.id}`;
  const engineLabel = ev.engine.startsWith('model:') ? ev.engine.slice('model:'.length) : 'Tesseract';
  const task = await ensureTask(ctx.redis, {
    key: taskKey,
    kind: 'evaluation',
    name: `Score ${engineLabel} on the exam`,
    detail: 'Reading the frozen exam lines…',
    state: 'running',
  });
  const fail = async (error: string) => {
    await ctx.db.update(ocrEvaluations).set({ status: 'failed', error, completedAt: new Date() }).where(eq(ocrEvaluations.id, ev.id));
    await saveTask(ctx.redis, { key: task.key, kind: 'evaluation', name: task.name, state: 'failed', error, progress: 0 });
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

    // a cancelled evaluation must not start (its row says 'failed' already)
    const [stillWanted] = await ctx.db.select({ status: ocrEvaluations.status }).from(ocrEvaluations).where(eq(ocrEvaluations.id, ev.id));
    if (stillWanted && stillWanted.status === 'failed') {
      await saveTask(ctx.redis, { key: taskKey, kind: 'evaluation', name: task.name, state: 'cancelled', error: 'Cancelled before it started.', progress: 0 });
      return { error: 'cancelled' };
    }
    // a game classifier is scored on cards, not lines: its units are the exam's
    // images and its answer is a game, so it has its own path through this
    if (ev.engine.startsWith('model:')) {
      const [row] = await ctx.db.select().from(ocrModels).where(eq(ocrModels.id, ev.engine.slice('model:'.length)));
      if (row && isClassifierRow(row.card)) {
        const engineId = `classifier:${row.id}`;
        await ctx.db.update(ocrEvaluations).set({ status: 'running', engine: engineId, examId: exam.id, examVersion: exam.version, progress: { done: 0, total: 1 } }).where(eq(ocrEvaluations.id, ev.id));
        await taskProgress(ctx.redis, task.key, { progress: 10, detail: 'Classifying the exam’s cards…' });
        const r = await evaluateClassifier(ctx, { id: row.id, dir: row.dir, card: row.card }, exam.sampleIds);
        const sliceOf = (slice: string) => r.slices.find((x) => x.slice === slice) ?? null;
        const summary = {
          engine: engineId,
          kind: 'card-classifier',
          examVersion: exam.version,
          units: r.units,
          exam: r.units,
          correct: r.correct,
          abstained: r.abstained,
          missingImages: r.missingImages,
          game: sliceOf('all · game'),
          name: null,
          number: null,
          regression: { name: null, number: null },
          msPerLine: r.msPerCard,
          durationMs: Date.now() - started,
          comparedTo: null,
        };
        await ctx.db
          .update(ocrEvaluations)
          .set({ status: 'done', summary, slices: r.slices as unknown as Record<string, unknown>[], misses: r.misses, progress: { done: 1, total: 1 }, completedAt: new Date() })
          .where(eq(ocrEvaluations.id, ev.id));
        const pctGame = r.units ? `${((r.correct / r.units) * 100).toFixed(1)}%` : '—';
        await saveTask(ctx.redis, {
          key: task.key,
          kind: 'evaluation',
          name: task.name,
          state: 'done',
          progress: 100,
          progressLabel: `${r.units.toLocaleString()} cards`,
          detail: `Games ${pctGame} right · ${r.abstained} abstained · ${r.msPerCard ?? '?'} ms/card`,
          error: null,
        });
        ctx.log.info({ evaluation: ev.id, game: r.units ? r.correct / r.units : null }, 'card classifier evaluation finished');
        return { ok: true };
      }
    }
    const engine = await engineFor(ctx, ev.engine.startsWith('model:') ? ev.engine : 'tesseract');
    await ctx.db.update(ocrEvaluations).set({ status: 'running', engine: engine.id, examId: exam.id, examVersion: exam.version, progress: { done: 0, total: units.length } }).where(eq(ocrEvaluations.id, ev.id));

    const items: ScoredItem[] = [];
    const misses: Record<string, unknown>[] = [];
    let missing = 0, lines = 0, readMs = 0;
    const dictionaries = new Map<string, Awaited<ReturnType<typeof nameIndex>>>();
    for (const [i, u] of units.entries()) {
      // stopping: the row was marked failed ('Cancelled.') by the API
      if (i % 20 === 0) {
        const [now] = await ctx.db.select({ status: ocrEvaluations.status }).from(ocrEvaluations).where(eq(ocrEvaluations.id, ev.id));
        if (now?.status === 'failed') {
          await saveTask(ctx.redis, { key: task.key, kind: 'evaluation', name: task.name, state: 'cancelled', error: 'Stopped on request.', progress: percent(i, units.length) });
          return { error: 'cancelled' };
        }
      }
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
        const reading = await engine.read(crop, u.field, { numberChars: layout?.numberChars });
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
      if (i % 5 === 4 || i + 1 === units.length) {
        await taskProgress(ctx.redis, task.key, {
          progress: percent(i + 1, units.length),
          progressLabel: `${(i + 1).toLocaleString()} / ${units.length.toLocaleString()} groups`,
          detail: `${engineLabel} · ${items.length ? Math.round((items.filter((x) => x.correct).length / items.length) * 100) : 0}% right so far`,
          etaSeconds: etaFromPace(i + 1, units.length, Date.now() - started),
        });
      }
    }

    const slices = sliceReport(items);
    const pick = (slice: string) => slices.find((s) => s.slice === slice) ?? null;
    // compare with the last finished run on the same exam version
    const [prev] = await ctx.db
      .select()
      .from(ocrEvaluations)
      .where(and(eq(ocrEvaluations.examVersion, exam.version), eq(ocrEvaluations.status, 'done'), eq(ocrEvaluations.engine, engine.id), ne(ocrEvaluations.id, ev.id)))
      .orderBy(desc(ocrEvaluations.completedAt))
      .limit(1);
    const summary = {
      engine: engine.id,
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
    const pctText = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
    await saveTask(ctx.redis, {
      key: task.key,
      kind: 'evaluation',
      name: task.name,
      state: 'done',
      progress: 100,
      progressLabel: `${units.length.toLocaleString()} / ${units.length.toLocaleString()} groups`,
      detail: `Names ${pctText(summary.name?.accuracy)} · numbers ${pctText(summary.number?.accuracy)} · ${summary.units?.toLocaleString() ?? units.length} items scored`,
      error: null,
    });
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
  const task = await ensureTask(ctx.redis, {
    key: 'ocr-import',
    kind: 'import',
    name: 'Import harvested cards',
    detail: 'Reading the TCGdex harvest…',
    state: 'running',
  });
  const started = Date.now();
  const status = async (s: Record<string, unknown>) => ctx.redis.set(IMPORT_KEY, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }), 'EX', 7 * 24 * 3600);
  const report = (done: number, total: number, added: number, extra = '') =>
    void taskProgress(ctx.redis, task.key, {
      progress: percent(done, total),
      progressLabel: `${done.toLocaleString()} / ${total.toLocaleString()} cards`,
      detail: `${added.toLocaleString()} cards added${extra}`,
      etaSeconds: etaFromPace(done, total, Date.now() - started),
    });
  const cards = JSON.parse(await readFile(path.join(root, lang, 'cards.json'), 'utf8').catch(() => 'null')) as HarvestCard[] | null;
  if (!cards) {
    const error = `No ${lang}/cards.json in ${root}. Run the TCGdex Harvester (Developer menu) first.`;
    await status({ status: 'failed', error });
    await saveTask(ctx.redis, { key: task.key, kind: 'import', name: task.name, state: 'failed', error, progress: 0 });
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
  report(0, todo.length, 0, ` · ${todo.length.toLocaleString()} new of ${usable.length.toLocaleString()} harvested`);
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
          labelText: field === 'name' ? c.name : set?.official ? printedNumber(`${c.localId}/${set.official}`) : c.localId,
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
    if (i % 25 === 24) {
      await status({ status: 'running', done: i + 1, total: todo.length, added, skipped, alreadyImported: existing.size });
      report(i + 1, todo.length, added, skipped ? ` · ${skipped} skipped` : '');
    }
  }
  await status({ status: 'done', done: todo.length, total: todo.length, added, skipped, alreadyImported: existing.size });
  await saveTask(ctx.redis, {
    key: task.key,
    kind: 'import',
    name: task.name,
    state: 'done',
    progress: 100,
    progressLabel: `${todo.length.toLocaleString()} / ${todo.length.toLocaleString()} cards`,
    detail: `${added.toLocaleString()} cards added${skipped ? ` · ${skipped} skipped` : ''}`,
    error: null,
  });
  return { added, skipped };
}

// ------------------------------------------------------------------ training data export

export const DATASET_KEY = 'ocr:dataset';

/** "043/72" → "043/072": modern cards pad the set total to the number's width. */
export function printedNumber(text: string): string {
  const m = /^(\d+)\/(\d+)$/.exec(text);
  if (!m || !m[1]!.startsWith('0')) return text;
  return `${m[1]}/${m[2]!.padStart(m[1]!.length, '0')}`;
}

/**
 * Write a versioned snapshot of trustworthy TRAINING lines for
 * tools/ocr-trainer: storage/ocr/datasets/<id>/{train.jsonl, info.json}.
 * Never included: exam-side lines (split = 'exam') and labels that only the
 * engine itself vouched for ('self'). Lines a person corrected count triple.
 * Crops are referenced, not copied (paths relative to the storage folder).
 */
export async function exportDataset(ctx: WorkerContext) {
  const id = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const task = await ensureTask(ctx.redis, { key: 'ocr-export', kind: 'export', name: 'Export training data', detail: 'Selecting training lines…', state: 'running' });
  await taskProgress(ctx.redis, task.key, { progress: 5, detail: 'Selecting training lines…' });
  const rows = await ctx.db.execute(sql`
    SELECT id, group_key, game, field, region, crop_path, label_text, label_norm, label_source, regression, meta
    FROM ocr_samples
    WHERE split = 'train' AND label_source IN ('review', 'corroborated', 'harvest') AND label_norm IS NOT NULL`);
  type Row = { id: string; group_key: string; game: string; field: string; region: number; crop_path: string; label_text: string | null; label_norm: string; label_source: string; regression: boolean; meta: Record<string, unknown> };
  const all = rows as unknown as Row[];

  // which number spot carries the number, per harvested set (scans know it from their own reading)
  const tess = await engineFor(ctx, 'tesseract');
  const bySet = new Map<string, Row[]>();
  for (const r of all) if (r.label_source === 'harvest' && r.field === 'number') (bySet.get(String(r.meta.set)) ?? bySet.set(String(r.meta.set), []).get(String(r.meta.set))!).push(r);
  const numberRegion: Record<string, number | null> = {};
  for (const [set, list] of bySet) {
    const groups = [...new Set(list.map((r) => r.group_key))].sort((a, b) => fnv1a(a) - fnv1a(b)).slice(0, 6);
    const votes = new Map<number, number>();
    for (const g of groups) {
      for (const r of list.filter((x) => x.group_key === g)) {
        const crop = await readFile(resolveStoragePath(ctx.storageDir, r.crop_path)).catch(() => null);
        if (!crop) continue;
        const reading = await tess.read(crop, 'number', { numberChars: GAME_MODULES[r.game as GameSlug]?.ocrLayout?.numberChars });
        if (numberPrediction(reading.text, r.game)?.norm === r.label_norm) votes.set(r.region, (votes.get(r.region) ?? 0) + 1);
      }
    }
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    numberRegion[set] = ranked[0] && ranked[0][1] >= 2 && ranked[0][1] > (ranked[1]?.[1] ?? 0) ? ranked[0][0] : null;
  }

  const lines: string[] = [];
  const counts: Record<string, number> = {};
  for (const r of all) {
    let text: string | null = null;
    if (r.field === 'name') text = r.label_text;
    else if (r.label_source === 'harvest') text = numberRegion[String(r.meta.set)] === r.region ? printedNumber(r.label_text ?? '') : null;
    else text = r.label_text; // set only where that spot's own reading matched the card
    if (!text) continue;
    const weight = r.regression ? 3 : r.label_source === 'review' ? 2 : 1;
    lines.push(JSON.stringify({ id: r.id, crop: r.crop_path, text, field: r.field, game: r.game, source: r.label_source, group: r.group_key, weight }));
    const k = `${r.label_source} · ${r.field}`;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const body = lines.join('\n') + '\n';
  const { createHash } = await import('node:crypto');
  const jsonlSha256 = createHash('sha256').update(body).digest('hex');
  await writeFileSafe(ctx.storageDir, `ocr/datasets/${id}/train.jsonl`, Buffer.from(body));

  // ---- the same snapshot in CardVault-Vision's manifest format: whole cards
  // with every field's box, which is what `vision train` reads. Written from the
  // rows that are trustworthy training data, never the exam side.
  await taskProgress(ctx.redis, task.key, { progress: 60, detail: 'Writing the CardVault-Vision dataset…' });
  const groups = new Map<string, VisionGroup>();
  const imageOf = await groupImages(ctx, all.map((r) => r.group_key));
  for (const r of all) {
    const meta = (r.meta ?? {}) as Record<string, unknown>;
    const g = groups.get(r.group_key) ?? {
      groupKey: r.group_key,
      game: r.game,
      cardId: null,
      imagePath: imageOf.get(r.group_key) ?? '',
      harvest: r.label_source === 'harvest',
      nameRegion: null,
      numberRegion: null,
      nameText: null,
      numberText: null,
      meta: { era: meta.era, set: meta.set, source: r.label_source },
    };
    if (!g.imagePath) continue;
    if (r.field === 'name' && r.label_text && g.nameText == null) {
      g.nameText = r.label_text;
      g.nameRegion = r.region;
    }
    if (r.field === 'number' && g.numberRegion == null) {
      const text = r.label_source === 'harvest' ? (numberRegion[String(meta.set)] === r.region ? printedNumber(r.label_text ?? '') : null) : r.label_text;
      if (text) {
        g.numberText = text;
        g.numberRegion = r.region;
      }
    }
    groups.set(r.group_key, g);
  }
  const createdAt = new Date().toISOString();
  const vision = await writeVisionDataset(ctx, id, [...groups.values()], { jsonlSha256, counts, createdAt, split: 'train' }).catch((e: Error) => {
    ctx.log.warn({ dataset: id, err: e.message }, 'could not write the CardVault-Vision dataset');
    return null;
  });

  const info = {
    id,
    createdAt,
    rows: lines.length,
    counts,
    sha256: jsonlSha256,
    numberRegions: numberRegion,
    storage: ctx.storageDir,
    rules: 'split=train only; sources review/corroborated/harvest; review x2, regression x3',
    /** the CardVault-Vision manifest beside train.jsonl (`vision train --dataset <dir>`) */
    vision: vision ? { dir: vision.dir, samples: vision.samples, cards: vision.cards, fields: vision.fields, skipped: vision.skipped, contentHash: vision.contentHash } : null,
  };
  await writeFileSafe(ctx.storageDir, `ocr/datasets/${id}/info.json`, Buffer.from(JSON.stringify(info, null, 2)));
  await ctx.redis.set(DATASET_KEY, JSON.stringify({ ...info, dir: path.join(ctx.storageDir, 'ocr', 'datasets', id) }));
  await saveTask(ctx.redis, {
    key: task.key,
    kind: 'export',
    name: task.name,
    state: 'done',
    progress: 100,
    progressLabel: `${lines.length.toLocaleString()} lines`,
    detail: `${lines.length.toLocaleString()} lines in ${id} (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')})${vision ? ` · ${vision.samples.toLocaleString()} whole cards for CardVault-Vision` : ''}`,
    result: id,
    error: null,
  });
  ctx.log.info({ dataset: id, rows: lines.length, vision: vision?.samples ?? 0 }, 'OCR training data exported');
  return info;
}

/**
 * The full image each training group was read from: a scan's photo, or a
 * harvested card's official image (made camera-like when the manifest is
 * written). Groups with no image are left out — a sample cannot be annotated
 * without the pixels its boxes refer to.
 */
async function groupImages(ctx: WorkerContext, groupKeys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!groupKeys.length) return out;
  const rows = (await ctx.db.execute(sql`
    SELECT group_key, max(image_path) AS image_path FROM (
      SELECT s.group_key, sc.image_path
      FROM ocr_samples s JOIN scans sc ON sc.id = s.scan_id
      WHERE s.group_key IN (SELECT jsonb_array_elements_text(${JSON.stringify(groupKeys)}::jsonb))
      UNION ALL
      SELECT s.group_key, NULL::text AS image_path
      FROM ocr_samples s WHERE s.group_key IN (SELECT jsonb_array_elements_text(${JSON.stringify(groupKeys)}::jsonb)) AND s.label_source = 'harvest'
    ) x GROUP BY group_key`)) as unknown as { group_key: string; image_path: string | null }[];
  for (const r of rows) if (r.image_path) out.set(r.group_key, r.image_path);
  // harvested groups: the original card image lives beside the crop in the
  // harvest folder, keyed by the card id in the group key (`harvest:<lang>:<id>`)
  for (const key of groupKeys) {
    if (out.has(key) || !key.startsWith('harvest:')) continue;
    const path = await harvestImagePath(ctx, key);
    if (path) out.set(key, path);
  }
  return out;
}

/** The download a `harvest:<lang>:<cardId>` group came from, if it is still there. */
async function harvestImagePath(ctx: WorkerContext, groupKey: string): Promise<string | null> {
  const parts = groupKey.split(':');
  const lang = parts[1];
  const cardId = parts.slice(2).join(':');
  if (!lang || !cardId) return null;
  const root = path.resolve(ctx.config.HARVESTER_OUT_DIR ?? path.join(ctx.storageDir, 'tcgdex-data'));
  const cards = JSON.parse(await readFile(path.join(root, lang, 'cards.json'), 'utf8').catch(() => 'null')) as { id: string; image?: string }[] | null;
  const card = cards?.find((c) => c.id === cardId);
  if (!card?.image) return null;
  const abs = path.join(root, card.image);
  const { stat } = await import('node:fs/promises');
  if (!(await stat(abs).catch(() => null))?.isFile()) return null;
  // the manifest's paths are relative to the storage folder, like every other
  // sample's, so the artifact stays inside storage
  return path.relative(ctx.storageDir, abs);
}

// ------------------------------------------------------------------ model registry

/**
 * Register every model on disk that OCR Lab can score:
 *  - what tools/ocr-trainer wrote to `ocr/models/<id>/` (model.onnx + card.json)
 *  - CardVault-Vision exports under the Vision roots (`ocr/vision/exports`,
 *    VISION_MODELS_DIR): one row per OCR pair, one per card classifier
 */
export async function scanModels(ctx: WorkerContext) {
  const { readdir } = await import('node:fs/promises');
  const root = path.join(ctx.storageDir, 'ocr', 'models');
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  let added = 0;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const card = JSON.parse(await readFile(path.join(root, d.name, 'card.json'), 'utf8').catch(() => 'null')) as { id?: string } | null;
    const onnx = await readFile(path.join(root, d.name, 'model.onnx')).then(() => true, () => false);
    if (!card?.id || !onnx) continue;
    const values = { id: card.id, dir: `ocr/models/${d.name}`, card: { kind: 'trainer', ...card } as Record<string, unknown> };
    const r = await ctx.db.insert(ocrModels).values(values).onConflictDoNothing().returning({ id: ocrModels.id });
    added += r.length;
  }
  // CardVault-Vision artifacts: verified (checksum, contract) before they are
  // registered, so a broken export shows its reason instead of loading later
  const vision = await scanVisionModels(ctx).catch((e: Error) => {
    ctx.log.warn({ err: e.message }, 'could not scan CardVault-Vision exports');
    return { models: [] as string[], errors: [{ dir: '', error: e.message }], registered: [], found: [] };
  });
  if (added || vision.models.length) ctx.log.info({ added: added + vision.models.length, vision: vision.models }, 'OCR models registered');
  return { added: added + vision.models.length, legacy: added, vision: vision.models, errors: vision.errors };
}

export { ENGINE_ID, metrics };
