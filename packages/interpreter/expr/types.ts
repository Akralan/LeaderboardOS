/**
 * Les types du format
 * -------------------
 * Ceux des paramètres, des champs collectés, des champs de ressources et des
 * expressions. `dyn` est le type d'une donnée que le template ne décrit pas
 * (un `json`, la sortie d'un connecteur choisi par paramètre) : tout s'y lit,
 * rien n'y est vérifié.
 */

export type Type =
  | { kind: "int" }
  | { kind: "number" }
  | { kind: "bool" }
  | { kind: "string" }
  | { kind: "null" }
  | { kind: "dyn" }
  /** `values` à `null` : les valeurs viennent d'un paramètre, inconnues avant l'instanciation. */
  | { kind: "enum"; values: readonly string[] | null }
  | { kind: "url" }
  | { kind: "file" }
  | { kind: "date" }
  | { kind: "duration" }
  | { kind: "user" }
  | { kind: "role" }
  | { kind: "capability" }
  | { kind: "grid" }
  | { kind: "template" }
  | { kind: "challenge" }
  /** Une contribution d'un challenge source (`link`). */
  | { kind: "contribution" }
  | { kind: "list"; of: Type }
  | { kind: "record"; fields: Readonly<Record<string, Type>> }
  /** Une instance d'un type de ressource du template, résolue par nom. */
  | { kind: "resource"; name: string };

export const T = {
  int: { kind: "int" } as Type,
  number: { kind: "number" } as Type,
  bool: { kind: "bool" } as Type,
  string: { kind: "string" } as Type,
  null: { kind: "null" } as Type,
  dyn: { kind: "dyn" } as Type,
  url: { kind: "url" } as Type,
  file: { kind: "file" } as Type,
  date: { kind: "date" } as Type,
  duration: { kind: "duration" } as Type,
  user: { kind: "user" } as Type,
  role: { kind: "role" } as Type,
  capability: { kind: "capability" } as Type,
  grid: { kind: "grid" } as Type,
  template: { kind: "template" } as Type,
  challenge: { kind: "challenge" } as Type,
  contribution: { kind: "contribution" } as Type,
  list: (of: Type): Type => ({ kind: "list", of }),
  record: (fields: Record<string, Type>): Type => ({ kind: "record", fields }),
  resource: (name: string): Type => ({ kind: "resource", name }),
  enum: (values: readonly string[] | null): Type => ({ kind: "enum", values }),
};

export function showType(type: Type): string {
  switch (type.kind) {
    case "enum":
      return type.values ? `enum(${type.values.join(", ")})` : "enum";
    case "list":
      return `list(${showType(type.of)})`;
    case "record":
      return `{${Object.entries(type.fields)
        .map(([key, value]) => `${key}: ${showType(value)}`)
        .join(", ")}}`;
    case "resource":
      return type.name;
    default:
      return type.kind;
  }
}

export const isNumeric = (type: Type) => type.kind === "int" || type.kind === "number" || type.kind === "dyn";

/** Ce qui se compare comme une chaîne : une énumération, une URL, un rôle… */
export const isStringLike = (type: Type) =>
  type.kind === "string" || type.kind === "enum" || type.kind === "url" || type.kind === "role" ||
  type.kind === "capability" || type.kind === "grid" || type.kind === "template";

export function sameType(a: Type, b: Type): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "list":
      return sameType(a.of, (b as typeof a).of);
    case "resource":
      return a.name === (b as typeof a).name;
    case "enum": {
      const other = b as typeof a;
      if (!a.values || !other.values) return true;
      return a.values.length === other.values.length && a.values.every((value) => other.values!.includes(value));
    }
    case "record": {
      const other = b as typeof a;
      const keys = Object.keys(a.fields);
      return keys.length === Object.keys(other.fields).length &&
        keys.every((key) => other.fields[key] !== undefined && sameType(a.fields[key], other.fields[key]));
    }
    default:
      return true;
  }
}

/** Deux types qu'on peut comparer par `==` ou `!=`. */
export function comparable(a: Type, b: Type): boolean {
  if (a.kind === "dyn" || b.kind === "dyn" || a.kind === "null" || b.kind === "null") return true;
  if (isNumeric(a) && isNumeric(b)) return true;
  if (isStringLike(a) && isStringLike(b)) return true;
  if (a.kind === "list" && b.kind === "list") return comparable(a.of, b.of);
  return sameType(a, b);
}

/** Une valeur de type `source` peut-elle occuper une place de type `target` ? */
export function assignable(target: Type, source: Type): boolean {
  if (target.kind === "dyn" || source.kind === "dyn" || source.kind === "null") return true;
  if (target.kind === "number" && source.kind === "int") return true;
  if (target.kind === "string" && isStringLike(source)) return true;
  if (target.kind === "enum" && source.kind === "enum") {
    if (!target.values || !source.values) return true;
    return source.values.every((value) => target.values!.includes(value));
  }
  if (target.kind === "enum" && source.kind === "string") return true;
  if (target.kind === "list" && source.kind === "list") return assignable(target.of, source.of);
  return sameType(target, source);
}

/** Le type commun de deux branches d'un ternaire ou des éléments d'une liste. */
export function unify(a: Type, b: Type): Type | null {
  if (a.kind === "dyn" || b.kind === "dyn") return T.dyn;
  if (a.kind === "null") return b;
  if (b.kind === "null") return a;
  if (isNumeric(a) && isNumeric(b)) return a.kind === "int" && b.kind === "int" ? T.int : T.number;
  if (a.kind === "enum" && b.kind === "enum") {
    if (!a.values || !b.values) return T.enum(null);
    return T.enum([...new Set([...a.values, ...b.values])]);
  }
  if (isStringLike(a) && isStringLike(b)) return sameType(a, b) ? a : T.string;
  if (a.kind === "list" && b.kind === "list") {
    const of = unify(a.of, b.of);
    return of ? T.list(of) : null;
  }
  return sameType(a, b) ? a : null;
}
