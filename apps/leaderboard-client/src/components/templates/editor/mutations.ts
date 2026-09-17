import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLSeq } from 'yaml';
import { stringifyPreserving } from '../../../../../../packages/template-author/yaml-text';
import type { Family } from './families';
import { brokenReads, buildModel, pathKey, uniqueId, type EditorModel, type Path } from './model';

/**
 * Les écritures de l'éditeur
 * --------------------------
 * Chaque geste du canevas est une réécriture du texte : le document YAML est
 * relu, modifié à l'endroit visé et resérialisé, commentaires compris. Le
 * texte reste la seule vérité — ce que « View source » montre, ce que la
 * sauvegarde envoie, ce que l'annulation restaure.
 */

function edit(source: string, change: (doc: Document) => void): string {
  const doc = parseDocument(source);
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as unknown as typeof doc.contents;
  change(doc);
  // Ce que le geste n'a pas touché garde son texte d'origine, à l'octet près.
  return stringifyPreserving(source, doc);
}

function seqAt(doc: Document, path: Path): YAMLSeq {
  const existing = doc.getIn(path, true);
  if (isSeq(existing)) return existing;
  doc.setIn(path, doc.createNode([]));
  return doc.getIn(path, true) as YAMLSeq;
}

/** Écrit une valeur ; `undefined` supprime la clé. */
export function setAt(source: string, path: Path, value: unknown): string {
  return edit(source, (doc) => {
    if (value === undefined) {
      if (doc.hasIn(path)) doc.deleteIn(path);
      return;
    }
    doc.setIn(path, doc.createNode(value));
  });
}

export function removeAt(source: string, path: Path): string {
  return edit(source, (doc) => {
    if (doc.hasIn(path)) doc.deleteIn(path);
  });
}

export function insertAt(source: string, seqPath: Path, index: number, value: unknown): string {
  return edit(source, (doc) => {
    const seq = seqAt(doc, seqPath);
    seq.items.splice(Math.max(0, Math.min(index, seq.items.length)), 0, doc.createNode(value));
  });
}

/**
 * Déplace un nœud dans une séquence, la même ou une autre. La séquence cible
 * est résolue avant le retrait : un index décalé par le retrait ne la perd pas.
 */
export function moveNode(source: string, from: Path, toSeqPath: Path, toIndex: number): string {
  return edit(source, (doc) => {
    const fromSeq = doc.getIn(from.slice(0, -1), true);
    const position = from[from.length - 1];
    if (!isSeq(fromSeq) || typeof position !== 'number') return;
    const target = seqAt(doc, toSeqPath);
    const [item] = fromSeq.items.splice(position, 1);
    const index = target === fromSeq && position < toIndex ? toIndex - 1 : toIndex;
    target.items.splice(Math.max(0, Math.min(index, target.items.length)), 0, item);
  });
}

/** Renomme une clé de map en gardant sa place et ses commentaires. */
export function renameKey(source: string, mapPath: Path, from: string, to: string): string {
  return edit(source, (doc) => {
    const map = mapPath.length ? doc.getIn(mapPath, true) : doc.contents;
    if (!isMap(map)) return;
    const pair = map.items.find((item) => (isScalar(item.key) ? item.key.value : item.key) === from);
    if (!pair) return;
    if (isScalar(pair.key)) pair.key.value = to;
    else pair.key = doc.createNode(to);
  });
}

/** Ajoute une branche avant `else`, qui reste la dernière. */
export function addBranch(source: string, gateBodyPath: Path): string {
  return edit(source, (doc) => {
    const branches = seqAt(doc, [...gateBodyPath, 'branch']);
    const elseIndex = branches.items.findIndex((item) => isMap(item) && item.has('else'));
    const index = elseIndex >= 0 ? elseIndex : branches.items.length;
    branches.items.splice(index, 0, doc.createNode({ when: 'true', nodes: [] }));
  });
}

/** Bascule une Gate entre bloquante (`all`) et routage (`branch`). */
export function setGateMode(source: string, gateBodyPath: Path, mode: 'blocking' | 'routing'): string {
  return edit(source, (doc) => {
    if (mode === 'routing') {
      if (doc.hasIn([...gateBodyPath, 'all'])) doc.deleteIn([...gateBodyPath, 'all']);
      if (doc.hasIn([...gateBodyPath, 'refuse'])) doc.deleteIn([...gateBodyPath, 'refuse']);
      if (!doc.hasIn([...gateBodyPath, 'branch'])) doc.setIn([...gateBodyPath, 'branch'], doc.createNode([{ when: 'true', nodes: [] }, { else: { nodes: [] } }]));
    } else {
      if (doc.hasIn([...gateBodyPath, 'branch'])) doc.deleteIn([...gateBodyPath, 'branch']);
      if (!doc.hasIn([...gateBodyPath, 'all'])) doc.setIn([...gateBodyPath, 'all'], doc.createNode(['true']));
    }
  });
}

const ID_BASE: Record<Family, string> = {
  entry: 'lane',
  collect: 'form',
  gate: 'check',
  act: 'act',
  assess: 'assess',
  reward: 'pay',
  transition: 'close',
  aggregate: 'consensus',
};

/** Le premier paramètre de type `points` : le pool qu'une nouvelle récompense vise. */
function poolParam(model: EditorModel): string | null {
  return model.params.find((param) => param.type === 'points' && !param.mutable)?.name ?? null;
}

/** Le corps d'un nœud neuf, tel que la palette le dépose. */
export function newNodeValue(family: Exclude<Family, 'entry' | 'aggregate'>, model: EditorModel): Record<string, unknown> {
  const id = uniqueId(model, ID_BASE[family]);
  const firstResource = model.resources[0]?.name ?? 'item';
  switch (family) {
    case 'collect':
      return { collect: { id, fields: { value: { type: 'string' } } } };
    case 'gate':
      return { gate: { id, all: ['true'] } };
    case 'act':
      return { act: { id, claim: { resource: firstResource } } };
    case 'assess':
      return { assess: { id, kind: 'human', fields: { verdict: { type: 'enum(accepted, rejected)' } } } };
    case 'reward': {
      const pool = poolParam(model);
      return { reward: { id, amount: '0', ...(pool ? { pool: `params.${pool}`, clamp: 'pool' } : {}) } };
    }
    case 'transition':
      return { act: { id, transition: { resource: firstResource, to: 'closed' } } };
  }
}

export function newLaneValue(model: EditorModel, trigger: 'user' | 'admin' | 'cron'): Record<string, unknown> {
  const taken = new Set(model.lanes.map((lane) => lane.id));
  let id = trigger === 'user' ? 'participant' : trigger === 'admin' ? 'manage' : 'schedule';
  for (let n = 2; taken.has(id); n++) id = `${id.replace(/_\d+$/, '')}_${n}`;
  const entry =
    trigger === 'user' ? { trigger, access: { mode: 'open' } } : trigger === 'cron' ? { trigger, schedule: '0 4 * * 1' } : { trigger };
  return { id, entry, nodes: [] };
}

export function newAggregateValue(model: EditorModel): Record<string, unknown> {
  return {
    id: uniqueId(model, ID_BASE.aggregate),
    over: model.resources[0]?.name ?? 'item',
    resolve: { when: 'count(inputs) >= 3', verdict: 'mode(inputs.map(i, i.value))' },
  };
}

/** Un texte neuf : l'en-tête, le pool, et aucune lane — le canevas vide invite à poser la première entrée. */
export function blankTemplate(key: string, name: string): string {
  return [
    'format: leaderboardos/1',
    '',
    'template:',
    `  id: ${key}`,
    '  version: 1.0.0',
    `  name: ${JSON.stringify(name)}`,
    `  summary: ${JSON.stringify(name)}`,
    '',
    'requires: {core: 1}',
    '',
    'params:',
    '  pool: {type: points, mutable: false}',
    '',
    'lanes: []',
    '',
  ].join('\n');
}

export type DropSource = { kind: 'palette'; family: Family } | { kind: 'node'; path: Path };

/**
 * Le câblage refusé : ce qu'un dépôt sur le rail ne peut pas faire, avec sa raison.
 * `null` : le dépôt est accepté.
 */
export function refusalOf(source: string, model: EditorModel, drop: DropSource, toSeqPath: Path, toIndex: number): string | null {
  if (drop.kind === 'palette') {
    if (drop.family === 'entry') return 'An entry starts a lane — drop it on “New lane”.';
    if (drop.family === 'aggregate') return 'An aggregate lives off-canvas, in Lifecycle — Assess nodes emit to it.';
    return null;
  }
  const from = pathKey(drop.path);
  const target = pathKey(toSeqPath);
  if (target === from || target.startsWith(`${from}.`)) return 'A gate cannot move inside its own branches.';
  const moved = moveNode(source, drop.path, toSeqPath, toIndex);
  const before = brokenReads(model);
  for (const [signature, broken] of brokenReads(buildModel(moved))) {
    if (before.has(signature)) continue;
    return `‘${broken.node}’ reads ‘${broken.reads}’ — it must stay below ‘${broken.reads}’ in the same lane.`;
  }
  return null;
}

/** La version suivante d'un semver, pour le sélecteur de publication. */
export function bump(version: string, level: 'patch' | 'minor' | 'major'): string {
  const [major, minor, patch] = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}


