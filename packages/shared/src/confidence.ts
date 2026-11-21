/** Confidence thresholds (0..1). */
export const CONFIDENCE = {
  AUTO_ACCEPT: 0.95,
  VERIFY: 0.8,
} as const;

export type ConfidenceDecision = 'AUTO_ACCEPT' | 'VERIFY' | 'MANUAL';

export function decideConfidence(confidence: number): ConfidenceDecision {
  if (confidence >= CONFIDENCE.AUTO_ACCEPT) return 'AUTO_ACCEPT';
  if (confidence >= CONFIDENCE.VERIFY) return 'VERIFY';
  return 'MANUAL';
}

export interface SignalScore {
  /** signal name e.g. "ocr.name", "ocr.number", "image.hash" */
  signal: string;
  /** 0..1 match strength for this signal */
  score: number;
  /** relative importance */
  weight: number;
}

/**
 * Combine independent identification signals into a single confidence.
 * Weighted mean of present signals, with an agreement bonus when several
 * strong signals concur and a penalty when only one weak signal exists.
 */
export function combineSignals(signals: SignalScore[]): number {
  const present = signals.filter((s) => s.weight > 0);
  if (present.length === 0) return 0;
  const totalWeight = present.reduce((a, s) => a + s.weight, 0);
  let conf = present.reduce((a, s) => a + s.score * s.weight, 0) / totalWeight;
  const strong = present.filter((s) => s.score >= 0.9).length;
  if (strong >= 3) conf = conf + (1 - conf) * 0.6;
  else if (strong === 2) conf = conf + (1 - conf) * 0.35;
  if (present.length === 1) conf *= 0.85;
  return Math.max(0, Math.min(1, conf));
}
