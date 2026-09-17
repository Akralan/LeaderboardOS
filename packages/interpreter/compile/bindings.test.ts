import { describe, expect, it } from "vitest";
import { DEFAULT_CATALOG } from "../catalog.js";
import { BOUND_CAPABILITIES, artifactOf, bundleOf, latestMetrics, scoreOf } from "./bindings.js";

describe("the catalog bindings", () => {
  it("binds every capability the catalog calls executable", () => {
    const executable = Object.entries(DEFAULT_CATALOG).filter(([, entry]) => entry.v1).map(([name]) => name);
    expect(executable.filter((name) => !BOUND_CAPABILITIES.has(name))).toEqual([]);
  });

  it("reads artifact URLs as the hand-written flows do", () => {
    expect(artifactOf("https://github.com/alice/model.git")).toEqual({ host: "github", slug: "alice/model", url: "https://github.com/alice/model.git" });
    expect(artifactOf("https://github.com/alice/model/tree/contrib/001-alice")).toMatchObject({ slug: "alice/model", branch: "contrib/001-alice" });
    expect(artifactOf("https://www.kaggle.com/datasets/bob/lungs")).toMatchObject({ host: "kaggle", kind: "dataset", ref: "bob/lungs" });
    expect(artifactOf("https://www.kaggle.com/models/bob/lungs/pyTorch/default")).toMatchObject({ kind: "model", ref: "bob/lungs" });
    expect(artifactOf("https://example.com/x")).toBeNull();
  });

  it("picks the bundle source of each flow: branch history for code, latest state for ML artifacts", () => {
    expect(bundleOf(artifactOf("https://github.com/a/r/tree/b")!, "history")).toEqual({ source: "github-snapshot", input: { slug: "a/r", branch: "b" } });
    expect(bundleOf(artifactOf("https://github.com/a/r")!, "latest")).toEqual({ source: "kaggle-artifact", input: { ref: "a/r", repoType: "github" } });
    expect(bundleOf(artifactOf("https://kaggle.com/datasets/a/d")!, "latest")).toEqual({ source: "kaggle-artifact", input: { ref: "a/d", repoType: "kaggle_dataset" } });
  });

  it("scores on 0..1 and reads the latest version that reports each metric", () => {
    expect([scoreOf(9), scoreOf(4.5), scoreOf(12), scoreOf(-1)]).toEqual([1, 0.5, 1, 0]);
    expect(latestMetrics([{ metrics: { auc: 0.7 } }, { metrics: { f1: 0.6 } }, { metrics: { auc: 0.8 } }])).toEqual({ auc: 0.8, f1: 0.6, accuracy: 0 });
  });
});
