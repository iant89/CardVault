import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { eq, sql, researchJobs } from '@cardvault/database';
import type { WorkerContext } from '../context.js';
import { snapshotCollectionValues } from '../pricing/compute.js';
import { evaluate, exportDataset, importHarvest, labelReviewed, scanModels } from './ocr-lab.js';
import { setupOcrPython, trainModel } from './ocr-train.js';
import { trainWithVision, type VisionTrainRequest } from './ocr-vision.js';
import { pruneSamples } from '../identification/samples.js';
import { runWatch } from './ocr-watch.js';

/**
 * Recover abandoned jobs. BullMQ already re-queues *stalled* jobs whose worker
 * died; this sweep covers the remaining gap — DB rows stuck in an active state
 * whose queue entry is gone (e.g. Redis was reset). PROCESSING → QUEUED.
 */
async function recoverStale(ctx: WorkerContext): Promise<number> {
  const rows = await ctx.db.execute(sql`
    SELECT id, queue, bull_job_id, scan_id, card_id, user_id, priority FROM research_jobs
    WHERE status IN ('QUEUED','PROCESSING','MATCHING','RESEARCHING','PRICING')
      AND COALESCE(heartbeat_at, created_at) < now() - interval '15 minutes'
    LIMIT 200`);
  let n = 0;
  for (const r of rows) {
    const id = String(r.id);
    const q = r.queue === 'identification' ? ctx.queues.identification : ctx.queues.research;
    const existing = await q.getJob(String(r.bull_job_id ?? id));
    const state = existing ? await existing.getState() : 'missing';
    if (['active', 'waiting', 'delayed', 'prioritized', 'waiting-children'].includes(state)) continue;
    if (state === 'failed') {
      await ctx.db.update(researchJobs).set({ status: 'FAILED', completedAt: new Date(), error: existing?.failedReason ?? 'failed' }).where(eq(researchJobs.id, id));
      continue;
    }
    if (existing) await existing.remove().catch(() => undefined);
    await ctx.db.update(researchJobs).set({ status: 'QUEUED', stage: 'Recovered after interruption', heartbeatAt: new Date() }).where(eq(researchJobs.id, id));
    if (r.queue === 'identification' && r.scan_id) {
      await ctx.db.update(researchJobs).set({ bullJobId: id }).where(eq(researchJobs.id, id));
      await ctx.queues.identification.add('identify', { scanId: String(r.scan_id), userId: String(r.user_id), researchJobId: id }, { jobId: id, priority: Number(r.priority) });
    } else if (r.card_id) {
      await ctx.queues.research.add(
        'research',
        { researchJobId: id, cardId: String(r.card_id), scanId: (r.scan_id as string) ?? null, userId: (r.user_id as string) ?? null, priority: Number(r.priority), reason: 'RETRY' },
        { jobId: id, priority: Number(r.priority) },
      );
    }
    n++;
  }
  if (n) ctx.log.info({ recovered: n }, 'recovered abandoned jobs');
  return n;
}

/** "Scan once, research forever": periodically re-research owned cards. */
async function refreshResearch(ctx: WorkerContext): Promise<number> {
  const rows = await ctx.db.execute(sql`
    SELECT c.id, c.name FROM cards c
    WHERE EXISTS (SELECT 1 FROM collection_items ci WHERE ci.card_id = c.id)
      AND (c.last_researched_at IS NULL OR c.last_researched_at < now() - make_interval(hours => ${ctx.config.RESEARCH_REFRESH_HOURS}))
      AND NOT EXISTS (SELECT 1 FROM research_jobs j WHERE j.card_id = c.id AND j.status IN ('QUEUED','PROCESSING','RESEARCHING','PRICING'))
    ORDER BY c.last_researched_at ASC NULLS FIRST LIMIT 100`);
  for (const r of rows) {
    const id = randomUUID();
    await ctx.db.insert(researchJobs).values({ id, cardId: String(r.id), queue: 'research', label: String(r.name), stage: 'Scheduled refresh', priority: 9 });
    await ctx.queues.research.add('research', { researchJobId: id, cardId: String(r.id), priority: 9, reason: 'REFRESH' }, { jobId: id, priority: 9 });
  }
  if (rows.length) ctx.log.info({ queued: rows.length }, 'scheduled research refresh');
  return rows.length;
}

export async function processMaintenance(ctx: WorkerContext, job: Job) {
  switch (job.name) {
    case 'recover-stale':
      return { recovered: await recoverStale(ctx) };
    case 'refresh-research':
      return { queued: await refreshResearch(ctx) };
    case 'value-snapshots':
      await snapshotCollectionValues(ctx);
      return { ok: true };
    case 'ocr-label':
      return labelReviewed(ctx, job.data as { scanId: string; cardId: string });
    case 'ocr-evaluate':
      return evaluate(ctx, job.data as { evaluationId: string });
    case 'ocr-export-dataset':
      return exportDataset(ctx);
    case 'ocr-watch':
      return runWatch(ctx);
    case 'ocr-scan-models':
      return scanModels(ctx);
    case 'ocr-import-harvest':
      return importHarvest(ctx, job.data as { limit?: number });
    case 'ocr-train-model':
      return trainModel(ctx, job.data as { dataset?: string; epochs?: number; synthetic?: number; maxMinutes?: number });
    case 'ocr-python-setup':
      return setupOcrPython(ctx);
    case 'ocr-vision-train':
      return trainWithVision(ctx, job.data as VisionTrainRequest);
    case 'prune':
      await pruneSamples(ctx);
      await ctx.db.execute(sql`DELETE FROM sessions WHERE expires_at < now()`);
      await ctx.db.execute(sql`DELETE FROM research_results WHERE created_at < now() - interval '90 days'`);
      await ctx.db.execute(sql`DELETE FROM workers WHERE last_heartbeat < now() - interval '7 days'`);
      return { ok: true };
    default:
      return null;
  }
}

export async function scheduleMaintenance(ctx: WorkerContext) {
  const m = ctx.queues.maintenance;
  await m.upsertJobScheduler('recover-stale', { every: 5 * 60_000 }, { name: 'recover-stale' });
  await m.upsertJobScheduler('refresh-research', { every: 60 * 60_000 }, { name: 'refresh-research' });
  await m.upsertJobScheduler('value-snapshots', { every: 60 * 60_000 }, { name: 'value-snapshots' });
  await m.upsertJobScheduler('prune', { pattern: '17 3 * * *' }, { name: 'prune' });
  // live trial statistics and the active model's watch (may roll it back)
  await m.upsertJobScheduler('ocr-watch', { every: 15 * 60_000 }, { name: 'ocr-watch' });
  // pick up models the trainer wrote since the last start
  await m.add('ocr-scan-models', {}, { removeOnComplete: 10, removeOnFail: 10 });
}
