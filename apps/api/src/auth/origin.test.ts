import { describe, expect, it } from 'vitest';
import { isSameOrigin, parseAllowedOrigins } from './origin.js';

const none = new Set<string>();

describe('isSameOrigin', () => {
  it('accepts the docker setup (nginx on :8080 forwarding the full host)', () => {
    expect(isSameOrigin('http://192.168.1.50:8080', ['192.168.1.50:8080'], none)).toBe(true);
  });
  it('accepts HTTPS behind Caddy where the Host header has no port', () => {
    expect(isSameOrigin('https://cardvault.home', ['cardvault.home'], none)).toBe(true);
  });
  it('accepts the Vite dev proxy', () => {
    expect(isSameOrigin('http://localhost:5173', ['localhost:5173'], none)).toBe(true);
  });
  it('prefers X-Forwarded-Host and handles comma lists', () => {
    expect(isSameOrigin('https://cardvault.home', ['cardvault.home, web', 'api:3000'], none)).toBe(true);
  });
  it('is case-insensitive and ignores a trailing slash', () => {
    expect(isSameOrigin('http://CardVault.local:8080/', ['cardvault.local:8080'], none)).toBe(true);
  });
  it('rejects another site', () => {
    expect(isSameOrigin('https://evil.example', ['cardvault.home'], none)).toBe(false);
  });
  it('rejects another port on the same machine', () => {
    expect(isSameOrigin('http://192.168.1.50:9000', ['192.168.1.50:8080'], none)).toBe(false);
  });
  it('rejects a port-stripped host when the origin used a non-default port', () => {
    // this is what the old nginx config forwarded; the fix is to forward $http_host
    expect(isSameOrigin('http://192.168.1.50:8080', ['192.168.1.50'], none)).toBe(false);
  });
  it('accepts anything listed in WEB_ORIGIN', () => {
    const allowed = parseAllowedOrigins('http://cardvault.local:8080, https://cardvault.home/');
    expect(isSameOrigin('https://cardvault.home', ['internal-api'], allowed)).toBe(true);
    expect(isSameOrigin('http://cardvault.local:8080', [], allowed)).toBe(true);
  });
  it('rejects garbage', () => {
    expect(isSameOrigin('null', ['cardvault.home'], none)).toBe(false);
  });
});
