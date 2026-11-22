import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import type { AppContext } from './context.js';
import { HttpProblem } from './errors.js';
import { registerAuth } from './auth/plugin.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { scanRoutes } from './routes/scans.js';
import { cardRoutes } from './routes/cards.js';
import { collectionRoutes } from './routes/collection.js';
import { jobRoutes } from './routes/jobs.js';
import { manualReviewRoutes } from './routes/manual-review.js';
import { searchRoutes } from './routes/search.js';
import { adminRoutes } from './routes/admin.js';
import { fileRoutes } from './routes/files.js';
import { eventRoutes } from './websocket/events.js';

export async function buildApp(ctx: AppContext) {
  const app = Fastify({
    logger: {
      level: ctx.config.NODE_ENV === 'production' ? 'info' : 'debug',
      redact: ['req.headers.cookie', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
      ...(ctx.config.NODE_ENV === 'development' ? {} : {}),
    },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  // No HSTS: CardVault is served over plain HTTP on the LAN (port 8080) *and*
  // optionally over HTTPS via Caddy. An HSTS header seen once over HTTPS would
  // make browsers rewrite http://host:8080 to https://host:8080 for a year
  // ("SSL received a record that exceeded the maximum permissible length").
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-origin' }, strictTransportSecurity: false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 1200, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: ctx.config.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 20 } });

  registerAuth(app, ctx);

  app.setErrorHandler((err: FastifyError | HttpProblem, req, reply) => {
    if (err instanceof HttpProblem) {
      return reply.code(err.statusCode).send({ error: err.message, details: err.details });
    }
    const status = (err as FastifyError).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    if ((err as FastifyError).code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({ error: `Image exceeds ${ctx.config.MAX_UPLOAD_MB} MB` });
    }
    return reply.code(status).send({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  for (const r of [authRoutes, userRoutes, scanRoutes, cardRoutes, collectionRoutes, jobRoutes, manualReviewRoutes, searchRoutes, adminRoutes, fileRoutes, eventRoutes]) {
    await r(app, ctx);
  }
  return app;
}
