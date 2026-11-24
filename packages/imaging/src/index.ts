import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ALLOWED_INPUT_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif', 'avif']);
export const MAX_PIXELS = 40_000_000;

export class ImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageValidationError';
  }
}

export interface NormalizedImage {
  buffer: Buffer;
  width: number;
  height: number;
  mimeType: 'image/jpeg';
  sha256: string;
  dhash: string;
  quality: ImageQuality;
}

export interface ImageQuality {
  /** variance of Laplacian proxy; low => blurry */
  sharpness: number;
  /** mean luminance 0..255 */
  brightness: number;
  /** fraction of near-white blown-out pixels (glare) */
  glare: number;
  blurry: boolean;
  tooDark: boolean;
  tooBright: boolean;
  hasGlare: boolean;
}

/**
 * Validate by decoding (not by trusting the client MIME type), auto-rotate
 * from EXIF, strip metadata, cap the size and re-encode to JPEG.
 */
export async function normalizeUpload(input: Buffer, maxEdge = 1600): Promise<NormalizedImage> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw new ImageValidationError('File is not a readable image');
  }
  if (!meta.format || !ALLOWED_INPUT_FORMATS.has(meta.format)) {
    throw new ImageValidationError(`Unsupported image format: ${meta.format ?? 'unknown'}`);
  }
  if ((meta.width ?? 0) < 200 || (meta.height ?? 0) < 200) throw new ImageValidationError('Image too small (min 200px)');

  const { data, info } = await sharp(input, { limitInputPixels: MAX_PIXELS })
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: data,
    width: info.width,
    height: info.height,
    mimeType: 'image/jpeg',
    sha256: createHash('sha256').update(data).digest('hex'),
    dhash: await dhash(data),
    quality: await assessQuality(data),
  };
}

export const HASH_BITS = 256;
const HASH_SIDE = 16;

/** 256-bit difference hash (16×16 gradient grid), returned as 64 hex chars. */
export async function dhash(input: Buffer): Promise<string> {
  const W = HASH_SIDE + 1;
  const { data } = await sharp(input).grayscale().resize(W, HASH_SIDE, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let bits = 0n;
  for (let y = 0; y < HASH_SIDE; y++) {
    for (let x = 0; x < HASH_SIDE; x++) {
      bits = (bits << 1n) | (data[y * W + x]! > data[y * W + x + 1]! ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(HASH_BITS / 4, '0');
}

export function hammingDistance(a: string, b: string): number {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/** 0..1 similarity from two dHashes. */
export const hashSimilarity = (a: string, b: string) => (a.length !== b.length ? 0 : 1 - hammingDistance(a, b) / (a.length * 4));

export async function assessQuality(input: Buffer): Promise<ImageQuality> {
  const { data, info } = await sharp(input).grayscale().resize(400, 400, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i]!;
  const brightness = sum / data.length;
  // glare = pixels clipped in *every* channel (white card stock keeps a colour cast)
  const rgb = await sharp(input).removeAlpha().resize(400, 400, { fit: 'inside' }).raw().toBuffer();
  let blown = 0;
  for (let i = 0; i < rgb.length; i += 3) if (Math.min(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!) >= 252) blown++;
  // Laplacian variance
  let lsum = 0;
  let lsq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * data[i]! - data[i - 1]! - data[i + 1]! - data[i - w]! - data[i + w]!;
      lsum += lap;
      lsq += lap * lap;
      n++;
    }
  }
  const mean = lsum / n;
  const sharpness = Math.round(lsq / n - mean * mean);
  const glare = blown / (rgb.length / 3);
  return {
    sharpness,
    brightness: Math.round(brightness),
    glare: Math.round(glare * 1000) / 1000,
    blurry: sharpness < 60,
    tooDark: brightness < 50,
    tooBright: brightness > 225,
    hasGlare: glare > 0.06,
  };
}

export async function makeThumbnail(input: Buffer, width = 300): Promise<Buffer> {
  return sharp(input).resize({ width, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
}

/** Preprocess for OCR: grayscale, upscale, normalize contrast, sharpen. */
export async function prepareForOcr(input: Buffer, region?: { top: number; height: number; left?: number; width?: number }): Promise<Buffer> {
  let img = sharp(input);
  if (region) {
    const m = await img.metadata();
    const H = m.height ?? 0, W = m.width ?? 0;
    const left = Math.round(W * (region.left ?? 0));
    const top = Math.round(H * region.top);
    img = sharp(input).extract({
      left,
      top,
      width: Math.max(1, Math.min(W - left, Math.round(W * (region.width ?? 1)))),
      height: Math.max(1, Math.min(H - top, Math.round(H * region.height))),
    });
  }
  return img.grayscale().resize({ width: 1400, withoutEnlargement: false }).normalize().sharpen().png().toBuffer();
}

export interface CardRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Re-encode an image as a plain JPEG (datasets, exports: no metadata, no alpha). */
export async function toJpeg(input: Buffer, quality = 92): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(input).rotate().jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Cut a region (fractions of the card) out of an image, at its original resolution, as PNG. */
export async function cropRegion(input: Buffer, region: CardRegion): Promise<Buffer> {
  const m = await sharp(input).metadata();
  const W = m.width ?? 0, H = m.height ?? 0;
  const left = Math.min(W - 1, Math.round(W * region.left));
  const top = Math.min(H - 1, Math.round(H * region.top));
  return sharp(input)
    .extract({
      left,
      top,
      width: Math.max(1, Math.min(W - left, Math.round(W * region.width))),
      height: Math.max(1, Math.min(H - top, Math.round(H * region.height))),
    })
    .png()
    .toBuffer();
}

/**
 * A cropped text line made ready for OCR: grayscale, scaled so the line is
 * ~`targetHeight` px tall, contrast stretched. Measured on rendered cards:
 * plain grayscale with no added margin reads best; a white margin (a hard
 * frame around the grey card stock) and adaptive thresholding (breaks up
 * small digits) both made numbers unreadable.
 */
export async function prepareLine(crop: Buffer, targetHeight = 110): Promise<Buffer> {
  return sharp(crop).grayscale().resize({ height: targetHeight, kernel: 'lanczos3' }).normalize().png().toBuffer();
}

/** Input height of the trained line reader (tools/ocr-trainer uses the same). */
export const LINE_HEIGHT = 32;
/** Width limits of the trained line reader. */
export const LINE_MIN_WIDTH = 8;
export const LINE_MAX_WIDTH = 512;

/**
 * The input contract a line-reader artifact declares for itself
 * (`preprocessing.json` of a CardVault-Vision export, or `card.input` of a
 * tools/ocr-trainer model card). Everything that turns a crop into a tensor
 * reads it from here, so a model's declared contract is what runs.
 */
export interface LineTensorSpec {
  /** fixed input height in px (32 for both trainers) */
  height: number;
  /** smallest width a very narrow crop is padded up to */
  minWidth: number;
  /** largest width a very long line is squeezed down to */
  maxWidth: number;
  /** value range of the pixels sent to the model */
  range: 'unit' | 'signed';
  /** send the inverted line (light glyphs on dark paper) instead */
  invert?: boolean;
}

/** tools/ocr-trainer: 32px tall, 8..512 wide, pixels in [-1, 1]. */
export const TRAINER_LINE_SPEC: LineTensorSpec = { height: LINE_HEIGHT, minWidth: LINE_MIN_WIDTH, maxWidth: LINE_MAX_WIDTH, range: 'signed' };
/** CardVault-Vision: 32px tall, 32..1600 wide, pixels in [0, 1]. */
export const VISION_LINE_SPEC: LineTensorSpec = { height: 32, minWidth: 32, maxWidth: 1600, range: 'unit' };

/**
 * A text line as a trained reader's input: grayscale, `spec.height` px tall,
 * width scaled to keep the aspect ratio (clamped to the spec's range),
 * row-major, one channel. The default spec is tools/ocr-trainer's.
 */
export async function lineTensor(
  crop: Buffer,
  spec: LineTensorSpec = TRAINER_LINE_SPEC,
): Promise<{ data: Float32Array; width: number; height: number }> {
  const m = await sharp(crop).metadata();
  const h = spec.height;
  const width = Math.max(spec.minWidth, Math.min(spec.maxWidth, Math.round(((m.width ?? 1) * h) / Math.max(1, m.height ?? 1))));
  const raw = await sharp(crop).removeAlpha().grayscale().resize(width, h, { fit: 'fill', kernel: 'linear' }).raw().toBuffer();
  const data = new Float32Array(width * h);
  const scale = 255;
  for (let i = 0; i < data.length; i++) {
    const v = raw[i]! / scale;
    data[i] = spec.range === 'unit' ? v : v * 2 - 1;
  }
  if (spec.invert) for (let i = 0; i < data.length; i++) data[i] = 1 - data[i]!;
  return { data, width, height: h };
}

/** Input size of the whole-card game classifier (CardVault-Vision card-type-cnn). */
export const CLASSIFIER_SIZE = 160;

/**
 * A whole card as the game classifier's input: RGB, `size`×`size` (aspect ratio
 * deliberately squashed, as in training), NCHW float32 in [0, 1].
 */
export async function classifierTensor(card: Buffer, size = CLASSIFIER_SIZE): Promise<{ data: Float32Array; size: number }> {
  const raw = await sharp(card).removeAlpha().resize(size, size, { fit: 'fill', kernel: 'linear' }).raw().toBuffer();
  const plane = size * size;
  const data = new Float32Array(plane * 3);
  for (let i = 0, p = 0; i < raw.length; i += 3, p++) {
    data[p] = raw[i]! / 255;
    data[plane + p] = raw[i + 1]! / 255;
    data[plane * 2 + p] = raw[i + 2]! / 255;
  }
  return { data, size };
}

/** One region of a card made ready for OCR (crop + prepareLine). */
export async function prepareOcrRegion(input: Buffer, region: CardRegion, targetHeight = 110): Promise<Buffer> {
  return prepareLine(await cropRegion(input, region), targetHeight);
}

/**
 * Make a clean official card image look like a scanner capture: rescaled to a
 * camera-like card width, softened, JPEG-compressed, then stored at the
 * scanner's 750px width. `seed` makes it repeatable per card.
 */
export async function simulateCapture(input: Buffer, seed: number): Promise<{ image: Buffer; cameraWidth: number }> {
  const cameraWidth = 520 + (seed % 380);
  const cam = await sharp(input)
    .flatten({ background: '#808080' })
    .resize({ width: cameraWidth })
    .blur(0.4 + ((seed >>> 8) % 7) / 10)
    .jpeg({ quality: 70 + ((seed >>> 12) % 20) })
    .toBuffer();
  const image = await sharp(cam).resize(750, 1047, { fit: 'fill' }).jpeg({ quality: 90 }).toBuffer();
  return { image, cameraWidth };
}

export async function writeFileSafe(root: string, relative: string, data: Buffer): Promise<string> {
  const abs = path.resolve(root, relative);
  if (!abs.startsWith(path.resolve(root) + path.sep)) throw new Error('Path escapes storage root');
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, data);
  return relative;
}

export function resolveStoragePath(root: string, relative: string): string {
  const abs = path.resolve(root, relative);
  if (!abs.startsWith(path.resolve(root) + path.sep)) throw new Error('Path escapes storage root');
  return abs;
}
