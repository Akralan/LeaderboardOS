import type { Expr } from "./ast.js";
import { T, comparable, isNumeric, isStringLike, showType, unify, type Type } from "./types.js";

/**
 * Le vérificateur de types
 * ------------------------
 * Donne son type à une expression dans un contexte fermé : les noms que le
 * nœud voit (`params`, `counters`, les nœuds déjà passés de la lane…) et
 * rien d'autre. Un nom inconnu, un champ inconnu, une comparaison entre types
 * incompatibles ou une fonction hors de la bibliothèque est une erreur, avec
 * sa position dans le texte.
 *
 * La bibliothèque est fermée : `size, count, exists, majority, mode, mean,
 * min, max, has, age, int, double, string` et les macros de liste `map,
 * filter, exists, all`. `majority`, `mode`, `mean` et `age` ne sont pas du CEL
 * standard : la syntaxe est celle de CEL, la bibliothèque est la nôtre.
 */

export type ExprIssuePass = "reference" | "type" | "shape";

export interface ExprIssue {
  pass: ExprIssuePass;
  message: string;
  position: number;
}

/** Explique un nom absent du contexte : produit plus loin dans la lane, dans une branche… */
export type Explain = (name: string) => { pass: ExprIssuePass; message: string } | undefined;

export class Scope {
  private constructor(
    private readonly bindings: ReadonlyMap<string, Type>,
    private readonly parent: Scope | null,
    readonly explain: Explain | undefined
  ) {}

  static root(bindings: Record<string, Type>, explain?: Explain): Scope {
    return new Scope(new Map(Object.entries(bindings)), null, explain);
  }

  with(bindings: Record<string, Type>, explain?: Explain): Scope {
    return new Scope(new Map(Object.entries(bindings)), this, explain ?? this.explain);
  }

  lookup(name: string): Type | undefined {
    return this.bindings.get(name) ?? this.parent?.lookup(name);
  }
}

export interface CheckEnv {
  /** Les champs d'une instance de ressource, colonnes du moteur comprises. */
  resourceFields(name: string): Readonly<Record<string, Type>> | undefined;
}

const CONTRIBUTION_FIELDS: Record<string, Type> = { author: T.user, url: T.url, kind: T.string, metadata: T.dyn };
const USER_FIELDS: Record<string, Type> = { id: T.string };

export const BUILTINS = [
  "size", "count", "exists", "majority", "mode", "mean", "min", "max", "has", "age", "int", "double", "string",
] as const;

export function checkExpr(expr: Expr, scope: Scope, env: CheckEnv): { type: Type; issues: ExprIssue[] } {
  const issues: ExprIssue[] = [];
  const fail = (pass: ExprIssuePass, message: string, position: number): Type => {
    issues.push({ pass, message, position });
    return T.dyn;
  };

  const fieldsOf = (type: Type): Readonly<Record<string, Type>> | undefined => {
    switch (type.kind) {
      case "record":
        return type.fields;
      case "resource":
        return env.resourceFields(type.name);
      case "contribution":
        return CONTRIBUTION_FIELDS;
      case "user":
        return USER_FIELDS;
      default:
        return undefined;
    }
  };

  const expectBool = (node: Expr, s: Scope, what: string) => {
    const type = visit(node, s);
    if (type.kind !== "bool" && type.kind !== "dyn") fail("type", `${what} must be bool, got ${showType(type)}`, node.pos);
  };

  const elementOf = (node: Expr, type: Type, what: string): Type => {
    if (type.kind === "list") return type.of;
    if (type.kind === "dyn") return T.dyn;
    return fail("type", `${what} expects a list, got ${showType(type)}`, node.pos);
  };

  /** `coll.map(v, body)` et `exists(coll, v, body)` : lie `v` le temps du corps. */
  const comprehension = (node: Expr, element: Type, binder: Expr | undefined, body: Expr | undefined, s: Scope) => {
    if (!binder || binder.k !== "ident" || !body) {
      fail("type", "a comprehension takes a variable name and an expression", node.pos);
      return { body: T.dyn };
    }
    return { body: visit(body, s.with({ [binder.name]: element })) };
  };

  const enumLiteralMismatch = (enumSide: Type, other: Expr): string | null => {
    if (enumSide.kind !== "enum" || !enumSide.values) return null;
    if (other.k !== "lit" || other.type !== "string") return null;
    const value = other.value as string;
    return enumSide.values.includes(value) ? null : `"${value}" is not one of ${showType(enumSide)}`;
  };

  const visit = (node: Expr, s: Scope): Type => {
    switch (node.k) {
      case "lit":
        return T[node.type];

      case "ident": {
        const type = s.lookup(node.name);
        if (type) return type;
        const explained = s.explain?.(node.name);
        if (explained) return fail(explained.pass, explained.message, node.pos);
        return fail("reference", `unknown name '${node.name}'`, node.pos);
      }

      case "member": {
        const object = visit(node.object, s);
        if (object.kind === "dyn") return T.dyn;
        const fields = fieldsOf(object);
        if (!fields) return fail("type", `${showType(object)} has no field '${node.name}'`, node.pos);
        const field = fields[node.name];
        if (!field) return fail("reference", `unknown field '${node.name}' on ${showType(object)}`, node.pos);
        return field;
      }

      case "index": {
        const object = visit(node.object, s);
        const index = visit(node.index, s);
        if (object.kind === "dyn") return T.dyn;
        if (object.kind === "list") {
          if (index.kind !== "int" && index.kind !== "dyn") fail("type", `a list index must be int, got ${showType(index)}`, node.index.pos);
          return object.of;
        }
        if (object.kind === "record") {
          if (!isStringLike(index) && index.kind !== "dyn") fail("type", `a record key must be a string, got ${showType(index)}`, node.index.pos);
          const types = Object.values(object.fields);
          const common = types.reduce<Type | null>((acc, type) => (acc === null ? type : unify(acc, type)), null);
          return common ?? T.dyn;
        }
        return fail("type", `${showType(object)} cannot be indexed`, node.pos);
      }

      case "unary": {
        const arg = visit(node.arg, s);
        if (node.op === "!") {
          if (arg.kind !== "bool" && arg.kind !== "dyn") return fail("type", `'!' expects bool, got ${showType(arg)}`, node.pos);
          return T.bool;
        }
        if (!isNumeric(arg)) return fail("type", `'-' expects a number, got ${showType(arg)}`, node.pos);
        return arg;
      }

      case "binary": {
        const left = visit(node.left, s);
        const right = visit(node.right, s);
        switch (node.op) {
          case "&&":
          case "||":
            for (const [side, type] of [[node.left, left], [node.right, right]] as const) {
              if (type.kind !== "bool" && type.kind !== "dyn") fail("type", `'${node.op}' expects bool, got ${showType(type)}`, side.pos);
            }
            return T.bool;
          case "==":
          case "!=": {
            if (!comparable(left, right)) {
              return fail("type", `cannot compare ${showType(left)} with ${showType(right)}`, node.pos);
            }
            const mismatch = enumLiteralMismatch(left, node.right) ?? enumLiteralMismatch(right, node.left);
            if (mismatch) fail("type", mismatch, node.pos);
            return T.bool;
          }
          case "<":
          case "<=":
          case ">":
          case ">=": {
            const ordered =
              (isNumeric(left) && isNumeric(right)) ||
              (isStringLike(left) && isStringLike(right)) ||
              (left.kind === "date" && right.kind === "date") ||
              left.kind === "dyn" || right.kind === "dyn";
            if (!ordered) return fail("type", `cannot order ${showType(left)} and ${showType(right)}`, node.pos);
            return T.bool;
          }
          case "+":
            if (left.kind === "string" && right.kind === "string") return T.string;
            if (left.kind === "list" && right.kind === "list") return unify(left, right) ?? fail("type", "cannot concatenate lists of different types", node.pos);
          // fallthrough
          case "-":
          case "*":
          case "/":
          case "%": {
            if (!isNumeric(left) || !isNumeric(right)) {
              return fail("type", `'${node.op}' expects numbers, got ${showType(left)} and ${showType(right)}`, node.pos);
            }
            if (left.kind === "dyn" || right.kind === "dyn") return T.dyn;
            return left.kind === "int" && right.kind === "int" ? T.int : T.number;
          }
        }
        return T.dyn;
      }

      case "cond": {
        expectBool(node.test, s, "a ternary condition");
        const thenType = visit(node.then, s);
        const elseType = visit(node.else, s);
        return unify(thenType, elseType) ??
          fail("type", `ternary branches differ: ${showType(thenType)} and ${showType(elseType)}`, node.pos);
      }

      case "list": {
        let element: Type | null = null;
        for (const item of node.items) {
          const type = visit(item, s);
          element = element === null ? type : unify(element, type) ?? fail("type", "list items have different types", item.pos);
        }
        return T.list(element ?? T.dyn);
      }

      case "method": {
        const object = visit(node.object, s);
        const [binder, body] = node.args;
        switch (node.name) {
          case "map": {
            const element = elementOf(node.object, object, "map");
            return T.list(comprehension(node, element, binder, body, s).body);
          }
          case "filter": {
            const element = elementOf(node.object, object, "filter");
            const { body: predicate } = comprehension(node, element, binder, body, s);
            if (predicate.kind !== "bool" && predicate.kind !== "dyn") fail("type", `filter predicate must be bool, got ${showType(predicate)}`, body?.pos ?? node.pos);
            return object.kind === "list" ? object : T.list(T.dyn);
          }
          case "exists":
          case "all": {
            const element = elementOf(node.object, object, node.name);
            const { body: predicate } = comprehension(node, element, binder, body, s);
            if (predicate.kind !== "bool" && predicate.kind !== "dyn") fail("type", `${node.name} predicate must be bool, got ${showType(predicate)}`, body?.pos ?? node.pos);
            return T.bool;
          }
          case "size":
            if (object.kind !== "list" && !isStringLike(object) && object.kind !== "dyn") fail("type", `size expects a list or a string, got ${showType(object)}`, node.pos);
            return T.int;
          default:
            return fail("type", `unknown method '${node.name}'`, node.pos);
        }
      }

      case "call":
        return visitCall(node, s);
    }
  };

  const visitCall = (node: Extract<Expr, { k: "call" }>, s: Scope): Type => {
    const args = node.args;
    const arity = (n: number) => {
      if (args.length !== n) fail("type", `${node.callee} takes ${n} argument${n > 1 ? "s" : ""}, got ${args.length}`, node.pos);
    };
    switch (node.callee) {
      case "size":
      case "count": {
        arity(1);
        if (!args[0]) return T.int;
        const type = visit(args[0], s);
        if (type.kind !== "list" && type.kind !== "dyn" && !(node.callee === "size" && isStringLike(type))) {
          fail("type", `${node.callee} expects a list, got ${showType(type)}`, args[0].pos);
        }
        return T.int;
      }
      case "exists": {
        arity(3);
        if (args.length !== 3) return T.bool;
        const element = elementOf(args[0], visit(args[0], s), "exists");
        const { body } = comprehension(node, element, args[1], args[2], s);
        if (body.kind !== "bool" && body.kind !== "dyn") fail("type", `exists predicate must be bool, got ${showType(body)}`, args[2].pos);
        return T.bool;
      }
      case "majority":
      case "mode": {
        arity(1);
        if (!args[0]) return T.dyn;
        return elementOf(args[0], visit(args[0], s), node.callee);
      }
      case "mean": {
        arity(1);
        if (!args[0]) return T.number;
        const element = elementOf(args[0], visit(args[0], s), "mean");
        if (!isNumeric(element)) fail("type", `mean expects a list of numbers, got list(${showType(element)})`, args[0].pos);
        return T.number;
      }
      case "min":
      case "max": {
        if (args.length === 0) return fail("type", `${node.callee} takes at least one argument`, node.pos);
        const types = args.length === 1
          ? [elementOf(args[0], visit(args[0], s), node.callee)]
          : args.map((arg) => visit(arg, s));
        let result: Type | null = null;
        for (const [i, type] of types.entries()) {
          if (!isNumeric(type)) fail("type", `${node.callee} expects numbers, got ${showType(type)}`, args[Math.min(i, args.length - 1)].pos);
          result = result === null ? type : unify(result, type);
        }
        return result ?? T.number;
      }
      case "has": {
        arity(1);
        const arg = args[0];
        if (arg && arg.k !== "member") return fail("type", "has expects a field access", arg.pos);
        if (arg && arg.k === "member") visit(arg.object, s);
        return T.bool;
      }
      case "age": {
        arity(1);
        if (!args[0]) return T.int;
        const type = visit(args[0], s);
        if (type.kind !== "resource" && type.kind !== "dyn") fail("type", `age expects a resource, got ${showType(type)}`, args[0].pos);
        return T.int;
      }
      case "int":
      case "double":
      case "string": {
        arity(1);
        if (args[0]) visit(args[0], s);
        return node.callee === "int" ? T.int : node.callee === "double" ? T.number : T.string;
      }
      default:
        for (const arg of args) visit(arg, s);
        return fail("type", `unknown function '${node.callee}'`, node.pos);
    }
  };

  const type = visit(expr, scope);
  return { type, issues };
}
