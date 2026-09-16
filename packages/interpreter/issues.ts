/**
 * Ce qu'une vérification de template rapporte
 * -------------------------------------------
 * Les passes de validation, dans l'ordre de la note de conception (§3) :
 * `format`, `reference`, `type`, `shape`, `economy`, `claim`. Une erreur rend
 * le template invalide ; un avis (`advisory`) le laisse valide.
 *
 * Valide n'est pas compilable : un template valide peut utiliser une partie du
 * vocabulaire que la v1 ne compile pas encore (un webhook, un `unique_per`
 * scopé…). Cela se rapporte à part, en `SupportGap`, et n'invalide rien.
 */

export type IssuePass = "format" | "reference" | "type" | "shape" | "economy" | "claim";

export const PASS_ORDER: readonly IssuePass[] = ["format", "reference", "type", "shape", "economy", "claim"];

export type TemplatePath = readonly (string | number)[];

export interface TemplateIssue {
  pass: IssuePass;
  severity: "error" | "advisory";
  /** Le chemin dans le document : `["lanes", 1, "nodes", 0, "gate", "all", 0]`. */
  path: TemplatePath;
  /** Le nœud concerné, quand il y en a un. */
  node?: string;
  /** La position dans le texte de l'expression, quand l'erreur est dans une expression. */
  position?: number;
  /** La ligne dans le fichier source, quand le document vient d'un texte YAML. */
  line?: number;
  message: string;
}

/** Une partie du vocabulaire, valide, que la v1 ne compile pas encore. */
export interface SupportGap {
  feature: string;
  path: TemplatePath;
  node?: string;
  line?: number;
  message: string;
}

export function formatIssue(template: string, issue: TemplateIssue): string {
  const where = [
    issue.line !== undefined ? `line ${issue.line}` : issue.path.join("."),
    issue.node ? `node ${issue.node}` : null,
    issue.position !== undefined ? `col ${issue.position + 1}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const level = issue.severity === "advisory" ? "advisory" : "error";
  return `${template}: ${level} [${issue.pass}] ${where} — ${issue.message}`;
}
