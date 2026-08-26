CREATE TABLE "label_preview_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"definition_hash" text NOT NULL,
	"scanned_thread_count" integer NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_scan_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "label_preview_receipts_definition_hash_check" CHECK ("label_preview_receipts"."definition_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "label_preview_receipts_count_check" CHECK ("label_preview_receipts"."scanned_thread_count" between 0 and 100),
	CONSTRAINT "label_preview_receipts_results_check" CHECK (jsonb_typeof("label_preview_receipts"."results") = 'array' and jsonb_array_length("label_preview_receipts"."results") = "label_preview_receipts"."scanned_thread_count")
);
--> statement-breakpoint
ALTER TABLE "label_preview_receipts" ADD CONSTRAINT "label_preview_receipts_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_preview_receipts" ADD CONSTRAINT "label_preview_receipts_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "label_preview_receipts_account_expiration_idx" ON "label_preview_receipts" USING btree ("account_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "label_preview_receipts_consumed_scan_idx" ON "label_preview_receipts" USING btree ("consumed_scan_id") WHERE "label_preview_receipts"."consumed_scan_id" is not null;--> statement-breakpoint
UPDATE "workflow_steps"
SET "input" = jsonb_set(
	"input",
	'{historicalScanId}',
	to_jsonb("id"::text),
	true
)
WHERE "step_type" IN ('label.historical.scan', 'label.thread.scan')
	AND NOT ("input" ? 'historicalScanId');--> statement-breakpoint
UPDATE "workflow_steps"
SET "input" = jsonb_set(
	"input",
	'{previewReceiptId}',
	'null'::jsonb,
	true
)
WHERE "step_type" IN ('label.historical.scan', 'label.thread.scan')
	AND NOT ("input" ? 'previewReceiptId');
