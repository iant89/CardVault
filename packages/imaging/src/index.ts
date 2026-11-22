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
