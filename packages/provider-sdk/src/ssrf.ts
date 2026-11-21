import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

/** Only public unicast addresses are allowed. */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let ip = ipaddr.parse(address);
  if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress()) {
    ip = (ip as ipaddr.IPv6).toIPv4Address();
  }
  return ip.range() === 'unicast';
}

/**
 * Validate a URL before fetching: https only (http allowed only if
 * explicitly permitted), no credentials, hostname in allowlist (if given),
 * and every resolved address must be public (blocks localhost, RFC1918,
 * link-local incl. 169.254.169.254 metadata, CGNAT, ULA, etc.).
 * Returns the resolved address the request must be pinned to.
 */
export async function assertSafeUrl(
  raw: string | URL,
  opts: { allowedHosts?: readonly string[]; allowHttp?: boolean } = {},
): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('Invalid URL');
  }
  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) {
    throw new SsrfError(`Protocol not allowed: ${url.protocol}`);
  }
  if (url.username || url.password) throw new SsrfError('Credentials in URL not allowed');
  if (url.port && !['443', '80'].includes(url.port)) throw new SsrfError('Non-standard port not allowed');

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home') || host.endsWith('.lan')) {
    throw new SsrfError(`Host not allowed: ${host}`);
  }
  if (opts.allowedHosts && opts.allowedHosts.length) {
    const ok = opts.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!ok) throw new SsrfError(`Host not in provider allowlist: ${host}`);
  }

  if (ipaddr.isValid(host)) {
    if (!isPublicAddress(host)) throw new SsrfError(`Address not allowed: ${host}`);
    return { url, address: host, family: host.includes(':') ? 6 : 4 };
  }
  const addrs = await lookup(host, { all: true, verbatim: true });
  if (!addrs.length) throw new SsrfError(`Could not resolve ${host}`);
  for (const a of addrs) {
    if (!isPublicAddress(a.address)) throw new SsrfError(`${host} resolves to non-public address ${a.address}`);
  }
  return { url, address: addrs[0]!.address, family: addrs[0]!.family as 4 | 6 };
}
