# Writing a flow

A **flow** is what a challenge *is*: the work contributors do, how it is evaluated, how points are paid, and what the screens show. Every challenge has exactly one flow, stored in `challenges.type`. The core knows no flow: it reads what the installed distribution registers.

This guide shows how to add one. It assumes the separation described in `challenges/challenge-020-base_separation/SPEC.md`.

A flow can be written three ways, all installed as the same `FlowDefinition`:

| Way | Where | When |
|---|---|---|
| **TypeScript** | `content/flows/<key>/` | Behaviour the template vocabulary cannot express — sections 1 to 5 below. |
| **Template file** | `content/templates/<key>/template.yaml` | A `leaderboardos/1` template compiled by the interpreter and shipped with the distribution (`data-annotation`, `endpoint-check`) — see [Flows as templates](#6-flows-as-templates). |
| **Template in the database** | `template_versions`, through `/api/templates` | Written, validated and published at runtime by an admin, instantiated without a deployment — see [Flows as templates](#6-flows-as-templates). |

## Where things live

```
content/flows/<key>/
  descriptor.ts      ← name, icon, brief and public visibility (client-safe, pure data)
  index.ts           ← the server definition (FlowDefinition)
  actions/           ← action handlers, loaded on demand
  hooks.ts           ← join/close/delete hooks that do I/O, loaded on demand
  *.test.ts
apps/leaderboard-client/src/distribution/
  mytwin.flows.ts    ← the descriptor catalog (client and server)
  mytwin.platform.ts ← the server manifest: installs the flow
  mytwin.client.tsx  ← the flow's screen slots
  mytwin.forms.tsx   ← the flow's create/edit form section
```

**Import rules** (enforced by `packages/registry/architecture.test.ts`):

- a flow imports itself, kits (`content/kits/*`), the core (`packages/*`) and not-yet-sorted code (`packages/services/*`);
- a flow never imports another flow, a module, the shell (`apps/…`, `@/…`) or the distribution;
- the shell reaches a flow only through `src/distribution/*`.

Keep the declaration files free of **static** database imports. The server distribution — and the test setup — installs every flow at startup; a static import of a repository opens the database for everyone, and breaks tests that mock it. Load services and repositories inside the functions that need them (`const load = () => import("./actions/x.js")`).

## 1. The descriptor

```ts
// content/flows/demo/descriptor.ts
import type { FlowDescriptor } from "../../../packages/registry/flows.js";

export const demoFlowDescriptor: FlowDescriptor = {
  key: "demo",
  label: "Demo",
  longLabel: "Demo challenge",
  icon: "sparkles",          // a key of components/ui/FlowIcon.tsx
  briefRequired: true,       // non-members see the brief and a Join button
  publiclyVisible: false,    // anonymous visitors cannot open it
  joinCaption: "Joining gives you a personal board.",
};
```

Add it to `createFlowCatalog([...])` in `src/distribution/mytwin.flows.ts`.

## 2. The server definition

```ts
// content/flows/demo/index.ts
import { z } from "zod";
import type { FlowDefinition } from "../../../packages/registry/platform.js";
import { demoFlowDescriptor } from "./descriptor.js";

const load = () => import("./actions/submit.js");

export const demoFlow: FlowDefinition = {
  descriptor: demoFlowDescriptor,
  config: { version: 1, schema: z.object({ max_submissions: z.number().int().min(1).default(3) }) },
  ruleKeys: [{ key: "demo_submission", consumesPool: true, label: "Submission" }],
  contributionTypes: [{ key: "demo_entry", countsAsContribution: true }],
  uses: { board: false, groups: false },
  actions: [
    { path: "submissions", method: "POST", access: { member: true }, handle: async (ctx) => (await load()).submit(ctx) },
  ],
};
```

Then install it in `src/distribution/mytwin.platform.ts` (`flows: [..., demoFlow]`). Installation fails fast on any conflict: a rule key, contribution type, job, event or action path declared twice, a config version without its upgrade, an extension applying to a flow that is not installed.

### What a definition can declare

| Field | What it does |
|---|---|
| `descriptor` | Name, icon, brief, public visibility. |
| `config` | The schema of `challenges.flow_config`, fixed at creation (the form section sends it as `flow_config` in the body of `POST /api/challenges`, which passes it to the schema without knowing its keys), and its `version` with `upgrades[n]` (n → n+1). Old configs are upgraded in memory on read, and persisted by `npm run db:upgrade-flow-configs`. Read it with `flowConfigOf(challenge)` (`packages/capabilities/flow-config.ts`). |
| `configDefaults` | Set by the **distribution**, not the flow: values for missing config keys (a required qualification, for instance). |
| `rules` | `parse(raw)` for `challenges.reward_rules`, editable after creation. |
| `rewards` | Extra fields for `/api/challenges/[id]/rewards` (`summarize`, `publicFields`). |
| `ruleKeys` | The ledger keys the flow writes, and whether they consume the pool. Writing an undeclared key is refused. |
| `contributionTypes` | The contribution types the flow writes, and whether they count as contributions. |
| `deliverables` / `requires` | What the flow produces (`endpoint`, `deployed_app`…), or what it tests from a parent challenge. |
| `uses` | Core capabilities it turns on: `board` (personal board copied at join), `groups` (group work). |
| `hooks` | `onCreate` (pure: repos to create), `onJoin`, `onGroupJoin`, `onClose` (best effort), `onDelete` (runs before the row is deleted). |
| `actions` | HTTP actions, see below. |
| `evaluationHandlers` | How a failed evaluation run is retried. |
| `jobs` | Scheduled jobs (`key`, 5-field UTC cron `schedule`, `run`), run by `/api/cron/tick` under a lock. |
| `events` / `subscriptions` | Events the flow emits into the outbox, and events it consumes. An event with no subscriber is not written. |
| `quests` | Onboarding quests completed by an event, recorded by the onboarding module. |
| `proposable` | What the sandbox accepts as a proposal for this flow. |

**Extensions** (`content/extensions/*`) declare the same kind of things for the flows they apply to (`appliesTo: ["ml"]` or `"*"`), plus their own section of `flow_config.extensions[key]`. **Kits** (`content/kits/*`) hold code and declarations shared by several flows.

## 3. Actions

An action is served at `/api/challenges/[id]/flow/<path>` (or `/ext/<key>/<path>` for an extension). The dispatcher (`packages/capabilities/challenge-actions.ts`) resolves the challenge, its flow and the action, requires a session, then checks the declared `access`:

- no condition: any signed-in user;
- with conditions, **any one** is enough: `{ roles: ["admin"], manager: true }` reads "admin or manager"; `member` checks `challenge_teams`; `qualification(challenge)` reads the required qualification from the config.

The handler receives `{ request, challenge, user, params, access }` and keeps its own fine-grained checks (who owns a row, what state it is in). It returns a `Response` (a file, a chosen status) or any value, sent as JSON. Unknown paths answer 404, a wrong method 405, an unexpected error a generic 500.

Call it from the client with `flowActionUrl(challengeId, "submissions")` (`@/lib/challengeActions`).

Test handlers without routes, sessions or proxy, with the context builder:

```ts
import { actionContext } from "../../../../packages/capabilities/testing/action-context.js";

const result = await submit(actionContext({ challenge: { type: "demo" }, body: { url: "https://…" }, access: { member: true } }));
```

In the `packages` test project, mock classes through a hoisted object (`const h = vi.hoisted(...)`, `class { constructor() { return h.repo; } }`) and import the module under test after the `vi.mock` calls.

## 4. The screens

Screens never branch on the challenge type. They ask the distribution:

- **`src/distribution/mytwin.client.tsx`** — `FlowUiSlots` (`@/lib/flowSlots`): contributor tabs, manager tabs, the flow's hero stat on both screens, the anonymous view, the rules drawer body, and whether the screens read `/rewards`. Implementations live in `src/distribution/client/<key>.tsx` and may reuse any shell component.
- **`src/distribution/mytwin.forms.tsx`** — `FlowFormSection` (`@/lib/flowFormSlots`): the flow's part of the create/edit drawer: initial state, validation, the fields merged into the request body (including `type`), fields and detail editors, and what to save after creation. Keep the logic (`FlowFormLogic`) free of React so it can be tested without a browser.

## 6. Flows as templates

A template declares params, resources (typed fields with visibility, claim modes, closure), counters, aggregates and **lanes** — sequences of nodes (`collect`, `act`, `assess`, `gate`, `reward`) entered by a user, an admin or a cron. The format and its trade-offs are in `docs/input/interpreter-design-note.md`; `packages/interpreter/conformance/` holds eleven canonical examples, `content/templates/` the two installed ones.

**What the compiler derives, so you do not write it:**

- one `POST` action per lane step, a job per cron lane, the `flow_config` schema from `mutable: false` params and `reward_rules` from `mutable: true` ones (named `checks` become field-level messages), rule keys, a contribution type (`presentation.contribution`), `requires.deliverableCapability` from a `link` field's `deliverable`;
- the reads every template gets — `<lane>/release`, `progress`, `overview`, `export`, `<lane>/claim`, `<lane>/file`, `file`, `<lane>/options` (see [`api.md`](./api.md#template-flows)), each taking its lane's access;
- the descriptor from `presentation`, and a serializable **surface** (`describeTemplate`) from which the generated UI builds tabs, forms, choice pickers, file viewers, the manager overview and the rules drawer (`distribution/client/generated.tsx`). A distribution may still hand-write a template's slots — generated UI is the default, not a ceiling.

**A template file.** Write `content/templates/<key>/template.yaml`, then:

1. `npm run templates:build` writes `template.source.ts` beside it (the text as a module, importable by the server, the client and tests); `npm run templates:check` validates every template and fails when a source module is stale.
2. `descriptor.ts` calls `describeTemplate(templateSource, key)` (client-safe); `index.ts` calls `compileTemplate(checkTemplateSource(templateSource, key))`. A template that is invalid or uses what v1 does not compile (`SupportGap`) fails the boot, like any installation conflict.
3. Install the compiled flow in `mytwin.platform.ts` (with `configDefaults` if a param names a qualification), add its descriptor to `mytwin.flows.ts`, and either `generatedSlots(template)` or hand-written slots in `mytwin.client.tsx`.
4. Test it in memory with `packages/interpreter/testing/memory-runtime.ts` and the dispatcher (`content/templates/endpoint-check/reviewer.test.ts` is a full example), and on Postgres when it replaces a hand-written flow (`equivalence.integration.test.ts`).

A file template's rule keys are used as written: they belong to the distribution.

**A template in the database.** No deployment: create it with `POST /api/templates` (from a text, or a copy of a system template or published version), save drafts with `PUT /api/templates/:key/draft` — a draft may be incomplete, and every save returns the diagnostics a publication would be refused with — then `POST /api/templates/:key/publish`, which reads the version from `template.version`. A published version is immutable; a challenge created on the template references its latest published version and keeps it for life. Differences from a file template:

- its declared rule keys and contribution type are prefixed with its key (`<key>.<rule_key>`), identical across versions;
- its screens and its creation-form section are always generated (the client has no table entry for it);
- every instance loads it at boot and catches up on demand; a version that stops compiling is skipped with a warning and its challenges answer 503.

See [`api.md`](./api.md#templates) and [`database.md`](./database.md#templates).

**Retiring a flow a template replaces.** When a template takes over from a hand-written flow with the same data shapes, the distribution installs the template under the same key (`data-annotation`). When the shapes differ, the template takes its own key and the old flow is declared `retired: true`: it keeps serving its challenges, `POST /api/challenges` refuses new ones, and it can be uninstalled once no challenge references it (`endpoint-validation` → `endpoint-check`).

## 7. Checklist

- [ ] `content/flows/<key>/descriptor.ts` and `index.ts`, no static database import in either.
- [ ] Descriptor added to `mytwin.flows.ts`, definition installed in `mytwin.platform.ts`.
- [ ] Slots in `mytwin.client.tsx`, form section in `mytwin.forms.tsx`.
- [ ] Handler tests with `actionContext`, and a test of each action's declared `access`.
- [ ] `npx vitest run packages content modules` from the repository root (architecture test included) and `npx vitest run` in `apps/leaderboard-client`.
- [ ] For a template file: `npm run templates:build` and `npm run templates:check`.
- [ ] No change to the core, no migration: if the flow seems to need one, the need belongs in a capability first. Work units that people claim, under a redundancy `k`, a TTL or one claim per person, are the `resources` capability (`packages/capabilities/resources.ts`, see [`data-annotation.md`](./data-annotation.md)).
