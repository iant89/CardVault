import type { GameSlug, VariantType, SaleType, Condition } from '@cardvault/shared';

/** Provider-neutral card representation returned by every provider. */
export interface NormalizedCard {
  game: GameSlug;
  set: { code: string; name: string; releaseDate?: string | null; total?: number | null; series?: string | null };
  name: string;
  collectorNumber: string;
  rarity?: string | null;
  artist?: string | null;
  releaseDate?: string | null;
  imageUrl?: string | null;
  imageUrlSmall?: string | null;
  variants: VariantType[];
  /** game-specific attributes (validated by game module schema) */
  attributes: Record<string, unknown>;
  /** ids of this card in external systems, e.g. { pokemontcg: 'sv1-25', scryfall: '…' } */
  externalIds: Record<string, string>;
}

export interface PriceObservationInput {
  source: string;
  sourceItemId?: string | null;
  variant?: VariantType | null;
  price: number;
  shipping?: number | null;
  currency: string;
  condition?: Condition | string | null;
  saleType: SaleType;
  observedAt: string;
  url?: string | null;
  title?: string | null;
}
