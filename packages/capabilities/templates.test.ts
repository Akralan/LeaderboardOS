import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PlatformRegistry } from "../registry/platform.js";
import type { TemplateVersionRecord } from "../database-service/repositories/template.repo.js";
import { diagnose, templates, TemplatePublishError } from "./templates.js";

/**
 * T2 — l'éditeur et la porte ne divergent jamais
 * ----------------------------------------------
 * Ce que l'écriture d'un brouillon renvoie est exactement ce qui refuse sa
 * publication : une seule liste, calculée par le même collecteur.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = readFileSync(path.join(ROOT, "content/templates/endpoint-check/template.yaml"), "utf8")
  .replace(/\r\n/g, "\n")
  .replace("id: endpoint-check", "id: draft-check");

/** Un magasin en mémoire : la base tient les invariants, ce test ne regarde que les diagnostics. */
function memoryStore() {
  const drafts = new Map<string, TemplateVersionRecord>();
  const store = {
    createTemplate: async ({ key, name }: { key: string; name: string }) => ({ key, name, created_by: null, created_at: new Date(), archived_at: null }),
    findTemplate: async () => null,
    saveDraft: async (key: string, yaml: string) => {
      const draft = { uuid: key, template_key: key, status: "draft", version: null, yaml, checksum: "x", created_by: null, created_at: new Date(), updated_at: new Date(), published_at: null, published_by: null } as TemplateVersionRecord;
      drafts.set(key, draft);
      return draft;
    },
    findDraft: async (key: string) => drafts.get(key) ?? null,
    publishDraft: async () => {
      throw new Error("a refused draft never reaches the database");
    },
    findPublished: async () => null,
    listPublished: async () => [],
    listPublishedRefs: async () => [],
    systemChecksums: async () => ({}),
    recordSystemChecksum: async () => undefined,
    liveChallengesOf: async () => [],
  };
  return store;
}

describe("draft diagnostics and the publication gate", () => {
  beforeEach(() => {
    PlatformRegistry.reset();
    PlatformRegistry.install({ flows: [] });
  });
  afterAll(() => PlatformRegistry.reset());

  it("refuses a holey draft with exactly the list its save returned", async () => {
    const service = templates(memoryStore() as never);
    const yaml = SOURCE.replace('"pick.case.author != participation.user"', '"pick.case.writer != participation.user"').replace(
      "fields: {text: {type: string, check: \"size(value.trim()) > 0\"}}",
      "fields: 42"
    );
    const { diagnostics } = await service.create({ key: "draft-check", name: "Draft", yaml, by: null });
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    expect(errors.map((diagnostic) => diagnostic.code)).toEqual(["format", "reference"]);

    const refusal = await service.publish("draft-check", null).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(TemplatePublishError);
    expect((refusal as TemplatePublishError).diagnostics).toEqual(errors);
  });

  it("reports a document key that is not the template's in both places", async () => {
    const diagnostics = await diagnose(SOURCE, "another-key");
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([
      { severity: "error", code: "publish", path: "template.id", message: "template.id must be another-key" },
    ]);
  });
});
