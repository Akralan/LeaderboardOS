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

## Preview, publish, versions

- **Preview** renders "what players will see" from `describeTemplate` on the current text — the same surface the generated UI plays — lane by lane, as soon as the draft validates.
- **Publish** is enabled when the draft has no error and is saved. The modal recaps the validation passes and picks the version (patch / minor / major of the last published one, or the draft's version the first time); the version is written into the YAML, saved, then `POST /api/templates/:key/publish`. The editor then shows the published version read-only.
- **New version** (canvas or library) starts a draft from the latest published text with its patch version bumped. Published versions are immutable.
- A published template becomes a challenge from **Challenges → New challenge**, whose configuration section is generated from the template's params.
