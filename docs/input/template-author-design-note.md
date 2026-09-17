# The Template Author Agent — Design Note

**Describe a flow in natural language; receive a valid draft template**

Draft — September 2026. Companions: the interpreter design note (the capability catalog, the validator), the templates-in-DB note rev 2 (the editorial API this agent consumes), `spec-graph-editor.md` (where the entry point will live once the canvas exists).

---

## The one idea

Everything this agent needs already exists — it was built for humans and works unchanged for a model. The **diagnostic-mode validator** is the agent's harness: generate → validate → read located diagnostics → repair → loop. The **holey draft** is its safety net: an imperfect agent yields a saved draft with visible diagnostics, never a failure. The **editorial API** (T3) is its entire working surface: the agent is an *admin user of existing endpoints* with zero new privileges and zero new trust paths. And the **conformance corpus** is its few-shot library. The security principle is the one set for connectors long ago, applied verbatim: **the AI produces statically validated data, never executable code** — expressions land in the closed CEL-like subset and the type-checker judges them like anyone else's.

## 0. Arbitrated trade-offs

1. **Draft, never publish.** The agent's terminal state is a saved draft plus a report; publication stays human, always. Non-negotiable — it is what makes the agent safe to be wrong.
2. **Bounded repair loop.** Generate a candidate, run `collectDiagnostics`, feed the located diagnostics back (they are path-addressed — ideal LLM feedback), repair, at most **3 rounds**. Still red after that: save the draft anyway with its diagnostics — the T2 machinery makes partial success a feature, not a failure mode.
3. **Grounding is the catalog plus the corpus.** The system prompt carries: a condensed grammar of `leaderboardos/1`, the **capability catalog** (only what the engine executes — the agent cannot propose webhook triggers or stake because they are not in the catalog), the live registries it may reference (qualification keys, grid ids, connector names), and the **full canonical corpus** (twelve templates fit in context; no retrieval machinery in v1). The agent proposes only what the platform can run, by construction of its context.
4. **One-shot with explicit assumptions, plus refine.** No clarifying-question dialogue in v1. The agent generates and returns three things: the draft, **"Choices made"** (every assumption: k = 3, TTL 48h, pool defaults, which qualification…), and **"Open questions"** where the description was genuinely ambiguous. A second operation, `refine`, takes the existing draft plus an instruction ("make golds 20%", "add an admin resolve lane") and edits it — same loop, same guarantees. Multi-turn chat authoring waits for the canvas.
5. **Admin-only, synchronous in v1.** The route runs with a generous `maxDuration`, like evaluation runs today; the job/tick pattern is the fallback if latency ever demands it. Same LLM provider pattern as the evaluator.
6. **The agent references, never invents, platform objects.** Grid ids, qualifications, connectors come from the registries in its context; a description needing a grid that doesn't exist yields an open question ("no mammography grid found — create one first or point me at an id"), not a fabricated reference. The References validation pass backstops this mechanically.

## 1. The flow

```
POST /api/templates/author        (admin)
  { description, key?, name? }
   │
   ├─ 1. compose context: grammar + catalog + registries + corpus
   ├─ 2. LLM → candidate YAML (low temperature, fenced output)
   ├─ 3. collectDiagnostics(candidate)
   ├─ 4. if errors and rounds < 3: repair prompt (diagnostics verbatim) → 3
   ├─ 5. create template (key from input or slugged name) + save draft
   └─ 6. return { key, diagnostics, choices[], openQuestions[], previewUrl }

POST /api/templates/:key/author/refine    (admin)
  { instruction }        -- loads the draft, same loop, saves back
```

Steps 5–6 go through the **templates capability** — the exact code paths a human save takes. The preview URL is T3's `describe?draft=1`: the human immediately sees the generated participant screens of what the agent drew, which is the fastest possible review.

## 2. Evaluation — the corpus turned mirror

A small bench, not science: one-sentence descriptions of the twelve canonical flows ("annotators label items under 3-way redundancy with hidden gold cases weighting pay…") → the agent must produce valid templates. Metrics: validity after round 1 / after repair; manual semantic diff against the canonical for a sampled few. The bench doubles as the regression suite when the prompt or model changes. Lives beside the conformance fixtures.

## 3. Milestones

**A1 — the loop.** The `template-author` service (context composer, LLM call, repair loop), the `author` route, drafts saved through the capability. Proof: the twelve-description bench — every output saves as a draft; count how many are green without human touch.

**A2 — refine + the report.** The `refine` route, "Choices made" / "Open questions" extraction, the bench extended with refine cases ("take the annotation description, then: make it 5-way redundancy"). Proof: refine edits without collateral damage — untouched lanes byte-identical.

**A3 — the surface.** A "Describe a flow" entry in the template library (prompt box → agent → opens the draft with its diagnostics and preview), refine reachable from the draft view. When the canvas lands later, the same two operations become its AI panel — nothing to rebuild.

## Out of scope

Multi-turn conversational authoring (the canvas's chapter); generating evaluation grids or connectors (each is its own chantier — the agent references existing ones); auto-publish under any condition; non-admin access; fine-tuning (the corpus-in-context does the work in v1).
