# Invook

Invook is an open-source, AI-native Gmail client. It keeps a local, lossless Gmail replica, organizes mail with user-controlled AI labels, and drafts replies using Memory that the user can inspect and edit.

Google Identity sign-in and Gmail access are separate. Signing in creates an Invook session with Better Auth; a signed-in user then explicitly connects each Gmail mailbox. Gmail remains the source of truth.

## Quickstart

**Requirements:** [Node.js 22+](https://nodejs.org/), pnpm 11+, and [Docker Desktop](https://www.docker.com/products/docker-desktop/).

```bash
git clone https://github.com/Thinking-Sound-Lab/Invook-Email-.git
cd Invook-Email-
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env.local
openssl rand -base64 32
openssl rand -base64 32
```

Use the two generated values for `BETTER_AUTH_SECRET` and `TOKEN_ENCRYPTION_KEY`. Add your Google OAuth credentials to `.env.local`, then start the complete stack:

```bash
make dev
```

Open [http://localhost:3000](http://localhost:3000). Stop the stack with `make down`.

See [Configuration](#configuration) before signing in or connecting Gmail.

## Capabilities

- Mirror the complete Gmail mailbox, including Spam, Trash, drafts, parsed message content, and attachments.
- Search mail with text, metadata, and attachment filenames.
- Assign exactly one Invook-owned Important, Newsletter, Billing, Others, or custom label to each Inbox thread without changing Gmail labels.
- Learn editable Memory for writing preferences, contacts, and scheduling behavior.
- Draft replies with only the current thread and relevant Memory as context.
- Save, edit, and send Gmail drafts through an explicit user-confirmed flow.
- Use a read-only mail agent to find messages, inspect threads, and prepare local reply drafts.

## How it works

1. Better Auth handles global Google Identity sign-in and database-backed browser sessions. It requests identity scopes only, never Gmail access.
2. A signed-in user separately connects a Gmail mailbox. The Fastify API validates the mailbox, encrypts its credentials, registers a Gmail watch, and creates durable synchronization work.
3. Workers normalize Gmail full-format thread data into PostgreSQL and store attachment bytes in S3-compatible object storage.
4. PostgreSQL owns product state and transactionally records Temporal commands. Temporal Cloud durably schedules, executes, and retries worker Activities.
5. The mail reader sanitizes stored HTML and renders it inside an isolated Shadow DOM. Sender-hosted images load directly from their original URLs, so opening mail can disclose the request time and browser IP address to the image host.
6. AI jobs classify labels, learn Memory, and create drafts. The Next.js app reads the resulting local replica through the API.

Provider-owned changes are written to Gmail first and then converge locally through Gmail history.

```text
Browser -> Next.js -> Fastify API -> Better Auth / PostgreSQL
                         |                    |
                         v                    v
                       Gmail        temporal_commands
                                              |
                                              v
                                    Temporal Cloud -> Worker
                                              |        |
                                              v        v
                                        S3 storage   AI providers
```

For the detailed synchronization and ownership rules, read the [Gmail mailbox replica contract](./docs/gmail-replica-contract.md).

## Repository map

| Path | Responsibility |
| --- | --- |
| `apps/web` | Next.js App Router UI and same-origin API/SSE proxies |
| `apps/api` | Fastify authentication, authorization, Gmail OAuth, webhooks, and product routes |
| `apps/worker` | Durable Gmail sync, labeling, Memory, and feedback jobs |
| `packages/auth` | Better Auth Google Identity and database-backed sessions |
| `packages/ai` | Model, Memory, label, draft, and mail-agent logic |
| `packages/contracts` | Shared browser/server product and wire contracts |
| `packages/database` | Drizzle schema, migrations, repositories, and workflows |
| `packages/gmail` | Gmail OAuth, Gmail API, history mapping, full-message normalization, and draft MIME parsing |
| `packages/object-storage` | S3-compatible attachment storage |
| `packages/workflows` | Deterministic Temporal Workflows and shared execution contracts |
| `docker` | Local services and application images |
| `docs` | Product and implementation contracts |

Applications may import public `@invook/*` package exports. Packages never import from `apps/*`, and the web app never imports server-only database, Gmail, credential, object-storage, or worker code.

## Configuration

The root `.env.local` is used by both Docker and local application processes. Never commit it.

### Google Identity and Gmail

Create a Google Cloud OAuth web application. One OAuth client can serve both flows because each request uses its own scopes. Register both local callback URLs:

```text
http://localhost:3000/v1/auth/callback/google
http://localhost:3000/connections/gmail/callback
```

Configure the identity flow:

- `BETTER_AUTH_GOOGLE_CLIENT_ID`
- `BETTER_AUTH_GOOGLE_CLIENT_SECRET`
- `BETTER_AUTH_SECRET`

Enable the Gmail API, then configure the mailbox connection flow:

- `GMAIL_GOOGLE_CLIENT_ID`
- `GMAIL_GOOGLE_CLIENT_SECRET`
- `TOKEN_ENCRYPTION_KEY`
- `GMAIL_PUBSUB_TOPIC`
- `GOOGLE_PUBSUB_PUSH_AUDIENCE`
- `GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PUBSUB_SUBSCRIPTION`

You can reuse the same OAuth client ID and secret for both flows or use separate clients. The Pub/Sub push subscription must target the public HTTPS route `/v1/webhooks/google-pubsub`. Gmail connection remains unavailable until its complete OAuth and watch configuration is present.

### AI

AI configuration is feature-specific:

- `AI_BASE_URL`, `AI_MODEL`, and optional `AI_API_KEY` power fast new/recent-thread labels, label previews/historical custom-label scans, feedback analysis, and drafting through an OpenAI-compatible endpoint.
- `OPENAI_API_KEY`, optional `OPENAI_LABEL_BATCH_MODEL`, `OPENAI_LABEL_BATCH_INPUT_TOKEN_LIMIT`, and `OPENAI_WEBHOOK_SECRET` power serialized historical thread-label Batch analysis.
- `MEMORY_BATCH_PROVIDER=openai` uses OpenAI Batch for Memory.
- `MEMORY_BATCH_PROVIDER=azure-openai` uses the `AZURE_OPENAI_*` Batch settings.

When the Docker worker calls a model running on the host, use a host-reachable URL such as `http://host.docker.internal:11434/v1`. See [`.env.example`](./.env.example) for every setting and its local default.

### Temporal Cloud

Create a Temporal Cloud namespace and API key, then configure `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY`, and `TEMPORAL_TASK_QUEUE_PREFIX`. Use a different lowercase task-queue prefix for every environment. Invook does not start a local Temporal server.

Temporal execution is isolated by Invook user. Every user receives deterministic `control`, `live`, and `bulk` task queues; all Gmail accounts owned by that user share those queues. Gmail history catch-up and Workflow Tasks use `control`, label and other incremental AI work uses `live`, and snapshots and historical derivations use `bulk`. This prevents one user's historical mailbox synchronization from consuming another user's Activity capacity, lets new Gmail history bypass the same user's bulk backlog, and runs label analysis in parallel with Gmail synchronization. `MAIL_BULK_CONCURRENCY` (default `3`) bounds a user's concurrent bulk activities; keep it above one so a user's Gmail accounts synchronize in parallel.

`TEMPORAL_TENANT_SHARD_COUNT` and `TEMPORAL_TENANT_SHARD_INDEX` assign tenant queues to worker groups. They default to `1` and `0`. Every highly available replica in one group must use the same pair; different groups use distinct indexes in `[0, count)`. Queue names do not contain Gmail addresses or account IDs.

## Local services

`make dev` builds the applications, applies database migrations, and starts:

| Service | Local address | Purpose |
| --- | --- | --- |
| Web | [localhost:3000](http://localhost:3000) | Invook UI |
| API | [localhost:4000](http://localhost:4000) | Fastify API |
| PostgreSQL | `localhost:54322` | Mailbox, product, and workflow state |
| MinIO API | [localhost:9000](http://localhost:9000) | Attachment objects |
| MinIO console | [localhost:9001](http://localhost:9001) | Local object-storage administration |

Named Docker volumes preserve local data across `make down`.

## Common commands

| Command | Purpose |
| --- | --- |
| `make dev` | Build and run the complete Docker stack |
| `make down` | Stop containers without deleting local data |
| `pnpm dev` | Run the web and API processes from source |
| `pnpm worker` | Run the worker from source |
| `pnpm db:generate` | Generate a Drizzle migration after a schema change |
| `pnpm db:migrate` | Apply pending database migrations |
| `make verify` | Run typechecking, linting, tests, and the production web build |
| `make reset-local` | Clear local Invook data while keeping schemas, buckets, and Docker volumes |

For a source-based development loop, keep PostgreSQL and MinIO available, configure Temporal Cloud, apply migrations, run `pnpm dev`, and run `pnpm worker` in a second terminal.

`make reset-local` is intentionally guarded and destructive to local application data. Read [Reset local signup and mailbox data](./docs/local-development-reset.md) before using it.

## Tech stack

<details>
<summary>Next.js · React · Fastify · Better Auth · PostgreSQL · Temporal · MinIO</summary>

- **Language:** TypeScript
- **Web:** Next.js 16, React 19, Tailwind CSS, shadcn/ui, Zustand
- **API:** Fastify 5 and Better Auth
- **Database:** PostgreSQL 17 with Drizzle ORM
- **Jobs:** Temporal Cloud Workflows and Activities with a PostgreSQL transactional command handoff
- **Storage:** S3-compatible object storage; MinIO locally
- **Mail:** Gmail API, Google OAuth, and Gmail Pub/Sub notifications
- **AI:** Vercel AI SDK, OpenAI-compatible models, OpenAI Batch, or Azure OpenAI Batch
- **Workspace:** pnpm workspaces

</details>

## Project documents

- [Product requirements](./docs/product-requirements.md)
- [Gmail mailbox replica contract](./docs/gmail-replica-contract.md)
- [Local data reset](./docs/local-development-reset.md)
- [Engineering guidelines](./AGENTS.md)

## License

## Community and License

- [Contributing guide](./.github/CONTRIBUTING.md)
- [Code of Conduct](./.github/CODE_OF_CONDUCT.md)
- [Security Policy](./.github/SECURITY.md)

Invook is licensed under the [Apache License 2.0](./LICENSE). See
[NOTICE](./NOTICE) for attribution information.
