import { CircuitBreaker, HttpClient, type CardProvider, type ProviderContext, type ProviderLogger } from '@cardvault/provider-sdk';
import { sql, researchSources } from '@cardvault/database';
import type { Database } from '@cardvault/database';
import type { GameSlug } from '@cardvault/shared';
import { pokemonTcgProvider } from './pokemontcg.js';
import { tcgdexProvider } from './tcgdex.js';
import { scryfallProvider } from './scryfall.js';
import { ygoprodeckProvider } from './ygoprodeck.js';
import { ebayProvider } from './ebay.js';

export interface RegisteredProvider {
  provider: CardProvider;
  ctx: ProviderContext;
}

/**
 * Owns one HttpClient (rate limiter + circuit breaker) per provider so each
 * provider controls its own limits, and syncs provider status to the DB.
 */
export class ProviderRegistry {
  private readonly entries = new Map<string, RegisteredProvider>();
  private enabled = new Set<string>();
  private counters = new Map<string, { requests: number; errors: number }>();

  constructor(
    providers: CardProvider[],
    private readonly db: Database,
    log: ProviderLogger,
    env: Record<string, string | undefined>,
    userAgent: string,
  ) {
    for (const p of providers) {
      const http = new HttpClient({
        providerId: p.id,
        userAgent,
        rateLimit: p.rateLimit,
        allowedHosts: p.allowedHosts,
        log,
        breaker: new CircuitBreaker(p.id, 5, 5 * 60_000),
      });
      const c = { requests: 0, errors: 0 };
      this.counters.set(p.id, c);
      http.onRequest((e) => {
        c.requests++;
        if (e.error || (e.status ?? 0) >= 400) c.errors++;
        log.debug({ provider: e.providerId, method: e.method, url: e.url.replace(/([?&](?:key|token|api_key)=)[^&]+/gi, '$1***'), status: e.status, ms: e.durationMs, err: e.error }, 'provider request');
      });
      this.entries.set(p.id, { provider: p, ctx: { http, log, env } });
    }
  }

  async sync(): Promise<void> {
    for (const { provider: p, ctx } of this.entries.values()) {
      const configured = p.isConfigured(ctx);
      const c = this.counters.get(p.id)!;
      await this.db
        .insert(researchSources)
        .values({
          id: p.id,
          name: p.name,
          type: p.type,
          baseUrl: `https://${p.allowedHosts[0]}`,
          rateLimit: `${p.rateLimit.requests}/${p.rateLimit.intervalMs >= 60_000 ? `${p.rateLimit.intervalMs / 60_000}min` : `${p.rateLimit.intervalMs / 1000}s`}`,
          configured,
          enabled: configured,
          circuitState: ctx.http.breaker.state,
          lastError: ctx.http.breaker.lastError,
          requestCount: c.requests,
          errorCount: c.errors,
        })
        .onConflictDoUpdate({
          target: researchSources.id,
          set: {
            name: p.name,
            configured,
            circuitState: ctx.http.breaker.state,
            lastError: ctx.http.breaker.lastError,
            requestCount: sql`${researchSources.requestCount} + ${c.requests}`,
            errorCount: sql`${researchSources.errorCount} + ${c.errors}`,
            ...(c.requests > c.errors ? { lastSuccessAt: new Date() } : {}),
            updatedAt: new Date(),
          },
        });
      c.requests = 0;
      c.errors = 0;
    }
    const rows = await this.db.select({ id: researchSources.id, enabled: researchSources.enabled, configured: researchSources.configured }).from(researchSources);
    this.enabled = new Set(rows.filter((r) => r.enabled && r.configured).map((r) => r.id));
  }

  /** Enabled, configured providers for a game with a given capability, in registration order. */
  forGame(game: GameSlug | string, cap: keyof CardProvider['capabilities']): RegisteredProvider[] {
    return [...this.entries.values()].filter(
      (e) => this.enabled.has(e.provider.id) && e.provider.capabilities[cap] && (e.provider.games as readonly string[]).includes(game) && e.provider.isConfigured(e.ctx),
    );
  }

  get(id: string): RegisteredProvider | undefined {
    return this.entries.get(id);
  }
}

export const ALL_PROVIDERS: CardProvider[] = [tcgdexProvider, pokemonTcgProvider, scryfallProvider, ygoprodeckProvider, ebayProvider];
