# LeaderboardOS Conformance Suite

**Eleven founding flows, ten templates — and a post-corpus addendum**

Version 0.2 — Draft — September 2026

**Changes from 0.1** — aligned with specification 0.2, where both refinements from this suite's closing note are now normative; adds the post-corpus addendum (§11, `journey-validation`). Running total: twelve flows, eleven templates, zero node families added.

---

## How to read this document

This suite is the executable half of the specification's central claim: that a small, closed vocabulary expresses real contribution programs across unrelated domains. Each section is one challenge template — a complete, valid `leaderboardos/1` document — followed by a short **Exercises** note stating which parts of the execution model it stresses. An implementation conforms if it can validate and execute all eleven templates — reference corpus and addendum — with the semantics of the specification's Part III.

The corpus is the eleven reference flows: the five founding flows extracted from the production medical-AI platform (ML challenges, code challenges, endpoint validation, sandbox projects, social amplification) and the six foreign flows chosen to pull on every remaining part of the model (bug bounty, data annotation, localization, design contest, staked grant review, developer onboarding).

The headline result is in the arithmetic: **eleven flows, ten templates**. The founding ML and code challenges turn out to be two instantiations of a single template — a conformance finding in itself, since it demonstrates that the parameterization layer, not just the node vocabulary, carries real expressive weight. And across all ten templates, **zero node families were added** beyond the specification's ten.

A convention used throughout: node lists are quasi-linear per the specification's §4.2 — only routing gates branch, and refusal/error paths are never serialized because their behavior is engine-standard.

---

## 1. `graded-submission` — the founding pair

Contributors self-organize on the full challenge scope, submit typed artifacts at will, trigger their own evaluation, and drain a shared pool as a function of AI-graded quality. This is the nominal path of the whole system — and it is *one* template: the founding `ml` and `code` challenges are two instantiations of it (see the note after the document).

```yaml
format: leaderboardos/1

template:
  id: graded-submission
  version: 1.0.0
  name: Graded submission challenge
  summary: >
    Typed artifacts, self-triggered AI evaluation, pool-draining rewards,
    optional group participation.

params:
  pool:      {type: points, mutable: false}
  rate:      {type: number, mutable: true}       # points per grade point
  min_score: {type: number, mutable: true}
  kinds:                                          # the connector/grid table
    type: list({kind: string, connector: capability, grid: grid_ref})
    mutable: false
  group:
    type: {max_size: int, multiplier: expr}
    mutable: false

requires: {core: 1}

resources:
  contribution:
    fields:
      kind:     {type: string}
      url:      {type: url}
      metadata: {type: json,   visibility: [author, admin]}
      score:    {type: number, visibility: [author, admin]}
    created_by: [contributor.register]

lanes:
  - id: contributor
    entry:
      trigger: user
      access: {mode: open, group: params.group}
    nodes:
      - collect:
          id: submit
          fields:
            kind: {type: enum(params.kinds.map(k, k.kind))}
            url:  {type: url}
      - act:
          id: fetch
          kind: observer
          capability: "params.kinds[submit.kind].connector"
          store: metadata
      - act: {id: register, create: contribution, from: [submit, fetch]}
      - assess:
          id: grade
          kind: ai_grid
          grid: "params.kinds[submit.kind].grid"
          input: [submit.url, fetch.metadata]
      - gate: {id: floor, all: ["grade.score >= params.min_score"]}
      - reward:
          id: pay
          amount: >
            params.rate * grade.score
            * (1.0 + 0.3 * (size(group.members) - 1.0))
          pool: params.pool
          clamp: pool
```

**The two founding instantiations.** `ml`: `kinds = [{model, kaggle_metadata, grid:model@1}, {dataset, kaggle_metadata, grid:dataset@1}, {api_packaging, github_fetch, grid:api_packaging@1}]`. `code`: `kinds = [{repo, github_fetch, grid:code@1}]`. Same graph, different connector/grid tables — the unified challenge model, expressed as data.

**Exercises:** the nominal path (trigger → collect → observer → ai_grid → reward); group multiplier read from the core's group composition inside a CEL expression; resubmission-as-new-run; mutable live parameters (`rate`, `min_score`) on an immutable structure; the parameterization layer as a genuine axis of reuse.

---

## 2. `endpoint-validation` — the canonical stress test

Reproduced verbatim from the specification's Part V, where it is walked through in full; it is listed here so the suite is self-contained. Qualified reviewers verify deployed submissions from a source challenge against peer-authored ground-truth cases, under quorum, with majority-only payment.

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
      expected_output:  {type: file, visibility: []}     # grant-only
    created_by: [author.submit_case]
    cardinality: {exactly: params.required_validations}
    claim:
      mode: unique_per
      dimensions: [case, target]

lifecycle:
  states: standard
  aggregates:
    - id: quorum
      over: target
      input: verdict
      per_participation: 1
      resolve:
        when:    "count(inputs) == params.required_validations"
        verdict: "majority(inputs.map(i, i.verdict))"
        then:
          - transition: {resource: target, to: closed}
          - reward:
              to:     "inputs.filter(i, i.verdict == verdict)"
              amount: params.cp_per_validation
              pool:   params.pool
              order:  commit_time
              clamp:  pool
      state_visibility:
        count: everyone
        split: admin

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
          capability: http_proxy
          send:  pick.case.input
          to:    pick.target.endpoint_url
          store: response
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

**Exercises:** three actor kinds in one graph via entry-point access; structural ordering (observation-before-reveal as lane sequence, not a server check); claim carried by an Act, making claim-and-probe one transaction; grant-only field visibility; quorum resolving transactionally with its final input; earliest-first conditional payment under a pool clamp; blind-count aggregate state visibility.

---

## 3. `sandbox-project` — author scope, tiers, and promotion

```yaml
format: leaderboardos/1

template:
  id: sandbox-project
  version: 1.0.0
  name: Sandbox project
  summary: >
    A contributor proposes and works on their own project. Admin-defined
    star-tier milestones pay from the pool; self-evaluation is formative;
    promotion spawns an official challenge and auto-joins the author.

params:
  pool:                {type: points, mutable: false}
  promotion_templates: {type: list(template_ref), mutable: false}
  self_grids:          {type: {code: grid_ref, ml: grid_ref}, mutable: false}

requires: {core: 1}

resources:
  project:
    fields:
      title:       {type: string}
      kind:        {type: enum(code, ml)}
      description: {type: string}
      repo_url:    {type: url}
    created_by: [creator.open_project]
    closure: {by: [admin_act, transition], verdict: [promoted, archived]}
  milestone:
    fields:
      project:  {type: ref(project)}
      tier:     {type: int}
      criteria: {type: string}
      points:   {type: points}
    created_by: [milestones.define]
    closure: {by: admin_act, verdict: [reached]}

lanes:
  - id: creator
    entry: {trigger: user, access: {mode: open}}
    nodes:
      - collect:
          id: propose
          fields:
            title:       {type: string}
            kind:        {type: enum(code, ml)}
            description: {type: string}
            repo_url:    {type: url}
      - act: {id: open_project, create: project, from: propose}

  - id: self_review
    entry: {trigger: user, access: {mode: author_of, resource: project}}
    nodes:
      - assess:
          id: formative
          kind: self
          grid: "params.self_grids[project.kind]"
          gating: false            # feedback only: no emit, no reward

  - id: milestones
    entry: {trigger: admin}
    nodes:
      - collect:
          id: define
          fields:
            project:  {type: ref(project)}
            tier:     {type: int}
            criteria: {type: string}
            points:   {type: points}
      - act: {id: create_tier, create: milestone, from: define}

  - id: award
    entry: {trigger: admin}
    nodes:
      - collect: {id: review, fields: {milestone: {type: ref(milestone), where: "milestone.open"}}}
      - act: {id: settle, transition: {resource: review.milestone, to: closed, verdict: reached}}
      - reward:
          id: tier_pay
          to: review.milestone.project.author
          amount: review.milestone.points
          pool: params.pool

  - id: promote
    entry: {trigger: admin}
    nodes:
      - collect:
          id: pick
          fields:
            project:         {type: ref(project), where: "project.open"}
            template:        {type: enum(params.promotion_templates)}
            instance_params: {type: json}
      - act:
          id: spawn
          kind: effector
          capability: spawn_challenge
          template: pick.template
          params: pick.instance_params
          auto_join: pick.project.author
      - act: {id: close, transition: {resource: pick.project, to: closed, verdict: promoted}}
```

**Exercises:** open entry for creation but author-scoped entry for subsequent work; formative self-assessment (an Assess that emits nothing and pays nothing); tier rewards as admin-created resources rather than a bespoke mechanism; the `spawn_challenge` capability with auto-join (Link in its effector form); and **closure-as-lock**: `settle` before `tier_pay` means two concurrent award attempts race on the transition, the loser refuses, and no double payment can occur — transaction ordering doing the work a lock would.

---

## 4. `social-amplification` — attribution through shared resources

```yaml
format: leaderboardos/1

template:
  id: social-amplification
  version: 1.0.0
  name: Social amplification
  summary: >
    Contributors publish on shared brand accounts and declare their posts;
    the engine verifies the account, waits out a maturation window,
    measures engagement, and pays by tier.

params:
  pool:            {type: points, mutable: false}
  platforms:       {type: list(enum(instagram, x, linkedin)), mutable: false}
  maturation_days: {type: int, mutable: true}
  tiers:           {type: list({min_engagement: number, points: points}), mutable: true}

requires: {core: 1}

resources:
  account:
    fields:
      platform: {type: enum(params.platforms)}
      handle:   {type: string}
      notes:    {type: string, visibility: [admin]}
    created_by: [accounts.register]
    claim: {mode: unbounded}
  post:
    fields:
      url:     {type: url}
      account: {type: ref(account)}
      metrics: {type: json, visibility: [author, admin]}
    created_by: [contributor.register]
    match_or_create: {by: url}       # redeclaring a URL attaches, never duplicates
    closure: {by: via_measure, verdict: [measured]}

lanes:
  - id: accounts
    entry: {trigger: admin}
    nodes:
      - collect: {id: register_account, fields: {platform: {type: enum}, handle: {type: string}}}
      - act: {id: create_account, create: account, from: register_account}

  - id: contributor
    entry: {trigger: user, access: {mode: open}}
    nodes:
      - collect: {id: declare, fields: {url: {type: url}}}
      - act:
          id: resolve
          kind: observer
          capability: social_metadata      # platform, handle, post age
          store: meta
      - gate:
          id: ours
          all:
            - "exists(account, a, a.platform == resolve.meta.platform && a.handle == resolve.meta.handle)"
      - act:
          id: register
          create: post
          match_or_create: {by: declare.url}
          link: {account: matched}

  - id: measure
    entry:
      trigger: cron
      schedule: daily
      over: "post where post.open && age(post) >= params.maturation_days"
      cursor: engine
    nodes:
      - act: {id: fetch, kind: observer, capability: social_metadata, store: metrics}
      - assess: {id: reach, kind: metric, value: "fetch.metrics.engagement"}
      - reward:
          id: tier_pay
          to: post.author
          amount: {mapping: tiers, tiers: params.tiers, input: reach.value}
          pool: params.pool
      - act: {id: settle, transition: {resource: post, to: closed, verdict: measured}}
```

**Exercises:** the founding attribution gap, closed by the resource model — a post is attributable because it *references* the shared account it used, with `match_or_create` by exact key guaranteeing one resource per URL; `unbounded` claims; cron-triggered runs over a resource selection with an engine cursor; metric-kind Assess; tier-mapped reward; deferred measurement as a second lane rather than custom scheduling.

---

## 5. `bug-bounty` — emergent resources and human routing

```yaml
format: leaderboardos/1

template:
  id: bug-bounty
  version: 1.0.0
  name: Bug bounty
  summary: >
    Anyone reports; a security lane triages under exclusive claim, routing
    each report to a new vulnerability or an existing duplicate; only the
    first reporter of a novel vulnerability is paid, by severity tier.

params:
  pool:        {type: points, mutable: false}
  triage_role: {type: role, mutable: false}
  tiers:       {type: list({severity: enum(low, medium, high, critical), points: points}), mutable: true}

requires: {core: 1}

resources:
  report:
    fields:
      description: {type: string, visibility: [author, role(params.triage_role)]}
      poc:         {type: file,   visibility: [author, role(params.triage_role)]}
    created_by: [reporter.file_report, intake.file_report]
    claim: {mode: exclusive, ttl: 72h}           # the triage queue
    closure: {by: via_triage, verdict: [novel, duplicate, invalid]}
  vulnerability:
    fields:
      title:    {type: string, visibility: [role(params.triage_role), admin]}
      severity: {type: enum(low, medium, high, critical), visibility: [role(params.triage_role), admin]}
    created_by: [triage.route]                    # emergent
    match_or_create: {by: human}                  # the triager decides

lanes:
  - id: reporter
    entry: {trigger: user, access: {mode: open}}
    nodes:
      - collect: {id: file_report, fields: {description: {type: string}, poc: {type: file}}}
      - act: {id: register, create: report, from: file_report}

  - id: intake                                    # same flow, external origin
    entry: {trigger: webhook, dedup: {by: external_id, window: 30d}}
    nodes:
      - act: {id: register, create: report, from: webhook.payload}

  - id: triage
    entry: {trigger: user, access: {role: params.triage_role}}
    nodes:
      - act: {id: take, claim: {resource: report}}
      - collect:
          id: decide
          fields:
            outcome:  {type: enum(novel, duplicate, invalid)}
            existing: {type: ref(vulnerability), when: "outcome == duplicate"}
            severity: {type: enum(low, medium, high, critical), when: "outcome == novel"}
      - act:
          id: route
          match_or_create:
            resource: vulnerability
            decision: decide         # human routing: novel creates, duplicate attaches
          attach: take.report
      - act: {id: settle, transition: {resource: take.report, to: closed, verdict: decide.outcome}}
      - gate: {id: novel_only, all: ["decide.outcome == novel"]}
      - reward:
          id: bounty
          to: take.report.author
          amount: {mapping: tiers, tiers: params.tiers, input: decide.severity}
          pool: params.pool
```

**Exercises:** emergent resources through *human* match-or-create — the vulnerability is born from its first report, and first-reporter-wins is a consequence of creation order rather than a rule; exclusive claim with TTL as a triage queue that heals itself; a visibility embargo (report contents readable only by the author and the security role, with any public disclosure being a later admin grant); the webhook trigger with external-id dedup as an alternate entry to the same resource; cross-participation reward paid from the *triager's* run to the *reporter's* participation.

---

## 6. `data-annotation` — counters, golds, and pay-fast-audit-later

```yaml
format: leaderboardos/1

template:
  id: data-annotation
  version: 1.0.0
  name: Data annotation with gold cases
  summary: >
    Annotators label items under k-redundancy; hidden gold cases maintain a
    per-annotator accuracy record that weights pay and gates sensitive
    work; items resolve by agreement; payment is fast, audited by sampled
    clawback.

params:
  pool:       {type: points, mutable: false}
  per_unit:   {type: points, mutable: true}
  redundancy: {type: int, mutable: false}
  gold_rate:  {type: ratio, mutable: true}       # share of draws that are golds
  clearance:  {type: {min_seen: int, min_accuracy: ratio}, mutable: true}
  audit_rate: {type: ratio, mutable: true}

requires: {core: 1}

resources:
  item:
    fields:
      payload: {type: json, visibility: [claimant, admin]}
      class:   {type: enum(standard, sensitive)}
    created_by: [import.explode]
    claim: {mode: k_bounded, k: params.redundancy, ttl: 48h}
    closure: {by: aggregate, verdict: [labeled]}
  gold:
    fields:
      payload:  {type: json, visibility: [claimant, admin]}
      expected: {type: json, visibility: []}      # engine-read only, never granted
    created_by: [import.explode]
    claim: {mode: unique_per, dimensions: [gold, participation]}   # never re-served

counters:
  gold_seen:    {type: int}
  gold_correct: {type: int}

lifecycle:
  aggregates:
    - id: agreement
      over: item
      input: label
      per_participation: 1
      resolve:
        when:    "count(inputs) == params.redundancy"
        verdict: "mode(inputs.map(i, i.value))"
        then:
          - transition: {resource: item, to: closed, verdict: labeled}

lanes:
  - id: import
    entry: {trigger: admin}
    nodes:
      - collect:
          id: batch
          fields:
            file:  {type: file}
            kind:  {type: enum(items, golds)}
            class: {type: enum(standard, sensitive)}
      - act: {id: explode, create: "item | gold", many: from_file(batch.file)}

  - id: annotator
    entry: {trigger: user, access: {mode: open}}
    nodes:
      - act:
          id: draw
          claim:
            resource: item            # engine substitutes a gold at params.gold_rate
            where: >
              item.class == "standard"
              || (counters.gold_seen >= params.clearance.min_seen
                  && counters.gold_correct
                     >= params.clearance.min_accuracy * counters.gold_seen)
      - collect: {id: label, fields: {value: {type: json}}}
      - gate:
          id: kind
          branch:
            - when: "draw.is_gold"
              nodes:
                - assess:
                    id: check
                    kind: metric
                    value: "label.value == draw.expected"    # engine-side read; never revealed
                    counters:
                      gold_seen:    "+ 1"
                      gold_correct: "+ (value ? 1 : 0)"
            - else:
              nodes:
                - assess:
                    id: submit
                    kind: human
                    emit: {to: lifecycle.agreement, scope: draw.item}
      - reward:                        # branches converge: golds pay identically
          id: pay
          amount: >
            params.per_unit
            * (counters.gold_seen == 0 ? 1.0
               : counters.gold_correct * 1.0 / counters.gold_seen)
          pool: params.pool

  - id: audit
    entry:
      trigger: cron
      schedule: weekly
      over: "item where item.closed, sampled at params.audit_rate"
      cursor: engine
    nodes:
      - assess:
          id: recheck
          kind: metric
          value: "inputs of agreement disagreeing with item verdict"
      - reward:
          id: clawback
          to: recheck.disagreeing
          amount: "-params.per_unit"
          rule_key: clawback
          pool: params.pool
```

**Exercises:** `k_bounded` claims with TTL (the engine's only timer, returning abandoned items to the pool); participation counters written by an Assess and read by both a claim eligibility rule and a reward formula; a routing gate whose branches converge; agreement-mode Aggregate; and two deliberate design points. First, **opacity by symmetry**: golds pay identically to items and are never revealed, so they are indistinguishable from the annotator's side — field visibility constrains participants, not the engine's own nodes, which read `expected` server-side. Second, **pay fast, audit later**: immediate per-unit payment with sampled clawback, the specification's negative-entry instrument doing exactly the anti-gaming job it was designed for.

---

## 7. `localization` — the generality proof

Nothing in this template is new; that is its role in the suite. A two-stage resource pipeline built entirely from mechanisms other templates already required.

```yaml
format: leaderboardos/1

template:
  id: localization
  version: 1.0.0
  name: Localization pipeline
  summary: >
    Translators claim source strings exclusively; native reviewers approve
    or reject; approval pays the translator per string.

params:
  pool:          {type: points, mutable: false}
  per_string:    {type: points, mutable: true}
  reviewer_role: {type: role, mutable: false}
  target_locale: {type: string, mutable: false}

requires: {core: 1}

resources:
  string:
    fields:
      key:     {type: string}
      source:  {type: string}
      context: {type: string}
    created_by: [import.explode]
    claim:
      mode: exclusive
      ttl: 72h
      where: "count(open(translation, t, t.string == self)) == 0"
    closure: {by: via_review, verdict: [translated]}
  translation:
    fields:
      string: {type: ref(string)}
      text:   {type: string}
    created_by: [translator.register]
    claim: {mode: exclusive, ttl: 72h}          # the review queue
    closure: {by: via_review, verdict: [approved, rejected]}

lanes:
  - id: import
    entry: {trigger: admin}
    nodes:
      - collect: {id: batch, fields: {file: {type: file}}}
      - act: {id: explode, create: string, many: from_file(batch.file)}

  - id: translator
    entry: {trigger: user, access: {mode: open}}
    nodes:
      - act: {id: take, claim: {resource: string}}
      - collect: {id: submit, fields: {text: {type: string}}}
      - act: {id: register, create: translation, from: [take.string, submit]}

  - id: review
    entry: {trigger: user, access: {role: params.reviewer_role}}
    nodes:
      - act: {id: take, claim: {resource: translation}}
      - gate: {id: not_own, all: ["take.translation.author != participation.user"]}
      - assess:
          id: judge
          kind: human
          fields:
            decision: {type: enum(approved, rejected)}
            note:     {type: string}
      - gate:
          id: route
          branch:
            - when: "judge.decision == approved"
              nodes:
                - act: {id: close_t, transition: {resource: take.translation, to: closed, verdict: approved}}
                - act: {id: close_s, transition: {resource: take.translation.string, to: closed, verdict: translated}}
                - reward: {id: pay, to: take.translation.author, amount: params.per_string, pool: params.pool}
            - else:
              nodes:
                - act: {id: reject, transition: {resource: take.translation, to: closed, verdict: rejected}}
                # the string's claim-eligibility rule now passes again: claimable anew
```

**Exercises:** by design, nothing new — a two-stage resource pipeline (string → translation) as the inter-lane channel; exclusive+TTL at both stages; claim eligibility via a `where` expression, so "pending review" is a derived state, not a state machine; rejection reopening through claim semantics alone; cross-participation reward.

---

## 8. `design-contest` — the tournament

```yaml
format: leaderboardos/1

template:
  id: design-contest
  version: 1.0.0
  name: Design contest
  summary: >
    Open submissions during the window; at closure a jury aggregate ranks
    entries and the podium is paid by rank.

params:
  pool:       {type: points, mutable: false}
  close_date: {type: date, mutable: true}
  podium:     {type: list(points), mutable: false}    # [1st, 2nd, 3rd, ...]
  jury_role:  {type: role, mutable: false}

requires: {core: 1}

resources:
  entry:
    fields:
      asset:     {type: file, visibility: [author, role(params.jury_role), admin]}
      statement: {type: string}
    created_by: [contributor.register]
    closure: {by: transition}

lifecycle:
  states: {standard: true, close_at: params.close_date}
  aggregates:
    - id: panel
      over: entry
      input: score
      per_participation: 1
      resolve:
        when:    "challenge.state == closed"       # lifecycle-triggered, not quorum
        verdict: "mean(inputs.map(i, i.score))"
  on_close:
    - reward:
        id: podium_pay
        to: "rank(entry, by: aggregates.panel.verdict, desc)"
        amounts: params.podium
        pool: params.pool

lanes:
  - id: contributor
    entry: {trigger: user, access: {mode: open}}
    nodes:
      - collect: {id: submit, fields: {asset: {type: file}, statement: {type: string}}}
      - act: {id: register, create: entry, from: submit}

  - id: jury
    entry: {trigger: user, access: {role: params.jury_role}}
    nodes:
      - collect: {id: pick, fields: {entry: {type: ref(entry)}}}
      - gate: {id: not_own, all: ["pick.entry.author != participation.user"]}
      - assess:
          id: score
          kind: human
          fields: {score: {type: number, check: "value >= 0.0 && value <= 9.0"}}
          emit: {to: lifecycle.panel, scope: pick.entry}
```

**Exercises:** aggregate resolution triggered by lifecycle state instead of quorum count; rank-mapped tournament reward at `on_close` — the distribution model the founding platform deliberately abandoned internally, which an open format must nonetheless express; a mutable close date on an immutable structure.

---

## 9. `staked-grant-review` — skin in the game

```yaml
format: leaderboardos/1

template:
  id: staked-grant-review
  version: 1.0.0
  name: Staked grant review
  summary: >
    Reviewers stake points to enter; each application is reviewed by k
    reviewers; consensus pays the aligned and slashes the deviant, bounded
    by their stake; remaining stake is refunded at challenge close.

params:
  pool:       {type: points, mutable: false}
  stake:      {type: points, mutable: false}
  redundancy: {type: int, mutable: false}
  per_review: {type: points, mutable: true}
  slash:      {type: points, mutable: true}

requires: {core: 1}

resources:
  application:
    fields:
      title:    {type: string}
      document: {type: file}
    created_by: [intake.register]
    claim: {mode: k_bounded, k: params.redundancy, ttl: 96h}
    closure: {by: aggregate, verdict: [fund, reject]}

counters:
  slashed: {type: points}

lifecycle:
  aggregates:
    - id: consensus
      over: application
      input: review
      per_participation: 1
      resolve:
        when:    "count(inputs) == params.redundancy"
        verdict: "majority(inputs.map(i, i.recommendation))"
        then:
          - transition: {resource: application, to: closed}
          - reward:
              to:     "inputs.filter(i, i.recommendation == verdict)"
              amount: params.per_review
              pool:   params.pool
          - counters:
              on: "inputs.filter(i, i.recommendation != verdict)"
              slashed: "+ min(params.slash, params.stake - counters.slashed)"
  on_close:
    - reward:
        id: refund
        to: each_participation
        amount: "params.stake - counters.slashed"
        rule_key: stake_refund

lanes:
  - id: intake
    entry: {trigger: admin}
    nodes:
      - collect: {id: register_app, fields: {title: {type: string}, document: {type: file}}}
      - act: {id: register, create: application, from: register_app}

  - id: reviewer
    entry:
      trigger: user
      access:
        mode: open
        stake: {amount: params.stake}     # ledger debit at first entry; refusal if short
    nodes:
      - act: {id: take, claim: {resource: application}}
      - collect:
          id: review
          fields:
            recommendation: {type: enum(fund, reject)}
            score:          {type: number}
            rationale:      {type: string, visibility: [admin]}
      - assess:
          id: cast
          kind: human
          from: review
          emit: {to: lifecycle.consensus, scope: take.application}
```

**Accounting note.** Per participation, three ledger entries reconcile to the burn: `-stake` at entry, no explicit slash entry, `+(stake − slashed)` at close — net `−slashed`, burned. Slashing is serialized as *withheld refund* rather than a separate negative entry: economically identical to the specification's slash rule, but structurally incapable of exceeding the escrowed stake. The specification's explicit-negative form remains available for deployments that prefer visible slash entries.

**Exercises:** stake at entry as an Access property (a voluntary ledger debit, refused — not errored — on insufficient balance); consensus with bounded slashing via counters written by the Aggregate; stake refund at challenge close; counters as slash accounting; and the reconciliation-by-summation property of §3.5 holding across a three-entry lifecycle.

---

## 10. `developer-onboarding` — the verifiable quest, in one lane

```yaml
format: leaderboardos/1

template:
  id: developer-onboarding
  version: 1.0.0
  name: Developer onboarding
  summary: >
    A single long run: each step gives an instruction, verifies on a
    third-party API that it really happened, and pays a micro-reward.

params:
  pool:        {type: points, mutable: false}
  repo:        {type: url, mutable: false}
  step_points: {type: list(points), mutable: true}

requires: {core: 1}

resources: {}          # none — the state layers are independent

lanes:
  - id: dev
    entry:
      trigger: user
      access: {mode: open, runs_per_participation: 1}
    nodes:
      - collect: {id: identity, fields: {github_handle: {type: string}}}
      - act:
          id: v_fork
          kind: observer
          capability: github_check
          check: {kind: fork_exists, of: params.repo, by: identity.github_handle}
      - gate:   {id: g1, all: ["v_fork.ok"]}
      - reward: {id: r1, amount: params.step_points[0], pool: params.pool}
      - collect: {id: pr, fields: {url: {type: url}}}
      - act:
          id: v_pr
          kind: observer
          capability: github_check
          check: {kind: pr_open, url: pr.url, by: identity.github_handle}
      - gate:   {id: g2, all: ["v_pr.ok"]}
      - reward: {id: r2, amount: params.step_points[1], pool: params.pool}
      - collect: {id: deploy, fields: {endpoint: {type: url}}}
      - act:    {id: v_live, kind: observer, capability: http_proxy, probe: deploy.endpoint}
      - gate:   {id: g3, all: ["v_live.status == 200"]}
      - reward: {id: r3, amount: params.step_points[2], pool: params.pool}
```

**Exercises:** a single multi-segment run — the run persists across three interactive segments, and step deduplication is pure run advancement (a repeated gesture on a passed step refuses as "already advanced") plus `runs_per_participation`; engine-verified third-party actions through observer capabilities; micro-rewards mid-lane, each idempotent under `(run, node)`; an empty resource layer, demonstrating the state layers are genuinely independent. This is the quest-platform category — with every step *verified* rather than declared — in roughly thirty lines.

---

## Addendum — post-corpus flows

The reference corpus above is frozen as the 0.1 evidence base. Flows added to the platform *after* the corpus enter here — each one a live test of the closed vocabulary.

### 11. `journey-validation` — validating value, not code

The platform's code challenges need a validation counterpart that judges what endpoint validation cannot: whether the *product* works. A reviewer walks the deployed application through an ordered, admin-defined user journey — add to cart, check out, leave a review — recording a verdict and a note per step. One journey verdict per reviewer feeds the same quorum machinery as §2. This is `endpoint-validation` with the automated probe replaced by a human-driven one.

```yaml
format: leaderboardos/1

template:
  id: journey-validation
  version: 1.0.0
  name: Journey validation
  summary: >
    Qualified reviewers walk a deployed application through an ordered
    user journey, one verdict per step; a journey verdict per reviewer
    resolves under quorum, majority side paid.

params:
  pool:             {type: points, mutable: false}
  cp_per_journey:   {type: points, mutable: false}
  quorum:           {type: int, check: "value % 2 == 1", mutable: false}
  source_challenge: {type: challenge_ref, mutable: false}
  reviewer_role:    {type: role, mutable: false}

requires: {core: 1}

resources:
  target:
    fields:
      contribution: {type: link, from: params.source_challenge}
      app_url:      {type: url, visibility: [admin, role(params.reviewer_role)]}
    created_by: [expose.create_target]
    closure: {by: aggregate, verdict: [works, broken], permanent: true}

  journey_step:
    fields:
      order:       {type: int}
      instruction: {type: string}
    created_by: [journey.create_step]
    claim:
      mode: unique_per
      dimensions: [step, target, participation]   # each reviewer, each step, once per target

  step_report:
    fields:
      target:  {type: ref(target)}
      step:    {type: ref(journey_step)}
      verdict: {type: enum(passed, failed), visibility: [author, admin]}
      note:    {type: string, visibility: [author, admin]}
    created_by: [reviewer.log]

lifecycle:
  states: standard
  aggregates:
    - id: journey
      over: target
      input: verdict
      per_participation: 1          # one journey verdict per reviewer per target
      resolve:
        when:    "count(inputs) == params.quorum"
        verdict: "majority(inputs.map(i, i.verdict))"
        then:
          - transition: {resource: target, to: closed}
          - reward:
              to:     "inputs.filter(i, i.verdict == verdict)"
              amount: params.cp_per_journey
              pool:   params.pool
              order:  commit_time
              clamp:  pool
      state_visibility:
        count: everyone
        split: admin

lanes:
  - id: journey
    entry: {trigger: admin}
    nodes:
      - collect: {id: define, fields: {order: {type: int}, instruction: {type: string}}}
      - act: {id: create_step, create: journey_step, from: define}

  - id: expose
    entry: {trigger: admin}
    nodes:
      - collect:
          id: expose_app
          fields:
            contribution: {type: link, from: params.source_challenge}
            app_url:      {type: url}
      - act: {id: create_target, create: target, from: expose_app}

  - id: reviewer
    entry:
      trigger: user
      access: {role: params.reviewer_role}
    nodes:
      - collect:
          id: pick_target
          fields:
            target: {type: ref(target), where: "target.open"}
      - gate:
          id: not_own
          all: ["pick_target.target.contribution.author != participation.user"]
      - collect:
          id: pick_step
          fields:
            step:
              type: ref(journey_step)
              where: >
                step.order == 1
                || exists(step_report, r,
                     r.author == participation.user
                     && r.target == pick_target.target
                     && r.step.order == step.order - 1
                     && r.verdict == "passed")
      - assess:
          id: judge
          kind: human
          claim: {resource: pick_step.step, scope: {target: pick_target.target}}
          fields:
            verdict: {type: enum(passed, failed)}
            note:    {type: string}
      - act: {id: log, create: step_report, from: [pick_target, pick_step, judge]}
      - gate:
          id: outcome
          branch:
            - when: "judge.verdict == failed"
              nodes:
                - assess:
                    id: cast_broken
                    kind: metric
                    value: "broken"
                    emit: {to: lifecycle.journey, scope: pick_target.target}
            - when: "!exists(journey_step, s, s.order > pick_step.step.order)"
              nodes:
                - assess:
                    id: cast_works
                    kind: metric
                    value: "works"
                    emit: {to: lifecycle.journey, scope: pick_target.target}
            - else: {nodes: []}     # mid-journey pass: run ends, next step is next run
```

**Exercises:** the **claim carried by an Assess** — claim-and-verdict commits as one transaction, so a claimed step *is* a completed step; abandoned-claim states are unrepresentable, the same guarantee §2 gets from claim-and-probe. **Ordered progression with no state machine**: eligibility is a cross-resource `where` over prior step_reports, dedup is the `unique_per` claim, and a failed step closes the reviewer's journey by construction — no further step is eligible, and `per_participation: 1` already bounds their aggregate input. A three-branch routing gate with an empty else. The journey verdict as a *derived* (metric) Assess emitted from inside a branch. The quorum / majority / earliest-first machinery of §2, unchanged, over a human-driven probe. The live application renders through the typed renderer for the target's `app_url` — a display concern, not a node. Twelfth flow, eleventh template, still zero new node families.

---

## Coverage matrix

| Model feature | Exercised by |
|---|---|
| Access: open | 1, 3, 4, 5, 6, 7, 8, 9, 10 |
| Access: role-gated | 2, 5, 7, 8 |
| Access: author-scoped | 3 |
| Access: stake at entry | 9 |
| Access: runs cap | 10 |
| Group config + multiplier | 1 |
| Trigger: user | all |
| Trigger: admin | 2, 3, 4, 5*, 6, 7, 9 |
| Trigger: cron + engine cursor | 4, 6 |
| Trigger: webhook + external-id dedup | 5 |
| Collect: form / file / batch explode | all / 2, 6, 7, 8, 9 / 6, 7 |
| Act: observer | 1, 2, 4, 6*, 10 |
| Act: effector (spawn, auto-join) | 3 |
| Act: grant (reveal) | 2 |
| Claim: exclusive + TTL | 5, 7 |
| Claim: k_bounded + TTL | 6, 9 |
| Claim: unique_per | 2, 6 |
| Claim: unbounded | 4 |
| Claim eligibility (`where`) | 6, 7 |
| Match-or-create: by key / by human | 4 / 5 |
| Pre-declared vs emergent resources | 2 vs 5 |
| Resource cardinality (exact) | 2 |
| Hidden field: grant-only / engine-read-only | 2 / 6 |
| Aggregate state visibility (blind count) | 2 |
| Assess: ai_grid / human / metric / self | 1 / 2, 5, 7, 8, 9 / 4, 6 / 3 |
| Aggregate: quorum-majority / agreement / lifecycle-resolved | 2, 9 / 6 / 8 |
| Reward: continuous / tiers / fixed / rank | 1 / 4, 5 / 2, 3, 7, 9, 10 / 8 |
| Reward: cross-participation (`to:`) | 3, 4, 5, 7 |
| Negative economics: clawback / withheld-refund slash / refund | 6 / 9 / 9 |
| Closure-as-lock ordering | 3 |
| Routing gate (converging branches) | 6, 7 |
| Multi-segment single run | 10 |
| Empty resource layer | 10 |

\* 5's intake lane doubles admin/webhook; 6's gold check reads the external-shaped comparison engine-side.

**Addendum coverage.** §11 adds to the following rows: role-gated access, admin trigger, `unique_per` claims, claim eligibility (`where`), human and metric Assess, quorum-majority Aggregate, fixed reward, routing gate. It introduces two rows of its own: *claim carried by an Assess* (claim-and-verdict as one transaction) — 11; *ordered progression via cross-resource claim eligibility* — 11.

---

## Closing note

Twelve flows, eleven templates, zero node families added. Every mechanism the specification defines is exercised by at least one template, and no template needed a mechanism the specification does not define. The two serialization refinements surfaced by the 0.1 corpus are now normative in specification 0.2: the converging-branch form of the routing gate (§4.2) and slash-as-withheld-refund as the recommended stake serialization (§3.5).

The addendum queues three items for specification 0.3, none touching the execution model: the `claim` property formally allowed on Assess nodes (§11); the aligned list of aggregate builtins this suite actually uses (`count`, `majority`, `mode`, `mean`, `min`, `exists`); and, from the connector design session, declarative **connector manifests** (generic engine shapes parameterized by installable, versioned, cold-installing manifests) with **type-driven renderers** for their outputs.
