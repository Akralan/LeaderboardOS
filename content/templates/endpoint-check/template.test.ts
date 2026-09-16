import { describe, it, expect } from "vitest";
import { endpointCheckFlowDescriptor, endpointCheckTemplate } from "./descriptor.js";
import { endpointCheckTemplateFlow } from "./index.js";

describe("the endpoint-check template, as declared", () => {
  it("describes itself to the client from its presentation block and its params", () => {
    expect(endpointCheckFlowDescriptor).toMatchObject({
      key: "endpoint-check",
      label: "Validation",
      longLabel: "Endpoint validation",
      icon: "shield",
      briefRequired: false,
      publiclyVisible: false,
    });
    expect(endpointCheckTemplate.configSchema.safeParse({ cp_per_validation: 5, required_validations: 2, reviewer_qualification: "medical_pro" }).success).toBe(false);
    expect(endpointCheckTemplate.configSchema.safeParse({ cp_per_validation: 5, required_validations: 3, reviewer_qualification: "medical_pro" }).success).toBe(true);
  });

  it("compiles into a flow that tests endpoints, under its own ledger key", () => {
    expect(endpointCheckTemplateFlow.requires).toEqual({ deliverableCapability: "endpoint" });
    // Attrition : rien de commun avec le ledger du flow écrit à la main (`validation`).
    expect(endpointCheckTemplateFlow.ruleKeys!.map((ruleKey) => [ruleKey.key, ruleKey.consumesPool])).toEqual([["endpoint_check", true]]);
    expect(endpointCheckTemplateFlow.contributionTypes).toEqual([{ key: "endpoint_check", countsAsContribution: true }]);
  });

  it("describes the surface the generated UI renders: lanes, segments, typed fields, qualification", () => {
    const { lanes, resources } = endpointCheckTemplate.surface;
    expect(lanes.map((lane) => [lane.id, lane.trigger, lane.role ?? null, lane.claims])).toEqual([
      ["admin", "admin", null, false],
      ["author", "user", "reviewer_qualification", false],
      ["reviewer", "user", "reviewer_qualification", true],
    ]);
    const reviewer = lanes[2];
    expect(reviewer.segments.map((segment) => [segment.path, segment.opensClaim, segment.needsClaim, segment.final])).toEqual([
      ["reviewer/pick", true, false, false],
      ["reviewer/observation", false, true, false],
      ["reviewer/verdict", false, true, true],
    ]);
    expect(reviewer.segments[0].fields).toEqual([
      { name: "target", gesture: "pick", kind: "ref", resource: "target" },
      { name: "case", gesture: "pick", kind: "ref", resource: "reference_case" },
    ]);
    expect(reviewer.segments[2].fields[0]).toEqual({ name: "verdict", gesture: "verdict", kind: "enum", values: ["works", "broken"] });
    expect(lanes[0].segments[0].fields.map((field) => field.kind)).toEqual(["link", "url"]);
    expect(lanes[1].segments[0].fields.map((field) => field.kind)).toEqual(["file", "file"]);
    expect(resources.map((resource) => [resource.type, resource.aggregates])).toEqual([["target", ["quorum"]], ["reference_case", []]]);
  });
});
