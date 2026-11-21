import { Queue, type JobsOptions } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';
import {
  QUEUE_NAMES,
  EVENTS_CHANNEL,
  DEFAULT_JOB_OPTIONS,
  type CardVaultEvent,
  type QueueName,
  type IdentificationJobData,
  type ResearchJobData,
  type PricingJobData,
  type ImageJobData,
} from '@cardvault/shared';

export { QUEUE_NAMES };

export function createRedis(url: string, opts: RedisOptions = {}): Redis {
  // BullMQ workers require maxRetriesPerRequest = null
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, ...opts });
}

export interface Queues {
  identification: Queue<IdentificationJobData>;
  research: Queue<ResearchJobData>;
  pricing: Queue<PricingJobData>;
  image: Queue<ImageJobData>;
  maintenance: Queue<Record<string, unknown>>;
  all: Queue[];
  close(): Promise<void>;
}

export function createQueues(connection: Redis): Queues {
  const mk = <T>(name: QueueName) => new Queue<T>(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS as JobsOptions });
  const identification = mk<IdentificationJobData>(QUEUE_NAMES.identification);
  const research = mk<ResearchJobData>(QUEUE_NAMES.research);
  const pricing = mk<PricingJobData>(QUEUE_NAMES.pricing);
  const image = mk<ImageJobData>(QUEUE_NAMES.image);
  const maintenance = mk<Record<string, unknown>>(QUEUE_NAMES.maintenance);
  const all = [identification, research, pricing, image, maintenance] as Queue[];
  return {
    identification,
    research,
    pricing,
    image,
    maintenance,
    all,
    close: async () => {
      await Promise.all(all.map((q) => q.close()));
    },
  };
}

/** Publish an event to the Redis channel the API relays over SSE. */
export class EventBus {
  constructor(private readonly redis: Redis) {}
  async publish(e: Omit<CardVaultEvent, 'at'>): Promise<void> {
    await this.redis.publish(EVENTS_CHANNEL, JSON.stringify({ ...e, at: new Date().toISOString() }));
  }
}

export function subscribeEvents(url: string, onEvent: (e: CardVaultEvent) => void): { close: () => Promise<void> } {
  const sub = createRedis(url);
  void sub.subscribe(EVENTS_CHANNEL);
  sub.on('message', (_ch, msg) => {
    try {
      onEvent(JSON.parse(msg) as CardVaultEvent);
    } catch {
      /* ignore malformed */
    }
  });
  return { close: async () => void (await sub.quit()) };
}

export const WORKER_HEARTBEAT_KEY = (id: string) => `cardvault:worker:${id}`;
