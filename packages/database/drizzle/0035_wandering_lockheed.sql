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
	AND NOT ("input" ? 'previewReceiptId');--> statement-breakpoint
UPDATE "workflow_steps"
SET
	"status" = 'failed',
	"last_error" = 'gmail_sync_architecture_superseded',
	"completed_at" = COALESCE("completed_at", now()),
	"updated_at" = now()
WHERE "run_id" IN (
	SELECT "id" FROM "mail_sync_runs" WHERE "status" IN ('queued', 'running')
)
	AND "status" IN ('queued', 'running');--> statement-breakpoint
UPDATE "gmail_replica_states"
SET
	"state" = 'failed',
	"last_error" = 'gmail_sync_architecture_superseded',
	"updated_at" = now()
WHERE "account_id" IN (
	SELECT "account_id" FROM "mail_sync_runs" WHERE "status" IN ('queued', 'running')
);--> statement-breakpoint
UPDATE "connected_accounts"
SET
	"sync_state" = jsonb_set("sync_state", '{mailSync}', '"failed"'::jsonb, true),
	"updated_at" = now()
WHERE "id" IN (
	SELECT "account_id" FROM "mail_sync_runs" WHERE "status" IN ('queued', 'running')
);--> statement-breakpoint
UPDATE "gmail_sync_items"
SET
	"status" = 'failed',
	"last_error" = 'gmail_sync_architecture_superseded',
	"completed_at" = COALESCE("completed_at", now()),
	"updated_at" = now()
WHERE "run_id" IN (
	SELECT "id" FROM "mail_sync_runs" WHERE "status" IN ('queued', 'running')
)
	AND "status" IN ('queued', 'running');--> statement-breakpoint
UPDATE "mail_sync_runs"
SET
	"status" = 'failed',
	"last_error" = 'gmail_sync_architecture_superseded',
	"completed_at" = COALESCE("completed_at", now()),
	"updated_at" = now()
WHERE "status" IN ('queued', 'running');--> statement-breakpoint
ALTER TABLE "gmail_sync_pages" DROP CONSTRAINT "gmail_sync_pages_message_count_check";--> statement-breakpoint
ALTER TABLE "mail_sync_runs" DROP CONSTRAINT "mail_sync_runs_message_counts_check";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_raw_content_length_check";--> statement-breakpoint
DROP INDEX "gmail_sync_items_run_message_idx";--> statement-breakpoint
DROP INDEX "gmail_sync_items_run_thread_status_idx";--> statement-breakpoint
ALTER TABLE "gmail_sync_pages" ADD COLUMN "discovered_thread_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_sync_runs" ADD COLUMN "discovered_thread_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_sync_runs" ADD COLUMN "processed_thread_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_sync_runs" ADD COLUMN "failed_thread_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DELETE FROM "gmail_sync_items" WHERE "provider_thread_id" IS NULL;--> statement-breakpoint
WITH "grouped_items" AS (
	SELECT
		"run_id",
		"provider_thread_id",
		(array_agg("id" ORDER BY "id"::text))[1] AS "keep_id",
		CASE
			WHEN bool_or("status" = 'failed') THEN 'failed'
			WHEN bool_and("status" = 'complete') THEN 'complete'
			ELSE 'queued'
		END AS "status",
		max("attempts") AS "attempts",
		min("started_at") AS "started_at",
		max("completed_at") AS "completed_at",
		(array_remove(array_agg("last_error" ORDER BY "updated_at" DESC), NULL))[1] AS "last_error"
	FROM "gmail_sync_items"
	GROUP BY "run_id", "provider_thread_id"
)
UPDATE "gmail_sync_items" AS "item"
SET
	"status" = "grouped_items"."status",
	"attempts" = "grouped_items"."attempts",
	"started_at" = "grouped_items"."started_at",
	"completed_at" = CASE
		WHEN "grouped_items"."status" IN ('complete', 'failed') THEN "grouped_items"."completed_at"
		ELSE NULL
	END,
	"last_error" = "grouped_items"."last_error",
	"updated_at" = now()
FROM "grouped_items"
WHERE "item"."id" = "grouped_items"."keep_id";--> statement-breakpoint
WITH "ranked_items" AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "run_id", "provider_thread_id"
			ORDER BY "id"::text
		) AS "position"
	FROM "gmail_sync_items"
)
DELETE FROM "gmail_sync_items"
USING "ranked_items"
WHERE "gmail_sync_items"."id" = "ranked_items"."id"
	AND "ranked_items"."position" > 1;--> statement-breakpoint
UPDATE "mail_sync_runs" AS "run"
SET
	"discovered_thread_count" = "counts"."total",
	"processed_thread_count" = "counts"."complete",
	"failed_thread_count" = "counts"."failed",
	"updated_at" = now()
FROM (
	SELECT
		"run_id",
		count(*)::integer AS "total",
		count(*) FILTER (WHERE "status" = 'complete')::integer AS "complete",
		count(*) FILTER (WHERE "status" = 'failed')::integer AS "failed"
	FROM "gmail_sync_items"
	GROUP BY "run_id"
) AS "counts"
WHERE "run"."id" = "counts"."run_id";--> statement-breakpoint
ALTER TABLE "gmail_sync_items" ALTER COLUMN "provider_thread_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "label_preview_receipts" ADD CONSTRAINT "label_preview_receipts_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_preview_receipts" ADD CONSTRAINT "label_preview_receipts_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "label_preview_receipts_account_expiration_idx" ON "label_preview_receipts" USING btree ("account_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "label_preview_receipts_consumed_scan_idx" ON "label_preview_receipts" USING btree ("consumed_scan_id") WHERE "label_preview_receipts"."consumed_scan_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_sync_items_run_thread_idx" ON "gmail_sync_items" USING btree ("run_id","provider_thread_id");--> statement-breakpoint
INSERT INTO "workflow_steps" (
	"user_id",
	"account_id",
	"step_type",
	"status",
	"input",
	"attempts",
	"max_attempts",
	"idempotency_key"
)
SELECT
	message."user_id",
	message."account_id",
	'gmail.objects.delete',
	'queued',
	jsonb_build_object(
		'manifest',
		jsonb_build_object(
			'providerMessageId', message."provider_message_id",
			'providerThreadId', thread."provider_thread_id",
			'providerHistoryId', message."provider_history_id",
			'objectKeys', jsonb_build_array(message."raw_object_key")
		)
	),
	0,
	10,
	'gmail-object-delete:raw-mime-migration:' || message."id"::text
FROM "messages" AS message
INNER JOIN "threads" AS thread ON thread."id" = message."thread_id"
WHERE message."raw_object_key" IS NOT NULL
	AND btrim(message."raw_object_key") <> ''
ON CONFLICT ("idempotency_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "temporal_commands" ("workflow_step_id", "activity_task_lane")
SELECT step."id", 'bulk'
FROM "workflow_steps" AS step
WHERE step."idempotency_key" LIKE 'gmail-object-delete:raw-mime-migration:%'
	AND step."status" IN ('queued', 'running')
ON CONFLICT ("workflow_step_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "gmail_sync_items" DROP COLUMN "provider_message_id";--> statement-breakpoint
ALTER TABLE "gmail_sync_pages" DROP COLUMN "discovered_message_count";--> statement-breakpoint
ALTER TABLE "mail_sync_runs" DROP COLUMN "discovered_message_count";--> statement-breakpoint
ALTER TABLE "mail_sync_runs" DROP COLUMN "processed_message_count";--> statement-breakpoint
ALTER TABLE "mail_sync_runs" DROP COLUMN "failed_message_count";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "raw_object_key";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "raw_checksum_sha256";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "raw_content_length";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "raw_etag";--> statement-breakpoint
ALTER TABLE "gmail_sync_pages" ADD CONSTRAINT "gmail_sync_pages_thread_count_check" CHECK ("gmail_sync_pages"."discovered_thread_count" >= 0);--> statement-breakpoint
ALTER TABLE "mail_sync_runs" ADD CONSTRAINT "mail_sync_runs_thread_counts_check" CHECK ("mail_sync_runs"."discovered_thread_count" >= 0 and "mail_sync_runs"."processed_thread_count" >= 0 and "mail_sync_runs"."failed_thread_count" >= 0);
