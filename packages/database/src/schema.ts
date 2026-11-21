import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  numeric,
  real,
  date,
  index,
  uniqueIndex,
  pgEnum,
  bigint,
  primaryKey,
} from 'drizzle-orm/pg-core';
import {
  ROLES,
  JOB_STATES,
  SCAN_STATUSES,
  REVIEW_STATUSES,
  SALE_TYPES,
  SOURCE_TYPES,
  IDENTIFICATION_METHODS,
} from '@cardvault/shared';

export const roleEnum = pgEnum('role', ROLES);
export const jobStateEnum = pgEnum('job_state', JOB_STATES);
export const scanStatusEnum = pgEnum('scan_status', SCAN_STATUSES);
export const reviewStatusEnum = pgEnum('review_status', REVIEW_STATUSES);
export const saleTypeEnum = pgEnum('sale_type', SALE_TYPES);
export const sourceTypeEnum = pgEnum('source_type', SOURCE_TYPES);
export const identMethodEnum = pgEnum('identification_method', IDENTIFICATION_METHODS);

const ts = (name: string) => timestamp(name, { withTimezone: true });
const created = () => ts('created_at').notNull().defaultNow();
const updated = () => ts('updated_at').notNull().defaultNow();
const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: 'number' });

// ---------------------------------------------------------------- users & auth
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  avatar: text('avatar'),
  role: roleEnum('role').notNull().default('USER'),
  active: boolean('active').notNull().default(true),
  failedLogins: integer('failed_logins').notNull().default(0),
  lockedUntil: ts('locked_until'),
  createdAt: created(),
  lastLoginAt: ts('last_login_at'),
});

export const sessions = pgTable(
  'sessions',
  {
    /** sha256 of the opaque session token; the raw token only lives in the cookie */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    csrfToken: text('csrf_token').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: created(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

// ---------------------------------------------------------------- catalog
export const games = pgTable('games', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const sets = pgTable(
  'sets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    code: text('code'),
    series: text('series'),
    totalCards: integer('total_cards'),
    releaseDate: date('release_date'),
    symbolUrl: text('symbol_url'),
    externalIds: jsonb('external_ids').$type<Record<string, string>>().notNull().default({}),
  },
  (t) => [uniqueIndex('sets_game_slug_uq').on(t.gameId, t.slug), index('sets_code_idx').on(t.code)],
);

export const cards = pgTable(
  'cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id),
    setId: uuid('set_id').references(() => sets.id),
    name: text('name').notNull(),
    collectorNumber: text('collector_number').notNull().default(''),
    /** normalized number used for matching ("025/198" -> "25") */
    collectorNumberNorm: text('collector_number_norm').notNull().default(''),
    rarity: text('rarity'),
    artist: text('artist'),
    releaseDate: date('release_date'),
    imageUrl: text('image_url'),
    imagePath: text('image_path'),
    /** 64-bit difference hash (hex) of the catalog image for visual matching */
    imageHash: text('image_hash'),
    /** game-specific attributes (see @cardvault/card-model) */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    externalIds: jsonb('external_ids').$type<Record<string, string>>().notNull().default({}),
    lastResearchedAt: ts('last_researched_at'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index('cards_game_idx').on(t.gameId),
    index('cards_set_number_idx').on(t.setId, t.collectorNumberNorm),
    index('cards_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
    index('cards_external_ids_idx').using('gin', t.externalIds),
  ],
);

export const cardVariants = pgTable(
  'card_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cardId: uuid('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    description: text('description'),
    /** e.g. serial print run, parallel name */
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [uniqueIndex('card_variants_card_type_uq').on(t.cardId, t.type)],
);

// ---------------------------------------------------------------- ownership
export const collectionItems = pgTable(
  'collection_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    cardId: uuid('card_id')
      .notNull()
      .references(() => cards.id),
    variantId: uuid('variant_id').references(() => cardVariants.id),
    scanId: uuid('scan_id'),
    condition: text('condition').notNull().default('NM'),
    /** extensible grading: { status: 'GRADED', company: 'PSA', grade: '10', certNumber } */
    grading: jsonb('grading').$type<Record<string, unknown>>().notNull().default({ status: 'RAW' }),
    quantity: integer('quantity').notNull().default(1),
    purchasePrice: money('purchase_price'),
    purchaseDate: date('purchase_date'),
    source: text('source'),
    notes: text('notes'),
    favorite: boolean('favorite').notNull().default(false),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index('collection_user_idx').on(t.userId), index('collection_card_idx').on(t.cardId)],
);

// ---------------------------------------------------------------- scanning
export const scans = pgTable(
  'scans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** id generated in the browser's offline queue; makes uploads idempotent */
    clientScanId: text('client_scan_id'),
    imagePath: text('image_path').notNull(),
    thumbnailPath: text('thumbnail_path'),
    imageHash: text('image_hash'),
    /** sha256 of exact bytes */
    contentHash: text('content_hash').notNull(),
    width: integer('width'),
    height: integer('height'),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    status: scanStatusEnum('status').notNull().default('UPLOADED'),
    confidence: real('confidence'),
    cardId: uuid('card_id').references(() => cards.id),
    variantId: uuid('variant_id').references(() => cardVariants.id),
    collectionItemId: uuid('collection_item_id'),
    gameHint: text('game_hint'),
    quality: jsonb('quality').$type<Record<string, unknown>>().notNull().default({}),
    capturedAt: ts('captured_at'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index('scans_user_idx').on(t.userId, t.createdAt),
    index('scans_status_idx').on(t.status),
    uniqueIndex('scans_client_id_uq').on(t.userId, t.clientScanId),
    index('scans_image_hash_idx').on(t.imageHash),
  ],
);

export const identifications = pgTable(
  'identifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    cardId: uuid('card_id').references(() => cards.id),
    variantId: uuid('variant_id').references(() => cardVariants.id),
    confidence: real('confidence').notNull(),
    method: identMethodEnum('method').notNull(),
    rank: integer('rank').notNull().default(0),
    /** OCR text, signals, candidate scores */
    rawResult: jsonb('raw_result').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: created(),
  },
  (t) => [index('identifications_scan_idx').on(t.scanId)],
);

// ---------------------------------------------------------------- jobs
export const researchJobs = pgTable(
  'research_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scanId: uuid('scan_id').references(() => scans.id, { onDelete: 'set null' }),
    cardId: uuid('card_id').references(() => cards.id),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    queue: text('queue').notNull().default('research'),
    bullJobId: text('bull_job_id'),
    status: jobStateEnum('status').notNull().default('QUEUED'),
    stage: text('stage'),
    label: text('label'),
    priority: integer('priority').notNull().default(5),
    attempts: integer('attempts').notNull().default(0),
    progress: integer('progress').notNull().default(0),
    workerId: text('worker_id'),
    createdAt: created(),
    startedAt: ts('started_at'),
    heartbeatAt: ts('heartbeat_at'),
    completedAt: ts('completed_at'),
    error: text('error'),
  },
  (t) => [index('research_jobs_status_idx').on(t.status, t.createdAt), index('research_jobs_user_idx').on(t.userId)],
);

// ---------------------------------------------------------------- pricing
export const priceObservations = pgTable(
  'price_observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cardId: uuid('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').references(() => cardVariants.id),
    source: text('source').notNull(),
    sourceItemId: text('source_item_id'),
    price: money('price').notNull(),
    shipping: money('shipping'),
    currency: text('currency').notNull().default('USD'),
    condition: text('condition'),
    saleType: saleTypeEnum('sale_type').notNull(),
    title: text('title'),
    url: text('url'),
    observedAt: ts('observed_at').notNull(),
    createdAt: created(),
  },
  (t) => [
    index('price_obs_card_idx').on(t.cardId, t.variantId, t.observedAt),
    // the same listing observed on the same day is one observation
    uniqueIndex('price_obs_dedupe_uq').on(t.source, t.sourceItemId, t.saleType, t.observedAt),
  ],
);

export const priceSnapshots = pgTable(
  'price_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cardId: uuid('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').references(() => cardVariants.id),
    marketPrice: money('market_price'),
    medianPrice: money('median_price'),
    averagePrice: money('average_price'),
    minPrice: money('min_price'),
    maxPrice: money('max_price'),
    soldMedian: money('sold_median'),
    soldAverage: money('sold_average'),
    listedMedian: money('listed_median'),
    avg30d: money('avg_30d'),
    avg90d: money('avg_90d'),
    avg1y: money('avg_1y'),
    trend30d: real('trend_30d'),
    volatility: real('volatility'),
    observationCount: integer('observation_count').notNull().default(0),
    createdAt: created(),
  },
  (t) => [index('price_snapshots_card_idx').on(t.cardId, t.variantId, t.createdAt)],
);

export const collectionValueSnapshots = pgTable(
  'collection_value_snapshots',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    totalValue: money('total_value').notNull(),
    byGame: jsonb('by_game').$type<Record<string, number>>().notNull().default({}),
    itemCount: integer('item_count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

// ---------------------------------------------------------------- research
export const researchSources = pgTable('research_sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: sourceTypeEnum('type').notNull(),
  baseUrl: text('base_url'),
  enabled: boolean('enabled').notNull().default(true),
  /** human readable, e.g. "10/min" */
  rateLimit: text('rate_limit'),
  configured: boolean('configured').notNull().default(false),
  circuitState: text('circuit_state').notNull().default('CLOSED'),
  lastError: text('last_error'),
  lastSuccessAt: ts('last_success_at'),
  requestCount: bigint('request_count', { mode: 'number' }).notNull().default(0),
  errorCount: bigint('error_count', { mode: 'number' }).notNull().default(0),
  updatedAt: updated(),
});

export const researchResults = pgTable(
  'research_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => researchJobs.id, { onDelete: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => researchSources.id),
    rawData: jsonb('raw_data'),
    normalizedData: jsonb('normalized_data'),
    error: text('error'),
    createdAt: created(),
  },
  (t) => [index('research_results_job_idx').on(t.jobId)],
);

// ---------------------------------------------------------------- manual review
export const manualReviews = pgTable(
  'manual_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
    status: reviewStatusEnum('status').notNull().default('OPEN'),
    reason: text('reason'),
    /** what the identifier thought */
    originalIdentification: jsonb('original_identification'),
    /** what the human said */
    correctedIdentification: jsonb('corrected_identification'),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    notes: text('notes'),
    createdAt: created(),
    completedAt: ts('completed_at'),
  },
  (t) => [index('manual_reviews_status_idx').on(t.status, t.createdAt)],
);

// ---------------------------------------------------------------- ops
export const workers = pgTable('workers', {
  id: text('id').primaryKey(),
  hostname: text('hostname').notNull(),
  pid: integer('pid').notNull(),
  version: text('version').notNull(),
  queues: jsonb('queues').$type<string[]>().notNull().default([]),
  startedAt: ts('started_at').notNull().defaultNow(),
  lastHeartbeat: ts('last_heartbeat').notNull().defaultNow(),
  jobsProcessed: integer('jobs_processed').notNull().default(0),
  jobsFailed: integer('jobs_failed').notNull().default(0),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ip: text('ip'),
    createdAt: created(),
  },
  (t) => [index('audit_log_created_idx').on(t.createdAt), index('audit_log_entity_idx').on(t.entity, t.entityId)],
);
