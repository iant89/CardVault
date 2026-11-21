import type { Job } from 'bullmq';
import { eq, sql, cards, scans, researchResults, priceObservations, cardVariants } from '@cardvault/database';
import { CircuitOpenError } from '@cardvault/provider-sdk';
import { normalizeCollectorNumber, type ResearchJobData } from '@cardvault/shared';
import type { PriceObservationInput } from '@cardvault/card-model';
import type { WorkerContext } from '../context.js';
import { JobTracker } from '../jobs/state.js';
import { loadNormalized, upsertCatalogCard } from '../catalog.js';
import { computeSnapshots } from '../pricing/compute.js';
import { run } from './common.js';

async function variantIdMap(ctx: WorkerContext, cardId: string) {
  const rows = await ctx.db.select().from(cardVariants).where(eq(cardVariants.cardId, cardId));
  return new Map(rows.map((r) => [r.type, r.id]));
}

/**
 * Research = enrich identity from card databases, then gather prices/sales
 * from every enabled provider, then recompute statistics. Each provider's
 * failure is isolated and recorded; the job fails only if *every* provider did.
 */
export async function processResearch(ctx: WorkerContext, job: Job<ResearchJobData>) {
  const d = job.data;
  const tracker = new JobTracker(ctx, d.researchJobId, d.userId ?? null, d.scanId ?? null, d.cardId);
  return run(ctx, job, tracker, async () => {
    await tracker.start('Starting research', job.attemptsMade + 1);
    let card = await loadNormalized(ctx, d.cardId);
    if (!card) throw new Error('Card not found');
    await tracker.update('RESEARCHING', `Researching ${card.name}`, 15, 'RESEARCH_STARTED');

    let attempted = 0;
    let failedCount = 0;
    const record = async (sourceId: string, normalizedData: unknown, error?: string) => {
      await ctx.db.insert(researchResults).values({ jobId: d.researchJobId, sourceId, normalizedData: normalizedData as object, error: error ?? null });
    };
    const guard = async <T>(id: string, fn: () => Promise<T>): Promise<T | null> => {
      attempted++;
      try {
        return await fn();
      } catch (e) {
        failedCount++;
        const msg = e instanceof CircuitOpenError ? `circuit open until ${new Date(e.retryAt).toISOString()}` : (e as Error).message;
        ctx.log.warn({ provider: id, card: d.cardId, err: msg }, 'provider failed');
        await record(id, null, msg);
        return null;
      }
    };

    // 1. Identity enrichment (attributes, images, external ids)
    for (const { provider, ctx: pctx } of ctx.providers.forGame(card.game, 'search')) {
      await tracker.update('RESEARCHING', `${provider.name}: card data`, 25);
      const ext = card.externalIds[provider.id];
      const enriched = await guard(provider.id, async () => {
        if (ext) return provider.getCard(ext, pctx);
        const results = await provider.search({ game: card!.game, name: card!.name, collectorNumber: card!.collectorNumber, limit: 10 }, pctx);
        const num = normalizeCollectorNumber(card!.collectorNumber);
        return (
          results.find((r) => normalizeCollectorNumber(r.card.collectorNumber) === num && r.score > 0.85 && (!card!.set.name || r.card.set.name.toLowerCase() === card!.set.name.toLowerCase()))?.card ??
          results.find((r) => normalizeCollectorNumber(r.card.collectorNumber) === num && r.score > 0.9)?.card ??
          null
        );
      });
      if (enriched) {
        await upsertCatalogCard(ctx, enriched, d.cardId);
        await record(provider.id, { kind: 'card', externalIds: enriched.externalIds, variants: enriched.variants });
        card = (await loadNormalized(ctx, d.cardId)) ?? card;
      }
    }
    // cache image locally if we have a remote one but no local copy
    const [row] = await ctx.db.select({ imagePath: cards.imagePath, imageUrl: cards.imageUrl }).from(cards).where(eq(cards.id, d.cardId));
    if (row?.imageUrl && !row.imagePath) await ctx.queues.image.add('catalog-image', { kind: 'CATALOG_HASH', cardId: d.cardId }, { jobId: `img:${d.cardId}` }).catch(() => undefined);

    // 2. Prices & sales
    await tracker.update('PRICING', 'Collecting prices', 55);
    const variants = await variantIdMap(ctx, d.cardId);
    let stored = 0;
    const store = async (obs: PriceObservationInput[]) => {
      if (!obs.length) return;
      for (const o of obs) {
        if (o.variant && !variants.has(o.variant)) {
          const [v] = await ctx.db.insert(cardVariants).values({ cardId: d.cardId, type: o.variant }).onConflictDoNothing().returning();
          if (v) variants.set(v.type, v.id);
        }
      }
      const res = await ctx.db
        .insert(priceObservations)
        .values(
          obs.map((o) => ({
            cardId: d.cardId,
            variantId: o.variant ? (variants.get(o.variant) ?? null) : null,
            source: o.source,
            sourceItemId: o.sourceItemId ?? null,
            price: o.price,
            shipping: o.shipping ?? null,
            currency: o.currency,
            condition: o.condition ?? null,
            saleType: o.saleType,
            title: o.title ?? null,
            url: o.url ?? null,
            observedAt: new Date(o.observedAt),
          })),
        )
        .onConflictDoNothing()
        .returning({ id: priceObservations.id });
      stored += res.length;
    };
    for (const { provider, ctx: pctx } of ctx.providers.forGame(card.game, 'prices')) {
      await tracker.update('PRICING', `${provider.name}: prices`, 65);
      const obs = await guard(provider.id, () => provider.getPrices!(card!, pctx));
      if (obs) {
        await store(obs);
        await record(provider.id, { kind: 'prices', count: obs.length, sample: obs.slice(0, 5) });
      }
    }
    for (const { provider, ctx: pctx } of ctx.providers.forGame(card.game, 'sales')) {
      await tracker.update('PRICING', `${provider.name}: sold listings`, 75);
      const obs = await guard(provider.id, () => provider.getSales!(card!, pctx));
      if (obs) {
        await store(obs);
        await record(provider.id, { kind: 'sales', count: obs.length, sample: obs.slice(0, 5) });
      }
    }

    // 3. Statistics
    await tracker.update('PRICING', 'Calculating market statistics', 90);
    const market = await computeSnapshots(ctx, d.cardId);
    await ctx.db.update(cards).set({ lastResearchedAt: new Date(), updatedAt: new Date() }).where(eq(cards.id, d.cardId));
    if (d.scanId) await ctx.db.execute(sql`UPDATE scans SET status = 'COMPLETED', updated_at = now() WHERE id = ${d.scanId} AND status = 'RESEARCHING'`);
    void scans;

    if (attempted > 0 && failedCount === attempted) throw new Error(`All ${attempted} provider calls failed`);

    await ctx.events.publish({ type: 'PRICE_UPDATED', userId: d.userId ?? null, cardId: d.cardId, data: { marketPrice: market, newObservations: stored } });
    await tracker.finish('COMPLETED', market != null ? `Market $${market.toFixed(2)}` : 'No price data yet', 'CARD_RESEARCH_COMPLETE');
    return { stored, market };
  });
}
