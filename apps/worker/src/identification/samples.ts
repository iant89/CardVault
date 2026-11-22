import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { and, eq, lt, ocrSamples, sql } from '@cardvault/database';
import { resolveStoragePath, writeFileSafe } from '@cardvault/imaging';
import type { SignalScore } from '@cardvault/shared';
import type { WorkerContext } from '../context.js';
import { ENGINE_ID, type OcrLine } from './ocr.js';
import { autoLabelSource, eraOf, namePrediction, nameNorm, numberPrediction, splitFor } from './ocr-data.js';

const month = () => new Date().toISOString().slice(0, 7);
export const scanGroup = (scanId: string, version: number) => `scan:${scanId}:v${version}`;

async function removeFiles(ctx: WorkerContext, paths: string[]) {
  for (const p of paths) await rm(resolveStoragePath(ctx.storageDir, p), { force: true }).catch(() => undefined);
}

/**
 * Keep the lines a scan was read from (title and number spots) as unlabelled
 * samples. Older readings of the same scan (retakes, re-identification) are
 * replaced. Only lines cut with a known game's layout are kept.
 */
export async function saveScanSamples(ctx: WorkerContext, scan: { id: string; imageVersion: number; quality?: Record<string, unknown> }, game: string | undefined, lines: OcrLine[] | undefined) {
  const old = await ctx.db.select({ id: ocrSamples.id, path: ocrSamples.cropPath }).from(ocrSamples).where(eq(ocrSamples.scanId, scan.id));
  if (old.length) {
    await ctx.db.delete(ocrSamples).where(eq(ocrSamples.scanId, scan.id));
    await removeFiles(ctx, old.map((o) => o.path));
  }
  if (!game || !lines?.length) return 0;
  const group = scanGroup(scan.id, scan.imageVersion);
  const rows = [];
  for (const l of lines) {
    const id = randomUUID();
    const cropPath = await writeFileSafe(ctx.storageDir, `ocr/${month()}/${id}.png`, l.crop);
    rows.push({
      id,
      scanId: scan.id,
      imageVersion: scan.imageVersion,
      groupKey: group,
      game,
      field: l.field,
      region: l.region,
      cropPath,
      engine: ENGINE_ID,
      predicted: l.text,
      predictedConfidence: l.confidence,
      meta: { readings: l.readings, source: 'scan', capture: scan.quality ?? {} },
    });
  }
  await ctx.db.insert(ocrSamples).values(rows);
  return rows.length;
}

interface CardInfo {
  id: string;
  name: string;
  collector_number: string;
  collector_number_norm: string;
  game: string;
  release_date: string | null;
  set_code: string | null;
}

async function cardInfo(ctx: WorkerContext, cardId: string): Promise<CardInfo | null> {
  const rows = await ctx.db.execute(sql`
    SELECT c.id, c.name, c.collector_number, c.collector_number_norm, g.slug AS game,
           COALESCE(c.release_date, s.release_date)::text AS release_date, s.code AS set_code
    FROM cards c JOIN games g ON g.id = c.game_id LEFT JOIN sets s ON s.id = c.set_id
    WHERE c.id = ${cardId}`);
  return (rows[0] as unknown as CardInfo) ?? null;
}

/**
 * Label a scan's samples with the card it turned out to be.
 *  - mode 'review': a person confirmed or corrected it. Misreads become
 *    regression samples: every future engine must read them correctly.
 *  - mode 'auto': automatic identification. Trusted only where independent
 *    evidence agreed (see autoLabelSource); otherwise marked 'self'.
 */
export async function labelScanSamples(ctx: WorkerContext, scanId: string, cardId: string, mode: 'auto' | 'review', signals: SignalScore[] = []) {
  const card = await cardInfo(ctx, cardId);
  if (!card) return 0;
  const rows = await ctx.db.select().from(ocrSamples).where(eq(ocrSamples.scanId, scanId));
  if (!rows.length) return 0;
  const latest = Math.max(...rows.map((r) => r.imageVersion));
  const current = rows.filter((r) => r.imageVersion === latest);
  const split = splitFor(card.id);
  const era = eraOf(card.release_date);
  const nameLabel = nameNorm(card.name);
  const numberLabel = card.collector_number_norm;
  // numbers are scored per scan: whatever the number spots agree on
  const numberRows = current.filter((r) => r.field === 'number');
  const groupNumber = numberPrediction(numberRows.map((r) => r.predicted).join('\n'), card.game);
  const now = new Date();
  for (const r of current) {
    if (r.game !== card.game) {
      await ctx.db.update(ocrSamples).set({ labelSource: 'excluded', cardId: card.id, labeledAt: now }).where(eq(ocrSamples.id, r.id));
      continue;
    }
    const source = mode === 'review' ? 'review' : autoLabelSource(r.field as 'name' | 'number', signals);
    let labelText: string | null = null;
    let labelNorm: string | null = null;
    let wrong = false;
    if (r.field === 'name') {
      labelText = card.name;
      labelNorm = nameLabel;
      wrong = namePrediction(r.predicted) !== nameLabel;
    } else if (numberLabel) {
      labelNorm = numberLabel;
      // the exact printed text is known only when this spot's reading matched
      const own = numberPrediction(r.predicted, card.game);
      if (own?.norm === numberLabel) labelText = own.raw;
      wrong = groupNumber?.norm !== numberLabel;
    }
    await ctx.db
      .update(ocrSamples)
      .set({
        cardId: card.id,
        labelText,
        labelNorm,
        labelSource: labelNorm ? source : 'excluded',
        split,
        regression: mode === 'review' && wrong && !!labelNorm,
        meta: { ...r.meta, era, set: card.set_code, wrong },
        labeledAt: now,
      })
      .where(eq(ocrSamples.id, r.id));
  }
  return current.length;
}

/** Unlabelled samples of scans nobody identified (rejected, abandoned) are dropped after a month. */
export async function pruneSamples(ctx: WorkerContext) {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const stale = await ctx.db
    .select({ id: ocrSamples.id, path: ocrSamples.cropPath })
    .from(ocrSamples)
    .where(and(eq(ocrSamples.labelSource, 'pending'), lt(ocrSamples.createdAt, cutoff)));
  if (!stale.length) return 0;
  await ctx.db.execute(sql`DELETE FROM ocr_samples WHERE label_source = 'pending' AND created_at < ${cutoff}`);
  await removeFiles(ctx, stale.map((s) => s.path));
  return stale.length;
}
