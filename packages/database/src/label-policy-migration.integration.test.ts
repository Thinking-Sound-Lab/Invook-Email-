import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const migrationsUrl = new URL("../drizzle/", import.meta.url);

test(
  "the label-policy upgrade preserves assignments and explicit requests while retiring automatic Batch work",
  { skip: !testDatabaseUrl },
  async () => {
    assert.ok(testDatabaseUrl);
    const client = postgres(testDatabaseUrl, {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    const testSchema = `label_policy_${uuidv4().replaceAll("-", "")}`;
    const userId = uuidv4();
    const accountId = uuidv4();
    const labelId = uuidv4();
    const receiptId = uuidv4();
    const historicalScanId = uuidv4();
    const manualThreadId = uuidv4();
    const pendingThreadId = uuidv4();
    const liveStepId = uuidv4();
    const batchStepId = uuidv4();
    const childStepId = uuidv4();
    const unrelatedStepId = uuidv4();
    const providerBatchId = `batch_${uuidv4()}`;
    const admittedAt = new Date("2026-08-01T10:00:00.000Z");
    const after = new Date("2026-07-02T10:00:00.000Z");
    async function applyMigration(filename: string): Promise<void> {
      const source = await readFile(new URL(filename, migrationsUrl), "utf8");
      for (const statement of source
        .replaceAll('"public".', `"${testSchema}".`)
        .split("--> statement-breakpoint")) {
        if (statement.trim()) await client.unsafe(statement);
      }
    }
    try {
      await client.unsafe(`CREATE SCHEMA "${testSchema}"`);
      await client.unsafe(
        "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public",
      );
      await client.unsafe(`SET search_path TO "${testSchema}", public`);
      const migrationFiles = (await readdir(migrationsUrl))
        .filter((filename) => /^\d{4}_.+\.sql$/.test(filename))
        .sort();
      for (const filename of migrationFiles.filter(
        (filename) => filename < "0036_",
      ))
        await applyMigration(filename);
      await client`INSERT INTO profiles (id, email, display_name) VALUES (${userId}, 'owner@example.test', 'Migration test')`;
      await client`INSERT INTO connected_accounts (id, user_id, provider_account_id, email, memory_acknowledged_at)
      VALUES (${accountId}, ${userId}, ${accountId}, 'owner@example.test', now())`;
      await client`INSERT INTO labels (id, user_id, account_id, kind, name, normalized_name, description)
      VALUES (${labelId}, ${userId}, ${accountId}, 'invook', 'Billing', 'billing', 'Billing records')`;
      await client`INSERT INTO labels (user_id, account_id, kind, provider_label_id, name, normalized_name, provider_type)
      VALUES (${userId}, ${accountId}, 'gmail', 'IMPORTANT', 'Important', 'important', 'system'),
             (${userId}, ${accountId}, 'gmail', 'INBOX', 'Inbox', 'inbox', 'system')`;
      await client`INSERT INTO threads (id, user_id, account_id, provider_thread_id, label_analysis_state)
      VALUES (${manualThreadId}, ${userId}, ${accountId}, ${manualThreadId}, 'running'),
             (${pendingThreadId}, ${userId}, ${accountId}, ${pendingThreadId}, 'pending')`;
      await client`INSERT INTO thread_label_assignments (thread_id, user_id, account_id, label_id, source, definition_version)
      VALUES (${manualThreadId}, ${userId}, ${accountId}, ${labelId}, 'user', 1)`;
      await client`INSERT INTO label_preview_receipts (id, user_id, account_id, definition_hash, scanned_thread_count, expires_at, consumed_scan_id)
      VALUES (${receiptId}, ${userId}, ${accountId}, ${"a".repeat(64)}, 0, now(), ${historicalScanId})`;
      const request = {
        historicalScanId,
        labelId,
        previewReceiptId: receiptId,
        definitionVersion: 1,
        enablementVersion: 1,
        after: after.toISOString(),
      };
      // The coordinator has completed, but its per-thread work is still pending.
      await client`INSERT INTO workflow_steps (user_id, account_id, step_type, status, input, idempotency_key, created_at)
      VALUES (${userId}, ${accountId}, 'label.historical.scan', 'complete', ${client.json(request)}, ${uuidv4()}, ${admittedAt})`;
      await client`INSERT INTO workflow_steps (id, user_id, account_id, step_type, input, idempotency_key)
      VALUES (${childStepId}, ${userId}, ${accountId}, 'label.thread.scan', ${client.json(request)}, ${uuidv4()}),
             (${liveStepId}, ${userId}, ${accountId}, 'label.thread.assign', '{}', ${uuidv4()}),
             (${batchStepId}, ${userId}, ${accountId}, 'label.batch.submit', '{}', ${uuidv4()}),
             (${unrelatedStepId}, ${userId}, ${accountId}, 'memory.extract', '{}', ${uuidv4()})`;
      for (const stepId of [
        childStepId,
        liveStepId,
        batchStepId,
        unrelatedStepId,
      ]) {
        await client`INSERT INTO temporal_commands (workflow_step_id, activity_task_lane) VALUES (${stepId}, 'bulk')`;
      }
      await client`INSERT INTO thread_label_batch_submissions (workflow_step_id, user_id, account_id, model_id, definition_hash, request_count, manifest, status, provider_batch_id, input_file_id)
      VALUES (${batchStepId}, ${userId}, ${accountId}, 'test-model', ${"a".repeat(64)}, 1,
        ${client.json([{ threadId: pendingThreadId, analysisVersion: 1, definitionHash: "a".repeat(64), fallbackLabelId: labelId }])},
        'submitted', ${providerBatchId}, 'test-input-file')`;
      for (const filename of migrationFiles.filter(
        (filename) => filename >= "0036_",
      ))
        await applyMigration(filename);

      const [scan] =
        await client`SELECT id, label_id, definition_version, enablement_version, "after", "before", preview_receipt_id, status FROM historical_thread_label_scans`;
      assert.deepEqual(scan, {
        id: historicalScanId,
        label_id: labelId,
        definition_version: 1,
        enablement_version: 1,
        after,
        before: admittedAt,
        preview_receipt_id: receiptId,
        status: "queued",
      });
      assert.deepEqual(
        Array.from(
          await client`SELECT label_id, source FROM thread_label_assignments WHERE thread_id = ${manualThreadId}`,
        ),
        [{ label_id: labelId, source: "user" }],
      );
      const [manualThread] =
        await client`SELECT label_analysis_state FROM threads WHERE id = ${manualThreadId}`;
      const [pendingThread] =
        await client`SELECT label_analysis_state FROM threads WHERE id = ${pendingThreadId}`;
      assert.equal(manualThread?.label_analysis_state, "complete");
      assert.equal(pendingThread?.label_analysis_state, "not_requested");
      const retiredSteps =
        await client`SELECT status, result FROM workflow_steps WHERE id IN (${childStepId}, ${liveStepId}, ${batchStepId})`;
      assert.equal(retiredSteps.length, 3);
      assert.ok(
        retiredSteps.every(
          (step) =>
            step.status === "complete" &&
            step.result.status === "label_policy_superseded",
        ),
      );
      assert.deepEqual(
        Array.from(
          await client`SELECT workflow_step_id FROM temporal_commands`,
        ),
        [{ workflow_step_id: unrelatedStepId }],
      );
      const [batch] =
        await client`SELECT status, historical_scan_id, last_error, provider_batch_id FROM thread_label_batch_submissions`;
      assert.deepEqual(batch, {
        status: "failed",
        historical_scan_id: null,
        last_error: "automatic_labeling_superseded",
        provider_batch_id: providerBatchId,
      });
      assert.deepEqual(
        Array.from(
          await client`SELECT provider_label_id FROM labels WHERE kind = 'gmail'`,
        ),
        [{ provider_label_id: "INBOX" }],
      );
      await assert.rejects(
        () => client`INSERT INTO labels (user_id, account_id, kind, provider_label_id, name, normalized_name, provider_type)
      VALUES (${userId}, ${accountId}, 'gmail', 'IMPORTANT', 'Important', 'important', 'system')`,
        /labels_gmail_mailbox_state_check/,
      );
      const removedColumns =
        await client`SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${testSchema} AND table_name = 'thread_label_batch_submissions' AND column_name IN ('has_more', 'flush_remainder')`;
      assert.equal(removedColumns.length, 0);
    } finally {
      await client.unsafe("SET search_path TO public");
      await client.unsafe(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
      await client.end();
    }
  },
);
