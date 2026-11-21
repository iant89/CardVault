import type { Job } from 'bullmq';
import { JobCancelled, type JobTracker } from '../jobs/state.js';
import type { WorkerContext } from '../context.js';

/** Wrap a processor: cancellation is a clean exit; final failures are recorded. */
export async function run<T>(ctx: WorkerContext, job: Job, tracker: JobTracker, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const r = await fn();
    ctx.stats.processed++;
    return r;
  } catch (err) {
    if (err instanceof JobCancelled) {
      ctx.log.info({ job: job.id }, 'job cancelled');
      return undefined;
    }
    const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    ctx.stats.failed += final ? 1 : 0;
    ctx.log.error({ job: job.id, queue: job.queueName, err: (err as Error).message, final }, 'job failed');
    await tracker.fail(err, final).catch(() => undefined);
    throw err;
  }
}
