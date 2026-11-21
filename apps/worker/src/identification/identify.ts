import { sql } from '@cardvault/database';
import { combineSignals, similarity, normalizeText, type GameSlug, type SignalScore } from '@cardvault/shared';
import { hashSimilarity } from '@cardvault/imaging';
import type { WorkerContext } from '../context.js';
import { upsertCatalogCard } from '../catalog.js';
import type { ExtractedSignals } from './extract.js';

export interface Candidate {
  cardId: string;
  name: string;
  game: string;
  collectorNumberNorm: string;
  setTotal: number | null;
  imageHash: string | null;
  sources: Set<string>;
}

export interface ScoredCandidate {
  cardId: string;
  name: string;
  game: string;
  confidence: number;
  signals: SignalScore[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toCand = (r: any, source: string): Candidate => ({
  cardId: String(r.id),
  name: String(r.name),
  game: String(r.game),
  collectorNumberNorm: String(r.collector_number_norm ?? ''),
  setTotal: r.total_cards == null ? null : Number(r.total_cards),
  imageHash: (r.image_hash as string) ?? null,
  sources: new Set([source]),
});

const COLS = sql`c.id, c.name, c.collector_number_norm, c.image_hash, g.slug AS game, s.total_cards`;
const FROM = sql`FROM cards c JOIN games g ON g.id = c.game_id LEFT JOIN sets s ON s.id = c.set_id`;

/** Gather candidates from the LOCAL catalog first (no internet for basic identity). */
export async function localCandidates(ctx: WorkerContext, sig: ExtractedSignals, dhash: string | null, game: GameSlug | null) {
  const map = new Map<string, Candidate>();
  const add = (rows: readonly Record<string, unknown>[], src: string) => {
    for (const r of rows) {
      const c = map.get(String(r.id));
      if (c) c.sources.add(src);
      else map.set(String(r.id), toCand(r, src));
    }
  };
  const gameFilter = game ? sql`AND g.slug = ${game}` : sql``;

  for (const n of sig.numbers) {
    add(await ctx.db.execute(sql`SELECT ${COLS} ${FROM} WHERE c.collector_number_norm = ${n.norm} ${gameFilter} LIMIT 40`), 'number');
  }
  for (const name of sig.nameCandidates.slice(0, 4)) {
    add(
      await ctx.db.execute(sql`SELECT ${COLS} ${FROM} WHERE similarity(c.name, ${name}) > 0.3 ${gameFilter} ORDER BY similarity(c.name, ${name}) DESC LIMIT 15`),
      'name',
    );
  }
  if (dhash) {
    add(
      await ctx.db.execute(sql`
        SELECT ${COLS} ${FROM} WHERE length(c.image_hash) = 64 ${gameFilter}
          AND bit_count(('x' || c.image_hash)::bit(256) # ('x' || ${dhash})::bit(256)) <= 64
        ORDER BY bit_count(('x' || c.image_hash)::bit(256) # ('x' || ${dhash})::bit(256)) LIMIT 10`),
      'image',
    );
  }
  return map;
}

/** Ask identity providers (catalog APIs) and import their results into the local catalog. */
export async function remoteCandidates(ctx: WorkerContext, sig: ExtractedSignals, games: GameSlug[], into: Map<string, Candidate>) {
  for (const game of games) {
    for (const { provider, ctx: pctx } of ctx.providers.forGame(game, 'search')) {
      for (const name of sig.nameCandidates.slice(0, 2)) {
        try {
          const results = await provider.search({ game, name, collectorNumber: sig.numbers[0]?.raw, limit: 8 }, pctx);
          for (const r of results.slice(0, 8)) {
            const id = await upsertCatalogCard(ctx, r.card);
            const rows = await ctx.db.execute(sql`SELECT ${COLS} ${FROM} WHERE c.id = ${id}`);
            const c = into.get(id);
            if (c) c.sources.add(provider.id);
            else if (rows[0]) into.set(id, toCand(rows[0], provider.id));
          }
          if (results.length) break;
        } catch (e) {
          ctx.log.warn({ provider: provider.id, err: (e as Error).message }, 'provider search failed');
        }
      }
      if ([...into.values()].some((c) => c.game === game)) break; // first provider with hits wins
    }
  }
}

export function scoreCandidates(cands: Iterable<Candidate>, sig: ExtractedSignals, ocrText: string, dhash: string | null): ScoredCandidate[] {
  const text = normalizeText(ocrText);
  const out: ScoredCandidate[] = [];
  for (const c of cands) {
    const signals: SignalScore[] = [];
    const nameSim = Math.max(0, ...sig.nameCandidates.map((n) => similarity(n, c.name)));
    const inText = text.includes(normalizeText(c.name)) ? 0.95 : 0;
    const name = Math.max(nameSim, inText);
    signals.push({ signal: 'ocr.name', score: name, weight: 3 });

    if (sig.numbers.length) {
      const exact = sig.numbers.find((n) => n.norm === c.collectorNumberNorm);
      let num = exact ? 1 : 0;
      if (exact && exact.total && c.setTotal && Number(exact.total) !== c.setTotal) num = 0.7; // same number, different set
      signals.push({ signal: 'ocr.number', score: num, weight: 3 });
    }
    if (dhash && c.imageHash) signals.push({ signal: 'image.hash', score: Math.max(0, (hashSimilarity(dhash, c.imageHash) - 0.5) * 2), weight: 2 });
    const g = sig.gameGuesses.find((x) => x.game === c.game);
    if (g && g.score > 0) signals.push({ signal: 'ocr.game', score: g.score, weight: 1 });

    out.push({ cardId: c.cardId, name: c.name, game: c.game, confidence: combineSignals(signals), signals });
  }
  out.sort((a, b) => b.confidence - a.confidence);
  // ambiguity penalty: two near-equal top candidates (e.g. reprints) need a human
  if (out.length > 1 && out[0]!.confidence - out[1]!.confidence < 0.03) out[0]!.confidence = Math.min(out[0]!.confidence, 0.94);
  return out;
}
