import type { BinaryOp, Expr } from "./ast.js";

/**
 * Le parseur d'expressions
 * ------------------------
 * La syntaxe de surface de CEL, sur un sous-ensemble fermé : littéraux, accès
 * aux champs, index, appels de fonctions et de méthodes, `! -`, arithmétique,
 * comparaisons, `&& ||`, ternaire, listes littérales. Un parseur de Pratt :
 * chaque opérateur binaire a sa précédence, le reste se lit en préfixe ou en
 * suffixe. Rien d'autre n'existe : pas d'affectation, pas de fonction définie
 * par l'utilisateur, pas de récursion possible.
 */

export class ExprSyntaxError extends Error {
  constructor(message: string, readonly position: number) {
    super(message);
  }
}

type Token =
  | { t: "num"; value: number; int: boolean; pos: number }
  | { t: "str"; value: string; pos: number }
  | { t: "ident"; value: string; pos: number }
  | { t: "op"; value: string; pos: number }
  | { t: "eof"; pos: number };

const OPERATORS = ["&&", "||", "==", "!=", "<=", ">=", "<", ">", "+", "-", "*", "/", "%", "!", "?", ":", ".", ",", "(", ")", "[", "]"];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const match = /^[0-9]+(\.[0-9]+)?/.exec(source.slice(i))!;
      tokens.push({ t: "num", value: Number(match[0]), int: match[1] === undefined, pos: i });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))!;
      tokens.push({ t: "ident", value: match[0], pos: i });
      i += match[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let value = "";
      while (j < source.length && source[j] !== ch) {
        if (source[j] === "\\" && j + 1 < source.length) {
          value += source[j + 1];
          j += 2;
          continue;
        }
        value += source[j];
        j++;
      }
      if (j >= source.length) throw new ExprSyntaxError("unterminated string", i);
      tokens.push({ t: "str", value, pos: i });
      i = j + 1;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (!op) throw new ExprSyntaxError(`unexpected character '${ch}'`, i);
    tokens.push({ t: "op", value: op, pos: i });
    i += op.length;
  }
  tokens.push({ t: "eof", pos: source.length });
  return tokens;
}

const BINARY_PRECEDENCE: Record<BinaryOp, number> = {
  "||": 2,
  "&&": 3,
  "==": 4,
  "!=": 4,
  "<": 5,
  "<=": 5,
  ">": 5,
  ">=": 5,
  "+": 6,
  "-": 6,
  "*": 7,
  "/": 7,
  "%": 7,
};

/** La précédence du ternaire : la plus basse. */
const TERNARY = 1;

export function parseExpr(source: string): Expr {
  const tokens = tokenize(source);
  let index = 0;

  const peek = () => tokens[index];
  const next = () => tokens[index++];
  const isOp = (value: string) => {
    const token = peek();
    return token.t === "op" && token.value === value;
  };
  const expectOp = (value: string) => {
    const token = next();
    if (token.t !== "op" || token.value !== value) {
      throw new ExprSyntaxError(`expected '${value}'`, token.pos);
    }
  };

  const parseArgs = (close: string): Expr[] => {
    const args: Expr[] = [];
    if (isOp(close)) {
      next();
      return args;
    }
    for (;;) {
      args.push(parse(0));
      if (isOp(",")) {
        next();
        continue;
      }
      expectOp(close);
      return args;
    }
  };

  const parsePrefix = (): Expr => {
    const token = next();
    switch (token.t) {
      case "num":
        return { k: "lit", type: token.int ? "int" : "number", value: token.value, pos: token.pos };
      case "str":
        return { k: "lit", type: "string", value: token.value, pos: token.pos };
      case "ident":
        if (token.value === "true" || token.value === "false") {
          return { k: "lit", type: "bool", value: token.value === "true", pos: token.pos };
        }
        if (token.value === "null") return { k: "lit", type: "null", value: null, pos: token.pos };
        if (isOp("(")) {
          next();
          return { k: "call", callee: token.value, args: parseArgs(")"), pos: token.pos };
        }
        return { k: "ident", name: token.value, pos: token.pos };
      case "op":
        if (token.value === "!" || token.value === "-") {
          return { k: "unary", op: token.value, arg: parse(8), pos: token.pos };
        }
        if (token.value === "(") {
          const inner = parse(0);
          expectOp(")");
          return inner;
        }
        if (token.value === "[") {
          return { k: "list", items: parseArgs("]"), pos: token.pos };
        }
        throw new ExprSyntaxError(`unexpected '${token.value}'`, token.pos);
      case "eof":
        throw new ExprSyntaxError("unexpected end of expression", token.pos);
    }
  };

  const parse = (minPrecedence: number): Expr => {
    let left = parsePrefix();
    for (;;) {
      const token = peek();
      if (token.t !== "op") break;

      // Suffixes : accès, appel de méthode, index.
      if (token.value === ".") {
        next();
        const name = next();
        if (name.t !== "ident") throw new ExprSyntaxError("expected a field name after '.'", name.pos);
        if (isOp("(")) {
          next();
          left = { k: "method", object: left, name: name.value, args: parseArgs(")"), pos: name.pos };
        } else {
          left = { k: "member", object: left, name: name.value, pos: name.pos };
        }
        continue;
      }
      if (token.value === "[") {
        next();
        const indexExpr = parse(0);
        expectOp("]");
        left = { k: "index", object: left, index: indexExpr, pos: token.pos };
        continue;
      }

      if (token.value === "?") {
        if (TERNARY < minPrecedence) break;
        next();
        const thenExpr = parse(0);
        expectOp(":");
        const elseExpr = parse(TERNARY);
        left = { k: "cond", test: left, then: thenExpr, else: elseExpr, pos: token.pos };
        continue;
      }

      const precedence = BINARY_PRECEDENCE[token.value as BinaryOp];
      if (precedence === undefined || precedence <= minPrecedence) break;
      next();
      const right = parse(precedence);
      left = { k: "binary", op: token.value as BinaryOp, left, right, pos: token.pos };
    }
    return left;
  };

  const expr = parse(0);
  const rest = peek();
  if (rest.t !== "eof") throw new ExprSyntaxError("unexpected token after the expression", rest.pos);
  return expr;
}
