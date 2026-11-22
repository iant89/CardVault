CREATE TABLE "ocr_models" (
	"id" text PRIMARY KEY NOT NULL,
	"dir" text NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"card" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"activated_by" uuid,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "ocr_models" ADD CONSTRAINT "ocr_models_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;