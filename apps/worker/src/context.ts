import type { AppConfig } from '@cardvault/config';
import type { Database } from '@cardvault/database';
import type { Queues, EventBus } from '@cardvault/jobs';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { ProviderRegistry } from './providers/registry.js';

export interface WorkerContext {
  config: AppConfig;
  db: Database;
  redis: Redis;
  queues: Queues;
  events: EventBus;
  providers: ProviderRegistry;
  log: Logger;
  storageDir: string;
  workerId: string;
  stats: { processed: number; failed: number };
}
