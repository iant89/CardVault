import type { FastifyInstance } from 'fastify';
import { EventEmitter } from 'node:events';
import { subscribeEvents } from '@cardvault/jobs';
import type { CardVaultEvent } from '@cardvault/shared';
import type { AppContext } from '../context.js';
import { requireUser, user as currentUser } from '../auth/plugin.js';

/**
 * Server-Sent Events relay. Workers publish to Redis; one subscriber per API
 * process fans events out to connected browsers, filtered per user.
 */
export async function eventRoutes(app: FastifyInstance, ctx: AppContext) {
  const bus = new EventEmitter();
  bus.setMaxListeners(1000);
  const sub = subscribeEvents(ctx.config.REDIS_URL, (e) => bus.emit('event', e));
  app.addHook('onClose', async () => sub.close());

  app.get('/api/events', { preHandler: requireUser }, (req, reply) => {
    const me = currentUser(req);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    res.write(`event: hello\ndata: ${JSON.stringify({ userId: me.id, at: new Date().toISOString() })}\n\n`);

    const onEvent = (e: CardVaultEvent) => {
      const visible = e.userId === null || e.userId === me.id || (me.role === 'ADMIN' && e.type === 'WORKER_HEARTBEAT');
      if (!visible) return;
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    bus.on('event', onEvent);
    const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      bus.off('event', onEvent);
    });
  });
}
