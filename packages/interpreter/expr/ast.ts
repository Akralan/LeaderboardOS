/**
 * L'arbre d'une expression. Chaque nœud porte sa position (un décalage dans le
 * texte source) pour que les erreurs désignent l'endroit exact.
 */

export type Expr =
  | { k: "lit"; type: "int" | "number" | "string" | "bool" | "null"; value: number | string | boolean | null; pos: number }
  | { k: "ident"; name: string; pos: number }
  | { k: "member"; object: Expr; name: string; pos: number }
  | { k: "index"; object: Expr; index: Expr; pos: number }
  | { k: "call"; callee: string; args: Expr[]; pos: number }
  | { k: "method"; object: Expr; name: string; args: Expr[]; pos: number }
  | { k: "unary"; op: "!" | "-"; arg: Expr; pos: number }
  | { k: "binary"; op: BinaryOp; left: Expr; right: Expr; pos: number }
  | { k: "cond"; test: Expr; then: Expr; else: Expr; pos: number }
  | { k: "list"; items: Expr[]; pos: number };

export type BinaryOp = "||" | "&&" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "+" | "-" | "*" | "/" | "%";

/** Les enfants directs d'un nœud. */
function children(expr: Expr): Expr[] {
  switch (expr.k) {
    case "lit":
    case "ident":
      return [];
    case "member":
      return [expr.object];
    case "index":
      return [expr.object, expr.index];
    case "call":
      return expr.args;
    case "method":
      return [expr.object, ...expr.args];
    case "unary":
      return [expr.arg];
    case "binary":
      return [expr.left, expr.right];
    case "cond":
      return [expr.test, expr.then, expr.else];
    case "list":
      return expr.items;
  }
}

/** L'expression lit-elle le nom racine `name` (`counters`, `params`…) ? */
export function readsRoot(expr: Expr, name: string): boolean {
  if (expr.k === "ident") return expr.name === name;
  return children(expr).some((child) => readsRoot(child, name));
}
