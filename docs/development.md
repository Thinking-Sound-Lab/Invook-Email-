# Developing Invook

[Back to the README](../README.md)

This guide covers the services behind Invook, local configuration, and the development workflow. For contribution policy and verification requirements, read the [contributing guide](../.github/CONTRIBUTING.md).

## Requirements

- Node.js 22+ and the repository-pinned pnpm 11.10.0.
- Docker with Compose, such as Docker Desktop.
- Google Cloud OAuth credentials, the Gmail API, and an authenticated Pub/Sub push subscription.
- A Temporal Cloud namespace and API key. The Docker stack does not include a Temporal server.
- Model and Batch-provider configuration for the AI features you want to use.

From your clone of the repository:

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env.local
```

## Configuration

The root `.env.local` supplies configuration to Docker and local application processes. Never commit it. [`.env.example`](../.env.example) is the complete setting reference, including local defaults.

### Application secrets

Generate two independent values:

```bash
openssl rand -base64 32
openssl rand -base64 32
```

Use the first for `BETTER_AUTH_SECRET` and the second for `TOKEN_ENCRYPTION_KEY`. Keep `APP_URL=http://localhost:3000` for the default local setup.

### Google Identity and Gmail

Create a Google Cloud OAuth web application and register both local callback URLs:

```text
http://localhost:3000/v1/auth/callback/google
http://localhost:3000/connections/gmail/callback
```

Google Identity sign-in and Gmail access are separate flows. One OAuth client can serve both, because each flow requests its own scopes; separate clients are also supported.

| Flow | Required settings |
| --- | --- |
| Sign-in | `BETTER_AUTH_GOOGLE_CLIENT_ID`, `BETTER_AUTH_GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET` |
| Gmail OAuth | `GMAIL_GOOGLE_CLIENT_ID`, `GMAIL_GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` |
| Gmail notifications | `GMAIL_PUBSUB_TOPIC`, `GOOGLE_PUBSUB_PUSH_AUDIENCE`, `GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PUBSUB_SUBSCRIPTION` |

Enable the Gmail API. Configure a Pub/Sub topic that Gmail can publish to, and an authenticated push subscription targeting the public HTTPS route `/v1/webhooks/google-pubsub`. Local development needs a public HTTPS endpoint forwarding that route to Invook; a localhost URL alone cannot receive Google's pushes.

The configured audience must match the subscription's OIDC audience, the service-account email must match its push identity, and `GOOGLE_PUBSUB_SUBSCRIPTION` must be the full subscription resource name.

Gmail connection remains unavailable until the complete OAuth and watch configuration is present. Signing in requests identity scopes only; connecting each mailbox is an explicit, separate action.

### Temporal Cloud

Create a Temporal Cloud namespace and API key, then set:

- `TEMPORAL_ADDRESS`
- `TEMPORAL_NAMESPACE`
- `TEMPORAL_API_KEY`
- `TEMPORAL_TASK_QUEUE_PREFIX`

Use a distinct task-queue prefix for every environment. Prefixes accept lowercase letters, digits, and hyphens. The example file uses `invook-local`; development workers must not consume production work.

Every Invook user has deterministic `control`, `live`, and `bulk` task queues, shared by that user's Gmail accounts. History catch-up and Workflow Tasks use `control`, incremental AI work uses `live`, and snapshots and historical derivations use `bulk`. These queues isolate each user's Activity capacity and let new Gmail history proceed independently of bulk work.

`MAIL_BULK_CONCURRENCY` defaults to `3` and bounds concurrent bulk activities per user. Keep it above one to allow that user's Gmail accounts to synchronize in parallel.

`TEMPORAL_TENANT_SHARD_COUNT` and `TEMPORAL_TENANT_SHARD_INDEX` assign tenant queues to worker groups. They default to `1` and `0`. Replicas in the same group use the same pair; separate groups use distinct indexes in `[0, count)`. Queue names do not contain Gmail addresses or account IDs.

### AI providers

AI configuration is feature-specific. An OpenAI-compatible endpoint alone does not configure the native Batch features.

| Feature | Configuration |
| --- | --- |
| Recent-thread labels, custom-label previews and historical scans, feedback, drafting, and the mail agent | `AI_BASE_URL`, `AI_MODEL`, and optional `AI_API_KEY` |
| Historical thread-label Batch analysis | `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET`, and optional `OPENAI_LABEL_BATCH_MODEL` and `OPENAI_LABEL_BATCH_INPUT_TOKEN_LIMIT` overrides |
| Memory with OpenAI Batch | `MEMORY_BATCH_PROVIDER=openai`, `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET` |
| Memory with Azure OpenAI Batch | `MEMORY_BATCH_PROVIDER=azure-openai` and the `AZURE_OPENAI_*` settings in `.env.example` |

Native Batch completion uses signed provider webhooks. Register the configured provider's public HTTPS webhook route and matching signing secret:

| Provider | Webhook route | Signing secret |
| --- | --- | --- |
| OpenAI | `/v1/webhooks/openai` | `OPENAI_WEBHOOK_SECRET` |
| Azure OpenAI | `/v1/webhooks/azure-openai` | `AZURE_OPENAI_WEBHOOK_SECRET` |

When a Docker worker calls a model running on the host, use a host-reachable URL such as `http://host.docker.internal:11434/v1`. `AI_API_KEY` can be empty for an endpoint that does not require authentication.

Initial Memory analysis stays queued when its selected provider configuration is incomplete. Missing integrations must remain explicit; never add fabricated mailbox or Memory data to make the interface appear populated.

## Run locally

Once configuration is complete:

```bash
make dev
```

This builds the applications, applies database migrations, and starts the local stack. Open [localhost:3000](http://localhost:3000), sign in, and connect Gmail.

| Service | Default local address | Purpose |
| --- | --- | --- |
| Web | [localhost:3000](http://localhost:3000) | Invook UI |
| API | [localhost:4000](http://localhost:4000) | Fastify API |
| PostgreSQL | `localhost:54322` | Mailbox and product state, checkpoints, and Temporal command handoff |
| MinIO API | [localhost:9000](http://localhost:9000) | Attachment objects |
| MinIO console | [localhost:9001](http://localhost:9001) | Local object-storage administration |

`make down` stops the containers without deleting named volumes. PostgreSQL and MinIO retain their local data.

### Run application processes from source

Keep PostgreSQL and MinIO available, configure Temporal Cloud, and apply migrations:

```bash
pnpm db:migrate
pnpm dev
```

Run the worker in a second terminal:

```bash
pnpm worker
```

`pnpm dev` starts the web and API only. Stop their Docker counterparts first if they occupy the same ports. When running a model and the worker directly on the host, use the model's host-local endpoint instead of the Docker-specific hostname.

### Common commands

| Command | Purpose |
| --- | --- |
| `make dev` | Build and run the Docker stack |
| `make down` | Stop containers without deleting local data |
| `pnpm dev` | Run the web and API processes from source |
| `pnpm worker` | Run the worker from source |
| `pnpm db:generate` | Generate a Drizzle migration after a schema change |
| `pnpm db:migrate` | Apply pending database migrations |
| `make verify` | Run typechecking, linting, tests, and the production web build |
| `make verify-database` | Run integration tests against a migrated disposable database selected by `TEST_DATABASE_URL` |

For a clean onboarding run, read [Reset local signup and mailbox data](./local-development-reset.md). `make reset-local` is destructive to local application data, although it preserves schemas, buckets, and Docker volumes.

## Architecture

The Next.js application serves the UI and same-origin API/SSE proxies. Fastify owns authentication, authorization, OAuth, webhooks, and product routes. Workers own durable synchronization and AI work.

| System | Owns |
| --- | --- |
| Gmail | Provider messages, recognized system-label memberships, and Gmail Draft resources |
| PostgreSQL | Normalized mailbox replica, Invook labels, Memory, local drafts, checkpoints, and transactional Temporal commands |
| Temporal Cloud | Workflow history, schedules, task delivery, and retries |
| S3-compatible storage | Attachment bytes; MinIO provides this locally |

Provider-owned actions write Gmail first, then converge through Gmail history. Workers normalize Gmail full-format thread data into PostgreSQL and save attachment bytes to object storage. Committed mail can be browsed while synchronization continues; labels and Memory arrive through their own durable work.

PostgreSQL commits product-state changes and any required Temporal command together. Dispatchers hand those commands to Temporal; workers re-read durable state when executing Activities.

## Repository map

| Path | Responsibility |
| --- | --- |
| [`apps/web`](../apps/web) | Next.js App Router UI and same-origin API/SSE proxies |
| [`apps/api`](../apps/api) | Fastify authentication, authorization, Gmail OAuth, webhooks, and product routes |
| [`apps/worker`](../apps/worker) | Durable Gmail sync, labeling, Memory, and feedback work |
| [`packages/auth`](../packages/auth) | Better Auth Google Identity and database-backed sessions |
| [`packages/ai`](../packages/ai) | Model, Memory, label, draft, and mail-agent logic |
| [`packages/contracts`](../packages/contracts) | Shared browser/server product and wire contracts |
| [`packages/database`](../packages/database) | Drizzle schema, migrations, repositories, and Temporal command admission |
| [`packages/gmail`](../packages/gmail) | OAuth, Gmail API, history mapping, full-message normalization, and draft MIME parsing |
| [`packages/object-storage`](../packages/object-storage) | S3-compatible attachment storage |
| [`packages/workflows`](../packages/workflows) | Deterministic Temporal Workflows and shared execution contracts |
| [`docker`](../docker) | Local services and application images |
| [`docs`](.) | Product and implementation contracts |

Applications import public `@invook/*` package exports. Packages never import from `apps/*`, and the web app never imports server-only database, Gmail, credential, object-storage, or worker code. Read the [engineering guidelines](../AGENTS.md) and the closest directory-specific `AGENTS.md` before editing.

## Tech stack

- **Language:** TypeScript
- **Web:** Next.js 16, React 19, Tailwind CSS, shadcn/ui, Zustand
- **API and identity:** Fastify 5 and Better Auth
- **Database:** PostgreSQL 17 with Drizzle ORM
- **Durable work:** Temporal Cloud with a PostgreSQL transactional command handoff
- **Storage:** S3-compatible object storage; MinIO locally
- **Mail:** Gmail API, Google OAuth, and Gmail Pub/Sub notifications
- **AI:** Vercel AI SDK, OpenAI-compatible models, OpenAI Batch, and Azure OpenAI Batch
- **Workspace:** pnpm workspaces
