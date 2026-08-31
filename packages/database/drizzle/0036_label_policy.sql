CREATE TABLE "historical_thread_label_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"definition_version" integer NOT NULL,
	"enablement_version" integer NOT NULL,
	"after" timestamp with time zone NOT NULL,
	"before" timestamp with time zone NOT NULL,
	"preview_receipt_id" uuid,
	"cursor_thread_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_thread_label_scans_status_check" CHECK ("historical_thread_label_scans"."status" in ('queued', 'running', 'complete', 'failed', 'superseded')),
	CONSTRAINT "historical_thread_label_scans_window_check" CHECK ("historical_thread_label_scans"."after" <= "historical_thread_label_scans"."before"),
	CONSTRAINT "historical_thread_label_scans_versions_check" CHECK ("historical_thread_label_scans"."definition_version" > 0 and "historical_thread_label_scans"."enablement_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "threads" DROP CONSTRAINT "threads_label_analysis_state_check";--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "label_analysis_state" SET DEFAULT 'not_requested';--> statement-breakpoint
ALTER TABLE "thread_label_batch_submissions" ADD COLUMN "historical_scan_id" uuid;--> statement-breakpoint
ALTER TABLE "thread_label_batch_submissions" ADD COLUMN "retry_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "label_analysis_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "historical_thread_label_scans" ADD CONSTRAINT "historical_thread_label_scans_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_thread_label_scans" ADD CONSTRAINT "historical_thread_label_scans_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_thread_label_scans" ADD CONSTRAINT "historical_thread_label_scans_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_thread_label_scans" ADD CONSTRAINT "historical_thread_label_scans_preview_receipt_id_label_preview_receipts_id_fk" FOREIGN KEY ("preview_receipt_id") REFERENCES "public"."label_preview_receipts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "historical_thread_label_scans_account_status_idx" ON "historical_thread_label_scans" USING btree ("account_id","status");--> statement-breakpoint
ALTER TABLE "thread_label_batch_submissions" ADD CONSTRAINT "thread_label_batch_submissions_historical_scan_id_historical_thread_label_scans_id_fk" FOREIGN KEY ("historical_scan_id") REFERENCES "public"."historical_thread_label_scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "thread_label_batch_submissions_scan_active_idx" ON "thread_label_batch_submissions" USING btree ("historical_scan_id") WHERE "thread_label_batch_submissions"."status" in ('preparing', 'submitted');--> statement-breakpoint
-- Preserve explicit settings requests before retiring their per-thread jobs.
INSERT INTO "historical_thread_label_scans" (
  "id", "user_id", "account_id", "label_id", "definition_version", "enablement_version", "after", "before", "preview_receipt_id", "created_at"
)
SELECT DISTINCT ON (coordinator."input"->>'historicalScanId')
  (coordinator."input"->>'historicalScanId')::uuid,
  coordinator."user_id", coordinator."account_id", (coordinator."input"->>'labelId')::uuid,
  (coordinator."input"->>'definitionVersion')::integer,
  (coordinator."input"->>'enablementVersion')::integer,
  (coordinator."input"->>'after')::timestamptz,
  coordinator."created_at", receipt."id", coordinator."created_at"
FROM "workflow_steps" coordinator
INNER JOIN "labels" label ON label."id" = (coordinator."input"->>'labelId')::uuid
  AND label."user_id" = coordinator."user_id" AND label."account_id" = coordinator."account_id"
LEFT JOIN "label_preview_receipts" receipt ON receipt."id" = (coordinator."input"->>'previewReceiptId')::uuid
WHERE coordinator."step_type" = 'label.historical.scan'
  AND EXISTS (
    SELECT 1 FROM "workflow_steps" pending
    WHERE pending."step_type" IN ('label.historical.scan', 'label.thread.scan')
      AND pending."status" IN ('queued', 'running')
      AND pending."input"->>'historicalScanId' = coordinator."input"->>'historicalScanId'
  )
ORDER BY coordinator."input"->>'historicalScanId', coordinator."created_at"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- The database terminal guard makes already-dispatched Temporal Activities no-op.
UPDATE "workflow_steps"
SET "status" = 'complete', "result" = '{"status":"label_policy_superseded"}'::jsonb,
  "completed_at" = now(), "updated_at" = now()
WHERE "step_type" IN ('label.thread.assign', 'label.historical.scan', 'label.thread.scan', 'label.batch.submit')
  AND "status" IN ('queued', 'running');--> statement-breakpoint
DELETE FROM "temporal_commands"
WHERE "workflow_step_id" IN (
  SELECT "id" FROM "workflow_steps" WHERE "result"->>'status' = 'label_policy_superseded'
);--> statement-breakpoint
UPDATE "thread_label_batch_submissions"
SET "status" = 'failed', "last_error" = 'automatic_labeling_superseded', "completed_at" = now(), "updated_at" = now()
WHERE "historical_scan_id" IS NULL AND "status" IN ('preparing', 'submitted');--> statement-breakpoint
-- Keep completed assignments. Unrequested history is not a pending AI backlog.
UPDATE "threads" thread
SET "label_analysis_state" = CASE WHEN EXISTS (
    SELECT 1 FROM "thread_label_assignments" assignment WHERE assignment."thread_id" = thread."id"
  ) THEN 'complete' ELSE 'not_requested' END,
  "label_analysis_version" = "label_analysis_version" + 1,
  "label_analysis_after" = NULL, "label_analysis_error" = NULL, "updated_at" = now()
WHERE "label_analysis_state" IN ('pending', 'running', 'failed');--> statement-breakpoint
-- Only operational Gmail state is retained internally; it is not a product label.
DELETE FROM "labels" WHERE "kind" = 'gmail'
  AND "provider_label_id" NOT IN ('INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM', 'STARRED', 'UNREAD');--> statement-breakpoint
ALTER TABLE "thread_label_batch_submissions" DROP COLUMN "flush_remainder";--> statement-breakpoint
ALTER TABLE "thread_label_batch_submissions" ADD CONSTRAINT "thread_label_batch_submissions_scope_check" CHECK ("thread_label_batch_submissions"."historical_scan_id" is not null or "thread_label_batch_submissions"."status" in ('complete', 'failed'));--> statement-breakpoint
ALTER TABLE "thread_label_batch_submissions" ADD CONSTRAINT "thread_label_batch_submissions_retry_check" CHECK ("thread_label_batch_submissions"."retry_attempt" between 0 and 6);--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_label_analysis_state_check" CHECK ("threads"."label_analysis_state" in ('not_requested', 'pending', 'running', 'complete', 'failed'));