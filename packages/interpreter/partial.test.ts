import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkTemplateSource } from "./index.js";

/**
 * T2 — le modèle partiel
 * ----------------------
 * Un brouillon troué (templates-in-db, §3) : un paramètre à clé inconnue, un
 * nœud illisible, une lane sans entrée valide. Avant T2, le format arrêtait
 * tout et seuls ses diagnostics sortaient. Désormais les morceaux cassés
 * deviennent des marqueurs, et les passes suivantes analysent ce qui tient :
 * on reçoit aussi les erreurs de références, de types et de forme des lanes
 * intactes — sans cascade sur ce qui lit un morceau cassé.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = readFileSync(path.join(ROOT, "content/templates/endpoint-check/template.yaml"), "utf8").replace(/\r\n/g, "\n");

function holey(): string {
  return (
    SOURCE
      // format : un paramètre avec une clé inconnue — lu partout (cardinality, quorum), il ne doit rien casser d'autre.
      .replace("required_validations:   {type: int, check:", "required_validations:   {type: int, oops: true, check:")
      // format : le nœud `observation` a des champs illisibles.
      .replace("fields: {text: {type: string, check: \"size(value.trim()) > 0\"}}", "fields: 42")
      // format : la lane `author` n'a pas d'entrée lisible.
      .replace("  - id: author\n    entry:\n      trigger: user", "  - id: author\n    entry:\n      trigger: whenever")
      // référence, dans la lane intacte `reviewer` : un champ qui n'existe pas.
      .replace('"pick.case.author != participation.user"', '"pick.case.writer != participation.user"')
      // type, dans la lane intacte `admin` : un endpoint qui n'est pas une URL comparée à un nombre.
      .replace("      - act: {id: create_target, create: target, from: expose}", "      - gate: {id: sanity, all: [\"expose.endpoint_url > 3\"]}\n      - act: {id: create_target, create: target, from: expose}")
  );
}

describe("a holey draft", () => {
  const report = checkTemplateSource(holey(), "endpoint-check");
  const summary = report.errors.map((issue) => [issue.pass, issue.path.join("."), issue.message]);

  it("reports the broken pieces in the format pass", () => {
    expect(summary.filter(([pass]) => pass === "format").map(([, at]) => at)).toEqual([
      "params.required_validations",
      "lanes.1.entry.trigger",
      "lanes.2.nodes.3.collect.fields",
    ]);
  });

  it("still analyzes what stands: a reference error and a type error in intact lanes", () => {
    expect(summary.filter(([pass]) => pass !== "format")).toEqual([
      ["reference", "lanes.2.nodes.1.gate.all.0", "unknown field 'writer' on reference_case"],
      ["type", "lanes.0.nodes.1.gate.all.0", expect.stringMatching(/url/)],
    ]);
  });

  it("never cascades on what reads a broken piece", () => {
    // `params.required_validations` (cardinality, quorum), `observation`, the author lane's `create_case` in created_by.
    expect(report.errors.filter((issue) => /required_validations|observation|create_case/.test(issue.message))).toEqual([]);
    expect(report.valid).toBe(false);
    expect(report.model).toBeNull();
  });

  it("gives an untouched template exactly its former verdict", () => {
    const clean = checkTemplateSource(SOURCE, "endpoint-check");
    expect(clean.errors).toEqual([]);
    expect(clean.valid).toBe(true);
    expect(clean.model).not.toBeNull();
  });
});

describe("a draft with holes", () => {
  it("names what is missing rather than a type it expected", () => {
    const report = checkTemplateSource(SOURCE.replace("  cp_per_validation:      {type: points, check: \"value >= 0\", mutable: false}\n", "  cp_per_validation:      {check: \"value >= 0\", mutable: false}\n"), "endpoint-check");
    expect(report.errors.map((issue) => [issue.path.join("."), issue.message])).toEqual([["params.cp_per_validation.type", "missing type"]]);
  });
});
