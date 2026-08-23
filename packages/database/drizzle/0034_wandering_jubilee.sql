DELETE FROM "temporal_commands"
WHERE "workflow_step_id" IN (
	SELECT "id"
	FROM "workflow_steps"
	WHERE "step_type" IN ('embedding.backfill', 'embedding.incremental', 'embedding.batch.event')
);--> statement-breakpoint
UPDATE "workflow_steps"
SET
	"status" = 'complete',
	"result" = coalesce("result", '{}'::jsonb) || '{"status":"retired","reason":"embedding_removed"}'::jsonb,
	"last_error" = NULL,
	"completed_at" = coalesce("completed_at", now()),
	"updated_at" = now()
WHERE
	"step_type" IN ('embedding.backfill', 'embedding.incremental', 'embedding.batch.event')
	AND "status" IN ('queued', 'running');--> statement-breakpoint
UPDATE "connected_accounts"
SET "sync_state" = "sync_state" - 'indexing'
WHERE "sync_state" ? 'indexing';--> statement-breakpoint
ALTER TABLE "embedding_batch_submissions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_embeddings" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "embedding_batch_submissions" CASCADE;--> statement-breakpoint
DROP TABLE "message_embeddings" CASCADE;--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_embedding_content_hash_check";--> statement-breakpoint
ALTER TABLE "connected_accounts" ALTER COLUMN "sync_state" SET DEFAULT '{"mailSync":"pending","memory":"pending"}'::jsonb;--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "embedding_content_hash";--> statement-breakpoint
DROP EXTENSION IF EXISTS "vector";
