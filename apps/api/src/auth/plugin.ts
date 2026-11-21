import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@cardvault/shared';
import type { AppContext } from '../context.js';
import { loadSession, safeEqual, type LoadedSession } from './sessions.js';
import { forbidden, unauthorized } from '../errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    session: LoadedSession | null;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Routes that may be called without a session (login itself). */
const CSRF_EXEMPT = new Set(['/api/auth/login']);

export function cookieOptions(ctx: AppContext, httpOnly: boolean, expires?: Date) {
  return {
    path: '/',
    httpOnly,
    secure: ctx.config.COOKIE_SECURE,
    sameSite: 'strict' as const,
    ...(expires ? { expires } : {}),
  };
}

export function registerAuth(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('session', null);

  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    req.session = token ? await loadSession(ctx, token) : null;

    if (SAFE_METHODS.has(req.method) || !req.url.startsWith('/api/')) return;

    // Origin check (defence in depth; SameSite=Strict already blocks most CSRF)
    const origin = req.headers.origin;
    if (origin) {
      const host = req.headers['x-forwarded-host'] ?? req.headers.host;
      let ok = origin === ctx.config.WEB_ORIGIN;
      try {
        ok ||= new URL(origin).host === host;
      } catch {
        ok = false;
      }
      if (!ok) throw forbidden('Cross-origin request rejected');
    }

    const path = req.url.split('?')[0]!;
    if (CSRF_EXEMPT.has(path)) return;
    if (!req.session) throw unauthorized();
    const header = req.headers[CSRF_HEADER];
    if (typeof header !== 'string' || !safeEqual(header, req.session.csrfToken)) {
      throw forbidden('Invalid CSRF token');
    }
  });
}

export async function requireUser(req: FastifyRequest): Promise<void> {
  if (!req.session) throw unauthorized();
}

export async function requireAdmin(req: FastifyRequest): Promise<void> {
  if (!req.session) throw unauthorized();
  if (req.session.user.role !== 'ADMIN') throw forbidden('Administrator only');
}

export const user = (req: FastifyRequest) => {
  if (!req.session) throw unauthorized();
  return req.session.user;
};

export function setSessionCookies(ctx: AppContext, reply: FastifyReply, token: string, csrf: string, expires: Date) {
  reply.setCookie(SESSION_COOKIE, token, cookieOptions(ctx, true, expires));
  reply.setCookie(CSRF_COOKIE, csrf, cookieOptions(ctx, false, expires));
}

export function clearSessionCookies(ctx: AppContext, reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, cookieOptions(ctx, true));
  reply.clearCookie(CSRF_COOKIE, cookieOptions(ctx, false));
}
