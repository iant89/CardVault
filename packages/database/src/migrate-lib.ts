import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createDb } from './client.js';

/** Locate the repo-level migrations folder from either src/ or dist/. */
export function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.resolve(here, '../../../migrations'),
    path.resolve(process.cwd(), 'migrations'),
  ].filter(Boolean) as string[];
  const found = candidates.find((c) => existsSync(path.join(c, 'meta', '_journal.json')));
  if (!found) throw new Error(`migrations folder not found (looked in ${candidates.join(', ')})`);
  return found;
}

export async function runMigrations(url: string): Promise<void> {
  const { db, sql } = createDb(url, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: migrationsFolder() });
  } finally {
    await sql.end();
  }
}
