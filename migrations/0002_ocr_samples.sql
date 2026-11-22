CREATE TABLE "ocr_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_id" uuid,
	"exam_version" integer,
	"engine" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" jsonb DEFAULT '{"done":0,"total":0}'::jsonb NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"slices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"misses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ocr_exams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"sample_ids" jsonb NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ocr_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" uuid,
	"image_version" integer DEFAULT 0 NOT NULL,
	"group_key" text NOT NULL,
	"game" text NOT NULL,
	"field" text NOT NULL,
	"region" integer DEFAULT 0 NOT NULL,
	"crop_path" text NOT NULL,
	"width" integer,
	"height" integer,
	"engine" text NOT NULL,
	"predicted" text DEFAULT '' NOT NULL,
	"predicted_confidence" real,
	"card_id" uuid,
	"label_text" text,
	"label_norm" text,
	"label_source" text DEFAULT 'pending' NOT NULL,
	"split" text,
	"regression" boolean DEFAULT false NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"labeled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ocr_evaluations" ADD CONSTRAINT "ocr_evaluations_exam_id_ocr_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."ocr_exams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocr_evaluations" ADD CONSTRAINT "ocr_evaluations_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocr_exams" ADD CONSTRAINT "ocr_exams_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocr_samples" ADD CONSTRAINT "ocr_samples_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocr_samples" ADD CONSTRAINT "ocr_samples_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ocr_evaluations_created_idx" ON "ocr_evaluations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ocr_samples_scan_idx" ON "ocr_samples" USING btree ("scan_id","image_version");--> statement-breakpoint
CREATE INDEX "ocr_samples_split_idx" ON "ocr_samples" USING btree ("split","label_source");--> statement-breakpoint
CREATE INDEX "ocr_samples_group_idx" ON "ocr_samples" USING btree ("group_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ocr_samples_harvest_uq" ON "ocr_samples" USING btree ("group_key","field","region");