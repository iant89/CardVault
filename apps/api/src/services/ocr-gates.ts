/**
 * Promotion gates: a candidate engine may replace the current one only if,
 * scored on the SAME frozen exam version, it is at least as good overall, no
 * part of the exam gets noticeably worse, it keeps every human-fixed misread
 * fixed, it stays fast, and its confidence can be trusted.
 */

export interface SliceLike {
  slice: string;
  n: number;
  accuracy: number;
  confidentAccuracy: number | null;
  confident: number;
}

export interface EvalLike {
  id: string;
  engine: string;
  examVersion: number | null;
  status: string;
  summary: { msPerLine?: number | null };
  slices: SliceLike[];
}

export interface Gate {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

/** Overall accuracy may not drop at all (half a point of noise allowed). */
export const OVERALL_TOLERANCE = 0.005;
/** No slice with at least SLICE_MIN_N items may lose more than this. */
export const SLICE_TOLERANCE = 0.02;
export const SLICE_MIN_N = 20;
/** When an engine says it's ≥90% sure, it must be right this often (given enough such reads). */
export const CONFIDENT_FLOOR = 0.95;
export const CONFIDENT_MIN_N = 20;

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const find = (e: EvalLike, slice: string) => e.slices.find((s) => s.slice === slice);

export function gates(candidate: EvalLike, champion: EvalLike | null): Gate[] {
  const out: Gate[] = [];
  if (candidate.status !== 'done') return [{ id: 'scored', label: 'Scored on the current exam', pass: false, detail: 'Score it first.' }];
  if (!champion) {
    return [{ id: 'baseline', label: 'Current engine scored on the same exam', pass: false, detail: 'Score the current engine on this exam version first, so there is something to compare with.' }];
  }
  if (champion.examVersion !== candidate.examVersion) {
    return [{ id: 'same-exam', label: 'Same exam version', pass: false, detail: `Candidate scored on v${candidate.examVersion}, current engine on v${champion.examVersion}. Score both on the same version.` }];
  }

  for (const field of ['name', 'number'] as const) {
    const c = find(candidate, `all · ${field}`), b = find(champion, `all · ${field}`);
    if (!b || !c) continue;
    out.push({
      id: `overall-${field}`,
      label: `${field === 'name' ? 'Names' : 'Numbers'}: at least as accurate overall`,
      pass: c.accuracy >= b.accuracy - OVERALL_TOLERANCE,
      detail: `${pct(c.accuracy)} vs ${pct(b.accuracy)} now`,
    });
  }

  const drops = candidate.slices
    .filter((c) => !c.slice.startsWith('regression') && !c.slice.startsWith('all ·'))
    .map((c) => ({ c, b: find(champion, c.slice) }))
    .filter(({ c, b }) => b && c.n >= SLICE_MIN_N && b.n >= SLICE_MIN_N && c.accuracy < b.accuracy - SLICE_TOLERANCE);
  out.push({
    id: 'slices',
    label: 'No part of the exam gets worse',
    pass: drops.length === 0,
    detail: drops.length ? drops.map(({ c, b }) => `${c.slice}: ${pct(c.accuracy)} vs ${pct(b!.accuracy)}`).join('; ') : `every slice with ${SLICE_MIN_N}+ items within ${pct(SLICE_TOLERANCE)}`,
  });

  for (const field of ['name', 'number'] as const) {
    const c = find(candidate, `regression set · ${field}`), b = find(champion, `regression set · ${field}`);
    if (!c && !b) continue;
    out.push({
      id: `regression-${field}`,
      label: `${field === 'name' ? 'Names' : 'Numbers'}: fixed misreads stay fixed`,
      pass: (c?.accuracy ?? 0) >= (b?.accuracy ?? 0),
      detail: `${pct(c?.accuracy ?? 0)} of ${c?.n ?? 0} vs ${pct(b?.accuracy ?? 0)} now`,
    });
  }

  const cs = candidate.summary.msPerLine, bs = champion.summary.msPerLine;
  if (cs != null && bs != null) {
    const limit = Math.max(1.5 * bs, 50);
    out.push({ id: 'speed', label: 'Fast enough', pass: cs <= limit, detail: `${cs} ms per line (limit ${Math.round(limit)})` });
  }

  for (const field of ['name', 'number'] as const) {
    const c = find(candidate, `all · ${field}`);
    if (!c || c.confident < CONFIDENT_MIN_N || c.confidentAccuracy == null) continue;
    out.push({
      id: `confidence-${field}`,
      label: `${field === 'name' ? 'Names' : 'Numbers'}: confident reads are right`,
      pass: c.confidentAccuracy >= CONFIDENT_FLOOR,
      detail: `${pct(c.confidentAccuracy)} of ${c.confident} reads it was ≥90% sure of (needs ${pct(CONFIDENT_FLOOR)})`,
    });
  }
  return out;
}
