ALTER TABLE "messages" DROP CONSTRAINT "messages_raw_content_length_check";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "raw_object_key";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "raw_checksum_sha256";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "raw_content_length";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "raw_etag";