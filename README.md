<h1 align="center">Invook</h1>

<p align="center">
  <strong>Your inbox. Your priorities. Your voice.</strong><br />
  An open-source, AI-native alternative for Gmail.
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-2563eb?style=flat-square" alt="License: Apache 2.0" /></a>
  <a href="./.github/SECURITY.md#supported-versions"><img src="https://img.shields.io/badge/status-early_development-64748b?style=flat-square" alt="Status: early development" /></a>
  <a href="./docs/development.md"><img src="https://img.shields.io/badge/built_with-TypeScript-3178c6?style=flat-square" alt="Built with TypeScript" /></a>
</p>

<p align="center">
  <a href="#features">Features</a> &nbsp; / &nbsp;
  <a href="#get-started">Get started</a> &nbsp; / &nbsp;
  <a href="./docs/development.md">Development</a> &nbsp; / &nbsp;
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

Follow the [configuration guide](./docs/development.md#configuration) to fill in `.env.local` before starting:

| Service | What it's for |
| --- | --- |
| Google OAuth + Gmail Pub/Sub | Sign-in, mailbox access, and ongoing synchronization |
| Temporal Cloud | Durable sync and background work; no local Temporal server is bundled |
| AI providers | An OpenAI-compatible endpoint for interactive features, plus native Batch configuration for historical labels and Memory |

The guide covers OAuth callbacks, a public HTTPS webhook endpoint, independently generated secrets, and the settings required by each AI feature. Local database and object-storage defaults are already in [`.env.example`](./.env.example).

### 3. Start Invook

```bash
make dev
```

Open [localhost:3000](http://localhost:3000), sign in with Google, then connect a Gmail account. Signing in does not grant mailbox access; connecting Gmail is a separate step.

`make down` stops the containers and preserves local data.

## Your mail and your data

Gmail owns your messages, read state, stars, and drafts. Invook writes provider actions to Gmail first, then brings its stored replica up to date through Gmail history. Invook owns your AI labels, editable Memory, and local reply drafts.

Mailbox data lives in your configured PostgreSQL database; attachment bytes live in S3-compatible storage. AI features send the mail context they need to the providers you configure. Self-hosting does not mean every operation stays on your machine.

Sender-hosted images currently load directly from their original URLs. Opening an email can reveal your browser's IP address and the request time to the image host.

## Built for contributors

**TypeScript throughout.** Next.js and React on the web, Fastify at the API, PostgreSQL with Drizzle for persistence, and Temporal Cloud for durable work.

| Start here | You'll find |
| --- | --- |
| [Development guide](./docs/development.md) | Configuration, local services, commands, architecture, and repository map |
| [Contributing guide](./.github/CONTRIBUTING.md) | How to propose changes, verify your work, and open a pull request |
| [Engineering guidelines](./AGENTS.md) | Code conventions and ownership boundaries |

Bug fixes, documentation, tests, and design improvements are welcome. For larger changes, [open an issue](https://github.com/Thinking-Sound-Lab/Invook-Email-/issues) first so the scope is agreed before you build.

Please follow the [Code of Conduct](./.github/CODE_OF_CONDUCT.md). Report vulnerabilities privately through the [Security Policy](./.github/SECURITY.md).

## License

[Apache License 2.0](./LICENSE). See [NOTICE](./NOTICE) for attribution.
