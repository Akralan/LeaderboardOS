# Template Parity — Design Note

**Run `code`, `ml` and `journey-validation` (and finish `endpoint-validation`) as templates, exactly as the hand-written flows run**

Draft — September 2026. Companions: `template-parity-gap-analysis.md` (the exact behavior of each flow and every gap, with file references), `interpreter-design-note.md` (J1–J5), `templates-in-db-design-note.md`.

---

## The one idea

The strangler already bit twice: `data-annotation` was flipped with data continuity (J4), `endpoint-validation` was replaced by attrition (J5). This chapter finishes the job for the remaining flows, **with continuity**: each template reads and writes the data shapes the hand-written flow writes today, equivalence tests prove it rule by rule, then every challenge of that type — running ones included — switches to the compiled template. The format grows only by what a flow actually needs, and each addition is compiled, typed and bound before any template uses it.

## 0. Arbitrated trade-offs

1. **Flip with continuity, not attrition** (decided Sept. 17). A template must serve the challenges that already run: same contribution types, same ledger rule keys, same `challenge_teams` workspace columns, same `evaluation_runs`, same `reward_entries` meta. The hand-written data shapes are canon (J4 trade-off, unchanged); the hand-written flow stays in the tree as the equivalence reference.
2. **Exact rules, generated UI** (decided Sept. 17). Parity is strict on rules, payments, refusals and data. Screens come from the generated UI; what it cannot show today (a task board, an app iframe, a managers' evidence view) becomes a **generic** generated component, never a per-flow screen.
3. **Proof before flip.** Each flow gets an in-memory equivalence suite against its pure reward functions (`computeCodeAward`, `computeMlAward`, `payMajority`, `payWalkthrough`) and a Postgres integration suite on the dev database (non-destructive, own rows only). The flip is a one-line platform change once both are green.
4. **The format grows by named additions.** Each addition lands in `format/schema.ts`, the analyzer (types, shape, support gaps), the compiler, the runtime port and `conformance/CANONICAL.md` together, with a conformance case. No addition is declared `v1` before it is bound.
5. **Validation equals execution.** A capability, a node kind or an option that validates must run (P1 test: the catalog never exceeds its bindings). The same holds for every addition below.

## 1. Milestones

### P1 — Runtime bindings — **done** (Sept. 17)

`packages/interpreter/compile/bindings.ts`:
- `ai_grid` evaluates through the core `evaluate` capability. It scores on 0..1; `snapshot: history | latest` selects the `github-snapshot` or the `kaggle-artifact` source.
- `kaggle_metadata` and `github_fetch` are typed and bound.
- A test holds the catalog to its bindings.
- Verified live on the dev database.

### P2 — Asynchronous evaluation, and paying the delta

**Asynchronous evaluation** (gap D13). A gesture that reaches an `ai_grid` node does not wait for the agent:

1. The lane's preconditions run as today. Gates before the assessment still refuse synchronously (the code flow's nine `canEvaluate` reasons).
2. The engine claims the evaluation on the participation's contribution (`presentation.contribution` type) with the code flow's compare-and-set: `evaluation_status = running`, `submitted_at = now`, taken over after 30 minutes. A fresh run answers **409**.
3. It records the continuation — lane, node, serialized bindings, claim hold — in the `evaluation_runs` origin payload, under a registered evaluation handler `template.continue`. It answers **202**.
4. In the background: evaluate, store `contributions.evaluation`, then resume the lane at the node after the assessment (floor gates, rewards) with the restored bindings. Status becomes `done`, or `failed` on any throw.
5. Admin retry of a failed run replays the stored continuation. As in the code flow, it skips the preconditions and keeps the compare-and-set.

The generated UI polls the contribution while it is `running` (the overview already polls every 3 s).

**Paying the delta** (gap B3). A reward option `basis: delta`:
- **Rule.** The paid amount is `max(0, raw − already paid on this rule key to this recipient in this challenge)`, then clamped to the remaining pool.
- **Order.** Rewards run in lane order, so `fixed` before `quality`.
- **Semantics.** A clamped remainder is paid by a later run. A lower raw pays nothing and nothing is clawed back. This is exactly `computeCodeAward`.

**Proof.** A `graded-submission`-like conformance case, an equivalence suite of `basis: delta` against `computeCodeAward` (scores up and down, pool clamp, rule edits), and the continuation replayed by retry.

### P3 — `code`

- **Task board** (gap D10) — a core capability read, `board.total` and `board.done` in scope for the participation's holder. The template gates evaluation on `board.total > 0 && board.done == board.total`. Join copies the template tasks: a lane `on_join` effect `copy_board`.
- **Workspace** (gaps E14, D13 inputs):
  - Bind `github_workspace` as a join effect (branch `contrib/NNN-<slug>`, protection, `workspace_status`), written to the `challenge_teams` columns the code flow uses.
  - `own_repo`: a gesture writing `workspace_url`.
  - The evaluation's artifact is the holder's workspace URL.
- **Groups** (gap B6), compiled from `access.group`:
  - holder resolution (`pickGroupOwner`);
  - `size` and `multiplier` in scope (`1 + 0.4 × (min(n, 3) − 1)` as a param-level expression);
  - rewards to the holder's contribution, delta split into `contribution_members` shares (`splitShares`);
  - join by invite token, `onGroupJoin` re-protection.
- **Closed challenge** — join and evaluation refuse when `challenge.state == "closed"`; in-flight runs still pay.
- **Around the flow** — promotion from a sandbox keeps the `code` proposable (the template reuses it through the flow key), and the onboarding events (`evaluation.requested`, `contribution.evaluated`) are emitted by the engine's evaluation path.
- **Proof and flip** — equivalence against the code flow's services on Postgres (a real branch is not required: the provider is stubbed at the runtime port), then `code` switches to the template.

### P4 — `journey-validation`, and resource edits

- **Update and delete a resource** (gap C8) — `act: {update: {resource, set}}` and `act: {delete: {resource}}`, with guards expressed as gates. This covers the scenario steps (edit, reorder with dense renumbering, delete) and the endpoint admin deletions (unclaimed case, target without verdicts).
- **Multi-request runs** (gap D11) — a persisted run per (lane, participant, scope), resumable, whose gestures upsert keyed step results. This compiles the `multi-segment run` support gap (`flow_runs`).
- **Field permissions** (gap D12) — `fields.<f>.requires: <qualification expr>`: a non-blank value without it refuses (403); blank is always accepted.
- **Platform-role access** — `access: {mode: platform_role, roles: <expr>}`.
- **Exclusion of the author's group members** — from P3's groups.
- **Freeze** — a gate on the existence of any run.
- **Completion** — `global_feedback` required, every step answered (count gate), pay `cp_per_validation` clamped, no resolution.
- **UI** — a generic "app frame" field kind in the generated UI (`url` shown in an iframe).
- **Proof and flip** — equivalence against `scenario-walkthrough.service.ts`, then `journey-validation` switches.

### P5 — `ml`

- **First-submitter ownership** (gap C7) — compile `match_or_create` on a resource keyed by the normalized artifact URL. A reuse is recorded, never scored, paid 0.
- **Challenge-wide reads** (gap B4) — `best(<rule_key>.<meta field>, except: participation.user)` and `mine(…)` over ledger meta. This yields the beat-best condition (`takesTheLead`) and `blockThreshold`.
- **Transfers** (gap B5) — `reward: {transfer: {to, share, base, floor}}` writes a debit/credit pair that does not consume the pool. The base excludes the group bonus. The floor is `minKeepShare`. Weights come from a `list(ref(dataset))` selection (gap C9).
- **Metric** — `kaggle_metadata.metrics.<name>` from P1; `baseline` normalization in expressions.
- **Proof and flip** — equivalence against `computeMlAward` (lead changes, reuse chains, floor, clamp before splits, groups), then `ml` switches.

### P6 — `endpoint-validation` residuals

- Admin deletions (from P4).
- A managers' evidence read (inputs and responses per verdict).
- An explicit decision, with tests, on the two edge behaviors: 4xx/5xx probe responses accepted as claims, and a tie after a race resolving to `broken`.
- Then retire `endpoint-validation` for good: its remaining challenges switch to `endpoint-check` with continuity.

## 2. Order and dependencies

- P1 → P2 → P3.
- P4 needs P3's groups only for the exclusion rule; otherwise independent.
- P5 needs P2 (evaluation), P3 (groups) and P4 (runs, for the dataset selection).
- P6 needs P4.

## Out of scope

- Per-flow bespoke screens (trade-off 2).
- Rank rewards, stakes, webhooks, `spawn_challenge` and self-assessment — no hand-written flow needs them.
- Changing any rule while porting it: behavior changes are separate decisions, taken after the flip.
