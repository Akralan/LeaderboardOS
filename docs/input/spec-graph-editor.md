# The Graph Editor — Product & Design Specification

**For producing realistic UI mockups.** Self-contained: everything needed is in this document.

Draft — September 2026. The visual editor for LeaderboardOS challenge templates: the "Unreal Blueprint / n8n for contribution programs" surface.

---

## 1. What this is

MyTwin Leaderboard runs contribution challenges (ML, code, medical validation, data annotation…) from **templates**: graph documents that declare who enters, what gets submitted, how it is evaluated, how consensus forms, and what gets paid. The engine that executes these templates is live in production — one challenge type already runs entirely from a template file. The graph editor is the surface where an admin **draws** a template instead of writing its YAML: drop blocks, connect them, configure them, publish, and the platform executes the result — including auto-generating the screens participants use to play.

The pitch line the editor makes true: *"You don't code the platform, you draw the program."*

**Audience:** platform admins and challenge designers (desktop, expert users, but not necessarily developers). Participants never see this surface — they see the generated challenge screens.

**One sentence for the designer:** think n8n's approachability with Linear's sobriety — a professional tool, not a game engine aesthetic; calm surfaces, strong typography, color used for meaning (node families, validation states), not decoration.

## 2. Design foundations

- **Lives inside the existing MyTwin admin.** Existing top navbar and theme (light/dark) stay; the editor is a new admin section. Design tokens come from the platform's design system — do not invent a second visual language for chrome, buttons, forms.
- **Desktop-first.** Canvas editing is a large-screen activity. Mobile: read-only preview at most (out of scope for mockups).
- **The core UX material is validation.** The engine validates templates statically and completely: types, references, graph shape, economy. The editor's personality is *"impossible to break"*: wires refuse to connect with a typed reason, nodes carry their errors inline, publish is disabled until green. Errors are first-class visual citizens, not afterthoughts.
- **Calm canvas.** The underlying model is quasi-linear (see §3), so the canvas should read top-to-bottom like a clean flowchart — never an n8n spaghetti. Auto-layout is the default; free dragging allowed but tidiness is the brand.

## 3. The mental model (what the designer must internalize)

A template has two kinds of matter:

**On-canvas: lanes.** A lane is a vertical rail of nodes describing one actor's program: an **entry** (who may start it and how: user gesture, admin gesture, or a cron schedule) followed by a **sequence** of nodes. Lanes are strict top-down sequences — **no cycles, ever** (iteration = the participant simply runs the lane again). Only one construct branches: the **routing gate**, whose branches always **reconverge** further down (or end the lane). This is the editor's biggest visual advantage over generic node tools: every graph is readable top to bottom.

**Off-canvas: declarations.** Side panels, not nodes: **Params** (the template's configuration surface: typed values, some editable after creation, with named validation checks), **Resources** (the shared work units — items to annotate, cases to verify, targets to test — each with typed fields, per-field visibility, and a *claim policy*: how many people can hold one, for how long, with what uniqueness), **Counters** (derived per-participant stats, e.g. gold accuracy), and **Lifecycle** (the challenge's aggregates: consensus/quorum rules that resolve a resource when enough inputs arrive, and what they pay).

**Wiring is sequence, not data.** This is crucial and unusual: there are no data wires. Everything a node produces joins a typed *run context* that every later node in the lane can read; the inspector offers typed pickers over "what's upstream" instead of cables. The only connections drawn on canvas are: the thick **sequence rail** of each lane, thin dashed **emit** links from an Assess node to a Lifecycle aggregate card, and subtle **resource links** (a node that claims or creates a resource shows a chip; selecting the node highlights the resource card). Selecting any node highlights, upstream, everything it reads — provenance at a glance.

**The node families (the palette):**

| Family | Role | Suggested hue | Card shows |
|---|---|---|---|
| Entry | who starts this lane: user / admin / cron + access rules (role, qualification, open) | slate | trigger icon + access chips ("role: medical_pro") |
| Collect | a form step — fields the actor fills (text, number, choice, url, file, picker) | blue | field list preview (name: type) |
| Gate | a check; blocking form (conditions) or routing form (branches that reconverge) | amber | condition summary / branch labels |
| Act | the system does something: observer (fetch/probe), effector (create, provision), grant (reveal a hidden field) | violet | capability name + claim/create chips |
| Assess | a judgment: AI grid, human verdict, or computed metric; may emit to an aggregate | green | kind badge + emit target |
| Reward | pays points: fixed, per-unit, tiered, or continuous formula; pool-clamped | gold | amount formula + pool chip |
| Aggregate (lifecycle card) | consensus over a resource: resolves at k inputs / quorum, sets verdict, pays winners | teal | "over: item · resolve at k · verdict: majority" |
| Transition | closes a resource or the challenge with a verdict | gray | "close item → labeled" |

Unavailable-in-v1 families (webhook entry, spawn/Link, stake access) appear **greyed with a lock + "coming with its first template"** tooltip — the palette is honest about what the engine executes.

## 4. The screens to mock

### 4.1 Template library
Grid/list of templates: name, current version, status chip (Draft / Published vX.Y.Z), "used by N challenges", last edited. Actions: New template, Open, New version (from a published one). Published versions are immutable — visible in the UI language ("v1.2.0 · published · read-only").

### 4.2 The canvas (the hero screen)
Layout: **left** — collapsible palette (families above, greyed locked ones below); **center** — canvas with lanes as vertical rails side by side, each lane titled by its entry ("Annotator · open entry", "Import · admin", "Audit · cron weekly"); zoom/pan, minimap bottom-right, auto-layout button; **right** — context panel: inspector of the selected node, or the declarations tabs (Params / Resources / Counters / Lifecycle) when nothing is selected; **top bar** — template name, version + Draft chip, validation status ("3 problems" red / "Valid" green), Preview toggle, Publish button (disabled until valid); **bottom** — collapsible Problems drawer listing every error with node link.

### 4.3 Node inspector
Generated from the node's schema: typed fields, expression inputs with autocomplete over the upstream context (e.g. typing `grade.` suggests `score: number`), pickers for resources/grids/qualifications, per-field visibility editor on resource fields. Named checks show as human messages ("option keys must be unique").

### 4.4 Declarations panels
Params: table of name · type · default · editable-after-creation toggle · checks. Resources: cards with field list (each field: type + visibility chips like "claimant + admin", "hidden — grant only"), claim policy summary ("up to 3 holders · 48h TTL · never re-served to same person"), closure ("closed by aggregate → labeled | contested"). Lifecycle: aggregate cards (the teal cards emit links point to).

### 4.5 Validation states
Wire refusal: dragging an incompatible connection shows the wire snapping back with a tooltip ("This branch must reconverge — connect to 'pay' or end the lane"). Node error: red ring + badge, message in inspector header ("references params.rate — not declared"). Warning (advisory): amber, e.g. "counter read inside a draw filter — one aggregation per gesture". Problems drawer aggregates all, click → focus node.

### 4.6 Participant preview
A right-side or overlay panel: "what players will see", rendered from the same template — contributor screen (the generated form of the current Collect, e.g. an image with choice buttons), manager screen (import panel, progress), hero stat. Tabs per lane/actor. This is a real differentiator: **you draw the program and watch its screens form live.**

### 4.7 Publish flow
Modal: full validation recap (green checklist: format, references, types, graph shape, economy, claims), version picker (patch/minor/major), the immutability sentence ("Published versions are immutable — future edits create a new version"), confirm. After publish: canvas switches to read-only with a "New version" CTA.

### 4.8 Instantiation
"Create challenge from template": the existing challenge-creation screen, whose configuration section is **generated from the template's params** — typed fields, editable-marked ones flagged as adjustable later, pool and reward fields, named-check messages inline. This is where a published template becomes a live challenge.

## 5. Key interactions

- Drag a family from the palette onto a lane → the node snaps into the rail at the drop point; the rail re-flows.
- Routing gate: "+ branch" affordance on the gate; branches fan out and visually reconverge to the next node — the editor draws the merge, the user never manages it.
- Wire attempt between incompatible points → refusal animation + typed reason tooltip.
- Select a node → upstream provenance highlight (what it reads), resource cards it touches glow.
- Expression fields: autocomplete over upstream context with types; errors inline as you type.
- Cmd/Ctrl-Z undo everywhere; auto-layout; keyboard: arrows navigate the rail, Enter opens inspector.
- Everything the canvas shows serializes to YAML (a "view source" toggle for expert users — read-only pretty YAML side panel).

## 6. Realistic content for the mockups

Use these two real templates — both exist; the first runs in production. Card labels below are the exact strings to display.

### 6.1 Data annotation (production template — the flagship mockup)

**Params:** `k = 3 (odd)`, `ttl_hours = 48`, `label_schema: single choice — [normal, anomaly, unsure]`, `sensitive_clearance: min_seen 5 · min_accuracy 0.8`. Editable later: `per_unit_cp = 40`, `gold_rate = 0.10`, `audit_rate = 0.10`.

**Resources:** `item` — fields: `image_url (url · visible to claimant + admin)`, `class (standard | sensitive)`; claim: `up to 3 holders · 48h TTL`; closed by aggregate → `labeled | contested`. `gold` — fields: `image_url`, `expected (hidden — never shown)`; claim: `never re-served to the same annotator`.

**Counters:** `gold_seen`, `gold_correct` (derived).

**Lifecycle:** aggregate `agreement` — `over: item · input: label · resolve when 3 labels · verdict: majority · then: close item → labeled`.

**Lanes (left to right):**
1. `Import · admin entry` → Collect `batch` (`file: CSV`, `kind: items | golds`, `class`) → Act `explode` (create many: item/gold — chip "creates: item").
2. `Annotator · open entry` → Act `draw` (claim: item, gold mix 10%, chip "claims: item") → Collect `label` (`value: choice of label_schema`) → Gate `kind` (routing, 2 branches) — branch *gold*: Assess `check` (metric · counters +1) — branch *item*: Assess `submit` (human · dashed emit → `agreement`) — branches reconverge → Reward `pay` (`per_unit_cp × accuracy · pool`).
3. `Resolve · admin entry` → Collect `pick` (`item — contested only`, `decision`) → Transition `close item → labeled`.
4. `Audit · cron weekly` → Assess `recheck` (metric · sampled 10%) → Reward `clawback` (`− per_unit_cp`).

### 6.2 Endpoint validation (the reveal + quorum showcase)

**Params:** `pool = 5000`, `cp_per_validation = 120`, `required_validations = 5 (odd — check: "must be odd")`, `source_challenge: picker`, `reviewer_role = medical_pro`.

**Resources:** `target` — `contribution (link from source challenge)`, `endpoint_url (visible to reviewers + admin)`; closed by aggregate → `works | broken`. `reference_case` — `input (file · author + admin)`, `expected_output (file · hidden — grant only)`; claim: `one per (case, target)`.

**Lifecycle:** aggregate `quorum` — `over: target · resolve at 5 verdicts · verdict: majority · pays majority side, earliest first, pool-clamped`; state visibility: `count: everyone · split: admin` (mock the "3/5 validations" chip).

**Lanes:** `Expose · admin` → Collect → create target. `Author · role: medical_pro` → Collect `case` (`input: file`, `expected_output: file`) → create. `Reviewer · role: medical_pro` → Collect `pick` (`target (open)`, `case`) → Gate `eligibility` ("not your case · not your target") → Act `probe` (observer · http_proxy · chip "claims: case@target" · stores response) → Collect `observation` (`text`) → Act `reveal` (grant · "unlocks expected_output for you") → Assess `verdict` (human · `works | broken` + description · emit → `quorum`).

### 6.3 Error states to mock (on the annotation canvas)
- Red node: Reward `pay` — "references `params.rate` — not declared. Did you mean `per_unit_cp`?"
- Refused wire: gold branch dragged past the reward — "This branch must reconverge — connect to 'pay' or end the lane."
- Amber advisory on `draw`: "reads counter `gold_correct` in its filter — one aggregation per draw."
- Problems drawer: the three above, one line each, node-linked.

## 7. States to mock

1. Library with 4 templates (2 published, 1 draft, 1 "v2 draft of published v1").
2. Empty canvas — first-node moment: ghost lane with "Add an entry" hint.
3. The annotation template mid-edit with the 3 problems above (the money shot).
4. The same, valid: green "Valid", Publish enabled, Preview open showing the annotator screen (image + three choice buttons + quality score).
5. Publish modal.
6. Published read-only + "New version".
7. Instantiation form generated from params.

## 8. Out of scope (v1)

Real-time multi-user editing; a public template marketplace; mobile editing; free-form cycles (the model forbids them — not a missing feature); custom code nodes (extension happens through engine capabilities, never code-in-graph); editing a published version (immutable by design).
