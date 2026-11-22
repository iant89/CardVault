/**
 * Fetching with guard rails: only allow-listed hosts (redirects included),
 * a timeout, a size cap, and errors that say whether a retry makes sense.
 */

export class FetchError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, retryable?: boolean, throttle?: boolean, retryAfterMs?: number }} info
   */
  constructor(message, info = {}) {
    super(message);
    this.status = info.status;
    this.retryable = info.retryable ?? false;
    this.throttle = info.throttle ?? false;
    this.retryAfterMs = info.retryAfterMs;
  }
}

/** Retry-After as milliseconds (seconds or HTTP date), capped. */
export function parseRetryAfter(value, cap = 120_000, now = Date.now()) {
  if (!value) return undefined;
  const s = Number(value);
  if (Number.isFinite(s)) return Math.min(cap, Math.max(0, s * 1000));
  const d = Date.parse(value);
  return Number.isFinite(d) ? Math.min(cap, Math.max(0, d - now)) : undefined;
}

/**
 * @param {string} url
 * @param {{ allowedHosts: Set<string>, signal?: AbortSignal, timeoutMs?: number, maxBytes?: number, userAgent?: string }} opts
 */
export async function guardedFetch(url, opts) {
  const u = new URL(url);
  if (!opts.allowedHosts.has(u.host)) throw new FetchError(`host not allowed: ${u.host}`);
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res;
  try {
    res = await fetch(u, {
      signal,
      redirect: 'manual',
      headers: { 'user-agent': opts.userAgent ?? 'tcgdex-harvester (personal archive tool)', accept: '*/*' },
    });
  } catch (e) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? e;
    const msg = timeout.aborted ? 'timed out' : (e.cause?.code ?? e.message);
    throw new FetchError(`network: ${msg}`, { retryable: true });
  }

  // follow redirects ourselves, only to allowed hosts
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    const next = new URL(res.headers.get('location'), u).toString();
    await res.body?.cancel();
    if ((opts.hops ?? 0) >= 3) throw new FetchError('too many redirects');
    return guardedFetch(next, { ...opts, hops: (opts.hops ?? 0) + 1 });
  }

  if (!res.ok) {
    await res.body?.cancel();
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    if (res.status === 429 || res.status === 503) {
      throw new FetchError(`HTTP ${res.status}`, { status: res.status, retryable: true, throttle: true, retryAfterMs });
    }
    throw new FetchError(`HTTP ${res.status}`, { status: res.status, retryable: res.status >= 500 || res.status === 408 });
  }

  const max = opts.maxBytes ?? 25 * 1024 * 1024;
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) {
    await res.body?.cancel();
    throw new FetchError(`response too large (${declared} bytes)`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > max) throw new FetchError(`response too large (> ${max} bytes)`);
    chunks.push(chunk);
  }
  return { status: res.status, headers: res.headers, body: Buffer.concat(chunks), url: u.toString() };
}

/** Recognize common image formats by their first bytes. */
export function imageKind(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
