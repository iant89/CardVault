import type { AppConfig } from '@cardvault/config';
import type { Database } from '@cardvault/database';
import type { Queues } from '@cardvault/jobs';
import type { EventBus } from '@cardvault/jobs';
import type { Redis } from 'ioredis';
import type { Sql } from 'postgres';

export interface AppContext {
  config: AppConfig;
  db: Database;
  sql: Sql;
  redis: Redis;
  queues: Queues;
  events: EventBus;
  storageDir: string;
}
