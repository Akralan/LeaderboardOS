import type { UiScreen } from "../format/schema.js";

/**
 * Le catalogue des composants d'écran (note §5, catalogue UI)
 * -----------------------------------------------------------
 * Ce qu'un template peut poser sur un écran composé : des composants
 * génériques, chacun avec les écrans qu'il admet, ses arguments typés et sa
 * taille de départ. Le catalogue est la vérité des deux côtés : le validateur
 * refuse un composant ou un argument qu'il ne connaît pas, le client monte le
 * composant React du même nom. Le catalogue est fermé — un template compose,
 * il n'embarque pas de code.
 */

export const UI_COLUMNS = 12;

/** `values` : des champs d'un segment fixés par l'écran (`{app: $app}`), jamais saisis. Un `text` peut aussi lire une variable (`$app.app_url`). */
export type UiPropKind = "lane" | "resource" | "text" | "markdown" | "bool" | "values";

/** Une liaison : `$name` ou `$name.field`. */
export const BINDING = /^\$([a-z][a-z0-9_]*)(?:\.([a-z][a-z0-9_]*))?$/;

export interface UiPropSpec {
  kind: UiPropKind;
  label: string;
  hint?: string;
  required?: boolean;
}

export interface UiComponentSpec {
  name: string;
  label: string;
  /** Ce que le composant fait, en une ligne, pour la palette. */
  role: string;
  screens: readonly UiScreen[];
  props: Readonly<Record<string, UiPropSpec>>;
  /** La taille posée par la palette, et ce en dessous de quoi le composant ne se lit plus. */
  size: { w: number; h: number; minW: number; minH: number };
  /** Une seule occurrence par écran. */
  single?: boolean;
  /** Ce que le template doit déclarer pour que le composant ait quelque chose à montrer. */
  requires?: "board" | "workspace";
  /**
   * Un écran écrit à la main, entré au catalogue tel quel : les lanes qu'il
   * joue par leur nom, la déclaration `submissions` qu'il lit. Le validateur
   * refuse un template qui ne les a pas.
   */
  expects?: { lanes?: readonly string[]; submissions?: boolean };
  /**
   * Le bloc peut choisir pour l'écran (`selects`) : une instance de la
   * ressource que sa lane désigne (`resource`), ou ce qu'un geste a créé ou
   * réclamé (`created`, dont seul l'identifiant est connu).
   */
  selects?: "resource" | "created";
}

export const UI_CATALOG: readonly UiComponentSpec[] = [
  {
    name: "lane",
    label: "Lane",
    role: "one lane played step by step: its forms, its claim, its result",
    screens: ["contributor", "manage"],
    props: { lane: { kind: "lane", label: "Lane", required: true, hint: "a user lane on the contributor screen, an admin lane on the manage screen" } },
    size: { w: 12, h: 6, minW: 4, minH: 3 },
  },
  {
    name: "text",
    label: "Text",
    role: "a title and a paragraph: instructions, context, a reminder",
    screens: ["contributor", "manage"],
    props: {
      title: { kind: "text", label: "Title" },
      body: { kind: "markdown", label: "Body", hint: "plain text, paragraphs separated by a blank line" },
    },
    size: { w: 12, h: 2, minW: 2, minH: 1 },
  },
  {
    name: "mine",
    label: "My work",
    role: "what the participant already created, by resource type",
    screens: ["contributor"],
    props: {},
    size: { w: 12, h: 4, minW: 4, minH: 2 },
    single: true,
  },
  {
    name: "board",
    label: "Board",
    role: "the participant's personal task board",
    screens: ["contributor"],
    props: {},
    size: { w: 12, h: 4, minW: 6, minH: 3 },
    single: true,
    requires: "board",
  },
  {
    name: "workspace",
    label: "Workspace",
    role: "where the participant delivers: the challenge repo or their own",
    screens: ["contributor"],
    props: {},
    size: { w: 12, h: 3, minW: 4, minH: 2 },
    single: true,
    requires: "workspace",
  },
  {
    name: "pool",
    label: "Pool",
    role: "the points pool: what is left, what was distributed",
    screens: ["contributor", "manage"],
    props: {},
    size: { w: 6, h: 2, minW: 3, minH: 1 },
    single: true,
  },
  {
    name: "activity",
    label: "Activity",
    role: "the ledger of contributions, and the linked repository's events",
    screens: ["contributor", "manage"],
    props: { reward_breakdown: { kind: "bool", label: "Reward breakdown", hint: "detail each contribution's ledger lines" } },
    size: { w: 12, h: 6, minW: 6, minH: 3 },
    single: true,
  },
  {
    name: "metrics",
    label: "Metrics",
    role: "dataset and model metrics of the linked repositories, version by version",
    screens: ["contributor", "manage"],
    props: {},
    size: { w: 12, h: 5, minW: 6, minH: 3 },
    single: true,
  },
  {
    name: "overview",
    label: "Overview",
    role: "progress by resource type, the pool, the participants, CSV export",
    screens: ["manage"],
    props: {},
    size: { w: 12, h: 4, minW: 6, minH: 3 },
    single: true,
  },
  {
    name: "participants",
    label: "Participants",
    role: "each participant's board progress and what their evaluation awarded",
    screens: ["manage"],
    props: { workspace_status: { kind: "bool", label: "Workspace status", hint: "show whether each workspace is ready" } },
    size: { w: 12, h: 5, minW: 6, minH: 3 },
    single: true,
  },
  {
    name: "resources",
    label: "Resources",
    role: "every instance of every resource type, drafts included",
    screens: ["manage"],
    props: {},
    size: { w: 12, h: 5, minW: 6, minH: 3 },
    single: true,
  },

  // ── Les briques : elles se coordonnent par les variables de l'écran ────
  // Un `picker` choisit une instance (`$app`), un `stepper` une étape
  // (`$step`), un `form` fixe des champs d'un segment sur ces choix et garde ce
  // que le geste a créé (`$run`), un `frame` montre l'URL du choix. Le
  // walkthrough de journey-validation s'écrit avec ces quatre briques.
  {
    name: "picker",
    label: "Picker",
    role: "the instances a lane's field can pick, one chosen for the screen",
    screens: ["contributor", "manage"],
    props: {
      lane: { kind: "lane", label: "Lane", required: true, hint: "the lane whose first segment picks the instance (its options read)" },
      field: { kind: "text", label: "Field", hint: "the ref or link field of that segment; its first one by default" },
      status: { kind: "resource", label: "Status from", hint: "a resource I create that refers to the picked instance: shows mine on each (in progress, completed)" },
    },
    size: { w: 4, h: 8, minW: 3, minH: 3 },
    selects: "resource",
  },
  {
    name: "stepper",
    label: "Stepper",
    role: "the instances a lane's field can pick, walked one at a time in order",
    screens: ["contributor", "manage"],
    props: {
      lane: { kind: "lane", label: "Lane", required: true, hint: "the lane whose first segment picks the step (its options read)" },
      field: { kind: "text", label: "Field", hint: "the ref field of that segment; its first one by default" },
      order: { kind: "text", label: "Order by", hint: "the field that orders the steps (position)" },
    },
    size: { w: 4, h: 4, minW: 3, minH: 2 },
    selects: "resource",
  },
  {
    name: "form",
    label: "Form",
    role: "the first segment of a lane, some fields fixed by the screen's choices, the others asked",
    screens: ["contributor", "manage"],
    props: {
      lane: { kind: "lane", label: "Lane", required: true },
      values: { kind: "values", label: "Fixed fields", hint: "field: $variable — a field the screen fixes, never asked" },
      label: { kind: "text", label: "Button", hint: "the submit button's label" },
    },
    size: { w: 8, h: 4, minW: 3, minH: 2 },
    selects: "created",
  },
  {
    name: "frame",
    label: "Frame",
    role: "an application under test, in a frame, at the URL of a choice",
    screens: ["contributor", "manage"],
    props: { url: { kind: "text", label: "URL", required: true, hint: "$app.app_url — a variable's url field, or an address" } },
    size: { w: 8, h: 8, minW: 4, minH: 4 },
  },

  // ── Un scénario parcouru dans des applications (journey-validation) ────
  // Les ressources : des cibles qui portent une URL et un lien (`app`), des
  // étapes ordonnées (`step`, avec title, instructions, position), une
  // walkthrough par (validateur, cible) qui se ferme sur `global_feedback`, et
  // un résultat par (walkthrough, étape) — `result` (enum), `comment`,
  // `medical_comment`. Les lanes : ouvrir, enregistrer une étape, conclure.
  {
    name: "walkthrough",
    label: "Walkthrough",
    role: "the exposed apps and my walkthrough on each: the app in a frame, one scenario step at a time",
    screens: ["contributor"],
    props: {
      targets: { kind: "resource", label: "Apps", required: true, hint: "the exposed apps: a link field and an url field" },
      steps: { kind: "resource", label: "Steps", required: true, hint: "the ordered scenario: title, instructions, position" },
      open: { kind: "lane", label: "Open", required: true, hint: "opens (or resumes) my walkthrough on an app" },
      record: { kind: "lane", label: "Record", required: true, hint: "records a step: walkthrough, step, result, comment, medical_comment" },
      complete: { kind: "lane", label: "Complete", required: true, hint: "closes the walkthrough on global_feedback" },
      reward_param: { kind: "text", label: "Reward param", hint: "the param paid per walkthrough (cp_per_validation)" },
      expert_param: { kind: "text", label: "Expert param", hint: "the role param that allows an expert comment" },
    },
    size: { w: 12, h: 8, minW: 8, minH: 5 },
    single: true,
  },
  {
    name: "targets",
    label: "Targets",
    role: "the apps under test: expose a submission of the source challenge, withdraw one nobody walked",
    screens: ["manage"],
    props: {
      targets: { kind: "resource", label: "Apps", required: true },
      expose: { kind: "lane", label: "Expose", required: true, hint: "collects the contribution and its url" },
      withdraw: { kind: "lane", label: "Withdraw", hint: "deletes an app" },
    },
    size: { w: 12, h: 5, minW: 6, minH: 3 },
    single: true,
  },
  {
    name: "steps",
    label: "Scenario steps",
    role: "the ordered scenario, editable until the first walkthrough",
    screens: ["manage"],
    props: {
      steps: { kind: "resource", label: "Steps", required: true },
      add: { kind: "lane", label: "Add", required: true, hint: "collects title and instructions" },
      edit: { kind: "lane", label: "Edit", hint: "updates title, instructions or position" },
      remove: { kind: "lane", label: "Remove", hint: "deletes a step" },
    },
    size: { w: 12, h: 5, minW: 6, minH: 3 },
    single: true,
  },
  {
    name: "walkthroughs",
    label: "Walkthroughs",
    role: "every walkthrough with its step results, app by app",
    screens: ["manage"],
    props: {
      targets: { kind: "resource", label: "Apps", required: true },
      steps: { kind: "resource", label: "Steps", required: true },
    },
    size: { w: 12, h: 6, minW: 6, minH: 3 },
    single: true,
  },

  // ── Les écrans écrits à la main des flows code, ml et data-annotation ──
  // Entrés tels quels : chacun joue les lanes du template dont il porte le
  // nom (`expects`), sans argument. Un template qui les compose a la forme du
  // flow d'origine ; le validateur le vérifie par les noms.
  {
    name: "project",
    label: "Project",
    role: "the code challenge panel: workspace, personal board, and the project evaluation",
    screens: ["contributor"],
    props: {},
    size: { w: 12, h: 8, minW: 8, minH: 5 },
    single: true,
    requires: "board",
    expects: { lanes: ["project_evaluation"] },
  },
  {
    name: "submissions",
    label: "Submissions",
    role: "the ML submission steps: dataset, model, API packaging, with the community picks and the compute request",
    screens: ["contributor"],
    props: {},
    size: { w: 12, h: 8, minW: 8, minH: 5 },
    single: true,
    expects: { submissions: true },
  },
  {
    name: "submission_list",
    label: "Submission list",
    role: "every submitted URL, step by step, for the manager",
    screens: ["manage"],
    props: {},
    size: { w: 12, h: 5, minW: 6, minH: 3 },
    single: true,
    expects: { submissions: true },
  },
  {
    name: "compute",
    label: "Compute",
    role: "GPU compute requests (compute extension): the request for a participant, the decisions for a manager",
    screens: ["contributor", "manage"],
    props: {},
    size: { w: 12, h: 3, minW: 6, minH: 2 },
    single: true,
  },
  {
    name: "annotation",
    label: "Annotation",
    role: "the labeling workbench: one item at a time, the answers of the label schema, a skip",
    screens: ["contributor"],
    props: { schema_param: { kind: "text", label: "Schema param", hint: "the param holding {options: [{key, label}]} (label_schema)" } },
    size: { w: 12, h: 8, minW: 8, minH: 5 },
    single: true,
    expects: { lanes: ["annotator"] },
  },
  {
    name: "campaign",
    label: "Campaign",
    role: "the annotation campaign: imports, progress, annotators' accuracy, contested items, export",
    screens: ["manage"],
    props: { schema_param: { kind: "text", label: "Schema param", hint: "the param holding {options: [{key, label}]} (label_schema)" } },
    size: { w: 12, h: 8, minW: 8, minH: 5 },
    single: true,
    expects: { lanes: ["import", "resolve"] },
  },
];

const byName = new Map(UI_CATALOG.map((spec) => [spec.name, spec]));

export function uiComponent(name: string): UiComponentSpec | undefined {
  return byName.get(name);
}

/** Les composants qu'un écran admet. */
export function uiComponentsFor(screen: UiScreen): UiComponentSpec[] {
  return UI_CATALOG.filter((spec) => spec.screens.includes(screen));
}

/** Le déclencheur des lanes qu'un écran joue. */
export const LANE_TRIGGER_OF_SCREEN: Readonly<Record<UiScreen, "user" | "admin">> = { contributor: "user", manage: "admin" };
