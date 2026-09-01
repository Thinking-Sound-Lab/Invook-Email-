<h1 align="center">Invook</h1>

<p align="center">
  <strong>Your inbox. Your priorities. Your voice.</strong><br />
  An open-source, AI-native alternative for Gmail.
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-2563eb?style=flat-square" alt="License: Apache 2.0" /></a>
  <a href="./.github/SECURITY.md#supported-versions"><img src="https://img.shields.io/badge/status-early_development-64748b?style=flat-square" alt="Status: early development" /></a>
  <a href="./package.json"><img src="https://img.shields.io/badge/built_with-TypeScript-3178c6?style=flat-square" alt="Built with TypeScript" /></a>
</p>

<p align="center">
  <a href="#features">Features</a> &nbsp; / &nbsp;
  <a href="#get-started">Get started</a> &nbsp; / &nbsp;
  <a href="#built-for-contributors">Development</a> &nbsp; / &nbsp;
  <a href="./.github/CONTRIBUTING.md">Contribute</a>
</p>

Invook brings your Gmail accounts into one workspace, organizes your inbox with labels you control, and helps you write with Memory you can inspect and edit. Run it on your own infrastructure and connect the AI providers you choose.

> [!NOTE]
> Invook is in early development, with no stable release yet. The current setup uses Google OAuth, Gmail Pub/Sub, and Temporal Cloud; Docker provides the local applications, PostgreSQL, and MinIO.

## Features

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Every account, one workspace</h3>
      Connect multiple Gmail accounts. Browse and search them together, or focus on a single inbox.
    </td>
    <td width="50%" valign="top">
      <h3>Labels on your terms</h3>
      Start with Important, Newsletter, Billing, and Others. Describe your own labels, preview matches, and keep the final say over assignments.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>Memory you can edit</h3>
      Inspect the writing preferences, contact rules, and scheduling habits learned from your sent mail. Add, correct, or delete them at any time.
    </td>
    <td valign="top">
      <h3>Replies in your voice</h3>
      Draft with the current conversation and relevant Memory. Edit the result, save a Gmail draft, and send when you choose.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>Find the conversation</h3>
      Search message text, metadata, and attachment filenames. Ask the mail agent to find a thread, read it, or prepare a reply.
    </td>
    <td valign="top">
      <h3>Stay connected to Gmail</h3>
      Read, star, archive, and manage drafts with Gmail as the source of truth. Browse stored mail while the rest of your mailbox synchronizes.
    </td>
  </tr>
</table>

**You stay in control.** Invook's AI labels are separate from Gmail labels. The mail agent can read stored mail and prepare local drafts, but it has no tools to send email or change Gmail.

## Get started

You'll need **Node.js 22+**, **pnpm 11.10.0** (pinned in the repository), and **Docker with Compose**.

### 1. Clone and install

```bash
git clone https://github.com/Thinking-Sound-Lab/Invook-Email-.git
cd Invook-Email-
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env.local
```

### 2. Connect your services

Use the settings documented in [`.env.example`](./.env.example) to fill in `.env.local` before starting:

| Service | What it's for |
| --- | --- |
| Google OAuth + Gmail Pub/Sub | Sign-in, mailbox access, and ongoing synchronization |
| Temporal Cloud | Durable sync and background work; no local Temporal server is bundled |
| AI providers | An OpenAI-compatible endpoint for interactive features, plus native Batch configuration for historical labels and Memory |

Generate `BETTER_AUTH_SECRET` and `TOKEN_ENCRYPTION_KEY` independently with `openssl rand -base64 32`. Gmail Pub/Sub and Batch webhooks require public HTTPS endpoints. Local database and object-storage defaults are already in `.env.example`.

### 3. Start Invook

```bash
make dev
```

Open [localhost:3000](http://localhost:3000), sign in with Google, then connect a Gmail account. Signing in does not grant mailbox access; connecting Gmail is a separate step.

`make down` stops the containers and preserves local data.

## Your mail and your data

Gmail owns your messages, read state, stars, and drafts. Invook writes provider actions to Gmail first, then brings its stored replica up to date through Gmail history. Invook owns your AI labels, editable Memory, and local reply drafts.

The same Gmail mailbox can be connected by multiple Invook users. Each user must independently complete Gmail authorization; credentials, replicas, attachments, Invook labels, Memory, and preferences remain isolated by their internal connection IDs. Provider actions still change the real shared mailbox and converge through each connection's own history cursor. Verified push notifications fan out to every active connection; a busy replica requests redelivery without undoing other admissions.

Disconnect removes only that user's connection and local data. Watch operations are serialized by Gmail identity, and cleanup stops the provider watch only when no other connected or reconnect-required connection needs it. Reconnecting a connection still being removed requires waiting for cleanup to finish. Invook does not revoke the shared Google application grant on disconnect.

Automatic labeling considers Inbox threads with an Inbox message from the last 14 days and uses individual model calls, including during initial sync. Older mail still syncs, but does not start automatic labeling. OpenAI Batch is used for labels only when you explicitly choose to apply a label to past mail in Settings (7, 30, or 90 days); that request considers only the selected label and preserves nonmatches. Gmail categories, custom labels, and Gmail Important are not imported as Invook labels. Operational Gmail state such as read, star, Inbox, and draft status remains synchronized.

Mailbox data lives in your configured PostgreSQL database; attachment bytes live in S3-compatible storage. AI features send the mail context they need to the providers you configure. Self-hosting does not mean every operation stays on your machine.

Sender-hosted images currently load directly from their original URLs. Opening an email can reveal your browser's IP address and the request time to the image host.

## Built for contributors

When upgrading across the label-policy migration, stop API and worker processes before migrating, then restart them together with the updated web build. The migration retires automatic label jobs, preserves completed assignments and pending explicit settings requests, and removes imported Gmail label metadata. The worker resumes eligible recent labeling and saved settings requests after startup.

Shared-mailbox support adds migration `0038_shared_gmail_connections` after label-policy migrations 0036/0037. Apply them in order with API and workers stopped, then deploy the updated API, worker, and web together. Do not run the older single-recipient push or unconditional watch-stop implementation after enabling multi-user connections. Migration 0038 preserves existing IDs and data while changing provider-identity uniqueness to `(user_id, provider, provider_account_id)`.

**TypeScript throughout.** Next.js and React on the web, Fastify at the API, PostgreSQL with Drizzle for persistence, and Temporal Cloud for durable work.

| Start here | You'll find |
| --- | --- |
| [Contributing guide](./.github/CONTRIBUTING.md) | How to propose changes, verify your work, and open a pull request |
| [Engineering guidelines](./AGENTS.md) | Code conventions and ownership boundaries |

Bug fixes, documentation, tests, and design improvements are welcome. For larger changes, [open an issue](https://github.com/Thinking-Sound-Lab/Invook-Email-/issues) first so the scope is agreed before you build.

Please follow the [Code of Conduct](./.github/CODE_OF_CONDUCT.md). Report vulnerabilities privately through the [Security Policy](./.github/SECURITY.md).

## License

[Apache License 2.0](./LICENSE). See [NOTICE](./NOTICE) for attribution.
