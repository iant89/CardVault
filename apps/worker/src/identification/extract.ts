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

/** Stage / type words printed beside the name (BASIC badge, often misread as "BAS"). */
const LEAD_WORD = /^(basic|bas|stage\s?\d?|stg|item|supporter|trainer|tool|stadium|energy)$/i;
/** Suffixes that are part of a card's name and must be kept. */
const NAME_SUFFIX = /^(ex|gx|v|vmax|vstar|lv\.?x?|prime|break|star|δ|◇)$/i;

/**
 * Trim OCR debris from the ends of a title line: leading stage words, numbers
 * and stray marks, trailing HP values, "HP" and stray marks. Inner tokens are
 * kept, so names like "Number 39: Utopia" survive.
 */
export function trimDebris(line: string): string {
  const t = line.split(' ').filter(Boolean);
  // card names start with a capital: a lowercase (or symbol-led) first word
  // followed by a capitalised one is a misread badge ("oasic Porygon")
  const misreadLead = () => t.length > 1 && !/^\p{Lu}/u.test(t[0]!) && t.slice(1).some((w) => /^\p{Lu}/u.test(w));
  // HP with its tiny "HP" misread as letters: "w90", "HP60"
  const hpTail = (w: string) => /^[a-z]{0,2}\d{2,3}$/i.test(w) && !/^\p{Lu}\p{L}*\d$/u.test(w);
  const junk = (w: string) => /^[\d.,:\-]+$/.test(w) || /^hp$/i.test(w) || (w.length <= 2 && !NAME_SUFFIX.test(w) && !/^\p{Lu}\p{Ll}\.?$/u.test(w));
  while (t.length && (junk(t[0]!) || LEAD_WORD.test(t[0]!) || misreadLead())) t.shift();
  while (t.length && (junk(t[t.length - 1]!) || LEAD_WORD.test(t[t.length - 1]!) || hpTail(t[t.length - 1]!))) t.pop();
  return t.join(' ').replace(/[\s,.:\-]+$/, '');
}

/** Turn raw OCR text into structured identification signals. */
export function extractSignals(text: { full: string; top: string; bottom: string }, gameHint?: string): ExtractedSignals {
  const all = `${text.top}\n${text.full}\n${text.bottom}`;
  const gameGuesses = gameHint ? [{ game: gameHint as GameSlug, score: 1 }] : guessGameFromText(all);

  // Name candidates: the cleaner lines of the title band, then full text first lines.
  // Each line is also offered with OCR debris trimmed from its ends (stage
  // badges, an "HP" too small to read leaving its number behind, stray marks):
  // "5 Fletchling 60" → "Fletchling".
  const raw = [...text.top.split('\n'), ...text.full.split('\n').slice(0, 6)].map((l) =>
    l
      .replace(/\b\d{2,3}\s*HP\b.*$/i, '')
      .replace(/\bHP\s*\d{2,3}\b.*$/i, '')
      .replace(/[^\p{L}\p{N}'’\-., &:]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  const lines: string[] = [];
  for (const l of raw) {
    const t = trimDebris(l);
    if (!t) continue; // nothing but labels and debris ("Supporter TRAINER")
    if (t !== l) lines.push(t);
    lines.push(l);
  }
  const nameCandidates = [...new Set(lines.filter((l) => l.length >= 3 && l.length <= 48 && /\p{L}{3}/u.test(l) && !STOP.test(l)))].slice(0, 6);

  // Collector numbers using every known game's patterns (prefer footer band).
  // The footer text holds several readings of the same spot, so a number seen
  // in more of them ranks first.
  const found = new Map<string, { raw: string; norm: string; total?: string; hits: number; order: number }>();
  const games = gameGuesses.length && gameGuesses[0]!.score > 0 ? [gameGuesses[0]!.game] : (Object.keys(GAME_MODULES) as GameSlug[]);
  const note = (rawIn: string, num: string, total: string | undefined, weight: number) => {
    let numerator = num;
    // "E086/193": letters glued on from the symbols beside the number. A numeric
    // total means a numeric number (prefixed numbers have prefixed totals: TG05/TG30)
    if (total && /^\d+$/.test(total)) numerator = numerator.replace(/^[A-Z]+(?=\d)/, '');
    const norm = normalizeCollectorNumber(numerator);
    const key = `${norm}/${total ?? ''}`;
    const raw = total ? `${numerator}/${total}` : rawIn.replace(/\s+/g, '');
    const cur = found.get(key);
    if (cur) cur.hits += weight;
    else found.set(key, { raw, norm, total, hits: weight, order: found.size });
  };
  for (const [src, weight] of [[text.bottom, 2], [text.full, 1]] as const) {
    for (const line of src.split('\n')) {
      let hit = false;
      for (const g of games) {
        for (const re of GAME_MODULES[g].collectorNumberPatterns) {
          const rg = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
          for (const m of line.matchAll(rg)) {
            hit = true;
            note(m[0], m[1] ?? m[0], m[2], weight);
          }
        }
      }
      // "0861193": the slash read as a 1 (only in the targeted number readings)
      if (!hit && src === text.bottom && games.includes('pokemon' as GameSlug)) {
        const m = /(?<!\d)(\d{3})[1lI|](\d{3})(?!\d)/.exec(line);
        if (m) note(m[0], m[1]!, m[2], weight * 0.5);
      }
    }
  }
  const numbers: ExtractedSignals['numbers'] = [...found.values()]
    .sort((x, y) => y.hits - x.hits || x.order - y.order)
    .map(({ raw, norm, total }) => (total ? { raw, norm, total } : { raw, norm }));

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
