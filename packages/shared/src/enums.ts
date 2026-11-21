export const GAME_SLUGS = [
  'pokemon',
  'magic',
  'yugioh',
  'football',
  'baseball',
  'basketball',
  'hockey',
  'other',
] as const;
export type GameSlug = (typeof GAME_SLUGS)[number];

export const SPORTS_GAMES: readonly GameSlug[] = ['football', 'baseball', 'basketball', 'hockey'];
export const isSportsGame = (g: string): boolean => (SPORTS_GAMES as readonly string[]).includes(g);

export const ROLES = ['ADMIN', 'USER'] as const;
export type Role = (typeof ROLES)[number];

export const VARIANT_TYPES = [
  'NORMAL',
  'HOLO',
  'REVERSE_HOLO',
  'NON_HOLO',
  'FOIL',
  'NON_FOIL',
  'ETCHED_FOIL',
  'ALT_ART',
  'FULL_ART',
  'SECRET_RARE',
  'FIRST_EDITION',
  'UNLIMITED',
  'SHADOWLESS',
  'PROMO',
  'PARALLEL',
  'SIGNED',
  'AUTOGRAPH',
  'RELIC',
  'MEMORABILIA',
  'SERIAL_NUMBERED',
] as const;
export type VariantType = (typeof VARIANT_TYPES)[number];

export const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'] as const;
export type Condition = (typeof CONDITIONS)[number];

export const GRADING_STATUS = ['RAW', 'GRADED'] as const;
export type GradingStatus = (typeof GRADING_STATUS)[number];

export const GRADING_COMPANIES = ['PSA', 'BGS', 'CGC', 'SGC', 'OTHER'] as const;
export type GradingCompany = (typeof GRADING_COMPANIES)[number];

export const JOB_STATES = [
  'QUEUED',
  'PROCESSING',
  'MATCHING',
  'RESEARCHING',
  'PRICING',
  'COMPLETED',
  'FAILED',
  'MANUAL_REVIEW',
  'CANCELLED',
] as const;
export type JobState = (typeof JOB_STATES)[number];
export const TERMINAL_JOB_STATES: readonly JobState[] = ['COMPLETED', 'FAILED', 'MANUAL_REVIEW', 'CANCELLED'];

export const SCAN_STATUSES = [
  'UPLOADED',
  'IDENTIFYING',
  'IDENTIFIED',
  'NEEDS_VERIFICATION',
  'MANUAL_REVIEW',
  'RESEARCHING',
  'COMPLETED',
  'FAILED',
  'REJECTED',
] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const REVIEW_STATUSES = ['OPEN', 'RESOLVED', 'REJECTED'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const SALE_TYPES = ['LISTING', 'SOLD', 'AUCTION', 'MARKET', 'BUY_IT_NOW'] as const;
export type SaleType = (typeof SALE_TYPES)[number];

export const SOURCE_TYPES = ['CARD_DATABASE', 'MARKETPLACE_API', 'PRICE_SOURCE', 'WEB_CRAWLER', 'IMAGE_SEARCH'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const IDENTIFICATION_METHODS = ['OCR', 'IMAGE_HASH', 'CATALOG', 'COMBINED', 'MANUAL'] as const;
export type IdentificationMethod = (typeof IDENTIFICATION_METHODS)[number];

export const QUEUE_NAMES = {
  identification: 'identification',
  research: 'research',
  pricing: 'pricing',
  image: 'image',
  manualReview: 'manual-review',
  maintenance: 'maintenance',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
