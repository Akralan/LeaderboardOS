import { describe, it, expect } from "vitest";
import { EvalError, evaluate, type Bindings } from "./evaluator.js";
import { parseExpr } from "./parser.js";

const run = (source: string, bindings: Bindings = {}, now?: Date) => evaluate(parseExpr(source), bindings, { now });

describe("evaluate", () => {
  it("computes the annotation pay formula with real division", () => {
    const bindings = { params: { per_unit: 5 }, counters: { gold_seen: 4, gold_correct: 3 } };
    const formula = "params.per_unit * (counters.gold_seen == 0 ? 1.0 : counters.gold_correct * 1.0 / counters.gold_seen)";
    expect(run(formula, bindings)).toBe(3.75);
    expect(run(formula, { ...bindings, counters: { gold_seen: 0, gold_correct: 0 } })).toBe(5);
    expect(run("3 / 2")).toBe(1.5);
  });

  it("short-circuits && and || so the right side may be unsafe", () => {
    expect(run("false && x.y", {})).toBe(false);
    expect(run("true || x.y", {})).toBe(true);
  });

  it("runs comprehensions and filters over lists", () => {
    const inputs = [{ verdict: "works" }, { verdict: "broken" }, { verdict: "works" }];
    expect(run('inputs.filter(i, i.verdict == "works").size()', { inputs })).toBe(2);
    expect(run("inputs.map(i, i.verdict)", { inputs })).toEqual(["works", "broken", "works"]);
    expect(run('exists(inputs, i, i.verdict == "broken")', { inputs })).toBe(true);
    expect(run("inputs.all(i, has(i.verdict))", { inputs })).toBe(true);
  });

  it("gives majority only with a strict majority, mode only without a tie", () => {
    expect(run("majority(v)", { v: ["a", "b", "a"] })).toBe("a");
    expect(run("majority(v)", { v: ["a", "b", "c"] })).toBeNull();
    expect(run("mode(v)", { v: ["a", "b", "b", "c"] })).toBe("b");
    expect(run("mode(v)", { v: ["a", "b"] })).toBeNull();
    expect(run("mean(v)", { v: [1, 2, 6] })).toBe(3);
    expect(run("min(3, x)", { x: 1 })).toBe(1);
  });

  it("compares resources by id and JSON values structurally", () => {
    expect(run("a == b", { a: { id: "r1", payload: 1 }, b: { id: "r1", payload: 2 } })).toBe(true);
    expect(run("a == b", { a: { label: [1, 2] }, b: { label: [1, 2] } })).toBe(true);
    expect(run("a != null", { a: "x" })).toBe(true);
  });

  it("reads the age of a resource from created_at and the engine clock", () => {
    const post = { id: "p", created_at: "2026-09-10T12:00:00Z" };
    expect(run("age(post)", { post }, new Date("2026-09-16T13:00:00Z"))).toBe(6);
  });

  it("fails with a position on a runtime error", () => {
    expect(() => run("x.y", { x: null })).toThrow(EvalError);
    expect(() => run("steps[3]", { steps: [1] })).toThrow("out of bounds");
    try {
      run("a / 0", { a: 1 });
      expect.unreachable();
    } catch (error) {
      expect((error as EvalError).position).toBe(2);
    }
  });
});
