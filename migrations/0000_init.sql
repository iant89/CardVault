CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."identification_method" AS ENUM('OCR', 'IMAGE_HASH', 'CATALOG', 'COMBINED', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('QUEUED', 'PROCESSING', 'MATCHING', 'RESEARCHING', 'PRICING', 'COMPLETED', 'FAILED', 'MANUAL_REVIEW', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('OPEN', 'RESOLVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('ADMIN', 'USER');--> statement-breakpoint
CREATE TYPE "public"."sale_type" AS ENUM('LISTING', 'SOLD', 'AUCTION', 'MARKET', 'BUY_IT_NOW');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('UPLOADED', 'IDENTIFYING', 'IDENTIFIED', 'NEEDS_VERIFICATION', 'MANUAL_REVIEW', 'RESEARCHING', 'COMPLETED', 'FAILED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('CARD_DATABASE', 'MARKETPLACE_API', 'PRICE_SOURCE', 'WEB_CRAWLER', 'IMAGE_SEARCH');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"type" text NOT NULL,
	"description" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"set_id" uuid,
	"name" text NOT NULL,
	"collector_number" text DEFAULT '' NOT NULL,
	"collector_number_norm" text DEFAULT '' NOT NULL,
	"rarity" text,
	"artist" text,
	"release_date" date,
	"image_url" text,
	"image_path" text,
	"image_hash" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_researched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"variant_id" uuid,
	"scan_id" uuid,
	"condition" text DEFAULT 'NM' NOT NULL,
	"grading" jsonb DEFAULT '{"status":"RAW"}'::jsonb NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"purchase_price" numeric(12, 2),
	"purchase_date" date,
	"source" text,
	"notes" text,
	"favorite" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_value_snapshots" (
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"total_value" numeric(12, 2) NOT NULL,
	"by_game" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "collection_value_snapshots_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "games_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "identifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" uuid NOT NULL,
	"card_id" uuid,
	"variant_id" uuid,
	"confidence" real NOT NULL,
	"method" "identification_method" NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL,
	"raw_result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manual_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" uuid NOT NULL,
	"assigned_to" uuid,
	"status" "review_status" DEFAULT 'OPEN' NOT NULL,
	"reason" text,
	"original_identification" jsonb,
	"corrected_identification" jsonb,
	"resolved_by" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "price_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"variant_id" uuid,
	"source" text NOT NULL,
	"source_item_id" text,
	"price" numeric(12, 2) NOT NULL,
	"shipping" numeric(12, 2),
	"currency" text DEFAULT 'USD' NOT NULL,
	"condition" text,
	"sale_type" "sale_type" NOT NULL,
	"title" text,
	"url" text,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"variant_id" uuid,
	"market_price" numeric(12, 2),
	"median_price" numeric(12, 2),
	"average_price" numeric(12, 2),
	"min_price" numeric(12, 2),
	"max_price" numeric(12, 2),
	"sold_median" numeric(12, 2),
	"sold_average" numeric(12, 2),
	"listed_median" numeric(12, 2),
	"avg_30d" numeric(12, 2),
	"avg_90d" numeric(12, 2),
	"avg_1y" numeric(12, 2),
	"trend_30d" real,
	"volatility" real,
	"observation_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" uuid,
	"card_id" uuid,
	"user_id" uuid,
	"queue" text DEFAULT 'research' NOT NULL,
	"bull_job_id" text,
	"status" "job_state" DEFAULT 'QUEUED' NOT NULL,
	"stage" text,
	"label" text,
	"priority" integer DEFAULT 5 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"worker_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "research_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"raw_data" jsonb,
	"normalized_data" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" "source_type" NOT NULL,
	"base_url" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"rate_limit" text,
	"configured" boolean DEFAULT false NOT NULL,
	"circuit_state" text DEFAULT 'CLOSED' NOT NULL,
	"last_error" text,
	"last_success_at" timestamp with time zone,
	"request_count" bigint DEFAULT 0 NOT NULL,
	"error_count" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_scan_id" text,
	"image_path" text NOT NULL,
	"thumbnail_path" text,
	"image_hash" text,
	"content_hash" text NOT NULL,
	"width" integer,
	"height" integer,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"status" "scan_status" DEFAULT 'UPLOADED' NOT NULL,
	"confidence" real,
	"card_id" uuid,
	"variant_id" uuid,
	"collection_item_id" uuid,
	"game_hint" text,
	"quality" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"captured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"csrf_token" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"code" text,
	"series" text,
	"total_cards" integer,
	"release_date" date,
	"symbol_url" text,
	"external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"avatar" text,
	"role" "role" DEFAULT 'USER' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" text PRIMARY KEY NOT NULL,
	"hostname" text NOT NULL,
	"pid" integer NOT NULL,
	"version" text NOT NULL,
	"queues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat" timestamp with time zone DEFAULT now() NOT NULL,
	"jobs_processed" integer DEFAULT 0 NOT NULL,
	"jobs_failed" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_variants" ADD CONSTRAINT "card_variants_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_set_id_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_variant_id_card_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."card_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_value_snapshots" ADD CONSTRAINT "collection_value_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identifications" ADD CONSTRAINT "identifications_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identifications" ADD CONSTRAINT "identifications_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identifications" ADD CONSTRAINT "identifications_variant_id_card_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."card_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_reviews" ADD CONSTRAINT "manual_reviews_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_reviews" ADD CONSTRAINT "manual_reviews_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_reviews" ADD CONSTRAINT "manual_reviews_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observations" ADD CONSTRAINT "price_observations_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observations" ADD CONSTRAINT "price_observations_variant_id_card_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."card_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD CONSTRAINT "price_snapshots_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD CONSTRAINT "price_snapshots_variant_id_card_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."card_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_jobs" ADD CONSTRAINT "research_jobs_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_jobs" ADD CONSTRAINT "research_jobs_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_jobs" ADD CONSTRAINT "research_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_results" ADD CONSTRAINT "research_results_job_id_research_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."research_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_results" ADD CONSTRAINT "research_results_source_id_research_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."research_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_variant_id_card_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."card_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sets" ADD CONSTRAINT "sets_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "card_variants_card_type_uq" ON "card_variants" USING btree ("card_id","type");--> statement-breakpoint
CREATE INDEX "cards_game_idx" ON "cards" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "cards_set_number_idx" ON "cards" USING btree ("set_id","collector_number_norm");--> statement-breakpoint
CREATE INDEX "cards_name_trgm_idx" ON "cards" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "cards_external_ids_idx" ON "cards" USING gin ("external_ids");--> statement-breakpoint
CREATE INDEX "collection_user_idx" ON "collection_items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "collection_card_idx" ON "collection_items" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "identifications_scan_idx" ON "identifications" USING btree ("scan_id");--> statement-breakpoint
CREATE INDEX "manual_reviews_status_idx" ON "manual_reviews" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "price_obs_card_idx" ON "price_observations" USING btree ("card_id","variant_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "price_obs_dedupe_uq" ON "price_observations" USING btree ("source","source_item_id","sale_type","observed_at");--> statement-breakpoint
CREATE INDEX "price_snapshots_card_idx" ON "price_snapshots" USING btree ("card_id","variant_id","created_at");--> statement-breakpoint
CREATE INDEX "research_jobs_status_idx" ON "research_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "research_jobs_user_idx" ON "research_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "research_results_job_idx" ON "research_results" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "scans_user_idx" ON "scans" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "scans_status_idx" ON "scans" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "scans_client_id_uq" ON "scans" USING btree ("user_id","client_scan_id");--> statement-breakpoint
CREATE INDEX "scans_image_hash_idx" ON "scans" USING btree ("image_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sets_game_slug_uq" ON "sets" USING btree ("game_id","slug");--> statement-breakpoint
CREATE INDEX "sets_code_idx" ON "sets" USING btree ("code");