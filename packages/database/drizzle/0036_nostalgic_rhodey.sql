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
ALTER TABLE "messages" DROP CONSTRAINT "messages_raw_content_length_check";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "raw_object_key";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "raw_checksum_sha256";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "raw_content_length";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "raw_etag";
