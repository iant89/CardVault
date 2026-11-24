import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GAME_MODULES } from '@cardvault/card-model';
import { resolveStoragePath, simulateCapture, toJpeg, type CardRegion } from '@cardvault/imaging';
import type { GameSlug } from '@cardvault/shared';
import type { WorkerContext } from '../context.js';

/**
 * CardVault → CardVault-Vision dataset bridge.
 *
 * The lab's own export (`ocr/datasets/<id>/train.jsonl`) is one line reader's
 * training set: crop paths and their text. CardVault-Vision trains *whole
 * cards* — it needs the full image and where every field sits, so it can cut
 * its own crops, synthesise new captures and train separate heads.
 *
 * So a second snapshot is written beside the JSONL one, in CardVault-Vision's
 * own manifest format, which `vision train <task> --dataset <dir>` accepts
 * directly:
 *
 *   storage/ocr/datasets/<id>/vision/
 *     manifest.json
 *     images/<group>.jpg      the full card image each sample annotates
 *
 * Annotations carry each field's box in *pixels of that image* (CardVault's
 * layouts are fractions of the card, so they are scaled by the image size) and
 * its label text. The split is CardVault's own: only `train`-side groups are
 * exported, so the frozen exam stays unseen — the same rule as the JSONL
 * snapshot, for the same reason.
 *
 * `metadata.cardvault` records where the dataset came from (id, counts, the
 * JSONL snapshot's hash, and each game's field ROIs), so a model trained on it
 * can be traced to the exact lines and boxes CardVault exported.
 */

export const VISION_MANIFEST = 'manifest.json';
export const VISION_IMAGE_DIR = 'images';
/** The schema version CardVault-Vision writes in its manifests. */
export const VISION_SCHEMA_VERSION = '1.0';

/** One training-side group: a scan's crop set, or one harvested card. */
export interface VisionGroup {
  /** stable id, also the sample's image_id */
  groupKey: string;
  game: string;
  /** catalog card id, when the group was identified */
  cardId: string | null;
  /** storage-relative path of the full image (a scan photo, or a harvest original) */
  imagePath: string;
  /** true when `imagePath` is an official card image to be made camera-like */
  harvest: boolean;
  /** which spot in the game's layout carries the label, per field */
  nameRegion: number | null;
  numberRegion: number | null;
  nameText: string | null;
  numberText: string | null;
  meta: Record<string, unknown>;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface FieldAnnotation {
  text: string;
  bbox: Box;
  roi?: Box;
}

export interface VisionSample {
  image_id: string;
  card_id: string;
  image_path: string;
  width: number;
  height: number;
  sha256: string;
  split: string;
  tags: string[];
  annotation: {
    schema_version: string;
    image_id: string;
    card_id: string;
    card_type: string;
    width: number;
    height: number;
    fields: Record<string, FieldAnnotation>;
    generation?: Record<string, unknown>;
    extra?: Record<string, unknown>;
  };
}

export interface VisionManifest {
  schema_version: string;
  name: string;
  kind: 'real';
  /** absolute path the manifest's relative `image_path`s resolve against */
  root: string;
  version: { version: string; created_at: string; content_hash?: string; notes?: string };
  counts: { samples: number; cards: number };
  provenance: Record<string, unknown>;
  metadata: Record<string, unknown>;
  samples: VisionSample[];
}

/**
 * CardVault's game slug as CardVault-Vision's card type. The sports games map to
 * their own types (the classifier knows all four); anything unknown abstains
 * rather than claiming to be a card type it is not.
 */
export function normalizeCardType(game: string): string {
  switch (game) {
    case 'pokemon':
      return 'POKEMON';
    case 'magic':
      return 'MAGIC_THE_GATHERING';
    case 'yugioh':
      return 'YU_GI_OH';
    case 'baseball':
      return 'BASEBALL';
    case 'football':
      return 'FOOTBALL';
    case 'basketball':
      return 'BASKETBALL';
    case 'hockey':
      return 'HOCKEY';
    default:
      return 'UNKNOWN';
  }
}

/** A fraction-of-the-card ROI as a pixel box on an image of a known size. */
export function roiToPixels(r: CardRegion, width: number, height: number): Box {
  return {
    x0: Math.round(r.left * width),
    y0: Math.round(r.top * height),
    x1: Math.round((r.left + r.width) * width),
    y1: Math.round((r.top + r.height) * height),
  };
}

/** A ROI in normalised card coordinates (CardVault-Vision's `FieldAnnotation.roi`). */
const normalized = (r: CardRegion): Box => ({ x0: r.left, y0: r.top, x1: r.left + r.width, y1: r.top + r.height });

/** The spot in a game's layout that a field's label belongs to. */
function regionOf(game: string, field: 'name' | 'number', index: number | null): CardRegion | null {
  const layout = GAME_MODULES[game as GameSlug]?.ocrLayout;
  if (!layout || index == null) return null;
  return (field === 'name' ? layout.name : layout.number)[index] ?? null;
}

/**
 * Build one manifest sample.
 *
 * Only fields with *both* a known box and known text are annotated: an empty
 * annotation is worse than a missing one, because CardVault-Vision's OCR
 * trainer reads text from `annotation.fields[field]` and would learn to read
 * nothing from a blank.
 */
export function sampleFor(
  group: VisionGroup,
  image: { width: number; height: number; sha256: string; relativePath: string },
  opts: { split: string },
): VisionSample {
  const fields: Record<string, FieldAnnotation> = {};
  for (const [field, text, index] of [
    ['name', group.nameText, group.nameRegion],
    ['number', group.numberText, group.numberRegion],
  ] as const) {
    if (!text || index == null) continue;
    const region = regionOf(group.game, field, index);
    if (!region) continue;
    fields[field] = { text, bbox: roiToPixels(region, image.width, image.height), roi: normalized(region) };
  }
  const tags = [group.game];
  if (group.harvest) tags.push('harvest');
  if (typeof group.meta.era === 'string') tags.push(`era:${group.meta.era}`);
  return {
    image_id: group.groupKey,
    card_id: group.cardId ?? group.groupKey,
    image_path: image.relativePath,
    width: image.width,
    height: image.height,
    sha256: image.sha256,
    split: opts.split,
    tags,
    annotation: {
      schema_version: VISION_SCHEMA_VERSION,
      image_id: group.groupKey,
      card_id: group.cardId ?? group.groupKey,
      card_type: normalizeCardType(group.game),
      width: image.width,
      height: image.height,
      fields,
      // harvested cards are simulated captures: their own slice, never mixed in
      // as if they were photographs
      ...(group.harvest ? { generation: { source: 'harvest', simulated_capture: true } } : {}),
      ...(Object.keys(group.meta).length ? { extra: group.meta } : {}),
    },
  };
}

/** Order-independent content hash over `(image_id, sha256)`, as CardVault-Vision does. */
export function contentHash(samples: Pick<VisionSample, 'image_id' | 'sha256'>[]): string {
  const h = createHash('sha256');
  for (const pair of samples.map((s) => `${s.image_id}:${s.sha256}`).sort()) h.update(pair).update('\n');
  return h.digest('hex');
}

/** The full image a group annotates, as JPEG bytes plus its facts. */
async function imageFor(ctx: WorkerContext, group: VisionGroup): Promise<{ data: Buffer; width: number; height: number }> {
  const source = await readFile(resolveStoragePath(ctx.storageDir, group.imagePath));
  // a harvested card is an official image: make it a camera-like capture, the
  // same transformation the import used, so training sees scanner-like pixels
  const img = group.harvest ? (await simulateCapture(source, seedOf(group.groupKey))).image : source;
  return toJpeg(img);
}

/** A stable 32-bit hash, for a repeatable simulated capture per card. */
function seedOf(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

export interface VisionDatasetResult {
  /** `ocr/datasets/<id>/vision`, relative to the storage folder */
  dir: string;
  samples: number;
  cards: number;
  contentHash: string;
  skipped: number;
  /** how many samples carry each field, i.e. what each head can train on */
  fields: Record<string, number>;
}

/**
 * Write the CardVault-Vision dataset for an exported snapshot.
 *
 * Returns null when no group had both a readable image and a labelled field:
 * an empty manifest would only fail later, inside the trainer.
 */
export async function writeVisionDataset(
  ctx: WorkerContext,
  datasetId: string,
  groups: VisionGroup[],
  provenance: { jsonlSha256?: string; counts?: Record<string, number>; createdAt: string; split: string },
): Promise<VisionDatasetResult | null> {
  const absolute = path.join(ctx.storageDir, 'ocr', 'datasets', datasetId, 'vision');
  const images = path.join(absolute, VISION_IMAGE_DIR);
  await mkdir(images, { recursive: true });
  const samples: VisionSample[] = [];
  let skipped = 0;
  for (const g of groups) {
    let image: { data: Buffer; width: number; height: number };
    try {
      image = await imageFor(ctx, g);
    } catch (e) {
      ctx.log.warn({ group: g.groupKey, err: (e as Error).message }, 'vision dataset: image unreadable, group skipped');
      skipped++;
      continue;
    }
    const file = `${g.groupKey.replace(/[^A-Za-z0-9._-]+/g, '_')}.jpg`;
    const sample = sampleFor(g, {
      width: image.width,
      height: image.height,
      sha256: createHash('sha256').update(image.data).digest('hex'),
      relativePath: `${VISION_IMAGE_DIR}/${file}`,
    }, { split: provenance.split });
    if (!Object.keys(sample.annotation.fields).length) {
      skipped++;
      continue;
    }
    await writeFile(path.join(images, file), image.data);
    samples.push(sample);
  }
  if (!samples.length) return null;

  // A *card-level* validation split. The factory trains on `train` and measures
  // held-out CER on `val`, and with every sample in `train` (the lab's own
  // export only trains) it would report training CER as if it were held out.
  // Cards are split, never lines: two scans of one card would otherwise sit on
  // both sides and flatter the score. The frozen exam is still the real judge —
  // this is only the trainer's own progress signal.
  const val = splitForValidation(samples, 0.2);
  for (const s of samples) if (val.has(s.card_id)) s.split = 'val';

  const fields: Record<string, number> = {};
  for (const s of samples) for (const f of Object.keys(s.annotation.fields)) fields[f] = (fields[f] ?? 0) + 1;
  const cards = new Set(samples.map((s) => s.card_id)).size;
  const hash = contentHash(samples);
  const manifest: VisionManifest = {
    schema_version: VISION_SCHEMA_VERSION,
    name: `cardvault-${datasetId}`,
    kind: 'real',
    // CardVault-Vision resolves a *relative* root against the process's working
    // directory, not against the manifest, so a trainer started anywhere but
    // this folder would look for the images in the wrong place. Absolute, and
    // the container's own path: a run on this server, reading this dataset.
    root: absolute,
    version: { version: '1.0.0', created_at: provenance.createdAt, content_hash: hash, notes: `CardVault OCR Lab dataset ${datasetId}` },
    counts: { samples: samples.length, cards },
    provenance: {
      source: 'cardvault',
      dataset: datasetId,
      jsonl_sha256: provenance.jsonlSha256 ?? null,
      created_at: provenance.createdAt,
      exported_by: 'cardvault-ocr-lab',
      splits: { train: samples.filter((x) => x.split === 'train').length, val: val.size ? samples.filter((x) => x.split === 'val').length : 0 },
    },
    metadata: {
      cardvault: {
        dataset: datasetId,
        counts: provenance.counts ?? {},
        fields,
        split: provenance.split,
        // the layout each game's boxes came from: a model trained on these boxes
        // is a model a scan will show the same boxes to
        field_rois: Object.fromEntries(
          Object.values(GAME_MODULES)
            .filter((m) => m.ocrLayout)
            .map((m) => [m.slug, { name: m.ocrLayout!.name, number: m.ocrLayout!.number }]),
        ),
      },
    },
    samples,
  };
  await writeFile(path.join(absolute, VISION_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  ctx.log.info({ dataset: datasetId, samples: samples.length, cards, skipped }, 'CardVault-Vision dataset written');
  return { dir: path.relative(ctx.storageDir, absolute), samples: samples.length, cards, contentHash: hash, skipped, fields };
}

/**
 * Card ids held out for the factory's own validation, chosen by a stable hash of
 * the card id, so two exports of overlapping data split the same way and a card
 * can never drift from one side to the other between runs.
 */
export function splitForValidation(samples: Pick<VisionSample, 'card_id'>[], fraction: number): Set<string> {
  const cards = [...new Set(samples.map((s) => s.card_id))];
  const hold = Math.round(cards.length * Math.min(0.5, Math.max(0, fraction)));
  if (hold <= 0) return new Set();
  // keep at least one card training, whatever the fraction
  const keep = Math.max(0, Math.min(hold, cards.length - 1));
  return new Set(cards.sort((a, b) => fnv(a) - fnv(b) || a.localeCompare(b)).slice(0, keep));
}

/** A stable 32-bit hash of a card id (FNV-1a), for the validation split. */
function fnv(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

/** Read a written manifest (used by OCR Lab's dataset listing). */
export async function readVisionManifest(dir: string): Promise<VisionManifest | null> {
  const raw = await readFile(path.join(dir, VISION_MANIFEST), 'utf8').catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as VisionManifest;
    return Array.isArray(parsed.samples) ? parsed : null;
  } catch {
    return null;
  }
}

/** What a dataset directory's Vision manifest holds, for OCR Lab's list. */
export async function visionManifestInfo(dir: string): Promise<{ samples: number; cards: number; fields: Record<string, number> } | null> {
  const m = await readVisionManifest(dir);
  if (!m) return null;
  const fields: Record<string, number> = {};
  for (const s of m.samples) for (const f of Object.keys(s.annotation.fields ?? {})) fields[f] = (fields[f] ?? 0) + 1;
  return { samples: m.samples.length, cards: new Set(m.samples.map((s) => s.card_id)).size, fields };
}
