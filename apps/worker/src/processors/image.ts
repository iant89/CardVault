import type { Job } from 'bullmq';
import { eq, cards, games } from '@cardvault/database';
import { normalizeUpload, makeThumbnail, writeFileSafe } from '@cardvault/imaging';
import type { HttpClient } from '@cardvault/provider-sdk';
import type { ImageJobData } from '@cardvault/shared';
import type { WorkerContext } from '../context.js';

/** Download a catalog image (through the SSRF-guarded client), store locally and hash it. */
export async function processImage(ctx: WorkerContext, job: Job<ImageJobData>, http: HttpClient) {
  if (job.data.kind !== 'CATALOG_HASH' || !job.data.cardId) return;
  const [row] = await ctx.db.select({ c: cards, g: games }).from(cards).innerJoin(games, eq(games.id, cards.gameId)).where(eq(cards.id, job.data.cardId));
  if (!row?.c.imageUrl) return;
  const res = await http.request(row.c.imageUrl, { headers: { accept: 'image/*' }, maxBytes: 15 * 1024 * 1024 });
  const img = await normalizeUpload(res.body, 1000);
  const rel = `cards/${row.g.slug}/${row.c.id}.jpg`;
  await writeFileSafe(ctx.storageDir, rel, img.buffer);
  await writeFileSafe(ctx.storageDir, `thumbnails/cards/${row.g.slug}/${row.c.id}.webp`, await makeThumbnail(img.buffer));
  await ctx.db.update(cards).set({ imagePath: rel, imageHash: img.dhash, updatedAt: new Date() }).where(eq(cards.id, row.c.id));
}
