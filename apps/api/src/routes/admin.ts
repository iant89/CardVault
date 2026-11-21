import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { statfs } from 'node:fs/promises';
import { desc, eq, sql, researchSources, workers, auditLog } from '@cardvault/database';
import type { AppContext } from '../context.js';
import { notFound, parse } from '../errors.js';
import { requireAdmin, requireUser } from '../auth/plugin.js';
import { audit } from '../services/audit.js';
import { enqueueResearch } from '../services/pipeline.js';

const ONLINE_MS = 60_000;

async function check(fn: () => Promise<unknown>): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const t = Date.now();
  try {
    await fn();
    return { ok: true, latencyMs: Date.now() - t };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t, error: (e as Error).message };
  }
}

export async function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/admin/system', { preHandler: requireAdmin }, async () => {
    const [database, redis] = await Promise.all([check(() => ctx.db.execute(sql`SELECT 1`)), check(() => ctx.redis.ping())]);
    const workerRows = await ctx.db.select().from(workers).orderBy(desc(workers.lastHeartbeat));
    const queues: Record<string, Record<string, number>> = {};
    if (redis.ok) {
      for (const q of ctx.queues.all) queues[q.name] = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed', 'prioritized', 'paused');
    }
    const reviews = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM manual_reviews WHERE status = 'OPEN'`);
    let storage: { totalBytes: number; freeBytes: number } | null = null;
    try {
      const s = await statfs(ctx.storageDir);
      storage = { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
    } catch {
      storage = null;
    }
    const dbStats = await ctx.db.execute(sql`
      SELECT (SELECT count(*) FROM cards)::int AS cards, (SELECT count(*) FROM collection_items)::int AS items,
        (SELECT count(*) FROM price_observations)::int AS observations, (SELECT count(*) FROM scans)::int AS scans,
        pg_database_size(current_database())::bigint AS bytes`);
    const now = Date.now();
    return {
      api: { ok: true, uptimeSec: Math.round(process.uptime()), version: process.env.npm_package_version ?? '0.1.0' },
      database: { ...database, stats: dbStats[0] },
      redis,
      workers: workerRows.map((w) => ({ ...w, online: now - w.lastHeartbeat.getTime() < ONLINE_MS })),
      queues,
      manualReviewOpen: Number(reviews[0]?.n ?? 0),
      storage,
    };
  });

  app.get('/api/admin/providers', { preHandler: requireUser }, async () => ({
    providers: await ctx.db.select().from(researchSources).orderBy(researchSources.name),
  }));

  app.patch<{ Params: { id: string } }>('/api/admin/providers/:id', { preHandler: requireAdmin }, async (req) => {
    const b = parse(z.object({ enabled: z.boolean() }), req.body);
    const [row] = await ctx.db.update(researchSources).set({ enabled: b.enabled, updatedAt: new Date() }).where(eq(researchSources.id, req.params.id)).returning();
    if (!row) throw notFound();
    await audit(ctx, req, b.enabled ? 'provider.enable' : 'provider.disable', 'research_source', row.id);
    return { provider: row };
  });

  /** Re-queue research for stale cards (the worker also does this on a schedule). */
  app.post('/api/admin/research/refresh', { preHandler: requireAdmin }, async (req) => {
    const b = parse(z.object({ limit: z.number().int().min(1).max(5000).default(200) }).default({ limit: 200 }), req.body ?? {});
    const rows = await ctx.db.execute(sql`
      SELECT DISTINCT c.id, c.last_researched_at FROM cards c JOIN collection_items ci ON ci.card_id = c.id
      ORDER BY c.last_researched_at ASC NULLS FIRST LIMIT ${b.limit}`);
    for (const r of rows) await enqueueResearch(ctx, { cardId: String(r.id), priority: 8, reason: 'REFRESH' });
    await audit(ctx, req, 'research.refresh', 'research_job', null, { count: rows.length });
    return { queued: rows.length };
  });

  app.post<{ Params: { name: string } }>('/api/admin/queues/:name/:action', { preHandler: requireAdmin }, async (req) => {
    const { name, action } = req.params as { name: string; action: string };
    const q = ctx.queues.all.find((x) => x.name === name);
    if (!q) throw notFound('Unknown queue');
    if (action === 'pause') await q.pause();
    else if (action === 'resume') await q.resume();
    else if (action === 'retry-failed') {
      const failed = await q.getFailed(0, 500);
      await Promise.all(failed.map((j) => j.retry().catch(() => undefined)));
    } else throw notFound('Unknown action');
    await audit(ctx, req, `queue.${action}`, 'queue', name);
    return { ok: true };
  });

  app.get('/api/admin/audit', { preHandler: requireAdmin }, async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().int().max(500).default(100) }), req.query);
    return { entries: await ctx.db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(q.limit) };
  });
}
