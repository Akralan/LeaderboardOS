import type { z } from "zod";
import type { TemplateIssue, TemplatePath } from "../issues.js";
import {
  DOCUMENT_KEYS,
  EFFECT_FAMILIES,
  LIFECYCLE_KEYS,
  NODE_FAMILIES,
  aggregateDecl,
  counterDecl,
  entryDecl,
  gateBody,
  paramDecl,
  presentationDecl,
  workspaceDecl,
  submissionsDecl,
  PARAM_NAME,
  requiresDecl,
  resourceDecl,
  statesDecl,
  templateHeader,
  type ActBody,
  type AggregateDecl,
  type AssessBody,
  type DocumentShell,
  type EffectFamily,
  type EntryDecl,
  type ExprSource,
  type RewardBody,
  type TransitionBody,
} from "../format/schema.js";

/**
 * Passe 1 — le format, en parse de sauvetage
 * ------------------------------------------
 * Contrôle la structure du document et rend un modèle où chaque nœud connaît
 * sa famille et son chemin. Les passes suivantes ne lisent que ce modèle.
 *
 * Un brouillon troué garde son modèle (templates-in-db, T2) : chaque section,
 * chaque entrée d'une section, chaque lane et chaque nœud se valident à part.
 * Ce qui ne tient pas est écarté du modèle, porte son diagnostic, et laisse un
 * **marqueur** (`broken`) : son nom, que l'analyse type `dyn` pour ne pas
 * rapporter en cascade ce qui y fait référence. Les passes suivantes analysent
 * tout ce qui tient debout. Un document sans erreur de format donne exactement
 * le modèle d'avant.
 */

export type NodeModel =
  | { family: "collect"; id: string; body: z.infer<(typeof NODE_FAMILIES)["collect"]>; path: TemplatePath }
  | { family: "act"; id: string; body: ActBody; path: TemplatePath }
  | { family: "assess"; id: string; body: AssessBody; path: TemplatePath }
  | { family: "gate"; id: string; body: z.infer<typeof gateBody>; branches: BranchModel[] | null; path: TemplatePath }
  | { family: "reward"; id: string; body: RewardBody; path: TemplatePath };

export interface BranchModel {
  /** `null` : la branche `else`. */
  when: ExprSource | null;
  nodes: NodeModel[];
  path: TemplatePath;
}

export type EffectModel =
  | { family: "transition"; body: TransitionBody; path: TemplatePath }
  | { family: "reward"; body: RewardBody; path: TemplatePath }
  | { family: "counters"; body: z.infer<(typeof EFFECT_FAMILIES)["counters"]>; path: TemplatePath };

export interface LaneModel {
  id: string;
  entry: EntryDecl;
  nodes: NodeModel[];
  path: TemplatePath;
  /** Les identifiants des nœuds écartés de cette lane : lus, ils valent `dyn`. */
  broken: string[];
}

export interface AggregateModel {
  decl: AggregateDecl;
  then: EffectModel[];
  path: TemplatePath;
}

/** Les marqueurs d'un modèle partiel : ce qui existe dans le document mais n'a pas passé le format. */
export interface BrokenParts {
  params: Set<string>;
  resources: Set<string>;
  counters: Set<string>;
  aggregates: Set<string>;
  lanes: Set<string>;
}

export interface TemplateModel {
  shell: DocumentShell;
  lanes: LaneModel[];
  aggregates: AggregateModel[];
  onClose: EffectModel[];
  broken: BrokenParts;
}

type Issues = TemplateIssue[];

/** `input` : la valeur validée — un trou de brouillon (une clé absente) se dit alors `missing <clé>`, pas un type attendu. */
function zodIssues(error: z.ZodError, base: TemplatePath, input?: unknown): TemplateIssue[] {
  return error.issues.map((issue) => {
    const relative = issue.path.map((key) => (typeof key === "symbol" ? String(key) : key));
    const path = [...base, ...relative];
    const missing = input !== undefined && relative.length > 0 && isAbsent(input, relative);
    return {
      pass: "format" as const,
      severity: "error" as const,
      path,
      message: missing && path.length > 0 ? `missing ${String(path[path.length - 1])}` : issue.message,
    };
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** La clé au bout de ce chemin manque, son parent existe. */
function isAbsent(input: unknown, path: readonly (string | number)[]): boolean {
  let parent: unknown = input;
  for (const key of path.slice(0, -1)) parent = parent && typeof parent === "object" ? (parent as Record<string, unknown>)[key as string] : undefined;
  return !!parent && typeof parent === "object" && (parent as Record<string, unknown>)[path[path.length - 1] as string] === undefined;
}
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

const formatIssue = (path: TemplatePath, message: string, node?: string): TemplateIssue => ({ pass: "format", severity: "error", path, message, ...(node ? { node } : {}) });

/** Un élément à clé unique : `{collect: {...}}`, `{reward: {...}}`. */
function familyOf(item: unknown, families: readonly string[], path: TemplatePath, issues: Issues) {
  const keys = isRecord(item) ? Object.keys(item) : [];
  if (keys.length !== 1 || !families.includes(keys[0])) {
    issues.push(formatIssue(path, `expected exactly one of ${families.join(", ")}, got ${keys.length ? keys.join(", ") : "nothing"}`));
    return null;
  }
  return keys[0];
}

/** L'identifiant lisible d'un nœud écarté, pour son marqueur. */
function readableId(body: unknown): string | null {
  return isRecord(body) && typeof body.id === "string" && IDENTIFIER.test(body.id) ? body.id : null;
}

function readNodes(items: readonly unknown[], base: TemplatePath, issues: Issues, broken: string[]): NodeModel[] {
  const nodes: NodeModel[] = [];
  items.forEach((item, index) => {
    const path = [...base, index];
    const family = familyOf(item, Object.keys(NODE_FAMILIES), path, issues) as keyof typeof NODE_FAMILIES | null;
    if (!family) return;
    const raw = (item as Record<string, unknown>)[family];
    const bodyPath = [...path, family];
    const parsed = NODE_FAMILIES[family].safeParse(raw);
    if (!parsed.success) {
      issues.push(...zodIssues(parsed.error, bodyPath, raw));
      const id = readableId(raw);
      if (id) broken.push(id);
      // Les nœuds d'une gate cassée : leurs propres diagnostics comptent, eux restent des marqueurs.
      if (family === "gate" && isRecord(raw) && Array.isArray(raw.branch)) readBranches(raw.branch, [...bodyPath, "branch"], id ?? "gate", issues, broken, true);
      return;
    }
    const body = parsed.data as { id?: string };
    const id = body.id ?? `${family}_${index}`;

    if (family === "gate") {
      const gate = parsed.data as z.infer<typeof gateBody>;
      if (Boolean(gate.all) === Boolean(gate.branch)) {
        issues.push(formatIssue(bodyPath, "a gate has either `all` or `branch`", id));
        broken.push(id);
        return;
      }
      if (!gate.branch) {
        nodes.push({ family, id, body: gate, branches: null, path: bodyPath });
        return;
      }
      const before = issues.length;
      const branches = readBranches(gate.branch, [...bodyPath, "branch"], id, issues, broken, false);
      // Une branche illisible fausserait la convergence : la gate entière devient un marqueur.
      if (issues.length > before && branches.length !== gate.branch.length) {
        broken.push(id, ...branches.flatMap((branch) => allIds(branch.nodes)));
        return;
      }
      nodes.push({ family, id, body: gate, branches, path: bodyPath });
      return;
    }
    nodes.push({ family, id, body: parsed.data, path: bodyPath } as NodeModel);
  });
  return nodes;
}

function allIds(nodes: readonly NodeModel[]): string[] {
  return nodes.flatMap((node) => [node.id, ...(node.family === "gate" && node.branches ? node.branches.flatMap((branch) => allIds(branch.nodes)) : [])]);
}

function readBranches(items: readonly unknown[], base: TemplatePath, gate: string, issues: Issues, broken: string[], markAll: boolean): BranchModel[] {
  const branches: BranchModel[] = [];
  items.forEach((item, index) => {
    const path = [...base, index];
    const record = isRecord(item) ? item : {};
    const read = (rawNodes: readonly unknown[]) => {
      const nodes = readNodes(rawNodes, [...path, "nodes"], issues, broken);
      if (markAll) broken.push(...allIds(nodes));
      return nodes;
    };
    // `- else:` suivi de `nodes:` au même niveau se lit `{else: null, nodes}` ;
    // `- else: {nodes: []}` se lit `{else: {nodes}}`. Les deux sont admis.
    if ("else" in record) {
      const inner = record.else as Record<string, unknown> | null;
      const rawNodes = inner && typeof inner === "object" ? inner.nodes : record.nodes;
      const extra = Object.keys(record).filter((key) => key !== "else" && key !== "nodes");
      if (!Array.isArray(rawNodes) || extra.length > 0) {
        issues.push(formatIssue(path, "an else branch is `else: {nodes: [...]}`", gate));
        return;
      }
      branches.push({ when: null, nodes: read(rawNodes), path });
      return;
    }
    const extra = Object.keys(record).filter((key) => key !== "when" && key !== "nodes");
    if (record.when === undefined || !Array.isArray(record.nodes) || extra.length > 0) {
      issues.push(formatIssue(path, "a branch is `{when: <expr>, nodes: [...]}` or an else", gate));
      return;
    }
    branches.push({ when: record.when as ExprSource, nodes: read(record.nodes), path });
  });
  return branches;
}

function readEffects(items: readonly unknown[], base: TemplatePath, issues: Issues): EffectModel[] {
  const effects: EffectModel[] = [];
  items.forEach((item, index) => {
    const path = [...base, index];
    const family = familyOf(item, Object.keys(EFFECT_FAMILIES), path, issues) as EffectFamily | null;
    if (!family) return;
    const parsed = EFFECT_FAMILIES[family].safeParse((item as Record<string, unknown>)[family]);
    if (!parsed.success) {
      issues.push(...zodIssues(parsed.error, [...path, family], (item as Record<string, unknown>)[family]));
      return;
    }
    effects.push({ family, body: parsed.data, path: [...path, family] } as EffectModel);
  });
  return effects;
}

/** Une section entière : sa valeur si elle tient, sinon `fallback` et ses diagnostics. */
function section<T>(schema: z.ZodType<T>, value: unknown, path: TemplatePath, fallback: T, issues: Issues): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  issues.push(...zodIssues(parsed.error, path, value));
  return fallback;
}

/** Une section en dictionnaire : chaque entrée à part ; une entrée cassée devient un marqueur. */
function entries<T>(schema: z.ZodType<T>, value: unknown, path: TemplatePath, issues: Issues, broken: Set<string>, names = IDENTIFIER): Record<string, T> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    issues.push(formatIssue(path, "expected a mapping"));
    return {};
  }
  const kept: Record<string, T> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!names.test(name)) {
      issues.push(formatIssue([...path, name], names === IDENTIFIER ? "an identifier is lower_snake_case" : "a param name is lower_snake_case or camelCase"));
      continue;
    }
    const parsed = schema.safeParse(entry);
    if (parsed.success) kept[name] = parsed.data;
    else {
      issues.push(...zodIssues(parsed.error, [...path, name], entry));
      broken.add(name);
    }
  }
  return kept;
}

function unknownKeys(value: Record<string, unknown>, known: readonly string[], path: TemplatePath, issues: Issues) {
  for (const key of Object.keys(value)) if (!known.includes(key)) issues.push(formatIssue([...path, key], `unknown key '${key}'`));
}

/**
 * Le modèle d'un document, partiel s'il le faut. `model` n'est `null` que
 * pour ce qui n'est pas un document du tout ; `complete` dit si rien n'a été
 * écarté.
 */
export function validateFormat(raw: unknown): { model: TemplateModel | null; issues: TemplateIssue[]; complete: boolean } {
  const issues: Issues = [];
  if (!isRecord(raw)) {
    return { model: null, issues: [formatIssue([], "a template is a YAML mapping")], complete: false };
  }
  const broken: BrokenParts = { params: new Set(), resources: new Set(), counters: new Set(), aggregates: new Set(), lanes: new Set() };
  unknownKeys(raw, DOCUMENT_KEYS, [], issues);

  if (raw.format !== "leaderboardos/1") issues.push(formatIssue(["format"], 'format is "leaderboardos/1"'));
  const template = section(templateHeader, raw.template, ["template"], { id: "draft", version: "0.0.0", name: "Draft", summary: "Draft" }, issues);
  const params = entries(paramDecl, raw.params, ["params"], issues, broken.params, PARAM_NAME);
  const requires = section(requiresDecl, raw.requires, ["requires"], { core: 1 }, issues);
  const resources = entries(resourceDecl, raw.resources, ["resources"], issues, broken.resources);
  const counters = entries(counterDecl, raw.counters, ["counters"], issues, broken.counters);
  const presentation = raw.presentation === undefined ? undefined : section(presentationDecl.optional(), raw.presentation, ["presentation"], undefined, issues);
  const workspace = raw.workspace === undefined ? undefined : section(workspaceDecl.optional(), raw.workspace, ["workspace"], undefined, issues);
  const submissions = raw.submissions === undefined ? undefined : section(submissionsDecl.optional(), raw.submissions, ["submissions"], undefined, issues);

  const lifecycleRaw = raw.lifecycle === undefined ? {} : raw.lifecycle;
  const lifecycle: DocumentShell["lifecycle"] = { aggregates: [], on_close: [] };
  const aggregates: AggregateModel[] = [];
  let onClose: EffectModel[] = [];
  if (!isRecord(lifecycleRaw)) {
    issues.push(formatIssue(["lifecycle"], "expected a mapping"));
  } else {
    unknownKeys(lifecycleRaw, LIFECYCLE_KEYS, ["lifecycle"], issues);
    if (lifecycleRaw.states !== undefined) lifecycle.states = section(statesDecl.optional(), lifecycleRaw.states, ["lifecycle", "states"], undefined, issues);
    const rawAggregates = lifecycleRaw.aggregates ?? [];
    if (!Array.isArray(rawAggregates)) issues.push(formatIssue(["lifecycle", "aggregates"], "expected a list"));
    else {
      rawAggregates.forEach((item, index) => {
        const path = ["lifecycle", "aggregates", index];
        const parsed = aggregateDecl.safeParse(item);
        if (!parsed.success) {
          issues.push(...zodIssues(parsed.error, path, item));
          const id = readableId(item);
          if (id) broken.aggregates.add(id);
          return;
        }
        lifecycle.aggregates.push(parsed.data);
        aggregates.push({ decl: parsed.data, then: readEffects(parsed.data.resolve.then ?? [], [...path, "resolve", "then"], issues), path });
      });
    }
    const rawOnClose = lifecycleRaw.on_close ?? [];
    if (!Array.isArray(rawOnClose)) issues.push(formatIssue(["lifecycle", "on_close"], "expected a list"));
    else {
      lifecycle.on_close = rawOnClose.filter(isRecord);
      onClose = readEffects(rawOnClose, ["lifecycle", "on_close"], issues);
    }
  }

  const lanes: LaneModel[] = [];
  const laneShells: DocumentShell["lanes"] = [];
  if (!Array.isArray(raw.lanes)) {
    issues.push(formatIssue(["lanes"], raw.lanes === undefined ? "a template declares its lanes" : "expected a list"));
  } else {
    if (raw.lanes.length === 0) issues.push(formatIssue(["lanes"], "a template has at least one lane"));
    raw.lanes.forEach((item, index) => {
      const path = ["lanes", index];
      if (!isRecord(item)) {
        issues.push(formatIssue(path, "a lane is `{id, entry, nodes}`"));
        return;
      }
      unknownKeys(item, ["id", "entry", "nodes"], path, issues);
      const idOk = typeof item.id === "string" && IDENTIFIER.test(item.id);
      if (!idOk) issues.push(formatIssue([...path, "id"], "a lane id is lower_snake_case"));
      const entry = entryDecl.safeParse(item.entry);
      if (!entry.success) issues.push(...zodIssues(entry.error, [...path, "entry"], item.entry));
      const brokenNodes: string[] = [];
      let nodes: NodeModel[] = [];
      if (!Array.isArray(item.nodes)) issues.push(formatIssue([...path, "nodes"], "expected a list"));
      else nodes = readNodes(item.nodes, [...path, "nodes"], issues, brokenNodes);

      // Sans identifiant ni entrée lisibles, la lane ne s'analyse pas : ses nœuds ont déjà rendu leurs diagnostics.
      if (!idOk || !entry.success || !Array.isArray(item.nodes)) {
        if (idOk) broken.lanes.add(item.id as string);
        return;
      }
      laneShells.push({ id: item.id as string, entry: entry.data, nodes: item.nodes.filter(isRecord) });
      lanes.push({ id: item.id as string, entry: entry.data, nodes, path, broken: brokenNodes });
    });
  }

  const shell: DocumentShell = { format: "leaderboardos/1", template, params, requires, resources, counters, presentation, workspace, submissions, lifecycle, lanes: laneShells };
  return { model: { shell, lanes, aggregates, onClose, broken }, issues, complete: issues.length === 0 };
}
