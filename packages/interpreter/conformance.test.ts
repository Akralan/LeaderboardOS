import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { checkTemplate, checkTemplateSource, type TemplateReport } from "./index.js";

/**
 * Le corpus de conformance, et le corpus muté
 * -------------------------------------------
 * La définition de « terminé » de J1 : les onze templates canoniques sont
 * valides, et chaque mutation — un fil cassé, un mauvais type, une branche
 * qui ne converge pas… — échoue dans la bonne passe.
 */

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "conformance");
const FILES = readdirSync(DIR).filter((file) => file.endsWith(".yaml")).sort();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = any;

const load = (id: string): Doc => parse(readFileSync(path.join(DIR, `${id}.yaml`), "utf8"));
const lane = (doc: Doc, id: string) => doc.lanes.find((candidate: Doc) => candidate.id === id);
const node = (nodes: Doc[], id: string) => nodes.find((candidate: Doc) => Object.values(candidate)[0] && (Object.values(candidate)[0] as Doc).id === id);

function mutated(id: string, mutate: (doc: Doc) => void): TemplateReport {
  const doc = load(id);
  mutate(doc);
  return checkTemplate(doc, id);
}

describe("the conformance corpus", () => {
  it("holds the eleven templates", () => {
    expect(FILES).toHaveLength(11);
  });

  it.each(FILES)("%s is valid", (file) => {
    const report = checkTemplateSource(readFileSync(path.join(DIR, file), "utf8"), file);
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
    expect(report.name).toBe(file.replace(/\.yaml$/, ""));
  });

  it("finds data-annotation — the J3 target — compilable in v1", () => {
    const report = checkTemplateSource(readFileSync(path.join(DIR, "data-annotation.yaml"), "utf8"), "data-annotation");
    expect(report.gaps).toEqual([]);
    expect(report.advisories.map((advisory) => advisory.node)).toEqual(["draw"]);
  });

  it("reports what v1 does not compile without invalidating", () => {
    const report = checkTemplateSource(readFileSync(path.join(DIR, "bug-bounty.yaml"), "utf8"), "bug-bounty");
    expect(report.valid).toBe(true);
    expect(report.gaps.map((gap) => gap.feature)).toContain("webhook trigger");
  });
});

describe("the mutated corpus", () => {
  const cases: [string, IssuePassName, string, (doc: Doc) => void][] = [
    // format
    ["a param without mutable", "format", "graded-submission", (doc) => delete doc.params.rate.mutable],
    ["an unknown node family", "format", "localization", (doc) => lane(doc, "import").nodes.push({ wait: { id: "pause" } })],
    ["an expression that does not parse", "format", "design-contest", (doc) => {
      node(lane(doc, "jury").nodes, "not_own").gate.all = ["pick.entry.author != "];
    }],
    // references — a broken wire
    ["an emit to an unknown aggregate", "reference", "endpoint-validation", (doc) => {
      node(lane(doc, "reviewer").nodes, "verdict").assess.emit.to = "lifecycle.quorom";
    }],
    ["created_by naming a collect instead of the act", "reference", "endpoint-validation", (doc) => {
      doc.resources.target.created_by = ["admin.expose"];
    }],
    ["a misspelled output field", "reference", "graded-submission", (doc) => {
      node(lane(doc, "contributor").nodes, "floor").gate.all = ["grade.scor >= params.min_score"];
    }],
    ["an unknown capability", "reference", "developer-onboarding", (doc) => {
      node(lane(doc, "dev").nodes, "v_live").act.capability = "http_proxi";
    }],
    ["a core version the engine does not provide", "reference", "localization", (doc) => (doc.requires.core = 2)],
    // types
    ["a verdict literal outside the enum", "type", "localization", (doc) => {
      node(lane(doc, "review").nodes, "route").gate.branch[0].when = 'judge.decision == "aproved"';
    }],
    ["arithmetic on a bool", "type", "data-annotation", (doc) => {
      node(lane(doc, "annotator").nodes, "pay").reward.amount = "params.per_unit * draw.substituted";
    }],
    ["a gate condition that is not bool", "type", "graded-submission", (doc) => {
      node(lane(doc, "contributor").nodes, "floor").gate.all = ["grade.score"];
    }],
    ["a capability argument of the wrong type", "type", "developer-onboarding", (doc) => {
      node(lane(doc, "dev").nodes, "v_live").act.to = "identity.github_handle == 'x'";
    }],
    // shape — a diverging branch, an out-of-order read
    ["a branching gate without else", "shape", "localization", (doc) => {
      node(lane(doc, "review").nodes, "route").gate.branch.pop();
    }],
    ["a read of a value produced inside a branch", "shape", "data-annotation", (doc) => {
      node(lane(doc, "annotator").nodes, "pay").reward.amount = "check.value ? params.per_unit : 0";
    }],
    ["a read of a value produced later in the lane", "shape", "developer-onboarding", (doc) => {
      node(lane(doc, "dev").nodes, "g1").gate.all = ["v_pr.ok"];
    }],
    ["a transition on a resource closed by an aggregate only", "shape", "endpoint-validation", (doc) => {
      lane(doc, "admin").nodes.push({ act: { id: "force", transition: { resource: "create_target", to: "closed" } } });
    }],
    // economy
    ["a pool that is not a points param", "economy", "data-annotation", (doc) => {
      node(lane(doc, "annotator").nodes, "pay").reward.pool = "params.gold_rate";
    }],
    ["a clawback without rule_key", "economy", "data-annotation", (doc) => {
      delete node(lane(doc, "audit").nodes, "clawback").reward.rule_key;
    }],
    ["a reward that mints without a pool", "economy", "localization", (doc) => {
      delete node(lane(doc, "review").nodes, "route").gate.branch[0].nodes[2].reward.pool;
    }],
    // claims
    ["a TTL on an unbounded claim", "claim", "social-amplification", (doc) => (doc.resources.account.claim.ttl = "24h")],
    ["a claim missing its unique_per scope", "claim", "endpoint-validation", (doc) => {
      delete node(lane(doc, "reviewer").nodes, "probe").act.claim.scope;
    }],
    ["a claim on a resource without claim mode", "claim", "sandbox-project", (doc) => {
      lane(doc, "award").nodes.unshift({ act: { id: "take", claim: { resource: "milestone" } } });
    }],
  ];

  it.each(cases)("%s fails in the %s pass", (_label, pass, id, mutate) => {
    const report = mutated(id, mutate);
    expect(report.valid).toBe(false);
    expect(report.errors[0]?.pass).toBe(pass);
  });

  it("names the node and the position of an expression error", () => {
    const report = mutated("graded-submission", (doc) => {
      node(lane(doc, "contributor").nodes, "floor").gate.all = ["grade.scor >= params.min_score"];
    });
    expect(report.errors[0]).toMatchObject({ node: "floor", position: 6, path: ["lanes", 0, "nodes", 4, "gate", "all", 0] });
  });

  it("gives the source line of an error read from text", () => {
    const source = readFileSync(path.join(DIR, "localization.yaml"), "utf8").replace('judge.decision == "approved"', 'judge.decision == "aproved"');
    const report = checkTemplateSource(source, "localization");
    const line = source.split("\n").findIndex((text) => text.includes('"aproved"')) + 1;
    expect(report.errors[0]).toMatchObject({ pass: "type", line });
  });

  it("reports invalid YAML as a format error", () => {
    const report = checkTemplateSource("format: leaderboardos/1\nparams: {a: {type: enum(x, y), mutable: [}\n", "broken");
    expect(report.valid).toBe(false);
    expect(report.errors[0]?.pass).toBe("format");
  });
});

type IssuePassName = "format" | "reference" | "type" | "shape" | "economy" | "claim";
