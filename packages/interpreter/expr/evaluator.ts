import type { Expr } from "./ast.js";

/**
 * L'évaluateur
 * ------------
 * Exécute une expression déjà vérifiée par `checkExpr` sur des valeurs JSON.
 * Aucune entrée-sortie, aucune horloge hors de `now` que le moteur fournit,
 * aucune récursion possible : la terminaison tient à la grammaire.
 *
 * Deux choix de sémantique, faute de types à l'exécution : `/` est toujours
 * une division réelle, et une instance de ressource se compare par son `id`.
 * `majority` rend `null` sans majorité stricte, `mode` rend `null` en cas
 * d'égalité : c'est au template de traiter l'absence de verdict.
 */

export type Value = null | boolean | number | string | Value[] | { [key: string]: Value };

export class EvalError extends Error {
  constructor(message: string, readonly position: number) {
    super(message);
  }
}

export interface EvalContext {
  /** Pour `age(resource)`. */
  now?: Date;
}

export type Bindings = Readonly<Record<string, Value>>;

const isObject = (value: Value): value is { [key: string]: Value } =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function equals(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => equals(item, b[i]));
  if (isObject(a) && isObject(b)) {
    if (typeof a.id === "string" && typeof b.id === "string") return a.id === b.id;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && equals(a[key], b[key]));
  }
  return false;
}

function frequencies(values: Value[]): { value: Value; count: number }[] {
  const table: { value: Value; count: number }[] = [];
  for (const value of values) {
    const entry = table.find((candidate) => equals(candidate.value, value));
    if (entry) entry.count++;
    else table.push({ value, count: 1 });
  }
  return table.sort((a, b) => b.count - a.count);
}

export function evaluate(expr: Expr, bindings: Bindings, context: EvalContext = {}): Value {
  const run = (node: Expr, scope: Bindings): Value => {
    switch (node.k) {
      case "lit":
        return node.value;

      case "ident":
        if (!(node.name in scope)) throw new EvalError(`'${node.name}' is not bound`, node.pos);
        return scope[node.name];

      case "member": {
        const object = run(node.object, scope);
        if (!isObject(object)) throw new EvalError(`cannot read '${node.name}' of ${describe(object)}`, node.pos);
        return object[node.name] ?? null;
      }

      case "index": {
        const object = run(node.object, scope);
        const index = run(node.index, scope);
        if (Array.isArray(object) && typeof index === "number") {
          if (!Number.isInteger(index) || index < 0 || index >= object.length) {
            throw new EvalError(`index ${index} out of bounds (size ${object.length})`, node.pos);
          }
          return object[index];
        }
        if (isObject(object) && typeof index === "string") return object[index] ?? null;
        throw new EvalError(`cannot index ${describe(object)} with ${describe(index)}`, node.pos);
      }

      case "unary": {
        const arg = run(node.arg, scope);
        if (node.op === "!") return !bool(arg, node.arg.pos);
        return -num(arg, node.arg.pos);
      }

      case "binary": {
        if (node.op === "&&") return bool(run(node.left, scope), node.left.pos) && bool(run(node.right, scope), node.right.pos);
        if (node.op === "||") return bool(run(node.left, scope), node.left.pos) || bool(run(node.right, scope), node.right.pos);
        const left = run(node.left, scope);
        const right = run(node.right, scope);
        switch (node.op) {
          case "==":
            return equals(left, right);
          case "!=":
            return !equals(left, right);
          case "<":
          case "<=":
          case ">":
          case ">=": {
            const [a, b] = ordered(left, right, node.pos);
            return node.op === "<" ? a < b : node.op === "<=" ? a <= b : node.op === ">" ? a > b : a >= b;
          }
          case "+":
            if (typeof left === "string" && typeof right === "string") return left + right;
            if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
            return num(left, node.left.pos) + num(right, node.right.pos);
          case "-":
            return num(left, node.left.pos) - num(right, node.right.pos);
          case "*":
            return num(left, node.left.pos) * num(right, node.right.pos);
          case "/": {
            const divisor = num(right, node.right.pos);
            if (divisor === 0) throw new EvalError("division by zero", node.pos);
            return num(left, node.left.pos) / divisor;
          }
          case "%": {
            const divisor = num(right, node.right.pos);
            if (divisor === 0) throw new EvalError("modulo by zero", node.pos);
            return num(left, node.left.pos) % divisor;
          }
        }
        return null;
      }

      case "cond":
        return bool(run(node.test, scope), node.test.pos) ? run(node.then, scope) : run(node.else, scope);

      case "list":
        return node.items.map((item) => run(item, scope));

      case "method": {
        const object = run(node.object, scope);
        if (node.name === "size") return sizeOf(object, node.pos);
        const list = listOf(object, node.object.pos);
        const [binder, body] = node.args;
        const each = (item: Value) => run(body, { ...scope, [(binder as { name: string }).name]: item });
        switch (node.name) {
          case "map":
            return list.map(each);
          case "filter":
            return list.filter((item) => bool(each(item), body.pos));
          case "exists":
            return list.some((item) => bool(each(item), body.pos));
          case "all":
            return list.every((item) => bool(each(item), body.pos));
        }
        throw new EvalError(`unknown method '${node.name}'`, node.pos);
      }

      case "call":
        return call(node, scope);
    }
  };

  const call = (node: Extract<Expr, { k: "call" }>, scope: Bindings): Value => {
    const [first, second, third] = node.args;
    switch (node.callee) {
      case "size":
      case "count":
        return sizeOf(run(first, scope), node.pos);
      case "exists": {
        const list = listOf(run(first, scope), first.pos);
        const name = (second as { name: string }).name;
        return list.some((item) => bool(run(third, { ...scope, [name]: item }), third.pos));
      }
      case "majority": {
        const values = listOf(run(first, scope), first.pos);
        const [top] = frequencies(values);
        return top && top.count * 2 > values.length ? top.value : null;
      }
      case "mode": {
        const [top, next] = frequencies(listOf(run(first, scope), first.pos));
        if (!top || (next && next.count === top.count)) return null;
        return top.value;
      }
      case "mean": {
        const values = listOf(run(first, scope), first.pos).map((value) => num(value, first.pos));
        return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
      }
      case "min":
      case "max": {
        const values = (node.args.length === 1 ? listOf(run(first, scope), first.pos) : node.args.map((arg) => run(arg, scope)))
          .map((value) => num(value, node.pos));
        if (values.length === 0) return null;
        return node.callee === "min" ? Math.min(...values) : Math.max(...values);
      }
      case "has": {
        if (first.k !== "member") throw new EvalError("has expects a field access", node.pos);
        const object = run(first.object, scope);
        return isObject(object) && object[first.name] !== undefined && object[first.name] !== null;
      }
      case "age": {
        const resource = run(first, scope);
        const created = isObject(resource) ? resource.created_at : null;
        if (typeof created !== "string") throw new EvalError("age expects a resource with created_at", node.pos);
        const now = (context.now ?? new Date()).getTime();
        return Math.floor((now - new Date(created).getTime()) / 86_400_000);
      }
      case "int":
        return Math.trunc(num(run(first, scope), first.pos));
      case "double":
        return num(run(first, scope), first.pos);
      case "string": {
        const value = run(first, scope);
        return typeof value === "string" ? value : JSON.stringify(value);
      }
    }
    throw new EvalError(`unknown function '${node.callee}'`, node.pos);
  };

  return run(expr, bindings);
}

function describe(value: Value): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return typeof value === "object" ? "an object" : `${typeof value} ${JSON.stringify(value)}`;
}

function bool(value: Value, position: number): boolean {
  if (typeof value !== "boolean") throw new EvalError(`expected bool, got ${describe(value)}`, position);
  return value;
}

function num(value: Value, position: number): number {
  if (typeof value !== "number") throw new EvalError(`expected a number, got ${describe(value)}`, position);
  return value;
}

function listOf(value: Value, position: number): Value[] {
  if (!Array.isArray(value)) throw new EvalError(`expected a list, got ${describe(value)}`, position);
  return value;
}

function sizeOf(value: Value, position: number): number {
  if (Array.isArray(value) || typeof value === "string") return value.length;
  throw new EvalError(`size expects a list or a string, got ${describe(value)}`, position);
}

function ordered(left: Value, right: Value, position: number): [number, number] | [string, string] {
  if (typeof left === "number" && typeof right === "number") return [left, right];
  if (typeof left === "string" && typeof right === "string") return [left, right];
  throw new EvalError(`cannot order ${describe(left)} and ${describe(right)}`, position);
}
