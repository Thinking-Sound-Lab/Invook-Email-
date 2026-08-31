# Invook engineering guidelines

Invook is an open-source, AI-native Superhuman mail alternative.

These instructions apply repository-wide. Before editing a file, read the closest applicable `AGENTS.md`; directory-specific instructions override this root guide for files in their scope.

## Core principles

These principles apply to every change:

1. **Evidence over assumption.** Implement only behavior proved by the request, repository, connected services, or real stored data. Preserve an honest empty or unavailable state when information is missing.
2. **Correctness over convenience.** Protect data integrity, provider fidelity, authorization, idempotency, and concurrency even when the safer implementation spans several layers.
3. **One source of truth.** Identify which system owns each state. Do not create competing local representations, optimistic provider state, or duplicated business rules.
4. **Clear ownership.** Keep UI, HTTP admission, durable work, domain logic, persistence, and provider integration in their established layers. A module should have one coherent reason to change.
5. **Composition over complexity.** Build behavior from small, focused modules with explicit contracts instead of large components, hidden coupling, or speculative abstractions.
6. **Types are contracts.** Model valid states precisely, validate untrusted boundaries, and make impossible states difficult to represent. Do not use casts to hide an unclear contract.
7. **Durability over process memory.** Temporal owns durable workflow execution, retries, schedules, and task delivery. PostgreSQL owns product state and the transactional command handoff required when a database commit must atomically admit Temporal work.
8. **Retry-safe by design.** External delivery and worker execution are at least once. Use stable idempotency keys, transactions, database constraints, and cross-process locks where required.
9. **Privacy and security by default.** Minimize access to mailbox data and credentials, authorize before reading, and never expose sensitive content through logs or errors.
10. **Complete changes only.** Update every producer and consumer of a changed contract, remove the superseded path, and verify the result end to end at the level the environment permits.


## Global standards

- Preserve existing user changes and unrelated work. Inspect `git status` before editing and never reset or revert a dirty worktree to simplify a task.
- Never introduce dummy, placeholder, seeded, synthetic, mock, or fixture data into product flows or persistent product stores. Test-only protocol inputs stay inside tests.
- Remove dead files, functions, routes, exports, dependencies, configuration, environment variables, and documentation made obsolete by a change. Do not keep speculative compatibility shims.
- Finish replacements with repository-wide `rg` searches for the obsolete symbols, routes, configuration, and forbidden APIs.
- Never use `setTimeout`, ad hoc request deadline options named `timeout`, or timer-based polling in project code or configuration. Prefer Temporal retries and schedules, PostgreSQL notifications, SSE, provider webhooks, or platform-native health behavior. Temporal Activity execution bounds such as `startToCloseTimeout` and `scheduleToCloseTimeout` are required durability controls and are allowed.
- Use Fastify for the API server and Axios for outbound application HTTP. Do not use native `fetch`, `node:http` clients, or `node:https` clients for application requests.
- Use the `uuid` package for UUID generation and utilities. Do not use UUID APIs from `node:crypto`, including `randomUUID`.
- Use `pnpm` and `pnpm dlx`, not npm, yarn, or bun. Use Node.js 22+ and the versions pinned by the repository manifests and lockfile.
- Never commit `.env.local`, credentials, tokens, real mailbox content, raw provider payloads containing secrets, or local tunnel URLs. Keep `.env.example`, runtime validation, setup docs, and container configuration synchronized.
- Treat email content, attachments, filenames, webhook payloads, model output, and provider error text as untrusted input. Log structured identifiers and statuses, never provider credentials, raw MIME, attachment bytes, or full email content.
- Do not claim verification that was not performed. State exactly which checks passed and which external integration behavior remains unverified.
- Frontend work uses shadcn/ui conventions, Plus Jakarta Sans, and free Hugeicons. Do not add icon fonts, emoji, text glyphs, hand-drawn SVG icons, or decorative borders by default.


## Repository structure and boundaries

```text
apps/
  api/                 Fastify HTTP API, sessions, OAuth, webhooks, SSE, and product routes
  web/                 Next.js App Router UI and same-origin API/SSE proxies
  worker/              Durable Gmail, indexing, labeling, Memory, and feedback work
packages/
  ai/                  Model, embedding, Memory, label, draft, and mail-agent logic
  auth/                Better Auth Google identity and database-backed sessions
  contracts/           Shared browser/server product and wire contracts
  database/            Schema, migrations, repositories, replica operations, and Temporal command admission
  workflows/           Deterministic Temporal Workflows and server-side workflow contracts
  gmail/               Google OAuth/OIDC, Gmail API, history mapping, and MIME parsing
  object-storage/      S3-compatible raw MIME and attachment storage
docker/                 Container images and local service orchestration
```

- Deployable processes belong in `apps/`; reusable domain and infrastructure code belongs in `packages/`; container assets belong in `docker/`.
- Applications may import public workspace-package exports. Packages must never import from `apps/*`.
- `apps/web` is UI-only and must not import database, Gmail, object-storage, credentials, or worker code.
- `apps/api` owns HTTP admission, authentication, authorization, protocol validation, and response serialization. Long-running or retryable work belongs in `apps/worker`.
- `packages/contracts` remains infrastructure-free and safe for browser imports.
- Cross-package imports use `@invook/*` public exports. Use relative imports within one package or application. Add a barrel file only when it defines a genuine public boundary.
- Read `apps/web/AGENTS.md` before frontend work; its Next.js-specific instructions take precedence for that subtree.

## Naming conventions

- Use `kebab-case` for source filenames and directories, except framework-required filenames such as `page.tsx`, `layout.tsx`, and `route.ts`.
- Use `PascalCase` for React components, classes, types, and interfaces.
- Name component props `<ComponentName>Props`. Name hooks `use<Capability>`.
- Use `camelCase` for functions, variables, object properties, and parameters.
- Prefix booleans with `is`, `has`, `can`, `should`, or another predicate that makes the true condition clear.
- Name UI event implementations `handle<Action>` and callback props `on<Action>`.
- Use `SCREAMING_SNAKE_CASE` only for true module-level constants. Do not capitalize ordinary immutable local variables.
- Use explicit identifier names at boundaries: `userId`, `accountId`, `messageId`, and `providerMessageId`, not an ambiguous `id` when several identities are in scope.
- Name collections with plural nouns. Name keyed lookups `<entities>ById` and identifier sets `<entity>Ids` when that describes their shape.
- Use verbs that reveal behavior. Prefer `get`, `list`, `create`, `save`, `replace`, `delete`, `enqueue`, `mark`, `complete`, or `fail` over vague names such as `handleData`, `processThing`, or `doWork`.
- Route registration functions use `register<Domain>Routes`. Durable worker handlers use `run<Step>` or another established verb that distinguishes them from pure transforms.
- Keep TypeScript property names `camelCase`; map to SQL `snake_case` explicitly through Drizzle.
- Test files are colocated and named `<subject>.test.ts` or `<subject>.test.tsx`.
- Avoid generic filenames and abstractions such as `utils`, `helpers`, `manager`, or `common` when a domain-specific name can state the responsibility.
- Match established domain vocabulary exactly. Do not create synonyms for existing concepts in adjacent layers.

## TypeScript standards

- TypeScript is strict. Do not add `any`, implicit `any`, or broad suppressions. Start with `unknown` at untrusted boundaries and narrow it explicitly.
- Add explicit input and return types at exported package APIs, HTTP/service boundaries, repository boundaries, queue payloads, and callbacks whose contract is not obvious. Prefer local inference inside a well-typed implementation.
- Use discriminated unions for state machines and provider/domain results. Handle closed unions exhaustively, with a `never` check when it improves compile-time safety.
- Model `null`, `undefined`, and omission deliberately. Preserve their distinction when it is part of a database, provider, or wire contract.
- Use `import type` for type-only imports. Keep imports grouped as external, workspace, then local, following the file's existing formatting.
- Prefer `satisfies` when validating an object while preserving inference. Use `as const` for intentional literal contracts, not as a substitute for proper modeling.
- Avoid type assertions, non-null assertions, and double casts. If a library boundary makes an assertion unavoidable, keep it narrow and document the invariant that proves it safe.
- Do not accept positional boolean arguments. Use an options object or a descriptive union so call sites explain intent.
- Keep public result shapes stable and domain-specific. Do not pass arbitrary records through several layers when the allowed fields are known.
- Validate environment variables, request bodies, webhook payloads, queue data, and provider responses before converting them to trusted domain types.
- Do not duplicate a shared browser/server contract in `apps/web` and `apps/api`; put genuinely shared wire types in `@invook/contracts`.
- Normalize caught `unknown` values before branching or logging. Preserve the original cause internally without leaking sensitive provider details to clients.

## Code and composition patterns

- Keep functions small enough to expose their invariant and side effects. Extract a focused module when logic is independently testable, reused, or owns a distinct integration boundary; do not create an abstraction for one trivial call site.
- Keep pure transformation and validation separate from I/O when practical. Pure code should not reach into global configuration, a database client, or provider SDK implicitly.
- Pass dependencies or established executors explicitly at boundaries where transaction composition, testing, or ownership requires it. Avoid hidden mutable global state.
- Reuse existing route, service, repository, serializer, access, credential, workflow, and error helpers before introducing a parallel implementation.
- HTTP handlers should follow the established flow: authenticate and authorize, validate protocol/input, call a focused service or repository operation, then serialize a stable success or problem response.
- Authenticate and authorize before reading protected data. Scope reads by server-resolved stable user/account IDs, never client-asserted ownership.
- Multi-row invariants and state transition plus Temporal command publication belong in one database transaction. Repository functions that must compose should accept an existing transaction executor.
- Use database constraints, row/advisory locks, or expected-version/cursor checks for cross-process correctness. In-memory mutexes do not coordinate multiple workers.
- Temporal payloads contain identifiers and durable checkpoints, not authoritative mutable state, mailbox content, or credentials. Activities re-read canonical state, remain idempotent, and no-op terminal or superseded work before expensive external calls.
- Temporal is the durable source of workflow execution, retries, schedules, and task delivery. PostgreSQL command records exist only to bridge an atomic product-state transaction into Temporal and stop owning execution after Temporal acknowledges the command; `LISTEN/NOTIFY` only wakes dispatchers.
- Default to React Server Components. Add `'use client'` only where browser APIs, client state, or hooks require it. Keep client components focused and keep server-only packages out of the client bundle.
- Keep server data authoritative in the UI. Loading, empty, unavailable, reconnect, and error states must be explicit and honest.
- Comments explain invariants, external constraints, or non-obvious tradeoffs. Do not narrate the code or add decorative section comments.

## React hooks and Zustand state

- A hook has one clear responsibility and exposes a small, typed return contract. Name hook input interfaces `Use<Capability>Props` and hooks `use<Capability>`.
- Use `useState` for component-local UI state. When state genuinely needs to be shared across unrelated client components, use a feature-owned Zustand store instead of passing it through several component layers or inventing a custom global event system.
- When a callback must keep a stable identity while reading the latest changing value, store that value in a typed ref, synchronize the ref in an effect, and let the callback read the ref. An empty dependency array is correct only when the callback reads changing values exclusively through synchronized refs and captures no other reactive value; otherwise declare the complete dependency list.

```typescript
interface UseFeatureProps {
  id: string;
}

export function useFeature({ id }: UseFeatureProps) {
  const idRef = useRef(id);
  const [data, setData] = useState<Data | null>(null);

  useEffect(() => {
    idRef.current = id;
  }, [id]);

  const fetchData = useCallback(async () => {
    const nextData = await loadFeature(idRef.current);
    setData(nextData);
  }, []);

  return { data, fetchData };
}
```

- Zustand stores live under `apps/web/src/stores/<feature>/`. Keep a simple store in `store.ts`; split a complex store into `store.ts` and `types.ts`.
- Define a reusable typed `initialState`, initialize from it, and implement `reset` from the same source so initialization and reset cannot drift.
- Wrap product stores in Zustand `devtools` middleware and give each store a stable, feature-specific name.
- Add `persist` only when the product explicitly requires state to survive a reload. When persistence is required, use `partialize` so only the minimum necessary state is stored; never persist server-owned mailbox data, credentials, provider payloads, or derivable state.
- Do not add Zustand merely for local component state or server state. A feature must demonstrate a real cross-component client-state need before introducing the dependency or a store.

```typescript
import { create } from "zustand";
import { devtools } from "zustand/middleware";

interface FeatureState {
  items: Item[];
  setItems: (items: Item[]) => void;
  reset: () => void;
}

const initialState: Pick<FeatureState, "items"> = {
  items: [],
};

export const useFeatureStore = create<FeatureState>()(
  devtools(
    (set) => ({
      ...initialState,
      setItems: (items) => set({ items }),
      reset: () => set(initialState),
    }),
    { name: "feature-store" },
  ),
);
```


## Testing and verification

Tests use Node's built-in runner through `node --import tsx --test`. Test files are colocated as `*.test.ts` or `*.test.tsx`.

Use the narrowest relevant checks while iterating, then run the full gate before handoff when the change warrants it:

```bash
pnpm --filter @invook/api test
pnpm --filter @invook/worker test
pnpm --filter @invook/gmail test
pnpm --filter @invook/database typecheck
pnpm --filter @invook/worker typecheck
pnpm --filter @invook/web lint
make verify
docker compose -f docker/compose.yml config --quiet
```

- `make verify` runs repository typechecking, linting, tests, and the production web build.
- Add regression coverage for changed parsing, validation, ownership, state transitions, concurrency, deduplication, idempotency, and retry behavior.
- Prefer pure unit tests for deterministic transforms, Temporal replay and time-skipping tests for Workflows, and real service integration checks when Temporal Cloud, PostgreSQL, MinIO, Gmail, Pub/Sub, or model credentials are available.
- Do not weaken assertions to make tests pass. Test observable contracts and failure modes rather than private implementation details.
- Schema changes require migration generation and inspection, plus a clean apply when the required database is available.
- Configuration changes require Docker Compose validation. Runtime changes require the closest practical end-to-end verification.

## Working procedure

1. Read applicable instructions and source-of-truth documentation.
2. Inspect `git status`, relevant call sites, schemas, tests, and configuration before editing.
3. State the invariant being changed and identify every producer and consumer of the affected state or contract.
4. Implement the smallest complete end-to-end change across the layers that own the behavior.
5. Remove the superseded path and all dead remnants in the same change.
6. Run targeted checks while iterating, then the full verification proportional to risk.
7. Search repository-wide for forbidden APIs, obsolete symbols, routes, configuration, and dead exports.
8. Report what changed, what was verified, and the exact external verification that remains.

`make dev` starts the complete Docker stack. `make down` stops containers without deleting named volumes. Never remove volumes or other user data unless the user explicitly requests it.
