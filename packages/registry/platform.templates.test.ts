import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { compareVersions, PlatformRegistry, type FlowDefinition } from "./platform.js";

/**
 * Les versions de templates en base, dans le registre
 * ---------------------------------------------------
 * Une version publiée s'installe à côté des flows fichiers, indexée par
 * `(clé, version)`. `flowFor` résout un challenge par sa version, `flow` une
 * clé par la dernière publiée ; les versions d'un template partagent leurs
 * clés de ledger, et un job déclaré par plusieurs versions les exécute toutes.
 */

function version(key: string, runs: string[], declarations: Partial<FlowDefinition> = {}): FlowDefinition {
  return {
    descriptor: { key, label: key, longLabel: key, icon: "code", briefRequired: false, publiclyVisible: false },
    ruleKeys: [{ key: `${key}.pay`, consumesPool: true }],
    contributionTypes: [{ key: `${key}.work`, countsAsContribution: true }],
    jobs: [{ key: `${key}.audit`, schedule: "0 4 * * 1", run: async () => runs.push(String(declarations.descriptor ?? "")) }],
    ...declarations,
  };
}

describe("template versions in the registry", () => {
  beforeEach(() => {
    PlatformRegistry.reset();
    PlatformRegistry.install({
      flows: [{ descriptor: { key: "code", label: "Code", longLabel: "Code", icon: "code", briefRequired: false, publiclyVisible: true }, ruleKeys: [{ key: "code_score", consumesPool: true }] }],
    });
  });
  afterEach(() => PlatformRegistry.reset());

  it("compares semver numerically", () => {
    expect(["1.10.0", "1.9.0", "1.9.10", "0.1.0"].sort(compareVersions)).toEqual(["0.1.0", "1.9.0", "1.9.10", "1.10.0"]);
  });

  it("resolves a challenge by its version, a key by its latest version, and never mixes them with file flows", () => {
    const v1 = version("rating", []);
    const v2 = version("rating", []);
    PlatformRegistry.installTemplateVersion("1.9.0", v1);
    PlatformRegistry.installTemplateVersion("1.10.0", v2);

    expect(PlatformRegistry.flowFor({ type: "rating", template_version: "1.9.0" })).toBe(v1);
    expect(PlatformRegistry.flowFor({ type: "rating", template_version: "2.0.0" })).toBeUndefined();
    expect(PlatformRegistry.flowFor({ type: "rating" })).toBeUndefined();
    expect(PlatformRegistry.flow("rating")).toBe(v2);
    expect(PlatformRegistry.latestTemplateVersion("rating")).toBe("1.10.0");
    expect(PlatformRegistry.flows().map((flow) => flow.descriptor.key)).toEqual(["code", "rating"]);
    expect(PlatformRegistry.flowFor({ type: "code" })?.descriptor.key).toBe("code");
  });

  it("shares ledger keys across versions, and runs one job for all of them", async () => {
    const runs: string[] = [];
    PlatformRegistry.installTemplateVersion("1.0.0", version("rating", runs, { descriptor: { key: "rating", label: "v1", longLabel: "v1", icon: "code", briefRequired: false, publiclyVisible: false } }));
    PlatformRegistry.installTemplateVersion("1.1.0", version("rating", runs, { descriptor: { key: "rating", label: "v2", longLabel: "v2", icon: "code", briefRequired: false, publiclyVisible: false } }));
    PlatformRegistry.installTemplateVersion("1.1.0", version("rating", runs));

    expect(PlatformRegistry.ruleKeys().map((ruleKey) => [ruleKey.key, ruleKey.owner])).toEqual([
      ["code_score", "flow:code"],
      ["rating.pay", "template:rating"],
    ]);
    const audits = PlatformRegistry.jobs().filter((job) => job.key === "rating.audit");
    expect(audits).toHaveLength(1);
    await audits[0].run();
    expect(runs).toHaveLength(2);
  });

  it("refuses a key served by a file flow, a key another owner declares, or a key that changes meaning", () => {
    expect(() => PlatformRegistry.installTemplateVersion("1.0.0", version("code", []))).toThrow(/already served by an installed flow/);
    expect(() =>
      PlatformRegistry.installTemplateVersion("1.0.0", version("rating", [], { ruleKeys: [{ key: "code_score", consumesPool: true }] }))
    ).toThrow(/declared by both flow:code and template:rating/);
    PlatformRegistry.installTemplateVersion("1.0.0", version("rating", []));
    const drifted = version("rating", [], { ruleKeys: [{ key: "rating.pay", consumesPool: false }] });
    expect(PlatformRegistry.templateVersionConflict("1.1.0", drifted)).toMatch(/changes meaning between versions/);
    expect(() => PlatformRegistry.installTemplateVersion("1.1.0", drifted)).toThrow();
    expect(PlatformRegistry.templateVersions("rating")).toEqual(["1.0.0"]);
  });
});
