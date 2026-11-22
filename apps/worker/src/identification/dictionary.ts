import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from '@cardvault/database';
import type { GameSlug } from '@cardvault/shared';
import type { WorkerContext } from '../context.js';
import { NameIndex } from './names.js';

/** How long a downloaded name list is used before it is fetched again. */
const REFRESH_MS = 7 * 24 * 3600 * 1000;
/** After a failed download, wait this long before trying again. */
const RETRY_MS = 30 * 60 * 1000;

interface Entry {
  index: NameIndex;
  builtAt: number;
}

const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<NameIndex | null>>();
const failedAt = new Map<string, number>();

const fileFor = (ctx: WorkerContext, game: string) => path.join(ctx.storageDir, 'cache', `card-names-${game}.json`);

/** Names from the card sources that can list them; cached on disk between restarts. */
async function remoteNames(ctx: WorkerContext, game: GameSlug): Promise<string[]> {
  const file = fileFor(ctx, game);
  const age = await stat(file).then((s) => Date.now() - s.mtimeMs, () => Infinity);
  const cached = async () => JSON.parse(await readFile(file, 'utf8')) as string[];
  if (age < REFRESH_MS) return cached().catch(() => []);
  if (Date.now() - (failedAt.get(game) ?? 0) < RETRY_MS) return age < Infinity ? cached().catch(() => []) : [];

  for (const { provider, ctx: pctx } of ctx.providers.forGame(game, 'search')) {
    if (!provider.listCardNames) continue;
    try {
      const names = await provider.listCardNames(game, pctx);
      if (names.length) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, JSON.stringify(names));
        await rename(`${file}.tmp`, file);
        ctx.log.info({ game, provider: provider.id, names: names.length }, 'card name list downloaded');
        return names;
      }
    } catch (e) {
      ctx.log.warn({ game, provider: provider.id, err: (e as Error).message }, 'card name list download failed');
    }
  }
  failedAt.set(game, Date.now());
  // an out-of-date list is still far better than none
  return age < Infinity ? cached().catch(() => []) : [];
}

async function build(ctx: WorkerContext, game: GameSlug): Promise<NameIndex | null> {
  const local = await ctx.db.execute(sql`SELECT DISTINCT c.name FROM cards c JOIN games g ON g.id = c.game_id WHERE g.slug = ${game}`);
  const names = [...(await remoteNames(ctx, game)), ...local.map((r) => String(r.name))];
  return names.length ? new NameIndex(names) : null;
}

/**
 * Index of every known card name for a game: the source's full name list
 * plus the local catalog. Built once and kept in memory; rebuilt hourly so new
 * catalog cards are included. Returns null if no names are available.
 */
export async function nameIndex(ctx: WorkerContext, game: GameSlug): Promise<NameIndex | null> {
  const e = cache.get(game);
  if (e && Date.now() - e.builtAt < 3600_000) return e.index;
  let p = pending.get(game);
  if (!p) {
    p = build(ctx, game)
      .then((index) => {
        if (index) cache.set(game, { index, builtAt: Date.now() });
        return index ?? e?.index ?? null;
      })
      .catch((err) => {
        ctx.log.warn({ game, err: (err as Error).message }, 'card name index unavailable');
        return e?.index ?? null;
      })
      .finally(() => pending.delete(game));
    pending.set(game, p);
  }
  return p;
}
