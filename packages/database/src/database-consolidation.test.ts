import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

const migrationUrl = new URL(
  "../drizzle/0021_nervous_lucky_pierre.sql",
  import.meta.url,
);
const removeBuiltInLabelsMigrationUrl = new URL(
  "../drizzle/0022_burly_magneto.sql",
  import.meta.url,
);
const authenticationMigrationUrl = new URL(
  "../drizzle/0024_yielding_talisman.sql",
  import.meta.url,
);
const temporalMigrationUrl = new URL(
  "../drizzle/0026_curvy_glorian.sql",
  import.meta.url,
);
const rebasedMailboxEventMigrationUrl = new URL(
  "../drizzle/0029_rebased_mailbox_event_contract.sql",
  import.meta.url,
);
const threadLabelsMigrationUrl = new URL(
  "../drizzle/0030_parallel_tarantula.sql",
  import.meta.url,
);
const threadLabelBatchMigrationUrl = new URL(
  "../drizzle/0032_brave_kree.sql",
  import.meta.url,
);
const tenantTemporalRoutingMigrationUrl = new URL(
  "../drizzle/0033_shallow_apocalypse.sql",
  import.meta.url,
);
const removeEmbeddingMigrationUrl = new URL(
  "../drizzle/0034_wandering_jubilee.sql",
  import.meta.url,
);
const threadSyncMigrationUrl = new URL(
  "../drizzle/0035_wandering_lockheed.sql",
  import.meta.url,
);
const schemaUrl = new URL("./schema.ts", import.meta.url);
const migrationsUrl = new URL("../drizzle/", import.meta.url);
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

function assertBefore(source: string, earlier: string, later: string): void {
  const earlierIndex = source.indexOf(earlier);
  const laterIndex = source.indexOf(later);
  assert.notEqual(earlierIndex, -1, `missing migration fragment: ${earlier}`);
  assert.notEqual(laterIndex, -1, `missing migration fragment: ${later}`);
  assert.ok(earlierIndex < laterIndex, `${earlier} must precede ${later}`);
}

test("the Drizzle schema has exactly the 27 owned tables without embedding or Memory storage", async () => {
  const source = await readFile(schemaUrl, "utf8");
  assert.equal(source.match(/\bpgTable\s*\(/g)?.length, 27);
  assert.doesNotMatch(source, /memoryEntries/);
  assert.doesNotMatch(source, /memoryPendingEvidence/);
  assert.doesNotMatch(source, /memoryDeletions/);
  assert.doesNotMatch(source, /messageEmbeddings/);
  assert.doesNotMatch(source, /embeddingBatchSubmissions/);
  assert.doesNotMatch(source, /embeddingContentHash/);
  assert.doesNotMatch(source, /\bvector\s*\(/);
});

test("the thread-sync migration preserves durable label and object work before retiring legacy storage", async () => {
  const migration = await readFile(threadSyncMigrationUrl, "utf8");

  assert.match(migration, /CREATE TABLE "label_preview_receipts"/);
  assert.match(migration, /'\{historicalScanId\}'/);
  assert.match(migration, /'\{previewReceiptId\}'/);
  assertBefore(
    migration,
    'WHERE "provider_thread_id" IS NULL',
    'ALTER COLUMN "provider_thread_id" SET NOT NULL',
  );
  assertBefore(
    migration,
    'PARTITION BY "run_id", "provider_thread_id"',
    'CREATE UNIQUE INDEX "gmail_sync_items_run_thread_idx"',
  );
  assertBefore(
    migration,
    "'gmail.objects.delete'",
    'DROP COLUMN "raw_object_key"',
  );
  assertBefore(
    migration,
    'INSERT INTO "temporal_commands"',
    'DROP COLUMN "raw_object_key"',
  );
});

test("the auth migration preserves identity without copying Gmail credentials", async () => {
  const migration = await readFile(authenticationMigrationUrl, "utf8");

  assertBefore(
    migration,
    'UPDATE "profiles" AS profile',
    'CREATE UNIQUE INDEX "profiles_email_idx"',
  );
  assert.match(migration, /'google'/);
  assert.match(migration, /'openid,email,profile'/);
  assert.doesNotMatch(migration, /INSERT INTO "auth_accounts"[^;]+token_ciphertext/s);
});

test("the auth user contract backfills real identity data before enforcing required fields", async () => {
  const migration = await readFile(authenticationMigrationUrl, "utf8");

  assertBefore(
    migration,
    'FROM "connected_accounts"',
    "Cannot enforce Better Auth user requirements",
  );
  assertBefore(
    migration,
    "Cannot enforce Better Auth user requirements",
    'ALTER TABLE "profiles" ALTER COLUMN "display_name" SET NOT NULL',
  );
  assertBefore(
    migration,
    "Cannot enforce Better Auth user requirements",
    'ALTER TABLE "profiles" ALTER COLUMN "email" SET NOT NULL',
  );
});

test("the Temporal migration preserves commands and redrives unfinished work", async () => {
  const migration = await readFile(temporalMigrationUrl, "utf8");

  assert.match(
    migration,
    /ALTER TABLE "queue_outbox" RENAME TO "temporal_commands"/,
  );
  assertBefore(
    migration,
    'DROP TRIGGER IF EXISTS "queue_outbox_notify_worker"',
    'CREATE TRIGGER "temporal_commands_notify_worker"',
  );
  assert.match(migration, /pg_notify\('invook_temporal_commands'/);
  assert.match(
    migration,
    /"workflow_steps"\."status" IN \('queued', 'running'\)/,
  );
  assert.doesNotMatch(migration, /DROP TABLE "queue_outbox"/);
});

test("the post-rebase migration reconciles existing mailbox event databases", async () => {
  const migration = await readFile(rebasedMailboxEventMigrationUrl, "utf8");

  assertBefore(
    migration,
    "WHERE \"change_type\" = 'repair_complete'",
    "ADD CONSTRAINT \"mailbox_change_events_type_check\"",
  );
  assert.match(migration, /CREATE OR REPLACE FUNCTION notify_invook_mailbox_change/);
  assert.match(migration, /'eventId', NEW\.id/);
  assert.match(migration, /'userId', NEW\.user_id/);
  assert.match(migration, /'accountId', NEW\.account_id/);
});

test("the consolidation migration backfills durable state before removing legacy tables", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  for (const [backfill, removedTable] of [
    ['FROM "gmail_labels"', 'DROP TABLE "gmail_labels"'],
    ['FROM "gmail_message_labels"', 'DROP TABLE "gmail_message_labels"'],
    ['FROM "thread_label_analyses"', 'DROP TABLE "thread_label_analyses"'],
    ['FROM "thread_labels"', 'DROP TABLE "thread_labels"'],
    ['FROM "gmail_drafts"', 'DROP TABLE "gmail_drafts"'],
    ['FROM "gmail_push_events"', 'DROP TABLE "gmail_push_events"'],
    ['FROM "gmail_message_tombstones"', 'DROP TABLE "gmail_message_tombstones"'],
  ] as const) {
    assertBefore(migration, backfill, removedTable);
  }

  assertBefore(
    migration,
    "INSERT INTO \"queue_outbox\"",
    'DROP TABLE "gmail_push_events"',
  );
  assertBefore(
    migration,
    "'gmail.objects.delete'",
    'DROP TABLE "gmail_message_tombstones"',
  );
  assertBefore(
    migration,
    'INSERT INTO "drafts"',
    'ALTER TABLE "drafts" ADD CONSTRAINT "drafts_kind_contract_check"',
  );
  assertBefore(
    migration,
    'INSERT INTO "labels"',
    'ALTER TABLE "labels" ADD CONSTRAINT "labels_kind_contract_check"',
  );
  assert.doesNotMatch(migration, /DROP TABLE[^;]+CASCADE/i);
});

test("the consolidated provider identities retain account-scoped uniqueness", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "labels_account_provider_idx" ON "labels" \("account_id", "provider_label_id"\) WHERE "provider_label_id" IS NOT NULL/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "drafts_account_provider_idx" ON "drafts" \("account_id", "provider_draft_id"\) WHERE "provider_draft_id" IS NOT NULL/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "message_labels_message_label_idx" ON "message_labels" \("message_id", "label_id"\)/,
  );
});

test("the built-in Invook labels are deleted before system_key is removed", async () => {
  const migration = await readFile(removeBuiltInLabelsMigrationUrl, "utf8");

  assertBefore(
    migration,
    `DELETE FROM "labels"\nWHERE "kind" = 'invook' AND "system_key" IS NOT NULL`,
    'ALTER TABLE "labels" DROP COLUMN "system_key"',
  );
});

test("the thread-label migration preserves only unambiguous manual state", async () => {
  const migration = await readFile(threadLabelsMigrationUrl, "utf8");

  assert.match(
    migration,
    /HAVING COUNT\(DISTINCT membership\."label_id"\) = 1/,
  );
  assertBefore(
    migration,
    'INSERT INTO "thread_label_assignments"',
    'DELETE FROM "message_labels" WHERE "source" <> \'gmail\'',
  );
  assertBefore(
    migration,
    "('Others', 'others'",
    'ALTER TABLE "labels" ADD CONSTRAINT "labels_enabled_contract_check"',
  );
  assert.match(
    migration,
    /step\."step_type" IN \('label\.message\.analyze', 'label\.message\.apply'\)/,
  );
});

test("the thread-label Batch migration supersedes per-thread assignments safely", async () => {
  const migration = await readFile(threadLabelBatchMigrationUrl, "utf8");

  assert.match(migration, /CREATE TABLE "thread_label_batch_submissions"/);
  assert.match(migration, /"request_count" between 1 and 2000/);
  assert.match(migration, /ADD COLUMN "provider_thread_id" text/);
  assert.match(migration, /"step_type" = 'label\.thread\.assign'/);
  assert.match(migration, /superseded_by_batch/);
  assert.match(migration, /"label_analysis_state" = 'pending'/);
  assert.match(migration, /'mail-label-events'/);
});

test("the tenant Temporal migration replaces legacy queues with required lanes", async () => {
  const migration = await readFile(tenantTemporalRoutingMigrationUrl, "utf8");

  assertBefore(
    migration,
    'ADD COLUMN "activity_task_lane" text',
    'ALTER COLUMN "activity_task_lane" SET NOT NULL',
  );
  assertBefore(
    migration,
    'ALTER COLUMN "activity_task_lane" SET NOT NULL',
    'DROP COLUMN "activity_task_queue"',
  );
  assert.match(migration, /UPDATE "temporal_commands" command[\s\S]+FROM "workflow_steps" step/);
  assert.match(migration, /'gmail\.history\.catchup'[\s\S]+THEN 'control'/);
  assert.match(migration, /'gmail\.sync\.page'[\s\S]+THEN 'bulk'/);
  assert.match(migration, /activity_task_lane_check[\s\S]+\('control', 'live', 'bulk'\)/);
  assert.doesNotMatch(migration, /routing_version/);
  assert.match(migration, /CREATE INDEX "workflow_steps_user_status_idx"/);
});

test("the embedding removal migration retires durable work before dropping storage", async () => {
  const migration = await readFile(removeEmbeddingMigrationUrl, "utf8");

  assertBefore(
    migration,
    'DELETE FROM "temporal_commands"',
    'DROP TABLE "embedding_batch_submissions"',
  );
  assertBefore(
    migration,
    'UPDATE "workflow_steps"',
    'DROP TABLE "embedding_batch_submissions"',
  );
  assertBefore(
    migration,
    'UPDATE "connected_accounts"',
    'DROP TABLE "message_embeddings"',
  );
  assertBefore(
    migration,
    'DROP TABLE "message_embeddings"',
    'DROP EXTENSION IF EXISTS "vector"',
  );
  assert.match(migration, /'embedding\.backfill'/);
  assert.match(migration, /'embedding\.incremental'/);
  assert.match(migration, /'embedding\.batch\.event'/);
});

async function applyMigrationFile(
  client: postgres.Sql | postgres.TransactionSql,
  filename: string,
  schemaName?: string,
): Promise<void> {
  const source = await readFile(new URL(filename, migrationsUrl), "utf8");
  const migration = schemaName
    ? source.replaceAll('"public".', `"${schemaName}".`)
    : source;
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
}

test(
  "the auth migrations produce a strict Better Auth user contract",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const testSchema = `auth_migration_${uuidv4().replaceAll("-", "")}`;
    try {
      await client.unsafe(`CREATE SCHEMA "${testSchema}"`);
      await client.unsafe("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
      await client.unsafe(`SET search_path TO "${testSchema}", public`);
      const migrationFiles = (await readdir(migrationsUrl))
        .filter((filename) => /^\d{4}_.+\.sql$/.test(filename))
        .sort();
      for (const filename of migrationFiles.filter((name) => name < "0024_")) {
        await applyMigrationFile(client, filename, testSchema);
      }

      await client.unsafe(`
        INSERT INTO profiles (id) VALUES
          ('11111111-1111-4111-8111-111111111111'),
          ('33333333-3333-4333-8333-333333333333');
        INSERT INTO connected_accounts (
          id, user_id, provider_account_id, email, memory_acknowledged_at
        ) VALUES (
          '22222222-2222-4222-8222-222222222222',
          '11111111-1111-4111-8111-111111111111',
          'provider-account',
          'owner@example.com',
          now()
        );
      `);

      await assert.rejects(
        () =>
          client.begin(async (transaction) => {
            await applyMigrationFile(
              transaction,
              "0024_yielding_talisman.sql",
              testSchema,
            );
          }),
        /Cannot enforce Better Auth user requirements/,
      );
      await client.unsafe(`
        DELETE FROM profiles
        WHERE id = '33333333-3333-4333-8333-333333333333'
      `);
      await applyMigrationFile(
        client,
        "0024_yielding_talisman.sql",
        testSchema,
      );

      assert.deepEqual(
        Array.from(
          await client`
            SELECT email, display_name
            FROM profiles
            WHERE id = '11111111-1111-4111-8111-111111111111'
          `,
        ),
        [{ email: "owner@example.com", display_name: "owner@example.com" }],
      );
      assert.deepEqual(
        Array.from(
          await client`
            SELECT column_name, is_nullable
            FROM information_schema.columns
            WHERE table_schema = ${testSchema}
              AND table_name = 'profiles'
              AND column_name IN ('display_name', 'email')
            ORDER BY column_name
          `,
        ),
        [
          { column_name: "display_name", is_nullable: "NO" },
          { column_name: "email", is_nullable: "NO" },
        ],
      );
    } finally {
      await client.unsafe("SET search_path TO public");
      await client.unsafe(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
      await client.end();
    }
  },
);

test(
  "the consolidation migration preserves legacy label, draft, push, and cleanup state",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const testSchema = `migration_${uuidv4().replaceAll("-", "")}`;
    try {
      await client.unsafe(`CREATE SCHEMA "${testSchema}"`);
      await client.unsafe("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
      await client.unsafe(`SET search_path TO "${testSchema}", public`);
      const migrationFiles = (await readdir(migrationsUrl))
        .filter((filename) => /^\d{4}_.+\.sql$/.test(filename))
        .sort();
      for (const filename of migrationFiles.filter((name) => name < "0021_")) {
        await applyMigrationFile(client, filename, testSchema);
      }

      await client.unsafe(`
        INSERT INTO profiles (id) VALUES ('11111111-1111-4111-8111-111111111111');
        INSERT INTO connected_accounts (
          id, user_id, provider_account_id, email, memory_acknowledged_at
        ) VALUES (
          '22222222-2222-4222-8222-222222222222',
          '11111111-1111-4111-8111-111111111111',
          'provider-account',
          'owner@example.com',
          now()
        );
        INSERT INTO gmail_replica_states (
          account_id, initial_history_id, history_cursor, state, ready_at
        ) VALUES (
          '22222222-2222-4222-8222-222222222222', '100', '120', 'auditing', now()
        );
        INSERT INTO threads (
          id, user_id, account_id, provider_thread_id, message_count
        ) VALUES (
          '33333333-3333-4333-8333-333333333333',
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          'provider-thread',
          1
        );
        INSERT INTO messages (
          id, user_id, account_id, thread_id, provider_message_id, direction,
          sender, internal_date, sent_at
        ) VALUES (
          '44444444-4444-4444-8444-444444444444',
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          '33333333-3333-4333-8333-333333333333',
          'provider-message',
          'incoming',
          '{"raw":"Sender <sender@example.com>","email":"sender@example.com"}'::jsonb,
          now(),
          now()
        );
        INSERT INTO labels (
          id, user_id, account_id, name, normalized_name, description,
          definition_version, analysis_state
        ) VALUES (
          '55555555-5555-4555-8555-555555555555',
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          'Follow up',
          'follow up',
          'Needs a reply',
          3,
          'complete'
        );
        INSERT INTO gmail_labels (
          id, user_id, account_id, provider_label_id, name, type
        ) VALUES (
          '66666666-6666-4666-8666-666666666666',
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          'INBOX',
          'Inbox',
          'system'
        );
        INSERT INTO gmail_message_labels (account_id, message_id, gmail_label_id)
        VALUES (
          '22222222-2222-4222-8222-222222222222',
          '44444444-4444-4444-8444-444444444444',
          '66666666-6666-4666-8666-666666666666'
        );
        INSERT INTO thread_label_analyses (
          user_id, account_id, thread_id, label_id, definition_version, model_id
        ) VALUES (
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          '33333333-3333-4333-8333-333333333333',
          '55555555-5555-4555-8555-555555555555',
          3,
          'model-1'
        );
        INSERT INTO thread_labels (
          user_id, account_id, thread_id, label_id, source, state, analysis_version
        ) VALUES (
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          '33333333-3333-4333-8333-333333333333',
          '55555555-5555-4555-8555-555555555555',
          'user',
          'applied',
          3
        );
        INSERT INTO drafts (
          id, user_id, account_id, thread_id, current_text
        ) VALUES (
          '77777777-7777-4777-8777-777777777777',
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          '33333333-3333-4333-8333-333333333333',
          'Local reply'
        );
        INSERT INTO gmail_drafts (
          id, user_id, account_id, provider_draft_id, provider_message_id,
          provider_thread_id, message_id
        ) VALUES (
          '88888888-8888-4888-8888-888888888888',
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          'provider-draft',
          NULL,
          'provider-thread',
          '44444444-4444-4444-8444-444444444444'
        );
        INSERT INTO gmail_push_events (
          id, provider_event_id, account_id, email_address,
          notification_history_id, subscription, payload, status
        ) VALUES (
          '99999999-9999-4999-8999-999999999999',
          'provider-event',
          '22222222-2222-4222-8222-222222222222',
          'owner@example.com',
          '150',
          'subscription',
          '{}'::jsonb,
          'stored'
        );
        INSERT INTO gmail_message_tombstones (
          id, user_id, account_id, provider_message_id, provider_thread_id,
          provider_history_id, object_keys
        ) VALUES (
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          'deleted-message',
          'deleted-thread',
          '140',
          '["raw/deleted.eml"]'::jsonb
        );
      `);

      await applyMigrationFile(
        client,
        "0021_nervous_lucky_pierre.sql",
        testSchema,
      );

      const tableCount = await client<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM information_schema.tables
        WHERE table_schema = ${testSchema} AND table_type = 'BASE TABLE'
      `;
      assert.equal(tableCount[0]?.count, 25);
      assert.deepEqual(
        Array.from(
          await client`SELECT kind, count(*)::integer AS count FROM labels GROUP BY kind ORDER BY kind`,
        ),
        [
          { kind: "gmail", count: 1 },
          { kind: "invook", count: 1 },
        ],
      );
      assert.deepEqual(
        Array.from(
          await client`SELECT source FROM message_labels ORDER BY source`,
        ),
        [{ source: "gmail" }, { source: "user" }],
      );
      assert.deepEqual(
        Array.from(
          await client`
            SELECT ai_decision, model_id, definition_version, user_override
            FROM message_label_decisions
          `,
        ),
        [
          {
            ai_decision: "not_applied",
            model_id: "model-1",
            definition_version: 3,
            user_override: "applied",
          },
        ],
      );
      assert.deepEqual(
        Array.from(
          await client`
            SELECT kind, provider_draft_id, provider_message_id
            FROM drafts
            ORDER BY kind
          `,
        ),
        [
          {
            kind: "gmail",
            provider_draft_id: "provider-draft",
            provider_message_id: null,
          },
          { kind: "invook", provider_draft_id: null, provider_message_id: null },
        ],
      );
      assert.deepEqual(
        Array.from(
          await client`
            SELECT state, history_cursor, pending_history_cursor
            FROM gmail_replica_states
          `,
        ),
        [{ state: "ready", history_cursor: "120", pending_history_cursor: "150" }],
      );
      assert.deepEqual(
        Array.from(
          await client`
            SELECT step_type, input
            FROM workflow_steps
            WHERE step_type IN ('gmail.history.catchup', 'gmail.objects.delete')
            ORDER BY step_type
          `,
        ),
        [
          {
            step_type: "gmail.history.catchup",
            input: { reason: "notification" },
          },
          {
            step_type: "gmail.objects.delete",
            input: {
              manifest: {
                providerMessageId: "deleted-message",
                providerThreadId: "deleted-thread",
                providerHistoryId: "140",
                objectKeys: ["raw/deleted.eml"],
              },
            },
          },
        ],
      );
      for (const table of [
        "gmail_labels",
        "gmail_message_labels",
        "thread_labels",
        "thread_label_analyses",
        "gmail_drafts",
        "gmail_push_events",
        "gmail_message_tombstones",
      ]) {
        const relation = await client<{ relation: string | null }[]>`
          SELECT to_regclass(${table})::text AS relation
        `;
        assert.equal(relation[0]?.relation, null);
      }
    } finally {
      await client.unsafe("SET search_path TO public");
      await client.unsafe(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
      await client.end();
    }
  },
);
