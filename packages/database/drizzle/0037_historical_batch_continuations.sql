ALTER TABLE "thread_label_batch_submissions" ADD COLUMN "continuations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_gmail_mailbox_state_check" CHECK ("labels"."kind" <> 'gmail' or "labels"."provider_label_id" in ('INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM', 'STARRED', 'UNREAD'));--> statement-breakpoint
ALTER TABLE "thread_label_batch_submissions" DROP COLUMN "has_more";
