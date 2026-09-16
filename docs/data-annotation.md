# Data annotation

An **annotation campaign** is a challenge whose flow is `data-annotation`. An admin imports a batch of unlabeled images and a set of hidden quality checks ("golds"). Contributors label one image at a time. Each image is labeled by `k` people and resolved by agreement. The golds measure each annotator's accuracy, which weights their pay and gates sensitive images. A weekly audit claws back pay on labels that disagreed with the agreed answer.

The flow is the first one added *through* the core/content separation of challenge 020 rather than reorganized into it. It declares no table of its own: items, golds and labels are rows of the core **`resources`** capability. Source spec: [`docs/input/spec-annotation-flow.md`](./input/spec-annotation-flow.md).

**Two implementations, one installed.** MyTwin serves `data-annotation` from its **template**, `content/templates/data-annotation/template.yaml`, compiled by the interpreter (see [`packages.md`](./packages.md#packagesinterpreter)). The hand-written flow `content/flows/data-annotation` is no longer installed: it stays in the repository as the reference the equivalence tests replay against (`equivalence.test.ts`, and `equivalence.integration.test.ts` on Postgres, including a campaign handed over mid-flight from one to the other). Both write the same data shapes and ledger keys, so a challenge moves between them without migration. The rules below hold for both; the **actions** are the template's.

## The `resources` capability (core)

`packages/capabilities/resources.ts`, over `resource_instances` and `resource_claims` (see [`database.md`](./database.md#resources)). It stores, claims and counts; it knows nothing about golds, accuracy or pay.

- A **resource** has a `resource_type` chosen by the flow, a jsonb `payload`, an optional `class`, a `state` (`open` / `closed`), a `verdict` and a jsonb `resolution`.
- A **claim** is one unit of work by one person: **active** (not consumed, released or expired), **consumed** (work delivered, permanent, with its `result`) or **lapsed** (released or past `expires_at`).
- **`draw(challengeId, userId, { type, k?, ttlHours?, class? })`** runs in one transaction. It releases the caller's expired claims (`released_at = expires_at`), locks a candidate with `FOR UPDATE SKIP LOCKED`, recounts active + consumed claims under the lock and inserts the claim if the count is below `k`. Concurrent draws spread across resources instead of colliding, and `k` is a hard bound. Without `k`, only uniqueness per person applies.
- **Uniqueness per person** is the partial unique index `(resource_id, user_id, scope_key) WHERE released_at IS NULL`: one live claim per person per resource (annotation claims have an empty `scope_key`), forever once consumed. An index cannot depend on the clock, so an expired claim stops blocking its author only when that author's next draw releases it. Scoped and designated claims (`claimScoped`, used by `endpoint-check`) add a second index, exclusive per scope — see [`database.md`](./database.md#resources).
- A draw serves resources the caller has **never claimed** first: a skipped image comes back only once the others are exhausted.
- **TTL is lazy**: nothing frees expired claims on a timer; they simply stop counting. `consume` refuses a lapsed claim, since a late label could exceed `k`.
- `close`, `reclose` (change the verdict of a closed resource that still has an expected verdict) and `stampResolution` (set a `resolution` key only once) are conditional updates: the loser of a race gets `null`.

The draw algorithm is tested against an in-memory store that reproduces row locks with `SKIP LOCKED`, snapshots taken before the lock, the partial unique index and expiry (`resources.test.ts`), and against Postgres by `resources.integration.test.ts` (`npm run test:integration`: concurrent draws never exceed `k`, uniqueness and TTL hold — see [`testing.md`](./testing.md)).

## Configuration

`flow_config`, fixed at creation (version 1):

| Key | Default | Meaning |
|-----|---------|---------|
| `k` | 3 | Labels per item. Odd, 1–15. |
| `ttl_hours` | 48 | Lifetime of a claim. |
| `label_schema` | — (required) | `{ kind: "single_choice", options: [{ key, label }] }`, 2–12 options with unique keys. |
| `sensitive_clearance` | `{ min_seen: 5, min_accuracy: 0.8 }` | Golds counted and accuracy required to receive `sensitive` items. |

`reward_rules`, editable during the campaign: `per_unit_cp` (CP per label), `gold_rate` (default 0.1), `audit_rate` (default 0.1).

These are the template's `params`: `mutable: false` ones form `flow_config`, `mutable: true` ones `reward_rules`, and their `checks` are named — a failing check comes back under its name (`label_schema: option keys must be unique`). The creation route takes this configuration as a generic `flow_config` object, validated by the compiled schema (see [`writing-a-flow.md`](./writing-a-flow.md)).

## Actions

Served at `/api/challenges/[id]/flow/<path>`. Lanes of the template become gestures; the reads are generated by the compiler for every template (trade-off 10 of the interpreter note).

| Action | Access | What it does |
|--------|--------|--------------|
| `POST annotator` | member | Draws a claim, or serves the caller's active one again: with probability `gold_rate` an unseen gold, otherwise an item — standard only, unless the caller's lagged counters clear `sensitive_clearance`. Returns `{ claim: { claim_id, expires_at, resource: { id, image_url } } }`, never the type nor the expected answer. |
| `POST annotator/label` | member | `{ claim_id, value }`, an option key. Consumes the claim (409 already labeled, 410 lapsed). A gold updates `gold_seen` / `gold_correct`; an item emits into the `agreement` aggregate, which closes it at `k` labels. Pays one `annotation` ledger row, identical for golds and items. |
| `POST annotator/release` | member | `{ claim_id }` — explicit skip. |
| `GET annotator/claim` | member | `?claim_id=` — the caller's claim, its resource as they may read it. |
| `GET progress` | member | Labels delivered, net CP (clawbacks deducted), lagged counters, eligible classes, active claim. |
| `POST import/batch` | admin, manager | `{ kind: "items" | "golds", class?, file }`, `file` being the rows (JSON). Items: `image_url`, optional `class`. Golds: `image_url`, `expected` (checked against the option keys at creation). All or nothing. The manager panel parses the CSV client-side. |
| `GET overview` | admin, manager | Counts per resource type and verdict, pool state, each participant with name and unlagged counters, contested items with their inputs. |
| `POST resolve/decide` | admin, manager | `{ item, value }` — settles a `contested` item by hand (recloses it `labeled` with the chosen consensus). |
| `GET resolve/options` | admin, manager | `?field=decide.item` — the items a decision can name. |
| `GET export` | admin, manager | `?type=item` — CSV of closed items with their verdict, consensus and inputs. |
| `GET annotator/file`, `GET file` | member | Bytes of a readable file field (none in this template). |

## Agreement

An item closes at its `k`-th label on the **strict plurality** answer (`verdict: labeled`, `resolution.consensus`). Any tie at the top closes it as `contested`. With `k = 3` that means three different answers. With `k ≥ 5` it also covers `A A B B C`, which neither a majority nor "all different" describes.

## Quality, pay and gold opacity

- **Accuracy** is a live sum over the annotator's consumed golds (correct / seen). There is no counter table.
- **Pay** per label is `round(per_unit_cp × accuracy)` (full rate while no gold counts), clamped to the remaining pool. It is identical for golds and items. The ledger row carries only `meta.claim_id`.
- **Opacity.** Nothing sent to an annotator reveals whether a draw was a gold: the card never carries the type or `expected`, and the label response has the same shape and pay. The **quality score is lagged**: accuracy, pay weighting and clearance ignore the annotator's 10 most recent labels (`QUALITY_LAG`). Without the lag, the score would only move right after a gold, and comparing it before and after each label would reveal which images were golds and whether the answer was right. The manager overview shows live, unlagged accuracy.

## Audit

Job `data-annotation.audit` (Mondays 04:00 UTC — the template's `audit` cron lane). For each `labeled` item without `resolution.audit`, it draws with probability `audit_rate` and stamps `resolution.audit = { at, sampled }` on **every** item it considers, sampled or not. Otherwise a non-sampled item would come back every week, and the real audit rate would drift toward 1. For a sampled item, each label that disagrees with the consensus gets an `annotation_clawback` row of minus what that claim was paid, net of earlier clawbacks. A negative row hands its CP back to the pool.

The stamp is a conditional update written **before** the clawback rows. Two concurrent passes never claw back twice; a crash between the stamp and the rows loses a clawback rather than doubling one. An item a manager resolves by hand becomes `labeled` and enters the next pass.

## Screens

The screens are MyTwin's own components (`distribution/client/data-annotation.tsx`), wired to the generated surfaces — generated UI is the default, not a ceiling:

- **Contributor tab "Label"** (`AnnotationWorkbench`): quality score, net CP and labels, then one image with the option buttons and Skip.
- **Manager tab "Campaign"** (`AnnotationCampaignPanel`): two CSV dropzones (items, golds), progress and export, the annotator table, the contested queue with one button per option.
- **Hero stat**: labeled / total items, from the flow's `rewards.summarize`.
- **Form section "Annotation"**: option builder, `k`, TTL and clearance (locked after creation), and the three pay fields (always editable).
- **Anonymous view**: the brief only; no image is shown outside membership.

## Differences from the spec

| Spec | Implementation | Why |
|------|----------------|-----|
| "Zero core modification beyond one new capability" | The creation route also accepts a generic `flow_config` object | The route listed the config keys of the first four flows; a new flow's keys were stripped. |
| An expired claim stops blocking `unique_per` | Released by its author's next draw | A partial unique index cannot read the clock. |
| "Majority is guaranteed unless all k answers differ" | Strict plurality, any tie is `contested` | False for `k ≥ 5` with three or more options. |
| Accuracy is a live sum used as is | Live sum, lagged by 10 labels for the annotator | The unlagged score leaks which draws were golds. |
| `resolution.audited_at` on audited items | `resolution.audit = { at, sampled }` on every considered item | Keeps non-sampled items from being re-sampled weekly. |
| Stamp and clawback in the same transaction | Conditional stamp first, then the ledger rows | The ledger repository has no transaction parameter; this order never double-claws. |
| — | `draw` serves the active claim again; never-claimed resources first | Prevents hoarding slots by drawing without labeling, and Skip returning the same image. |
| — | `userStats` is `consumedBy` (claims with payload and result) | Accuracy is gold semantics, which belongs to the flow. |

## Seed

`npm run db:seed:annotation` (`db_data/seed-annotation.ts`, dev only) creates "Demo annotation campaign": 30 photos from picsum.photos (3 sensitive), 6 golds, a neutral indoor / outdoor question. Three existing users then label up to 12 images each through the hand-written flow's `draw` and `label` handlers — the data they write is exactly what the installed template reads. It requires `db:apply-schema` and `db:seed`.
