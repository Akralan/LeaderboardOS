# Canonical corpus

The eleven templates of the conformance suite 0.2 (`docs/input/leaderboardos-conformance-suite-0.2-draft.md`), rewritten so that a parser reads them. The suite's YAML blocks are illustrative. Each rewrite below is a syntax decision the format had to make; none changes what a flow does. Candidates for specification 0.3.

## Syntax

| Suite 0.2 | Canonical | Why |
|---|---|---|
| `{type: enum(works, broken)}` in a flow mapping | `{type: "enum(works, broken)"}` | YAML splits an unquoted flow scalar on its comma |
| `enum` with no values (§4) | `enum(params.platforms)` | a bare enum has nothing to check against |
| `verdict == failed`, `outcome == duplicate` | `'judge.outcome == "failed"'` | enum literals are strings; a bare word is a name |
| `value: "broken"` (metric) | `value: '"broken"'` | the value is an expression |
| `access: {role: params.x}` | `access: {mode: role, role: params.x}` | every access declares its mode |
| `- else:` / `nodes:` siblings | both `else: {nodes: [...]}` and the sibling form are read | the sibling form is what YAML makes of the suite's text |

## Wiring

| Suite 0.2 | Canonical | Why |
|---|---|---|
| `created_by: [admin.expose]` (a collect) | `created_by: [admin.create_target]` | `created_by` names the creating **act**, both ways |
| `dimensions: [case, target]` | `dimensions: [self, target]` | `self` is the claimed resource; other dimensions are the claim's `scope` keys |
| `input: verdict` on an aggregate | removed | inputs are typed from the assessments that emit to it |
| `assess {kind: human}` with no fields (§6) | `from: label` | a human verdict comes from its fields or from a collect |
| `from: [take.string, submit]` | `from: submit` + `set: {string: take.string}` | `from` merges node outputs; `set` assigns a field |
| act `match_or_create: {by: declare.url}` + `link: {account: matched}` (§4) | resource-level `match_or_create: {by: url}` + `set: {account: <expr>}` | matching is a property of the resource type |
| `closure: {by: via_measure}` | `closure: {by: transition}` | closers are `aggregate`, `transition`, `admin_act` |
| `step_report.verdict` (§11) | `step_report.outcome` | `verdict` is an engine column of every resource |

## Engine behaviour written in prose

| Suite 0.2 | Canonical |
|---|---|
| `claim: {resource: item}  # engine substitutes a gold at params.gold_rate` | `claim: {resource: item, substitute: {resource: gold, rate: params.gold_rate}}`, read as `draw.substituted`, `draw.gold` |
| `over: "item where item.closed, sampled at params.audit_rate"` | `over: {resource: item, where: "item.closed", sample: params.audit_rate}` |
| `value: "inputs of agreement disagreeing with item verdict"` | `aggregates.agreement.inputs.filter(i, i.value != aggregates.agreement.verdict)` |
| `create: "item \| gold"` | a branching gate on `batch.kind` with one create per branch |
| `many: from_file(batch.file)` | `many: {from_file: batch.file}` |
| `counters: {gold_seen: "+ 1"}` | `counters: {gold_seen: {add: "1"}}` |
| `to: "rank(entry, by: …, desc)"` + `amounts:` | `amount: {mapping: rank, over: entry, by: …, order: desc, amounts: …}` |
| `amount: {mapping: tiers, tiers, input}` | adds `key` (the tier field) and `match: at_least \| equals` |
| `capability: "params.kinds[submit.kind].connector"` | `params.kinds.filter(k, k.kind == submit.kind)[0].connector` |
| `count(open(translation, t, …))` | `count(translation.filter(t, t.open && …))` |
| `check: {kind: fork_exists, of, by}`, `probe:` | flat capability arguments: `check: fork_exists`, `of:`, `by:`; `to:` for `http_proxy` |
| `states: {standard: true, close_at: …}` | `states: {close_at: …}` |

## Expression library

`size, count, exists, majority, mode, mean, min, max, has, age, int, double, string` and the list macros `map, filter, exists, all`. The syntax is CEL's; `majority`, `mode`, `mean` and `age` are not standard CEL.

## Format additions from J3

Reconciling `content/templates/data-annotation/template.yaml` with the hand-written flow needed four additions. Each one carries behaviour the flow already had in production.

| Addition | Why |
|---|---|
| `counters: {name: {type, lag: N}}` | a counter ignores the N most recently delivered claims, so a score change never points at the gold that caused it |
| `claim: {ttl: <expression>}` | a TTL can come from a param (`params.ttl_hours`), in hours |
| `ttl` on `unique_per` claims | a gold is claimed once per annotator and still expires; only `unbounded` refuses a TTL |
| `amount: {reverse: <rule_key or lane.node>}` | the exact negative of what a reward paid for each recipient's claim, net of earlier reversals (spec §3.5, clawback); aggregate inputs expose `claim` for it |

## Runtime bindings (template parity, milestone 1)

The catalog's executable half is bound in `compile/bindings.ts`; a test holds every `v1: true` capability to a binding.

| Addition | Why |
|---|---|
| `assess: {kind: ai_grid, input: [<artifact URL>, …]}` scores on **0..1** (`globalScore / 9`) | the ML flow's `agentScore`; the code flow's `score10` is `10 × score`. The first GitHub or Kaggle URL among the inputs is the artifact; the other inputs go to the agent's context |
| `assess: {kind: ai_grid, snapshot: history \| latest}` | what is graded: a GitHub branch's recent history (`github-snapshot`, the code flow — default on GitHub) or an artifact's latest state (`kaggle-artifact`, the ML flow — default on Kaggle) |
| `kaggle_metadata` output `{ref, kind, url, title, versions, metrics: {auc, f1, accuracy}}` | typed; each metric is the latest model version that reports it, `0` when none does — the ML flow's `readKaggleMetric` |
| `github_fetch` output `{slug, url, branch, commits, last_commit, last_commit_at}` | typed; up to 100 commits of the branch |
| An evaluation or observer failure refuses the gesture (`502`), without effect | a failed agent call or connector read never writes a partial run |

## Background evaluation and delta pay (template parity, milestone 2)

| Addition | Why |
|---|---|
| `assess: {kind: ai_grid, background: true}` | the code flow's evaluation: the gesture answers `202 {scheduled: true}` once every node before passed; the evaluation is claimed on the participation's contribution (one at a time, taken over after 30 minutes, `409` otherwise), runs outside the request, stores `contributions.evaluation`, then the lane resumes at the next node with the rules in force. A failed run is replayed by the flow's `continue` evaluation handler (admin retry). Top level of a user or admin lane only, no claim, nothing interactive after it |
| generated read `GET <lane>/evaluation` | `{status, running, started_at, score, evaluation, artifact_url, cp}` — what the generated UI polls; the surface marks the segment `evaluates` |
| `reward: {basis: delta}` | `computeCodeAward`: pays `max(0, round(amount) − already paid on this rule key to the recipient)`, then clamps to the pool; a clamped remainder is paid by a later run, a lower amount pays nothing, nothing is taken back. Its ledger meta carries `rawPoints` and, when clamped, `clampedTo` |
| `reward: {meta: {<key>: <expr>}}` | the ledger meta the hand-written flows write (`agentScore`); keys may be camelCase |

## Participations, workspaces and boards (template parity, milestone 3)

| Addition | Why |
|---|---|
| `entry.access.group: true` | the platform's group policy (3 members, bonus 1 / 1.4 / 1.8), compiled: the holder acts for the group — contribution, evaluation and ledger are the holder's — and the delta a gesture or a background run pays the holder is split between the members present (`splitShares`) on `contribution_members`. A custom policy expression stays a support gap |
| `participation.holder`, `participation.group.{size, multiplier, members}`, `participation.workspace.{provider, url, ref, status, ready}` | read from `challenge_teams` through the `groups` and `workspaces` capabilities; `ready` is the code flow's evaluable workspace |
| top-level `workspace: {mode: <expr>}` | the `workspaces` capability: the challenge repo at creation (`provided_repo`), the personal branch provisioned and protected at join, re-protected when a group grows, `PATCH workspace` in `own_repo` |
| `presentation.board: true`, `board.{total, done}` | the `board` capability: the template tasks copied onto each participant's (holder's) board at join, read as the holder's progress |
| `presentation.contribution.{description, deliverables}` | the contribution the code flow writes (`Global delivery for "<title>"`) and what a validation challenge can test (`deployed_app`) |
| `presentation.evaluation_handler` | the handler key a replacing template keeps (`project`); it also replays the hand-written flow's `{challengeId, userId}` runs |
| `gate: {refuse: 400, message, reason}` | the code flow's refusals: `{error: "Cannot start evaluation", reason: "tasks_not_done"}` |
| `grid: '"code"'` | a grid named by its slug literal |
| `challenge.title` | a contribution description reads it |

## Resource edits and signed-in lanes (template parity, milestone 4)

| Addition | Why |
|---|---|
| `act: {update: {resource, from, set}}` | a scenario step is renamed, rewritten or moved; `from` writes only the fields the request carried (`instructions: null` clears, absent keeps) |
| `act: {delete: <resource>}` | a step or an untouched app is removed; its guards are gates (the freeze) |
| `act: {create, upsert: {by, overwrite}}` | one walkthrough per (validator, app), returned when opened again; one step result per (walkthrough, step), overwritten on revisit — under an advisory lock on the combination |
| `resources.<type>.ordered_by: <int field>` | dense positions: create appends, an update of the field moves the instance to that index (bounded), delete renumbers |
| field `optional`, `trim`, `public` | optional comments stored `null`; a trimmed title; an app URL checked public (the core's SSRF guard) at exposure |
| `access: {mode: signed_in}` | validators walk through without joining; the platform role and qualifications are then read by gates |
| `participation.role`, `participation.qualified.<role param>` | eligible roles (`viewer` refused) and the expert opinion reserved to a qualification |
| `<resource>.id`, link `.id`, `.title`, `.members` | comparing references; excluding the author's group (`contribution_members`) |
| declared `reward.meta` | is the shape of the ledger line (`{targetContributionId, runId}`), only the natural key of a claim or resource is added |
| generated `GET mine`, `GET resources?type=` | what a participant resumes; every instance, drafts included, for a manager |

## Submitted steps, ledger reads and reuse credit (template parity, milestone 5)

| Addition | Why |
|---|---|
| top-level `submissions: {steps, selection, closed_message, evaluation_handler}` | the `submissions` capability (moved out of the ML flow): one repo per step at creation, `GET/PATCH workspace` generated with the flow's exact writes (`workspace_meta.userUrls`, `datasetUrls`, the step contribution, the implicit join), a step's `open` condition refusing a submission (403) |
| `entry: {trigger: submission, step}` | the step's lane runs in the background for the holder after a submission; leading gates run first, a refusal with a `reason` becomes the contribution's status (`skipped_reuse`), then `running`, `done` or `failed` (replayable through `evaluation_handler`) |
| `submission.lineage.{artifacts, selection}` | who first submitted each artifact, and the selected datasets weighing `1/N` — `resolveLineage` |
| `best`, `best_of_others`, `best_of_mine` | the challenge-wide best metric (blockThreshold) and the lead condition (`takesTheLead`) |
| `reward.multiplier` | the group bonus multiplies what is paid, never the base of reuse credit |
| `reward.transfers: {floor, to}` | off-pool debit/credit pairs on the (clamped) base, with the reuser's floor — `computeReuseSplits` |
| `reward.record_clamp`, `reward.label` | `rawPoints`/`clampedTo` on a clamped line; the ledger key's label |
| `optional(<type>)` in a record param, camelCase param names | `model.metric.blockThreshold`; the `reward_rules` keys the ML flow stores (`apiPackaging`) |

## Guarded deletions and managers' evidence (template parity, milestone 6)

| Addition | Why |
|---|---|
| `act: {delete: {resource, unclaimed, without_inputs}}` | an admin removes a reference case nobody claimed and a target nobody voted on — facts only the engine reads (live or delivered claims, an aggregate's inputs); refused 409 with the flow's message |
| `GET resources?type=` carries each delivered claim (`user`, `context`, `result`) | the managers' evidence view of `GET runs`: what each reviewer observed, the endpoint's answer, the verdict |
| `<lane>/file?claim_id=` open to managers | the bytes of that evidence (the endpoint's response) |
| endpoint-check quorum `count(inputs) >= required`, verdict `works` only on a strict majority | the hand-written resolution: a tie left by concurrent verdicts resolves `broken`, and a target is never stuck past its quorum |
