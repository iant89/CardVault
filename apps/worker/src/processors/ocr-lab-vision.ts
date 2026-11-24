import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, inArray, ocrModels, ocrSamples, scans, sql } from '@cardvault/database';
import type { WorkerContext } from '../context.js';
import { classifierFor } from '../identification/engines.js';
import { isSportsGame } from '@cardvault/shared';
import { ARTIFACT_FILES, discoverExports, gameForClass, loadVisionArtifact, type VisionArtifact } from '../identification/vision.js';

/**
 * CardVault-Vision artifacts in OCR Lab's model registry.
 *
 * The lab has always registered what the trainer wrote (`ocr/models/<id>/`).
 * A Vision export is a different shape — one directory per *task and version* —
 * and a scan needs a *pair* of them (`name-ocr` + `number-ocr`). This module
 * turns exports into the same `ocr_models` rows everything else reads, so
 * scoring, the live trial, promotion gates and the automatic watch work on a
 * Vision model exactly as they do on a legacy one:
 *
 *   exports/name-ocr/1.0.0     ┐
 *   exports/number-ocr/1.0.0   ┴→ one row  `vision-ocr-1.0.0`     (reads lines)
 *   exports/card-classifier/1.0.0 → one row `vision-classifier-1.0.0` (routes games)
 *
 * A lone head still registers (reading what it can), and a second version of a
 * pair is a second row, so the exam can compare them.
 */

/** Where Vision exports are looked for: `<storage>/ocr/vision/exports` and any configured root. */
export function visionRoots(ctx: WorkerContext): string[] {
  const roots = [path.join(ctx.storageDir, 'ocr', 'vision', 'exports')];
  const extra = ctx.config.VISION_MODELS_DIR;
  if (extra) for (const dir of extra.split(path.delimiter).map((d) => d.trim()).filter(Boolean)) roots.push(path.resolve(ctx.storageDir, dir));
  return [...new Set(roots)];
}

/** A pair id for an OCR model, stable across rescans: `vision-ocr-1.0.0`. */
export const ocrModelId = (head: 'pair' | 'name' | 'number', version: string) =>
  `vision-${head === 'pair' ? 'ocr' : head}-${version}`.replace(/[^A-Za-z0-9._-]+/g, '-');

/** A classifier row id: `vision-classifier-1.0.0`. */
export const classifierModelId = (version: string) => `vision-classifier-${version}`.replace(/[^A-Za-z0-9._-]+/g, '-');

interface Registered {
  id: string;
  task: 'ocr' | 'card-classifier';
  version: string;
}

export interface ScanVisionResult {
  models: string[];
  registered: Registered[];
  errors: { dir: string; error: string }[];
  /** artifacts seen, by task and version */
  found: { task: string; version: string; dir: string }[];
}

/** The dataset a Vision artifact records training on, in OCR Lab's shape. */
function datasetInfo(a: VisionArtifact): { id: string; rows?: number } | undefined {
  const ds = a.metadata.dataset as { version?: string | null } | undefined;
  const id = ds?.version ?? undefined;
  return id ? { id } : undefined;
}

/**
 * Discover Vision exports on disk and register the ones not registered yet.
 *
 * A directory that fails verification is *not* registered, and its error is
 * returned so OCR Lab can say which export is broken and why — silently
 * skipping it would leave an admin wondering why a model never appears.
 */
export async function scanVisionModels(ctx: WorkerContext): Promise<ScanVisionResult> {
  const roots = visionRoots(ctx);
  const found: ScanVisionResult['found'] = [];
  const errors: { dir: string; error: string }[] = [];
  /** version → the heads found for it, across roots */
  const byVersion = new Map<string, { name?: { artifact: VisionArtifact; rel: string }; number?: { artifact: VisionArtifact; rel: string } }>();
  const classifiers: { artifact: VisionArtifact; rel: string }[] = [];

  for (const root of roots) {
    const info = await stat(root).catch(() => null);
    if (!info?.isDirectory()) continue;
    const { artifacts, errors: bad } = await discoverExports(root);
    errors.push(...bad);
    for (const a of artifacts) {
      const rel = path.relative(ctx.storageDir, a.absoluteDir) || a.dir;
      const version = String(a.metadata.version ?? path.basename(a.dir));
      found.push({ task: a.task, version, dir: rel });
      if (a.task === 'card-classifier') classifiers.push({ artifact: a, rel });
      else {
        const slot = byVersion.get(version) ?? {};
        slot[a.task === 'name-ocr' ? 'name' : 'number'] = { artifact: a, rel };
        byVersion.set(version, slot);
      }
    }
  }

  const registered: Registered[] = [];
  const models: string[] = [];

  const upsert = async (id: string, dir: string, card: Record<string, unknown>): Promise<boolean> => {
    const [existing] = await ctx.db.select({ id: ocrModels.id, card: ocrModels.card }).from(ocrModels).where(eq(ocrModels.id, id));
    if (existing) {
      // a rescan refreshes the provenance of a model that is not reading scans,
      // and never touches the row of one that is (its trial/watch live there)
      const status = (await ctx.db.select({ status: ocrModels.status }).from(ocrModels).where(eq(ocrModels.id, id)))[0]?.status;
      if (status && status !== 'candidate') return false;
      const merged = { ...(existing.card as Record<string, unknown>), ...card };
      if (JSON.stringify(merged) !== JSON.stringify(existing.card)) await ctx.db.update(ocrModels).set({ dir, card: merged }).where(eq(ocrModels.id, id));
      return false;
    }
    await ctx.db.insert(ocrModels).values({ id, dir, card }).onConflictDoNothing();
    return true;
  };

  for (const [version, heads] of [...byVersion.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const any = heads.name?.artifact ?? heads.number?.artifact!;
    const id = ocrModelId(heads.name && heads.number ? 'pair' : heads.name ? 'name' : 'number', version);
    const card = {
      kind: 'vision',
      id,
      task: heads.name && heads.number ? 'ocr-pair' : heads.name ? 'name-ocr' : 'number-ocr',
      version,
      architecture: any.metadata.architecture ?? 'crnn',
      heads: {
        ...(heads.name ? { name: heads.name.rel } : {}),
        ...(heads.number ? { number: heads.number.rel } : {}),
      },
      checksums: Object.fromEntries([[heads.name ? 'name' : 'number', any.sha256]] as [string, string][]),
      metrics: { ...(heads.name?.artifact.metadata.metrics ?? {}), ...(heads.number?.artifact.metadata.metrics ?? {}) },
      dataset: datasetInfo(any),
      training: {
        ...(any.metadata.training_config ?? {}),
        ...(any.metadata.epoch != null ? { epochs: any.metadata.epoch } : {}),
      },
      validation: {
        name: heads.name?.artifact.validation?.status ?? null,
        number: heads.number?.artifact.validation?.status ?? null,
      },
      exportedAt: any.metadata.exported_at ?? null,
      gitCommit: any.metadata.git_commit ?? null,
    };
    const added = await upsert(id, heads.name?.rel ?? heads.number!.rel, card);
    registered.push({ id, task: 'ocr', version });
    if (added) models.push(id);
  }

  for (const { artifact, rel } of classifiers) {
    const version = String(artifact.metadata.version ?? path.basename(artifact.dir));
    const id = classifierModelId(version);
    const card = {
      kind: 'vision',
      id,
      task: 'card-classifier',
      version,
      architecture: artifact.metadata.architecture ?? 'card-type-cnn',
      checksum: artifact.sha256,
      classes: artifact.labels,
      metrics: artifact.metadata.metrics ?? {},
      validation: artifact.validation?.status ?? null,
      exportedAt: artifact.metadata.exported_at ?? null,
      gitCommit: artifact.metadata.git_commit ?? null,
    };
    const added = await upsert(id, rel, card);
    registered.push({ id, task: 'card-classifier', version });
    if (added) models.push(id);
  }

  if (models.length) ctx.log.info({ models }, 'CardVault-Vision artifacts registered');
  return { models, registered, errors, found };
}

// ------------------------------------------------------------------ classifier evaluation

/** Is this `ocr_models` row a game classifier rather than a line reader? */
export const isClassifierRow = (card: unknown): boolean => (card as { task?: string } | null)?.task === 'card-classifier';

/**
 * Score a game classifier on the frozen exam.
 *
 * Its units are cards, not lines: for every exam group whose *full image* is
 * available, the classifier names a game and the sample's own game says whether
 * that was right. A `SPORTS` verdict counts for any of the four sports, because
 * that is the distinction the export actually makes; anything else must match
 * exactly. Abstentions (OTHER/UNKNOWN, or below 0.5) are scored as misses —
 * routing a card to the wrong layout costs more than declining to route it, but
 * a classifier that declines everything must not look good.
 */
export async function evaluateClassifier(
  ctx: WorkerContext,
  model: { id: string; dir: string; card: unknown },
  examSampleIds: string[],
): Promise<{
  units: number;
  correct: number;
  abstained: number;
  missingImages: number;
  msPerCard: number | null;
  slices: { slice: string; n: number; accuracy: number; confidentAccuracy: null; confident: number }[];
  misses: Record<string, unknown>[];
}> {
  const classifier = await classifierFor(ctx, model);
  const ids = examSampleIds.length ? examSampleIds : ['00000000-0000-0000-0000-000000000000'];
  const rows = (await ctx.db.execute(sql`
    SELECT DISTINCT s.group_key, s.game, s.scan_id, sc.image_path
    FROM ocr_samples s JOIN scans sc ON sc.id = s.scan_id
    WHERE s.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
      AND s.scan_id IS NOT NULL`)) as unknown as { group_key: string; game: string; scan_id: string; image_path: string }[];
  const { readFile } = await import('node:fs/promises');
  const { resolveStoragePath } = await import('@cardvault/imaging');
  let correct = 0;
  let abstained = 0;
  let missingImages = 0;
  let ms = 0;
  let scored = 0;
  const misses: Record<string, unknown>[] = [];
  const byGame = new Map<string, { n: number; ok: number }>();
  for (const r of rows) {
    let image: Buffer;
    try {
      image = await readFile(resolveStoragePath(ctx.storageDir, r.image_path));
    } catch {
      missingImages++;
      continue;
    }
    const t0 = Date.now();
    const hit = await classifier.classify(image).catch(() => null);
    ms += Date.now() - t0;
    scored++;
    const expected = r.game;
    const got = hit?.game ?? null;
    const ok = got != null && (got === expected || (isSportsGame(expected) && got !== null && isSportsGame(got)) || (gameForClass(hit!.guess.label) === expected));
    if (hit == null) abstained++;
    if (ok) correct++;
    const g = byGame.get(expected) ?? { n: 0, ok: 0 };
    g.n++;
    if (ok) g.ok++;
    byGame.set(expected, g);
    if (!ok && misses.length < 120) misses.push({ field: 'game', game: expected, predicted: got ?? 'ABSTAIN', raw: hit?.guess.label ?? '', label: expected, samples: [] });
  }
  const slice = (name: string, n: number, ok: number) => ({ slice: name, n, accuracy: n ? Math.round((ok / n) * 10000) / 10000 : 0, confidentAccuracy: null, confident: 0 });
  const slices = [slice('all · game', scored, correct)];
  for (const [game, { n, ok }] of [...byGame.entries()].sort(([a], [b]) => a.localeCompare(b))) slices.push(slice(`game ${game} · game`, n, ok));
  return { units: scored, correct, abstained, missingImages, msPerCard: scored ? Math.round(ms / scored) : null, slices, misses };
}

// ------------------------------------------------------------------ exports on disk

/** Every artifact directory under the Vision roots, for OCR Lab's provenance view. */
export async function visionExportsOnDisk(ctx: WorkerContext): Promise<{ root: string; dir: string; task?: string; version?: string; status: string }[]> {
  const out: { root: string; dir: string; task?: string; version?: string; status: string }[] = [];
  for (const root of visionRoots(ctx)) {
    if (!(await stat(root).catch(() => null))?.isDirectory()) continue;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const version of await readdir(path.join(root, entry.name), { withFileTypes: true }).catch(() => [])) {
        if (!version.isDirectory()) continue;
        const abs = path.join(root, entry.name, version.name);
        const files = await readdir(abs).catch(() => [] as string[]);
        const complete = ARTIFACT_FILES.every((f) => (files as string[]).includes(f));
        let status = complete ? 'complete' : 'incomplete';
        if (complete) {
          try {
            const a = await loadVisionArtifact(abs, path.relative(ctx.storageDir, abs));
            status = a.validation?.status === 'APPROVED' ? 'approved' : 'ok';
          } catch (e) {
            status = e instanceof Error ? e.message : 'invalid';
          }
        }
        out.push({ root: path.relative(ctx.storageDir, root), dir: path.relative(ctx.storageDir, abs), task: entry.name, version: version.name, status });
      }
    }
  }
  return out;
}

/** Active classifier row, if one is reading scans. */
export async function activeClassifier(ctx: WorkerContext) {
  const rows = await ctx.db.select().from(ocrModels).where(eq(ocrModels.status, 'active'));
  return rows.find((r) => isClassifierRow(r.card)) ?? null;
}

/** The most recently activated classifier row of a task, for comparisons. */
export async function latestClassifierModel(ctx: WorkerContext, excludeId?: string) {
  const rows = await ctx.db.select().from(ocrModels).orderBy(desc(ocrModels.createdAt));
  return rows.find((r) => isClassifierRow(r.card) && r.id !== excludeId) ?? null;
}

/** Rows that read lines (either a Vision pair or a legacy trainer model). */
export async function ocrModelRows(ctx: WorkerContext) {
  const rows = await ctx.db.select().from(ocrModels).where(inArray(ocrModels.status, ['candidate', 'shadow', 'active', 'retired']));
  return rows.filter((r) => !isClassifierRow(r.card));
}

export { and, ocrSamples };
