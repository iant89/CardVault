export interface IdentificationJobData {
  scanId: string;
  userId: string;
  /** Optional hint from the scanner UI */
  gameHint?: string;
  /** Client-side OCR text (optional extra signal) */
  clientOcr?: string;
  /** research_jobs row this run reports to (defaults to the BullMQ job id) */
  researchJobId?: string;
}

export interface ResearchJobData {
  researchJobId: string;
  cardId: string;
  scanId?: string | null;
  userId?: string | null;
  priority: number;
  reason: 'SCAN' | 'MANUAL' | 'REFRESH' | 'RETRY';
}

export interface PricingJobData {
  cardId: string;
  variantId?: string | null;
}

export interface ImageJobData {
  kind: 'THUMBNAIL' | 'CATALOG_HASH';
  scanId?: string;
  cardId?: string;
}

export const DEFAULT_JOB_OPTIONS = {
  attempts: 4,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
  removeOnFail: { age: 30 * 24 * 3600 },
};
