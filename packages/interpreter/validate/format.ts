import type { z } from "zod";
import type { TemplateIssue, TemplatePath } from "../issues.js";
import {
  EFFECT_FAMILIES,
  NODE_FAMILIES,
  documentShell,
  gateBody,
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
 * Passe 1 — le format
 * -------------------
 * Contrôle la structure du document et rend un modèle où chaque nœud connaît
 * sa famille et son chemin. Les passes suivantes ne lisent que ce modèle.
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
}

export interface AggregateModel {
  decl: AggregateDecl;
  then: EffectModel[];
  path: TemplatePath;
}

export interface TemplateModel {
  shell: DocumentShell;
  lanes: LaneModel[];
  aggregates: AggregateModel[];
  onClose: EffectModel[];
}

function zodIssues(error: z.ZodError, base: TemplatePath): TemplateIssue[] {
  return error.issues.map((issue) => ({
    pass: "format" as const,
    severity: "error" as const,
    path: [...base, ...issue.path.map((key) => (typeof key === "symbol" ? String(key) : key))],
    message: issue.message,
  }));
}

/** Un élément à clé unique : `{collect: {...}}`, `{reward: {...}}`. */
function familyOf(item: Record<string, unknown>, families: readonly string[], path: TemplatePath, issues: TemplateIssue[]) {
  const keys = Object.keys(item);
  if (keys.length !== 1 || !families.includes(keys[0])) {
    issues.push({
      pass: "format",
      severity: "error",
      path,
      message: `expected exactly one of ${families.join(", ")}, got ${keys.length ? keys.join(", ") : "nothing"}`,
    });
    return null;
  }
  return keys[0];
}

function readNodes(items: readonly Record<string, unknown>[], base: TemplatePath, issues: TemplateIssue[]): NodeModel[] {
  const nodes: NodeModel[] = [];
  items.forEach((item, index) => {
    const path = [...base, index];
    const family = familyOf(item, Object.keys(NODE_FAMILIES), path, issues) as keyof typeof NODE_FAMILIES | null;
    if (!family) return;
    const bodyPath = [...path, family];
    const parsed = NODE_FAMILIES[family].safeParse(item[family]);
    if (!parsed.success) {
      issues.push(...zodIssues(parsed.error, bodyPath));
      return;
    }
    const body = parsed.data as { id?: string };
    const id = body.id ?? `${family}_${index}`;

    if (family === "gate") {
      const gate = parsed.data as z.infer<typeof gateBody>;
      if (Boolean(gate.all) === Boolean(gate.branch)) {
        issues.push({ pass: "format", severity: "error", path: bodyPath, node: id, message: "a gate has either `all` or `branch`" });
        return;
      }
      nodes.push({ family, id, body: gate, branches: gate.branch ? readBranches(gate.branch, [...bodyPath, "branch"], id, issues) : null, path: bodyPath });
      return;
    }
    nodes.push({ family, id, body: parsed.data, path: bodyPath } as NodeModel);
  });
  return nodes;
}

function readBranches(items: readonly Record<string, unknown>[], base: TemplatePath, gate: string, issues: TemplateIssue[]): BranchModel[] {
  const branches: BranchModel[] = [];
  items.forEach((item, index) => {
    const path = [...base, index];
    // `- else:` suivi de `nodes:` au même niveau se lit `{else: null, nodes}` ;
    // `- else: {nodes: []}` se lit `{else: {nodes}}`. Les deux sont admis.
    if ("else" in item) {
      const inner = item.else as Record<string, unknown> | null;
      const rawNodes = inner && typeof inner === "object" ? inner.nodes : item.nodes;
      const extra = Object.keys(item).filter((key) => key !== "else" && key !== "nodes");
      if (!Array.isArray(rawNodes) || extra.length > 0) {
        issues.push({ pass: "format", severity: "error", path, node: gate, message: "an else branch is `else: {nodes: [...]}`" });
        return;
      }
      branches.push({ when: null, nodes: readNodes(rawNodes, [...path, "nodes"], issues), path });
      return;
    }
    const extra = Object.keys(item).filter((key) => key !== "when" && key !== "nodes");
    if (item.when === undefined || !Array.isArray(item.nodes) || extra.length > 0) {
      issues.push({ pass: "format", severity: "error", path, node: gate, message: "a branch is `{when: <expr>, nodes: [...]}` or an else" });
      return;
    }
    branches.push({ when: item.when as ExprSource, nodes: readNodes(item.nodes, [...path, "nodes"], issues), path });
  });
  return branches;
}

function readEffects(items: readonly Record<string, unknown>[], base: TemplatePath, issues: TemplateIssue[]): EffectModel[] {
  const effects: EffectModel[] = [];
  items.forEach((item, index) => {
    const path = [...base, index];
    const family = familyOf(item, Object.keys(EFFECT_FAMILIES), path, issues) as EffectFamily | null;
    if (!family) return;
    const parsed = EFFECT_FAMILIES[family].safeParse(item[family]);
    if (!parsed.success) {
      issues.push(...zodIssues(parsed.error, [...path, family]));
      return;
    }
    effects.push({ family, body: parsed.data, path: [...path, family] } as EffectModel);
  });
  return effects;
}

export function validateFormat(raw: unknown): { model: TemplateModel | null; issues: TemplateIssue[] } {
  const parsed = documentShell.safeParse(raw);
  if (!parsed.success) return { model: null, issues: zodIssues(parsed.error, []) };

  const shell = parsed.data;
  const issues: TemplateIssue[] = [];
  const lanes = shell.lanes.map((lane, index) => ({
    id: lane.id,
    entry: lane.entry,
    nodes: readNodes(lane.nodes, ["lanes", index, "nodes"], issues),
    path: ["lanes", index],
  }));
  const aggregates = shell.lifecycle.aggregates.map((decl, index) => ({
    decl,
    then: readEffects(decl.resolve.then ?? [], ["lifecycle", "aggregates", index, "resolve", "then"], issues),
    path: ["lifecycle", "aggregates", index],
  }));
  const onClose = readEffects(shell.lifecycle.on_close, ["lifecycle", "on_close"], issues);

  return { model: issues.length ? null : { shell, lanes, aggregates, onClose }, issues };
}
