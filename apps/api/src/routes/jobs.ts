import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, sql, researchJobs, researchResults } from '@cardvault/database';
import { TERMINAL_JOB_STATES, type JobState } from '@cardvault/shared';
import type { AppContext } from '../context.js';
import { badRequest, forbidden, notFound, parse } from '../errors.js';
import { requireUser, user as currentUser } from '../auth/plugin.js';
import { audit } from '../services/audit.js';

const uuid = z.string().uuid();

export async function jobRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/jobs', { preHandler: requireUser }, async (req) => {
    const me = currentUser(req);
    const q = parse(
      z.object({
        status: z.string().optional(),
        scope: z.enum(['mine', 'all']).default('mine'),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      req.query,
    );
    const statuses = q.status?.split(',').filter(Boolean);
    const rows = await ctx.db.execute(sql`
      SELECT j.*, c.name AS card_name, s.thumbnail_path, u.display_name AS owner_name
      FROM research_jobs j LEFT JOIN cards c ON c.id = j.card_id LEFT JOIN scans s ON s.id = j.scan_id
      LEFT JOIN users u ON u.id = j.user_id
      WHERE true
        ${q.scope === 'mine' || me.role !== 'ADMIN' ? sql`AND (j.user_id = ${me.id} OR j.user_id IS NULL)` : sql``}
        ${statuses?.length ? sql`AND j.status::text IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})` : sql``}
      ORDER BY CASE WHEN j.status IN ('PROCESSING','MATCHING','RESEARCHING','PRICING') THEN 0 WHEN j.status = 'QUEUED' THEN 1 ELSE 2 END,
        COALESCE(j.completed_at, j.started_at, j.created_at) DESC
      LIMIT ${q.limit}`);
    const counts = await ctx.db.execute(sql`
      SELECT status, count(*)::int AS n FROM research_jobs
      WHERE created_at > now() - interval '7 days' ${me.role !== 'ADMIN' || q.scope === 'mine' ? sql`AND (user_id = ${me.id} OR user_id IS NULL)` : sql``}
      GROUP BY status`);
    return {
      jobs: rows.map((r) => ({
        id: r.id,
        queue: r.queue,
        status: r.status,
        stage: r.stage,
        label: r.card_name ?? r.label,
        progress: r.progress,
        attempts: r.attempts,
        priority: r.priority,
        error: r.error,
        scanId: r.scan_id,
        cardId: r.card_id,
        ownerName: r.owner_name,
        thumbnail: r.thumbnail_path ? `/api/files/${r.thumbnail_path}` : null,
        createdAt: r.created_at,
        startedAt: r.started_at,
        completedAt: r.completed_at,
      })),
      counts: Object.fromEntries(counts.map((c) => [String(c.status), Number(c.n)])),
    };
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id', { preHandler: requireUser }, async (req) => {
    parse(uuid, req.params.id);
    const me = currentUser(req);
    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, req.params.id));
    if (!job) throw notFound();
    if (job.userId && job.userId !== me.id && me.role !== 'ADMIN') throw forbidden();
    const results = await ctx.db
      .select({ id: researchResults.id, sourceId: researchResults.sourceId, error: researchResults.error, createdAt: researchResults.createdAt, normalizedData: researchResults.normalizedData })
      .from(researchResults)
      .where(eq(researchResults.jobId, job.id));
    return { job, results };
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', { preHandler: requireUser }, async (req) => {
    parse(uuid, req.params.id);
    const me = currentUser(req);
    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, req.params.id));
    if (!job) throw notFound();
    if (job.userId && job.userId !== me.id && me.role !== 'ADMIN') throw forbidden();
    if (!['FAILED', 'CANCELLED', 'COMPLETED'].includes(job.status)) throw badRequest('Job is still active');
    const queue = job.queue === 'identification' ? ctx.queues.identification : ctx.queues.research;
    const old = await queue.getJob(job.id);
    if (old) await old.remove().catch(() => undefined);
    await ctx.db.update(researchJobs).set({ status: 'QUEUED', error: null, progress: 0, stage: 'Retry queued', completedAt: null }).where(eq(researchJobs.id, job.id));
    if (job.queue === 'identification') {
      if (!job.scanId) throw badRequest('Job has no scan');
      await ctx.queues.identification.add('identify', { scanId: job.scanId, userId: job.userId ?? me.id }, { jobId: job.id, priority: 2 });
    } else {
      if (!job.cardId) throw badRequest('Job has no card');
      await ctx.queues.research.add('research', { researchJobId: job.id, cardId: job.cardId, scanId: job.scanId, userId: job.userId, priority: 2, reason: 'RETRY' }, { jobId: job.id, priority: 2 });
    }
    await audit(ctx, req, 'job.retry', 'research_job', job.id);
    await ctx.events.publish({ type: 'JOB_CREATED', userId: job.userId, jobId: job.id, state: 'QUEUED', message: 'Retry queued' });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', { preHandler: requireUser }, async (req) => {
    parse(uuid, req.params.id);
    const me = currentUser(req);
    const [job] = await ctx.db.select().from(researchJobs).where(eq(researchJobs.id, req.params.id));
    if (!job) throw notFound();
    if (job.userId && job.userId !== me.id && me.role !== 'ADMIN') throw forbidden();
    if (TERMINAL_JOB_STATES.includes(job.status as JobState)) throw badRequest('Job already finished');
    const queue = job.queue === 'identification' ? ctx.queues.identification : ctx.queues.research;
    const bull = await queue.getJob(job.id);
    // Waiting jobs are removed; active jobs see CANCELLED at their next stage checkpoint
    if (bull && !(await bull.isActive())) await bull.remove().catch(() => undefined);
    await ctx.db.update(researchJobs).set({ status: 'CANCELLED', completedAt: new Date(), stage: 'Cancelled' }).where(eq(researchJobs.id, job.id));
    await audit(ctx, req, 'job.cancel', 'research_job', job.id);
    await ctx.events.publish({ type: 'JOB_FAILED', userId: job.userId, jobId: job.id, state: 'CANCELLED', message: 'Cancelled' });
    return { ok: true };
  });
}
