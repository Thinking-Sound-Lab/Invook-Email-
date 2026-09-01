import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const migrationsUrl = new URL("../drizzle/", import.meta.url);

test(
  "0038 upgrades PR #45 without changing connection IDs, credentials, cursors, or label policy",
  { skip: !testDatabaseUrl },
  async () => {
    assert.ok(testDatabaseUrl);
    const client = postgres(testDatabaseUrl, {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    const testSchema = `shared_gmail_${uuidv4().replaceAll("-", "")}`;
    const userA = uuidv4();
    const userB = uuidv4();
    const accountId = uuidv4();
    const providerAccountId = uuidv4();
    const labelId = uuidv4();
    async function apply(filename: string) {
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
      const migrations = (await readdir(migrationsUrl))
        .filter((name) => /^\d{4}_.+\.sql$/.test(name))
        .sort();
      for (const migration of migrations.filter((name) => name < "0038_"))
        await apply(migration);
      await client`INSERT INTO profiles (id, email, display_name) VALUES (${userA}, ${`${userA}@example.test`}, 'A'), (${userB}, ${`${userB}@example.test`}, 'B')`;
      await client`INSERT INTO connected_accounts (id, user_id, provider_account_id, email, memory_acknowledged_at) VALUES (${accountId}, ${userA}, ${providerAccountId}, 'shared@example.test', now())`;
      await client`INSERT INTO account_secrets (account_id, token_ciphertext, key_version) VALUES (${accountId}, 'test-encrypted-grant', 1)`;
      await client`INSERT INTO gmail_replica_states (account_id, initial_history_id, history_cursor, pending_history_cursor, state) VALUES (${accountId}, '100', '200', '300', 'ready')`;
      await client`INSERT INTO labels (id, user_id, account_id, kind, name, normalized_name, description) VALUES (${labelId}, ${userA}, ${accountId}, 'invook', 'Private', 'private', 'Preserved definition')`;
      const before =
        await client`SELECT a.*, s.token_ciphertext, r.history_cursor, r.pending_history_cursor FROM connected_accounts a JOIN account_secrets s ON s.account_id=a.id JOIN gmail_replica_states r ON r.account_id=a.id`;
      await apply("0038_shared_gmail_connections.sql");
      assert.deepEqual(
        await client`SELECT a.*, s.token_ciphertext, r.history_cursor, r.pending_history_cursor FROM connected_accounts a JOIN account_secrets s ON s.account_id=a.id JOIN gmail_replica_states r ON r.account_id=a.id`,
        before,
      );
      assert.equal(
        (await client`SELECT description FROM labels WHERE id=${labelId}`)[0]
          ?.description,
        "Preserved definition",
      );
      await client`INSERT INTO connected_accounts (user_id, provider_account_id, email, memory_acknowledged_at) VALUES (${userB}, ${providerAccountId}, 'shared@example.test', now())`;
      await assert.rejects(
        client`INSERT INTO connected_accounts (user_id, provider_account_id, email, memory_acknowledged_at) VALUES (${userA}, ${providerAccountId}, 'shared@example.test', now())`,
        (error: unknown) =>
          error instanceof postgres.PostgresError && error.code === "23505",
      );
      assert.equal(
        (await client`SELECT count(*)::int AS count FROM connected_accounts`)[0]
          ?.count,
        2,
      );
      assert.ok(
        (
          await client`SELECT to_regclass('historical_thread_label_scans') AS name`
        )[0]?.name,
      );
    } finally {
      await client.unsafe("SET search_path TO public");
      await client.unsafe(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
      await client.end();
    }
  },
);
