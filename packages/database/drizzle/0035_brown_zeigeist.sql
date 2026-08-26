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
ALTER TABLE "gmail_sync_pages" ADD COLUMN "discovered_thread_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_sync_runs" ADD COLUMN "discovered_thread_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_sync_runs" ADD COLUMN "processed_thread_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_sync_runs" ADD COLUMN "failed_thread_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_sync_pages" DROP CONSTRAINT "gmail_sync_pages_message_count_check";--> statement-breakpoint
ALTER TABLE "mail_sync_runs" DROP CONSTRAINT "mail_sync_runs_message_counts_check";--> statement-breakpoint
DROP INDEX "gmail_sync_items_run_message_idx";--> statement-breakpoint
DROP INDEX "gmail_sync_items_run_thread_status_idx";--> statement-breakpoint
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
CREATE UNIQUE INDEX "gmail_sync_items_run_thread_idx" ON "gmail_sync_items" USING btree ("run_id","provider_thread_id");--> statement-breakpoint
ALTER TABLE "gmail_sync_items" DROP COLUMN "provider_message_id";--> statement-breakpoint
ALTER TABLE "gmail_sync_pages" DROP COLUMN "discovered_message_count";--> statement-breakpoint
ALTER TABLE "mail_sync_runs" DROP COLUMN "discovered_message_count";--> statement-breakpoint
ALTER TABLE "mail_sync_runs" DROP COLUMN "processed_message_count";--> statement-breakpoint
ALTER TABLE "mail_sync_runs" DROP COLUMN "failed_message_count";--> statement-breakpoint
ALTER TABLE "gmail_sync_pages" ADD CONSTRAINT "gmail_sync_pages_thread_count_check" CHECK ("gmail_sync_pages"."discovered_thread_count" >= 0);--> statement-breakpoint
ALTER TABLE "mail_sync_runs" ADD CONSTRAINT "mail_sync_runs_thread_counts_check" CHECK ("mail_sync_runs"."discovered_thread_count" >= 0 and "mail_sync_runs"."processed_thread_count" >= 0 and "mail_sync_runs"."failed_thread_count" >= 0);
