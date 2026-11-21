import { eq, researchJobs } from '@cardvault/database';
import type { JobState, EventType } from '@cardvault/shared';
import type { WorkerContext } from '../context.js';

export class JobCancelled extends Error {
  constructor() {
    super('Job cancelled');
    this.name = 'JobCancelled';
  }
}

/** Tracks a research_jobs row through its states and mirrors changes as events. */
export class JobTracker {
  constructor(
    private readonly ctx: WorkerContext,
    readonly id: string,
    readonly userId: string | null,
    readonly scanId: string | null,
    public cardId: string | null,
  ) {}

  async assertNotCancelled(): Promise<void> {
    const [row] = await this.ctx.db.select({ status: researchJobs.status }).from(researchJobs).where(eq(researchJobs.id, this.id));
    if (row?.status === 'CANCELLED') throw new JobCancelled();
  }

  async update(state: JobState, stage: string, progress: number, event: EventType = 'JOB_PROGRESS', extra: Partial<typeof researchJobs.$inferInsert> = {}) {
    await this.assertNotCancelled();
    const now = new Date();
    await this.ctx.db
      .update(researchJobs)
      .set({ status: state, stage, progress, heartbeatAt: now, workerId: this.ctx.workerId, ...(this.cardId ? { cardId: this.cardId } : {}), ...extra })
      .where(eq(researchJobs.id, this.id));
    await this.ctx.events.publish({ type: event, userId: this.userId, jobId: this.id, scanId: this.scanId ?? undefined, cardId: this.cardId ?? undefined, state, message: stage, progress });
  }

  async start(stage: string, attempts: number) {
    await this.update('PROCESSING', stage, 5, 'JOB_STARTED', { startedAt: new Date(), attempts, error: null });
  }

  async finish(state: JobState, stage: string, event: EventType, extra: Partial<typeof researchJobs.$inferInsert> = {}) {
    await this.ctx.db
      .update(researchJobs)
      .set({ status: state, stage, progress: 100, completedAt: new Date(), ...(this.cardId ? { cardId: this.cardId } : {}), ...extra })
      .where(eq(researchJobs.id, this.id));
    await this.ctx.events.publish({ type: event, userId: this.userId, jobId: this.id, scanId: this.scanId ?? undefined, cardId: this.cardId ?? undefined, state, message: stage, progress: 100 });
  }

  async fail(err: unknown, final: boolean) {
    const message = err instanceof Error ? err.message : String(err);
    await this.ctx.db
      .update(researchJobs)
      .set(final ? { status: 'FAILED', error: message, completedAt: new Date(), stage: 'Failed' } : { status: 'QUEUED', error: message, stage: 'Retrying after error' })
      .where(eq(researchJobs.id, this.id));
    await this.ctx.events.publish({ type: final ? 'JOB_FAILED' : 'JOB_PROGRESS', userId: this.userId, jobId: this.id, scanId: this.scanId ?? undefined, state: final ? 'FAILED' : 'QUEUED', message });
  }
}
