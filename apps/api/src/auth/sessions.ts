import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, lt } from '@cardvault/database';
import { sessions, users } from '@cardvault/database';
import type { AppContext } from '../context.js';
import type { SessionUser } from '@cardvault/shared';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function createSession(ctx: AppContext, userId: string, meta: { ua?: string; ip?: string }) {
  const token = randomToken();
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + ctx.config.SESSION_TTL_HOURS * 3600_000);
  await ctx.db.insert(sessions).values({
    id: sha256(token),
    userId,
    csrfToken,
    userAgent: meta.ua?.slice(0, 300) ?? null,
    ip: meta.ip ?? null,
    expiresAt,
  });
  return { token, csrfToken, expiresAt };
}

export interface LoadedSession {
  id: string;
  csrfToken: string;
  user: SessionUser;
}

export async function loadSession(ctx: AppContext, token: string): Promise<LoadedSession | null> {
  const id = sha256(token);
  const rows = await ctx.db
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date()), eq(users.active, true)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // sliding expiry, at most once per 5 minutes
  if (Date.now() - row.s.lastSeenAt.getTime() > 5 * 60_000) {
    await ctx.db
      .update(sessions)
      .set({ lastSeenAt: new Date(), expiresAt: new Date(Date.now() + ctx.config.SESSION_TTL_HOURS * 3600_000) })
      .where(eq(sessions.id, id));
  }
  return {
    id,
    csrfToken: row.s.csrfToken,
    user: { id: row.u.id, username: row.u.username, displayName: row.u.displayName, avatar: row.u.avatar, role: row.u.role },
  };
}

export const destroySession = (ctx: AppContext, id: string) => ctx.db.delete(sessions).where(eq(sessions.id, id));
export const destroyUserSessions = (ctx: AppContext, userId: string) => ctx.db.delete(sessions).where(eq(sessions.userId, userId));
export const purgeExpiredSessions = (ctx: AppContext) => ctx.db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
