# Packages

This monorepo holds one app, the **core** (`packages/`), **installed content** (`content/`) and **product modules** (`modules/`). None of them is deployed on its own: the app imports them, and its distribution manifest decides what is installed. The import rules between these zones are in [`architecture.md`](./architecture.md#import-boundaries); adding a flow is described in [`writing-a-flow.md`](./writing-a-flow.md).

---

## `apps/leaderboard-client`

**Type:** Next.js 16 application (App Router)
**Role:** The single deployable artifact. Serves the UI and handles all server-side logic via Route Handlers.

Key responsibilities:
- Renders all pages: leaderboard, challenges, contributor profiles, admin panel, sandbox
- Implements all API endpoints under `src/app/api/`, including the generic flow/extension action routes, `/api/integrations/*`, `/api/cron/tick`, `/api/modules` and `/api/events/ui`
- Handles authentication (JWT cookies, route protection in `src/proxy.ts`)
- **`src/distribution/`** — the composition root for MyTwin:
  - `mytwin.platform.ts` — flows (hand-written and compiled from `content/templates/`, `endpoint-validation` retired), extensions, kits and modules installed
  - `mytwin.server.ts` — connectors, integrations, bundle sources, providers and grids; installed by `src/instrumentation.ts`, which then loads the template versions published in the database (`loadDatabaseTemplates`) and checks the file templates for drift
  - `mytwin.templates.ts` — the text of the file templates, read-only in the editor's library
  - `client/generated.tsx` — the generated slots of a template, and `describedSlots`: the slots of a type absent from the client tables (a database template), built from its served description
  - `forms/template.ts`, `forms/template-fields.tsx` — the creation form section of a database template, generated from its param declarations
  - `mytwin.client.tsx`, `mytwin.forms.tsx`, `mytwin.activity.tsx`, `mytwin.integrations.tsx` — client slots per flow and connector (`client/`, `forms/`, `activity/`)
  - `mytwin.modules.tsx`, `mytwin.proxy.ts` — module slots and module route rules (`modules/`)

---

## Core — `packages/`

### `packages/registry`

`PlatformRegistry` (`platform.ts`): flows, extensions, kits, modules, qualifications, rule keys, contribution types, jobs, events, subscriptions, quests, evaluation handlers and CP sources. Installation fails on a duplicate key or on a subscription or quest bound to an undeclared event. Also holds the architecture, empty-distribution and example-flow tests.

Beside the distribution it holds the **template versions published in the database**, indexed by `(key, version)` (`installTemplateVersion`, `templateVersionConflict` for a dry run). `flowFor(challenge)` is the canonical resolution — a challenge with a `template_version` gets exactly that compiled version, one without gets its file flow; `flow(key)` and `flows()` take the latest published version of a database template. Versions of one template share their ledger keys, and a job several versions declare stays one job that runs them all. A flow may be `retired`: installed, serving its challenges, refused for new ones. `flows.ts` is the flow catalog; its `unknown` option describes a type the client does not know (a database template).

### `packages/capabilities`

What flows, extensions and modules build on:
- **`evaluation.ts`** — `evaluate({ bundle, gridSlug, subject })`, runs and their retry; `bundle.ts` prepares and cleans the snapshot
- **`challenge-actions.ts`** / **`challenge-hooks.ts`** — the action dispatcher with declared access, and the `onCreate` / `onJoin` / `onGroupJoin` / `onClose` / `onDelete` hooks
- **`board.ts`**, **`groups.ts`**, **`qualifications.ts`** — personal task board, group policy, user qualifications
- **`resources.ts`** — claimable work units: import, `draw` bounded by `k` with TTL and one live claim per person, `claimScoped` (a designated instance, unique per scope, exclusive or per person), the claim `context` a multi-step lane keeps, field grants (`grant`, `grantsFor`), `heldInScope`, `consume`, `release`, `close` (`resource_instances`, `resource_claims`, `resource_field_grants` — see [`data-annotation.md`](./data-annotation.md) and [`database.md`](./database.md#resources))
- **`blobs.ts`** — files: `store` (up to 25 MB, returns a reference `{blob_id, content_type, filename, size}`), `get`, `delete`, `purgeExpired` (retention in days after the challenge closes, run by the core job `core.blobs.retention`); Postgres `bytea` in v1
- **`templates.ts`** — templates in the database: `loadPublished` (boot), `ensureFlowFor` (dispatch catch-up, `unservable` → 503), `refreshPublished` (cron tick), `create`, `saveDraft`, `publish` (strict validation, version read from the YAML, dry-run conflict check), `library`, `detail`, `seedYaml`, `describeDraft`, `checkSystemDrift`, and `diagnose` — the one diagnostic list shared by draft saves and publication refusals
- **`pool.ts`**, **`economy.ts`**, **`rewards.ts`**, **`deliverables.ts`**, **`flow-config.ts`**, **`grid-seeds.ts`**
- **`cron.ts`** — the job registry behind `/api/cron/tick` (`cron_runs`)
- **`events.ts`** — outbox: `emit`, `distribute`, `purge`
- **`modules.ts`** — module state and settings (`module_settings`)
- **`crypto.ts`**, **`credentials.ts`** — encryption and the `integration_credentials` store
- **`identity/google-auth.ts`** — Google OAuth login
- **`http-proxy/`** — `ssrf-guard.ts` (`assertPublicHttpUrl`, guarded DNS lookup) and `endpoint-proxy.ts` (the proxied call to a contributor's endpoint)
- **`testing/action-context.ts`** — a fake action context for handler tests

### `packages/interpreter`

Reads, validates and compiles `leaderboardos/1` challenge templates (`docs/input/interpreter-design-note.md`, milestones J1 to J5; templates in the database: `docs/input/templates-in-db-design-note.md`):
- **`expr/`** — the CEL-syntax expression parser, its static type-checker and its evaluator
- **`compile/`** — `compileTemplate(report, {runtime, published?})` turns a valid template with no v1 gap into a `FlowDefinition`: one `POST flow/<lane>[/<gesture>]` action per lane segment (`segments.ts`), a job per cron lane, an `onClose` hook for aggregates resolved at close, immutable params as `flow_config`, mutable params as `reward_rules`. `published: {version}` compiles a database template: its declared rule keys and contribution type are prefixed `<key>.`, and its jobs only run the challenges of that version.
  - `engine.ts` runs the nodes: draws and designated claims (the observer runs before the claim is taken), grants (the reveal), aggregates and their deferred pay, reverse rewards, and what a claim keeps between steps — persisted from typing, scalars and references only.
  - `reads.ts` generates `release`, `progress`, `overview`, `export`, `<lane>/claim`, `<lane>/file`, `file` and `<lane>/options`; each read takes its lane's access.
  - `values.ts` hydrates resources and projects them by declared visibility **or** grant.
  - `runtime.ts` is the port to the `resources`, `blobs` and contributions capabilities, the ledger, grid evaluation and observers (`http_proxy` over `capabilities/http-proxy`); `testing/memory-runtime.ts` is its in-memory double
- **`format/`** — the document schema (zod) and the declared-type syntax
- **`validate/`** — the passes: format, references, types, graph shape, economy, claims; plus the features v1 does not compile yet (`SupportGap`). `format.ts` is a **salvage parse**: sections, entries, lanes and nodes are validated one by one, what fails is left out with its diagnostic and a `broken` marker the analysis types `dyn` — so a holey draft still gets its reference, type and shape diagnostics on what stands, without cascades
- **`catalog.ts`** — the capabilities a template may name, with their arguments, outputs and create-or-get flag
- **`conformance/`** — the eleven templates of the conformance suite 0.2 in canonical form (`CANONICAL.md` lists the rewrites)

`npm run templates:check` validates the corpus and `content/templates/*/template.yaml`.

`describe.ts` is the client-safe entry, nothing executed: a template's descriptor, its config and rules schemas, and its **surface** — lanes, their steps (which one opens or resumes a claim), typed gesture fields, the qualification a lane requires, resource types, and the param declarations with their binding (`pool`, `source`, `config`, `rules`). The surface is serializable: `/api/templates/:key/describe` serves it, and the generated UI and the generic creation form are built from it. `npm run templates:build` writes each template's text into `template.source.ts` beside it, so the server, the client, vitest and tsx import it as a module; `templates:check` fails when that module is stale.

`content/templates/data-annotation/template.yaml` is the data-annotation flow as a template, and the flow the MyTwin distribution installs (the hand-written `content/flows/data-annotation` stays as the reference of the equivalence tests); `equivalence.test.ts` beside it plays one seeded scenario against the hand-written flow and the compiled template and requires the same draws, pay, resource states and ledger rows, and `equivalence.integration.test.ts` does it on Postgres, including a campaign handed over mid-flight.

`content/templates/endpoint-check/template.yaml` is endpoint validation as a template: it serves every new ML validation challenge, under its own keys, while the hand-written `endpoint-validation` is retired by attrition (see [`validation-challenges.md`](./validation-challenges.md)). Its screens are generated (`distribution/client/generated.tsx`, `src/components/generated/`).

### `packages/config`

**Required by:** everything
**Purpose:** Validates environment variables at startup with Zod, and exposes credential getters that read the credentials store first.

Variables it validates:
- `DATABASE_URL` — required
- `JWT_SECRET` — required, must be 32+ characters
- `JWT_ACCESS_EXPIRY` / `JWT_REFRESH_EXPIRY` — optional (defaults: `15m` / `7d`)
- `OPENAI_API_KEY` — optional fallback for the OpenAI connection
- `GITHUB_TOKEN` — optional static fallback token
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_OAUTH_REDIRECT_URI` / `GITHUB_TOKEN_ENCRYPTION_KEY` — optional (in-app GitHub OAuth connection, see [`github-setup.md`](./github-setup.md))
- `KAGGLE_USERNAME` / `KAGGLE_KEY`, `SLACK_BOT_TOKEN` — optional fallbacks (see [`admin-settings.md`](./admin-settings.md))
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URI` — required (login)
- Other `GOOGLE_*` — Google Workspace credentials (meetings module)
- `CRON_SECRET` — secures `/api/cron/tick`
- `OTEL_*` — observability config (optional)
- `VALIDATION_ALLOW_PRIVATE_ENDPOINTS` — optional, **local dev only** (see [`validation-challenges.md`](./validation-challenges.md))

> Scaleway has **no** env fallback — GPU compute credentials only ever come from the admin-connected account (see [`compute-power.md`](./compute-power.md)).

**Key files:** `index.ts`, `githubToken.ts`, `kaggleCredentials.ts`, `slackCredentials.ts`, `openaiCredentials.ts`, `scalewayCredentials.ts`

### `packages/database-service`

**Purpose:** PostgreSQL schema + typed repositories. The only package that talks to the database directly.

- **Schema** (`db/drizzle.ts`), **mappers** (`db/mappers.ts`), **domain types** (`domain/entities.ts`, `domain/schemas_zod.ts`)
- **Repositories** (`repositories/`) — one per domain area, among them the platform tables: `cronRun`, `platformEvent`, `eventDelivery`, `moduleSetting`, `integrationCredential`, `userQualification`, `onboardingProgress`
- `domain/legacyFlowConfig.ts`, `domain/legacyProposalFields.ts` — read fallbacks for columns kept until they are dropped

### `packages/evaluator`

**Purpose:** The OpenAI scoring agent (`openai/evaluate.agent.ts`, 0–9 per criterion, 3 retries) and the grid registry (`grids/index.ts`), which has no built-in grid: grids are content seeds (`content/grids/{code,dataset,model}`) inserted at deploy time by `npm run db:seed-grids`. Callers go through `evaluate()`; reward math belongs to the flows.

**Key file:** `evaluator.ts` (`OpenAIAgentEvaluator`)

### `packages/connectors`

**Purpose:** The `ExternalConnector` interface and `ConnectorRegistry` (`interfaces.ts`, `registry.ts`), the opaque activity shape `{ connectorKey, payload }` (`activity.ts`), and `IntegrationRegistry` (`integrations.ts`) — each integration declares its auth mode (`oauth` or `api_key` + fields), its test and its public fields. The connectors themselves are content.

### `packages/provisioner`

**Purpose:** The provider interface and `ProvisionerRegistry` (`src/registry.ts`, `src/index.ts`). A provider reports whether it is available from the credentials store; the providers themselves are content.

### Not yet sorted

Still in `packages/` but outside the core rules (see `UNSORTED_PREFIXES` in the architecture test):
- **`packages/services/`** — service code used by flows and modules: `challenge/` (code and ML rewards, repo evaluation, validation and reference cases, scenarios, SSRF guard, endpoint proxy), `compute/`, `digest/`, `google-workspace/` (calendar, meet), `sandbox/`, `slack/`, `sync-meeting/`, `evaluation-grid.service.ts`, `database-grid-provider.ts`
- **`packages/sync-meeting-agent/`** — AI analysis of a meeting transcript (`meeting-analyzer.ts`)
- **`packages/slack-signal-agent/`** — AI detection of a challenge's contribution signals in Slack messages (`openai/detect.agent.ts`, see [`slack-signals.md`](./slack-signals.md))

---

## Content — `content/`

| Kind | Entries |
|------|---------|
| `flows/` | `code` (project on a branch, board-gated evaluation), `ml` (datasets, models, packaging), `endpoint-validation`, `journey-validation`, `data-annotation` (labeling campaigns on the `resources` capability) — each exports a `FlowDefinition` from `index.ts` |
| `kits/validation` | validation targets, validator contribution and `cp_per_validation` payment, shared by the two validation flows |
| `extensions/` | `slack-signals` (every flow), `compute` (ML: GPU requests, Scaleway client and provider in `compute/scaleway/`) |
| `connectors/` | `github`, `kaggle`, `slack` — connector, integration and activity extractor |
| `integrations/openai` | the OpenAI API key connection |
| `bundle-sources/` | `github-snapshot`, `kaggle-artifact` |
| `workspace-providers/` | `github-branch` (a protected personal branch per contributor) |
| `grids/` | `code`, `dataset`, `model` seeds |

---

## Modules — `modules/`

Each exports a `ModuleDefinition` (key, default state, settings schema, jobs, events, subscriptions). Disabled, a module's routes answer 404, its jobs are skipped and its slots hidden. See [`admin-settings.md`](./admin-settings.md).

| Module | Role |
|--------|------|
| `meetings` | Google Meet sync meetings and their analysis — off by default ([`sync-meetings.md`](./sync-meetings.md)) |
| `onboarding` | records quests from platform events (`questRecorder`) ([`onboarding.md`](./onboarding.md)) |
| `digest` | periodic activity snapshots ([`digest.md`](./digest.md)) |
| `sandbox` | contributor proposals for any flow that declares `proposable`, star economy and promotion ([`sandbox.md`](./sandbox.md)) |
