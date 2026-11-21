import { hostname } from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { Worker } from 'bullmq';
import pino from 'pino';
import { loadConfig } from '@cardvault/config';
import { createDb, runMigrations, seedCatalog, sql, workers } from '@cardvault/database';
import { createQueues, createRedis, EventBus } from '@cardvault/jobs';
import { HttpClient } from '@cardvault/provider-sdk';
import { QUEUE_NAMES } from '@cardvault/shared';
import type { WorkerContext } from './context.js';
import { ALL_PROVIDERS, ProviderRegistry } from './providers/registry.js';
import { processIdentification } from './processors/identification.js';
import { processResearch } from './processors/research.js';
import { processImage } from './processors/image.js';
import { processMaintenance, scheduleMaintenance } from './processors/maintenance.js';
import { computeSnapshots } from './pricing/compute.js';
import { shutdownOcr } from './identification/ocr.js';

// load nearest .env for local development
for (let dir = process.cwd(), i = 0; i < 4; i++, dir = path.dirname(dir)) {
  const f = path.join(dir, '.env');
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
  }
  if (process.env.STORAGE_DIR && !path.isAbsolute(process.env.STORAGE_DIR)) process.env.STORAGE_DIR = path.resolve(dir, process.env.STORAGE_DIR);
  break;
}

const VERSION = '0.1.0';
const config = loadConfig();
const log = pino({ level: config.NODE_ENV === 'production' ? 'info' : 'debug', base: { svc: 'worker' } });
if (process.env.AUTO_MIGRATE !== 'false') await runMigrations(config.DATABASE_URL);
const { db, sql: pg } = createDb(config.DATABASE_URL);
await seedCatalog(db);
const redis = createRedis(config.REDIS_URL);
const queues = createQueues(redis);
const storageDir = path.resolve(config.STORAGE_DIR);
await mkdir(storageDir, { recursive: true });
const workerId = `${hostname()}-${process.pid}`;

const providers = new ProviderRegistry(ALL_PROVIDERS, db, log, process.env, config.CRAWLER_USER_AGENT);
await providers.sync();

const ctx: WorkerContext = { config, db, redis, queues, events: new EventBus(redis), providers, log, storageDir, workerId, stats: { processed: 0, failed: 0 } };

// Image downloads may only reach provider image CDNs
const imageHttp = new HttpClient({
  providerId: 'images',
  userAgent: config.CRAWLER_USER_AGENT,
  rateLimit: { requests: 4, intervalMs: 1000 },
  allowedHosts: ALL_PROVIDERS.flatMap((p) => p.allowedHosts),
  log,
});

const connection = createRedis(config.REDIS_URL);
const common = { connection, lockDuration: 120_000, stalledInterval: 30_000, maxStalledCount: 2 };
const bull = [
  new Worker(QUEUE_NAMES.identification, (j) => processIdentification(ctx, j), { ...common, concurrency: 1 }),
  new Worker(QUEUE_NAMES.research, (j) => processResearch(ctx, j), { ...common, concurrency: config.WORKER_CONCURRENCY }),
  new Worker(QUEUE_NAMES.pricing, async (j) => computeSnapshots(ctx, j.data.cardId), { ...common, concurrency: 2 }),
  new Worker(QUEUE_NAMES.image, (j) => processImage(ctx, j, imageHttp), { ...common, concurrency: 2 }),
  new Worker(QUEUE_NAMES.maintenance, (j) => processMaintenance(ctx, j), { ...common, concurrency: 1 }),
];
for (const w of bull) {
  w.on('error', (err) => log.error({ queue: w.name, err: err.message }, 'worker error'));
  w.on('failed', (job, err) => log.warn({ queue: w.name, job: job?.id, err: err.message, attempts: job?.attemptsMade }, 'job attempt failed'));
}
await scheduleMaintenance(ctx);

async function heartbeat() {
  await db
    .insert(workers)
    .values({ id: workerId, hostname: hostname(), pid: process.pid, version: VERSION, queues: Object.values(QUEUE_NAMES), jobsProcessed: ctx.stats.processed, jobsFailed: ctx.stats.failed })
    .onConflictDoUpdate({ target: workers.id, set: { lastHeartbeat: sql`now()`, jobsProcessed: ctx.stats.processed, jobsFailed: ctx.stats.failed } });
  await ctx.events.publish({ type: 'WORKER_HEARTBEAT', userId: null, data: { workerId, processed: ctx.stats.processed, failed: ctx.stats.failed } });
}
await heartbeat();
const hb = setInterval(() => void heartbeat().catch((e) => log.warn({ err: e.message }, 'heartbeat failed')), 15_000);
const ps = setInterval(() => void providers.sync().catch((e) => log.warn({ err: e.message }, 'provider sync failed')), 30_000);
log.info({ workerId, providers: ALL_PROVIDERS.map((p) => p.id) }, 'CardVault worker started');

async function shutdown(sig: string) {
  log.info({ sig }, 'shutting down (finishing active jobs)');
  clearInterval(hb);
  clearInterval(ps);
  await Promise.all(bull.map((w) => w.close()));
  await shutdownOcr();
  await providers.sync().catch(() => undefined);
  await queues.close();
  await connection.quit();
  await redis.quit();
  await pg.end();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
