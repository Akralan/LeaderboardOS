# Templates in the Database — Design Note

**The editorial chapter: draft → immutable publication → instantiation, plus diagnostic-mode validation**

Draft, rev 2 — September 2026. Rev 2, after code review against the registry's real read paths: boot-load with lazy catch-up replaces pure lazy loading, version-aware resolution (`flowFor`) becomes T1's central chantier, DB-template rule keys are prefixed by construction, the client falls back to generated UI, immutability moves into the database, T2 recenters on the partial model, and system-template drift gets a checksum alert. Four refinements from the follow-up pass are folded in: the no-dot template-key invariant, serializable param declarations instead of zod over HTTP, the version read from the YAML itself, and the cron-lock interplay. The canvas itself stays out of scope (its design spec for mockups exists separately).

---

## The one idea

Today templates are files installed at boot, validated fail-fast, frozen per deployment. The editor needs creation and publication at runtime. The idea that makes the chapter small: **publication is immutability, and immutability is the snapshot.** A published version is an immutable database row; a challenge references `(template key, version)` and never copies anything — the spec's lockfile-style instantiation realized by a database constraint instead of duplication. Immutability is also what makes loading trivially correct: any instance may load any published version at any time and can never be wrong.

## 0. Arbitrated trade-offs

1. **The YAML text is the canon.** `template_versions` stores the source text plus a checksum; parsed and compiled forms are always derived in memory. One source of truth — the same rule as `content/templates`.
2. **Two origins, one key space.** File templates (the distribution's system templates) install at boot as today, read-only in the library, duplicable as starting points. DB templates come from the editor. A key collision between the two fails the boot or the creation. System templates never migrate to DB.
3. **Publication = validation + key reservation + immutable row. Loading = boot plus catch-up.** Every instance loads **all published versions at startup** (one query, in-memory compilation), alongside the files — the registry stays synchronous and its seventeen existing readers (flow-config, deliverables, hooks, pool rule keys, cron jobs, creation, sandbox, rewards) do not change. A version published after an instance booted is caught by on-demand loading on the same path when its key or version is first met. The cron tick additionally does a light refresh before iterating (published versions newer than its last load), so scheduled jobs never wait on instance recycling. Future optimization if volume ever demands it: restrict boot-load to referenced versions plus each template's latest.
4. **Resolution is version-aware: `flowFor(challenge)`.** Two challenges on two versions of one template are served by two compiled flows. The registry indexes compiled DB templates by `(key, version)`; the canonical resolver reads the challenge's `template_version` (null → the file flow, as today). Callers that start from a challenge migrate to `flowFor`; callers that only have a key (catalog, type picker, creation) take the latest published. Cron jobs register deduplicated by `(key, job)`, and their bodies resolve **per challenge** through `flowFor` — each challenge runs under its own version; and the existing `cron_runs` lock serializes each job key across instances, so two freshly refreshed instances cannot double-fire.
5. **DB-template rule keys are prefixed by construction.** Action paths are namespaced by flow key; rule keys are not — `annotation`, `endpoint_check` are global, and a DB template declaring a historic key would collide with the ledger. So the compiler prefixes every DB template's rule keys and contribution types with the template key. The prefix is the **key alone, never the version**: successive versions mechanically produce identical keys, so a template's ledger never fragments. The separation is sound because of a **written invariant**: a template key matches `^[a-z][a-z0-9-]*$` — kebab-case, no dots, enforced at creation — while rule keys may contain dots; the first dot therefore always splits prefix from key, and no two (key, rule_key) pairs can produce the same string. Compiler-generated default keys (`<flowKey>.<lane>.<node>`) already have this shape. System templates keep their bare historic keys — they are the distribution's own. Nothing is reserved, nothing checked.
6. **A draft saves without passing validation.** Structural well-formedness is required; completeness is not. Validation runs in diagnostic mode and returns located diagnostics; publish requires zero errors. Same validator, two modes — and the collector already exists (`TemplateIssue` carries pass, severity and a logical path; `report.errors` / `advisories` are the two tiers). See §3 for where the real T2 cost sits.
7. **A challenge lives and dies on its template version.** Published versions are undeletable; `archived` hides a template from the library, never from its challenges. For **file** templates (`template_version` null) the rule is different and assumed: they follow the deployment, like any hand-written flow — that is today's behavior. The boot records each system template's checksum and emits a structured warning when it changed since the last boot, naming the live challenges affected. Cross-version challenge upgrades are a separate later chapter.
8. **Admin-only authoring in v1.** `created_by`, `published_by`, `published_at` are the audit trail.
9. **Semver, strictly increasing per template; one draft at a time.** "New version" = a new draft seeded from a published document.

## 1. Data model

```
templates
  key varchar PK          -- = the flow key; globally unique across files + DB
  name, created_by, created_at, archived_at?

template_versions
  template_key FK · version (semver) · status draft | published
  yaml text · checksum · created_at · published_at? · published_by?
  UNIQUE (template_key, version)
  PARTIAL UNIQUE (template_key) WHERE status = 'draft'      -- one draft at a time
  TRIGGER BEFORE UPDATE OR DELETE: error when OLD.status = 'published'
    -- immutability held by the database, not the repository (the house rule);
    -- the draft→published transition passes (OLD is draft)

system_template_checksums
  key PK · checksum · updated_at                             -- boot drift alert (trade-off 7)
```

Challenges gain one nullable column, `template_version`, and a **composite FK** `(type, template_version) → template_versions(template_key, version)` — NULL (file flows) passes under MATCH SIMPLE, a DB reference must point at a real version. Reference, never copy.

## 2. Runtime loading

Boot: files as today, then all published versions — compile, index by `(key, version)`. Dispatch and every registry reader stay synchronous; unknown keys or versions load on demand through the same compile-and-cache path; the tick refreshes recent publications before iterating. `flowFor(challenge)` is the canonical resolver (trade-off 4). Publish runs the full strict validation against the live registry plus flow-key uniqueness across both origins; rule-key safety needs no check at all (trade-off 5).

## 3. Diagnostic-mode validation — T2's real cost

The collector exists; the gap is upstream. `validateFormat` is a strict zod schema: without a model, the later passes never run, so a holey draft yields only format errors. T2's work is the **partial model**: a salvage parse that validates section by section, lane by lane, node by node, replaces invalid subtrees with `broken` markers carrying their diagnostic, and lets every later pass analyze whatever stands — skipping broken subtrees instead of aborting. A draft then gets its reference, type and graph-shape diagnostics on the intact parts, which is what a canvas needs. Publish = the same collector + assert-no-errors, so the gate and the editor can never disagree.

## 4. Editor API (admin) and the client

- `GET /api/templates` — library: system (read-only) + DB, with status, versions, usage counts.
- `POST /api/templates` — create; optional seed = duplicate of a system or published template.
- `GET /api/templates/:key` — versions + current draft.
- `PUT /api/templates/:key/draft` — save YAML text (structural salvage only) → diagnostics.
- `POST /api/templates/:key/validate` — diagnostics on demand.
- `POST /api/templates/:key/publish` — no version parameter: **the version is read from the YAML itself** (`template.version` — trade-off 1 applied, the text is the canon), and the database checks it strictly greater than the last published. The editor's patch/minor/major picker edits the draft's field; it is not an API input.
- `GET /api/templates/:key/:version/describe` — the template's serializable surface: lanes, steps, typed fields, **and the param declarations themselves** (type, default, mutable, named checks). Not the zod schemas — `configSchema` and `rulesSchema` are live objects that neither serialize nor survive `z.toJSONSchema` (named `refine` checks are lost). The client generates forms from the declarations; the server revalidates with the real schemas at creation.

**The client fallback changes.** `mytwin.flows.ts` and `mytwin.client.tsx` are static tables, and today an unknown type falls back to the code flow's slots — a DB-template challenge would render the wrong UI. New rule: a type absent from the tables fetches its version's describe and renders through `generatedSlots` — the generated UI is the universal fallback, never another flow's screens. Same machinery as the editor preview, so the preview costs nothing extra.

Instantiation: the existing create-challenge form, its template picker extended to published DB templates; for those, the configuration section renders from the served param declarations — the generic instantiation form of T1.

## 5. Milestones

**T1 — the editorial backbone.** Tables with the trigger and composite FK, repository guards (single draft), publish with strict validation, flow-key reservation and the YAML-read version check, boot-load + catch-up, **`flowFor` and the migration of challenge-anchored registry readers** (the central chantier), rule-key and contribution-type prefixing in the compiler, **the generic instantiation form** (generated from the served param declarations — a DB template has no hand-written form section), checksum drift alert. Proof: upload a YAML by hand — no editor exists yet — publish it, create a challenge on it, play it end to end; then publish a v2 and verify both versions serve their own challenges side by side.

**T2 — the partial model.** The salvage parse, `broken` markers, later passes running on intact subtrees. Proof: a deliberately holey draft returns format diagnostics *and* reference/type/shape diagnostics on its intact lanes; publish refuses with exactly that list.

**T3 — the editor API + client fallback.** The endpoints above, library data, the describe route, the generated-UI fallback for unknown types, draft preview. Proof: the full loop over HTTP — create, save invalid, read diagnostics, fix, publish, instantiate, and the challenge renders through generated UI with zero client-table changes.

Then the canvas: a separate chantier, fed by the mockups from `spec-graph-editor.md`, landing on an API that already does everything.

## Out of scope

The canvas itself; cross-version challenge upgrades; non-admin authoring; marketplace or import/export beyond plain YAML download/upload; real-time collaboration.
