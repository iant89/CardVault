import { and, eq, sql } from 'drizzle-orm';
import { normalizeCollectorNumber } from '@cardvault/shared';
import type { Database } from './client.js';
import { games, sets, cards, cardVariants, priceObservations } from './schema.js';

export const GAMES_SEED = [
  { slug: 'pokemon', name: 'Pokémon', sortOrder: 1 },
  { slug: 'magic', name: 'Magic: The Gathering', sortOrder: 2 },
  { slug: 'yugioh', name: 'Yu-Gi-Oh!', sortOrder: 3 },
  { slug: 'football', name: 'Football', sortOrder: 4 },
  { slug: 'baseball', name: 'Baseball', sortOrder: 5 },
  { slug: 'basketball', name: 'Basketball', sortOrder: 6 },
  { slug: 'hockey', name: 'Hockey', sortOrder: 7 },
  { slug: 'other', name: 'Other', sortOrder: 99 },
];

interface DemoCard {
  game: string;
  set: { name: string; code: string; releaseDate: string; total?: number };
  name: string;
  number: string;
  rarity: string;
  artist?: string;
  variants: string[];
  metadata: Record<string, unknown>;
  basePrice: number;
}

/** A small, offline demo catalog so the UI is usable before providers sync. */
const DEMO: DemoCard[] = [
  {
    game: 'pokemon',
    set: { name: 'Scarlet & Violet', code: 'sv1', releaseDate: '2023-03-31', total: 198 },
    name: 'Pikachu',
    number: '025/198',
    rarity: 'Rare',
    artist: 'Atsuko Nishida',
    variants: ['NORMAL', 'HOLO', 'REVERSE_HOLO'],
    metadata: {
      hp: '70',
      types: ['Lightning'],
      attacks: [{ name: 'Thunder Shock', cost: ['Lightning'], damage: '20', text: 'Flip a coin. If heads, your opponent’s Active Pokémon is now Paralyzed.' }],
      weaknesses: [{ type: 'Fighting', value: '×2' }],
      retreatCost: ['Colorless'],
      illustrator: 'Atsuko Nishida',
    },
    basePrice: 12,
  },
  {
    game: 'pokemon',
    set: { name: 'Base Set', code: 'base1', releaseDate: '1999-01-09', total: 102 },
    name: 'Charizard',
    number: '4/102',
    rarity: 'Rare Holo',
    artist: 'Mitsuhiro Arita',
    variants: ['HOLO', 'FIRST_EDITION', 'SHADOWLESS', 'UNLIMITED'],
    metadata: {
      hp: '120',
      types: ['Fire'],
      abilities: [{ name: 'Energy Burn', type: 'Pokémon Power' }],
      attacks: [{ name: 'Fire Spin', cost: ['Fire', 'Fire', 'Fire', 'Fire'], damage: '100' }],
      weaknesses: [{ type: 'Water', value: '×2' }],
      resistances: [{ type: 'Fighting', value: '-30' }],
      retreatCost: ['Colorless', 'Colorless', 'Colorless'],
      evolvesFrom: 'Charmeleon',
      illustrator: 'Mitsuhiro Arita',
    },
    basePrice: 420,
  },
  {
    game: 'pokemon',
    set: { name: 'Base Set', code: 'base1', releaseDate: '1999-01-09', total: 102 },
    name: 'Mewtwo',
    number: '10/102',
    rarity: 'Rare Holo',
    variants: ['HOLO', 'UNLIMITED'],
    metadata: { hp: '60', types: ['Psychic'], attacks: [{ name: 'Psychic', damage: '10+' }, { name: 'Barrier' }] },
    basePrice: 75,
  },
  {
    game: 'magic',
    set: { name: 'Limited Edition Alpha', code: 'lea', releaseDate: '1993-08-05', total: 295 },
    name: 'Black Lotus',
    number: '232',
    rarity: 'Rare',
    artist: 'Christopher Rush',
    variants: ['NON_FOIL'],
    metadata: { manaCost: '{0}', colors: [], typeLine: 'Artifact', oracleText: '{T}, Sacrifice Black Lotus: Add three mana of any one color.' },
    basePrice: 25000,
  },
  {
    game: 'magic',
    set: { name: 'Modern Horizons 2', code: 'mh2', releaseDate: '2021-06-18', total: 303 },
    name: 'Ragavan, Nimble Pilferer',
    number: '138',
    rarity: 'Mythic',
    variants: ['NON_FOIL', 'FOIL', 'ETCHED_FOIL'],
    metadata: { manaCost: '{R}', colors: ['R'], typeLine: 'Legendary Creature — Monkey Pirate', power: '2', toughness: '1' },
    basePrice: 55,
  },
  {
    game: 'yugioh',
    set: { name: 'Legend of Blue Eyes White Dragon', code: 'LOB', releaseDate: '2002-03-08' },
    name: 'Blue-Eyes White Dragon',
    number: 'LOB-001',
    rarity: 'Ultra Rare',
    variants: ['FIRST_EDITION', 'UNLIMITED'],
    metadata: { attribute: 'LIGHT', level: 8, race: 'Dragon', type: 'Normal Monster', attack: 3000, defense: 2500, effect: 'This legendary dragon is a powerful engine of destruction.', archetype: 'Blue-Eyes' },
    basePrice: 90,
  },
  {
    game: 'football',
    set: { name: '2000 Bowman Chrome', code: '2000-bowman-chrome', releaseDate: '2000-09-01' },
    name: 'Tom Brady',
    number: '236',
    rarity: 'Rookie',
    variants: ['NORMAL', 'PARALLEL'],
    metadata: { player: 'Tom Brady', team: 'New England Patriots', league: 'NFL', season: '2000', position: 'QB', rookie: true },
    basePrice: 1800,
  },
  {
    game: 'baseball',
    set: { name: '2011 Topps Update', code: '2011-topps-update', releaseDate: '2011-10-01' },
    name: 'Mike Trout',
    number: 'US175',
    rarity: 'Rookie',
    variants: ['NORMAL', 'PARALLEL'],
    metadata: { player: 'Mike Trout', team: 'Los Angeles Angels', league: 'MLB', season: '2011', position: 'OF', rookie: true },
    basePrice: 650,
  },
];

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export async function seedCatalog(db: Database, opts: { demo?: boolean } = {}): Promise<void> {
  await db
    .insert(games)
    .values(GAMES_SEED)
    .onConflictDoUpdate({ target: games.slug, set: { name: sql`excluded.name`, sortOrder: sql`excluded.sort_order` } });
  if (!opts.demo) return;

  const gameRows = await db.select().from(games);
  const gameId = (slug: string) => gameRows.find((g) => g.slug === slug)!.id;

  for (const d of DEMO) {
    const gid = gameId(d.game);
    const [setRow] = await db
      .insert(sets)
      .values({ gameId: gid, name: d.set.name, slug: slugify(d.set.name), code: d.set.code, releaseDate: d.set.releaseDate, totalCards: d.set.total ?? null })
      .onConflictDoUpdate({ target: [sets.gameId, sets.slug], set: { code: d.set.code } })
      .returning();
    const existing = await db
      .select()
      .from(cards)
      .where(and(eq(cards.setId, setRow!.id), eq(cards.name, d.name)))
      .limit(1);
    let card = existing[0];
    if (!card) {
      [card] = await db
        .insert(cards)
        .values({
          gameId: gid,
          setId: setRow!.id,
          name: d.name,
          collectorNumber: d.number,
          collectorNumberNorm: normalizeCollectorNumber(d.number),
          rarity: d.rarity,
          artist: d.artist ?? null,
          releaseDate: d.set.releaseDate,
          metadata: d.metadata,
          externalIds: { demo: `${d.set.code}-${d.number}` },
        })
        .returning();
    }
    const variantRows = [];
    for (const v of d.variants) {
      const [row] = await db
        .insert(cardVariants)
        .values({ cardId: card!.id, type: v })
        .onConflictDoUpdate({ target: [cardVariants.cardId, cardVariants.type], set: { type: v } })
        .returning();
      variantRows.push(row!);
    }
    // Demo price history (source "demo") — 120 days of synthetic sold + listed prices
    const now = Date.now();
    const obs = [];
    let p = d.basePrice * 0.8;
    for (let day = 120; day >= 0; day -= 4) {
      p = p * (1 + (Math.sin(day / 13) * 0.03 + 0.006));
      const observedAt = new Date(now - day * 86_400_000);
      observedAt.setUTCHours(12, 0, 0, 0);
      obs.push({
        cardId: card!.id,
        variantId: variantRows[0]!.id,
        source: 'demo',
        sourceItemId: `${card!.id}-sold-${day}`,
        price: Math.round(p * 100) / 100,
        currency: 'USD',
        condition: 'NM',
        saleType: 'SOLD' as const,
        observedAt,
      });
      if (day % 8 === 0)
        obs.push({ ...obs[obs.length - 1]!, sourceItemId: `${card!.id}-list-${day}`, price: Math.round(p * 1.15 * 100) / 100, saleType: 'LISTING' as const });
    }
    await db.insert(priceObservations).values(obs).onConflictDoNothing();
  }
}
