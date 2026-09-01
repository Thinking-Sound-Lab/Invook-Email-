DROP INDEX "connected_accounts_provider_identity_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "connected_accounts_user_provider_identity_idx" ON "connected_accounts" USING btree ("user_id","provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "connected_accounts_active_email_idx" ON "connected_accounts" USING btree (lower("email")) WHERE "connected_accounts"."status" = 'connected';--> statement-breakpoint
CREATE INDEX "connected_accounts_provider_identity_idx" ON "connected_accounts" USING btree ("provider","provider_account_id");