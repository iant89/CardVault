export const dayStamp = (d = new Date()) => {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
};
export const toNum = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
/** Escape a value for a Lucene-ish query string. */
export const q = (s: string) => s.replace(/["\\]/g, '').trim();
export const isoDate = (s: string | undefined | null) => (s ? s.replace(/\//g, '-').slice(0, 10) : null);
