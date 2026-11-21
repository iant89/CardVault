import type { JobState, QueueName } from './enums.js';

export const EVENT_TYPES = [
  'JOB_CREATED',
  'JOB_STARTED',
  'JOB_PROGRESS',
  'IDENTIFICATION_COMPLETE',
  'IDENTIFICATION_FAILED',
  'RESEARCH_STARTED',
  'CARD_RESEARCH_COMPLETE',
  'PRICE_UPDATED',
  'JOB_COMPLETE',
  'JOB_FAILED',
  'MANUAL_REVIEW_REQUIRED',
  'WORKER_HEARTBEAT',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface CardVaultEvent {
  type: EventType;
  /** user that owns the affected scan/job, null for broadcast */
  userId: string | null;
  jobId?: string;
  scanId?: string;
  cardId?: string;
  queue?: QueueName;
  state?: JobState;
  message?: string;
  progress?: number;
  data?: Record<string, unknown>;
  at: string;
}

/** Redis pub/sub channel that workers publish to and the API relays over SSE. */
export const EVENTS_CHANNEL = 'cardvault:events';
