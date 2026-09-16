import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkTemplateSource, formatIssue } from "../packages/interpreter/index.js";

/**
 * `npm run templates:check` — valide les templates `leaderboardos/1`
 * ------------------------------------------------------------------
 * Le corpus de conformance (`packages/interpreter/conformance/`) et les
 * templates de la distribution (`content/templates/<clé>/template.yaml`).
 * Sort en erreur au premier template invalide ; les avis et ce que la v1 ne
 * compile pas encore s'affichent sans faire échouer.
 */

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function templateFiles(): string[] {
  const conformance = path.join(ROOT, "packages/interpreter/conformance");
  const files = readdirSync(conformance)
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => path.join(conformance, file));
  const content = path.join(ROOT, "content/templates");
  try {
    for (const key of readdirSync(content)) files.push(path.join(content, key, "template.yaml"));
  } catch {
    // Aucun template installé dans la distribution.
  }
  return files.sort();
}

let invalid = 0;
for (const file of templateFiles()) {
  const relative = path.relative(ROOT, file).split(path.sep).join("/");
  const report = checkTemplateSource(readFileSync(file, "utf8"), relative);
  const status = report.valid ? (report.gaps.length === 0 ? "valid, compilable" : `valid, ${report.gaps.length} v1 gap(s)`) : "INVALID";
  console.log(`${report.valid ? "✓" : "✗"} ${relative} — ${status}`);
  for (const issue of [...report.errors, ...report.advisories]) console.log(`    ${formatIssue(report.name, issue)}`);
  for (const gap of report.gaps) {
    console.log(`    gap ${gap.line !== undefined ? `line ${gap.line}` : gap.path.join(".")}${gap.node ? ` (${gap.node})` : ""}: ${gap.feature} — ${gap.message}`);
  }
  if (!report.valid) invalid++;
}

if (invalid > 0) {
  console.error(`\n${invalid} invalid template(s)`);
  process.exit(1);
}
