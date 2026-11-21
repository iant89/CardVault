import type { GameSlug, SourceType } from '@cardvault/shared';
import type { NormalizedCard, PriceObservationInput } from '@cardvault/card-model';
import type { HttpClient } from './http.js';

export interface CardSearchQuery {
  game?: GameSlug;
  name?: string;
  setName?: string;
  setCode?: string;
  collectorNumber?: string;
  /** free text (OCR output etc.) */
  text?: string;
  limit?: number;
}

export interface CardSearchResult {
  providerId: string;
  externalId: string;
  card: NormalizedCard;
  /** provider-side relevance 0..1 */
  score: number;
}

export type SaleObservation = PriceObservationInput & { saleType: 'SOLD' | 'AUCTION' };

export interface ProviderCapabilities {
  identify: boolean;
  search: boolean;
  prices: boolean;
  sales: boolean;
  images: boolean;
}

export interface RateLimit {
  /** max requests per interval */
  requests: number;
  intervalMs: number;
}

export interface ProviderLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface ProviderContext {
  http: HttpClient;
  log: ProviderLogger;
  env: Record<string, string | undefined>;
}

/**
 * Every data source implements this interface and returns normalized
 * CardVault data. Providers are replaceable; nothing else in the system
 * knows about a provider's wire format.
 */
export interface CardProvider {
  readonly id: string;
  readonly name: string;
  readonly type: SourceType;
  readonly games: readonly GameSlug[];
  readonly capabilities: ProviderCapabilities;
  readonly rateLimit: RateLimit;
  /** hosts this provider may contact (SSRF allowlist) */
  readonly allowedHosts: readonly string[];

  /** false when required credentials/config are missing */
  isConfigured(ctx: ProviderContext): boolean;

  identify?(query: CardSearchQuery, ctx: ProviderContext): Promise<CardSearchResult[]>;
  search(query: CardSearchQuery, ctx: ProviderContext): Promise<CardSearchResult[]>;
  getCard(externalId: string, ctx: ProviderContext): Promise<NormalizedCard | null>;
  getPrices?(card: NormalizedCard, ctx: ProviderContext): Promise<PriceObservationInput[]>;
  getSales?(card: NormalizedCard, ctx: ProviderContext): Promise<SaleObservation[]>;
  getImages?(card: NormalizedCard, ctx: ProviderContext): Promise<string[]>;
}
