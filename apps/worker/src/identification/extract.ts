import { GAME_MODULES, guessGameFromText } from '@cardvault/card-model';
import type { GameSlug, VariantType } from '@cardvault/shared';
import { normalizeCollectorNumber } from '@cardvault/shared';

export interface ExtractedSignals {
  gameGuesses: { game: GameSlug; score: number }[];
  nameCandidates: string[];
  numbers: { raw: string; norm: string; total?: string }[];
  variantHints: VariantType[];
  serial?: string;
}

const STOP = /^(basic|stage ?\d|trainer|item|supporter|energy|evolves from.*|hp ?\d*|pokemon|pokémon|creature.*|instant|sorcery|level ?\d*|\W+)$/i;

/** Turn raw OCR text into structured identification signals. */
export function extractSignals(text: { full: string; top: string; bottom: string }, gameHint?: string): ExtractedSignals {
  const all = `${text.top}\n${text.full}\n${text.bottom}`;
  const gameGuesses = gameHint ? [{ game: gameHint as GameSlug, score: 1 }] : guessGameFromText(all);

  // Name candidates: the cleaner lines of the title band, then full text first lines
  const lines = [...text.top.split('\n'), ...text.full.split('\n').slice(0, 6)]
    .map((l) =>
      l
        .replace(/\b\d{2,3}\s*HP\b.*$/i, '')
        .replace(/\bHP\s*\d{2,3}\b.*$/i, '')
        .replace(/[^\p{L}\p{N}'’\-., &:]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((l) => l.length >= 3 && l.length <= 48 && /\p{L}{3}/u.test(l) && !STOP.test(l));
  const nameCandidates = [...new Set(lines)].slice(0, 6);

  // Collector numbers using every known game's patterns (prefer footer band)
  const numbers: ExtractedSignals['numbers'] = [];
  const games = gameGuesses.length && gameGuesses[0]!.score > 0 ? [gameGuesses[0]!.game] : (Object.keys(GAME_MODULES) as GameSlug[]);
  for (const src of [text.bottom, text.full]) {
    for (const g of games) {
      for (const re of GAME_MODULES[g].collectorNumberPatterns) {
        const rg = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
        for (const m of src.matchAll(rg)) {
          const raw = m[0].replace(/\s+/g, '');
          if (numbers.some((n) => n.raw === raw)) continue;
          numbers.push({ raw, norm: normalizeCollectorNumber(m[1] ?? raw), total: m[2] });
        }
      }
    }
  }

  const lower = all.toLowerCase();
  const variantHints: VariantType[] = [];
  if (/1st\s*edition/.test(lower)) variantHints.push('FIRST_EDITION');
  if (/\bauto(graph)?\b|certified autograph/.test(lower)) variantHints.push('AUTOGRAPH');
  if (/\b(relic|patch|game[- ]used|jersey)\b/.test(lower)) variantHints.push('MEMORABILIA');
  if (/\bpromo\b|black star/.test(lower)) variantHints.push('PROMO');
  const serial = /\b(\d{1,4})\s*\/\s*(\d{1,4})\b/.exec(text.full);
  const isSports = ['football', 'baseball', 'basketball', 'hockey'].includes(gameGuesses[0]?.game ?? '');
  if (isSports && serial && Number(serial[2]) <= 999) variantHints.push('SERIAL_NUMBERED');

  return { gameGuesses, nameCandidates, numbers: numbers.slice(0, 6), variantHints, serial: isSports && serial ? serial[0] : undefined };
}
