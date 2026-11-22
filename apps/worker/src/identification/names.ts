import { normalizeText, similarity } from '@cardvault/shared';

export interface NameMatch {
  name: string;
  score: number;
}

const grams = (s: string): string[] => {
  const p = ` ${s} `;
  const out: string[] = [];
  for (let i = 0; i + 3 <= p.length; i++) out.push(p.slice(i, i + 3));
  return out;
};

/**
 * Every known card name for a game, for correcting OCR. Lookups go through a
 * trigram index (tens of thousands of names), then edit distance on the few
 * best candidates. Handles letter misreads ("Nidorand" → "Nidoran♂") and
 * junk glued to the name ("JPorygoniiie" → "Porygon").
 */
export class NameIndex {
  private readonly names: string[] = [];
  private readonly norms: string[] = [];
  private readonly byGram = new Map<string, number[]>();
  private readonly exact = new Map<string, number>();

  constructor(names: Iterable<string>) {
    for (const name of names) {
      const n = normalizeText(name);
      if (n.length < 3 || this.exact.has(n)) continue;
      const id = this.names.length;
      this.names.push(name);
      this.norms.push(n);
      this.exact.set(n, id);
      for (const g of new Set(grams(n))) {
        const list = this.byGram.get(g);
        if (list) list.push(id);
        else this.byGram.set(g, [id]);
      }
    }
  }

  get size(): number {
    return this.names.length;
  }

  /** Closest known name to an OCR'd phrase, or null when none is close enough. */
  lookup(phrase: string): NameMatch | null {
    const q = normalizeText(phrase);
    if (q.length < 3) return null;
    const hit = this.exact.get(q);
    if (hit !== undefined) return { name: this.names[hit]!, score: 1 };
    // candidates sharing the most trigrams with the phrase
    const counts = new Map<number, number>();
    for (const g of new Set(grams(q))) for (const id of this.byGram.get(g) ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
    let best: NameMatch | null = null;
    for (const [id] of top) {
      const n = this.norms[id]!;
      let score = similarity(q, n);
      // the whole name appears inside the phrase, with junk around it
      if (n.length >= 5 && q.includes(n)) score = Math.max(score, 0.9);
      // longer names win near-ties ("Buzzwole ex" over "Buzzwole" when "ex" was read)
      if (!best || score > best.score + 0.01 || (Math.abs(score - best.score) <= 0.01 && n.length > normalizeText(best.name).length)) {
        best = { name: this.names[id]!, score };
      }
    }
    // short names need a closer match: one wrong letter in "Mew" is a third of it
    const need = q.length <= 4 ? 0.75 : 0.8;
    return best && best.score >= need ? best : null;
  }

  /**
   * Best known names found in OCR lines: each line, and each run of up to
   * four words in it, is looked up. Ordered by score, then by line order.
   */
  correct(lines: string[], max = 4): NameMatch[] {
    const found = new Map<string, NameMatch & { order: number }>();
    let order = 0;
    for (const line of lines) {
      const words = line.split(/\s+/).filter(Boolean);
      const phrases = new Set<string>([line]);
      for (let len = Math.min(4, words.length); len >= 1; len--) {
        for (let i = 0; i + len <= words.length; i++) phrases.add(words.slice(i, i + len).join(' '));
      }
      for (const p of phrases) {
        const m = this.lookup(p);
        if (!m) continue;
        const cur = found.get(m.name);
        if (!cur || m.score > cur.score) found.set(m.name, { ...m, order: cur?.order ?? order++ });
      }
    }
    return [...found.values()]
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, max)
      .map(({ name, score }) => ({ name, score }));
  }
}
