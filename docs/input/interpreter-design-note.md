# The Interpreter — Design Note

**Compiling `leaderboardos/1` templates into installed flows**

Draft, rev 4 — September 2026. Rev 4, after J3: J4 retirement parity, generated reads (trade-off 10), the hand-written flow's data as canon (trade-off 11). Rev 2, after a first code review: capability catalog scoped, honest CEL-like framing, at-least-once effectors, J3 two-boot protocol, corpus location. Rev 3, after a second pass: `mutable` maps to `reward_rules` in v1 (flow-level `editableKeys` is a named later chantier), the `resources` line gains the `unbounded` mode and `class` filter that already exist, and J3 gains deterministic sequential draws. The bridge between the LeaderboardOS specification 0.2 (the ideal engine) and the post-020 architecture (the real one). Companions: the conformance suite 0.2 (the test corpus), `writing-a-flow.md` (the target interface), `spec-annotation-flow.md` (the reference consumer and equivalence contract).

---

## Why this exists, and the one idea underneath

The specification describes an engine that interprets challenge graphs. Challenge 020 built, without naming it, most of that engine's substrate: a core that knows no flow, registries, a declarative `FlowDefinition`, capability-gated actions, one cron tick, an event outbox. What remains is not a runtime — it is a **translator**.

**The interpreter is a compiler, not a second execution path.** It reads a `leaderboardos/1` document and produces a `FlowDefinition` — the exact object a hand-written flow exports. An installed template *is* an installed flow: same registries, same dispatcher, same architecture test, same screens machinery. The core does not learn a new way to run challenges; it keeps reading what the distribution installs, and the distribution gains a second way to say it. This is the connectors decision ("manifests-in-code → manifests-as-data") applied to flows themselves, and it is what makes the milestone small enough to ship.

## 0. Arbitrated trade-offs

These win on contradiction with anything below.

1. **Compile, never fork.** One execution path. If a template needs something `FlowDefinition` cannot express, the gap is fixed in the flow interface or in a capability — never by the interpreter running things privately.
2. **CEL-shaped syntax, a LeaderboardOS standard library.** Expressions use CEL's surface syntax, parsed and evaluated by our own code over a closed subset: field access, arithmetic, comparisons, `&& || !`, ternary, and a fixed builtin list — `count, majority, mode, mean, min, max, size, exists, filter, map`. Said plainly: `majority`, `mode` and `mean` are not standard CEL, so this is CEL-like, not CEL — third-party tooling compatibility is a possible future alignment, not a v1 promise. The gains stand on their own: no dependency in the security-critical path, a type-checker that owns the AST, termination by construction (no recursion, no user-defined functions, comprehensions only over engine-supplied collections).
3. **Templates are distribution content.** `content/templates/<key>/template.yaml`, installed by `mytwin.platform.ts` (`templates: [...]`), parsed and validated at startup with the same fail-fast posture as every install conflict. No template upload, no templates-in-DB in v1 — that arrives with the visual editor, changing storage, not semantics.
4. **`mutable` maps to `reward_rules` in v1; flow-level `editableKeys` is a named later chantier.** Two facts from the code decide this: `editableKeys` exists only on extensions (`ExtensionConfigDeclaration` + `patchExtensionConfig` — flows have no post-creation config patch), and the annotation flow's three mutable params already live in `reward_rules`, defensibly: rate, control mix and audit rate all govern what gets paid and checked. So v1 compiles strictly — `mutable: false` → the generated `flow_config` schema, `mutable: true` → the generated `rules.parse` — **one source of truth each, never both**. This narrows the spec's general `mutable` for now. The named trigger for widening it: the first template with a mutable param that has no business in a rewards surface — `design-contest`'s `close_date` is the obvious candidate — at which point `editableKeys` + `patchFlowConfig` extend the flow interface (trade-off 1 applied), post-J3.
5. **Counters are derived, never stored.** A declared counter compiles to a live aggregation over claims, resources or ledger rows (`gold_correct` → sum over consumed gold claims; `slashed` → sum over slash ledger rows). The house rule — no cached total — generalized. A counter that cannot be derived is a design smell to resolve in the template, until a real one proves otherwise. Derivation has a cost: a counter read inside a draw filter or a gate is one aggregation query per gesture — fine at annotation scale with the right index, and the static validator emits an **advisory** (not an error) when a counter sits on a hot path. Materialization is a measured future optimization, never a default.
6. **Aggregates resolve inline.** No runtime aggregate object: the resolve condition is checked at each emission (the k-th `consume`, the quorum-th verdict), inside that action's transaction — the annotation consensus pattern, which is also how validation already behaves. Lifecycle-triggered resolution (`when: challenge.state == closed`) compiles into an `onClose` hook.
7. **No generic run table in v1.** Lanes whose inter-segment context lives in a claim or resource (annotation: draw → label) compile without persistent run state; each interactive segment is an idempotent action over that state. A `flow_runs` table joins the core the day a template genuinely needs cross-segment memory (developer-onboarding) — added then as a capability, per the 020 rule, not preemptively.
8. **Visibility compiles to projectors.** Field visibility declarations generate the response allowlists (the `lib/public` pattern): a `visibility: []` field never serializes; role- and author-scoped fields filter per caller. Dynamic grants (the reveal) are out of v1 scope — see §6.
9. **v1's target is one template end-to-end, not ten.** J3 installs `data-annotation` and proves it equivalent to the hand-written flow, using spec-annotation-flow §3 as the contract. Full-suite conformance is the milestone after — aligned with the funding map's M3.
10. **Lanes describe the program; reads are generated.** The format does not model reads, by choice. `release` (the standard abandon gesture of every claim with a TTL), `progress`, `overview` and `export` are generated by the compiler from resource declarations, counters and visibility. A missing *gesture* is a template omission (resolving a contested item is an admin lane); a missing *read* is a compiler generation.
11. **The hand-written flow's data is the canon.** When a template replaces a flow, the compiler aligns on the data the flow already wrote — claim results, resolutions, cursor stamps, ledger metas — never the other way round. Zero migration: the strangler replaces without the data noticing.

## 1. The compilation model

`packages/interpreter` (core). Input: a parsed, validated template. Output: a `FlowDefinition`. The mapping, construct by construct:

| Template construct | Compiles to |
|---|---|
| `template.id / version / name / summary` | `descriptor` (key, labels; icon and visibility from a small presentation block) |
| `params` (mutable: false) | `config.schema` — a generated zod object, typed from param types |
| `params` (mutable: true) | `rules.parse` for `reward_rules` — the v1 rule of trade-off 4 |
| `requires: {core: N}` | interpreter/capability version check at install, fail fast |
| `resources` + `claim` modes | the `resources` capability — v1 compiles what it implements: `k_bounded` (k ≥ 1; `exclusive` is k = 1), `unbounded` (no k), TTL, a `class` draw filter, the structural one-live-claim-per-(resource, user); scoped `unique_per` dimensions land with their first consuming template |
| `counters` | derived-aggregation readers (trade-off 5) |
| `lanes` — `trigger: user/admin` entries | one generated action per interactive segment (`POST flow/<lane>` or `flow/<lane>/<collect-id>`), `access` from the entry's Access declaration (roles, member, qualification) |
| `lanes` — `trigger: cron` | a generated `jobs` entry on the tick |
| `lanes` — `trigger: webhook` | out of v1 |
| Collect field schemas | request-body zod validation + generated form UI (§5) |
| Gate (blocking) | an in-handler check; refusal returns a modeled 4xx — the three-outcome semantics |
| Gate (branching) | compiled conditional inside the handler; convergence already proven statically |
| Act observer/effector | capability and connector calls, resolved through the interpreter's **capability catalog** (below) and the connector registry |
| Assess `ai_grid` | the `evaluate` capability + grid registry |
| Assess `human` | the enclosing Collect's submission, consumed with the claim |
| Assess `metric` | an expression evaluation |
| Aggregate | inline resolve at emission (trade-off 6) + `close(resource, verdict)` |
| Reward nodes | generated `ruleKeys` (with `consumesPool`) + ledger writes through the economy capability; `mapping: continuous/tiers/fixed` as expressions or lookup |
| Resource/field visibility | generated response projectors (trade-off 8) |

Install-time wiring is the same ceremony as a hand-written flow: descriptor into the catalog, definition into the platform manifest, conflicts (rule keys, action paths, jobs) failing the boot.

### The capability catalog

There is no runtime capability registry in the core, and this note does not create one: `packages/capabilities/*` stay plain imported modules, and hand-written flows keep importing them directly. What the interpreter needs is narrower — a **compilation catalog** inside `packages/interpreter`: a table mapping the capability names templates may use (`evaluate`, `resources`, economy, `http_proxy`, connector-backed observers…) to their typed signatures, their create-or-get flag, and — in J2 — their executable bindings. J1 ships the static half, which the References pass validates against; J2 ships the bindings. The catalog is the interpreter's contract surface, not a core refactor.

## 2. The expression layer

Grammar: the CEL subset of trade-off 2, parsed by a small Pratt parser into a typed AST (~a few hundred lines, owned). Evaluation contexts are engine-supplied and closed — an expression sees exactly what the spec says its node sees: `params.*`, the run's collected fields, the drawn claim's payload, `counters.*` (derived readers), `challenge.state`, `group.members` where the flow uses groups. No IO, no clock, no globals beyond the builtin list.

Static typing happens at install: every expression is type-checked against the declared types of its context (param types, Collect field types, resource field types). An expression referencing an unknown field, comparing incompatible types, or calling an unknown builtin fails the boot with the template name, the node id and the position — the editor-time-error promise of the spec, delivered at install time until an editor exists.

## 3. Static validation

What installing a template verifies, in order, all fail-fast:

1. **Format** — `format: leaderboardos/1`, structural schema of the document (zod).
2. **References** — every `ref(...)`, resource type, grid id, connector and qualification name resolves against the running distribution's registries, and every capability name against the interpreter's catalog; `requires.core` satisfied.
3. **Types** — every expression type-checks (§2); Collect schemas are well-formed; param defaults match their types.
4. **Graph shape** — lanes are quasi-linear; branching gates converge (possibly to the lane's end); no node reads a value produced later in the lane.
5. **Economy** — every Reward writes a declared-compilable rule key; pool-consuming rewards reference the challenge pool; clamp semantics present where the spec requires them.
6. **Claims** — every claim mode is one the `resources` capability implements today (k-bounded, unbounded, TTL, the `class` filter, the structural per-user uniqueness); TTLs positive; a mode outside that list is an install error naming the missing support.

The conformance suite is the corpus — and it enters the repository. The specification and the suite land in `docs/leaderboardos/`; the eleven templates are extracted into individual YAML fixtures under `packages/interpreter/conformance/`. That extraction is a real J1 task, not a copy-paste: the suite's YAML blocks are illustrative (ellipses, `a | b` shorthands, prose comments), and canonicalizing them into strictly parseable documents will surface concrete syntax decisions — the format meeting its first parser. J1's definition of done: all eleven canonical templates parse and validate (execution comes later), and a mutated corpus — one broken wire, one bad type, one diverging branch per case — fails with the right error.

## 4. Execution semantics

A compiled handler is a sequence of node executions, each mapped onto the capabilities' existing transactional behavior: `draw` and `consume` are single transactions in the `resources` capability; ledger writes commit with their action; an inline aggregate resolve happens inside the consuming transaction — exactly the node-boundary-is-transaction-boundary rule, inherited rather than rebuilt. The three outcomes are literal: success continues, refusal is a modeled 4xx with no side effects (a failed gate, an exhausted claim), error is a 5xx after which the repeated gesture resumes cleanly because every step is idempotent by construction (claims race on indexes, rewards dedupe by their rule keys' natural keys, closes are first-wins).

Effectors follow the two-sided contract of spec §3.4, stated here without euphemism: across retries the real guarantee is **at-least-once, deduplicated by the capability's natural key** — a 5xx replay re-fires the action, and it is the capability's create-or-get behavior that makes the effect exactly-once. That is why create-or-get eligibility is mandatory, not advisory: the catalog carries the flag, and the static validator refuses an effector compilation onto a capability without it.

## 5. Generated UI

Screens never branch on the flow — they already ask the distribution for slots. The interpreter supplies generic slot implementations, parameterized by the template:

- **A form renderer** for Collect schemas: `string`, `number`, `enum` (buttons or select by cardinality), `url`, `file`, `ref` (a picker over visible resources). The annotation flow's single-choice screen is its prototype.
- **Output renderers** by declared type: `image` (url), `json`, `url`, plain text — the typed-renderer direction from the connector session, at its minimum useful size.
- **The standard slots** — contributor tab, manager tab, hero stat, rules drawer — composed from the template's lanes (member-accessible entries become contributor blocks; admin entries become manager panels) plus the generated progress reads.

A distribution can always override a template's slots with hand-written ones — generated UI is the default, not a ceiling. That is the escape hatch that keeps v1's renderer set small.

## 6. Milestones — and what v1 leaves out

**J1 — parse and validate.** Canonicalize the eleven-template corpus into fixtures (§3), the format schema, the expression parser and type-checker, the six validation passes, the static half of the capability catalog, the mutated-corpus test suite. Deliverable: `npm run templates:check` green on the canonical corpus. *(Funding M1.)*

**J2 — compile and execute.** The FlowDefinition compiler and the catalog's executable bindings, over the capability set the annotation flow proved: `resources`, `evaluate`, economy, cron, qualifications. Deliverable: a toy template installed by `example-flow.test.ts`'s successor, exercised end to end. *(Funding M2, retargeted.)*

**J3 — the equivalence proof.** Not side by side: both implementations declare the same rule keys and action paths, so one boot would fail fast on its own conflict detection — correctly. Instead, **two test distributions booted in succession** — `PlatformRegistry.reset()` between them, database re-seeded — one installing the hand-written flow, the other `content/templates/data-annotation/template.yaml`, with a harness replaying identical scenarios against each. Two tiers of proof. Sequential scenarios assert **identical draws**: the candidate ordering (unclaimed-by-caller first, then `created_at`, then `uuid`) is deterministic outside concurrency, so the harness seeds fixed uuids and timestamps and requires both implementations to pull the same items in the same order — a stronger proof at no extra cost. Concurrent scenarios assert **invariants** — `SKIP LOCKED` makes assignment order legitimately nondeterministic there — same consensus verdicts, same ledger sums per rule key and per user, same projected payloads, same refusals, per the §3 mapping table of `spec-annotation-flow.md`. What J3 proves is behavioural equivalence, not continuity: each boot wrote its own data. That gap is J4's first condition.

**J4 — retirement parity.** The strangler bites only when these conditions are green, and each future bite inherits them:

1. *Data continuity.* The compiler writes the hand-written flow's data shapes (trade-off 11). Proven by the **in-flight handoff**: half a campaign on the hand-written flow, a reboot on the template over the same store, the campaign finished — accuracy carries over, draws stay coherent, final sums equal an uninterrupted campaign. This test becomes the standard requirement of every strangler bite.
   Retirement has two regimes. When the hand-written flow and the template share the same storage shape, retirement is a mid-flight handover, proven by the handover test (data-annotation). When shapes differ structurally, retirement is attrition: the template takes a distinct flow key and rule keys and serves new challenges only; the legacy flow turns non-proposable, keeps dispatching its existing challenges, and uninstalls when none reference it. No data migration — production data is the canon in both regimes. The ledger, being core, is untouched either way. Equivalence testing follows the regime: behavioral equivalence on fresh challenges in both; the handover test only where shapes coincide. Endpoint-validation is the first attrition retirement.
2. *Creation checks.* Resource fields carry `check:` expressions — the mechanism params already use — and the compiler evaluates them at every creation, imports included. The template's gold `expected` checks membership in the label schema's keys; no ad hoc import validation.
3. *Surfaces.* Resolving a contested item is an admin lane of the template (a collect of a contested item and a decision, then a transition that recloses it). `release`, `progress`, `overview` and `export` are generated (trade-off 10).
4. *The real substrate.* An integration test project on Postgres: the `resources` capability's concurrent invariants (k never exceeded, TTL, uniqueness — the tests spec-annotation-flow required from M1), the concurrent tier of the J3 harness, and the handoff of condition 1. `test:integration` green is the retirement gate.
5. *The client contract.* The distribution's UI is the fifth retirement condition: MyTwin's components were written against the hand-written flow's API and must move to the generated surfaces before the flip. The custom components stay — generated UI is the default, not a ceiling (§5) — it is their data contract that switches: generated paths, generated shapes, generated names. Anything the UI needs that the generated surface lacks is handled by enriching the generator first, wherever the data is derivable from the template (`rewards.summarize` from rule keys and resource counts; per-class eligibility from the claim's clearance declaration); only genuinely distribution-specific reads become distribution endpoints, stated as such — never aliases of the retired flow's API, which would be a hand-written fork of a generated surface. The first flip pays this migration; every later one inherits it.

Order: 1 → 2 → 3 → 4 → 5, then the flip in the distribution — the hand-written flow retires and its template replaces it, the strangler's first bite, and the funding pitch's sentence made true.

**Out of v1**, each waiting on its first real consumer: webhook triggers and external-id dedup (no landing site is reserved — the first consuming template decides the shape); `spawn_challenge` / Link and auto-join; stake, slash and refund economics; the generic `flow_runs` table for multi-segment lanes; dynamic visibility grants (the reveal — required by `endpoint-validation`-as-template, which is exactly why interpreting the validation flows is the milestone after J3); contouring-grade Collect widgets; template storage outside the distribution (the editor's chapter).
