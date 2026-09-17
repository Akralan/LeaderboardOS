import type { FlowDefinition } from "../../../packages/registry/platform.js";
import { checkTemplateSource, compileTemplate, defaultRuntime, type TemplateRuntime } from "../../../packages/interpreter/index.js";
import { templateSource } from "./template.source.js";

export { ML_TEMPLATE_KEY, mlTemplate } from "./descriptor.js";

/**
 * Le flow ML, compilé depuis son template (parité P5)
 * ---------------------------------------------------
 * Ce que la distribution installe à la place du flow écrit à la main
 * (`content/flows/ml`), qui reste dans le dépôt comme référence des tests
 * d'équivalence : mêmes dépôts d'étape et `workspace_meta`, mêmes
 * contributions, mêmes clés de ledger et méta, même handler `submission`.
 */
export function compileMlFlow(runtime: TemplateRuntime = defaultRuntime()): FlowDefinition {
  return compileTemplate(checkTemplateSource(templateSource, "ml"), { runtime });
}

export const mlTemplateFlow: FlowDefinition = compileMlFlow();
