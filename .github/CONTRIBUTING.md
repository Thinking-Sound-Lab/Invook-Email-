# Contributing to Invook

Thank you for helping improve Invook. Contributions can include bug fixes,
documentation, tests, design improvements, and focused product changes.
Participation in the project is governed by our
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Before You Start

- Search [existing issues](https://github.com/Thinking-Sound-Lab/Invook-Email-/issues)
  before opening a new one.
- Open an issue before investing in a large feature or architecture change so
  its scope and ownership can be agreed first.
- Follow the [Security Policy](./SECURITY.md) instead of opening a public issue
  for a suspected vulnerability.
- Never include credentials, tokens, real mailbox content, raw MIME, attachment
  bytes, or private provider payloads in an issue, pull request, test, or log.

## Development Setup

Invook is a pnpm workspace that requires Node.js 22+, pnpm 11+, and Docker
Desktop. Fork the repository, clone your fork, and create a focused branch:

```bash
git clone https://github.com/<your-username>/Invook-Email-.git
cd Invook-Email-
git checkout -b fix/short-description
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env.local
openssl rand -base64 32
openssl rand -base64 32
```

Put the two different generated values in `BETTER_AUTH_SECRET` and
`TOKEN_ENCRYPTION_KEY`, respectively. Fill every other blank value required by
the services you intend to run; authentication requires the Better Auth Google
client values, while a complete Gmail connection also requires the Gmail OAuth
and Pub/Sub values documented in the development guide. Never commit
`.env.local` or real credentials. Start the complete local stack with:

```bash
make dev
```

See the [development guide](../docs/development.md#configuration) for Google
OAuth, Gmail, Pub/Sub, Temporal Cloud, model, and object-storage configuration.
If an external integration is not configured, preserve an honest unavailable
state rather than adding fake data.

## Repository Boundaries

- `apps/web` owns the Next.js user interface and same-origin proxies.
- `apps/api` owns Fastify HTTP admission, authentication, authorization,
  validation, webhooks, SSE, and response serialization.
- `apps/worker` owns retryable and long-running durable work.
- `packages/*` owns reusable domain and infrastructure code.
- PostgreSQL owns product state and the transactional Temporal command handoff;
  Temporal owns durable execution, retries, schedules, and task delivery.

Read the root `AGENTS.md` and the closest directory-specific `AGENTS.md` before
editing. Keep application-to-package dependencies one-way, use public
`@invook/*` package exports across workspaces, and do not import server-only
packages into `apps/web`.

## Making a Change

1. Keep the change small and focused on one problem.
2. Add or update tests for changed behavior and failure modes.
3. Update every producer and consumer when changing a shared contract.
4. Generate and inspect a migration for schema changes.
5. Update documentation and configuration when behavior or setup changes.
6. Remove the superseded path and search for obsolete symbols before handoff.

Use pnpm for all repository commands. Application HTTP uses Fastify and Axios;
UUID generation uses the `uuid` package. Follow the existing TypeScript,
naming, privacy, durability, and retry-safety rules in `AGENTS.md`.

## Verification

Run the narrowest relevant checks while iterating. Before opening a pull
request, run the full repository gate and validate Docker Compose:

```bash
make verify
TEST_DATABASE_URL=postgresql://invook:invook@127.0.0.1:54322/invook_test make verify-database
docker compose -f docker/compose.yml config --quiet
```

`verify-database` runs the real-PostgreSQL integration suite and fails closed
when `TEST_DATABASE_URL` is absent. Point it at a migrated disposable test
database, never at a mailbox database containing product data.

If an external service prevents a check, state exactly what ran, what failed,
and what remains unverified. Do not weaken assertions or claim checks that were
not performed.

## Pull Requests

A pull request should:

- explain the problem, the invariant being changed, and the chosen solution;
- link related issues with `Fixes #123` or `Refs #123` when applicable;
- identify security, privacy, migration, concurrency, or compatibility risks;
- include screenshots for visible UI changes;
- list the exact verification commands and results; and
- remain free of unrelated formatting or refactoring changes.

Use clear, imperative commit subjects. Maintainers may ask for changes to keep
contracts, data ownership, and repository boundaries consistent.

## License

Invook is licensed under the [Apache License 2.0](../LICENSE). Unless you
explicitly state otherwise, contributions intentionally submitted for inclusion
in Invook are provided under the same license, as described in Section 5 of the
license.
