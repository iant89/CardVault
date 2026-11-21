import { isAllowedByRobots, type CardProvider, type ProviderContext } from '@cardvault/provider-sdk';

/**
 * Template for a polite generic web source. Prefer APIs; use this only for
 * sites whose terms permit automated access. It:
 *   - only contacts hosts listed in `allowedHosts` (SSRF guard)
 *   - checks robots.txt before every fetch and skips disallowed paths
 *   - never handles CAPTCHAs, logins or other access controls — a 401/403/429
 *     or challenge page is treated as "not available", never bypassed
 * Copy this file, set the host + parse logic, and register it in the
 * provider registry. Disabled by default (isConfigured → false).
 */
export function createWebSourceProvider(opts: {
  id: string;
  name: string;
  host: string;
  searchPath: (q: string) => string;
  parse: (html: string) => { title: string; price: number; url: string }[];
}): CardProvider {
  const fetchPage = async (ctx: ProviderContext, path: string): Promise<string | null> => {
    const url = new URL(path, `https://${opts.host}`);
    const ua = String(ctx.env.CRAWLER_USER_AGENT ?? 'CardVault');
    if (!(await isAllowedByRobots(ctx.http, url, ua))) {
      ctx.log.info({ provider: opts.id, url: url.toString() }, 'robots.txt disallows path; skipping');
      return null;
    }
    const res = await ctx.http.request(url, { headers: { accept: 'text/html' }, retries: 2 });
    if (/captcha|challenge-platform|cf-chl/i.test(res.text)) {
      ctx.log.warn({ provider: opts.id }, 'challenge page detected; not bypassing');
      return null;
    }
    return res.text;
  };

  return {
    id: opts.id,
    name: opts.name,
    type: 'WEB_CRAWLER',
    games: ['pokemon', 'magic', 'yugioh', 'football', 'baseball', 'basketball', 'hockey', 'other'],
    capabilities: { identify: false, search: false, prices: true, sales: false, images: false },
    rateLimit: { requests: 10, intervalMs: 60_000 },
    allowedHosts: [opts.host],
    isConfigured: () => false,
    search: async () => [],
    getCard: async () => null,
    async getPrices(card, ctx) {
      const html = await fetchPage(ctx, opts.searchPath(`${card.name} ${card.collectorNumber}`));
      if (!html) return [];
      const at = new Date().toISOString();
      return opts.parse(html).map((r) => ({ source: opts.id, sourceItemId: r.url, price: r.price, currency: 'USD', saleType: 'LISTING' as const, observedAt: at, url: r.url, title: r.title }));
    },
  };
}
