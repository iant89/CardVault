import type { Job } from 'bullmq';
import { readFile } from 'node:fs/promises';
import { and, eq, sql, scans, identifications, manualReviews, researchJobs, collectionItems, cardVariants } from '@cardvault/database';
import { resolveStoragePath } from '@cardvault/imaging';
import { CONFIDENCE, decideConfidence, type GameSlug, type IdentificationJobData, type VariantType } from '@cardvault/shared';
import type { WorkerContext } from '../context.js';
import { JobTracker } from '../jobs/state.js';
import { ocrCard } from '../identification/ocr.js';
import { extractSignals } from '../identification/extract.js';
import { localCandidates, remoteCandidates, scoreCandidates } from '../identification/identify.js';
import { run } from './common.js';

const VARIANT_PREFERENCE: VariantType[] = ['NORMAL', 'NON_FOIL', 'UNLIMITED', 'HOLO'];

async function chooseVariant(ctx: WorkerContext, cardId: string, hints: VariantType[]): Promise<string> {
  const rows = await ctx.db.select().from(cardVariants).where(eq(cardVariants.cardId, cardId));
  const pick =
    rows.find((r) => hints.includes(r.type as VariantType)) ??
    VARIANT_PREFERENCE.map((p) => rows.find((r) => r.type === p)).find(Boolean) ??
    rows[0];
  if (pick) return pick.id;
  const [v] = await ctx.db.insert(cardVariants).values({ cardId, type: hints[0] ?? 'NORMAL' }).returning();
  return v!.id;
}

export async function processIdentification(ctx: WorkerContext, job: Job<IdentificationJobData>) {
  const { scanId, userId } = job.data;
  const tracker = new JobTracker(ctx, job.id!, userId, scanId, null);
  return run(ctx, job, tracker, async () => {
    await tracker.start('Preparing image', job.attemptsMade + 1);
    const [scan] = await ctx.db.select().from(scans).where(eq(scans.id, scanId));
    if (!scan) throw new Error('Scan not found');
    await ctx.db.update(scans).set({ status: 'IDENTIFYING', updatedAt: new Date() }).where(eq(scans.id, scanId));
    const image = await readFile(resolveStoragePath(ctx.storageDir, scan.imagePath));

    // 1. OCR
    await tracker.update('PROCESSING', 'Reading card text (OCR)', 20);
    let ocr = { full: '', top: '', bottom: '', confidence: 0 };
    if (ctx.config.OCR_ENABLED) {
      try {
        ocr = await ocrCard(image, ctx.log, ctx.config.OCR_LANG_PATH);
      } catch (e) {
        ctx.log.warn({ err: (e as Error).message }, 'OCR failed; continuing with other signals');
      }
    }
    if (job.data.clientOcr) ocr.full = `${ocr.full}\n${job.data.clientOcr}`;

    // 2. Signals + local catalog
    await tracker.update('MATCHING', 'Matching against local catalog', 45);
    const hint = job.data.gameHint ?? scan.gameHint ?? undefined;
    const sig = extractSignals(ocr, hint);
    const topGame = sig.gameGuesses[0] && sig.gameGuesses[0].score >= 0.34 ? sig.gameGuesses[0].game : null;
    const cands = await localCandidates(ctx, sig, scan.imageHash, (hint as GameSlug) ?? topGame);
    let scored = scoreCandidates(cands.values(), sig, `${ocr.top}\n${ocr.full}`, scan.imageHash);

    // 3. Only if the local catalog can't decide, ask catalog providers
    if ((!scored[0] || scored[0].confidence < CONFIDENCE.AUTO_ACCEPT) && sig.nameCandidates.length) {
      await tracker.update('MATCHING', 'Searching card databases', 60);
      const games: GameSlug[] = hint
        ? [hint as GameSlug]
        : topGame
          ? [topGame]
          : (sig.gameGuesses.filter((g) => g.score > 0).map((g) => g.game).slice(0, 2) as GameSlug[]);
      await remoteCandidates(ctx, sig, games.length ? games : ['pokemon', 'magic', 'yugioh'], cands);
      scored = scoreCandidates(cands.values(), sig, `${ocr.top}\n${ocr.full}`, scan.imageHash);
    }

    const top = scored.slice(0, 5);
    const raw = { ocr: { top: ocr.top.slice(0, 500), bottom: ocr.bottom.slice(0, 300), full: ocr.full.slice(0, 2000), confidence: ocr.confidence }, signals: sig };
    if (top.length) {
      await ctx.db.insert(identifications).values(
        top.map((c, i) => ({ scanId, cardId: c.cardId, confidence: c.confidence, method: 'COMBINED' as const, rank: i, rawResult: { ...(i === 0 ? raw : {}), signals: c.signals } })),
      );
    } else {
      await ctx.db.insert(identifications).values({ scanId, cardId: null, confidence: 0, method: 'OCR', rank: 0, rawResult: raw });
    }

    const best = top[0];
    const confidence = best?.confidence ?? 0;
    const decision = decideConfidence(confidence);

    if (best && decision === 'AUTO_ACCEPT') {
      tracker.cardId = best.cardId;
      const variantId = await chooseVariant(ctx, best.cardId, sig.variantHints);
      const owned = await ctx.db.execute(sql`SELECT COALESCE(sum(quantity),0)::int AS n FROM collection_items WHERE user_id = ${userId} AND card_id = ${best.cardId} AND variant_id = ${variantId}`);
      const [item] = await ctx.db
        .insert(collectionItems)
        .values({ userId, cardId: best.cardId, variantId, scanId, source: 'scan', condition: 'NM', quantity: 1, grading: { status: 'RAW' }, ...(sig.serial ? { notes: `Serial ${sig.serial}` } : {}) })
        .returning({ id: collectionItems.id });
      await ctx.db.update(scans).set({ status: 'RESEARCHING', cardId: best.cardId, variantId, confidence, collectionItemId: item!.id, updatedAt: new Date() }).where(eq(scans.id, scanId));
      await ctx.events.publish({
        type: 'IDENTIFICATION_COMPLETE',
        userId,
        scanId,
        cardId: best.cardId,
        jobId: job.id,
        message: `${best.name} (${Math.round(confidence * 1000) / 10}%)`,
        data: { confidence, alreadyOwned: Number(owned[0]?.n ?? 0) },
      });
      // Same job row continues into research
      await ctx.db
        .update(researchJobs)
        .set({ queue: 'research', status: 'QUEUED', stage: 'Queued for research', progress: 50, cardId: best.cardId, label: best.name })
        .where(eq(researchJobs.id, job.id!));
      await ctx.queues.research.add(
        'research',
        { researchJobId: job.id!, cardId: best.cardId, scanId, userId, priority: 3, reason: 'SCAN' },
        { jobId: job.id!, priority: 3 },
      );
      return { decision, cardId: best.cardId, confidence };
    }

    // Needs a human: verification (80–94%) or manual processing (<80%)
    const verify = decision === 'VERIFY';
    await ctx.db.update(scans).set({ status: verify ? 'NEEDS_VERIFICATION' : 'MANUAL_REVIEW', confidence, cardId: null, updatedAt: new Date() }).where(eq(scans.id, scanId));
    const [open] = await ctx.db.select().from(manualReviews).where(and(eq(manualReviews.scanId, scanId), eq(manualReviews.status, 'OPEN')));
    const original = { candidates: top.map((t) => ({ cardId: t.cardId, name: t.name, game: t.game, confidence: t.confidence })), gameGuess: topGame, names: sig.nameCandidates, numbers: sig.numbers };
    if (open) await ctx.db.update(manualReviews).set({ originalIdentification: original, reason: verify ? 'VERIFY' : best ? 'LOW_CONFIDENCE' : 'NO_MATCH' }).where(eq(manualReviews.id, open.id));
    else await ctx.db.insert(manualReviews).values({ scanId, reason: verify ? 'VERIFY' : best ? 'LOW_CONFIDENCE' : 'NO_MATCH', originalIdentification: original });
    if (!best) await ctx.events.publish({ type: 'IDENTIFICATION_FAILED', userId, scanId, jobId: job.id, message: 'No catalog match' });
    await tracker.finish('MANUAL_REVIEW', verify ? `Verify: ${best!.name}?` : 'Needs manual identification', 'MANUAL_REVIEW_REQUIRED', { label: best?.name ?? 'Unknown card' });
    return { decision, confidence };
  });
}
