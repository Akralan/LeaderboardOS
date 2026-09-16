import { describe, it, expect } from "vitest";
import { Scope, checkExpr } from "./checker.js";
import { ExprSyntaxError, parseExpr } from "./parser.js";
import { T, showType } from "./types.js";

describe("parseExpr", () => {
  it("gives && precedence over || and binds member access tightest", () => {
    const ast = parseExpr('item.class == "standard" || a && b');
    expect(ast.k).toBe("binary");
    if (ast.k !== "binary") return;
    expect(ast.op).toBe("||");
    expect(ast.right.k === "binary" && ast.right.op).toBe("&&");
  });

  it("reads a right-associative ternary", () => {
    const ast = parseExpr("a ? 1 : b ? 2 : 3");
    expect(ast.k === "cond" && ast.else.k).toBe("cond");
  });

  it("reads unary minus over a member access", () => {
    const ast = parseExpr("-params.per_unit");
    expect(ast.k === "unary" && ast.arg.k).toBe("member");
  });

  it("reads macros, calls, indexes and list literals", () => {
    expect(parseExpr("inputs.filter(i, i.v == verdict)[0].x").k).toBe("member");
    expect(parseExpr("exists(account, a, a.handle == 'x')").k).toBe("call");
    expect(parseExpr("[1, 2.5]").k).toBe("list");
  });

  it("reports a syntax error with its position", () => {
    try {
      parseExpr("a && ");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ExprSyntaxError);
      expect((error as ExprSyntaxError).position).toBe(5);
    }
    expect(() => parseExpr("a b")).toThrow(ExprSyntaxError);
    expect(() => parseExpr('"open')).toThrow("unterminated string");
  });
});

describe("checkExpr", () => {
  const env = {
    resourceFields: (name: string) =>
      name === "item" ? { class: T.enum(["standard", "sensitive"]), author: T.user, open: T.bool } : undefined,
  };
  const scope = Scope.root({
    params: T.record({ per_unit: T.int, rate: T.number, kinds: T.list(T.record({ kind: T.string })) }),
    counters: T.record({ seen: T.int }),
    item: T.resource("item"),
    items: T.list(T.resource("item")),
    meta: T.dyn,
    participation: T.record({ user: T.user }),
  });
  const check = (source: string) => checkExpr(parseExpr(source), scope, env);

  it("types arithmetic, promoting int to number", () => {
    expect(showType(check("params.per_unit * 2").type)).toBe("int");
    expect(showType(check("params.per_unit * params.rate").type)).toBe("number");
    expect(showType(check("counters.seen == 0 ? 1.0 : params.rate").type)).toBe("number");
  });

  it("types comprehensions and the aggregate library", () => {
    expect(showType(check("params.kinds.map(k, k.kind)").type)).toBe("list(string)");
    expect(showType(check("majority(items.map(i, i.class))").type)).toBe("enum(standard, sensitive)");
    expect(check("exists(items, i, i.author == participation.user)").type).toEqual(T.bool);
    expect(check("size(items.filter(i, i.open)) > 0").issues).toEqual([]);
  });

  it("lets anything through a dyn value", () => {
    expect(check("meta.anything.deep == 3 && meta.flag").issues).toEqual([]);
  });

  it("refuses an unknown name, field or function", () => {
    expect(check("paramz.rate").issues[0]).toMatchObject({ pass: "reference", position: 0 });
    expect(check("item.clas").issues[0]).toMatchObject({ pass: "reference", message: "unknown field 'clas' on item" });
    expect(check("median(items)").issues[0]).toMatchObject({ pass: "type", message: "unknown function 'median'" });
  });

  it("refuses incompatible comparisons and a literal outside an enum", () => {
    expect(check("item.open == 3").issues[0]?.message).toBe("cannot compare bool with int");
    expect(check('item.class == "sensitiv"').issues[0]?.message).toBe('"sensitiv" is not one of enum(standard, sensitive)');
    expect(check("item.author == participation.user").issues).toEqual([]);
  });

  it("refuses arithmetic on non-numbers and non-bool logic", () => {
    expect(check("params.per_unit * item.open").issues[0]?.pass).toBe("type");
    expect(check("counters.seen && item.open").issues[0]?.message).toBe("'&&' expects bool, got int");
  });

  it("scopes a comprehension variable to its body", () => {
    expect(check("items.map(i, i.class) == i").issues[0]?.message).toBe("unknown name 'i'");
  });

  it("asks the scope to explain a missing name", () => {
    const explained = Scope.root({}, (name) => (name === "later" ? { pass: "shape", message: "produced later" } : undefined));
    const result = checkExpr(parseExpr("later.x"), explained, env);
    expect(result.issues[0]).toMatchObject({ pass: "shape", message: "produced later" });
  });
});
