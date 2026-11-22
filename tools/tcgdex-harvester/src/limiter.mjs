/**
 * Polite request pacing, per host.
 *
 * - Token bucket: at most `rate` requests per second, with a small burst.
 * - Adaptive (AIMD): a 429/503 halves the effective rate; every run of
 *   successes nudges it back up toward the target. The server tells us when
 *   we are too fast, and we listen.
 * - Cool-down: a Retry-After (or repeated failures) blocks the whole host
 *   until a given time, so no request is sent while we are being told to wait.
 */

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export class HostLimiter {
  /**
   * @param {string} host
   * @param {{ rate: number, burst?: number, minRate?: number, now?: () => number }} opts
   */
  constructor(host, opts) {
    this.host = host;
    this.now = opts.now ?? (() => Date.now());
    this.target = opts.rate;
    this.rate = opts.rate;
    this.minRate = opts.minRate ?? 0.2;
    this.burst = opts.burst ?? 2;
    this.tokens = this.burst;
    this.last = this.now();
    this.cooldownUntil = 0;
    this.streak = 0;
    this.throttleEvents = 0;
    this.sent = 0;
  }

  /** Change the target rate (from the UI). The effective rate follows it. */
  setTarget(rate) {
    this.target = rate;
    this.rate = Math.min(this.rate, rate);
    if (this.rate < rate && this.throttleEvents === 0) this.rate = rate;
  }

  refill() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
  }

  /** Milliseconds until a request may be sent (0 = now). */
  waitTime() {
    const t = this.now();
    if (this.cooldownUntil > t) return this.cooldownUntil - t;
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.rate) * 1000);
  }

  /** Wait for permission to send one request. */
  async acquire(signal) {
    for (;;) {
      const w = this.waitTime();
      if (w === 0) {
        this.tokens -= 1;
        this.sent++;
        return;
      }
      await sleep(Math.min(w, 1000), signal);
    }
  }

  /** A request succeeded: after a run of successes, recover toward the target. */
  success() {
    this.streak++;
    if (this.rate < this.target && this.streak >= 20) {
      this.rate = Math.min(this.target, this.rate * 1.25);
      this.streak = 0;
      if (this.rate >= this.target) this.throttleEvents = 0;
    }
  }

  /** The server pushed back (429/503): slow down and wait. */
  throttled(retryAfterMs) {
    this.streak = 0;
    this.throttleEvents++;
    this.rate = Math.max(this.minRate, this.rate / 2);
    this.tokens = 0;
    this.cooldown(retryAfterMs ?? 5000);
  }

  /** Block the host until now + ms (keeps the later of two cool-downs). */
  cooldown(ms) {
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + ms);
  }

  /** A failure that isn't push-back (5xx, network): reset the success run. */
  failure() {
    this.streak = 0;
  }

  snapshot() {
    const t = this.now();
    return {
      host: this.host,
      target: this.target,
      rate: Math.round(this.rate * 100) / 100,
      throttled: this.rate < this.target - 1e-9,
      cooldownMs: Math.max(0, this.cooldownUntil - t),
      sent: this.sent,
    };
  }
}

export class Limiter {
  constructor(rate, opts = {}) {
    this.rate = rate;
    this.opts = opts;
    /** @type {Map<string, HostLimiter>} */
    this.hosts = new Map();
  }

  for(host) {
    let h = this.hosts.get(host);
    if (!h) {
      h = new HostLimiter(host, { ...this.opts, rate: this.rate });
      this.hosts.set(host, h);
    }
    return h;
  }

  setRate(rate) {
    this.rate = rate;
    for (const h of this.hosts.values()) h.setTarget(rate);
  }

  snapshot() {
    return [...this.hosts.values()].map((h) => h.snapshot());
  }
}

export { sleep };
