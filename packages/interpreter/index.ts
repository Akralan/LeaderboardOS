import { LineCounter, isNode, parseDocument } from "yaml";
import { DEFAULT_CATALOG, type CapabilityCatalog } from "./catalog.js";
import { PASS_ORDER, type SupportGap, type TemplateIssue } from "./issues.js";
import { analyzeTemplate } from "./validate/analyze.js";
import { validateFormat, type TemplateModel } from "./validate/format.js";

/**
 * L'interpréteur — J1 : lire et valider
 * -------------------------------------
 * Un template `leaderboardos/1` entre en texte YAML (ou déjà parsé) ; il en
 * sort un verdict : ses erreurs dans l'ordre des passes (format, références,
 * types, forme, économie, claims), ses avis, et ce que la v1 ne sait pas
 * encore compiler. La compilation en `FlowDefinition` est l'objet de J2.
 */

export { DEFAULT_CATALOG, type CapabilityCatalog } from "./catalog.js";
export { formatIssue, type SupportGap, type TemplateIssue } from "./issues.js";
export type { TemplateModel } from "./validate/format.js";

/** La version du core que cette implémentation fournit. */
export const CORE_VERSION = 1;

export interface CheckOptions {
  catalog?: CapabilityCatalog;
  coreVersion?: number;
  gridExists?: (ref: string) => boolean;
}

export interface TemplateReport {
  /** `template.id`, ou le nom donné quand le document ne se lit pas. */
  name: string;
  valid: boolean;
  errors: TemplateIssue[];
  advisories: TemplateIssue[];
  /** Vide : la v1 compile tout ce que le template utilise. */
  gaps: SupportGap[];
  model: TemplateModel | null;
}

function byPass(a: TemplateIssue, b: TemplateIssue): number {
  return PASS_ORDER.indexOf(a.pass) - PASS_ORDER.indexOf(b.pass);
}

export function checkTemplate(raw: unknown, name: string, options: CheckOptions = {}): TemplateReport {
  const format = validateFormat(raw);
  if (!format.model) {
    return { name, valid: false, errors: format.issues, advisories: [], gaps: [], model: null };
  }
  const { issues, gaps } = analyzeTemplate(format.model, {
    catalog: options.catalog ?? DEFAULT_CATALOG,
    coreVersion: options.coreVersion ?? CORE_VERSION,
    gridExists: options.gridExists,
  });
  const errors = issues.filter((issue) => issue.severity === "error").sort(byPass);
  return {
    name: format.model.shell.template.id,
    valid: errors.length === 0,
    errors,
    advisories: issues.filter((issue) => issue.severity === "advisory").sort(byPass),
    gaps,
    model: errors.length === 0 ? format.model : null,
  };
}

/** Depuis le texte : les erreurs portent en plus leur ligne dans le fichier. */
export function checkTemplateSource(source: string, name: string, options: CheckOptions = {}): TemplateReport {
  const lineCounter = new LineCounter();
  const document = parseDocument(source, { lineCounter, prettyErrors: false });
  if (document.errors.length > 0) {
    return {
      name,
      valid: false,
      errors: document.errors.map((error) => ({
        pass: "format" as const,
        severity: "error" as const,
        path: [],
        line: lineCounter.linePos(error.pos[0]).line,
        message: `YAML: ${error.message.split("\n")[0]}`,
      })),
      advisories: [],
      gaps: [],
      model: null,
    };
  }

  const report = checkTemplate(document.toJS(), name, options);
  const locate = <T extends { path: readonly (string | number)[]; line?: number }>(item: T): T => {
    for (let length = item.path.length; length >= 0; length--) {
      const node = document.getIn(item.path.slice(0, length), true);
      if (isNode(node) && node.range) return { ...item, line: lineCounter.linePos(node.range[0]).line };
    }
    return item;
  };
  return {
    ...report,
    errors: report.errors.map(locate),
    advisories: report.advisories.map(locate),
    gaps: report.gaps.map(locate),
  };
}
