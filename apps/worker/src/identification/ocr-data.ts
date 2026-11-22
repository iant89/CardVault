import { levenshtein, normalizeText, type SignalScore } from '@cardvault/shared';
import { extractSignals, trimDebris } from './extract.js';

/**
 * Rules for turning scans into trustworthy OCR training and exam data, and
 * the scoring used by the exam. Kept free of I/O so each rule is testable.
 */

export type LabelSource = 'pending' | 'review' | 'corroborated' | 'self' | 'harvest' | 'excluded';

/** Label sources an exam or training set may use. `self` never: the engine would be grading itself. */
export const TRUSTED_SOURCES: LabelSource[] = ['review', 'corroborated', 'harvest'];

/** Share of cards whose samples go to the exam side (fixed per card, so never on both sides). */
export const EXAM_PERCENT = 20;

/** 32-bit FNV-1a: a stable hash for splitting and ordering. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** train or exam, decided by the card (not the scan): rescans of one card stay on one side. */
export function splitFor(cardKey: string, percent = EXAM_PERCENT): 'exam' | 'train' {
  return fnv1a(`split:${cardKey}`) % 100 < percent ? 'exam' : 'train';
}

/**
 * How far an automatic identification vouches for a line's label. A label
 * counts as corroborated only when evidence that does not come from reading
 * that very line picked the card:
 *  - name: the collector number matched exactly, or the picture matched strongly
 *  - number: the picture matched strongly (a name alone fits many printings)
 */
export function autoLabelSource(field: 'name' | 'number', signals: SignalScore[]): 'corroborated' | 'self' {
  const score = (name: string) => signals.find((s) => s.signal === name)?.score ?? 0;
  const image = score('image.hash') >= 0.85;
  if (field === 'name') return score('ocr.number') >= 1 || image ? 'corroborated' : 'self';
  return image ? 'corroborated' : 'self';
}

/** Normalized form a name is scored on. */
export const nameNorm = (s: string) => normalizeText(s);

/** What an engine's raw title reading counts as: debris trimmed, normalized. */
export function namePrediction(text: string): string {
  const lines = text.split('\n').map((l) => trimDebris(l.replace(/[^\p{L}\p{N}'’\-., &:]/gu, ' ').replace(/\s+/g, ' ').trim())).filter(Boolean);
  return nameNorm(lines[0] ?? '');
}

/** The collector number found in a number-spot reading (normalized and as printed), or null. */
export function numberPrediction(text: string, game: string): { norm: string; raw: string } | null {
  const n = extractSignals({ top: '', full: '', bottom: text }, game).numbers[0];
  return n ? { norm: n.norm, raw: n.raw } : null;
}

/** Character error rate: edit distance over label length (0 = perfect). */
export function cer(predicted: string, label: string): number {
  if (!label.length) return predicted.length ? 1 : 0;
  return Math.min(1, levenshtein(predicted, label) / label.length);
}

/** Release-era bucket for slicing results (card designs and fonts change by era). */
export function eraOf(releaseDate: string | null | undefined): string {
  const y = Number(String(releaseDate ?? '').slice(0, 4));
  if (!y) return 'unknown';
  if (y <= 2010) return '≤2010';
  if (y <= 2016) return '2011–2016';
  if (y <= 2019) return '2017–2019';
  if (y <= 2022) return '2020–2022';
  return '2023+';
}

export interface ScoredItem {
  field: 'name' | 'number';
  game: string;
  source: string;
  era: string;
  correct: boolean;
  /** correct after the card-name dictionary (names only) */
  correctWithDictionary?: boolean;
  cer: number;
  confidence: number;
  regression: boolean;
  exam: boolean;
}

export interface SliceMetrics {
  slice: string;
  n: number;
  accuracy: number;
  accuracyWithDictionary?: number;
  cer: number;
  /** accuracy of the readings the engine was ≥90% sure of, and how many there were */
  confidentAccuracy: number | null;
  confident: number;
  /** expected calibration error over 5 confidence bins (0 = confidence matches accuracy) */
  calibrationError: number;
}

export function metrics(slice: string, items: ScoredItem[]): SliceMetrics {
  const n = items.length;
  const mean = (f: (x: ScoredItem) => number) => (n ? items.reduce((a, x) => a + f(x), 0) / n : 0);
  const confident = items.filter((x) => x.confidence >= 0.9);
  const dict = items.filter((x) => x.correctWithDictionary !== undefined);
  let ece = 0;
  for (let b = 0; b < 5; b++) {
    const bin = items.filter((x) => Math.min(4, Math.floor(x.confidence * 5)) === b);
    if (!bin.length) continue;
    const acc = bin.filter((x) => x.correct).length / bin.length;
    const conf = bin.reduce((a, x) => a + x.confidence, 0) / bin.length;
    ece += (bin.length / n) * Math.abs(acc - conf);
  }
  const round = (v: number) => Math.round(v * 10000) / 10000;
  return {
    slice,
    n,
    accuracy: round(mean((x) => (x.correct ? 1 : 0))),
    ...(dict.length ? { accuracyWithDictionary: round(dict.filter((x) => x.correctWithDictionary).length / dict.length) } : {}),
    cer: round(mean((x) => x.cer)),
    confidentAccuracy: confident.length ? round(confident.filter((x) => x.correct).length / confident.length) : null,
    confident: confident.length,
    calibrationError: round(ece),
  };
}

/** Results broken down so a gain in one place can't hide a loss in another. */
export function sliceReport(items: ScoredItem[]): SliceMetrics[] {
  const exam = items.filter((x) => x.exam);
  const out: SliceMetrics[] = [];
  const groups = new Map<string, ScoredItem[]>();
  const add = (k: string, x: ScoredItem) => (groups.get(k) ?? groups.set(k, []).get(k)!).push(x);
  for (const x of exam) {
    add(`all · ${x.field}`, x);
    add(`game ${x.game} · ${x.field}`, x);
    add(`source ${x.source} · ${x.field}`, x);
    add(`era ${x.era} · ${x.field}`, x);
  }
  for (const x of items.filter((i) => i.regression)) add(`regression set · ${x.field}`, x);
  for (const [k, v] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) out.push(metrics(k, v));
  return out;
}

// ------------------------------------------------------------------ live trial & live watch

/** One scored unit (a title line, or a scan's number spots) from live scans. */
export interface LiveUnit {
  field: 'name' | 'number';
  /** the live engine read it correctly */
  live: boolean;
  /** the trial model read it correctly (trial only) */
  shadow?: boolean;
}

export interface TrialStats {
  lines: number;
  liveAccuracy: number | null;
  shadowAccuracy: number | null;
  /** the trial model right where the live engine was wrong */
  wins: number;
  /** the trial model wrong where the live engine was right */
  losses: number;
  byField: Record<string, { lines: number; live: number | null; shadow: number | null }>;
}

const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 10000) / 10000 : null);

/** Compare live and trial readings on the same labelled lines. */
export function compareTrial(units: LiveUnit[]): TrialStats {
  const u = units.filter((x) => x.shadow !== undefined);
  const byField: TrialStats['byField'] = {};
  for (const f of ['name', 'number'] as const) {
    const g = u.filter((x) => x.field === f);
    byField[f] = { lines: g.length, live: ratio(g.filter((x) => x.live).length, g.length), shadow: ratio(g.filter((x) => x.shadow).length, g.length) };
  }
  return {
    lines: u.length,
    liveAccuracy: ratio(u.filter((x) => x.live).length, u.length),
    shadowAccuracy: ratio(u.filter((x) => x.shadow).length, u.length),
    wins: u.filter((x) => x.shadow && !x.live).length,
    losses: u.filter((x) => !x.shadow && x.live).length,
    byField,
  };
}

export interface WatchWindow {
  /** labelled lines read by the engine in this window, and how many it got right */
  lines: number;
  correct: number;
  /** scans in this window, and how many needed manual review */
  scans: number;
  reviewed: number;
}

export interface WatchRules {
  minLines: number;
  minScans: number;
  /** roll back if line accuracy falls by more than this (0.05 = 5 points) */
  maxAccuracyDrop: number;
  /** roll back if the share of scans needing manual review rises by more than this */
  maxReviewRise: number;
}

export const DEFAULT_WATCH: WatchRules = { minLines: 30, minScans: 20, maxAccuracyDrop: 0.05, maxReviewRise: 0.15 };

/**
 * Should an active model be rolled back? Compares its live results since
 * promotion with the previous engine's in the same length of time before it.
 * Only judges once both windows hold enough data; never on a handful of scans.
 */
export function rollbackDecision(after: WatchWindow, before: WatchWindow, rules: WatchRules = DEFAULT_WATCH): { rollback: boolean; reasons: string[]; judged: string[] } {
  const reasons: string[] = [];
  const judged: string[] = [];
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  if (after.lines >= rules.minLines && before.lines >= rules.minLines) {
    judged.push('accuracy');
    const a = after.correct / after.lines, b = before.correct / before.lines;
    if (a < b - rules.maxAccuracyDrop) reasons.push(`live reading accuracy fell to ${pct(a)} from ${pct(b)} (${after.lines} vs ${before.lines} confirmed lines)`);
  }
  if (after.scans >= rules.minScans && before.scans >= rules.minScans) {
    judged.push('reviews');
    const a = after.reviewed / after.scans, b = before.reviewed / before.scans;
    if (a > b + rules.maxReviewRise) reasons.push(`scans needing manual review rose to ${pct(a)} from ${pct(b)} (${after.scans} vs ${before.scans} scans)`);
  }
  return { rollback: reasons.length > 0, reasons, judged };
}
