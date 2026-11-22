import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql, collectionItems, researchJobs, scans, cards, cardVariants, identifications } from '@cardvault/database';
import { unlink } from 'node:fs/promises';
import { normalizeUpload, makeThumbnail, writeFileSafe, resolveStoragePath } from '@cardvault/imaging';
import type { SessionUser } from '@cardvault/shared';
import type { AppContext } from '../context.js';

const month = () => new Date().toISOString().slice(0, 7);

export interface CreateScanInput {
  buffer: Buffer;
  clientScanId?: string;
  gameHint?: string;
  clientOcr?: string;
  capturedAt?: Date;
  clientQuality?: Record<string, unknown>;
}

export type CreateScanResult =
  | { kind: 'created'; scanId: string; jobId: string }
  | { kind: 'existing'; scanId: string; jobId: string | null };

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

  // A card you already own is simply another copy: no blocking duplicate check.
  // (Offline re-uploads are de-duplicated above by clientScanId; accidental
  // double captures can be undone from the scanner.)
  const img = await normalizeUpload(input.buffer);

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
    await tx.insert(researchJobs).values({ id: jobId, bullJobId: jobId, scanId: id, userId: user.id, queue: 'identification', label: 'New scan', stage: 'Queued for identification', priority: 3 });
  });

  await ctx.queues.identification.add(
    'identify',
    { scanId: id, userId: user.id, gameHint: input.gameHint, clientOcr: input.clientOcr?.slice(0, 4000), researchJobId: jobId },
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

// ---------------------------------------------------------------- retake & delete

const ACTIVE = ['QUEUED', 'PROCESSING', 'MATCHING', 'RESEARCHING', 'PRICING'] as const;
const IDENTIFIED_STATUSES = ['IDENTIFIED', 'RESEARCHING', 'COMPLETED'];
const WAITING_BULL = new Set(['waiting', 'delayed', 'prioritized', 'waiting-children']);

async function removeFiles(ctx: AppContext, ...paths: (string | null | undefined)[]) {
  for (const p of paths) {
    if (!p) continue;
    try {
      await unlink(resolveStoragePath(ctx.storageDir, p));
    } catch {
      /* already gone */
    }
  }
}

/**
 * Cancel a scan's unfinished jobs. Waiting BullMQ jobs are removed; a job
 * already running sees CANCELLED (or a changed image version) at its next
 * checkpoint and discards its result.
 */
async function cancelScanJobs(ctx: AppContext, scanId: string, queues: ('identification' | 'research')[], stage: string) {
  const rows = await ctx.db
    .select()
    .from(researchJobs)
    .where(and(eq(researchJobs.scanId, scanId), inArray(researchJobs.queue, queues), inArray(researchJobs.status, [...ACTIVE])));
  for (const r of rows) {
    const q = r.queue === 'identification' ? ctx.queues.identification : ctx.queues.research;
    const job = await q.getJob(r.bullJobId ?? r.id);
    if (job && WAITING_BULL.has(await job.getState())) await job.remove().catch(() => undefined);
    await ctx.db.update(researchJobs).set({ status: 'CANCELLED', stage, completedAt: new Date() }).where(eq(researchJobs.id, r.id));
    await ctx.events.publish({ type: 'JOB_FAILED', userId: r.userId, jobId: r.id, scanId, state: 'CANCELLED', message: stage });
  }
}

/** Remove the collection copy that this scan created (a copy added by hand is never touched). */
async function removeScanCopy(ctx: AppContext, scanId: string) {
  await ctx.db.delete(collectionItems).where(eq(collectionItems.scanId, scanId));
}

export type RetakeResult = { scanId: string; jobId: string; requeued: 'kept' | 'requeued' };

/**
 * Replace a scan's photo. The old photo is removed only after the new one is
 * stored.
 *  - Not identified yet: the scan keeps its place in the queue and is
 *    identified from the new photo.
 *  - Already identified: the identification (and the collection copy it
 *    created) is removed and the scan is queued for identification again.
 */
export async function retakeScan(ctx: AppContext, scanId: string, buffer: Buffer, clientQuality?: Record<string, unknown>): Promise<RetakeResult> {
  const [scan] = await ctx.db.select().from(scans).where(eq(scans.id, scanId));
  if (!scan) throw new Error('scan not found');
  const img = await normalizeUpload(buffer);
  const version = scan.imageVersion + 1;
  const rel = `scans/${scan.userId}/${month()}/${scan.id}-v${version}.jpg`;
  const thumbRel = `thumbnails/scans/${scan.userId}/${month()}/${scan.id}-v${version}.webp`;
  await writeFileSafe(ctx.storageDir, rel, img.buffer);
  await writeFileSafe(ctx.storageDir, thumbRel, await makeThumbnail(img.buffer));

  const wasIdentified = !!scan.cardId && IDENTIFIED_STATUSES.includes(scan.status);
  // latest identification run for this scan (absent once identified: that row became the research job)
  const [idRow] = wasIdentified
    ? []
    : await ctx.db
        .select()
        .from(researchJobs)
        .where(and(eq(researchJobs.scanId, scanId), eq(researchJobs.queue, 'identification')))
        .orderBy(sql`${researchJobs.createdAt} DESC`)
        .limit(1);

  if (wasIdentified) {
    await cancelScanJobs(ctx, scanId, ['research'], 'Photo retaken');
    await removeScanCopy(ctx, scanId);
  }

  await ctx.db.transaction(async (tx) => {
    await tx
      .update(scans)
      .set({
        imagePath: rel,
        thumbnailPath: thumbRel,
        imageHash: img.dhash,
        contentHash: img.sha256,
        width: img.width,
        height: img.height,
        sizeBytes: img.buffer.length,
        mimeType: img.mimeType,
        quality: { ...img.quality, client: clientQuality ?? null, retake: version },
        imageVersion: version,
        status: 'UPLOADED',
        confidence: null,
        cardId: null,
        variantId: null,
        collectionItemId: null,
        updatedAt: new Date(),
      })
      .where(eq(scans.id, scanId));
    // old candidates were computed from the old photo
    await tx.delete(identifications).where(eq(identifications.scanId, scanId));
  });
  await removeFiles(ctx, scan.imagePath, scan.thumbnailPath);

  let jobId: string;
  let requeued: RetakeResult['requeued'];
  if (idRow) {
    // keep its existing queue entry
    jobId = idRow.id;
    requeued = 'kept';
    const current = await ctx.queues.identification.getJob(idRow.bullJobId ?? idRow.id);
    const waiting = current && WAITING_BULL.has(await current.getState());
    // a waiting job will simply read the new photo when it runs; otherwise start a fresh run on the same row
    const bullJobId = waiting ? (idRow.bullJobId ?? idRow.id) : `${idRow.id}-v${version}`;
    await ctx.db
      .update(researchJobs)
      .set({ status: 'QUEUED', stage: 'Photo retaken — queued for identification', progress: 0, error: null, completedAt: null, bullJobId, label: 'Retaken scan' })
      .where(eq(researchJobs.id, idRow.id));
    if (!waiting) {
      await ctx.queues.identification.add(
        'identify',
        { scanId, userId: scan.userId, gameHint: scan.gameHint ?? undefined, researchJobId: idRow.id },
        { jobId: bullJobId, priority: 2 },
      );
    }
  } else {
    jobId = randomUUID();
    requeued = 'requeued';
    await ctx.db.insert(researchJobs).values({ id: jobId, bullJobId: jobId, scanId, userId: scan.userId, queue: 'identification', label: 'Retaken scan', stage: 'Photo retaken — queued for identification', priority: 2 });
    await ctx.queues.identification.add('identify', { scanId, userId: scan.userId, gameHint: scan.gameHint ?? undefined, researchJobId: jobId }, { jobId, priority: 2 });
  }
  await ctx.events.publish({ type: 'JOB_CREATED', userId: scan.userId, jobId, scanId, queue: 'identification', state: 'QUEUED', message: 'Photo retaken' });
  return { scanId, jobId, requeued };
}

/** Delete a scan: its jobs, photos, identification history and the collection copy it created. */
export async function deleteScan(ctx: AppContext, scanId: string): Promise<{ removedCopy: boolean }> {
  const [scan] = await ctx.db.select().from(scans).where(eq(scans.id, scanId));
  if (!scan) throw new Error('scan not found');
  await cancelScanJobs(ctx, scanId, ['identification', 'research'], 'Scan deleted');
  const copies = await ctx.db.select({ id: collectionItems.id }).from(collectionItems).where(eq(collectionItems.scanId, scanId));
  await removeScanCopy(ctx, scanId);
  // identifications and manual reviews cascade; job rows keep their history with scan_id = NULL
  await ctx.db.delete(scans).where(eq(scans.id, scanId));
  await removeFiles(ctx, scan.imagePath, scan.thumbnailPath);
  await ctx.events.publish({ type: 'JOB_FAILED', userId: scan.userId, scanId, state: 'CANCELLED', message: 'Scan deleted' });
  return { removedCopy: copies.length > 0 };
}
