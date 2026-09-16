import { parse } from 'yaml';
import type { Family } from './families';

/**
 * Le modèle de l'éditeur de graphe
 * --------------------------------
 * Le YAML fait foi : le canevas en est une vue, recalculée à chaque écriture.
 * Rien ici n'est validé — c'est le travail du validateur, côté serveur, dont
 * les diagnostics reviennent avec chaque sauvegarde. Le modèle tient donc
 * debout sur un brouillon troué : un nœud illisible devient une carte
 * `unknown`, une lane sans entrée garde sa colonne.
 *
 * Le câblage est une séquence, pas un flux de données : un nœud lit tout ce
 * que ses prédécesseurs ont produit. `upstream` est cette liste ; `reads`, ce
 * qu'il en lit vraiment — la provenance que la sélection allume.
 */

export type Path = readonly (string | number)[];
export type Rec = Record<string, unknown>;

export const pathKey = (path: Path) => path.join('.');
export const isRec = (value: unknown): value is Rec => !!value && typeof value === 'object' && !Array.isArray(value);

export type DocKey = 'collect' | 'act' | 'assess' | 'gate' | 'reward';
export const DOC_KEYS: readonly DocKey[] = ['collect', 'act', 'assess', 'gate', 'reward'];

export interface Chip {
  label: string;
  tone: 'default' | 'emit' | 'resource' | 'access';
}

export interface Line {
  k: string;
  v: string;
}

export interface CanvasNode {
  /** `lanes.1.nodes.3`, `lanes.1.entry`, `lifecycle.aggregates.0` : la clé est le chemin. */
  key: string;
  path: Path;
  /** Le chemin du corps éditable : `…nodes.3.gate`, `…entry`, `lifecycle.aggregates.0`. */
  bodyPath: Path;
  id: string;
  family: Family | 'unknown';
  docKey: DocKey | 'entry' | 'aggregate' | null;
  body: Rec;
  badge: string;
  lines: Line[];
  chips: Chip[];
  /** Les racines des expressions du nœud : `params`, `counters`, `draw`… */
  reads: string[];
  emitsTo: string | null;
  resources: { verb: 'claims' | 'creates' | 'closes' | 'reveals'; type: string }[];
  laneIndex: number | null;
}

export type SeqItem = { kind: 'node'; node: CanvasNode } | { kind: 'routing'; node: CanvasNode; branches: Branch[] };

export interface Branch {
  label: string;
  isElse: boolean;
  /** Le chemin de la branche dans `gate.branch`. */
  path: Path;
  nodesPath: Path;
  items: SeqItem[];
}

export interface CanvasLane {
  index: number;
  id: string;
  title: string;
  subtitle: string;
  entry: CanvasNode;
  nodesPath: Path;
  items: SeqItem[];
  /** Les clés de la lane, dans l'ordre de lecture : ce que les flèches parcourent. */
  order: string[];
}

export interface ParamView {
  name: string;
  type: string;
  defaultText: string | null;
  mutable: boolean;
  checks: { name: string; expr: string }[];
  decl: Rec;
}

export interface ResourceFieldView {
  name: string;
  type: string;
  visibility: string;
  tone: 'everyone' | 'restricted' | 'hidden';
}

export interface ResourceView {
  name: string;
  fields: ResourceFieldView[];
  claim: string | null;
  closure: string | null;
  createdBy: string[];
  decl: Rec;
}

export interface CounterView {
  name: string;
  type: string;
  lag: number | null;
}

export interface AggregateView {
  index: number;
  id: string;
  rows: Line[];
  emitters: string[];
  node: CanvasNode;
}

export interface EditorModel {
  /** Le YAML ne se lit pas : le canevas reste sur son dernier état lisible. */
  parseError: string | null;
  doc: Rec;
  header: { id: string; version: string; name: string; summary: string };
  lanes: CanvasLane[];
  nodes: Map<string, CanvasNode>;
  upstream: Map<string, string[]>;
  params: ParamView[];
  resources: ResourceView[];
  counters: CounterView[];
  aggregates: AggregateView[];
}

/** `submit_case` → `Submit case`. */
export function humanize(id: string): string {
  const words = id.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const str = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : typeof value === 'object' ? compact(value) : String(value));

/** Une valeur en une ligne, dans la syntaxe de flux du YAML. */
export function compact(value: unknown): string {
  if (typeof value === 'string') return /[:{},\[\]#]/.test(value) && !/^[\w.() ]+$/.test(value) ? JSON.stringify(value) : value;
  if (Array.isArray(value)) return `[${value.map(compact).join(', ')}]`;
  if (isRec(value)) return `{${Object.entries(value).map(([k, v]) => `${k}: ${compact(v)}`).join(', ')}}`;
  return String(value);
}

/** Une expression, raccourcie pour une carte. */
export function short(value: unknown, max = 42): string {
  const text = str(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const IDENT = /^[a-z][a-z0-9_]*$/;
const ROOT = /(?<![\w.])([a-z][a-z0-9_]*)\s*\./g;
const NOT_EXPRESSIONS = new Set(['id', 'type', 'rule_key', 'capability', 'kind', 'mode', 'schedule', 'cursor']);

/** Les racines lues par un corps de nœud : `a.b` donne `a` ; `from: label` donne `label`. */
export function readsOf(body: unknown): string[] {
  const roots = new Set<string>();
  const visit = (value: unknown, key: string | null) => {
    if (key && NOT_EXPRESSIONS.has(key)) return;
    if (typeof value === 'string') {
      if ((key === 'from' || key === 'scope' || key === 'resource') && IDENT.test(value.trim())) roots.add(value.trim());
      for (const match of value.replace(/"[^"]*"|'[^']*'/g, '""').matchAll(ROOT)) roots.add(match[1]);
      return;
    }
    if (Array.isArray(value)) value.forEach((item) => visit(item, key));
    else if (isRec(value)) for (const [k, v] of Object.entries(value)) visit(v, k);
  };
  visit(body, null);
  return [...roots];
}

function familyOf(raw: unknown): { docKey: DocKey | null; body: Rec } {
  if (!isRec(raw)) return { docKey: null, body: {} };
  const keys = Object.keys(raw).filter((key): key is DocKey => (DOC_KEYS as readonly string[]).includes(key));
  if (keys.length !== 1) return { docKey: null, body: raw };
  const body = raw[keys[0]];
  return { docKey: keys[0], body: isRec(body) ? body : {} };
}

function visibilityLabel(visibility: unknown): { label: string; tone: ResourceFieldView['tone'] } {
  if (!Array.isArray(visibility)) return { label: 'everyone', tone: 'everyone' };
  if (visibility.length === 0) return { label: 'hidden — grant only', tone: 'hidden' };
  const names = visibility.map((entry) => {
    const role = /^role\(\s*params\.([a-z0-9_]+)\s*\)$/.exec(String(entry));
    return role ? `role: ${role[1]}` : String(entry);
  });
  return { label: names.join(' + '), tone: 'restricted' };
}

interface BuildContext {
  doc: Rec;
  resourceTypes: Set<string>;
  /** Par id de nœud : ses champs déclarés (`ref(item)`…), pour résoudre `pick.case`. */
  fieldsById: Map<string, Rec>;
}

/** Le type de ressource qu'une expression désigne : `item`, ou `pick.case` quand ce champ est un `ref(reference_case)`. */
function resourceOf(expr: unknown, ctx: BuildContext): string | null {
  const text = str(expr).trim();
  if (ctx.resourceTypes.has(text)) return text;
  const match = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/.exec(text);
  if (match) {
    const field = ctx.fieldsById.get(match[1])?.[match[2]];
    const type = isRec(field) ? str(field.type) : '';
    const ref = /^ref\(\s*([a-z][a-z0-9_]*)\s*\)$/.exec(type);
    if (ref) return ref[1];
    if (ctx.resourceTypes.has(match[2])) return match[2];
  }
  return text || null;
}

function fieldLines(fields: unknown): Line[] {
  if (!isRec(fields)) return [];
  return Object.entries(fields).map(([name, decl]) => ({
    k: name,
    v: isRec(decl) ? `${short(decl.type, 26)}${decl.when !== undefined ? ' · when' : ''}` : short(decl, 26),
  }));
}

function amountText(amount: unknown): string {
  if (isRec(amount)) {
    if (amount.reverse !== undefined) return `− ${str(amount.reverse)} (reverse)`;
    if (amount.mapping === 'tiers') return `tiers of ${short(amount.tiers, 24)}`;
    if (amount.mapping === 'rank') return `rank over ${str(amount.over)}`;
  }
  return short(amount, 40);
}

function summarizeNode(docKey: DocKey | null, body: Rec, ctx: BuildContext): Pick<CanvasNode, 'family' | 'badge' | 'lines' | 'chips' | 'emitsTo' | 'resources'> {
  const lines: Line[] = [];
  const chips: Chip[] = [];
  const resources: CanvasNode['resources'] = [];
  let emitsTo: string | null = null;
  switch (docKey) {
    case 'collect': {
      const count = isRec(body.fields) ? Object.keys(body.fields).length : 0;
      return { family: 'collect', badge: `${count} field${count === 1 ? '' : 's'}`, lines: fieldLines(body.fields), chips, emitsTo, resources };
    }
    case 'gate': {
      if (Array.isArray(body.branch)) {
        return { family: 'gate', badge: `routing · ${body.branch.length} branches`, lines, chips, emitsTo, resources };
      }
      const all = Array.isArray(body.all) ? body.all : [];
      all.forEach((condition, index) => lines.push({ k: all.length > 1 ? `${index + 1}` : 'all', v: short(condition, 38) }));
      if (body.refuse !== undefined) chips.push({ label: `refuse ${str(body.refuse)}`, tone: 'default' });
      return { family: 'gate', badge: 'blocking', lines, chips, emitsTo, resources };
    }
    case 'act': {
      if (isRec(body.transition)) {
        const type = resourceOf(body.transition.resource, ctx);
        const verdict = body.transition.verdict !== undefined ? ` → ${short(body.transition.verdict, 20)}` : '';
        lines.push({ k: str(body.transition.to) || 'to', v: `${type ?? '?'}${verdict}` });
        if (body.transition.from !== undefined) lines.push({ k: 'from', v: str(body.transition.from) });
        if (type) resources.push({ verb: 'closes', type });
        return { family: 'transition', badge: 'closure', lines, chips, emitsTo, resources };
      }
      let badge = str(body.kind) || 'effector';
      if (isRec(body.claim)) {
        const type = resourceOf(body.claim.resource, ctx);
        if (type) {
          resources.push({ verb: 'claims', type });
          chips.push({ label: `claims: ${type}`, tone: 'resource' });
        }
        if (body.claim.where !== undefined) lines.push({ k: 'where', v: short(body.claim.where, 30) });
        if (isRec(body.claim.substitute)) lines.push({ k: `${str(body.claim.substitute.resource)} mix`, v: short(body.claim.substitute.rate, 24) });
      }
      if (body.create !== undefined) {
        const type = str(body.create);
        resources.push({ verb: 'creates', type });
        chips.push({ label: `creates${body.many ? ' many' : ''}: ${type}`, tone: 'resource' });
      }
      if (isRec(body.grant)) {
        badge = 'grant';
        lines.push({ k: 'unlocks', v: short(body.grant.field, 30) });
      }
      if (body.capability !== undefined) lines.push({ k: 'capability', v: str(body.capability) });
      if (body.store !== undefined) lines.push({ k: 'stores', v: str(body.store) });
      if (isRec(body.set)) for (const [k, v] of Object.entries(body.set)) lines.push({ k: `set ${k}`, v: short(v, 24) });
      return { family: 'act', badge, lines, chips, emitsTo, resources };
    }
    case 'assess': {
      const kind = str(body.kind) || 'assess';
      if (body.value !== undefined) lines.push({ k: 'value', v: short(body.value, 34) });
      if (body.from !== undefined) lines.push({ k: 'from', v: str(body.from) });
      lines.push(...fieldLines(body.fields));
      if (isRec(body.counters)) chips.push({ label: `counters: ${Object.keys(body.counters).join(', ')}`, tone: 'default' });
      if (isRec(body.emit)) {
        emitsTo = str(body.emit.to).replace(/^lifecycle\./, '');
        chips.push({ label: `emit → ${emitsTo}`, tone: 'emit' });
      }
      if (isRec(body.claim)) {
        const type = resourceOf(body.claim.resource, ctx);
        if (type) {
          resources.push({ verb: 'claims', type });
          chips.push({ label: `claims: ${type}`, tone: 'resource' });
        }
      }
      return { family: 'assess', badge: kind === 'human' ? 'human verdict' : kind, lines, chips, emitsTo, resources };
    }
    case 'reward': {
      lines.push({ k: 'amount', v: amountText(body.amount) });
      if (body.to !== undefined) lines.push({ k: 'to', v: short(body.to, 30) });
      if (body.pool !== undefined) chips.push({ label: `pool: ${short(body.pool, 20)}${body.clamp === 'pool' ? ' · clamped' : ''}`, tone: 'default' });
      if (body.rule_key !== undefined) chips.push({ label: `ledger: ${str(body.rule_key)}`, tone: 'default' });
      const shape = isRec(body.amount) ? (body.amount.reverse !== undefined ? 'clawback' : str(body.amount.mapping)) : 'formula';
      return { family: 'reward', badge: shape, lines, chips, emitsTo, resources };
    }
    default:
      return { family: 'unknown', badge: 'unreadable node', lines, chips, emitsTo, resources };
  }
}

function entrySummary(entry: Rec): { subtitle: string; badge: string; chips: Chip[]; lines: Line[] } {
  const trigger = str(entry.trigger) || '?';
  const chips: Chip[] = [];
  const lines: Line[] = [];
  const access = isRec(entry.access) ? entry.access : null;
  let subtitle = `${trigger} entry`;
  if (access) {
    const mode = str(access.mode);
    if (mode === 'open') {
      chips.push({ label: 'open to all', tone: 'access' });
      subtitle = 'open entry';
    } else if (mode === 'role') {
      const role = str(access.role).replace(/^params\./, '');
      chips.push({ label: `role: ${role}`, tone: 'access' });
      subtitle = `role: ${role}`;
    } else if (mode === 'author_of') {
      chips.push({ label: `author of ${str(access.resource)}`, tone: 'access' });
      subtitle = `author of ${str(access.resource)}`;
    }
    if (access.runs_per_participation !== undefined) chips.push({ label: `${str(access.runs_per_participation)} run(s)`, tone: 'default' });
  } else if (trigger === 'admin') {
    chips.push({ label: 'role: admin', tone: 'access' });
  }
  if (trigger === 'cron') {
    subtitle = `cron · ${str(entry.schedule) || 'no schedule'}`;
    if (entry.schedule !== undefined) chips.push({ label: `schedule: ${str(entry.schedule)}`, tone: 'default' });
    if (isRec(entry.over)) {
      lines.push({ k: 'over', v: str(entry.over.resource) });
      if (entry.over.where !== undefined) lines.push({ k: 'where', v: short(entry.over.where, 32) });
      if (entry.over.sample !== undefined) lines.push({ k: 'sample', v: short(entry.over.sample, 24) });
    }
  }
  const badge = trigger === 'user' ? 'user gesture' : trigger === 'admin' ? 'admin gesture' : trigger;
  return { subtitle, badge, chips, lines };
}

function typeText(type: unknown): string {
  return typeof type === 'string' ? type : compact(type);
}

function claimSummary(claim: unknown, params: Rec): string | null {
  if (!isRec(claim)) return null;
  const valueOf = (expr: unknown) => {
    const param = /^params\.([a-z0-9_]+)$/.exec(str(expr).trim());
    const decl = param ? params[param[1]] : undefined;
    return param && isRec(decl) && decl.default !== undefined ? `${str(expr)} (${str(decl.default)})` : str(expr);
  };
  const parts: string[] = [];
  const mode = str(claim.mode);
  if (mode === 'k_bounded') parts.push(`up to ${valueOf(claim.k)} holders`);
  else if (mode === 'exclusive') parts.push('one holder at a time');
  else if (mode === 'unbounded') parts.push('unbounded holders');
  else if (mode === 'unique_per') {
    const dims = Array.isArray(claim.dimensions) ? claim.dimensions.map(str) : [];
    parts.push(dims.length === 1 && dims[0] === 'self' ? 'never re-served to the same person' : `one per (${dims.join(', ')})`);
  } else parts.push(mode || 'claim');
  if (claim.ttl !== undefined) {
    const ttl = str(claim.ttl);
    parts.push(/^[0-9]+$/.test(ttl) ? `${ttl}h TTL` : /^[0-9]+[mhd]$/.test(ttl) ? `${ttl} TTL` : `TTL ${valueOf(claim.ttl)} h`);
  }
  if (claim.where !== undefined) parts.push(`where ${short(claim.where, 24)}`);
  return parts.join(' · ');
}

function closureSummary(closure: unknown): string | null {
  if (!isRec(closure)) return null;
  const by = Array.isArray(closure.by) ? closure.by.map(str).join(' | ') : str(closure.by);
  const verdicts = Array.isArray(closure.verdict) ? ` → ${closure.verdict.map(str).join(' | ')}` : '';
  return `closed by ${by}${verdicts}${closure.permanent ? ' · permanent' : ''}`;
}

function thenLine(effect: unknown): string {
  if (!isRec(effect)) return short(effect);
  if (isRec(effect.transition)) {
    const t = effect.transition;
    return `${str(t.to) === 'closed' ? 'close' : 'open'} ${str(t.resource)}${t.verdict !== undefined ? ` → ${short(t.verdict, 24)}` : ''}`;
  }
  if (isRec(effect.reward)) return `pay ${short(effect.reward.amount, 24)}${effect.reward.to !== undefined ? ` to ${short(effect.reward.to, 22)}` : ''}`;
  if (isRec(effect.counters)) return `counters on ${short(effect.counters.on, 24)}`;
  return short(effect);
}

export function buildModel(source: string, previous?: EditorModel): EditorModel {
  let doc: Rec;
  try {
    const parsed = parse(source);
    doc = isRec(parsed) ? parsed : {};
  } catch (error) {
    if (previous) return { ...previous, parseError: error instanceof Error ? error.message : String(error) };
    doc = {};
  }

  const template = isRec(doc.template) ? doc.template : {};
  const paramsDecl = isRec(doc.params) ? doc.params : {};
  const resourcesDecl = isRec(doc.resources) ? doc.resources : {};
  const lanesRaw = Array.isArray(doc.lanes) ? doc.lanes : [];
  const lifecycle = isRec(doc.lifecycle) ? doc.lifecycle : {};
  const aggregatesRaw = Array.isArray(lifecycle.aggregates) ? lifecycle.aggregates : [];

  const fieldsById = new Map<string, Rec>();
  const collectFields = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const raw of items) {
      const { docKey, body } = familyOf(raw);
      if (docKey && typeof body.id === 'string' && isRec(body.fields)) fieldsById.set(body.id, body.fields);
      if (docKey === 'gate' && Array.isArray(body.branch)) {
        for (const branch of body.branch) {
          if (!isRec(branch)) continue;
          collectFields(branch.nodes ?? (isRec(branch.else) ? branch.else.nodes : undefined));
        }
      }
    }
  };
  lanesRaw.forEach((lane) => isRec(lane) && collectFields(lane.nodes));
  const ctx: BuildContext = { doc, resourceTypes: new Set(Object.keys(resourcesDecl)), fieldsById };

  const nodes = new Map<string, CanvasNode>();
  const upstream = new Map<string, string[]>();

  const lanes: CanvasLane[] = lanesRaw.map((raw, index) => {
    const lane = isRec(raw) ? raw : {};
    const id = str(lane.id) || `lane_${index + 1}`;
    const entryRaw = isRec(lane.entry) ? lane.entry : {};
    const entryInfo = entrySummary(entryRaw);
    const entryPath: Path = ['lanes', index, 'entry'];
    const entry: CanvasNode = {
      key: pathKey(entryPath),
      path: entryPath,
      bodyPath: entryPath,
      id,
      family: 'entry',
      docKey: 'entry',
      body: entryRaw,
      badge: entryInfo.badge,
      lines: entryInfo.lines,
      chips: entryInfo.chips,
      reads: readsOf(entryRaw),
      emitsTo: null,
      resources: isRec(entryRaw.over) ? [{ verb: 'claims', type: str(entryRaw.over.resource) }] : [],
      laneIndex: index,
    };
    nodes.set(entry.key, entry);
    upstream.set(entry.key, []);
    const order: string[] = [entry.key];

    const walk = (items: unknown, nodesPath: Path, before: string[]): { items: SeqItem[]; keys: string[] } => {
      const seq: SeqItem[] = [];
      const keys: string[] = [];
      let seen = [...before];
      (Array.isArray(items) ? items : []).forEach((rawNode, position) => {
        const path: Path = [...nodesPath, position];
        const { docKey, body } = familyOf(rawNode);
        const summary = summarizeNode(docKey, body, ctx);
        const node: CanvasNode = {
          key: pathKey(path),
          path,
          bodyPath: docKey ? [...path, docKey] : path,
          id: str(body.id) || (docKey ? `(${docKey})` : '(unreadable)'),
          docKey,
          body: docKey ? body : isRec(rawNode) ? rawNode : {},
          ...summary,
          reads: readsOf(body),
          laneIndex: index,
        };
        nodes.set(node.key, node);
        upstream.set(node.key, seen);
        order.push(node.key);
        keys.push(node.key);
        if (docKey === 'gate' && Array.isArray(body.branch)) {
          const branches: Branch[] = [];
          const inner: string[] = [];
          body.branch.forEach((rawBranch, branchIndex) => {
            const branch = isRec(rawBranch) ? rawBranch : {};
            const isElse = branch.else !== undefined;
            const branchPath: Path = [...path, 'gate', 'branch', branchIndex];
            const branchNodesPath: Path = isElse ? [...branchPath, 'else', 'nodes'] : [...branchPath, 'nodes'];
            const walked = walk(isElse ? (isRec(branch.else) ? branch.else.nodes : undefined) : branch.nodes, branchNodesPath, [...seen, node.key]);
            inner.push(...walked.keys);
            branches.push({ label: isElse ? 'else' : short(branch.when, 30) || 'when ?', isElse, path: branchPath, nodesPath: branchNodesPath, items: walked.items });
          });
          seq.push({ kind: 'routing', node, branches });
          keys.push(...inner);
          seen = [...seen, node.key, ...inner];
        } else {
          seq.push({ kind: 'node', node });
          seen = [...seen, node.key];
        }
      });
      return { items: seq, keys };
    };

    const nodesPath: Path = ['lanes', index, 'nodes'];
    const walked = walk(lane.nodes, nodesPath, [entry.key]);
    return { index, id, title: humanize(id), subtitle: entryInfo.subtitle, entry, nodesPath, items: walked.items, order };
  });

  const emittersOf = (aggregate: string) => [...nodes.values()].filter((node) => node.emitsTo === aggregate).map((node) => node.id);

  const aggregates: AggregateView[] = aggregatesRaw.map((raw, index) => {
    const decl = isRec(raw) ? raw : {};
    const id = str(decl.id) || `aggregate_${index + 1}`;
    const resolve = isRec(decl.resolve) ? decl.resolve : {};
    const rows: Line[] = [{ k: 'over', v: str(decl.over) || '?' }];
    if (decl.per_participation !== undefined) rows.push({ k: 'per participant', v: str(decl.per_participation) });
    rows.push({ k: 'resolve when', v: short(resolve.when, 40) || '?' });
    if (resolve.verdict !== undefined) rows.push({ k: 'verdict', v: short(resolve.verdict, 40) });
    (Array.isArray(resolve.then) ? resolve.then : []).forEach((effect) => rows.push({ k: 'then', v: thenLine(effect) }));
    if (isRec(decl.state_visibility)) {
      rows.push({ k: 'state', v: Object.entries(decl.state_visibility).map(([k, v]) => `${k}: ${str(v)}`).join(' · ') });
    }
    const path: Path = ['lifecycle', 'aggregates', index];
    const node: CanvasNode = {
      key: pathKey(path),
      path,
      bodyPath: path,
      id,
      family: 'aggregate',
      docKey: 'aggregate',
      body: decl,
      badge: 'lifecycle',
      lines: rows.filter((row) => row.k !== 'state'),
      chips: [],
      reads: readsOf(decl),
      emitsTo: null,
      resources: decl.over !== undefined ? [{ verb: 'closes', type: str(decl.over) }] : [],
      laneIndex: null,
    };
    nodes.set(node.key, node);
    upstream.set(node.key, []);
    return { index, id, rows, emitters: emittersOf(id), node };
  });

  const params: ParamView[] = Object.entries(paramsDecl).map(([name, raw]) => {
    const decl = isRec(raw) ? raw : {};
    const checks: ParamView['checks'] = [];
    if (decl.check !== undefined) checks.push({ name: 'check', expr: str(decl.check) });
    if (isRec(decl.checks)) for (const [checkName, expr] of Object.entries(decl.checks)) checks.push({ name: checkName, expr: str(expr) });
    return { name, type: typeText(decl.type), defaultText: decl.default !== undefined ? compact(decl.default) : null, mutable: decl.mutable === true, checks, decl };
  });

  const resources: ResourceView[] = Object.entries(resourcesDecl).map(([name, raw]) => {
    const decl = isRec(raw) ? raw : {};
    const fields = isRec(decl.fields) ? decl.fields : {};
    return {
      name,
      fields: Object.entries(fields).map(([fieldName, field]) => {
        const fieldDecl = isRec(field) ? field : {};
        const visibility = visibilityLabel(fieldDecl.visibility);
        return { name: fieldName, type: typeText(fieldDecl.type), visibility: visibility.label, tone: visibility.tone };
      }),
      claim: claimSummary(decl.claim, paramsDecl),
      closure: closureSummary(decl.closure),
      createdBy: Array.isArray(decl.created_by) ? decl.created_by.map(str) : [],
      decl,
    };
  });

  const counters: CounterView[] = Object.entries(isRec(doc.counters) ? doc.counters : {}).map(([name, raw]) => {
    const decl = isRec(raw) ? raw : {};
    return { name, type: str(decl.type) || '?', lag: typeof decl.lag === 'number' ? decl.lag : null };
  });

  return {
    parseError: null,
    doc,
    header: { id: str(template.id), version: str(template.version), name: str(template.name), summary: str(template.summary) },
    lanes,
    nodes,
    upstream,
    params,
    resources,
    counters,
    aggregates,
  };
}

/** Les nœuds en amont qu'un nœud lit vraiment : la provenance à allumer. */
export function provenanceOf(model: EditorModel, key: string): string[] {
  const node = model.nodes.get(key);
  if (!node) return [];
  const reads = new Set(node.reads);
  return (model.upstream.get(key) ?? []).filter((upstreamKey) => {
    const candidate = model.nodes.get(upstreamKey);
    return candidate && candidate.docKey !== 'entry' && reads.has(candidate.id);
  });
}

/** Où un diagnostic pointe : un nœud, une lane, une déclaration, ou l'en-tête. */
export type DiagnosticTarget =
  | { kind: 'node'; key: string }
  | { kind: 'lane'; index: number }
  | { kind: 'declaration'; tab: DeclarationTab; name: string | null }
  | { kind: 'document' };

export type DeclarationTab = 'params' | 'resources' | 'counters' | 'lifecycle' | 'template';

export function locate(model: EditorModel, path: string): DiagnosticTarget {
  let best: string | null = null;
  for (const key of model.nodes.keys()) {
    if ((path === key || path.startsWith(`${key}.`)) && (!best || key.length > best.length)) best = key;
  }
  if (best) return { kind: 'node', key: best };
  const segments = path.split('.');
  if (segments[0] === 'lanes' && segments[1] !== undefined && /^\d+$/.test(segments[1])) return { kind: 'lane', index: Number(segments[1]) };
  if (segments[0] === 'params' || segments[0] === 'resources' || segments[0] === 'counters') {
    return { kind: 'declaration', tab: segments[0], name: segments[1] ?? null };
  }
  if (segments[0] === 'lifecycle') return { kind: 'declaration', tab: 'lifecycle', name: null };
  if (segments[0] === 'template' || segments[0] === 'presentation' || segments[0] === 'requires' || segments[0] === 'format') {
    return { kind: 'declaration', tab: 'template', name: null };
  }
  return { kind: 'document' };
}

/** Ce qu'un nœud peut lire, typé : l'autocomplétion des expressions. */
export interface ContextEntry {
  path: string;
  type: string;
  from: string;
}

export function contextFor(model: EditorModel, key: string | null): ContextEntry[] {
  const entries: ContextEntry[] = [];
  const doc = model.doc;
  const resources = isRec(doc.resources) ? doc.resources : {};
  const resourceFields = (prefix: string, type: string, from: string) => {
    const decl = resources[type];
    const fields = isRec(decl) && isRec(decl.fields) ? decl.fields : {};
    for (const [name, field] of Object.entries(fields)) entries.push({ path: `${prefix}.${name}`, type: isRec(field) ? typeText(field.type) : '?', from });
    entries.push({ path: `${prefix}.open`, type: 'bool', from }, { path: `${prefix}.closed`, type: 'bool', from }, { path: `${prefix}.verdict`, type: 'string', from });
  };

  for (const param of model.params) entries.push({ path: `params.${param.name}`, type: param.type, from: 'Params' });
  for (const counter of model.counters) entries.push({ path: `counters.${counter.name}`, type: counter.type, from: 'Counters' });
  entries.push(
    { path: 'challenge.state', type: 'string', from: 'Challenge' },
    { path: 'participation.user', type: 'string', from: 'Participant' },
    { path: 'now()', type: 'date', from: 'Engine' },
  );
  for (const aggregate of model.aggregates) {
    entries.push({ path: `aggregates.${aggregate.id}.inputs`, type: 'list', from: 'Lifecycle' }, { path: `aggregates.${aggregate.id}.verdict`, type: 'string', from: 'Lifecycle' });
  }

  const node = key ? model.nodes.get(key) : null;
  if (node?.docKey === 'aggregate') {
    entries.push({ path: 'inputs', type: 'list', from: 'Aggregate' }, { path: 'verdict', type: 'string', from: 'Aggregate' });
  }
  const upstreamKeys = key ? model.upstream.get(key) ?? [] : [];
  for (const upstreamKey of upstreamKeys) {
    const upstreamNode = model.nodes.get(upstreamKey);
    if (!upstreamNode) continue;
    const from = `${upstreamNode.family === 'unknown' ? 'Node' : humanize(upstreamNode.family)} ${upstreamNode.id}`;
    const body = upstreamNode.body;
    if (upstreamNode.docKey === 'entry') {
      if (isRec(body.over) && typeof body.over.resource === 'string') resourceFields(body.over.resource, body.over.resource, from);
      continue;
    }
    if (isRec(body.fields)) {
      for (const [name, field] of Object.entries(body.fields)) {
        const type = isRec(field) ? typeText(field.type) : '?';
        entries.push({ path: `${upstreamNode.id}.${name}`, type, from });
        const ref = /^ref\(\s*([a-z][a-z0-9_]*)\s*\)$/.exec(type);
        if (ref) resourceFields(`${upstreamNode.id}.${name}`, ref[1], from);
      }
    }
    if (isRec(body.claim)) {
      const type = str(body.claim.resource);
      if (resources[type] !== undefined) resourceFields(`${upstreamNode.id}.${type}`, type, from);
      if (isRec(body.claim.substitute)) {
        const substitute = str(body.claim.substitute.resource);
        entries.push({ path: `${upstreamNode.id}.substituted`, type: 'bool', from });
        resourceFields(`${upstreamNode.id}.${substitute}`, substitute, from);
      }
    }
    if (typeof body.store === 'string') entries.push({ path: `${upstreamNode.id}.${body.store}`, type: 'json', from });
    if (upstreamNode.docKey === 'assess') entries.push({ path: `${upstreamNode.id}.value`, type: 'dyn', from });
  }
  return entries;
}

/** Les ids de nœuds déjà pris, lanes et aggregates compris : un nouvel id n'en recouvre aucun. */
export function uniqueId(model: EditorModel, base: string): string {
  const taken = new Set([...model.nodes.values()].map((node) => node.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

/**
 * Les lectures qui ne remontent à aucun prédécesseur : `pay` lit `check`
 * alors que `check` est plus bas. L'ensemble sert à refuser un déplacement
 * qui en crée une nouvelle.
 */
export function brokenReads(model: EditorModel): Map<string, { node: string; reads: string }> {
  const laneIds = new Map<number, Set<string>>();
  for (const node of model.nodes.values()) {
    if (node.laneIndex === null || node.docKey === 'entry') continue;
    if (!laneIds.has(node.laneIndex)) laneIds.set(node.laneIndex, new Set());
    laneIds.get(node.laneIndex)!.add(node.id);
  }
  const allIds = new Set([...model.nodes.values()].filter((node) => node.docKey !== 'entry' && node.docKey !== 'aggregate').map((node) => node.id));
  const broken = new Map<string, { node: string; reads: string }>();
  for (const node of model.nodes.values()) {
    if (node.laneIndex === null) continue;
    const upstreamIds = new Set((model.upstream.get(node.key) ?? []).map((key) => model.nodes.get(key)?.id));
    for (const root of node.reads) {
      if (root === node.id || !allIds.has(root) || upstreamIds.has(root)) continue;
      broken.set(`${node.id}->${root}`, { node: node.id, reads: root });
    }
  }
  return broken;
}
