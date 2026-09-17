import type { CapabilityCatalog } from "../catalog.js";
import { readsRoot, type Expr } from "../expr/ast.js";
import { Scope, checkExpr, type Explain } from "../expr/checker.js";
import { ExprSyntaxError, parseExpr } from "../expr/parser.js";
import { T, assignable, isNumeric, isStringLike, showType, unify, type Type } from "../expr/types.js";
import type { ClaimUse, ExprSource, FieldDecl, RewardBody, TransitionBody } from "../format/schema.js";
import { ACT_KEYS } from "../format/schema.js";
import { TypeSyntaxError, parseTypeSpec, type TypeNode } from "../format/type-syntax.js";
import type { IssuePass, SupportGap, TemplateIssue, TemplatePath } from "../issues.js";
import type { BranchModel, EffectModel, LaneModel, NodeModel, TemplateModel } from "./format.js";

/**
 * Passes 2 à 6 — références, types, forme, économie, claims
 * ----------------------------------------------------------
 * Une seule traversée du modèle : construire le contexte d'un nœud (ce qu'il
 * voit) et vérifier ce qu'il en lit sont la même opération. Chaque problème
 * porte la passe à laquelle il appartient ; l'ordre des passes se rétablit au
 * tri, dans `checkTemplate`.
 *
 * La traversée relève aussi ce qu'un template valide utilise sans que la v1
 * sache le compiler (`SupportGap`).
 */

export interface AnalyzeOptions {
  catalog: CapabilityCatalog;
  /** La version du core que la distribution fournit (`requires: {core: N}`). */
  coreVersion: number;
  /** Une grille existe-t-elle (`model@1`) ? Absent : les grilles littérales ne sont pas vérifiées. */
  gridExists?: (ref: string) => boolean;
}

/** Un nœud dans l'ordre de sa lane : sa place et les branches qui l'enferment. */
interface Placement {
  seq: number;
  stack: readonly string[];
  node: NodeModel;
}

interface NodeContext {
  lane: LaneModel;
  placement: Placement;
  index: Map<string, Placement[]>;
}

/**
 * Les segments d'une lane : un geste interactif après un pas serveur (un Act,
 * une récompense…) reprend un contexte que seul un claim ou un run persistant
 * peut porter. Des gestes séparés seulement par des gates tiennent dans un
 * même formulaire.
 */
interface Segments {
  interactive: number;
  serverStep: boolean;
  claimed: boolean;
  gapped: boolean;
}

const ENGINE_FIELD_NAMES = ["id", "author", "open", "closed", "verdict", "created_at"];

export function analyzeTemplate(model: TemplateModel, options: AnalyzeOptions) {
  const issues: TemplateIssue[] = [];
  const gaps: SupportGap[] = [];
  /** Les champs résolus d'un collect ou d'une évaluation humaine : le compilateur en tire la validation des requêtes. */
  const nodeFields = new Map<NodeModel, Record<string, Type>>();
  const { shell } = model;

  const report = (pass: IssuePass, path: TemplatePath, message: string, extra: Partial<TemplateIssue> = {}) => {
    issues.push({ pass, severity: "error", path, message, ...extra });
  };
  const advise = (pass: IssuePass, path: TemplatePath, message: string, node?: string) => {
    issues.push({ pass, severity: "advisory", path, message, node });
  };
  const gap = (feature: string, path: TemplatePath, message: string, node?: string) => {
    gaps.push({ feature, path, message, node });
  };

  // ── Workspace ───────────────────────────────────────────────────────────
  const checkWorkspace = (scope: Scope) => {
    if (!shell.workspace) return;
    const { type } = expr(shell.workspace.mode, scope, ["workspace", "mode"]);
    const modes = type.kind === "enum" && type.values ? type.values : null;
    if (modes && modes.some((mode) => mode !== "provided_repo" && mode !== "own_repo")) {
      report("type", ["workspace", "mode"], `a workspace mode is provided_repo or own_repo, got ${showType(type)}`);
    } else if (!(type.kind === "enum" || type.kind === "string" || type.kind === "dyn")) {
      report("type", ["workspace", "mode"], `a workspace mode is provided_repo or own_repo, got ${showType(type)}`);
    }
  };

  // ── Header ──────────────────────────────────────────────────────────────
  if (shell.requires.core > options.coreVersion) {
    report("reference", ["requires", "core"], `requires core ${shell.requires.core}, this engine provides ${options.coreVersion}`);
  }

  // ── Types déclarés ──────────────────────────────────────────────────────
  const resourceNames = new Set(Object.keys(shell.resources));
  // Les marqueurs d'un modèle partiel (validate/format.ts) : ce qui y fait référence vaut `dyn`, sans erreur en cascade.
  const brokenResources = model.broken.resources;
  const partial =
    Object.values(model.broken).some((names) => names.size > 0) || model.lanes.some((lane) => lane.broken.length > 0);
  const resourceFieldTypes = new Map<string, Record<string, Type>>();
  const env = {
    resourceFields: (name: string) => resourceFieldTypes.get(name),
  };

  /** Évalue une expression : parse, typage, et rapport des erreurs à sa place. */
  const expr = (
    source: ExprSource,
    scope: Scope,
    path: TemplatePath,
    node?: string
  ): { type: Type; ast: Expr | null } => {
    if (typeof source === "number") return { type: Number.isInteger(source) ? T.int : T.number, ast: null };
    if (typeof source === "boolean") return { type: T.bool, ast: null };
    let ast: Expr;
    try {
      ast = parseExpr(source);
    } catch (error) {
      if (!(error instanceof ExprSyntaxError)) throw error;
      report("format", path, `expression syntax: ${error.message}`, { node, position: error.position });
      return { type: T.dyn, ast: null };
    }
    const result = checkExpr(ast, scope, env);
    for (const issue of result.issues) report(issue.pass, path, issue.message, { node, position: issue.position });
    return { type: result.type, ast };
  };

  const expectType = (actual: Type, expected: (type: Type) => boolean, what: string, path: TemplatePath, node?: string) => {
    if (!expected(actual)) report("type", path, `${what}, got ${showType(actual)}`, { node });
  };
  const isBool = (type: Type) => type.kind === "bool" || type.kind === "dyn";

  /** `params.x` écrit tel quel : le nom du paramètre, sinon `null`. */
  const paramName = (source: ExprSource | undefined): string | null => {
    if (typeof source !== "string") return null;
    const match = /^\s*params\.([a-z][a-z0-9_]*)\s*$/.exec(source);
    return match ? match[1] : null;
  };

  // Les paramètres d'abord sans leurs énumérations tirées d'expressions, qui
  // lisent d'autres paramètres.
  const paramTypes: Record<string, Type> = {};
  const typeNodes = new Map<string, TypeNode>();
  for (const [name, param] of Object.entries(shell.params)) {
    try {
      typeNodes.set(name, parseTypeSpec(param.type));
    } catch (error) {
      if (!(error instanceof TypeSyntaxError)) throw error;
      report("format", ["params", name, "type"], error.message);
      paramTypes[name] = T.dyn;
    }
  }

  const resolveType = (node: TypeNode, path: TemplatePath, paramsScope: Scope | null): Type => {
    switch (node.k) {
      case "name":
        switch (node.name) {
          case "ratio":
            return T.number;
          case "points":
            return T.int;
          case "json":
          case "expr":
            return T.dyn;
          case "grid_ref":
            return T.grid;
          case "template_ref":
            return T.template;
          case "challenge_ref":
            return T.challenge;
          case "link":
            return T.contribution;
          default:
            return T[node.name as "string"];
        }
      case "enum":
        return T.enum(node.values);
      case "enum_expr": {
        if (!paramsScope) return T.enum(null);
        const { type } = expr(node.source, paramsScope, path);
        if (type.kind !== "list" && type.kind !== "dyn") report("type", path, `enum(...) needs a list, got ${showType(type)}`);
        const element = type.kind === "list" ? type.of : T.dyn;
        // Un choix parmi des références (templates, grilles…) garde leur type.
        if (element.kind === "enum" || (isStringLike(element) && element.kind !== "string")) return element;
        return T.enum(null);
      }
      case "ref":
        if (!resourceNames.has(node.resource)) {
          brokenResources.has(node.resource) || report("reference", path, `unknown resource type '${node.resource}'`);
          return T.dyn;
        }
        return T.resource(node.resource);
      case "list":
        return T.list(resolveType(node.of, path, paramsScope));
      case "optional":
        return T.optional(resolveType(node.of, path, paramsScope));
      case "record": {
        const fields: Record<string, Type> = {};
        for (const [key, value] of Object.entries(node.fields)) fields[key] = resolveType(value, path, paramsScope);
        return T.record(fields);
      }
    }
  };

  for (const [name, node] of typeNodes) paramTypes[name] = resolveType(node, ["params", name, "type"], null);
  for (const name of model.broken.params) paramTypes[name] = T.dyn;
  const paramsScope = Scope.root({ params: T.record(paramTypes) });
  for (const [name, node] of typeNodes) {
    if (JSON.stringify(node).includes("enum_expr")) {
      paramTypes[name] = resolveType(node, ["params", name, "type"], paramsScope);
    }
  }
  for (const [name, param] of Object.entries(shell.params)) {
    if (param.check !== undefined) {
      const scope = paramsScope.with({ value: paramTypes[name] });
      const { type } = expr(param.check, scope, ["params", name, "check"]);
      expectType(type, isBool, "a param check must be bool", ["params", name, "check"]);
    }
    for (const [check, source] of Object.entries(param.checks ?? {})) {
      const scope = paramsScope.with({ value: paramTypes[name] });
      const { type } = expr(source, scope, ["params", name, "checks", check]);
      expectType(type, isBool, "a param check must be bool", ["params", name, "checks", check]);
    }
  }

  const counterTypes: Record<string, Type> = {};
  for (const [name, counter] of Object.entries(shell.counters)) {
    counterTypes[name] = counter.type === "int" || counter.type === "points" ? T.int : T.number;
  }
  for (const name of model.broken.counters) counterTypes[name] = T.dyn;

  // Les champs des ressources, puis leurs colonnes du moteur.
  const declaredFieldTypes = (fields: Record<string, FieldDecl>, base: TemplatePath): Record<string, Type> => {
    const types: Record<string, Type> = {};
    for (const [key, field] of Object.entries(fields)) {
      const path = [...base, key, "type"];
      try {
        types[key] = resolveType(parseTypeSpec(field.type), path, paramsScope);
      } catch (error) {
        if (!(error instanceof TypeSyntaxError)) throw error;
        report("format", path, error.message);
        types[key] = T.dyn;
      }
    }
    return types;
  };

  for (const [name, resource] of Object.entries(shell.resources)) {
    const fields = declaredFieldTypes(resource.fields, ["resources", name, "fields"]);
    for (const reserved of ENGINE_FIELD_NAMES) {
      if (reserved in fields) report("shape", ["resources", name, "fields", reserved], `'${reserved}' is an engine column and cannot be declared`);
    }
    const verdicts = resource.closure?.verdict;
    resourceFieldTypes.set(name, {
      ...fields,
      id: T.string,
      author: T.user,
      open: T.bool,
      closed: T.bool,
      verdict: verdicts ? T.enum(verdicts) : T.string,
      created_at: T.date,
    });
  }

  const baseBindings: Record<string, Type> = {
    params: T.record(paramTypes),
    counters: T.record(counterTypes),
    challenge: T.record({ state: T.enum(["draft", "open", "closed"]), title: T.string }),
    // Le porteur, le groupe et le workspace de l'appelant (capacités `groups` et `workspaces`) ; en solo, le porteur est l'appelant.
    participation: T.record({
      user: T.user,
      holder: T.user,
      group: T.record({ size: T.int, multiplier: T.number, members: T.list(T.user) }),
      workspace: T.record({ provider: T.string, url: T.string, ref: T.string, status: T.string, ready: T.bool }),
      // Le rôle de plateforme de l'appelant (`contributor`, `admin`…), et, par paramètre `role`, s'il détient cette qualification.
      role: T.string,
      qualified: T.record(Object.fromEntries(Object.entries(paramTypes).filter(([, type]) => type.kind === "role").map(([name]) => [name, T.bool]))),
    }),
  };
  if (shell.presentation?.board) baseBindings.board = T.record({ total: T.int, done: T.int });
  for (const name of resourceNames) baseBindings[name] = T.list(T.resource(name));
  for (const name of brokenResources) baseBindings[name] = T.dyn;
  const base = Scope.root(baseBindings);
  checkWorkspace(base);

  // ── Soumissions ─────────────────────────────────────────────────────────
  /** Les rôles de dépôt que le core connaît (`challenge_repos.role`). */
  const SUBMISSION_ROLES = ["dataset", "model", "model_code", "api"];
  const author = T.record({ author: T.user, contribution: T.string, weight: T.number });
  const submissionType = shell.submissions
    ? T.record({
        step: T.string,
        url: T.url,
        repo: T.string,
        contribution: T.string,
        lineage: T.record({
          artifacts: T.record(Object.fromEntries(Object.values(shell.submissions.steps).filter((step) => step.artifact).map((step) => [step.contribution, author]))),
          selection: T.list(author),
        }),
      })
    : null;
  if (shell.submissions) {
    const steps = shell.submissions.steps;
    for (const [role, step] of Object.entries(steps)) {
      const at = ["submissions", "steps", role];
      if (!SUBMISSION_ROLES.includes(role)) report("reference", at, `a submission step is a repo role: ${SUBMISSION_ROLES.join(", ")}`);
      if (step.open !== undefined) {
        const { type } = expr(step.open, base, [...at, "open"]);
        expectType(type, isBool, "a step's open condition must be bool", [...at, "open"]);
      }
    }
    if (shell.submissions.selection !== undefined && !steps[shell.submissions.selection]) {
      report("reference", ["submissions", "selection"], `selection names no step '${shell.submissions.selection}'`);
    }
    if (shell.workspace) report("shape", ["submissions"], "a template declares workspace or submissions, not both: both serve PATCH workspace");
  }
  const submissionLanes = new Map<string, string>();

  /** Les règles de visibilité : `author`, `admin`, `claimant`, `everyone`, `role(params.x)`. */
  const checkVisibility = (entries: readonly string[] | undefined, path: TemplatePath) => {
    for (const [index, entry] of (entries ?? []).entries()) {
      if (["author", "admin", "claimant", "everyone"].includes(entry)) continue;
      const role = /^role\((.+)\)$/.exec(entry);
      if (role) {
        const { type } = expr(role[1], base, [...path, index]);
        expectType(type, (t) => t.kind === "role" || t.kind === "dyn", "role(...) takes a role", [...path, index]);
        continue;
      }
      report("reference", [...path, index], `unknown visibility '${entry}'`);
    }
  };

  /** `trim` rogne une chaîne, `public` garde une URL : chacun sur son type. */
  const checkFieldOptions = (field: FieldDecl, type: Type, path: TemplatePath, node?: string) => {
    if (field.trim && type.kind !== "string" && type.kind !== "dyn") report("shape", [...path, "trim"], "trim applies to a string field", { node });
    if (field.public && type.kind !== "url" && type.kind !== "dyn") report("shape", [...path, "public"], "public applies to a url field", { node });
  };

  const collectFieldTypes = (fields: Record<string, FieldDecl>, basePath: TemplatePath, scope: Scope, node?: string) => {
    const types = declaredFieldTypes(fields, basePath);
    for (const [key, field] of Object.entries(fields)) {
      const path = [...basePath, key];
      checkVisibility(field.visibility, [...path, "visibility"]);
      const type = types[key];
      if (field.from !== undefined) {
        if (type.kind !== "contribution") report("shape", [...path, "from"], "`from` only applies to a link field", { node });
        const { type: fromType } = expr(field.from, scope, [...path, "from"], node);
        expectType(fromType, (t) => t.kind === "challenge" || t.kind === "dyn", "a link comes from a challenge", [...path, "from"], node);
      } else if (type.kind === "contribution") {
        report("shape", path, "a link field needs `from: params.<challenge>`", { node });
      }
      if (field.where !== undefined) {
        if (type.kind !== "resource") report("shape", [...path, "where"], "`where` only filters a ref field", { node });
        const { type: whereType } = expr(field.where, scope.with({ [key]: type }), [...path, "where"], node);
        expectType(whereType, isBool, "a where filter must be bool", [...path, "where"], node);
      }
      if (field.when !== undefined) {
        const { type: whenType } = expr(field.when, scope.with(types), [...path, "when"], node);
        expectType(whenType, isBool, "a when condition must be bool", [...path, "when"], node);
      }
      if (field.check !== undefined) {
        const { type: checkType } = expr(field.check, scope.with({ value: type }), [...path, "check"], node);
        expectType(checkType, isBool, "a field check must be bool", [...path, "check"], node);
      }
      checkFieldOptions(field, type, path, node);
    }
    return types;
  };

  // ── Ressources : visibilité, claims, fermeture ──────────────────────────
  for (const [name, resource] of Object.entries(shell.resources)) {
    const path = ["resources", name];
    for (const [key, field] of Object.entries(resource.fields)) {
      checkVisibility(field.visibility, [...path, "fields", key, "visibility"]);
      if (field.check !== undefined) {
        // Évalué à chaque création, imports compris : la valeur et les paramètres, rien d'autre.
        const at = [...path, "fields", key, "check"];
        const { type } = expr(field.check, Scope.root({ params: T.record(paramTypes), value: resourceFieldTypes.get(name)![key] }), at);
        expectType(type, isBool, "a field check must be bool", at);
      }
      if (field.public) report("shape", [...path, "fields", key, "public"], "public applies to a collected url field, checked when it is sent");
      if (field.trim) report("shape", [...path, "fields", key, "trim"], "trim applies to a collected field");
      for (const misplaced of ["where", "when", "from"] as const) {
        if (field[misplaced] !== undefined && !(misplaced === "from" && field.type === "link")) {
          report("shape", [...path, "fields", key, misplaced], `${misplaced} applies to a collected field, not to a resource field`);
        }
      }
    }
    const claim = resource.claim;
    if (claim) {
      const claimPath = [...path, "claim"];
      if (claim.mode === "k_bounded") {
        if (claim.k === undefined) report("claim", claimPath, "k_bounded needs k");
        else {
          const { type } = expr(claim.k, base, [...claimPath, "k"]);
          expectType(type, (t) => t.kind === "int" || t.kind === "dyn", "k must be int", [...claimPath, "k"]);
        }
      } else if (claim.k !== undefined) {
        report("claim", [...claimPath, "k"], `k only applies to k_bounded, not ${claim.mode}`);
      }
      if (claim.ttl !== undefined && claim.mode === "unbounded") {
        report("claim", [...claimPath, "ttl"], "an unbounded claim holds nothing; it has no TTL");
      }
      if (typeof claim.ttl === "string" && /^[0-9]+[mhd]$/.test(claim.ttl)) {
        if (Number.parseInt(claim.ttl, 10) <= 0) report("claim", [...claimPath, "ttl"], "a TTL must be positive");
      } else if (claim.ttl !== undefined) {
        const { type } = expr(claim.ttl, base, [...claimPath, "ttl"]);
        expectType(type, (t) => isNumeric(t), "a TTL is a duration (48h) or a number of hours", [...claimPath, "ttl"]);
      }
      if (claim.mode === "unique_per") {
        const dims = claim.dimensions ?? [];
        if (dims.length === 0) report("claim", claimPath, "unique_per needs dimensions");
        if (!dims.includes("self")) report("claim", [...claimPath, "dimensions"], "unique_per dimensions include `self`, the claimed resource");
        if (new Set(dims).size !== dims.length) report("claim", [...claimPath, "dimensions"], "duplicate dimension");
      } else if (claim.dimensions) {
        report("claim", [...claimPath, "dimensions"], `dimensions only apply to unique_per, not ${claim.mode}`);
      }
      if (claim.where !== undefined) {
        const { type } = expr(claim.where, base.with({ self: T.resource(name) }), [...claimPath, "where"]);
        expectType(type, isBool, "a claim eligibility rule must be bool", [...claimPath, "where"]);
        gap("claim eligibility on a resource type", [...claimPath, "where"], "the resources capability filters draws by class only");
      }
    }
    if (resource.ordered_by !== undefined) {
      const orderType = resourceFieldTypes.get(name)![resource.ordered_by];
      if (!orderType || ENGINE_FIELD_NAMES.includes(resource.ordered_by)) {
        report("reference", [...path, "ordered_by"], `ordered_by '${resource.ordered_by}': no such field`);
      } else if (orderType.kind !== "int" && orderType.kind !== "dyn") {
        report("type", [...path, "ordered_by"], `ordered_by names an int field, got ${showType(orderType)}`);
      }
    }
    if (resource.cardinality) {
      const { type } = expr(resource.cardinality.exactly, base, [...path, "cardinality", "exactly"]);
      expectType(type, (t) => t.kind === "int" || t.kind === "dyn", "a cardinality must be int", [...path, "cardinality", "exactly"]);
    }
    if (resource.match_or_create) {
      const by = resource.match_or_create.by;
      if (by !== "human" && !(by in resource.fields)) {
        report("reference", [...path, "match_or_create", "by"], `match_or_create by '${by}': no such field`);
      }
      gap("match-or-create", [...path, "match_or_create"], "emergent resources are not compiled in v1");
    }
  }

  // ── Index des lanes : ordre des nœuds, créateurs, émetteurs ─────────────
  const laneIndexes = new Map<LaneModel, Map<string, Placement[]>>();
  const placements = new Map<NodeModel, Placement>();
  const laneIds = new Set<string>();

  for (const lane of model.lanes) {
    if (laneIds.has(lane.id)) report("shape", [...lane.path, "id"], `duplicate lane id '${lane.id}'`);
    laneIds.add(lane.id);
    const index = new Map<string, Placement[]>();
    let seq = 0;
    const place = (nodes: NodeModel[], stack: readonly string[]) => {
      for (const node of nodes) {
        const placement = { seq: seq++, stack, node };
        placements.set(node, placement);
        const existing = index.get(node.id) ?? [];
        if (existing.length > 0) report("shape", node.path, `duplicate node id '${node.id}' in lane '${lane.id}'`, { node: node.id });
        index.set(node.id, [...existing, placement]);
        if (node.family === "gate" && node.branches) {
          node.branches.forEach((branch, i) => place(branch.nodes, [...stack, `${node.id}#${i}`]));
        }
      }
    };
    place(lane.nodes, []);
    laneIndexes.set(lane, index);
  }

  const allNodes = (nodes: NodeModel[]): NodeModel[] =>
    nodes.flatMap((node) => [node, ...(node.family === "gate" && node.branches ? node.branches.flatMap((b) => allNodes(b.nodes)) : [])]);

  // `created_by` : chaque créateur existe, crée bien cette ressource, et
  // chaque Act qui crée une ressource figure dans sa liste.
  const creators = new Map<string, string[]>();
  for (const lane of model.lanes) {
    for (const node of allNodes(lane.nodes)) {
      if (node.family === "act" && node.body.create) {
        creators.set(node.body.create, [...(creators.get(node.body.create) ?? []), `${lane.id}.${node.id}`]);
      }
    }
  }
  for (const [name, resource] of Object.entries(shell.resources)) {
    const declared = resource.created_by ?? [];
    const actual = creators.get(name) ?? [];
    declared.forEach((entry, i) => {
      // Un créateur dans une lane ou un nœud écartés : il existe, le format l'a déjà dit.
      const [laneId, nodeId] = entry.split(".");
      if (model.broken.lanes.has(laneId) || model.lanes.find((lane) => lane.id === laneId)?.broken.includes(nodeId)) return;
      if (!actual.includes(entry)) {
        report("reference", ["resources", name, "created_by", i], `'${entry}' is not an act creating ${name}`);
      }
    });
    for (const entry of actual) {
      if (!declared.includes(entry)) report("reference", ["resources", name, "created_by"], `act '${entry}' creates ${name} but is not listed in created_by`);
    }
  }

  // Les entrées d'un Aggregate : ce que ses émetteurs produisent.
  const aggregateIds = new Map(model.aggregates.map((aggregate) => [aggregate.decl.id, aggregate]));
  const inputFields = new Map<string, Record<string, Type>>();
  for (const lane of model.lanes) {
    const laneNodes = allNodes(lane.nodes);
    for (const node of laneNodes) {
      if (node.family !== "assess" || !node.body.emit) continue;
      const target = /^lifecycle\.([a-z][a-z0-9_]*)$/.exec(node.body.emit.to);
      if (!target || !aggregateIds.has(target[1])) continue;
      let fields: Record<string, Type> = {};
      if (node.body.kind === "metric") fields = { value: T.dyn };
      else if (node.body.fields) fields = declaredFieldTypes(node.body.fields, []);
      else if (node.body.from) {
        const source = laneNodes.find((candidate) => candidate.id === node.body.from && candidate.family === "collect");
        if (source && source.family === "collect") fields = declaredFieldTypes(source.body.fields, []);
      }
      const previous = inputFields.get(target[1]);
      if (!previous) inputFields.set(target[1], fields);
      else {
        const merged: Record<string, Type> = { ...previous };
        for (const [key, type] of Object.entries(fields)) merged[key] = previous[key] ? unify(previous[key], type) ?? T.dyn : type;
        inputFields.set(target[1], merged);
      }
    }
  }
  /** Sans émetteur valide, les entrées restent `dyn` : une seule erreur, sur l'`emit` cassé. */
  const inputType = (aggregate: string): Type => {
    const fields = inputFields.get(aggregate);
    return fields ? T.record({ ...fields, participation: T.record({ user: T.user }), author: T.user, claim: T.string }) : T.dyn;
  };

  // ── Aggregates ──────────────────────────────────────────────────────────
  const verdictTypes = new Map<string, Type>();
  const ruleKeys = new Map<string, TemplatePath>();
  /** Ce qu'un `reverse` peut nommer : un `rule_key` écrit, ou `<lane>.<nœud>` d'une récompense de lane. */
  const rewardKeys = new Set<string>();
  for (const lane of model.lanes) {
    for (const node of allNodes(lane.nodes)) {
      if (node.family !== "reward") continue;
      rewardKeys.add(`${lane.id}.${node.id}`);
      if (node.body.rule_key) rewardKeys.add(node.body.rule_key);
    }
  }
  for (const effect of [...model.aggregates.flatMap((aggregate) => aggregate.then), ...model.onClose]) {
    if (effect.family === "reward" && effect.body.rule_key) rewardKeys.add(effect.body.rule_key);
  }

  /** `aggregates.<id>` vu depuis une instance de `resource` : son verdict, ses entrées. */
  const aggregatesOver = (resource: string): Type => {
    const fields: Record<string, Type> = {};
    for (const aggregate of model.aggregates) {
      if (aggregate.decl.over !== resource) continue;
      fields[aggregate.decl.id] = T.record({
        verdict: verdictTypes.get(aggregate.decl.id) ?? T.dyn,
        inputs: T.list(inputType(aggregate.decl.id)),
        count: T.int,
      });
    }
    // Un aggregate écarté se lit quand même : `aggregates.<id>` vaut `dyn`.
    if (model.broken.aggregates.size > 0) {
      for (const id of model.broken.aggregates) fields[id] = T.dyn;
    }
    return T.record(fields);
  };

  for (const aggregate of model.aggregates) {
    const { decl, path } = aggregate;
    if (!resourceNames.has(decl.over)) {
      brokenResources.has(decl.over) || report("reference", [...path, "over"], `unknown resource type '${decl.over}'`);
      continue;
    }
    const closure = shell.resources[decl.over].closure;
    const closers = closure ? [closure.by].flat() : [];
    if (aggregate.then.some((effect) => effect.family === "transition") && !closers.includes("aggregate")) {
      report("shape", [...path, "resolve", "then"], `${decl.over} is not closed by an aggregate (closure.by)`);
    }
    if (!inputFields.has(decl.id)) advise("shape", path, `aggregate '${decl.id}' has no emitter`);

    const scope = base.with({ inputs: T.list(inputType(decl.id)), [decl.over]: T.resource(decl.over) });
    const { type: whenType } = expr(decl.resolve.when, scope, [...path, "resolve", "when"]);
    expectType(whenType, isBool, "a resolve condition must be bool", [...path, "resolve", "when"]);
    let verdict: Type = T.dyn;
    if (decl.resolve.verdict !== undefined) verdict = expr(decl.resolve.verdict, scope, [...path, "resolve", "verdict"]).type;
    verdictTypes.set(decl.id, verdict);

    const thenScope = scope.with({ verdict });
    for (const effect of aggregate.then) checkEffect(effect, thenScope, "aggregate");
  }

  // ── Cycle de vie ────────────────────────────────────────────────────────
  const states = shell.lifecycle.states;
  if (states && typeof states === "object" && states.close_at !== undefined) {
    const { type } = expr(states.close_at, base, ["lifecycle", "states", "close_at"]);
    expectType(type, (t) => t.kind === "date" || t.kind === "dyn", "close_at must be a date", ["lifecycle", "states", "close_at"]);
    gap("scheduled close", ["lifecycle", "states", "close_at"], "closing a challenge at a date is not compiled in v1");
  }
  for (const effect of model.onClose) checkEffect(effect, base, "on_close");

  // ── Lanes ───────────────────────────────────────────────────────────────
  for (const lane of model.lanes) checkLane(lane);

  return { issues, gaps, types: { params: paramTypes, counters: counterTypes, resources: resourceFieldTypes, nodeFields, verdicts: verdictTypes } };

  // ────────────────────────────────────────────────────────────────────────

  function checkLane(lane: LaneModel) {
    const { entry } = lane;
    const entryPath = [...lane.path, "entry"];
    const bindings: Record<string, Type> = {};
    // Les nœuds écartés de la lane : leurs lectures valent `dyn`.
    for (const id of lane.broken) bindings[id] = T.dyn;

    if (entry.trigger === "submission") {
      if (!submissionType) report("reference", entryPath, "a submission lane needs a submissions declaration");
      else bindings.submission = submissionType;
      if (!entry.step || !shell.submissions?.steps[entry.step]) {
        report("reference", [...entryPath, "step"], `a submission lane names a declared step${entry.step ? `, not '${entry.step}'` : ""}`);
      } else if (submissionLanes.has(entry.step)) {
        report("shape", [...entryPath, "step"], `step '${entry.step}' is already played by lane '${submissionLanes.get(entry.step)}'`);
      } else {
        submissionLanes.set(entry.step, lane.id);
      }
    } else if (entry.step !== undefined) {
      report("shape", [...entryPath, "step"], "step belongs to a submission lane");
    }
    if ((entry.trigger === "user") !== Boolean(entry.access)) {
      report("shape", entryPath, entry.trigger === "user" ? "a user lane declares its access" : `a ${entry.trigger} lane has no access`);
    }
    if (entry.trigger === "cron") {
      if (!entry.schedule) report("shape", entryPath, "a cron lane needs a schedule");
      if (entry.over) {
        if (!resourceNames.has(entry.over.resource)) brokenResources.has(entry.over.resource) || report("reference", [...entryPath, "over", "resource"], `unknown resource type '${entry.over.resource}'`);
        else {
          bindings[entry.over.resource] = T.resource(entry.over.resource);
          bindings.aggregates = aggregatesOver(entry.over.resource);
        }
        const scope = base.with(bindings);
        if (entry.over.where !== undefined) {
          const { type } = expr(entry.over.where, scope, [...entryPath, "over", "where"]);
          expectType(type, isBool, "a cron selection must be bool", [...entryPath, "over", "where"]);
        }
        if (entry.cursor === "engine" && !selectsClosed(entry.over.where, entry.over.resource)) {
          gap("cursor over open resources", [...entryPath, "over", "where"], `the engine cursor marks closed resources only; select ${entry.over.resource}.closed first`);
        }
        if (entry.over.sample !== undefined) {
          const { type } = expr(entry.over.sample, scope, [...entryPath, "over", "sample"]);
          expectType(type, isNumeric, "a sample rate must be a number", [...entryPath, "over", "sample"]);
        }
      }
    } else if (entry.schedule || entry.over || entry.cursor) {
      report("shape", entryPath, "schedule, over and cursor belong to cron lanes");
    }
    if (entry.trigger === "webhook") {
      if (!entry.dedup) report("shape", entryPath, "a webhook lane needs dedup");
      bindings.webhook = T.record({ payload: T.dyn, external_id: T.string });
      gap("webhook trigger", entryPath, "webhook triggers are out of v1");
    } else if (entry.dedup) {
      report("shape", entryPath, "dedup belongs to webhook lanes");
    }

    const access = entry.access;
    if (access) {
      const accessPath = [...entryPath, "access"];
      if (access.mode === "role") {
        if (access.role === undefined) report("shape", accessPath, "a role access names its role");
        else {
          const { type } = expr(access.role, base, [...accessPath, "role"]);
          expectType(type, (t) => t.kind === "role" || t.kind === "dyn", "access role must be a role", [...accessPath, "role"]);
        }
      } else if (access.role !== undefined) {
        report("shape", [...accessPath, "role"], "role belongs to mode: role");
      }
      if (access.mode === "author_of") {
        if (!access.resource || !resourceNames.has(access.resource)) {
          if (!(access.resource && brokenResources.has(access.resource))) report("reference", [...accessPath, "resource"], `author_of needs a declared resource type`);
        }
        else bindings[access.resource] = T.resource(access.resource);
      }
      if (access.group !== undefined) {
        bindings.group = T.record({ members: T.list(T.user), size: T.int, multiplier: T.number });
        // `group: true` : la politique de groupe de la plateforme (3 membres, bonus 1 / 1.4 / 1.8), compilée.
        if (access.group !== true) {
          expr(access.group, base, [...accessPath, "group"]);
          gap("group participation", [...accessPath, "group"], "a custom group policy is not compiled in v1; group: true uses the platform's");
        }
      }
      if (access.stake) {
        const { type } = expr(access.stake.amount, base, [...accessPath, "stake", "amount"]);
        expectType(type, isNumeric, "a stake must be a number", [...accessPath, "stake", "amount"]);
        gap("stake", [...accessPath, "stake"], "stake, slash and refund economics are out of v1");
      }
    }

    const index = laneIndexes.get(lane)!;
    const segments: Segments = { interactive: 0, serverStep: false, claimed: false, gapped: false };
    walk(lane, lane.nodes, base.with(bindings), index, segments);
  }

  /** `R.closed`, ou une conjonction qui commence par lui. */
  function selectsClosed(where: ExprSource | undefined, resource: string): boolean {
    if (typeof where !== "string") return false;
    let ast: Expr;
    try {
      ast = parseExpr(where);
    } catch {
      return false;
    }
    while (ast.k === "binary" && ast.op === "&&") ast = ast.left;
    return ast.k === "member" && ast.name === "closed" && ast.object.k === "ident" && ast.object.name === resource;
  }

  function explainFor(ctx: NodeContext): Explain {
    return (name) => {
      const candidates = ctx.index.get(name);
      if (!candidates) return undefined;
      const { seq, stack } = ctx.placement;
      const earlier = candidates.find((candidate) => candidate.seq < seq);
      if (!earlier) {
        return { pass: "shape", message: `'${name}' is produced later in lane '${ctx.lane.id}'` };
      }
      const outside = earlier.stack.find((frame, i) => stack[i] !== frame);
      if (outside) {
        const gateId = outside.split("#")[0];
        return { pass: "shape", message: `'${name}' is produced inside a branch of gate '${gateId}'; branches converge, their values do not` };
      }
      return undefined;
    };
  }

  function walk(
    lane: LaneModel,
    nodes: NodeModel[],
    scope: Scope,
    index: Map<string, Placement[]>,
    segments: Segments
  ): Scope {
    let current = scope;
    for (const node of nodes) {
      const ctx: NodeContext = { lane, placement: placements.get(node)!, index };
      const nodeScope = current.with({}, explainFor(ctx));
      const output = checkNode(node, nodeScope, ctx, segments);
      if (output) current = current.with({ [node.id]: output });
      const gesture = node.family === "collect" || (node.family === "assess" && node.body.kind === "human" && Boolean(node.body.fields));
      if (!gesture && node.family !== "gate") segments.serverStep = true;
    }
    return current;
  }

  /** Un segment interactif après un premier : sans claim pour porter le contexte, il faut un run persistant. */
  function interactive(node: NodeModel, ctx: NodeContext, segments: Segments) {
    if (segments.interactive > 0 && segments.serverStep && !segments.claimed && !segments.gapped) {
      segments.gapped = true;
      gap("multi-segment run", node.path, `lane '${ctx.lane.id}' carries context across interactive segments without a claim; it needs flow_runs`, node.id);
    }
    segments.interactive++;
    segments.serverStep = false;
  }

  function checkNode(
    node: NodeModel,
    scope: Scope,
    ctx: NodeContext,
    segments: Segments
  ): Type | null {
    switch (node.family) {
      case "collect":
        interactive(node, ctx, segments);
        nodeFields.set(node, collectFieldTypes(node.body.fields, [...node.path, "fields"], scope, node.id));
        return T.record(nodeFields.get(node)!);

      case "act":
        return checkAct(node as Extract<NodeModel, { family: "act" }>, scope, ctx, segments);

      case "assess":
        return checkAssess(node as Extract<NodeModel, { family: "assess" }>, scope, ctx, segments);

      case "gate": {
        const hot = (source: ExprSource, path: TemplatePath) => {
          const { type, ast } = expr(source, scope, path, node.id);
          expectType(type, isBool, "a gate condition must be bool", path, node.id);
          if (ast && readsRoot(ast, "counters")) {
            advise("type", path, "a counter read in a gate is one aggregation query per gesture (counters are derived)", node.id);
          }
        };
        if (node.body.all) node.body.all.forEach((condition, i) => hot(condition, [...node.path, "all", i]));
        if (node.branches) checkBranches(node, node.branches, scope, ctx, segments, hot);
        return null;
      }

      case "reward":
        checkReward(node.body, scope, node.path, "lane", node.id, ctx.lane.id);
        return null;
    }
  }

  function checkBranches(
    gate: NodeModel,
    branches: BranchModel[],
    scope: Scope,
    ctx: NodeContext,
    segments: Segments,
    hot: (source: ExprSource, path: TemplatePath) => void
  ) {
    const elses = branches.filter((branch) => branch.when === null);
    if (elses.length !== 1 || branches[branches.length - 1].when !== null) {
      report("shape", gate.path, "a branching gate ends with exactly one else; without it the branches do not converge", { node: gate.id });
    }
    if (branches.every((branch) => branch.when === null)) {
      report("shape", gate.path, "a branching gate needs at least one `when`", { node: gate.id });
    }
    for (const branch of branches) {
      if (branch.when !== null) hot(branch.when, [...branch.path, "when"]);
      for (const inner of branch.nodes) {
        if (inner.family === "collect" || (inner.family === "assess" && inner.body.kind === "human" && inner.body.fields)) {
          gap("interactive node in a branch", inner.path, "a gesture inside a branch is not compiled in v1; collect before the gate", inner.id);
        }
      }
      walk(ctx.lane, branch.nodes, scope, ctx.index, segments);
    }
  }

  function checkClaimUse(claim: ClaimUse, scope: Scope, path: TemplatePath, node: string): Record<string, Type> {
    const outputs: Record<string, Type> = {};
    let resource: string | null = null;

    if (/^[a-z][a-z0-9_]*$/.test(claim.resource) && resourceNames.has(claim.resource) && scope.lookup(claim.resource)?.kind === "list") {
      // Un tirage : le moteur choisit l'instance.
      resource = claim.resource;
      outputs[resource] = T.resource(resource);
      if (claim.where !== undefined) {
        const { type, ast } = expr(claim.where, scope.with({ [resource]: T.resource(resource) }), [...path, "where"], node);
        expectType(type, isBool, "a draw filter must be bool", [...path, "where"], node);
        if (ast && readsRoot(ast, "counters")) {
          advise("type", [...path, "where"], "a counter read in a draw filter is one aggregation query per gesture (counters are derived)", node);
        }
        if (ast && !isClassFilter(ast, resource)) {
          gap("claim eligibility", [...path, "where"], `a draw filter compiles only as \`${resource}.class == "…" || <condition not reading ${resource}>\``, node);
        }
      }
      if (claim.substitute) {
        const sub = claim.substitute.resource;
        if (!resourceNames.has(sub)) brokenResources.has(sub) || report("reference", [...path, "substitute", "resource"], `unknown resource type '${sub}'`, { node });
        else {
          if (!shell.resources[sub].claim) report("claim", [...path, "substitute", "resource"], `${sub} declares no claim mode`, { node });
          outputs[sub] = T.resource(sub);
        }
        outputs.substituted = T.bool;
        const { type } = expr(claim.substitute.rate, scope, [...path, "substitute", "rate"], node);
        expectType(type, isNumeric, "a substitution rate must be a number", [...path, "substitute", "rate"], node);
      }
    } else {
      // Une instance désignée par une expression.
      const { type } = expr(claim.resource, scope, [...path, "resource"], node);
      if (type.kind === "resource") resource = type.name;
      else if (type.kind !== "dyn") report("type", [...path, "resource"], `a claim takes a resource, got ${showType(type)}`, { node });
      if (claim.where !== undefined) report("claim", [...path, "where"], "a draw filter applies to a draw, not to a designated instance", { node });
      if (claim.substitute) report("claim", [...path, "substitute"], "substitution applies to a draw", { node });
    }

    if (!resource) return outputs;
    const decl = shell.resources[resource].claim;
    if (!decl) {
      report("claim", [...path, "resource"], `${resource} declares no claim mode`, { node });
      return outputs;
    }
    const scopeKeys = Object.keys(claim.scope ?? {});
    const dims = decl.mode === "unique_per" ? (decl.dimensions ?? []).filter((dim) => dim !== "self" && dim !== "participation") : [];
    const missing = dims.filter((dim) => !scopeKeys.includes(dim));
    const extra = scopeKeys.filter((key) => !dims.includes(key));
    if (missing.length) report("claim", [...path, "scope"], `claim on ${resource} is missing scope ${missing.join(", ")}`, { node });
    if (extra.length) report("claim", [...path, "scope"], `claim on ${resource} has no dimension ${extra.join(", ")}`, { node });
    for (const [key, value] of Object.entries(claim.scope ?? {})) {
      const { type } = expr(value, scope, [...path, "scope", key], node);
      if (resourceNames.has(key)) {
        expectType(type, (t) => (t.kind === "resource" && t.name === key) || t.kind === "dyn", `scope ${key} must be a ${key}`, [...path, "scope", key], node);
      }
    }
    return outputs;
  }

  /** `R.class == "x" || <condition sans R>` : ce que `draw({class})` sait faire. */
  function isClassFilter(ast: Expr, resource: string): boolean {
    const isClassTest = (e: Expr) =>
      e.k === "binary" && e.op === "==" &&
      e.left.k === "member" && e.left.name === "class" && e.left.object.k === "ident" && e.left.object.name === resource &&
      e.right.k === "lit" && e.right.type === "string";
    if (isClassTest(ast)) return true;
    return ast.k === "binary" && ast.op === "||" && isClassTest(ast.left) && !readsRoot(ast.right, resource);
  }

  function checkAct(
    node: Extract<NodeModel, { family: "act" }>,
    scope: Scope,
    ctx: NodeContext,
    segments: Segments
  ): Type | null {
    const { body, path, id } = node;
    const operations = ["capability", "create", "transition", "grant", "match_or_create", "update", "delete"].filter((key) => body[key as keyof typeof body] !== undefined);
    const args = Object.keys(body).filter((key) => !ACT_KEYS.has(key));
    let output: Record<string, Type> = {};

    if (operations.length > 1) report("shape", path, `an act does one thing, got ${operations.join(" and ")}`, { node: id });
    if (operations.length === 0 && !body.claim) report("shape", path, "an act needs capability, create, claim, transition, grant, match_or_create, update or delete", { node: id });
    if (body.upsert && body.create === undefined) report("shape", [...path, "upsert"], "upsert applies to a create", { node: id });
    if (args.length > 0 && !body.capability) report("format", [...path, args[0]], `unknown act key '${args[0]}'`, { node: id });

    if (body.claim) {
      output = { ...output, ...checkClaimUse(body.claim, scope, [...path, "claim"], id) };
      segments.claimed = true;
    }

    if (body.capability !== undefined) {
      const name = body.capability;
      const entry = /^[a-z][a-z0-9_]*$/.test(name) ? options.catalog[name] : undefined;
      let result: Type = T.dyn;
      if (/^[a-z][a-z0-9_]*$/.test(name)) {
        if (!entry) report("reference", [...path, "capability"], `unknown capability '${name}'`, { node: id });
      } else {
        // Une capacité choisie par paramètre : un connecteur, résolu à l'instanciation.
        const { type } = expr(name, scope, [...path, "capability"], node.id);
        expectType(type, (t) => t.kind === "capability" || t.kind === "dyn", "a dynamic capability must be of type capability", [...path, "capability"], id);
        for (const arg of args) expr(body[arg] as ExprSource, scope, [...path, arg], id);
      }
      if (entry) {
        result = entry.output;
        const kind = body.kind ?? entry.kind;
        if (kind !== entry.kind) report("type", [...path, "kind"], `${name} is an ${entry.kind}, not an ${kind}`, { node: id });
        if (entry.kind === "effector" && !entry.createOrGet) {
          report("reference", [...path, "capability"], `${name} is not create-or-get by natural key; effectors must be (§3.4)`, { node: id });
        }
        if (!entry.v1) gap(`capability ${name}`, [...path, "capability"], `${name} has no v1 binding`, id);
        for (const arg of args) {
          const spec = entry.args[arg];
          if (!spec) {
            report("reference", [...path, arg], `${name} takes no argument '${arg}'`, { node: id });
            continue;
          }
          const value = body[arg];
          if (spec.form === "literal") {
            if (typeof value !== "string" || !spec.values?.includes(value)) {
              report("type", [...path, arg], `${arg} is one of ${spec.values?.join(", ")}`, { node: id });
            }
            continue;
          }
          const { type } = expr(value as ExprSource, scope, [...path, arg], id);
          if (spec.type && !assignable(spec.type, type)) {
            report("type", [...path, arg], `${name}.${arg} expects ${showType(spec.type)}, got ${showType(type)}`, { node: id });
          }
        }
        for (const [arg, spec] of Object.entries(entry.args)) {
          if (spec.required && !(arg in body)) report("reference", path, `${name} needs argument '${arg}'`, { node: id });
        }
      }
      if (body.store) return T.record({ ...output, [body.store]: result });
      if (result.kind === "record") return T.record({ ...output, ...result.fields });
      return body.claim ? T.record(output) : T.dyn;
    }

    if (body.kind !== undefined && body.kind !== "grant") {
      report("shape", [...path, "kind"], `kind ${body.kind} needs a capability`, { node: id });
    }

    if (body.create !== undefined) {
      const resource = body.create;
      if (!resourceNames.has(resource)) {
        brokenResources.has(resource) || report("reference", [...path, "create"], `unknown resource type '${resource}'`, { node: id });
        return null;
      }
      const fields = resourceFieldTypes.get(resource)!;
      const sources = body.from === undefined ? [] : [body.from].flat();
      sources.forEach((source, i) => {
        const at = Array.isArray(body.from) ? [...path, "from", i] : [...path, "from"];
        const { type } = expr(source, scope, at, id);
        if (type.kind !== "record") {
          if (type.kind !== "dyn") report("type", at, `create from takes a node's output, got ${showType(type)}`, { node: id });
          return;
        }
        for (const [key, value] of Object.entries(type.fields)) {
          if (fields[key] && !ENGINE_FIELD_NAMES.includes(key) && !assignable(fields[key], value)) {
            report("type", at, `${resource}.${key} expects ${showType(fields[key])}, got ${showType(value)}`, { node: id });
          }
        }
      });
      for (const [key, value] of Object.entries(body.set ?? {})) {
        const at = [...path, "set", key];
        if (!fields[key] || ENGINE_FIELD_NAMES.includes(key)) {
          report("reference", at, `${resource} has no field '${key}'`, { node: id });
          continue;
        }
        const { type } = expr(value, scope, at, id);
        if (!assignable(fields[key], type)) report("type", at, `${resource}.${key} expects ${showType(fields[key])}, got ${showType(type)}`, { node: id });
      }
      if (body.many) {
        const { type } = expr(body.many.from_file, scope, [...path, "many", "from_file"], id);
        expectType(type, (t) => t.kind === "file" || t.kind === "dyn", "a batch is read from a file", [...path, "many", "from_file"], id);
      }
      if (body.upsert) {
        if (body.many) report("shape", [...path, "upsert"], "an upsert creates one instance, not a batch", { node: id });
        body.upsert.by.forEach((key, i) => {
          if (key !== "author" && (!fields[key] || ENGINE_FIELD_NAMES.includes(key))) {
            report("reference", [...path, "upsert", "by", i], `${resource} has no field '${key}'`, { node: id });
          }
        });
      }
      if (shell.resources[resource].match_or_create?.by === "human") {
        report("shape", [...path, "create"], `${resource} is matched by a human decision; use match_or_create`, { node: id });
      }
      return body.many ? T.list(T.resource(resource)) : T.resource(resource);
    }

    if (body.update) {
      const at = [...path, "update"];
      const { type } = expr(body.update.resource, scope, [...at, "resource"], id);
      if (type.kind !== "resource") {
        if (type.kind !== "dyn") report("type", [...at, "resource"], `an update takes a resource, got ${showType(type)}`, { node: id });
        return T.record(output);
      }
      const fields = resourceFieldTypes.get(type.name) ?? {};
      if (body.update.from === undefined && !body.update.set) report("shape", at, "an update writes from a gesture or set", { node: id });
      if (body.update.from !== undefined) {
        const gesture = ctx.index.get(body.update.from)?.[0]?.node;
        const source = scope.lookup(body.update.from);
        if (!gesture || gesture.family !== "collect") {
          report("reference", [...at, "from"], `update from '${body.update.from}': not a collect of this lane`, { node: id });
        } else if (source?.kind === "record") {
          for (const [key, value] of Object.entries(source.fields)) {
            if (fields[key] && !ENGINE_FIELD_NAMES.includes(key) && !assignable(fields[key], value)) {
              report("type", [...at, "from"], `${type.name}.${key} expects ${showType(fields[key])}, got ${showType(value)}`, { node: id });
            }
          }
        }
      }
      for (const [key, value] of Object.entries(body.update.set ?? {})) {
        const where = [...at, "set", key];
        if (!fields[key] || ENGINE_FIELD_NAMES.includes(key)) {
          report("reference", where, `${type.name} has no field '${key}'`, { node: id });
          continue;
        }
        const { type: valueType } = expr(value, scope, where, id);
        if (!assignable(fields[key], valueType)) report("type", where, `${type.name}.${key} expects ${showType(fields[key])}, got ${showType(valueType)}`, { node: id });
      }
      return T.record(output);
    }

    if (body.delete !== undefined) {
      const { type } = expr(body.delete, scope, [...path, "delete"], id);
      if (type.kind !== "resource" && type.kind !== "dyn") report("type", [...path, "delete"], `a delete takes a resource, got ${showType(type)}`, { node: id });
      return T.record(output);
    }

    if (body.transition) {
      checkTransition(body.transition, scope, [...path, "transition"], ctx.lane.entry.trigger === "admin" ? "admin_act" : "transition", id);
      return T.record(output);
    }

    if (body.grant) {
      const at = [...path, "grant", "field"];
      if (body.kind !== "grant") report("shape", [...path, "kind"], "a grant act declares kind: grant", { node: id });
      const source = body.grant.field;
      const { ast } = expr(source, scope, at, id);
      if (ast && ast.k !== "member") report("type", at, "a grant names a resource field", { node: id });
      return T.record(output);
    }

    if (body.match_or_create) {
      const { resource, decision } = body.match_or_create;
      if (!resourceNames.has(resource)) brokenResources.has(resource) || report("reference", [...path, "match_or_create", "resource"], `unknown resource type '${resource}'`, { node: id });
      else if (shell.resources[resource].match_or_create?.by !== "human") {
        report("shape", [...path, "match_or_create"], `${resource} does not declare match_or_create: {by: human}`, { node: id });
      }
      const { type } = expr(decision, scope, [...path, "match_or_create", "decision"], id);
      if (type.kind === "record" && !type.fields.outcome) {
        report("reference", [...path, "match_or_create", "decision"], `decision '${decision}' has no outcome field`, { node: id });
      }
      if (body.attach !== undefined) expr(body.attach, scope, [...path, "attach"], id);
      gap("match-or-create", [...path, "match_or_create"], "human routing is out of v1", id);
      return T.record(output);
    }

    return T.record(output);
  }

  function checkAssess(
    node: Extract<NodeModel, { family: "assess" }>,
    scope: Scope,
    ctx: NodeContext,
    segments: Segments
  ): Type | null {
    const { body, path, id } = node;
    let output: Type = T.record({});

    if (body.claim) {
      checkClaimUse(body.claim, scope, [...path, "claim"], id);
    }

    if (body.snapshot !== undefined && body.kind !== "ai_grid") report("shape", [...path, "snapshot"], "snapshot applies to an ai_grid assessment", { node: id });
    if (body.background) checkBackground(node, ctx);
    else if (body.kind === "ai_grid" && (ctx.lane.entry.trigger === "user" || ctx.lane.entry.trigger === "admin")) {
      advise("shape", path, "an ai_grid evaluation takes a minute or more inside the request; background: true answers 202 and resumes the lane", id);
    }

    switch (body.kind) {
      case "ai_grid":
      case "self": {
        if (body.grid === undefined) report("shape", path, `a ${body.kind} assessment names its grid`, { node: id });
        else checkGrid(body.grid, scope, [...path, "grid"], id);
        for (const [i, input] of (body.input ?? []).entries()) expr(input, scope, [...path, "input", i], id);
        if (body.kind === "ai_grid") {
          // L'évaluation note un artefact : une URL GitHub ou Kaggle parmi les entrées.
          if (!body.input?.length) report("shape", path, "an ai_grid assessment takes its artifact URL in input", { node: id });
          output = T.record({ score: T.number });
        } else {
          if (body.gating !== false) report("shape", path, "a self assessment is formative: gating: false", { node: id });
          if (body.emit) report("shape", [...path, "emit"], "a self assessment emits nothing", { node: id });
          gap("self assessment", path, "formative self-evaluation is not compiled in v1", id);
        }
        break;
      }
      case "human": {
        if (body.fields && body.from) report("shape", path, "a human assessment has fields or from, not both", { node: id });
        if (body.fields) {
          interactive(node, ctx, segments);
          nodeFields.set(node, collectFieldTypes(body.fields, [...path, "fields"], scope, id));
          output = T.record(nodeFields.get(node)!);
        } else if (body.from) {
          const { type } = expr(body.from, scope, [...path, "from"], id);
          const source = ctx.index.get(body.from)?.[0]?.node;
          if (source && source.family !== "collect") report("shape", [...path, "from"], `'${body.from}' is not a collect`, { node: id });
          output = type.kind === "record" ? type : T.dyn;
        } else if (!body.emit) {
          report("shape", path, "a human assessment has fields, from, or emits the collected work", { node: id });
        }
        break;
      }
      case "metric": {
        if (body.value === undefined) {
          report("shape", path, "a metric assessment has a value", { node: id });
          break;
        }
        const { type } = expr(body.value, scope, [...path, "value"], id);
        output = T.record({ value: type });
        const updateScope = scope.with({ value: type });
        for (const [counter, update] of Object.entries(body.counters ?? {})) {
          const at = [...path, "counters", counter];
          if (!(counter in counterTypes)) report("reference", at, `unknown counter '${counter}'`, { node: id });
          const { type: added } = expr(update.add, updateScope, [...at, "add"], id);
          expectType(added, isNumeric, "a counter adds a number", [...at, "add"], id);
        }
        break;
      }
    }
    if (body.counters && body.kind !== "metric") report("shape", [...path, "counters"], "only a metric assessment writes counters", { node: id });

    if (body.emit) {
      const at = [...path, "emit"];
      const target = /^lifecycle\.([a-z][a-z0-9_]*)$/.exec(body.emit.to);
      const aggregate = target ? aggregateIds.get(target[1]) : undefined;
      if (!aggregate && !(target && model.broken.aggregates.has(target[1]))) {
        report("reference", [...at, "to"], `unknown aggregate '${body.emit.to}' (emit to lifecycle.<aggregate>)`, { node: id });
      }
      const { type } = expr(body.emit.scope, scope, [...at, "scope"], id);
      if (aggregate) {
        const over = aggregate.decl.over;
        expectType(type, (t) => (t.kind === "resource" && t.name === over) || t.kind === "dyn", `emit scope must be a ${over}`, [...at, "scope"], id);
      }
    }
    return output;
  }

  function checkGrid(grid: ExprSource, scope: Scope, path: TemplatePath, node: string) {
    if (typeof grid === "string" && /^[a-z][a-z0-9_-]*@[0-9]+$/.test(grid)) {
      if (options.gridExists && !options.gridExists(grid)) report("reference", path, `unknown grid '${grid}'`, { node });
      return;
    }
    const { type } = expr(grid, scope, path, node);
    // Un slug écrit en littéral (`'"code"'`) vaut une référence : la grille publiée de ce slug.
    expectType(type, (t) => t.kind === "grid" || t.kind === "string" || t.kind === "dyn", "a grid reference must be of type grid_ref", path, node);
  }

  function checkTransition(body: TransitionBody, scope: Scope, path: TemplatePath, closer: "aggregate" | "transition" | "admin_act", node?: string) {
    const { type } = expr(body.resource, scope, [...path, "resource"], node);
    if (type.kind !== "resource") {
      if (type.kind !== "dyn") report("type", [...path, "resource"], `a transition takes a resource, got ${showType(type)}`, { node });
      return;
    }
    const closure = shell.resources[type.name].closure;
    const closers = closure ? [closure.by].flat() : [];
    if (body.to === "closed" && closer !== "aggregate" && !closers.includes(closer) && !(closer === "admin_act" && closers.includes("transition"))) {
      report("shape", path, `${type.name} is not closed by ${closer === "admin_act" ? "an admin act" : "a transition"} (closure.by: ${closers.join(", ") || "none"})`, { node });
    }
    const verdicts = closure?.verdict ?? [];
    if (body.from !== undefined) {
      if (body.to !== "closed") report("shape", [...path, "from"], "from recloses a closed resource: to: closed", { node });
      if (!verdicts.includes(body.from)) report("reference", [...path, "from"], `${type.name} has no verdict ${body.from}`, { node });
      if (body.verdict === undefined) report("shape", [...path, "verdict"], "reclosing from a verdict names the new verdict", { node });
    }
    for (const [key, source] of Object.entries(body.resolution ?? {})) {
      expr(source, scope, [...path, "resolution", key], node);
    }
    if (body.verdict === undefined) return;
    if (verdicts.includes(body.verdict)) return;
    // Pas un verdict déclaré écrit nu : une expression.
    const { type: verdictType } = expr(body.verdict, scope, [...path, "verdict"], node);
    if (verdictType.kind === "enum" && verdictType.values) {
      const unknown = verdictType.values.filter((value) => !verdicts.includes(value));
      if (unknown.length) report("type", [...path, "verdict"], `${type.name} has no verdict ${unknown.join(", ")}`, { node });
    } else if (!isStringLike(verdictType) && verdictType.kind !== "dyn") {
      report("type", [...path, "verdict"], `a verdict is a string, got ${showType(verdictType)}`, { node });
    }
  }

  function checkEffect(effect: EffectModel, scope: Scope, where: "aggregate" | "on_close") {
    switch (effect.family) {
      case "transition":
        checkTransition(effect.body, scope, effect.path, "aggregate");
        return;
      case "reward":
        checkReward(effect.body, scope, effect.path, where, undefined, where === "on_close" ? "on_close" : "lifecycle");
        return;
      case "counters": {
        const { type } = expr(effect.body.on, scope, [...effect.path, "on"]);
        expectType(type, (t) => t.kind === "list" || t.kind === "dyn", "counters apply to a list of inputs", [...effect.path, "on"]);
        for (const [counter, update] of Object.entries(effect.body.update)) {
          const at = [...effect.path, "update", counter];
          if (!(counter in counterTypes)) report("reference", at, `unknown counter '${counter}'`);
          const { type: added } = expr(update.add, scope, [...at, "add"]);
          expectType(added, isNumeric, "a counter adds a number", [...at, "add"]);
        }
        gap("counters written by an aggregate", effect.path, "slash accounting is out of v1");
        return;
      }
    }
  }

  /**
   * Une évaluation en arrière-plan reprend la lane au nœud suivant, depuis ce
   * que le run a gardé : ni claim à tenir, ni geste après elle, et une place au
   * premier niveau de la lane pour que la reprise sache où continuer.
   */
  function checkBackground(node: Extract<NodeModel, { family: "assess" }>, ctx: NodeContext) {
    const { body, path, id } = node;
    const at = [...path, "background"];
    if (body.kind !== "ai_grid") return report("shape", at, "background applies to an ai_grid assessment", { node: id });
    if (ctx.lane.entry.trigger !== "user" && ctx.lane.entry.trigger !== "admin") {
      return report("shape", at, "a background evaluation answers a gesture: its lane is triggered by a user or an admin", { node: id });
    }
    const index = ctx.lane.nodes.indexOf(node);
    if (index < 0) return report("shape", at, "a background evaluation sits at the top level of its lane, not in a branch", { node: id });
    const claims = (nodes: readonly NodeModel[]): boolean =>
      nodes.some((candidate) =>
        (candidate.family === "act" && Boolean(candidate.body.claim)) ||
        (candidate.family === "assess" && Boolean(candidate.body.claim)) ||
        (candidate.family === "gate" && (candidate.branches ?? []).some((branch) => claims(branch.nodes)))
      );
    if (claims(ctx.lane.nodes)) report("shape", at, "a background evaluation does not hold a claim across its run", { node: id });
    const gestures = (nodes: readonly NodeModel[]): boolean =>
      nodes.some((candidate) =>
        candidate.family === "collect" ||
        (candidate.family === "assess" && candidate.body.kind === "human" && Boolean(candidate.body.fields)) ||
        (candidate.family === "gate" && (candidate.branches ?? []).some((branch) => gestures(branch.nodes)))
      );
    if (gestures(ctx.lane.nodes.slice(index + 1))) report("shape", at, "no gesture follows a background evaluation: the lane resumes without the participant", { node: id });
    if (ctx.lane.nodes.slice(index + 1).some((candidate) => candidate.family === "assess" && candidate.body.background)) {
      report("shape", at, "one background evaluation per lane", { node: id });
    }
  }

  function checkReward(
    body: RewardBody,
    scope: Scope,
    path: TemplatePath,
    where: "lane" | "aggregate" | "on_close",
    node: string | undefined,
    owner: string
  ) {
    let negative = false;

    if (typeof body.amount === "object" && "reverse" in body.amount) {
      const target = body.amount.reverse;
      negative = true;
      // Dans un modèle partiel, la récompense nommée peut être dans ce qui a été écarté.
      if (!rewardKeys.has(target) && !partial) {
        report("reference", [...path, "amount", "reverse"], `reverse names no reward: use its rule_key or <lane>.<node>`, { node });
      }
      if (body.to === undefined) {
        report("economy", [...path, "to"], "a reverse reward names whose payments it reverses: to", { node });
      } else if (body.to !== "each_participation") {
        const { type } = expr(body.to, scope, [...path, "to"], node);
        const item = type.kind === "list" ? type.of : type;
        if (item.kind !== "dyn" && !(item.kind === "record" && item.fields.claim)) {
          report("type", [...path, "to"], `a reverse reward pays back per claim; its recipients carry a claim, got ${showType(type)}`, { node });
        }
      }
    } else if (typeof body.amount === "object") {
      const mapping = body.amount;
      const at = [...path, "amount"];
      if (mapping.mapping === "tiers") {
        const { type: tiers } = expr(mapping.tiers, scope, [...at, "tiers"], node);
        const tier = tiers.kind === "list" ? tiers.of : T.dyn;
        if (tiers.kind !== "list" && tiers.kind !== "dyn") report("type", [...at, "tiers"], `tiers must be a list, got ${showType(tiers)}`, { node });
        if (tier.kind === "record") {
          const key = tier.fields[mapping.key];
          if (!key) report("reference", [...at, "key"], `tier has no field '${mapping.key}'`, { node });
          if (!tier.fields.points) report("reference", [...at, "tiers"], "a tier has a points field", { node });
          const { type: input } = expr(mapping.input, scope, [...at, "input"], node);
          if (key && mapping.match === "at_least" && !(isNumeric(key) && isNumeric(input))) {
            report("type", [...at, "input"], `at_least compares numbers, got ${showType(input)} against ${showType(key)}`, { node });
          }
          if (key && mapping.match === "equals" && !assignable(key, input) && !assignable(input, key)) {
            report("type", [...at, "input"], `tier key ${showType(key)} cannot match ${showType(input)}`, { node });
          }
        } else {
          expr(mapping.input, scope, [...at, "input"], node);
        }
      } else {
        if (!resourceNames.has(mapping.over)) brokenResources.has(mapping.over) || report("reference", [...at, "over"], `unknown resource type '${mapping.over}'`, { node });
        const rankScope = resourceNames.has(mapping.over)
          ? scope.with({ [mapping.over]: T.resource(mapping.over), aggregates: aggregatesOver(mapping.over) })
          : scope;
        const { type: by } = expr(mapping.by, rankScope, [...at, "by"], node);
        expectType(by, isNumeric, "a rank is by a number", [...at, "by"], node);
        const { type: amounts } = expr(mapping.amounts, scope, [...at, "amounts"], node);
        expectType(amounts, (t) => (t.kind === "list" && isNumeric(t.of)) || t.kind === "dyn", "rank amounts are a list of points", [...at, "amounts"], node);
        if (body.to !== undefined) report("economy", [...path, "to"], "a rank reward pays the ranked authors; it has no `to`", { node });
        gap("rank reward", at, "rank-mapped rewards are not compiled in v1", node);
      }
    } else {
      const { type, ast } = expr(body.amount, scope, [...path, "amount"], node);
      expectType(type, isNumeric, "a reward amount must be a number", [...path, "amount"], node);
      negative = (ast?.k === "unary" && ast.op === "-") || (typeof body.amount === "number" && body.amount < 0);
    }

    if (body.to !== undefined) {
      if (body.to === "each_participation") {
        if (where !== "on_close") report("economy", [...path, "to"], "each_participation pays at challenge close only", { node });
        else gap("refund at close", [...path, "to"], "stake refunds are out of v1", node);
      } else {
        const { type } = expr(body.to, scope, [...path, "to"], node);
        const payable = (t: Type): boolean =>
          t.kind === "user" || t.kind === "dyn" || t.kind === "resource" ||
          (t.kind === "record" && (Boolean(t.fields.participation) || Boolean(t.fields.author)));
        if (!(payable(type) || (type.kind === "list" && payable(type.of)))) {
          report("economy", [...path, "to"], `a reward pays a user, a participation or an author, got ${showType(type)}`, { node });
        }
      }
    }

    if (body.pool !== undefined) {
      const pool = paramName(body.pool);
      if (!pool || !(pool in shell.params)) {
        report("economy", [...path, "pool"], "a reward's pool is a points param: pool: params.<name>", { node });
      } else if (paramTypes[pool].kind !== "int") {
        report("economy", [...path, "pool"], `pool param '${pool}' must be of type points`, { node });
      } else {
        expr(body.pool, scope, [...path, "pool"], node);
      }
    }
    if (body.clamp === "pool" && body.pool === undefined) report("economy", [...path, "clamp"], "clamp: pool needs a pool", { node });
    if (body.basis === "delta") {
      if (typeof body.amount === "object") report("economy", [...path, "basis"], "a delta basis applies to an amount expression", { node });
      if (negative) report("economy", [...path, "basis"], "a delta basis never pays back: its amount is not negative", { node });
      if (where !== "lane") report("economy", [...path, "basis"], "a delta basis applies to a lane reward", { node });
    }
    for (const [key, source] of Object.entries(body.meta ?? {})) expr(source, scope, [...path, "meta", key], node);
    if (body.multiplier !== undefined) {
      const { type } = expr(body.multiplier, scope, [...path, "multiplier"], node);
      expectType(type, isNumeric, "a multiplier must be a number", [...path, "multiplier"], node);
      if (body.basis === "delta") report("economy", [...path, "multiplier"], "a delta basis multiplies in its amount; multiplier applies to a plain payment", { node });
    }
    if (body.transfers) {
      const at = [...path, "transfers"];
      if (where !== "lane") report("economy", at, "reuse transfers follow a lane payment", { node });
      if (negative) report("economy", at, "a payment back transfers nothing", { node });
      if (body.transfers.floor !== undefined) {
        const { type } = expr(body.transfers.floor, scope, [...at, "floor"], node);
        expectType(type, isNumeric, "a transfer floor is a share of the payment", [...at, "floor"], node);
      }
      body.transfers.to.forEach((target, i) => {
        const { type } = expr(target.from, scope, [...at, "to", i, "from"], node);
        const item = type.kind === "list" ? type.of : null;
        if (type.kind !== "dyn" && !(item && (item.kind === "dyn" || (item.kind === "record" && item.fields.author)))) {
          report("type", [...at, "to", i, "from"], `transfers go to a list of {author, contribution, weight?}, got ${showType(type)}`, { node });
        }
        const { type: share } = expr(target.share, scope, [...at, "to", i, "share"], node);
        expectType(share, isNumeric, "a transfer share must be a number", [...at, "to", i, "share"], node);
      });
    }
    if (body.order === "commit_time" && where !== "aggregate") report("economy", [...path, "order"], "earliest-first ordering applies to an aggregate's payment", { node });
    if (negative && !body.rule_key) report("economy", [...path, "amount"], "a negative reward (clawback) declares its rule_key", { node });
    if (!negative && body.pool === undefined && !body.rule_key) {
      report("economy", path, "a reward without a pool mints points; name its pool, or its rule_key for a refund", { node });
    }

    const key = body.rule_key ?? `${owner}.${node ?? body.id ?? "reward"}`;
    const previous = ruleKeys.get(key);
    if (previous && body.rule_key) report("economy", [...path, "rule_key"], `rule key '${key}' is already written at ${previous.join(".")}`, { node });
    ruleKeys.set(key, path);
  }
}
