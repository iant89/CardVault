import { request } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { requireAdmin } from '../auth/plugin.js';
import { HarvesterManager } from '../services/harvester.js';

/** Where the harvester's own web app is served, through CardVault. */
export const HARVESTER_APP = '/api/dev/harvester/app/';

/** Response headers passed back from the harvester. */
const PASS_HEADERS = ['content-type', 'content-length', 'cache-control', 'last-modified', 'etag'];

/**
 * Developer tools for administrators: start/stop the TCGdex Harvester and
 * reach its dashboard through CardVault's own address. The harvester itself
 * only listens on 127.0.0.1, so it is never exposed to the network directly;
 * CardVault's session, admin check, Origin check and CSRF token guard every
 * request before it is passed on.
 */
export async function devRoutes(app: FastifyInstance, ctx: AppContext) {
  if (!ctx.config.DEV_TOOLS) return;
  const harvester = new HarvesterManager(ctx.config);
  const guard = { preHandler: requireAdmin, config: { rateLimit: false as const } };

  app.get('/api/dev/tools', guard, async () => ({
    tools: [{ id: 'tcgdex-harvester', name: 'TCGdex Harvester', url: HARVESTER_APP, ...(await harvester.status()) }],
  }));
  app.get('/api/dev/harvester/status', guard, async () => harvester.status());
  app.post('/api/dev/harvester/start', guard, async (_req, reply) => {
    try {
      return { ...(await harvester.start()), url: HARVESTER_APP };
    } catch (e) {
      return reply.code(503).send({ error: (e as Error).message });
    }
  });
  app.post('/api/dev/harvester/stop', guard, async (_req, reply) => {
    try {
      return await harvester.stop();
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  // the dashboard uses relative links, so it needs the trailing slash
  app.get('/api/dev/harvester/app', guard, async (_req, reply) => reply.redirect(HARVESTER_APP, 302));

  const proxy = async (req: FastifyRequest, reply: FastifyReply) => {
    const rest = req.url.slice(HARVESTER_APP.length - 1); // keeps the leading "/" and the query string
    if (!rest.startsWith('/') || rest.startsWith('//')) return reply.code(400).send({ error: 'bad path' });
    const port = harvester.port;
    const body = req.method === 'POST' ? Buffer.from(JSON.stringify(req.body ?? {})) : undefined;

    reply.hijack();
    const out = reply.raw;
    const upstream = request(
      {
        host: '127.0.0.1',
        port,
        method: req.method,
        path: rest,
        // a fresh, minimal request: no cookies or CardVault headers are passed on
        headers: {
          host: `127.0.0.1:${port}`,
          accept: req.headers.accept ?? '*/*',
          ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}),
        },
      },
      (res) => {
        const headers: Record<string, string> = { 'x-content-type-options': 'nosniff' };
        for (const h of PASS_HEADERS) {
          const v = res.headers[h];
          if (typeof v === 'string') headers[h] = v;
        }
        if (headers['content-type']?.startsWith('text/event-stream')) {
          // live feed: nginx must not buffer it
          headers['x-accel-buffering'] = 'no';
          headers['cache-control'] = 'no-store';
          headers.connection = 'keep-alive';
        }
        out.writeHead(res.statusCode ?? 502, headers);
        res.pipe(out);
      },
    );
    out.on('close', () => upstream.destroy());
    upstream.on('error', () => {
      if (out.headersSent) return out.destroy();
      out.writeHead(502, { 'content-type': 'application/json' });
      out.end(JSON.stringify({ error: 'The TCGdex Harvester is not running. Start it from the Developer menu.' }));
    });
    upstream.end(body);
  };
  app.route({ method: ['GET', 'POST'], url: `${HARVESTER_APP}*`, ...guard, handler: proxy });
}
