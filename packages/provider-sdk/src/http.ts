import { Agent, request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { assertSafeUrl, SsrfError } from './ssrf.js';
import { RateLimiter, CircuitBreaker, backoffDelay } from './resilience.js';
import type { ProviderLogger, RateLimit } from './types.js';

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly retryAfterMs?: number) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** max retries for retryable failures (5xx, 429, network). Never infinite. */
  retries?: number;
  maxBytes?: number;
}

export interface HttpResponse {
  status: number;
  /** raw bytes (use for images) */
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json<T = unknown>(): T;
}

export interface HttpClientOptions {
  providerId: string;
  userAgent: string;
  rateLimit: RateLimit;
  allowedHosts: readonly string[];
  log: ProviderLogger;
  allowHttp?: boolean;
  breaker?: CircuitBreaker;
}

export interface RequestLogEntry {
  providerId: string;
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
  error?: string;
}

export type RequestLogSink = (e: RequestLogEntry) => void;

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Per-provider HTTP client enforcing: SSRF validation with DNS pinning,
 * host allowlist, rate limiting, timeout, bounded retries with exponential
 * backoff (honouring Retry-After), circuit breaker, a fixed User-Agent and
 * request logging. Redirects are not followed automatically; each hop is
 * re-validated.
 */
export class HttpClient {
  readonly limiter: RateLimiter;
  readonly breaker: CircuitBreaker;
  private sink?: RequestLogSink;

  constructor(private readonly opts: HttpClientOptions) {
    this.limiter = new RateLimiter(opts.rateLimit.requests, opts.rateLimit.intervalMs);
    this.breaker = opts.breaker ?? new CircuitBreaker(opts.providerId);
  }

  onRequest(sink: RequestLogSink): void {
    this.sink = sink;
  }

  async getJson<T>(url: string | URL, opts: HttpRequestOptions = {}): Promise<T> {
    const res = await this.request(url, { ...opts, headers: { accept: 'application/json', ...opts.headers } });
    return res.json<T>();
  }

  async request(url: string | URL, opts: HttpRequestOptions = {}): Promise<HttpResponse> {
    this.breaker.check();
    const retries = Math.min(opts.retries ?? 3, 5);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.limiter.acquire();
      try {
        const res = await this.once(url, opts, 0);
        this.breaker.success();
        return res;
      } catch (err) {
        lastErr = err;
        const retryable =
          !(err instanceof SsrfError) && (!(err instanceof HttpError) || RETRYABLE.has(err.status));
        if (!retryable) {
          // 4xx (other than 429) are caller errors, not provider health problems
          if (!(err instanceof HttpError) || err.status >= 500) this.breaker.failure(err);
          throw err;
        }
        if (attempt === retries) break;
        const wait = err instanceof HttpError && err.retryAfterMs ? Math.min(err.retryAfterMs, 60_000) : backoffDelay(attempt);
        this.opts.log.warn({ provider: this.opts.providerId, attempt, wait, err: String(err) }, 'retrying request');
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    this.breaker.failure(lastErr);
    throw lastErr;
  }

  private async once(raw: string | URL, opts: HttpRequestOptions, redirects: number): Promise<HttpResponse> {
    const { url, address, family } = await assertSafeUrl(raw, {
      allowedHosts: this.opts.allowedHosts,
      allowHttp: this.opts.allowHttp,
    });
    const started = Date.now();
    const method = opts.method ?? 'GET';
    const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
    const isHttps = url.protocol === 'https:';
    const reqFn = isHttps ? httpsRequest : httpRequest;

    const result = await new Promise<HttpResponse>((resolve, reject) => {
      const req = reqFn(
        url,
        {
          method,
          headers: {
            'user-agent': this.opts.userAgent,
            'accept-encoding': 'identity',
            ...(opts.body ? { 'content-length': Buffer.byteLength(opts.body).toString() } : {}),
            ...opts.headers,
          },
          // Pin the connection to the address we validated (prevents DNS rebinding)
          lookup: (_h, _o, cb) => cb(null, [{ address, family }] as never, family as never),
          agent: isHttps ? new Agent({ keepAlive: false }) : undefined,
          timeout: opts.timeoutMs ?? 15_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) {
              req.destroy(new Error('Response too large'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const body = Buffer.concat(chunks);
            const text = body.toString('utf8');
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body,
              text,
              json: <T>() => JSON.parse(text) as T,
            });
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`Timeout after ${opts.timeoutMs ?? 15_000}ms`)));
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    }).catch((err: Error) => {
      this.sink?.({ providerId: this.opts.providerId, method, url: url.toString(), status: null, durationMs: Date.now() - started, error: err.message });
      throw err;
    });

    this.sink?.({ providerId: this.opts.providerId, method, url: url.toString(), status: result.status, durationMs: Date.now() - started });

    if (result.status >= 300 && result.status < 400 && result.headers.location) {
      if (redirects >= 3) throw new HttpError(result.status, 'Too many redirects');
      const next = new URL(String(result.headers.location), url);
      return this.once(next, opts, redirects + 1);
    }
    if (result.status >= 400) {
      const ra = result.headers['retry-after'];
      const retryAfterMs = ra ? (Number(ra) > 0 ? Number(ra) * 1000 : Math.max(0, Date.parse(String(ra)) - Date.now())) : undefined;
      throw new HttpError(result.status, `HTTP ${result.status} from ${url.hostname}`, retryAfterMs);
    }
    return result;
  }
}
