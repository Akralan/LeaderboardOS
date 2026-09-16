import { isCollection, isMap, isPair, isScalar, isSeq, parseDocument, type Document, type Node, type Pair } from "yaml";

/**
 * Réécrire un document YAML sans toucher au reste du texte
 * -------------------------------------------------------
 * `Document.toString()` resérialise tout : les scalaires `>` repliés, les
 * mappings de flux trop longs, les espacements changent même là où rien n'a
 * bougé. Ici, le texte d'origine de chaque sous-arbre inchangé est recopié à
 * l'octet près ; seuls les sous-arbres modifiés prennent la sérialisation de
 * la bibliothèque. Le résultat est relu et comparé au document voulu : au
 * moindre écart, la sérialisation standard est rendue — jamais un texte faux.
 */

const OPTIONS = { lineWidth: 0, flowCollectionPadding: false } as const;

const lineStart = (text: string, position: number) => text.lastIndexOf("\n", position - 1) + 1;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const jsOf = (node: unknown, doc: Document) => (node && typeof node === "object" && "toJS" in node ? (node as Node).toJS(doc) : node);

interface Child {
  key: string | null;
  start: number;
  value: unknown;
  node: unknown;
}

/** Les enfants d'une collection en bloc, avec la ligne où chacun commence. */
function childrenOf(collection: Node, text: string, doc: Document): Child[] | null {
  if (!isCollection(collection) || collection.flow) return null;
  const children: Child[] = [];
  for (const item of collection.items as unknown[]) {
    if (isMap(collection)) {
      const pair = item as Pair;
      if (!isPair(pair) || !isScalar(pair.key) || !pair.key.range) return null;
      children.push({ key: String(pair.key.value), start: lineStart(text, pair.key.range[0]), value: jsOf(pair.value, doc), node: pair.value });
    } else {
      const node = item as Node;
      if (!node?.range) return null;
      children.push({ key: null, start: lineStart(text, node.range[0]), value: jsOf(node, doc), node });
    }
  }
  return children;
}

interface Side {
  text: string;
  doc: Document;
}

function merge(original: Node, o: Side, oStart: number, oEnd: number, next: Node, n: Side, nStart: number, nEnd: number): string {
  const originalText = o.text;
  const nextText = n.text;
  if (same(jsOf(original, o.doc), jsOf(next, n.doc))) return originalText.slice(oStart, oEnd);
  const oChildren = isMap(original) === isMap(next) && isSeq(original) === isSeq(next) ? childrenOf(original, originalText, o.doc) : null;
  const nChildren = oChildren ? childrenOf(next, nextText, n.doc) : null;
  if (!oChildren || !nChildren || nChildren.length === 0 || oChildren.length === 0) return nextText.slice(nStart, nEnd);

  const regions = (children: Child[], end: number) => children.map((child, index) => ({ ...child, end: index + 1 < children.length ? children[index + 1].start : end }));
  const oRegions = regions(oChildren, oEnd);
  const nRegions = regions(nChildren, nEnd);

  let text = nextText.slice(nStart, nRegions[0].start);
  let cursor = 0;
  for (const child of nRegions) {
    let match = -1;
    if (child.key !== null) match = oRegions.findIndex((candidate) => candidate.key === child.key);
    else {
      for (let index = cursor; index < oRegions.length; index++) {
        if (same(oRegions[index].value, child.value)) {
          match = index;
          break;
        }
      }
      if (match < 0 && cursor < oRegions.length && oRegions.length === nRegions.length) match = cursor;
    }
    if (match < 0) {
      text += nextText.slice(child.start, child.end);
      continue;
    }
    if (child.key === null) cursor = match + 1;
    const region = oRegions[match];
    text += same(region.value, child.value)
      ? originalText.slice(region.start, region.end)
      : isCollection(region.node) && isCollection(child.node)
        ? mergeValue(region, child, o, n)
        : nextText.slice(child.start, child.end);
  }
  return text;
}

/** Un enfant modifié : sa première ligne (clé ou tiret) vient du nouveau texte, son contenu se fusionne. */
function mergeValue(o: Child & { end: number }, n: Child & { end: number }, oSide: Side, nSide: Side): string {
  const originalText = oSide.text;
  const nextText = nSide.text;
  const oNode = o.node as Node;
  const nNode = n.node as Node;
  if (!oNode.range || !nNode.range || (isCollection(oNode) && oNode.flow) || (isCollection(nNode) && nNode.flow)) return nextText.slice(n.start, n.end);
  const oInner = lineStart(originalText, oNode.range[0]);
  const nInner = lineStart(nextText, nNode.range[0]);
  // Un élément de séquence qui ouvre sa map sur la ligne du tiret (`- id: x`) : sa première clé porte le tiret.
  if (oInner === o.start && nInner === n.start) return merge(oNode, oSide, o.start, o.end, nNode, nSide, n.start, n.end);
  if (oInner === o.start || nInner === n.start) return nextText.slice(n.start, n.end);
  return nextText.slice(n.start, nInner) + merge(oNode, oSide, oInner, o.end, nNode, nSide, nInner, n.end);
}

/** Le texte de `doc`, en recopiant de `original` tout ce qui n'a pas changé. */
export function stringifyPreserving(original: string, doc: Document): string {
  const fallback = doc.toString(OPTIONS);
  try {
    const before = parseDocument(original);
    const after = parseDocument(fallback);
    if (before.errors.length || after.errors.length || !isMap(before.contents) || !isMap(after.contents)) return fallback;
    const firstBefore = childrenOf(before.contents, original, before)?.[0]?.start ?? 0;
    const firstAfter = childrenOf(after.contents, fallback, after)?.[0]?.start ?? 0;
    const prefix = before.commentBefore === after.commentBefore ? original.slice(0, firstBefore) : fallback.slice(0, firstAfter);
    const body = merge(before.contents, { text: original, doc: before }, firstBefore, original.length, after.contents, { text: fallback, doc: after }, firstAfter, fallback.length);
    const text = prefix + body;
    const check = parseDocument(text);
    return check.errors.length === 0 && same(check.toJS(), doc.toJS()) ? text : fallback;
  } catch {
    return fallback;
  }
}
