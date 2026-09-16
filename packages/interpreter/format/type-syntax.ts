/**
 * La syntaxe des types déclarés
 * -----------------------------
 * `string`, `points`, `enum(works, broken)`, `enum(params.platforms)`,
 * `ref(target)`, `list({kind: string, grid: grid_ref})`… Un type s'écrit en
 * texte, ou en mapping YAML pour un enregistrement. Le texte se lit ici en un
 * petit arbre ; sa résolution en `Type` (les `ref` vers les ressources
 * déclarées, les énumérations tirées d'un paramètre) appartient à l'analyse.
 */

export type TypeNode =
  | { k: "name"; name: string }
  | { k: "enum"; values: string[] }
  /** Les valeurs viennent d'une expression sur les paramètres. */
  | { k: "enum_expr"; source: string }
  | { k: "ref"; resource: string }
  | { k: "list"; of: TypeNode }
  | { k: "record"; fields: Record<string, TypeNode> };

export class TypeSyntaxError extends Error {}

export const SCALAR_TYPES = [
  "string", "int", "number", "ratio", "points", "bool", "url", "file", "json", "date", "duration",
  "role", "capability", "grid_ref", "template_ref", "challenge_ref", "expr", "link",
] as const;

export function parseTypeSpec(spec: unknown): TypeNode {
  if (spec !== null && typeof spec === "object" && !Array.isArray(spec)) {
    const fields: Record<string, TypeNode> = {};
    for (const [key, value] of Object.entries(spec)) fields[key] = parseTypeSpec(value);
    return { k: "record", fields };
  }
  if (typeof spec !== "string") throw new TypeSyntaxError(`a type is a string or a mapping, got ${JSON.stringify(spec)}`);
  return parseText(spec.trim());
}

function parseText(text: string): TypeNode {
  const call = /^([a-z_]+)\((.*)\)$/s.exec(text);
  if (call) {
    const [, head, inner] = call;
    const body = inner.trim();
    switch (head) {
      case "enum":
        if (body === "") throw new TypeSyntaxError("enum() needs values");
        if (/[.(]/.test(body)) return { k: "enum_expr", source: body };
        return { k: "enum", values: splitTopLevel(body).map((value) => value.trim()) };
      case "ref":
        if (!/^[a-z_][a-z0-9_]*$/.test(body)) throw new TypeSyntaxError(`ref() names a resource type, got '${body}'`);
        return { k: "ref", resource: body };
      case "list":
        return { k: "list", of: parseText(body) };
      default:
        throw new TypeSyntaxError(`unknown type constructor '${head}'`);
    }
  }
  if (text.startsWith("{") && text.endsWith("}")) {
    const fields: Record<string, TypeNode> = {};
    const inner = text.slice(1, -1).trim();
    if (inner === "") return { k: "record", fields };
    for (const entry of splitTopLevel(inner)) {
      const colon = entry.indexOf(":");
      if (colon < 0) throw new TypeSyntaxError(`record field '${entry.trim()}' has no type`);
      fields[entry.slice(0, colon).trim()] = parseText(entry.slice(colon + 1).trim());
    }
    return { k: "record", fields };
  }
  if (text === "enum") throw new TypeSyntaxError("enum needs its values: enum(a, b) or enum(params.x)");
  if (!(SCALAR_TYPES as readonly string[]).includes(text)) throw new TypeSyntaxError(`unknown type '${text}'`);
  return { k: "name", name: text };
}

/** Découpe sur les virgules qui ne sont dans aucune parenthèse ni accolade. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}
