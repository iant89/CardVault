ALTER TABLE "ocr_models" ADD COLUMN "previous_engine" text;--> statement-breakpoint
ALTER TABLE "ocr_models" ADD COLUMN "trial_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ocr_models" ADD COLUMN "trial" jsonb;--> statement-breakpoint
ALTER TABLE "ocr_models" ADD COLUMN "watch" jsonb;--> statement-breakpoint
ALTER TABLE "ocr_models" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ocr_models" ADD COLUMN "retired_reason" text;