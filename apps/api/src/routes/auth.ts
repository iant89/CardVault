import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asc, eq, users } from '@cardvault/database';
import { SESSION_COOKIE } from '@cardvault/shared';
import type { AppContext } from '../context.js';
import { parse, unauthorized, HttpProblem } from '../errors.js';
import { verifyPassword, dummyVerify } from '../auth/password.js';
import { createSession, destroySession } from '../auth/sessions.js';
import { setSessionCookies, clearSessionCookies } from '../auth/plugin.js';
import { audit } from '../services/audit.js';

const LOCK_AFTER = 5;
const LOCK_MINUTES = 5;

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Login tiles (Windows-style user picker). Home-LAN app: names & avatars only. */
  app.get('/api/auth/users', async () => {
    const rows = await ctx.db
      .select({ id: users.id, username: users.username, displayName: users.displayName, avatar: users.avatar })
      .from(users)
      .where(eq(users.active, true))
      .orderBy(asc(users.createdAt));
    return { users: rows };
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) }), req.body);
    const [u] = await ctx.db.select().from(users).where(eq(users.username, body.username.toLowerCase())).limit(1);
    if (!u || !u.active) {
      await dummyVerify(body.password);
      throw unauthorized('Incorrect username or password');
    }
    if (u.lockedUntil && u.lockedUntil > new Date()) {
      throw new HttpProblem(423, `Too many attempts. Try again after ${u.lockedUntil.toLocaleTimeString()}`);
    }
    const ok = await verifyPassword(u.passwordHash, body.password);
    if (!ok) {
      const failed = u.failedLogins + 1;
      await ctx.db
        .update(users)
        .set({ failedLogins: failed, lockedUntil: failed >= LOCK_AFTER ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null })
        .where(eq(users.id, u.id));
      await audit(ctx, req, 'auth.login_failed', 'user', u.id, { failed }, u.id);
      throw unauthorized('Incorrect password');
    }
    await ctx.db.update(users).set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, u.id));
    const s = await createSession(ctx, u.id, { ua: req.headers['user-agent'], ip: req.ip });
    setSessionCookies(ctx, reply, s.token, s.csrfToken, s.expiresAt);
    await audit(ctx, req, 'auth.login', 'user', u.id, {}, u.id);
    return {
      user: { id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar, role: u.role },
      csrfToken: s.csrfToken,
    };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.session) {
      await destroySession(ctx, req.session.id);
      await audit(ctx, req, 'auth.logout', 'user', req.session.user.id);
    }
    clearSessionCookies(ctx, reply);
    return { ok: true };
  });

  app.get('/api/auth/session', async (req) => {
    if (!req.session || !req.cookies[SESSION_COOKIE]) return { user: null, csrfToken: null };
    return { user: req.session.user, csrfToken: req.session.csrfToken };
  });
}
