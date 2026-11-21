import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { loadConfig } from '@cardvault/config';
import { createDb } from '@cardvault/database';
import { createQueues, createRedis, EventBus } from '@cardvault/jobs';
import type { AppContext } from './context.js';

export async function createContext(): Promise<AppContext & { close: () => Promise<void> }> {
  const config = loadConfig();
  const { db, sql } = createDb(config.DATABASE_URL);
  const redis = createRedis(config.REDIS_URL);
  const queues = createQueues(redis);
  const storageDir = path.resolve(config.STORAGE_DIR);
  for (const d of ['scans', 'thumbnails', 'cards', 'users']) await mkdir(path.join(storageDir, d), { recursive: true });
  return {
    config,
    db,
    sql,
    redis,
    queues,
    events: new EventBus(redis),
    storageDir,
    close: async () => {
      await queues.close();
      await redis.quit();
      await sql.end();
    },
  };
}
