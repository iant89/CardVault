import { z } from 'zod';
import type { GameSlug } from '@cardvault/shared';

/**
 * Game modules: the generic Card stays generic; each game defines its own
 * attribute schema, display fields and identification hints.
 */
export interface DisplayField {
  key: string;
  label: string;
  format?: 'text' | 'list' | 'boolean' | 'number' | 'mana' | 'attacks' | 'longtext';
}

export interface GameModule {
  slug: GameSlug;
  name: string;
  shortName: string;
  attributes: z.ZodType<Record<string, unknown>>;
  displayFields: DisplayField[];
  /** Regexes that help OCR find a collector number on this game's cards. */
  collectorNumberPatterns: RegExp[];
  /** Keywords that suggest an OCR'd card belongs to this game. */
  ocrKeywords: string[];
  /** Where the name and collector number are printed, for targeted OCR. */
  ocrLayout?: OcrLayout;
  theme: string;
}

/** A region of the card as fractions of its width/height (0–1). */
export interface OcrRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface OcrLayout {
  /** the title line (read as a single line) */
  name: OcrRegion[];
  /** spots where the collector number / set code can be printed */
  number: OcrRegion[];
  /** characters allowed when reading the number spots */
  numberChars: string;
}

const attack = z.object({
  name: z.string(),
  cost: z.array(z.string()).optional(),
  damage: z.string().optional(),
  text: z.string().optional(),
});

export const pokemonAttributes = z
  .object({
    hp: z.string().optional(),
    types: z.array(z.string()).optional(),
    supertype: z.string().optional(),
    subtypes: z.array(z.string()).optional(),
    abilities: z.array(z.object({ name: z.string(), text: z.string().optional(), type: z.string().optional() })).optional(),
    attacks: z.array(attack).optional(),
    weaknesses: z.array(z.object({ type: z.string(), value: z.string().optional() })).optional(),
    resistances: z.array(z.object({ type: z.string(), value: z.string().optional() })).optional(),
    retreatCost: z.array(z.string()).optional(),
    evolvesFrom: z.string().optional(),
    illustrator: z.string().optional(),
  })
  .passthrough();

export const magicAttributes = z
  .object({
    manaCost: z.string().optional(),
    colors: z.array(z.string()).optional(),
    typeLine: z.string().optional(),
    oracleText: z.string().optional(),
    power: z.string().optional(),
    toughness: z.string().optional(),
    loyalty: z.string().optional(),
    finishes: z.array(z.string()).optional(),
  })
  .passthrough();

export const yugiohAttributes = z
  .object({
    attribute: z.string().optional(),
    level: z.number().optional(),
    race: z.string().optional(),
    type: z.string().optional(),
    attack: z.number().optional(),
    defense: z.number().optional(),
    effect: z.string().optional(),
    archetype: z.string().optional(),
    edition: z.string().optional(),
  })
  .passthrough();

export const sportsAttributes = z
  .object({
    player: z.string().optional(),
    team: z.string().optional(),
    league: z.string().optional(),
    season: z.string().optional(),
    position: z.string().optional(),
    rookie: z.boolean().optional(),
    parallel: z.string().optional(),
    serialNumber: z.string().optional(),
    printRun: z.number().optional(),
    autograph: z.boolean().optional(),
    memorabilia: z.boolean().optional(),
    statistics: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const sportsFields = (withMemorabilia: boolean): DisplayField[] => [
  { key: 'player', label: 'Player' },
  { key: 'team', label: 'Team' },
  { key: 'league', label: 'League' },
  { key: 'season', label: 'Season' },
  { key: 'position', label: 'Position' },
  { key: 'rookie', label: 'Rookie', format: 'boolean' },
  { key: 'parallel', label: 'Parallel' },
  { key: 'serialNumber', label: 'Serial Number' },
  { key: 'autograph', label: 'Autograph', format: 'boolean' },
  ...(withMemorabilia ? [{ key: 'memorabilia', label: 'Memorabilia', format: 'boolean' as const }] : []),
];

const sportsNumber = [/\b(?:#|No\.?\s?)([A-Z]{0,4}-?\d{1,4})\b/i];

const sports = (slug: GameSlug, name: string, theme: string, keywords: string[]): GameModule => ({
  slug,
  name,
  shortName: name,
  attributes: sportsAttributes,
  displayFields: sportsFields(slug !== 'baseball'),
  collectorNumberPatterns: sportsNumber,
  ocrKeywords: keywords,
  theme,
});

export const GAME_MODULES: Record<GameSlug, GameModule> = {
  pokemon: {
    slug: 'pokemon',
    name: 'Pokémon',
    shortName: 'Pokémon',
    attributes: pokemonAttributes,
    displayFields: [
      { key: 'hp', label: 'HP' },
      { key: 'types', label: 'Type', format: 'list' },
      { key: 'abilities', label: 'Abilities', format: 'attacks' },
      { key: 'attacks', label: 'Attacks', format: 'attacks' },
      { key: 'weaknesses', label: 'Weakness', format: 'list' },
      { key: 'resistances', label: 'Resistance', format: 'list' },
      { key: 'retreatCost', label: 'Retreat', format: 'list' },
      { key: 'evolvesFrom', label: 'Evolves From' },
      { key: 'illustrator', label: 'Illustrator' },
    ],
    collectorNumberPatterns: [/\b([A-Z]{0,4}\d{1,3})\s*\/\s*([A-Z]{0,4}\d{1,3})\b/, /\b(SWSH\d{2,3}|SVP?\s?\d{2,3}|SM\d{2,3}|XY\d{2,3})\b/i],
    ocrKeywords: ['hp', 'weakness', 'resistance', 'retreat', 'pokemon', 'pokémon', 'evolves', 'basic', 'stage', 'trainer', 'energy'],
    ocrLayout: {
      // name sits right of the stage badge; HP and type icon are on the right
      name: [{ left: 0.15, top: 0.035, width: 0.6, height: 0.07 }],
      // bottom-left (Sword & Shield onwards) and bottom-right (older sets)
      number: [
        { left: 0.02, top: 0.915, width: 0.4, height: 0.05 },
        { left: 0.58, top: 0.915, width: 0.4, height: 0.05 },
      ],
      numberChars: '0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    },
    theme: 'pokemon',
  },
  magic: {
    slug: 'magic',
    name: 'Magic: The Gathering',
    shortName: 'Magic',
    attributes: magicAttributes,
    displayFields: [
      { key: 'manaCost', label: 'Mana', format: 'mana' },
      { key: 'colors', label: 'Color', format: 'list' },
      { key: 'typeLine', label: 'Type' },
      { key: 'oracleText', label: 'Rules Text', format: 'longtext' },
      { key: 'power', label: 'Power' },
      { key: 'toughness', label: 'Toughness' },
      { key: 'loyalty', label: 'Loyalty' },
      { key: 'finishes', label: 'Finishes', format: 'list' },
    ],
    collectorNumberPatterns: [/\b(\d{1,4})\s*\/\s*(\d{1,4})\b/, /\b(\d{3,4})\s+[CURMSLT]\b/],
    ocrKeywords: ['creature', 'instant', 'sorcery', 'enchantment', 'artifact', 'planeswalker', 'land', 'legendary', 'wizards of the coast', 'illus'],
    ocrLayout: {
      // title bar, left of the mana cost
      name: [{ left: 0.06, top: 0.04, width: 0.62, height: 0.06 }],
      // collector number + set code, bottom-left (two small lines)
      number: [{ left: 0.03, top: 0.925, width: 0.42, height: 0.06 }],
      numberChars: '0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZ ',
    },
    theme: 'magic',
  },
  yugioh: {
    slug: 'yugioh',
    name: 'Yu-Gi-Oh!',
    shortName: 'Yu-Gi-Oh!',
    attributes: yugiohAttributes,
    displayFields: [
      { key: 'attribute', label: 'Attribute' },
      { key: 'level', label: 'Level', format: 'number' },
      { key: 'race', label: 'Type' },
      { key: 'type', label: 'Card Type' },
      { key: 'attack', label: 'ATK', format: 'number' },
      { key: 'defense', label: 'DEF', format: 'number' },
      { key: 'effect', label: 'Effect', format: 'longtext' },
      { key: 'archetype', label: 'Archetype' },
      { key: 'edition', label: 'Edition' },
    ],
    collectorNumberPatterns: [/\b([A-Z0-9]{2,5}-[A-Z]{0,2}\d{2,4})\b/],
    ocrKeywords: ['atk', 'def', 'effect', 'spell card', 'trap card', 'konami', 'dragon', 'warrior', 'spellcaster', 'fiend'],
    ocrLayout: {
      // name bar, left of the attribute icon
      name: [{ left: 0.06, top: 0.035, width: 0.74, height: 0.065 }],
      // set code just below the artwork, on the right
      number: [{ left: 0.55, top: 0.715, width: 0.42, height: 0.045 }],
      numberChars: '0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    },
    theme: 'yugioh',
  },
  football: sports('football', 'Football', 'football', ['nfl', 'quarterback', 'touchdown', 'panini', 'topps', 'rookie']),
  baseball: sports('baseball', 'Baseball', 'baseball', ['mlb', 'topps', 'bowman', 'pitcher', 'batting', 'rookie']),
  basketball: sports('basketball', 'Basketball', 'basketball', ['nba', 'panini', 'prizm', 'hoops', 'rookie']),
  hockey: sports('hockey', 'Hockey', 'hockey', ['nhl', 'upper deck', 'o-pee-chee', 'goalie', 'rookie']),
  other: {
    slug: 'other',
    name: 'Other',
    shortName: 'Other',
    attributes: z.record(z.string(), z.unknown()),
    displayFields: [],
    collectorNumberPatterns: [/\b(\d{1,4})\s*\/\s*(\d{1,4})\b/],
    ocrKeywords: [],
    theme: 'default',
  },
};

export function gameModule(slug: string): GameModule {
  return GAME_MODULES[slug as GameSlug] ?? GAME_MODULES.other;
}

/** Validate & strip attributes against the game's schema; never throws. */
export function parseAttributes(slug: string, attrs: unknown): Record<string, unknown> {
  const r = gameModule(slug).attributes.safeParse(attrs ?? {});
  return r.success ? r.data : {};
}

/** Score how likely OCR text belongs to each game (0..1). */
export function guessGameFromText(text: string): { game: GameSlug; score: number }[] {
  const t = text.toLowerCase();
  return Object.values(GAME_MODULES)
    .filter((m) => m.ocrKeywords.length)
    .map((m) => {
      const hits = m.ocrKeywords.filter((k) => t.includes(k)).length;
      return { game: m.slug, score: Math.min(1, hits / 3) };
    })
    .sort((a, b) => b.score - a.score);
}
