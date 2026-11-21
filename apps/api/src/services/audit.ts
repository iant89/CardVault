import type { FastifyRequest } from 'fastify';
import { auditLog } from '@cardvault/database';
import type { AppContext } from '../context.js';

export async function audit(
  ctx: AppContext,
  req: FastifyRequest | null,
  action: string,
  entity: string,
  entityId?: string | null,
  metadata: Record<string, unknown> = {},
  userId?: string | null,
): Promise<void> {
  await ctx.db.insert(auditLog).values({
    userId: userId ?? req?.session?.user.id ?? null,
    action,
    entity,
    entityId: entityId ?? null,
    metadata,
    ip: req?.ip ?? null,
  });
}
