import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asc, eq, users, sql } from '@cardvault/database';
import { ROLES } from '@cardvault/shared';
import { makeThumbnail, normalizeUpload, writeFileSafe } from '@cardvault/imaging';
import type { AppContext } from '../context.js';
import { badRequest, conflict, forbidden, notFound, parse } from '../errors.js';
import { requireAdmin, requireUser, user as currentUser } from '../auth/plugin.js';
import { hashPassword, passwordProblems, verifyPassword } from '../auth/password.js';
import { destroyUserSessions } from '../auth/sessions.js';
import { audit } from '../services/audit.js';

const publicCols = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  avatar: users.avatar,
  role: users.role,
  active: users.active,
  createdAt: users.createdAt,
  lastLoginAt: users.lastLoginAt,
};

const username = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9._-]+$/i, 'Letters, numbers, dot, dash and underscore only')
  .transform((s) => s.toLowerCase());

export async function userRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/users', { preHandler: requireUser }, async () => ({
    users: await ctx.db.select(publicCols).from(users).orderBy(asc(users.createdAt)),
  }));

  app.post('/api/users', { preHandler: requireAdmin }, async (req) => {
    const b = parse(
      z.object({
        username,
        displayName: z.string().min(1).max(64),
        password: z.string(),
        role: z.enum(ROLES).default('USER'),
        avatar: z.string().max(200).nullish(),
      }),
      req.body,
    );
    const problem = passwordProblems(b.password);
    if (problem) throw badRequest(problem);
    const exists = await ctx.db.select({ id: users.id }).from(users).where(eq(users.username, b.username));
    if (exists.length) throw conflict('Username already exists');
    const [row] = await ctx.db
      .insert(users)
      .values({ username: b.username, displayName: b.displayName, role: b.role, avatar: b.avatar ?? null, passwordHash: await hashPassword(b.password) })
      .returning(publicCols);
    await audit(ctx, req, 'user.create', 'user', row!.id, { username: b.username, role: b.role });
    return { user: row };
  });

  app.patch<{ Params: { id: string } }>('/api/users/:id', { preHandler: requireUser }, async (req) => {
    const me = currentUser(req);
    const isAdmin = me.role === 'ADMIN';
    if (!isAdmin && me.id !== req.params.id) throw forbidden();
    const b = parse(
      z.object({
        displayName: z.string().min(1).max(64).optional(),
        avatar: z.string().max(200).nullish(),
        password: z.string().optional(),
        currentPassword: z.string().optional(),
        role: z.enum(ROLES).optional(),
        active: z.boolean().optional(),
      }),
      req.body,
    );
    const [target] = await ctx.db.select().from(users).where(eq(users.id, req.params.id));
    if (!target) throw notFound();
    if ((b.role || b.active !== undefined) && !isAdmin) throw forbidden('Only administrators can change roles');
    if (isAdmin && me.id === target.id && (b.role === 'USER' || b.active === false)) {
      const [{ n }] = (await ctx.db.execute(sql`SELECT count(*)::int AS n FROM users WHERE role = 'ADMIN' AND active`)) as unknown as [{ n: number }];
      if (n <= 1) throw badRequest('Cannot demote or disable the last administrator');
    }
    const patch: Partial<typeof users.$inferInsert> = {};
    if (b.displayName) patch.displayName = b.displayName;
    if (b.avatar !== undefined) patch.avatar = b.avatar;
    if (b.role) patch.role = b.role;
    if (b.active !== undefined) patch.active = b.active;
    if (b.password) {
      const problem = passwordProblems(b.password);
      if (problem) throw badRequest(problem);
      // users changing their own password must prove the current one
      if (me.id === target.id && !(b.currentPassword && (await verifyPassword(target.passwordHash, b.currentPassword)))) {
        throw badRequest('Current password is incorrect');
      }
      patch.passwordHash = await hashPassword(b.password);
      patch.failedLogins = 0;
      patch.lockedUntil = null;
    }
    const [row] = await ctx.db.update(users).set(patch).where(eq(users.id, target.id)).returning(publicCols);
    if (b.password && me.id !== target.id) await destroyUserSessions(ctx, target.id);
    if (b.active === false) await destroyUserSessions(ctx, target.id);
    await audit(ctx, req, 'user.update', 'user', target.id, { fields: Object.keys(patch).filter((k) => k !== 'passwordHash') });
    return { user: row };
  });

  app.post<{ Params: { id: string } }>('/api/users/:id/avatar', { preHandler: requireUser }, async (req) => {
    const me = currentUser(req);
    if (me.role !== 'ADMIN' && me.id !== req.params.id) throw forbidden();
    const file = await req.file();
    if (!file) throw badRequest('No file');
    const img = await normalizeUpload(await file.toBuffer(), 512);
    const rel = `users/${req.params.id}.webp`;
    await writeFileSafe(ctx.storageDir, rel, await makeThumbnail(img.buffer, 256));
    const avatar = `file:${rel}?v=${Date.now()}`;
    const [row] = await ctx.db.update(users).set({ avatar }).where(eq(users.id, req.params.id)).returning(publicCols);
    if (!row) throw notFound();
    return { user: row };
  });

  app.delete<{ Params: { id: string } }>('/api/users/:id', { preHandler: requireAdmin }, async (req) => {
    const me = currentUser(req);
    if (me.id === req.params.id) throw badRequest('You cannot delete yourself');
    // Soft delete keeps collections, scans and audit history intact
    const [row] = await ctx.db.update(users).set({ active: false }).where(eq(users.id, req.params.id)).returning(publicCols);
    if (!row) throw notFound();
    await destroyUserSessions(ctx, row.id);
    await audit(ctx, req, 'user.deactivate', 'user', row.id);
    return { ok: true };
  });
}
