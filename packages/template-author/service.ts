import { authorTemplate, refineTemplate, type AuthorRun, type Llm } from "./author.js";
import { systemPrompt, type AuthorRegistries } from "./context.js";
import { withTemplateId } from "./edits.js";

/**
 * Le service de l'agent auteur (note §1)
 * --------------------------------------
 * Ce que les routes appellent : composer le contexte (registres vivants),
 * faire tourner la boucle sur le modèle OpenAI de la distribution, puis
 * enregistrer par la capacité `templates` — exactement les chemins qu'une
 * sauvegarde humaine emprunte. L'agent est un admin des endpoints existants,
 * sans privilège de plus : il crée et écrit des brouillons, il ne publie pas.
 */

/** Le modèle ; `TEMPLATE_AUTHOR_MODEL` le remplace sans redéploiement de code. */
export const AUTHOR_MODEL = process.env.TEMPLATE_AUTHOR_MODEL ?? "gpt-5.6-luna";

export class AuthorUnavailableError extends Error {}

export function openAiLlm(model = AUTHOR_MODEL): Llm {
  return async ({ system, messages }) => {
    const { getClient } = await import("../evaluator/openai/client.js");
    let client;
    try {
      client = await getClient();
    } catch (error) {
      throw new AuthorUnavailableError(error instanceof Error ? error.message : String(error));
    }
    const response = await client.responses.create({
      model,
      instructions: system,
      input: messages.map((message) => ({ role: message.role, content: message.content })),
      text: { format: { type: "json_object" } },
    });
    return response.output_text;
  };
}

/** Les registres qu'un template peut référencer : les qualifications en usage et déclarées, les grilles. */
export async function loadRegistries(declaredQualifications: readonly string[] = []): Promise<AuthorRegistries> {
  const { db, user_qualifications } = await import("../database-service/db/drizzle.js");
  const { EvaluationGridsRepository } = await import("../database-service/repositories/evaluationGrids.repo.js");
  const used = await db.selectDistinct({ key: user_qualifications.key }).from(user_qualifications);
  const grids = await new EvaluationGridsRepository().findAll({ pageSize: 200 });
  return {
    qualifications: [...new Set([...declaredQualifications, ...used.map((row) => row.key)])].sort(),
    grids: grids.map((grid) => ({ id: grid.uuid, slug: grid.slug, name: grid.name })),
  };
}

/** `Chest X-ray triage` → `chest-x-ray-triage`. */
export function slugKey(text: string | null | undefined): string {
  const slug = (text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "template";
}

export interface AuthorReport {
  key: string;
  name: string;
  diagnostics: AuthorRun["diagnostics"];
  choices: string[];
  openQuestions: string[];
  rounds: number;
  validAfterFirstRound: boolean;
}

interface ServiceDeps {
  llm?: Llm;
  registries?: AuthorRegistries;
  declaredQualifications?: readonly string[];
}

/** Décrit → brouillon : crée le template sous une clé libre et enregistre le brouillon, même rouge. */
export async function authorDraft(input: { description: string; name?: string | null; key?: string | null; by: string | null }, deps: ServiceDeps = {}): Promise<AuthorReport> {
  const [{ templates, diagnose }, { PlatformRegistry }, { TemplateRepository }] = await Promise.all([
    import("../capabilities/templates.js"),
    import("../registry/platform.js"),
    import("../database-service/repositories/template.repo.js"),
  ]);
  const repo = new TemplateRepository();
  const system = systemPrompt(deps.registries ?? (await loadRegistries(deps.declaredQualifications)));

  const run = await authorTemplate({
    description: input.description,
    name: input.name ?? null,
    key: input.key ?? (input.name ? slugKey(input.name) : null),
    keyOf: (name) => slugKey(name),
    system,
    llm: deps.llm ?? openAiLlm(),
    diagnose,
  });

  // Une clé prise (par un template ou un flow installé) reçoit un suffixe ; le document suit.
  let key = run.key;
  for (let n = 2; (await repo.findTemplate(key)) || PlatformRegistry.flow(key); n++) key = `${run.key}-${n}`;
  const yaml = key === run.key ? run.yaml : withTemplateId(run.yaml, key);
  const name = input.name?.trim() || run.name || key;

  const created = await templates().create({ key, name, yaml, by: input.by });
  return { key, name, diagnostics: created.diagnostics, choices: run.choices, openQuestions: run.openQuestions, rounds: run.rounds, validAfterFirstRound: run.validAfterFirstRound };
}

/** Brouillon + consigne → brouillon modifié, enregistré. */
export async function refineDraft(input: { key: string; instruction: string; by: string | null }, deps: ServiceDeps = {}): Promise<(AuthorReport & { yaml: string }) | null> {
  const [{ templates, diagnose }, { TemplateRepository }] = await Promise.all([
    import("../capabilities/templates.js"),
    import("../database-service/repositories/template.repo.js"),
  ]);
  const repo = new TemplateRepository();
  const [template, draft] = await Promise.all([repo.findTemplate(input.key), repo.findDraft(input.key)]);
  if (!template || !draft) return null;

  const run = await refineTemplate({
    yaml: draft.yaml,
    instruction: input.instruction,
    key: input.key,
    system: systemPrompt(deps.registries ?? (await loadRegistries(deps.declaredQualifications))),
    llm: deps.llm ?? openAiLlm(),
    diagnose,
  });
  const saved = await templates().saveDraft(input.key, run.yaml, input.by);
  return {
    key: input.key,
    name: template.name,
    yaml: run.yaml,
    diagnostics: saved.diagnostics,
    choices: run.choices,
    openQuestions: run.openQuestions,
    rounds: run.rounds,
    validAfterFirstRound: run.validAfterFirstRound,
  };
}
