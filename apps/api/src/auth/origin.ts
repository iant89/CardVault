/**
 * Same-origin check for state-changing requests (defence in depth on top of
 * SameSite=Strict cookies and the CSRF token).
 *
 * A request is accepted when its Origin either
 *  - is listed in WEB_ORIGIN (comma-separated), or
 *  - names the same scheme-default-normalised host:port that the browser
 *    addressed, as seen in X-Forwarded-Host / Host.
 *
 * Ports are compared after normalising defaults, so "Host: cardvault.home"
 * matches "Origin: https://cardvault.home" (443), while a page served from
 * another port on the same machine does not match.
 */
const DEFAULT_PORT: Record<string, string> = { 'http:': '80', 'https:': '443' };

export function parseAllowedOrigins(webOrigin: string | undefined): Set<string> {
  return new Set(
    (webOrigin ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, '').toLowerCase())
      .filter(Boolean),
  );
}

function hostPort(hostHeader: string, protocol: string): { host: string; port: string } | null {
  try {
    const u = new URL(`${protocol}//${hostHeader.trim()}`);
    return { host: u.hostname.toLowerCase(), port: u.port || DEFAULT_PORT[protocol] || '' };
  } catch {
    return null;
  }
}

export function isSameOrigin(origin: string, hostHeaders: (string | string[] | undefined)[], allowed: Set<string>): boolean {
  const o = origin.trim().replace(/\/+$/, '').toLowerCase();
  if (allowed.has(o)) return true;
  let url: URL;
  try {
    url = new URL(o);
  } catch {
    return false;
  }
  const want = { host: url.hostname, port: url.port || DEFAULT_PORT[url.protocol] || '' };
  const candidates = hostHeaders
    .flatMap((h) => (Array.isArray(h) ? h : h ? [h] : []))
    .flatMap((h) => h.split(','))
    .filter((h) => h.trim());
  return candidates.some((h) => {
    const got = hostPort(h, url.protocol);
    return !!got && got.host === want.host && got.port === want.port;
  });
}
