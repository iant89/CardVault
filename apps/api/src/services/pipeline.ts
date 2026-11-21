import { randomUUID } from 'node:crypto';
import { and, eq, sql, collectionItems, researchJobs, scans, cards, cardVariants } from '@cardvault/database';
import { normalizeUpload, makeThumbnail, writeFileSafe } from '@cardvault/imaging';
import type { SessionUser } from '@cardvault/shared';
import type { AppContext } from '../context.js';

const month = () => new Date().toISOString().slice(0, 7);

export interface DuplicateInfo {
  scanId: string;
  cardId: string | null;
  cardName: string | null;
  createdAt: string;
  distance: number;
}

/** Find a visually near-identical earlier scan by this user (256-bit dHash Hamming ≤ 16). */
export async function findDuplicateScan(ctx: AppContext, userId: string, dhash: string, sha: string): Promise<DuplicateInfo | null> {
  const rows = await ctx.db.execute(sql`
    SELECT s.id, s.card_id, c.name, s.created_at,
      bit_count(('x' || s.image_hash)::bit(256) # ('x' || ${dhash})::bit(256))::int AS dist
    FROM scans s LEFT JOIN cards c ON c.id = s.card_id
    WHERE s.user_id = ${userId} AND length(s.image_hash) = 64 AND s.status <> 'REJECTED'
      AND (s.content_hash = ${sha} OR bit_count(('x' || s.image_hash)::bit(256) # ('x' || ${dhash})::bit(256)) <= 16)
    ORDER BY dist, s.created_at DESC LIMIT 1`);
  const r = rows[0];
  return r
    ? { scanId: String(r.id), cardId: (r.card_id as string) ?? null, cardName: (r.name as string) ?? null, createdAt: new Date(r.created_at as string).toISOString(), distance: Number(r.dist) }
    : null;
}

export interface CreateScanInput {
  buffer: Buffer;
  clientScanId?: string;
  gameHint?: string;
  clientOcr?: string;
  capturedAt?: Date;
  allowDuplicate?: boolean;
  clientQuality?: Record<string, unknown>;
}

export type CreateScanResult =
  | { kind: 'created'; scanId: string; jobId: string }
  | { kind: 'existing'; scanId: string; jobId: string | null }
  | { kind: 'duplicate'; duplicate: DuplicateInfo };

export async function createScan(ctx: AppContext, user: SessionUser, input: CreateScanInput): Promise<CreateScanResult> {
  // Idempotency for offline-queue re-uploads
  if (input.clientScanId) {
    const [existing] = await ctx.db
      .select({ id: scans.id })
      .from(scans)
      .where(and(eq(scans.userId, user.id), eq(scans.clientScanId, input.clientScanId)))
      .limit(1);
    if (existing) {
      const [job] = await ctx.db.select({ id: researchJobs.id }).from(researchJobs).where(eq(researchJobs.scanId, existing.id)).limit(1);
      return { kind: 'existing', scanId: existing.id, jobId: job?.id ?? null };
    }
  }

  const img = await normalizeUpload(input.buffer);
  if (!input.allowDuplicate) {
    const dup = await findDuplicateScan(ctx, user.id, img.dhash, img.sha256);
    if (dup) return { kind: 'duplicate', duplicate: dup };
  }

  const id = randomUUID();
  const rel = `scans/${user.id}/${month()}/${id}.jpg`;
  const thumbRel = `thumbnails/scans/${user.id}/${month()}/${id}.webp`;
  await writeFileSafe(ctx.storageDir, rel, img.buffer);
  await writeFileSafe(ctx.storageDir, thumbRel, await makeThumbnail(img.buffer));

  const jobId = randomUUID();
  await ctx.db.transaction(async (tx) => {
    await tx.insert(scans).values({
      id,
      userId: user.id,
      clientScanId: input.clientScanId ?? null,
      imagePath: rel,
      thumbnailPath: thumbRel,
      imageHash: img.dhash,
      contentHash: img.sha256,
      width: img.width,
      height: img.height,
      mimeType: img.mimeType,
      sizeBytes: img.buffer.length,
      gameHint: input.gameHint ?? null,
      quality: { ...img.quality, client: input.clientQuality ?? null },
      capturedAt: input.capturedAt ?? null,
    });
    await tx.insert(researchJobs).values({ id: jobId, scanId: id, userId: user.id, queue: 'identification', label: 'New scan', stage: 'Queued for identification', priority: 3 });
  });

  await ctx.queues.identification.add(
    'identify',
    { scanId: id, userId: user.id, gameHint: input.gameHint, clientOcr: input.clientOcr?.slice(0, 4000) },
    { jobId, priority: 3 },
  );
  await ctx.events.publish({ type: 'JOB_CREATED', userId: user.id, jobId, scanId: id, queue: 'identification', state: 'QUEUED', message: 'New scan queued' });
  return { kind: 'created', scanId: id, jobId };
}

/** Queue research for a card (dedupes against an already-pending job). */
export async function enqueueResearch(
  ctx: AppContext,
  opts: { cardId: string; scanId?: string | null; userId?: string | null; priority?: number; reason: 'SCAN' | 'MANUAL' | 'REFRESH' | 'RETRY' },
): Promise<string> {
  const [pending] = await ctx.db
    .select({ id: researchJobs.id })
    .from(researchJobs)
    .where(and(eq(researchJobs.cardId, opts.cardId), eq(researchJobs.queue, 'research'), sql`${researchJobs.status} IN ('QUEUED','PROCESSING','RESEARCHING','PRICING')`))
    .limit(1);
  if (pending) return pending.id;
  const [card] = await ctx.db.select({ name: cards.name }).from(cards).where(eq(cards.id, opts.cardId));
  const id = randomUUID();
  const priority = opts.priority ?? 5;
  await ctx.db.insert(researchJobs).values({
    id,
    cardId: opts.cardId,
    scanId: opts.scanId ?? null,
    userId: opts.userId ?? null,
    queue: 'research',
    label: card?.name ?? 'Card',
    stage: 'Queued for research',
    priority,
  });
  await ctx.queues.research.add('research', { researchJobId: id, cardId: opts.cardId, scanId: opts.scanId ?? null, userId: opts.userId ?? null, priority, reason: opts.reason }, { jobId: id, priority });
  await ctx.events.publish({ type: 'JOB_CREATED', userId: opts.userId ?? null, jobId: id, cardId: opts.cardId, queue: 'research', state: 'QUEUED', message: `Research queued: ${card?.name ?? ''}` });
  return id;
}

/** Ensure a variant row exists for a card and return its id. */
export async function ensureVariant(ctx: AppContext, cardId: string, type: string): Promise<string> {
  const [row] = await ctx.db
    .insert(cardVariants)
    .values({ cardId, type })
    .onConflictDoUpdate({ target: [cardVariants.cardId, cardVariants.type], set: { type } })
    .returning({ id: cardVariants.id });
  return row!.id;
}

/** Attach an identified scan to the owner's collection as a new copy. */
export async function addScanToCollection(
  ctx: AppContext,
  scanId: string,
  cardId: string,
  variantId: string | null,
  opts: { condition?: string } = {},
): Promise<string> {
  const [scan] = await ctx.db.select().from(scans).where(eq(scans.id, scanId));
  if (!scan) throw new Error('scan not found');
  if (scan.collectionItemId) return scan.collectionItemId;
  const [item] = await ctx.db
    .insert(collectionItems)
    .values({ userId: scan.userId, cardId, variantId, scanId, condition: opts.condition ?? 'NM', source: 'scan', quantity: 1 })
    .returning({ id: collectionItems.id });
  await ctx.db.update(scans).set({ collectionItemId: item!.id, cardId, variantId, updatedAt: new Date() }).where(eq(scans.id, scanId));
  return item!.id;
}
