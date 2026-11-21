import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asc, eq, games, sets, sql } from '@cardvault/database';
import type { AppContext } from '../context.js';
import { parse } from '../errors.js';
import { requireUser, user as currentUser } from '../auth/plugin.js';
import { searchCards } from '../services/cards.js';
import { listCollection } from '../services/collection.js';

export async function searchRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Global search across the normalized catalog and the user's collection. */
  app.get('/api/search', { preHandler: requireUser }, async (req) => {
    const q = parse(
      z.object({ q: z.string().min(1).max(200), game: z.string().max(32).optional(), limit: z.coerce.number().int().max(100).default(24) }),
      req.query,
    );
    const me = currentUser(req);
    const [catalog, owned] = await Promise.all([
      searchCards(ctx, { q: q.q, game: q.game }, 1, q.limit),
      listCollection(ctx, { q: q.q, game: q.game, userId: me.id, sort: 'value' }, 1, q.limit),
    ]);
    return { cards: catalog.items, totalCards: catalog.total, collection: owned.items, totalCollection: owned.total };
  });

  app.get('/api/games', { preHandler: requireUser }, async () => {
    const rows = await ctx.db.execute(sql`
      SELECT g.id, g.slug, g.name, count(c.id)::int AS cards FROM games g LEFT JOIN cards c ON c.game_id = g.id
      GROUP BY g.id ORDER BY g.sort_order`);
    return { games: rows };
  });

  app.get('/api/sets', { preHandler: requireUser }, async (req) => {
    const q = parse(z.object({ game: z.string().max(32).optional() }), req.query);
    const base = ctx.db
      .select({ id: sets.id, name: sets.name, code: sets.code, releaseDate: sets.releaseDate, totalCards: sets.totalCards, game: games.slug })
      .from(sets)
      .innerJoin(games, eq(games.id, sets.gameId));
    const rows = await (q.game ? base.where(eq(games.slug, q.game)) : base).orderBy(asc(sets.releaseDate));
    return { sets: rows };
  });
}
