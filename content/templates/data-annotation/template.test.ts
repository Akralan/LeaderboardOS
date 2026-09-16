import { describe, it, expect } from "vitest";
import { staleTemplateSources } from "../../../scripts/templates-build.js";
import { PlatformRegistry } from "../../../packages/registry/platform.js";
import { dataAnnotationFlowDescriptor, dataAnnotationTemplate } from "./descriptor.js";

/**
 * Le template installé
 * --------------------
 * La distribution MyTwin sert data-annotation depuis ce template : le module
 * importé est à jour de son YAML, le flow installé est le flow compilé, et
 * ce qu'en lit le client vient de la même source.
 */
describe("the data-annotation template, as installed", () => {
  it("imports a source module that matches template.yaml (npm run templates:build)", () => {
    expect(staleTemplateSources()).toEqual([]);
  });

  it("is the flow the MyTwin distribution installs", () => {
    const installed = PlatformRegistry.flow("data-annotation")!;
    expect(installed.descriptor).toEqual(dataAnnotationFlowDescriptor);
    expect(installed.actions!.map((action) => `${action.method} ${action.path}`)).toContain("POST annotator/label");
  });

  it("describes itself to the client from its presentation block and its params", () => {
    expect(dataAnnotationFlowDescriptor).toEqual({
      key: "data-annotation",
      label: "Annotation",
      longLabel: "Data annotation",
      icon: "tag",
      briefRequired: true,
      publiclyVisible: true,
      joinCaption: "Joining lets you label items one at a time; your pay follows your quality score.",
    });
    const options = [{ key: "a", label: "A" }, { key: "a", label: "B" }];
    const refused = dataAnnotationTemplate.configSchema.safeParse({ label_schema: { kind: "single_choice", options } });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.message)).toContain("label_schema: option keys must be unique");
    expect(dataAnnotationTemplate.rulesSchema.parse({ per_unit_cp: 5 })).toEqual({ per_unit_cp: 5, gold_rate: 0.1, audit_rate: 0.1 });
  });
});
