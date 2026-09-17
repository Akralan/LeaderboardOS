# The graph editor

The admin surface where a challenge template is **drawn** instead of written: lanes of nodes on a canvas, declarations in side panels, validation on every edit, publish when green. The product spec is `docs/input/spec-graph-editor.md`; the storage and the API it drives are described in [`database.md`](./database.md#templates) and [`api.md`](./api.md) (template editor API).

## Access

- `/admin/templates` — the library. Reached from the admin navigation (**Templates**) or from the profile page (`/contributors/me`), where an admin sees a **Templates** button to the right of **Admin**.
- `/admin/templates/:key` — the canvas of a template's draft. Without a draft, the latest published version opens read-only; `?version=x.y.z` opens a given published version. A system template (`data-annotation`, `endpoint-check`) opens read-only, with **Duplicate**.

## The YAML is the document

The canvas is a view of the draft's YAML, rebuilt on every write (`src/components/templates/editor/model.ts`). Every gesture — dropping a node, editing a field, adding a branch — is a rewrite of the text at one path (`mutations.ts`, on the `yaml` document API, so comments survive). **View source** shows that text; undo / redo (`Ctrl+Z`, `Ctrl+Shift+Z`) restore it.

A write is saved to `PUT /api/templates/:key/draft` after a short pause, and the diagnostics of that text come back with the response — the exact list a publication would be refused with. Each diagnostic's logical path is mapped back to a node, a lane, or a declaration tab (`locate`): red ring and message on the node card, inline under the inspector field, one line in the **Problems** drawer (click → focus).

## Canvas

- **Lanes** side by side, each a top-down rail: the entry, then the sequence. A routing gate fans its branches out and draws their reconvergence; no cycles, no data wires.
- **Selection** highlights provenance: the upstream nodes the selected node actually reads (`provenanceOf`); the others dim. An Assess that emits to an aggregate draws a dashed link to the aggregate card under its lane.
- **Palette**: drag a family onto a rail slot, or click it to add after the selection. Entry adds a lane, Aggregate adds a lifecycle declaration, Transition writes `act: {transition: …}`. Webhook entry, Spawn / Link and Stake access are shown locked.
- **Refused wires**: a drop is checked before it is written (`refusalOf`) — an entry or an aggregate on a rail, a gate into its own branches, or a move that leaves a node above something it reads (`brokenReads`) — and refused with its reason.
- Zoom (`Ctrl` + wheel, minimap buttons), pan by dragging the background, **Auto-layout** fits the lanes. Keyboard: arrows walk the rails, `Enter` focuses the inspector, `Delete` removes the node, `Esc` clears the selection.

## Inspector and declarations

The inspector is generated per family (`Inspector.tsx`): typed controls, resource and aggregate pickers, and expression inputs whose autocomplete lists the typed upstream context (`contextFor`: params, counters, upstream form fields, claimed resources and their fields). What the controls do not cover is edited in the node's YAML at the bottom.

With nothing selected, the right panel shows the declarations: **Params** (type, default, editable after creation, checks), **Resources** (fields with visibility, claim policy, closure), **Counters**, **Lifecycle** (aggregates and their emit links) and **Template** (name, summary, presentation).

## Layout: composing a screen

**Layout** (top bar) swaps the canvas for the grid of one screen — **Contributor** (what a participant sees) or **Manage** (the manager's tab). A screen is *generated* by default: the client stacks the template's lanes and panels. Composing it writes a `ui.<screen>` block in the YAML — a list of blocks, each a component of the catalogue, its place and size on a 12-column grid (`at: {x, y, w, h}`) and its arguments — and the client then renders that grid instead of the stack (`GeneratedScreen`), stacking the blocks in reading order on a phone.

- **Catalogue** (`packages/interpreter/ui/catalog.ts`, the palette in layout view). Generic blocks: `lane` (one lane, played step by step), `text` (a title and a paragraph), `pool` (the CP pool), `activity` (the contributions ledger and the repository's events), `metrics` (dataset and model metrics) on both screens; `mine`, `board`, `workspace` on the contributor screen; `overview`, `resources`, `participants` on the manage screen. Scenario blocks, parameterized by the resources and lanes they play — a template with the same shape (targets with an url, ordered steps, a walkthrough per target closed on `global_feedback`, a `result` per step) reuses them: `walkthrough` (contributor), `targets`, `steps`, `walkthroughs` (manage); `journey-validation` writes its screens with them in its `ui` block (MyTwin keeps serving it through its hand-written slots, which play the same routes). The hand-written screens of the code, ml and data-annotation flows are in the catalogue as they are, unchanged: `project` (contributor), `submissions` and `submission_list`, `compute` (both screens), `annotation` and `campaign`; each plays the lanes of the template it comes from by their names (`expects`), which the validator and the palette require. The catalogue is closed — a template composes, it embeds no code. A component that is unique per screen, or that needs a declaration the template lacks (`board`, `workspace`), shows locked in the palette.
- **Bricks and the screen's variables**: `picker` (the instances a lane's field can pick), `stepper` (the same, walked one at a time in order), `form` (a lane's first segment with some fields fixed by the screen) and `frame` (an application at a chosen URL) are the small blocks the hand-written screens decompose into. They coordinate through variables the screen holds: a block that chooses declares `selects: app`, and another block's argument reads `$app`, `$app.app_url`, or `values: {walkthrough: $run, step: $step}` on a form (a form's own `selects` keeps what its gesture created). The validator knows each variable's type from the surface — a variable nobody chooses, a field the chosen instance lacks, a fixed field the segment does not collect are errors. The validator's screen of `journey-validation` is written this way (picker → open form → frame, stepper → record form, complete form) and plays the same routes as the `walkthrough` block.
- **Gestures**: **Start from the generated screen** writes the stack as blocks; drop a component from the palette where it should go (or click it: first free spot); drag a block to move it, its corner to resize it — snapped to the grid, written at release, refused with its reason if it would overlap another block; `Delete` removes the selected block; **Back to the generated screen** deletes the `ui.<screen>` block.
- **Inspector**: a block's arguments are generated from the catalogue (a lane picker restricted to the screen's lanes, texts), its place and size are also editable as numbers.
- **Validation** (`validate/ui.ts`): an unknown component, a component on the wrong screen, a duplicate of a unique one, a missing or unknown argument, a lane or a resource that does not exist, a lane of the other actor, a block that overflows the grid, a scenario block whose resources or lanes lack the fields it plays — errors, mapped to the block on the grid and in the **Problems** drawer. Overlapping or cramped blocks are advisories.

## Preview, publish, versions

- **Preview** renders "what players will see" from `describeTemplate` on the current text — the same surface the generated UI plays — lane by lane, as soon as the draft validates.
- **Publish** is enabled when the draft has no error and is saved. The modal recaps the validation passes and picks the version (patch / minor / major of the last published one, or the draft's version the first time); the version is written into the YAML, saved, then `POST /api/templates/:key/publish`. The editor then shows the published version read-only.
- **New version** (canvas or library) starts a draft from the latest published text with its patch version bumped. Published versions are immutable.
- A published template becomes a challenge from **Challenges → New challenge**, whose configuration section is generated from the template's params.

## The template author agent

An agent that drafts and edits templates from natural language, live on the admin's screen (design note: `docs/input/template-author-design-note.md`). It is an admin of the editor API with no extra privilege: it writes drafts through the `templates` capability, **never publishes**.

- **Describe a flow** (library): a description (and an optional name) → `POST /api/templates/author` → a new template whose draft the editor opens, with the agent's report in the **Author** panel.
- **Author panel** (canvas, drafts only): an instruction → `POST /api/templates/:key/author/refine` → the draft is changed, saved, and adopted by the editor as one undoable step. The canvas takes no gesture while the agent works.
- **Report**: validity and rounds, **Choices made** (every assumption the description did not state), **Open questions** (what was ambiguous, or a platform object that does not exist — click one to answer it).

How it works (`packages/template-author`):

- **Context** (`context.ts`): a condensed grammar of `leaderboardos/1`, the capability catalog restricted to what v1 executes, the live registries (qualification keys — declared by the distribution in `mytwin.templates.ts` or held by a user — and evaluation grids), and the whole corpus: the installed templates and the canonical conformance templates, each annotated with what v1 cannot execute. The corpus is generated into `corpus.source.ts` by `npm run templates:build`.
- **Loop** (`author.ts`): generate → `diagnose` (the list a publication would be refused with) → feed the path-addressed diagnostics back → repair, at most 3 repairs. Still red after that, the draft is saved anyway with its diagnostics.
- **Edits** (`edits.ts`): to change a document the model sends `set` / `insert` / `delete` edits addressed by path rather than a new text; an edit that does not apply comes back as a diagnostic. The text is rewritten with `yaml-text.ts`, which copies every unchanged subtree byte for byte (comments, folded scalars) — the canvas uses the same writer.
- **Model** (`service.ts`): OpenAI through the evaluator's client (key from the OpenAI connection or `OPENAI_API_KEY`), `TEMPLATE_AUTHOR_MODEL` (default `gpt-5.6-luna`), JSON output. Synchronous route, `maxDuration` 300 s.

**Bench**: `npm run templates:author-bench [name…]` runs one-sentence descriptions of the twelve reference flows (`bench.ts`) against the real model, plus refine cases checked for collateral changes. It writes nothing to the database. Last run (Sept. 2026, `gpt-5.6-luna`): 5/12 valid at the first round, 12/12 after repair, refines valid.
