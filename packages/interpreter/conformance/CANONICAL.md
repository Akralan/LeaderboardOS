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
