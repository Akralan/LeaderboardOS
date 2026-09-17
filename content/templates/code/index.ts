import type { FlowDefinition } from "../../../packages/registry/platform.js";
import { checkTemplateSource, compileTemplate, defaultRuntime, type TemplateRuntime } from "../../../packages/interpreter/index.js";
import { templateSource } from "./template.source.js";

export { CODE_FLOW_KEY, codeTemplate, codeTemplateDescriptor } from "./descriptor.js";

/**
 * Le flow code, compilé depuis son template (parité P3)
 * -----------------------------------------------------
 * Ce que la distribution installe à la place du flow écrit à la main
 * (`content/flows/code`), qui reste dans le dépôt comme référence des tests
 * d'équivalence : mêmes clés de ledger, même contribution `project`, mêmes
 * colonnes de workspace, mêmes runs d'évaluation.
 */
export function compileCodeFlow(runtime: TemplateRuntime = defaultRuntime()): FlowDefinition {
  return compileTemplate(checkTemplateSource(templateSource, "code"), { runtime });
}

export const codeTemplateFlow: FlowDefinition = compileCodeFlow();
