import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = PostgresJsDatabase<typeof schema>;

export function createDb(url: string, opts: { max?: number } = {}): { db: Database; sql: postgres.Sql } {
  const client = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  return { db: drizzle(client, { schema }), sql: client };
}
