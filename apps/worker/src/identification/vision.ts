import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { LineTensorSpec } from '@cardvault/imaging';
import { CLASSIFIER_SIZE, VISION_LINE_SPEC } from '@cardvault/imaging';

/**
 * CardVault-Vision artifacts: the contract between the Python model factory
 * (github.com/iant89/CardVault-Vision) and this worker.
 *
 * An export is a directory of plain files, so CardVault never needs Python at
 * runtime — it reads the JSON contracts and runs `model.onnx` with
 * onnxruntime-node:
 *
 *   <task>/<version>/
 *     model.onnx            self-contained graph (no external weights)
 *     metadata.json         task, version, input/output specs, checksum
 *     labels.json           CTC labels (index_offset 2) or class names
 *     preprocessing.json    how a crop becomes a tensor
 *     contract.json         output shape + decoding rules
 *     checksum.sha256       sha256 of model.onnx
 *     validation.json       written by `vision export validate` (optional here)
 *
 * Three tasks are understood: `name-ocr`, `number-ocr` and `card-classifier`.
 * The first two are line readers; the third classifies a whole card's game.
 *
 * Everything CardVault relies on is re-derived and checked here rather than
 * trusted: the checksum is recomputed, the input name and axis order come from
 * the contract, and an artifact that does not match its own JSON is rejected
 * instead of loading a model that would silently mis-decode.
 */

export type VisionTask = 'name-ocr' | 'number-ocr' | 'card-classifier';

export const VISION_TASKS: readonly VisionTask[] = ['name-ocr', 'number-ocr', 'card-classifier'];

export const ARTIFACT_FILES = ['model.onnx', 'metadata.json', 'labels.json', 'preprocessing.json', 'contract.json', 'checksum.sha256'] as const;

/** Why an artifact could not be loaded (never a generic Error: OCR Lab shows these). */
export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactError';
  }
}

// ------------------------------------------------------------------ JSON shapes

export interface VisionMetadata {
  schema_version?: string;
  task?: string;
  version?: string;
  architecture?: string;
  exported_at?: string;
  format?: string;
  opset?: number;
  input_spec?: { name?: string; shape?: (string | number)[]; dtype?: string };
  output_spec?: { name?: string; shape?: (string | number)[]; dtype?: string };
  num_classes?: number;
  checksum_sha256?: string;
  git_commit?: string | null;
  dataset?: { version?: string | null; content_hash?: string | null };
  metrics?: Record<string, unknown>;
  training_config?: Record<string, unknown>;
  field?: string | null;
  epoch?: number | null;
  [key: string]: unknown;
}

export interface VisionLabels {
  task?: string;
  count?: number;
  labels?: string[];
  /** 2 for OCR (0 = pad, 1 = blank), 0 for the classifier */
  index_offset?: number;
}

export interface VisionPreprocessing {
  type?: string;
  color_space?: string;
  channel_order?: string;
  input_layout?: string;
  input_height?: number;
  /** a number, or 'dynamic' for any width */
  width?: number | string;
  input_size?: number;
  value_range?: [number, number] | number[];
  normalization?: { mean?: number[]; std?: number[] };
  invert?: boolean;
  [key: string]: unknown;
}

export interface VisionContract {
  outputs?: { name?: string; shape?: (string | number)[]; dtype?: string }[];
  decoding?: {
    type?: string;
    blank_index?: number;
    pad_index?: number;
    steps?: string[];
    confidence?: string;
    abstain_rule?: string;
  };
  labels?: string;
  [key: string]: unknown;
}

export interface VisionValidation {
  status?: string;
  problems?: string[];
  max_abs_diff?: number | null;
  checksum_match?: boolean | null;
  checksums?: Record<string, string>;
  checks?: Record<string, unknown>;
}

/** A verified artifact directory, as CardVault will run it. */
export interface VisionArtifact {
  task: VisionTask;
  /** `<task>/<version>`, the directory name under the models root */
  dir: string;
  absoluteDir: string;
  metadata: VisionMetadata;
  labels: string[];
  preprocessing: VisionPreprocessing;
  contract: VisionContract;
  validation: VisionValidation | null;
  /** recomputed sha256 of model.onnx */
  sha256: string;
  /** ONNX input tensor name (metadata input_spec, else 'images') */
  inputName: string;
  /** ONNX output tensor name (metadata output_spec, else 'logits') */
  outputName: string;
  /** how far labels.json is shifted from the model's output index (2 for OCR, 0 for the classifier) */
  indexOffset: number;
  /** CTC specials (only meaningful for OCR artifacts) */
  blankIndex: number;
  padIndex: number;
  /** pixel contract a crop is turned into */
  lineSpec?: LineTensorSpec;
  /** side of the square the classifier expects */
  classifierSize?: number;
}

// ------------------------------------------------------------------ parsing helpers

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

async function readJson<T>(dir: string, name: string, required = true): Promise<T | null> {
  const raw = await readFile(path.join(dir, name), 'utf8').catch(() => null);
  if (raw === null) {
    if (required) throw new ArtifactError(`${name} is missing`);
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ArtifactError(`${name} is not valid JSON`);
  }
}

/** The task an artifact claims to be, from metadata.json (then labels.json). */
function taskOf(metadata: VisionMetadata, labels: VisionLabels | null, dirName: string): VisionTask {
  for (const candidate of [metadata.task, labels?.task, dirName]) {
    if (candidate && (VISION_TASKS as readonly string[]).includes(candidate)) return candidate as VisionTask;
  }
  throw new ArtifactError(`unknown task ${JSON.stringify(metadata.task ?? labels?.task ?? dirName)}; expected one of ${VISION_TASKS.join(', ')}`);
}

/**
 * The pixel contract from preprocessing.json. CardVault uses the declared
 * range/width limits; a missing file falls back to what every CardVault-Vision
 * OCR export has always used ([0, 1], 32 px tall, 32..1600 wide).
 */
export function lineSpecFrom(preprocessing: VisionPreprocessing): LineTensorSpec {
  const height = num(preprocessing.input_height) ?? VISION_LINE_SPEC.height;
  const maxWidth = typeof preprocessing.width === 'number' ? num(preprocessing.width) ?? VISION_LINE_SPEC.maxWidth : VISION_LINE_SPEC.maxWidth;
  const range: [number, number] = Array.isArray(preprocessing.value_range) && preprocessing.value_range.length >= 2
    ? [Number(preprocessing.value_range[0]), Number(preprocessing.value_range[1])]
    : [0, 1];
  return {
    height,
    minWidth: Math.min(height, VISION_LINE_SPEC.minWidth),
    maxWidth: Math.max(maxWidth, height),
    // [-1, 1] is what tools/ocr-trainer uses; CardVault-Vision exports [0, 1]
    range: range[0] < 0 ? 'signed' : 'unit',
    ...(preprocessing.invert ? { invert: true } : {}),
  };
}

export function classifierSizeFrom(preprocessing: VisionPreprocessing): number {
  return num(preprocessing.input_size) ?? CLASSIFIER_SIZE;
}

/**
 * Read and verify one artifact directory. Throws ArtifactError with a message
 * that says exactly what is wrong, so OCR Lab can show it to an admin.
 */
export async function loadVisionArtifact(absoluteDir: string, dir: string): Promise<VisionArtifact> {
  const info = await stat(absoluteDir).catch(() => null);
  if (!info?.isDirectory()) throw new ArtifactError(`${dir} is not a directory`);
  const metadata = (await readJson<VisionMetadata>(absoluteDir, 'metadata.json'))!;
  const labelsFile = await readJson<VisionLabels>(absoluteDir, 'labels.json', false);
  const labelList = Array.isArray(labelsFile?.labels) ? labelsFile!.labels!.map((l) => String(l)) : Array.isArray((metadata as { labels?: unknown }).labels) ? ((metadata as { labels: unknown[] }).labels).map(String) : [];
  if (!labelList.length) throw new ArtifactError('labels.json has no labels');
  const preprocessing = (await readJson<VisionPreprocessing>(absoluteDir, 'preprocessing.json', false)) ?? {};
  const contract = (await readJson<VisionContract>(absoluteDir, 'contract.json', false)) ?? {};
  const validation = await readJson<VisionValidation>(absoluteDir, 'validation.json', false);
  const task = taskOf(metadata, labelsFile, path.basename(dir));

  const modelPath = path.join(absoluteDir, 'model.onnx');
  const model = await readFile(modelPath).catch(() => null);
  if (!model) throw new ArtifactError('model.onnx is missing');
  const sha256 = createHash('sha256').update(model).digest('hex');

  // checksum.sha256 is "<hex>  model.onnx" (sha256sum format); metadata carries
  // the same value. Both are optional in principle, but when one is present it
  // must agree with the bytes on disk: a mismatch means a truncated copy or a
  // hand-edited artifact, and either would be a mystery at scan time instead.
  const sums = (await readFile(path.join(absoluteDir, 'checksum.sha256'), 'utf8').catch(() => null))?.trim().split(/\s+/)[0]?.toLowerCase();
  const declared = String(metadata.checksum_sha256 ?? sums ?? '').toLowerCase();
  if (declared && declared !== sha256) {
    throw new ArtifactError(`checksum mismatch: metadata says ${declared.slice(0, 12)}…, model.onnx hashes to ${sha256.slice(0, 12)}…`);
  }
  if (sums && sums !== sha256) {
    throw new ArtifactError(`checksum.sha256 says ${sums.slice(0, 12)}…, model.onnx hashes to ${sha256.slice(0, 12)}…`);
  }
  if (validation?.status === 'REJECTED') {
    throw new ArtifactError(`validation.json rejected this export${validation.problems?.length ? `: ${validation.problems.join('; ')}` : ''}`);
  }
  if (labelsFile?.index_offset !== undefined && labelsFile.index_offset !== (task === 'card-classifier' ? 0 : 2)) {
    throw new ArtifactError(`labels.json index_offset is ${labelsFile.index_offset}; ${task === 'card-classifier' ? 'a classifier needs 0' : 'an OCR reader needs 2 (0 = pad, 1 = blank)'}`);
  }

  const base: VisionArtifact = {
    task,
    dir,
    absoluteDir,
    metadata,
    labels: labelList,
    preprocessing,
    contract,
    validation: validation ?? null,
    sha256,
    inputName: String(metadata.input_spec?.name ?? 'images'),
    outputName: String(metadata.output_spec?.name ?? contract.outputs?.[0]?.name ?? 'logits'),
    indexOffset: task === 'card-classifier' ? 0 : 2,
    blankIndex: Number(contract.decoding?.blank_index ?? 1),
    padIndex: Number(contract.decoding?.pad_index ?? 0),
  };
  return task === 'card-classifier'
    ? { ...base, classifierSize: classifierSizeFrom(preprocessing) }
    : { ...base, lineSpec: lineSpecFrom(preprocessing) };
}

/** How deep discovery descends: an export is at most `<root>/exports/<task>/<version>`. */
const MAX_DEPTH = 3;

/** Is this directory shaped like a CardVault-Vision export (regardless of validity)? */
export async function looksLikeExport(absoluteDir: string): Promise<boolean> {
  const files = new Set(await readdir(absoluteDir).catch(() => []));
  return files.has('metadata.json') && files.has('model.onnx') && files.has('labels.json');
}

/**
 * What kind of model an `ocr_models.card` describes, from its own fields.
 *
 * A Vision pair carries `heads`, a single head carries `task`, a classifier says
 * so, and a legacy trainer model has nothing but a charset and an input size.
 * Reading the card rather than a column keeps the registry free of a migration
 * and lets a row written by an older version keep working.
 */
export type ModelKind = 'vision' | 'classifier' | 'trainer';

export function classifyModelCard(card: Record<string, unknown> | null | undefined): { kind: ModelKind; task?: string } {
  const c = card ?? {};
  if (c.task === 'card-classifier') return { kind: 'classifier', task: 'card-classifier' };
  if (c.kind === 'vision' || typeof c.heads === 'object' || c.task === 'name-ocr' || c.task === 'number-ocr' || c.task === 'ocr-pair') {
    return { kind: 'vision', ...(typeof c.task === 'string' ? { task: c.task } : {}) };
  }
  return { kind: 'trainer' };
}

/** A short, stable id for a verified artifact: `<task>-<version>`. */
export function artifactId(a: Pick<VisionArtifact, 'task' | 'metadata' | 'dir'>): string {
  const version = String(a.metadata.version ?? path.basename(a.dir));
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe(`${a.task}-${version}`);
}

/**
 * Find every export under a models root.
 *
 * Accepts both layouts CardVault-Vision writes:
 *  - registry layout: `<root>/<task>/<version>/` (with `<root>/registry.json`)
 *  - flattened:       `<root>/<task>-<version>/` or `<root>/<anything>/`
 * where every directory that carries metadata.json + model.onnx + labels.json
 * is one artifact. `<task>/production.json` and `registry.json` are skipped.
 * Also descends a single level into a copied `exports/` folder, so a whole
 * checkout can be pointed at without rearranging it.
 */
export async function discoverExports(root: string): Promise<{ artifacts: VisionArtifact[]; errors: { dir: string; error: string }[] }> {
  const artifacts: VisionArtifact[] = [];
  const errors: { dir: string; error: string }[] = [];
  const seen = new Set<string>();

  const consider = async (absoluteDir: string, relative: string): Promise<boolean> => {
    if (seen.has(absoluteDir)) return true;
    if (!(await looksLikeExport(absoluteDir))) return false;
    seen.add(absoluteDir);
    try {
      artifacts.push(await loadVisionArtifact(absoluteDir, relative));
    } catch (e) {
      errors.push({ dir: relative, error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  };

  const walk = async (absoluteDir: string, relative: string, depth: number) => {
    // an artifact is a leaf: nothing below a <task>/<version>/ is another model
    if (await consider(absoluteDir, relative)) return;
    // enough for `<root>/<task>/<version>` and one nesting (`<root>/exports/<task>/<version>`)
    if (depth >= MAX_DEPTH) return;
    for (const entry of await readdir(absoluteDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      await walk(path.join(absoluteDir, entry.name), relative ? `${relative}/${entry.name}` : entry.name, depth + 1);
    }
  };
  await walk(path.resolve(root), '', 0);
  // stable order: name, so OCR Lab's list does not jump around between scans
  artifacts.sort((a, b) => a.dir.localeCompare(b.dir));
  return { artifacts, errors };
}

// ------------------------------------------------------------------ decoding

/**
 * Softmax of one time step (in place into `out`), returned as probabilities.
 * CardVault-Vision exports raw logits: decoding them without this quietly reads
 * whichever class has the largest raw score as if it were a probability.
 */
export function softmax(logits: Float32Array | number[], offset: number, count: number, out = new Float32Array(count)): Float32Array {
  let max = -Infinity;
  for (let i = 0; i < count; i++) max = Math.max(max, logits[offset + i]!);
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const v = Math.exp(logits[offset + i]! - max);
    out[i] = v;
    sum += v;
  }
  for (let i = 0; i < count; i++) out[i] = out[i]! / sum;
  return out;
}

export interface CtcReading {
  text: string;
  /** 0..1: mean max-softmax probability over the collapsed, non-blank steps */
  confidence: number;
}

export interface CtcOptions {
  /** labels indexed as `class - indexOffset` */
  labels: string[];
  /** 2 for CardVault-Vision exports (0 pad, 1 blank) */
  indexOffset: number;
  blankIndex: number;
  padIndex: number;
  /** restrict the emitted characters (a collector number's alphabet) */
  allowed?: Set<string> | null;
}

/**
 * Greedy CTC decode of time-major logits `[T, C]` (CardVault-Vision's
 * `["time", "batch", num_classes"]` with batch 1).
 *
 * Rules from contract.json: softmax over the last axis, argmax per step,
 * collapse consecutive equal indices, drop blank/pad, then map class `i` to
 * `labels[i - indexOffset]`. A disallowed class (number spots) is skipped when
 * choosing each step's best class, exactly as Tesseract is given a whitelist.
 *
 * Confidence is the mean of the winning probability of each emitted character;
 * with nothing emitted it is the mean blank probability, so a confident "no
 * text here" and a baffled one are still distinguishable.
 */
export function decodeCtc(logits: Float32Array, T: number, C: number, opts: CtcOptions): CtcReading {
  const { labels, indexOffset, blankIndex, padIndex, allowed } = opts;
  const isDisallowed = (c: number) => {
    if (c === blankIndex || c === padIndex) return false;
    if (!allowed) return false;
    const label = labels[c - indexOffset];
    return label === undefined || !allowed.has(label);
  };
  const probs = new Float32Array(C);
  let text = '';
  let prev = -1;
  let confSum = 0;
  let emitted = 0;
  let blankSum = 0;
  let blanks = 0;
  for (let t = 0; t < T; t++) {
    softmax(logits, t * C, C, probs);
    let best = -1;
    let bestP = -Infinity;
    for (let c = 0; c < C; c++) {
      if (isDisallowed(c)) continue;
      const p = probs[c]!;
      if (p > bestP) (bestP = p), (best = c);
    }
    if (best < 0) continue;
    const isBlank = best === blankIndex || best === padIndex;
    if (isBlank) {
      blankSum += bestP;
      blanks++;
    } else if (best !== prev) {
      const label = labels[best - indexOffset];
      if (label !== undefined) text += label;
      confSum += bestP;
      emitted++;
    }
    // a repeated non-blank class is one glyph: CTC collapses the run, so the
    // step's probability is not a second reading and must not be counted twice
    prev = best;
  }
  const confidence = emitted ? confSum / emitted : blanks ? blankSum / blanks : 0;
  return { text: text.trim(), confidence: Math.round(confidence * 10000) / 10000 };
}

/** The classifier's answer for one card: argmax class and its softmax probability. */
export interface ClassGuess {
  label: string;
  confidence: number;
  /** every class with its probability, best first (for OCR Lab's detail view) */
  scores: { label: string; confidence: number }[];
}

/**
 * Decode classifier logits `[C]` (`contract.json`: softmax, argmax).
 * CardVault-Vision's own abstain rule is applied by the caller
 * (below 0.5 the card type is treated as UNKNOWN).
 */
export function decodeClassifier(logits: Float32Array, labels: string[]): ClassGuess {
  const C = labels.length;
  const probs = softmax(logits, 0, C);
  const scores = labels.map((label, i) => ({ label, confidence: Math.round(probs[i]! * 10000) / 10000 })).sort((a, b) => b.confidence - a.confidence);
  const top = scores[0] ?? { label: 'UNKNOWN', confidence: 0 };
  return { label: top.label, confidence: top.confidence, scores: scores.slice(0, 5) };
}

/** CardVault-Vision's abstain rule: below this, a card type is not committed to. */
export const CLASSIFIER_MIN_CONFIDENCE = 0.5;

/**
 * The game a classifier verdict routes to.
 *
 * `SPORTS` is a first-class type in the export (one physical layout) but
 * CardVault keeps per-sport games, so SPORTS falls back to a sports game that
 * has a layout; OTHER/UNKNOWN abstain.
 */
export const CLASS_TO_GAME: Record<string, string> = {
  POKEMON: 'pokemon',
  MAGIC_THE_GATHERING: 'magic',
  YU_GI_OH: 'yugioh',
  BASEBALL: 'baseball',
  FOOTBALL: 'football',
  BASKETBALL: 'basketball',
  HOCKEY: 'hockey',
};

/** A game slug (or 'sports') → the CardVault game it means, or null. */
export function gameForClass(label: string): string | null {
  const key = label.trim().toUpperCase();
  if (CLASS_TO_GAME[key]) return CLASS_TO_GAME[key]!;
  if (key === 'SPORTS') return 'baseball';
  return null;
}
