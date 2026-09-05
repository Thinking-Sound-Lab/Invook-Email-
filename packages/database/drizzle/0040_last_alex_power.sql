ALTER TABLE "memory_deletions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_entries" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_pending_evidence" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "memory_deletions" CASCADE;--> statement-breakpoint
DROP TABLE "memory_entries" CASCADE;--> statement-breakpoint
DROP TABLE "memory_pending_evidence" CASCADE;--> statement-breakpoint
DELETE FROM "drafts" WHERE "kind" <> 'gmail';--> statement-breakpoint
DELETE FROM "workflow_steps" WHERE "step_type" LIKE 'memory.%';--> statement-breakpoint
ALTER TABLE "drafts" DROP CONSTRAINT "drafts_kind_check";--> statement-breakpoint
ALTER TABLE "drafts" DROP CONSTRAINT "drafts_kind_contract_check";--> statement-breakpoint
ALTER TABLE "thread_label_batch_submissions" DROP CONSTRAINT "thread_label_batch_submissions_provider_check";--> statement-breakpoint
DROP INDEX "messages_memory_eligible_idx";--> statement-breakpoint
DROP INDEX "thread_label_batch_submissions_provider_batch_idx";--> statement-breakpoint
ALTER TABLE "connected_accounts" ALTER COLUMN "sync_state" SET DEFAULT '{"mailSync":"pending"}'::jsonb;--> statement-breakpoint
UPDATE "connected_accounts" SET "sync_state" = "sync_state" - 'memory';--> statement-breakpoint
ALTER TABLE "drafts" ALTER COLUMN "kind" SET DEFAULT 'gmail';--> statement-breakpoint
CREATE UNIQUE INDEX "thread_label_batch_submissions_provider_batch_idx" ON "thread_label_batch_submissions" USING btree ("provider_batch_id") WHERE "thread_label_batch_submissions"."provider_batch_id" is not null;--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "memory_acknowledged_at";--> statement-breakpoint
ALTER TABLE "drafts" DROP COLUMN "generated_text";--> statement-breakpoint
ALTER TABLE "drafts" DROP COLUMN "final_sent_text";--> statement-breakpoint
ALTER TABLE "drafts" DROP COLUMN "used_memory_ids";--> statement-breakpoint
ALTER TABLE "drafts" DROP COLUMN "generation_metadata";--> statement-breakpoint
ALTER TABLE "drafts" DROP COLUMN "edit_signals";--> statement-breakpoint
ALTER TABLE "drafts" DROP COLUMN "feedback_version";--> statement-breakpoint
ALTER TABLE "drafts" DROP COLUMN "last_feedback_at";--> statement-breakpoint
ALTER TABLE "drafts" DROP COLUMN "generated_at";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "is_memory_eligible";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "excluded_from_memory";--> statement-breakpoint
ALTER TABLE "profiles" DROP COLUMN "memory_acknowledged_at";--> statement-breakpoint
ALTER TABLE "thread_label_batch_submissions" DROP COLUMN "provider";--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_kind_check" CHECK ("drafts"."kind" = 'gmail');--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_kind_contract_check" CHECK ("drafts"."provider_draft_id" is not null and "drafts"."provider_thread_id" is not null);