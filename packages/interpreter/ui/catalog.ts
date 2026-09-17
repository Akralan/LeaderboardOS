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

export type UiPropKind = "lane" | "text" | "markdown" | "bool";

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
