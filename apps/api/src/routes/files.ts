import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveStoragePath } from '@cardvault/imaging';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { requireUser } from '../auth/plugin.js';

const TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const ALLOWED_ROOTS = ['scans/', 'thumbnails/', 'cards/', 'users/'];

/** Serves stored images to signed-in household members. Never lists directories. */
export async function fileRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/files/*', { preHandler: requireUser }, async (req, reply) => {
    const rel = decodeURIComponent((req.params as { '*': string })['*'] ?? '');
    if (!ALLOWED_ROOTS.some((r) => rel.startsWith(r)) || rel.includes('\0')) throw notFound();
    const type = TYPES[path.extname(rel).toLowerCase()];
    if (!type) throw notFound();
    let abs: string;
    try {
      abs = resolveStoragePath(ctx.storageDir, rel);
      const s = await stat(abs);
      if (!s.isFile()) throw new Error();
    } catch {
      throw notFound();
    }
    reply.header('content-type', type);
    reply.header('cache-control', 'private, max-age=86400');
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(createReadStream(abs));
  });
}
