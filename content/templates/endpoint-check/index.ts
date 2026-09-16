import type { FlowDefinition } from "../../../packages/registry/platform.js";
import { checkTemplateSource, compileTemplate, defaultRuntime, type TemplateRuntime } from "../../../packages/interpreter/index.js";
import { templateSource } from "./template.source.js";

export { ENDPOINT_CHECK_FLOW_KEY, endpointCheckFlowDescriptor, endpointCheckTemplate } from "./descriptor.js";

/**
 * Le flow endpoint-check, compilé depuis son template
 * ---------------------------------------------------
 * Ce qui prend la suite du flow endpoint-validation écrit à la main
 * (`content/flows/endpoint-validation`) par attrition : une clé de flow et des
 * clés de ledger à lui, des challenges nouveaux seulement. Le flow écrit à la
 * main reste installé, retiré (`retired`), tant qu'un challenge le porte.
 */
export function compileEndpointCheckFlow(runtime: TemplateRuntime = defaultRuntime()): FlowDefinition {
  return compileTemplate(checkTemplateSource(templateSource, "endpoint-check"), { runtime });
}

export const endpointCheckTemplateFlow: FlowDefinition = compileEndpointCheckFlow();
