ALTER TABLE "thread_label_batch_submissions" DROP CONSTRAINT "thread_label_batch_submissions_workflow_step_id_workflow_steps_id_fk";
--> statement-breakpoint
DROP INDEX "thread_label_batch_submissions_workflow_step_idx";--> statement-breakpoint
ALTER TABLE "thread_label_batch_submissions" DROP COLUMN "workflow_step_id";