import type { FlowDefinition } from "../../../packages/registry/platform.js";
import { checkTemplateSource, compileTemplate, defaultRuntime, type TemplateRuntime } from "../../../packages/interpreter/index.js";
import { templateSource } from "./template.source.js";

export { DATA_ANNOTATION_FLOW_KEY, dataAnnotationFlowDescriptor, dataAnnotationTemplate } from "./descriptor.js";

/**
 * Le flow data-annotation, compilé depuis son template
 * ----------------------------------------------------
 * Ce que la distribution installe à la place du flow écrit à la main
 * (`content/flows/data-annotation`), qui reste dans le dépôt comme référence
 * des tests d'équivalence. Un template invalide, ou qui utilise ce que la v1
 * ne compile pas, fait échouer le démarrage — comme tout conflit
 * d'installation.
 */
export function compileDataAnnotationFlow(runtime: TemplateRuntime = defaultRuntime()): FlowDefinition {
  return compileTemplate(checkTemplateSource(templateSource, "data-annotation"), { runtime });
}

export const dataAnnotationTemplateFlow: FlowDefinition = compileDataAnnotationFlow();
