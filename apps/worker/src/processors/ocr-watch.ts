import { auditLog, eq, ocrModels, sql } from '@cardvault/database';
import type { WorkerContext } from '../context.js';
import { compareTrial, namePrediction, numberPrediction, rollbackDecision, type LiveUnit, type WatchRules, type WatchWindow } from '../identification/ocr-data.js';
import { resetLiveEngine } from '../identification/engines.js';

interface Row {
  id: string;
  group_key: string;
  game: string;
  field: 'name' | 'number';
  predicted: string;
  label_norm: string;
  shadow_text: string | null;
}

const correct = (field: 'name' | 'number', text: string, game: string, label: string) =>
  field === 'name' ? namePrediction(text) === label : numberPrediction(text, game)?.norm === label;

/** Score labelled live samples the way identification uses them: titles per line, numbers per scan. */
export function liveUnits(rows: Row[]): LiveUnit[] {
  const units: LiveUnit[] = [];
  const numbers = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.field === 'name') {
      units.push({ field: 'name', live: correct('name', r.predicted, r.game, r.label_norm), ...(r.shadow_text != null ? { shadow: correct('name', r.shadow_text, r.game, r.label_norm) } : {}) });
    } else (numbers.get(r.group_key) ?? numbers.set(r.group_key, []).get(r.group_key)!).push(r);
  }
  for (const g of numbers.values()) {
    const f = g[0]!;
    const hasShadow = g.every((r) => r.shadow_text != null);
    units.push({
      field: 'number',
      live: correct('number', g.map((r) => r.predicted).join('\n'), f.game, f.label_norm),
      ...(hasShadow ? { shadow: correct('number', g.map((r) => r.shadow_text).join('\n'), f.game, f.label_norm) } : {}),
    });
  }
  return units;
}

/** Labelled lines from live scans (never harvest), optionally limited to an engine and a time window. */
async function labelledRows(ctx: WorkerContext, opts: { since: Date; until?: Date; engineLike?: string; shadowEngine?: string }) {
  const rows = await ctx.db.execute(sql`
    SELECT id, group_key, game, field, predicted, label_norm, meta->'shadow'->>'text' AS shadow_text
    FROM ocr_samples
    WHERE scan_id IS NOT NULL AND label_source IN ('review', 'corroborated') AND label_norm IS NOT NULL
      AND created_at >= ${opts.since.toISOString()}::timestamptz ${opts.until ? sql`AND created_at < ${opts.until.toISOString()}::timestamptz` : sql``}
      ${opts.engineLike ? sql`AND engine LIKE ${opts.engineLike}` : sql``}
      ${opts.shadowEngine ? sql`AND meta->'shadow'->>'engine' = ${opts.shadowEngine}` : sql``}`);
  return rows as unknown as Row[];
}

/** Scans in a window, and how many needed a person (went to manual review). */
async function scanWindow(ctx: WorkerContext, since: Date, until?: Date) {
  const [r] = await ctx.db.execute(sql`
    SELECT count(*)::int AS scans,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM manual_reviews m WHERE m.scan_id = s.id))::int AS reviewed
    FROM scans s WHERE s.created_at >= ${since.toISOString()}::timestamptz ${until ? sql`AND s.created_at < ${until.toISOString()}::timestamptz` : sql``}`);
  return { scans: Number(r?.scans ?? 0), reviewed: Number(r?.reviewed ?? 0) };
}

const engineLike = (engine: string) => (engine.startsWith('model:') ? `${engine}%` : 'tesseract%');

/**
 * Switch live reading back to what was used before this model: the previous
 * model if there was one, otherwise Tesseract. Recorded on the model and in
 * the audit log.
 */
export async function switchBack(ctx: WorkerContext, modelId: string, reason: string) {
  const [m] = await ctx.db.select().from(ocrModels).where(eq(ocrModels.id, modelId));
  if (!m || m.status !== 'active') return null;
  const prev = m.previousEngine?.startsWith('model:') ? m.previousEngine.slice('model:'.length) : null;
  await ctx.db.transaction(async (tx) => {
    await tx.update(ocrModels).set({ status: 'retired', retiredAt: new Date(), retiredReason: reason }).where(eq(ocrModels.id, m.id));
    if (prev) await tx.update(ocrModels).set({ status: 'active', activatedAt: new Date(), retiredReason: null }).where(eq(ocrModels.id, prev));
    await tx.insert(auditLog).values({ action: 'ocr.auto_rollback', entity: 'ocr_model', entityId: m.id, metadata: { reason, restored: prev ?? 'tesseract' } });
  });
  resetLiveEngine();
  ctx.log.warn({ model: m.id, restored: prev ?? 'tesseract', reason }, 'OCR model rolled back automatically');
  return prev ?? 'tesseract';
}

/**
 * Runs every 15 minutes:
 *  - the model on live trial: how it does against the live engine on the same, now labelled, lines
 *  - the active model: its live results since promotion against the previous
 *    engine's in the same length of time before; rolled back if clearly worse
 */
export async function runWatch(ctx: WorkerContext) {
  const out: Record<string, unknown> = {};
  const models = await ctx.db.select().from(ocrModels);

  for (const m of models.filter((x) => x.status === 'shadow' && x.trialStartedAt)) {
    const rows = await labelledRows(ctx, { since: m.trialStartedAt!, shadowEngine: `model:${m.id}` });
    const trial = { ...compareTrial(liveUnits(rows)), updatedAt: new Date().toISOString(), since: m.trialStartedAt };
    await ctx.db.update(ocrModels).set({ trial }).where(eq(ocrModels.id, m.id));
    out.trial = { model: m.id, ...trial };
  }

  const active = models.find((x) => x.status === 'active' && x.activatedAt);
  if (active) {
    const since = active.activatedAt!;
    const span = Math.min(Date.now() - since.getTime(), 30 * 24 * 3600 * 1000);
    const beforeFrom = new Date(since.getTime() - Math.max(span, 7 * 24 * 3600 * 1000));
    const prevEngine = active.previousEngine ?? 'tesseract';
    const score = (units: LiveUnit[]) => ({ lines: units.length, correct: units.filter((u) => u.live).length });
    const after: WatchWindow = { ...score(liveUnits(await labelledRows(ctx, { since, engineLike: engineLike(`model:${active.id}`) }))), ...(await scanWindow(ctx, since)) };
    const before: WatchWindow = { ...score(liveUnits(await labelledRows(ctx, { since: beforeFrom, until: since, engineLike: engineLike(prevEngine) }))), ...(await scanWindow(ctx, beforeFrom, since)) };
    const rules: WatchRules = {
      minLines: ctx.config.OCR_WATCH_MIN_LINES,
      minScans: ctx.config.OCR_WATCH_MIN_SCANS,
      maxAccuracyDrop: ctx.config.OCR_WATCH_MAX_DROP,
      maxReviewRise: ctx.config.OCR_WATCH_MAX_REVIEW_RISE,
    };
    const d = rollbackDecision(after, before, rules);
    const watch = { after, before, previousEngine: prevEngine, rules, judged: d.judged, reasons: d.reasons, updatedAt: new Date().toISOString() };
    await ctx.db.update(ocrModels).set({ watch }).where(eq(ocrModels.id, active.id));
    out.watch = { model: active.id, ...watch };
    if (d.rollback) out.rolledBackTo = await switchBack(ctx, active.id, d.reasons.join('; '));
  }
  return out;
}
