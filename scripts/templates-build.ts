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

const CONFORMANCE = path.join(ROOT, "packages/interpreter/conformance");
const CORPUS_MODULE = path.join(ROOT, "packages/template-author/corpus.source.ts");
const read = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

/**
 * Le corpus de l'agent auteur (note template-author §0.3) : les templates
 * installés, puis le corpus canonique de conformance, en texte.
 */
export function corpusModule(): string {
  const installed = existsSync(TEMPLATES)
    ? readdirSync(TEMPLATES)
        .filter((key) => existsSync(path.join(TEMPLATES, key, "template.yaml")))
        .sort()
        .map((key) => ({ name: key, origin: "installed", yaml: read(path.join(TEMPLATES, key, "template.yaml")) }))
    : [];
  const canonical = readdirSync(CONFORMANCE)
    .filter((file) => file.endsWith(".yaml"))
    .sort()
    .map((file) => ({ name: file.replace(/\.yaml$/, ""), origin: "canonical", yaml: read(path.join(CONFORMANCE, file)) }));
  return [
    "// Généré par `npm run templates:build` depuis content/templates et packages/interpreter/conformance — ne pas modifier à la main.",
    `export const corpus: readonly { name: string; origin: "installed" | "canonical"; yaml: string }[] = ${JSON.stringify([...installed, ...canonical], null, 2)};`,
    "",
  ].join("\n");
}

/** Les modules périmés ou absents, relativement à la racine. */
export function staleTemplateSources(): { yaml: string; module: string; expected: string }[] {
  const corpus = corpusModule();
  const stale = !existsSync(CORPUS_MODULE) || read(CORPUS_MODULE) !== corpus ? [{ yaml: CONFORMANCE, module: CORPUS_MODULE, expected: corpus }] : [];
  if (!existsSync(TEMPLATES)) return stale;
  return stale.concat(
    readdirSync(TEMPLATES)
      .map((key) => ({ yaml: path.join(TEMPLATES, key, "template.yaml"), module: path.join(TEMPLATES, key, "template.source.ts") }))
      .filter(({ yaml }) => existsSync(yaml))
      .map(({ yaml, module }) => ({ yaml, module, expected: sourceModuleOf(read(yaml)) }))
      .filter(({ module, expected }) => !existsSync(module) || read(module) !== expected)
  );
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
