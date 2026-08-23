# Reset local signup and mailbox data

Use the local reset when the Docker development stack must return to a clean, new-signup state:

```bash
make reset-local
```

The command is intentionally destructive only inside the known `invook` local Docker Compose stack. It requires the default localhost PostgreSQL, MinIO endpoint and `invook-mail` bucket; the expected service set, ports, internal endpoints and named-volume mounts; and an explicit confirmation token supplied by the Make target. It refuses to run when any of those guards differ.

Before mutation, the command stops `web`, `api` and `worker` and verifies that they are no longer running. It then:

- truncates every Invook product table in PostgreSQL's `public` schema;
- removes every object from the unversioned `invook-mail` MinIO bucket.

It does not delete Temporal Cloud Workflow histories, drop PostgreSQL schemas or the `drizzle.__drizzle_migrations` table, delete the MinIO bucket, remove Docker named volumes, or change `.env.local`, credentials, configuration, migrations or source files. An old Temporal Workflow that is later delivered after reset cannot execute product work because its PostgreSQL operation checkpoint no longer exists.

After clearing the stores, the command verifies the zero-data state while API, web, and worker services are still stopped, so an authenticated inbound webhook cannot race the destructive operation's result. It fails unless all product tables and mailbox objects are empty and the Drizzle migration row count is unchanged. It then rebuilds and restarts the normal stack. Its final output includes zero counts for profiles, connected accounts, messages, drafts, memories, operation checkpoints, and Temporal commands.

Open [http://localhost:3000](http://localhost:3000) after completion. A clean state presents the Better Auth `Sign in with Google` identity action. Signing in creates no mailbox data until the user separately authorizes `Connect Gmail`.
