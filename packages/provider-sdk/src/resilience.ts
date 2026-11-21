/** Token-bucket style limiter: at most `requests` per `intervalMs`, queued FIFO. */
export class RateLimiter {
  private timestamps: number[] = [];
  private chain: Promise<void> = Promise.resolve();
  constructor(
    private readonly requests: number,
    private readonly intervalMs: number,
  ) {}

  acquire(): Promise<void> {
    const next = this.chain.then(() => this.waitForSlot());
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < this.intervalMs);
      if (this.timestamps.length < this.requests) {
        this.timestamps.push(now);
        return;
      }
      const wait = this.intervalMs - (now - this.timestamps[0]!) + 5;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitOpenError extends Error {
  constructor(public readonly providerId: string, public readonly retryAt: number) {
    super(`Circuit open for provider ${providerId}`);
    this.name = 'CircuitOpenError';
  }
}

/** Opens after `threshold` consecutive failures; half-opens after `cooldownMs`. */
export class CircuitBreaker {
  state: CircuitState = 'CLOSED';
  failures = 0;
  openedAt = 0;
  lastError: string | null = null;
  constructor(
    public readonly id: string,
    private readonly threshold = 5,
    private readonly cooldownMs = 5 * 60_000,
  ) {}

  check(): void {
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt >= this.cooldownMs) this.state = 'HALF_OPEN';
      else throw new CircuitOpenError(this.id, this.openedAt + this.cooldownMs);
    }
  }
  success(): void {
    this.failures = 0;
    this.state = 'CLOSED';
  }
  failure(err: unknown): void {
    this.failures++;
    this.lastError = err instanceof Error ? err.message : String(err);
    if (this.state === 'HALF_OPEN' || this.failures >= this.threshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
    }
  }
}

export function backoffDelay(attempt: number, baseMs = 500, maxMs = 30_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}
