# LeaderboardOS

**An open format and execution model for verifiable contribution programs**

Version 0.2 — Draft — September 2026

**Changes from 0.1** — consolidation only; the execution model is unchanged. Four additions, all surfaced by writing the conformance suite and the workspace design session: the converging branch form of routing gates (Part II, §4.2); the generalized two-sided effector idempotency contract, of which Reward is now the internal special case (§3.4); slash-as-withheld-refund as the recommended stake serialization (§3.5); and the resource storage block — generic tables, the *installs-cold* conformance rule, tasks-as-resources, and the provisioned-workspace pattern (§3.2, Part VII).

---

## Part I — Why this exists

A contribution program is a structured way for strangers to do useful work and be rewarded fairly for it: a challenge, a bounty, a review process, an annotation campaign, a validation protocol. These programs are the coordination primitive of open ecosystems — and today, every platform that runs them hardcodes them. Each new kind of program is a new codebase, or a new feature branch in an old one. The programs cannot be shared, compared, audited, or reused across organizations, because they exist only as application code.

The existing landscape splits into two camps, and the interesting problem sits between them. Quest platforms verify trivial actions — follow an account, hold a token, click through a tutorial — because trivial actions are all they can verify. Grant and retroactive-funding programs handle substantial work but argue endlessly about impact after the fact, because the work was never structured for evaluation in the first place. The hard middle — structured work, evaluated against explicit criteria, rewarded from accountable pools, with every payment traceable to the exact step that authorized it — has no shared substrate.

LeaderboardOS is that substrate: an execution engine plus an open document format. A contribution program is not code; it is **data** — a graph the engine interprets. The relationship is the one between a game engine and a game, or between a workflow runtime and a workflow: the engine ships the invariant machinery, the graph declares the program.

The engine's **core** provides what every program needs and no program should redefine: identity and authentication, user profiles, groups (creation and invitations), an append-only reward ledger with its leaderboard, an AI evaluation agent invocable against structured grading grids, external notifications, and the standard pages (profile, leaderboard, program listing). A **challenge template** — a single document in the format specified here — declares everything else: who may enter and how, what gets submitted, what the system does with it, how it is assessed, how consensus forms, what gets paid, and what everyone is allowed to see at each moment.

The format was not designed in the abstract. It was extracted from a production platform running four kinds of programs for medical AI — machine-learning challenges, code challenges, human clinical validation with quorum verdicts, and contributor-proposed sandbox projects — then stress-tested against six foreign flows chosen to pull on every part of the model: bug bounties, data annotation campaigns, localization pipelines, design contests, staked grant review, and developer onboarding. The vocabulary survived all eleven without gaining a single node family. That is the evidence this draft rests on.

Five commitments shape every decision in this document:

1. **A small, closed vocabulary.** Ten node families express all eleven reference flows. Extension happens through versioned core capabilities, never through arbitrary code embedded in graphs.
2. **Static verifiability.** A template can be fully validated before publication: every wire, every expression, every capability use is checked against declared types. A published template cannot fail in ways the editor could have caught.
3. **Transactional locality.** A node boundary is a transaction boundary. Nothing larger is ever promised atomic, so the runtime needs no sagas, no compensation, no distributed coordination.
4. **Total accountability.** Every ledger entry carries full provenance: the participation, the run, the node, and the resource that produced it. Points are minted with pools and burned explicitly; the entire system reconciles by summation.
5. **Immutability, hence anchorability.** Published template versions are immutable; instantiated challenges execute a resolved snapshot. Provenance that points into an immutable graph is provenance that can be cryptographically anchored.

---

## Part II — The vocabulary

### Two graphs, one template

A template describes two graphs at different levels. The **lifecycle graph** is the envelope: the challenge's states (draft, open, closed), its shared resources, its aggregates, and the transitions between them. The **participation flow** is the program: the sequence of steps a contributor traverses, potentially many times. The visual editor edits participation flows; the lifecycle is a standard parameterized envelope in v1. Most quest platforms model only a degenerate form of the second graph and nothing of the first; the split is where most of this format's expressive power comes from.

### Node families

**Trigger** — what starts a run: a user action, an admin action, a cron schedule, or an external webhook. Every lane begins with exactly one.

**Access** — who may enter: open, author-only, or role-gated, with group configuration as parameters. Access is a property of an *entry point*, not of the challenge — which is what allows several kinds of actors to coexist in one graph.

**Collect** — typed data enters the system: a repository URL, a platform artifact, a form, a multipart file upload. Each Collect carries a field schema; the platform generates its UI from that schema. This is the entire UI story for flows in v1 — schema-driven screens hosted in the core's shell, no per-challenge frontend code.

**Act** — the system does something. **Observers** read the external world (proxy an HTTP call, fetch artifact metadata, verify an action happened on a third-party API); they are repeatable and fail as retryable no-ops. **Effectors** write to the external world or to the core (send a notification, write the ledger, provision a workspace); they execute under a two-sided idempotency contract (§3.4). A third kind, **grants**, modifies visibility (§3.3).

**Assess** — a judgment is produced: an AI evaluation against a structured grid, a human verdict, an external metric, or a formative self-evaluation that gates nothing and pays nothing. Each Assess declares whether it gates downstream progress.

**Aggregate** — reduces inputs from many participations into one decision: a quorum of verdicts resolved by majority, an inter-annotator agreement, a jury ranking. Aggregates live in the lifecycle graph, attach to a resource, and may cap inputs per participation.

**Gate** — a blocking precondition expressed over the run's context: a score threshold, an eligibility rule, a role check. A refused gate is a modeled outcome, not an error (§3.4). A gate may also take its **branching form** — the format's only routing construct: mutually exclusive `when` branches plus an `else`, whose sub-sequences converge to the node that follows the gate (possibly the lane's end). Branches route; they never fork parallel execution, and convergence is checked statically (§4.2).

**Reward** — points move: a source pool, a mapping (continuous score-to-points, admin-defined tiers, or a fixed amount), conditions (majority side only, clamped to remaining pool, earliest first), and modifiers (a group multiplier). Reward is an internal effector and inherits effector semantics wholesale (§3.5).

**Transition** — state changes: the challenge's lifecycle states, or the permanent resolution of a resource.

**Link** — cross-graph composition, always **by reference**: a template declares a dependency on another challenge's artifacts by identifier, and **spawn** creates a new challenge from a template with parameters and an automatic join — never by wiring pins between two live graphs.

### The node-versus-parameter rule

A concept is promoted to a node family only if at least two reference flows use it at *different positions* in a graph. Everything else is a parameter. The group multiplier is a parameter of Reward; quorum is a node family (Aggregate) because consensus recurs in unrelated positions across flows. This rule is what keeps the vocabulary closed.

---

## Part III — The execution model

### 3.0 Four layers of state

Everything a graph can read or write lives in exactly one of four layers, ordered by scope. The **run context** is ephemeral and statically typed: the data accumulated during one traversal of a flow. **Participation counters** are durable and private to one participation: named scalars written by Assess and Aggregate nodes, read by Gates and Rewards. **Resources** are the challenge's shared state — the *only* shared layer: anything two participations must both see goes through a resource. The **core** is global and reachable exclusively through the contractual interface of §3.6. No other channel exists.

### 3.1 Participations and runs

A **participation** is durable: identity, group membership, links to claimed resources, counters. A **run** is one traversal of a participation flow, and it is repeatable — a reviewer's claim is a run, an ML submission is a run, a resubmission is a *new* run. This split has a structural consequence: lanes are strict DAGs. Iteration never appears as a cycle in the graph; it appears as another run. The engine needs no loop detection.

The **run context is typed statically**. Its schema is derived at edit time from the lane's Collect and Act nodes, which means a template is verifiable before publication: a gate reading a field never collected, a reward with no source, an expression referencing a nonexistent counter, a miswired emit — all are editor-time errors, in the way a typed pin refuses a mismatched wire. Static verifiability is a design commitment (Part I), and the typed context is its foundation.

**Counters** are the flow's working memory about a participation — an annotator's accuracy on gold cases, a reviewer's throughput. They are local to the challenge by design. The canonical global reputation is the core's point ledger; if a deployment ever needs a custom cross-challenge reputation, that is a core evolution, not a graph feature.

### 3.2 Resources

A resource **type** declares a field schema, per-field visibility policies, and a claim mode. Resource **instances** are created by nodes — and this single mechanism covers what looks like two different worlds. When the creating node sits in an admin lane, resources are *pre-declared* (validation targets, ground-truth cases). When it sits in a contributor lane behind a **match-or-create**, resources are *emergent*: the submission searches by an exact key or by a human routing decision, attaches to the existing instance if found, creates it otherwise — which is precisely how a bug report either becomes a new vulnerability or a duplicate of one, and how a shared social-media account accumulates attributable posts. Batch import is not special either: a Collect of a file followed by an Act creating N instances.

Four **claim modes** cover all eleven reference flows:

- `exclusive` — one participation at a time (a string being translated)
- `k_bounded` — at most k concurrent claims (an annotation item with redundancy k)
- `unique_per(dimensions)` — one claim per combination (one claim per case *and* target; one verdict per validator *and* target)
- `unbounded` — shared read access (a shared brand account)

Claims in `exclusive` and `k_bounded` modes may declare a **TTL**, released by the engine on expiry. This is the only timer in the entire runtime; no template ever schedules its own cleanup.

Resources are also the **inter-lane channel — exclusively**. A translator lane does not "send" anything to a reviewer lane; it creates a translation resource, which the reviewer lane claims and assesses. Admin oversight (reading every run, every evidence byte) is not a lane flow at all: it is privileged read access provided by the core, outside the graph.

Lifecycle is deliberately minimal: a resource is **open** or **closed**, with an optional verdict, closed by an Aggregate resolving, by a challenge Transition (closing the challenge closes its open resources), or by an admin Act. Finer-grained states are derived from claims; there are no per-resource custom state machines in v1.

**Generic storage — the installs-cold rule.** What looks like "this flow needs a database table" is a resource type declared in the template. Logically it lives in the document; physically it lives in the engine's *generic* tables — one for resource instances (typed payload validated on write against the template's schema, plus the columns the engine itself reads: type, state, verdict, creator), one for claims, where the transactional invariants of the claim modes are enforced with database constraints rather than payload inspection. Hardcoded schema is reserved for what the core must understand: identity, groups, ledger, challenges, participations, runs. The rule this yields is a conformance requirement: **a template can never require a migration** — a third-party template installs cold on a running engine. Dynamic DDL would have broken both this and the immutability commitments of §4.3. One consequence worth naming: *tasks are not an engine concept.* A claimable unit of work with a TTL and a completion verdict — an annotation item, a string to translate, a report to triage — is exactly a resource with a claim mode. The task abstraction is declared, not built.

**Named pattern: the provisioned workspace.** Some flows need an external working space per participant — a branch in an ecosystem repository, a forked notebook, a group channel, a compute environment. The pattern: a resource holding a *handle* (never a mirror — canonical state stays external, read by observers at the moment it matters), claimed `unique_per(participation)`, created by an effector Act with `match_or_create` by participation, whose capability is create-or-get by natural key (§3.4):

```yaml
resources:
  workspace:
    fields: {branch: {type: string}, url: {type: url}}
    created_by: [contributor.provision]
    claim: {mode: unique_per, dimensions: [participation]}
lanes:
  - id: contributor
    nodes:
      - act: {id: provision, kind: effector, capability: github_workspace,
              repo: params.repo, match_or_create: {by: participation}}
      - act: {id: fetch, kind: observer, capability: github_fetch,
              ref: workspace.branch}
```

Provisioning is lazy at first run and idempotent by construction: no phantom workspaces for inactive joiners, and every evaluation run re-passes `provision`, which no-ops once the workspace exists. Evaluation stops needing hand-pasted URLs — the participation knows its workspace, and the observer fetches its live state when assessment triggers. Groups come free, since the workspace is per *participation* and a group is one. External permissions (repository invitations, branch protection) belong to the capability, not the engine: internal visibility and external ACLs are two systems, never conflated. There is no bidirectional sync and no `on: participation.created` trigger — laziness makes the hook unnecessary.

### 3.3 Visibility

Visibility is a policy on data, in two forms. **Static policies** are declared per field on resource types: who can read this field, expressed against roles and relationships (author, claimant, admin). **Dynamic grants** are performed by grant-kind Acts at a precise position in a flow: a "reveal" is nothing but a visibility grant to the current participation, placed after the node that must precede it. Aggregates additionally declare the visibility of their own running state — a participation count may be public while the tally split is admin-only. Fields with an empty static policy are unreadable by anyone until granted, *by construction*: there is no route that could serve them early.

### 3.4 Transactions and errors

Execution is **synchronous by segment**. The engine is purely reactive — nothing runs outside a trigger. A segment spans from a trigger to the next interactive node or to a terminal, and executes inside the triggering request itself: no queue, no workers in v1. The run persists between segments; a crash mid-segment has written nothing, and a repeated gesture resumes cleanly.

**A node boundary is a transaction boundary — and nothing more ever is.** No multi-node sequence is promised atomic, so the runtime contains no rollback and no compensation. If two effects must be atomic, they are *one node*; this is a design constraint on graphs, not machinery in the engine. A claim-and-probe is one Act precisely so that no abandoned intermediate state can exist.

Every node execution has one of **three outcomes**. **Success**: effects committed, the run advances. **Refusal**: a deterministic answer of the model in the current state — a failed gate, a lost uniqueness race, a closed resource. **Error**: a transient failure — timeout, upstream 5xx, contention. Refusals and errors are both total no-ops, but they are semantically different, and the generated UI renders them differently without per-template work: a business message versus "try again." Races resolve through declared constraints — the loser of a simultaneous claim receives a clean refusal, never a 500.

Acts split into **observers** (read the external world; repeatable; failure is a retryable no-op) and **effectors** (write to the external world or the core). Effector idempotency is a **two-sided contract**. Engine side: every effector executes under the key `(run, node)`; a committed effect is never re-fired — at-most-once from the engine's view. Capability side: a crash *between* the external call and the local commit is unresolvable by the engine alone, so any capability that creates external objects must be **create-or-get by a natural key** derivable from its inputs (a branch name from the participation, a spawned challenge from template-plus-source). Engine-side at-most-once plus capability-side create-or-get yields effective exactly-once against non-transactional external systems. Reward is the *internal* special case: the ledger write commits transactionally with the run itself, so `(run, node)` alone suffices. Trigger deduplication follows the same economy of means: user triggers dedupe through run advancement (a waiting run accepts one answer; a double submit is a refusal) plus declared uniqueness; cron triggers get an engine-managed persistent cursor; webhooks dedupe on the external event id within a window.

One race deserves explicit semantics: the final input of an Aggregate. The Aggregate resolves *transactionally with* the input that reaches quorum; resource closure then acts as an implicit gate for late arrivals, and commit order provides the earliest-first ordering that conditional payment needs.

### 3.5 The ledger

A ledger entry is `(participation, signed amount, rule_key, provenance)`, where provenance is the run, the node, and optionally the resource that produced it. A balance is a sum. The entire block is mechanical because **Reward is an internal effector**: same idempotency key `(run, node)`, same at-least-once semantics — hence no double payment is possible, with zero mechanism beyond what §3.4 already established.

A **pool** is not an account. Remaining pool is *derived*: initial allocation minus the sum of entries referencing it, never stored. Clamping and earliest-first ordering fall out of the Aggregate's transactional resolution.

Signed amounts admit exactly three negative cases, each with its own rule. A **stake** is a voluntary debit at entry, refused (a refusal, not an error) if the balance is insufficient. A **slash** is bounded by the stake that backs it, and is burned in v1 — with **withheld refund** as the recommended serialization: the aggregate accumulates a `slashed` counter and the closing refund pays `stake − slashed`, so the per-participation entries `−stake, +(stake − slashed)` net to exactly the burn. Structurally incapable of exceeding the escrow, with no explicit negative entry; the explicit-negative form remains valid for deployments that want visible slash entries. A **clawback** is the exact negative of a past reward — the anti-gaming instrument for high-volume flows: pay fast, sample-audit, reclaim on failure. Clawback alone may drive a balance negative; involuntary debt is accepted deliberately, otherwise spending fast would be an escape hatch from audits.

Accounting is total: points are minted when a pool is funded and burned explicitly; the whole system reconciles by summation. Append-only entries with full provenance into immutable graphs make periodic cryptographic anchoring (a Merkle root of ledger plus template) a deployment choice, not a redesign.

### 3.6 The core interface

A graph touches the core only through **capabilities**: declared, typed, versioned. A template states `requires: {core: N}` in its header, and static validation checks every capability use against that version's contract.

The complete surface for the eleven reference flows — reads: identity and roles (Access), group composition (Reward's multiplier), point balance (a stake's precondition); writes and invocations: the ledger (Reward, stake), the evaluation agent (grid-based Assess), external notification (effector), external workspace provisioning (create-or-get by natural key; §3.2), and challenge spawn (Link: template, parameters, automatic join of a designated participant — itself under the create-or-get contract of §3.4).

The evaluation agent is invoked synchronously within the segment by default; a grid too heavy for one request is structured as two segments joined by a cron trigger — the model already permits it, no queue needs inventing. This contract is also the **extension hinge of the open format**: extending the system means adding versioned core capabilities, never embedding arbitrary code in graphs. The provided pages (profile, leaderboard, listing) consume the core directly; the generated flow UI slots into that shell.

---

## Part IV — The serialization format

### 4.1 Expressions: a CEL subset

Conditions and formulas — `score >= 7.0`, `1.0 + 0.3 * (size(group.members) - 1.0)` — are written as text expressions in a restricted subset of **CEL** (Common Expression Language). Three reasons, in order of weight. **Security**: the engine will execute third-party templates, which demands guaranteed termination and zero side effects; CEL provides both by construction, where sandboxed JavaScript is a permanent attack surface. **Typing**: CEL is statically typed, so every expression is checked at edit time against the run context's schema — the static verification of §3.1 extends to expressions for free. **Credibility**: CEL is the industry standard for exactly this job (Kubernetes policies, Firebase rules), not a bespoke syntax to be audited from scratch.

The subset is fixed by this spec: arithmetic, comparisons, boolean logic, field access, `has`, `size`, and list `filter`/`map` — no macros beyond these, no custom functions outside the declared aggregate builtins (`count`, `majority`). The visual editor serializes to CEL the way a blueprint editor serializes its pins.

### 4.2 Document structure

One document is one challenge template. Everything is inline — lifecycle, lanes, resource types, counters, parameter declarations — with a single exception: **evaluation grids** are separate documents referenced by `id` and `version`, because they are already self-contained JSON artifacts and they form the reusable library across challenges.

```yaml
format: leaderboardos/1
template: {id, version, name, summary}
params:      # declared, typed, each marked mutable: true|false
requires:    {core: 1}
resources:   # types: fields, visibility, claim mode, creation, closure
counters:    # named scalars at participation level
lifecycle:   # states, aggregates, transitions
lanes:       # [{entry: {trigger, access}, nodes: [...]}]
```

Two properties of the model make serialized documents unusually legible. The three-outcome semantics of §3.4 removes error branches entirely: success flows to the next node, refusal and error have engine-standard behavior, so only genuine business routing ever branches — a serialized lane is quasi-linear, readable top to bottom, diffable in review. And the run/participation split of §3.1 makes lanes strict DAGs: no cycles exist to serialize.

Business routing serializes as the gate's branching form — and only there:

```yaml
- gate:
    id: kind
    branch:
      - when: "draw.is_gold"
        nodes: [...]          # sub-sequence
      - else:
        nodes: [...]
```

Branches converge to the node that follows the gate (possibly the lane's end); the validator rejects anything else. This is the entire routing story of the format.

### 4.3 Versioning: three levels

The **format** version (`leaderboardos/1`) follows semver on the document schema. **Published template versions are immutable**: to change a template is to publish a new version — append-only to the end. **Instantiation resolves a snapshot**: a challenge freezes the full template, referenced grids included, lockfile-style; only parameters explicitly declared `mutable` (a tier amount, a date) may change on a live challenge — structure, never.

The decisive argument is not caution. Ledger provenance points at `(run, node)` — it is meaningful only if the referenced graph can never change under it. Immutable snapshots are simultaneously what makes anchoring honest: the graph and the ledger it explains can be committed together.

---

## Part V — Canonical example: endpoint validation

This is the flow that exhibits nearly the entire model in one graph: three actor kinds, role-gated entry, enforced ordering, an atomic external probe, hidden-until-granted data, quorum resolution, and conditional pool payment. It is presented in full; the abridged counterpoints of Part VI show what it does *not* exercise.

The protocol, in one paragraph: qualified reviewers verify that a deployed submission from a source challenge actually works — not by improvising a test, but against ground-truth reference cases authored by *other* qualified reviewers. A reviewer claims a case against a target; the engine calls the live endpoint with the case's input; the reviewer records what they observed *before* being allowed to see the expected output; only then do they vote works or broken. At quorum, majority wins, and only the majority side is paid.

```yaml
format: leaderboardos/1

template:
  id: endpoint-validation
  version: 1.0.0
  name: Endpoint validation
  summary: >
    Qualified reviewers verify deployed submissions from a source challenge
    against peer-authored ground-truth cases, under quorum.

params:
  pool:                 {type: points, mutable: false}
  cp_per_validation:    {type: points, mutable: false}
  required_validations: {type: int, check: "value % 2 == 1", mutable: false}
  source_challenge:     {type: challenge_ref, mutable: false}
  reviewer_role:        {type: role, mutable: false}

requires: {core: 1}

resources:
  target:
    fields:
      contribution:  {type: link, from: params.source_challenge}
      endpoint_url:  {type: url, visibility: [admin, role(params.reviewer_role)]}
    created_by: [admin.expose]
    closure: {by: aggregate, verdict: [works, broken], permanent: true}

  reference_case:
    fields:
      input:            {type: file, visibility: [author, admin]}
      expected_output:  {type: file, visibility: []}     # grant-only (§3.3)
    created_by: [author.submit_case]
    cardinality: {exactly: params.required_validations}
    claim:
      mode: unique_per
      dimensions: [case, target]

lifecycle:
  states: standard          # draft → open → closed envelope
  aggregates:
    - id: quorum
      over: target
      input: verdict         # emitted by the reviewer lane
      per_participation: 1   # one verdict per validator per target
      resolve:
        when:    "count(inputs) == params.required_validations"
        verdict: "majority(inputs.map(i, i.verdict))"
        then:
          - transition: {resource: target, to: closed}
          - reward:
              to:     "inputs.filter(i, i.verdict == verdict)"
              amount: params.cp_per_validation
              pool:   params.pool
              order:  commit_time        # earliest first
              clamp:  pool
      state_visibility:
        count: everyone      # "3/5 validations received"
        split: admin         # live works/broken tally

lanes:
  - id: admin
    entry: {trigger: admin}
    nodes:
      - collect:
          id: expose
          fields:
            contribution: {type: link, from: params.source_challenge}
            endpoint_url: {type: url}
      - act: {id: create_target, create: target, from: expose}

  - id: author
    entry:
      trigger: user
      access: {role: params.reviewer_role}
    nodes:
      - collect:
          id: submit_case
          fields:
            input:           {type: file}
            expected_output: {type: file}
      - act: {id: create_case, create: reference_case, from: submit_case}

  - id: reviewer
    entry:
      trigger: user
      access: {role: params.reviewer_role}
    nodes:
      - collect:
          id: pick
          fields:
            target: {type: ref(target), where: "target.open"}
            case:   {type: ref(reference_case)}
      - gate:
          id: eligibility
          all:
            - "pick.case.author != participation.user"
            - "pick.target.contribution.author != participation.user"
      - act:
          id: probe
          kind: observer
          claim: {resource: pick.case, scope: {target: pick.target}}
          capability: http_proxy       # SSRF-guarded, engine-provided
          send:  pick.case.input
          to:    pick.target.endpoint_url
          store: response              # raw bytes into run context
      - collect:
          id: observation
          fields: {text: {type: string}}
      - act:
          id: reveal
          kind: grant
          grant: {field: pick.case.expected_output, to: participation}
      - assess:
          id: verdict
          kind: human
          fields:
            verdict:     {type: enum(works, broken)}
            description: {type: string}
          emit: {to: lifecycle.quorum, scope: pick.target}
```

What this single document exhibits:

- **Three actors, one graph.** Access lives on entry points, so an admin lane, an authoring lane, and a reviewing lane coexist without any actor concept in the challenge itself.
- **Ordering by structure, not by checks.** The production system this was extracted from enforces observation-before-reveal with a server-side 409. Here the guarantee is *structural*: the reveal node sits after the observation Collect in a linear lane, and the engine only moves forward. The class of bug is unrepresentable.
- **Claim and probe are one Act** — one transaction boundary, so no abandoned claim state can exist. A network failure is a retryable no-op; a lost claim race is a clean refusal; both fall out of §3.4 with no per-template handling.
- **Hidden until granted.** `expected_output` has an empty visibility policy; the only path to those bytes is the grant node, which cannot be reached out of order.
- **Quorum with honest edges.** Resolution commits transactionally with the final verdict; late verdicts hit a closed resource and refuse; commit order yields earliest-first payment under the pool clamp; the running count is public while the split is admin-only.
- **Reward as internal effector.** `(run, node)` idempotency makes double payment impossible — the ledger inherits transaction semantics rather than adding any.

---

## Part VI — Counterpoints (abridged)

Two foreign flows, reduced to the fragments that exercise what validation does not. The full eleven-flow suite (ten templates) is published as the companion conformance document.

### Data annotation with gold cases

Exercises: `k_bounded` claims with TTL, participation counters, counter-weighted reward, counter-gated access.

```yaml
resources:
  item:
    fields: {payload: {type: json, visibility: [claimant]}}
    claim: {mode: k_bounded, k: 3, ttl: 48h}
  gold:
    fields:
      payload:  {type: json, visibility: [claimant]}
      expected: {type: json, visibility: []}       # the reveal pattern, again
counters:
  gold_accuracy: {type: ratio}
```

The engine interleaves gold cases into the claim stream at a template-declared rate; an Assess compares the annotator's judgment to the revealed expected value and writes `gold_accuracy`. Reward per unit is `params.per_unit * counters.gold_accuracy`; a gate `counters.gold_accuracy >= 0.8` protects sensitive item classes. Abandoned claims return to the pool by TTL — the engine's only timer, doing the one job it exists for. Clawback (§3.5) is the natural audit instrument at this volume.

### Staked grant review

Exercises: stake at entry, consensus with slashing, negative ledger entries.

```yaml
lanes:
  - id: reviewer
    entry:
      trigger: user
      access:
        stake: {amount: params.review_stake}   # ledger debit; refusal if balance is short
```

Reviews aggregate to consensus; aligned reviewers earn from the pool, deviant reviewers are slashed — bounded by their stake, burned in v1. The entry stake is a voluntary debit and therefore a refusal when the balance is insufficient, per §3.5; nothing about web3-style skin-in-the-game required new machinery.

---

## Part VII — Conformance, extension, non-goals

**Conformance.** An implementation conforms if it interprets all ten node families with the execution semantics of Part III — four state layers, three outcomes, node-boundary transactions, the two-sided effector contract, derived pools, signed-entry rules — enforces static validation as specified in §3.1 and §4.1 (branch convergence included), stores resources generically so that **any valid template installs cold, never requiring a migration** (§3.2), and passes the eleven-flow conformance suite (five founding flows, six foreign ones — ten templates), published as a companion document.

**Extension.** The format is extended in exactly one way: new core capabilities, typed and versioned behind `requires`. Templates never embed executable code; expressions never exceed the fixed CEL subset. A capability proposal specifies its reads, writes, failure semantics under §3.4, and the core version introducing it.

**Non-goals of this draft.** The visual editor is a product built on this format, not part of it. A reference interpreter is a subsequent milestone, not a normative artifact of v0.1. Custom cross-challenge reputation is a core evolution (§3.1), deliberately out of the graph model. On-chain anchoring is a deployment concern: the ledger and template model are anchorable by construction (§3.5, §4.3), and this spec stops exactly there.
