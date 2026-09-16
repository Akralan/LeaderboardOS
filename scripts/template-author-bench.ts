import { diagnose } from "../packages/capabilities/templates.js";
import { authorTemplate, refineTemplate } from "../packages/template-author/author.js";
import { BENCH } from "../packages/template-author/bench.js";
import { systemPrompt } from "../packages/template-author/context.js";
import { AUTHOR_MODEL, openAiLlm, slugKey } from "../packages/template-author/service.js";
import { parse } from "yaml";

/**
 * `npm run templates:author-bench [name…]` — le banc de l'agent auteur, sur le vrai modèle.
 * N'écrit rien en base : la boucle seule, avec le validateur.
 */

if (process.env.OPENAI_API_KEY === undefined) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // Sans .env : la clé viendra de l'environnement ou du store des credentials.
  }
}

const only = new Set(process.argv.slice(2));
const system = systemPrompt({ qualifications: ["medical_pro"], grids: [] });
const llm = openAiLlm();
const rows: string[] = [];
let firstRound = 0;
let repaired = 0;
const cases = BENCH.filter((entry) => only.size === 0 || only.has(entry.name));

console.log(`model ${AUTHOR_MODEL} · ${cases.length} case(s)`);
for (const entry of cases) {
  const started = Date.now();
  const run = await authorTemplate({ description: entry.description, key: `bench-${entry.name}`, keyOf: slugKey, system, llm, diagnose });
  const errors = run.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (run.validAfterFirstRound) firstRound++;
  if (errors.length === 0) repaired++;
  let refineNote = "";
  if (entry.refine && errors.length === 0) {
    const refined = await refineTemplate({ yaml: run.yaml, instruction: entry.refine.instruction, key: run.key, system, llm, diagnose });
    const before = parse(run.yaml) as Record<string, unknown>;
    const after = parse(refined.yaml) as Record<string, unknown>;
    const collateral = Object.keys({ ...before, ...after }).filter((key) => !entry.refine!.touches.includes(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    const refinedErrors = refined.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
    refineNote = ` · refine: ${refinedErrors ? `${refinedErrors} error(s)` : "valid"}${collateral.length ? `, collateral in ${collateral.join(", ")}` : ", no collateral"}`;
  }
  const line = `${entry.name.padEnd(22)} ${errors.length ? `✗ ${errors.length} error(s)` : "✓ valid"} · rounds ${run.rounds}${run.validAfterFirstRound ? " (first try)" : ""} · ${Math.round((Date.now() - started) / 1000)}s${refineNote}`;
  rows.push(line);
  console.log(line);
  for (const error of errors.slice(0, 3)) console.log(`    ${error.path} — ${error.message}`);
}
console.log(`\nvalid after round 1: ${firstRound}/${cases.length} · valid after repair: ${repaired}/${cases.length}`);
