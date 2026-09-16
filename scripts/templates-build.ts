import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `npm run templates:build` — le texte des templates, importable
 * -------------------------------------------------------------
 * \`content/templates/<clé>/template.yaml\` reste la seule source. Ce script en
 * écrit le texte dans \`template.source.ts\`, à côté : le serveur Next, le
 * client, vitest et tsx l'importent comme n'importe quel module, sans lire de
 * fichier à l'exécution. \`templates:check\` échoue si un module est périmé ;
 * \`--check\` ici ne fait que vérifier.
 */

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const TEMPLATES = path.join(ROOT, "content/templates");

export function sourceModuleOf(yaml: string): string {
  return [
    "// Généré par `npm run templates:build` depuis template.yaml — ne pas modifier à la main.",
    `export const templateSource = ${JSON.stringify(yaml)};`,
    "",
  ].join("\n");
}

/** Les modules périmés ou absents, relativement à la racine. */
export function staleTemplateSources(): { yaml: string; module: string; expected: string }[] {
  if (!existsSync(TEMPLATES)) return [];
  return readdirSync(TEMPLATES)
    .map((key) => ({ yaml: path.join(TEMPLATES, key, "template.yaml"), module: path.join(TEMPLATES, key, "template.source.ts") }))
    .filter(({ yaml }) => existsSync(yaml))
    .map(({ yaml, module }) => ({ yaml, module, expected: sourceModuleOf(readFileSync(yaml, "utf8").replace(/\r\n/g, "\n")) }))
    .filter(({ module, expected }) => !existsSync(module) || readFileSync(module, "utf8").replace(/\r\n/g, "\n") !== expected);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stale = staleTemplateSources();
  if (process.argv.includes("--check")) {
    for (const { module } of stale) console.error(`stale: ${path.relative(ROOT, module)} — run npm run templates:build`);
    process.exit(stale.length > 0 ? 1 : 0);
  }
  for (const { module, expected } of stale) {
    writeFileSync(module, expected);
    console.log(`wrote ${path.relative(ROOT, module)}`);
  }
  if (stale.length === 0) console.log("template sources are up to date");
}
