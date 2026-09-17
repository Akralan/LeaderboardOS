import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { diagnose } from "../capabilities/templates.js";
import { templateSource as annotation } from "../../content/templates/data-annotation/template.source.js";
import { MAX_REPAIRS, authorTemplate, parseAnswer, refineTemplate, type Llm, type LlmMessage } from "./author.js";
import { systemPrompt } from "./context.js";
import { applyEdits } from "./edits.js";
import { slugKey } from "./service.js";
import { corpus } from "./corpus.source.js";
import { stringifyPreserving } from "./yaml-text.js";
import { parseDocument } from "yaml";

/** Un modèle scripté : une réponse par tour, et les messages qu'il a reçus. */
function scripted(answers: unknown[]): Llm & { calls: LlmMessage[][] } {
  const calls: LlmMessage[][] = [];
  const llm = (async ({ messages }: { messages: LlmMessage[] }) => {
    calls.push(messages.map((message) => ({ ...message })));
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    return typeof answer === "string" ? answer : JSON.stringify(answer);
  }) as unknown as Llm & { calls: LlmMessage[][] };
  llm.calls = calls;
  return llm;
}

const system = systemPrompt({ qualifications: ["medical_pro"], grids: [] });

describe("the template author loop", () => {
  it("returns a valid draft at once when the first answer validates", async () => {
    const llm = scripted([{ name: "Annotation", yaml: annotation, choices: ["k = 3"], open_questions: [] }]);
    const run = await authorTemplate({ description: "annotators label items", key: "data-annotation", keyOf: slugKey, system, llm, diagnose });
    expect(run.rounds).toBe(1);
    expect(run.validAfterFirstRound).toBe(true);
    expect(run.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(run.choices).toEqual(["k = 3"]);
  });

  it("feeds the located diagnostics back and repairs with edits", async () => {
    const broken = annotation.replace("rule_key: annotation\n", "rule_key: annotation\n          bogus: true\n");
    const llm = scripted([
      { name: "Annotation", yaml: broken.replace("params.per_unit_cp\n", "params.rate\n") },
      { edits: [{ op: "set", path: ["lanes", 2, "nodes", 4, "reward", "amount"], value: "params.per_unit_cp" }] },
    ]);
    const run = await authorTemplate({ description: "annotators", key: "data-annotation", keyOf: slugKey, system, llm, diagnose });
    const repair = llm.calls[1].at(-1)!.content;
    expect(repair).toMatch(/validator reports/);
    expect(repair).toMatch(/lanes\.2\.nodes\.4/);
    expect(run.validAfterFirstRound).toBe(false);
    expect(run.rounds).toBeGreaterThanOrEqual(2);
    expect(parse(run.yaml).lanes[2].nodes[4].reward.amount).toBe("params.per_unit_cp");
  });

  it("stops after the bounded repairs and still returns the draft with its diagnostics", async () => {
    const llm = scripted([{ name: "Broken", yaml: "format: leaderboardos/1\ntemplate: {id: x, version: 1.0.0, name: X, summary: X}\nrequires: {core: 1}\nlanes: []\n" }, "not json at all"]);
    const run = await authorTemplate({ description: "something", key: null, keyOf: slugKey, system, llm, diagnose });
    expect(run.rounds).toBe(MAX_REPAIRS + 1);
    expect(run.key).toBe("broken");
    expect(parse(run.yaml).template.id).toBe("broken");
    expect(run.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("refines with edits: what the instruction does not touch stays byte-identical", async () => {
    const llm = scripted([{ edits: [{ op: "set", path: ["params", "gold_rate", "default"], value: 0.2 }], choices: ["golds at 20%"] }]);
    const run = await refineTemplate({ yaml: annotation, instruction: "make golds 20%", key: "data-annotation", system, llm, diagnose });
    expect(parse(run.yaml).params.gold_rate.default).toBe(0.2);
    const lanesBefore = annotation.slice(annotation.indexOf("\nlanes:"));
    expect(run.yaml.slice(run.yaml.indexOf("\nlanes:"))).toBe(lanesBefore);
    expect(run.yaml).toContain("# The data-annotation flow as a template");
    expect(run.openQuestions).toEqual([]);
  });
});

describe("the author's pieces", () => {
  it("reads a fenced JSON answer and rejects anything else", () => {
    expect(parseAnswer('```json\n{"yaml": "a: 1"}\n```')).toEqual({ yaml: "a: 1" });
    expect(parseAnswer("sorry")).toBeNull();
  });

  it("reports edits it cannot apply instead of failing", () => {
    const result = applyEdits("a: 1\n", [{ op: "delete", path: ["b"] }, { op: "insert", path: ["a"], value: 2 }]);
    expect(result.failures).toHaveLength(2);
    expect(result.yaml).toBe("a: 1\n");
  });

  it("grounds the model in the executable catalog, the registries and the corpus", () => {
    expect(system).toContain("http_proxy (observer)");
    expect(system).not.toContain("spawn_challenge (effector)");
    expect(system).toContain("medical_pro");
    expect(system).toContain("## data-annotation (installed in production");
    expect(system).toMatch(/## social-amplification \(canonical example — NOT executable in v1/);
  });

  it("rewrites only the changed lines of every corpus template", () => {
    for (const entry of corpus) {
      const doc = parseDocument(entry.yaml);
      doc.setIn(["template", "version"], "9.9.9");
      const out = stringifyPreserving(entry.yaml, doc);
      const before = entry.yaml.split("\n");
      const after = out.split("\n");
      expect(after.length, entry.name).toBe(before.length);
      expect(after.filter((line, index) => line !== before[index]), entry.name).toEqual(["  version: 9.9.9"]);
    }
  });

  it("slugs keys", () => {
    expect(slugKey("Chest X-ray triage — batch 4")).toBe("chest-x-ray-triage-batch-4");
    expect(slugKey(null)).toBe("template");
  });
});
