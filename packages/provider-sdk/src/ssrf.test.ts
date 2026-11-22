import { describe, expect, it } from 'vitest';
import { assertSafeUrl, isPublicAddress } from './ssrf.js';
import { parseRobots, robotsAllows } from './robots.js';

describe('ssrf', () => {
  it('classifies addresses', () => {
    for (const a of ['127.0.0.1', '10.0.0.1', '192.168.1.5', '172.16.0.1', '169.254.169.254', '::1', 'fd00::1', '100.64.0.1', '0.0.0.0', '::ffff:127.0.0.1']) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    expect(isPublicAddress('8.8.8.8')).toBe(true);
  });
  it('rejects unsafe urls', async () => {
    await expect(assertSafeUrl('http://example.com')).rejects.toThrow(/Protocol/);
    await expect(assertSafeUrl('https://localhost/x')).rejects.toThrow();
    await expect(assertSafeUrl('https://127.0.0.1/')).rejects.toThrow();
    await expect(assertSafeUrl('https://[::1]/')).rejects.toThrow();
    await expect(assertSafeUrl('https://169.254.169.254/latest/meta-data')).rejects.toThrow();
    await expect(assertSafeUrl('https://user:pw@8.8.8.8/')).rejects.toThrow(/Credentials/);
    await expect(assertSafeUrl('https://8.8.8.8:8080/')).rejects.toThrow(/port/);
    await expect(assertSafeUrl('https://evil.com/', { allowedHosts: ['api.scryfall.com'] })).rejects.toThrow(/allowlist/);
    await expect(assertSafeUrl('https://cardvault.home/')).rejects.toThrow();
  });
});

describe('robots', () => {
  it('parses and matches rules', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /search\nAllow: /search/public\n', 'CardVault');
    expect(robotsAllows(rules, '/search?q=1')).toBe(false);
    expect(robotsAllows(rules, '/search/public')).toBe(true);
    expect(robotsAllows(rules, '/cards/1')).toBe(true);
  });
});

import { HttpError, MAX_RETRY_AFTER_MS, retryWait } from './http.js';

describe('retryWait', () => {
  it('ignores Retry-After on server errors (pokemontcg.io sends 60 s with 502s)', () => {
    expect(retryWait(new HttpError(502, 'bad gateway', 60_000), 0)).toBeLessThan(1_000);
    expect(retryWait(new HttpError(500, 'error', 60_000), 1)).toBeLessThan(2_000);
  });
  it('honours Retry-After for rate limits and maintenance, capped', () => {
    expect(retryWait(new HttpError(429, 'slow down', 4_000), 0)).toBe(4_000);
    expect(retryWait(new HttpError(503, 'maintenance', 120_000), 0)).toBe(MAX_RETRY_AFTER_MS);
  });
  it('falls back to exponential backoff for network errors', () => {
    expect(retryWait(new Error('ECONNRESET'), 0)).toBeLessThan(1_000);
  });
});
