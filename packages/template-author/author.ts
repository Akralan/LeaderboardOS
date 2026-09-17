import { z } from "zod";
import type { TemplateDiagnostic } from "../capabilities/templates.js";
import { applyEdits, editSchema, withTemplateId, type TemplateEdit } from "./edits.js";

/**
 * La boucle de l'agent auteur (note §0.2, §1)
 * -------------------------------------------
 * Générer → valider → lire les diagnostics localisés → réparer, au plus
 * `MAX_REPAIRS` tours. Encore rouge après : le brouillon est rendu quand même,
 * avec ses diagnostics — un brouillon troué s'enregistre, c'est la garantie
 * qui rend l'agent sûr de se tromper. La boucle ne publie jamais et ne touche
 * à aucun stockage : le modèle (`Llm`) et le validateur (`Diagnose`) lui sont
 * donnés.
 */

export const MAX_REPAIRS = 3;

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export type Llm = (input: { system: string; messages: LlmMessage[] }) => Promise<string>;
export type Diagnose = (yaml: string, key: string) => Promise<TemplateDiagnostic[]>;

export interface AuthorRun {
  yaml: string;
  name: string | null;
  diagnostics: TemplateDiagnostic[];
  choices: string[];
  openQuestions: string[];
  /** Les appels au modèle : la génération, puis chaque réparation. */
  rounds: number;
  /** Sans erreur dès la première réponse, avant toute réparation. */
  validAfterFirstRound: boolean;
}

const answerSchema = z.object({
  name: z.string().optional(),
  yaml: z.string().optional(),
  edits: z.array(editSchema).optional(),
  choices: z.array(z.string()).optional(),
  open_questions: z.array(z.string()).optional(),
});
type Answer = z.infer<typeof answerSchema>;

/** Le JSON de la réponse, même entouré d'une clôture de code. */
export function parseAnswer(text: string): Answer | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = answerSchema.safeParse(JSON.parse(trimmed.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const errorsOf = (diagnostics: readonly TemplateDiagnostic[]) => diagnostics.filter((diagnostic) => diagnostic.severity === "error");

function repairPrompt(diagnostics: readonly TemplateDiagnostic[], failures: readonly string[], unreadable: boolean): string {
  const lines: string[] = [];
  if (unreadable) lines.push("Your last answer was not the required JSON object. Answer again with the JSON object only.");
  if (failures.length) lines.push("These edits could not be applied:", ...failures.map((failure) => `- ${failure}`));
  const errors = errorsOf(diagnostics);
  if (errors.length) {
    lines.push(
      "The validator reports these errors on the current document (path — message):",
      ...errors.map((diagnostic) => `- [${diagnostic.code}] ${diagnostic.path || "(document)"} — ${diagnostic.message}`)
    );
  }
  lines.push(
    "Repair the document and answer with the JSON object. Prefer \"edits\" addressed to the paths above; send the complete \"yaml\" only if the document must be rewritten. Keep what is already valid unchanged. Update \"choices\" and \"open_questions\" if the repair changes an assumption."
  );
  return lines.join("\n");
}

function merge(target: string[], values: readonly string[] | undefined) {
  for (const value of values ?? []) if (value.trim() && !target.includes(value.trim())) target.push(value.trim());
}

interface LoopInput {
  system: string;
  prompt: string;
  /** Le document de départ : les éditions s'appliquent sur lui (vide pour une création). */
  base: string;
  /** La clé, quand elle est connue ; sinon tirée du nom que le modèle propose. */
  key: string | null;
  keyOf: (name: string | null) => string;
  llm: Llm;
  diagnose: Diagnose;
}

async function loop(input: LoopInput): Promise<AuthorRun & { key: string }> {
  const messages: LlmMessage[] = [{ role: "user", content: input.prompt }];
  const choices: string[] = [];
  const openQuestions: string[] = [];
  let candidate = input.base;
  let name: string | null = null;
  let key = input.key;
  let diagnostics: TemplateDiagnostic[] = [];
  let validAfterFirstRound = false;
  let rounds = 0;

  for (;;) {
    rounds++;
    const text = await input.llm({ system: input.system, messages });
    messages.push({ role: "assistant", content: text });
    const answer = parseAnswer(text);
    let failures: string[] = [];
    if (answer) {
      if (answer.name?.trim()) name = answer.name.trim();
      if (answer.yaml?.trim()) candidate = answer.yaml.replace(/\r\n/g, "\n");
      else if (answer.edits?.length) ({ yaml: candidate, failures } = applyEdits(candidate, answer.edits as TemplateEdit[]));
      else if (!candidate.trim()) failures = ["The answer carried neither \"yaml\" nor \"edits\"."];
      merge(choices, answer.choices);
      merge(openQuestions, answer.open_questions);
    }
    key ??= input.keyOf(name);
    candidate = withTemplateId(candidate, key);
    diagnostics = await input.diagnose(candidate, key);
    if (rounds === 1) validAfterFirstRound = !!answer && failures.length === 0 && errorsOf(diagnostics).length === 0;

    const clean = !!answer && failures.length === 0 && errorsOf(diagnostics).length === 0;
    if (clean || rounds > MAX_REPAIRS) break;
    messages.push({ role: "user", content: repairPrompt(diagnostics, failures, !answer) });
  }

  return { yaml: candidate, name, key, diagnostics, choices, openQuestions, rounds, validAfterFirstRound };
}

/** Une description en langage naturel → un brouillon complet. */
export function authorTemplate(input: {
  description: string;
  name?: string | null;
  key: string | null;
  keyOf: (name: string | null) => string;
  system: string;
  llm: Llm;
  diagnose: Diagnose;
}) {
  const prompt = [
    "Write a complete template for this contribution program.",
    input.name ? `Name: ${input.name}` : null,
    input.key ? `Template id (template.id): ${input.key}` : null,
    "Description:",
    input.description.trim(),
    'Answer with the JSON object: "yaml" (the complete document), "name", "choices" and "open_questions".',
  ]
    .filter(Boolean)
    .join("\n");
  return loop({ system: input.system, prompt, base: "", key: input.key, keyOf: input.keyOf, llm: input.llm, diagnose: input.diagnose });
}

/** Un brouillon existant + une consigne → le brouillon modifié, le reste intact. */
export function refineTemplate(input: { yaml: string; instruction: string; key: string; system: string; llm: Llm; diagnose: Diagnose }) {
  const prompt = [
    "Here is the current draft:",
    "```yaml",
    input.yaml.trim(),
    "```",
    `Instruction: ${input.instruction.trim()}`,
    'Change only what the instruction requires. Answer with the JSON object: "edits" addressed to the document (or the complete "yaml" if the change rewrites most of it), plus "choices" and "open_questions" about this change.',
  ].join("\n");
  return loop({ system: input.system, prompt, base: input.yaml, key: input.key, keyOf: () => input.key, llm: input.llm, diagnose: input.diagnose });
}
