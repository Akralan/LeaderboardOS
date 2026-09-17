import type { FlowDefinition } from "../../../packages/registry/platform.js";
import { checkTemplateSource, compileTemplate, defaultRuntime, type TemplateRuntime } from "../../../packages/interpreter/index.js";
import { templateSource } from "./template.source.js";

export { JOURNEY_VALIDATION_TEMPLATE_KEY, journeyValidationTemplate } from "./descriptor.js";

/**
 * Le flow journey-validation, compilé depuis son template (parité P4)
 * -------------------------------------------------------------------
 * Ce que la distribution installe à la place du flow écrit à la main
 * (`content/flows/journey-validation`), qui reste dans le dépôt comme
 * référence des tests d'équivalence : même clé de ledger `validation`, même
 * contribution d'agrégat, mêmes identifiants (les données des tables du
 * scénario sont copiées en ressources par `scripts/db-migrate-journey-resources.ts`).
 */
export function compileJourneyValidationFlow(runtime: TemplateRuntime = defaultRuntime()): FlowDefinition {
  return compileTemplate(checkTemplateSource(templateSource, "journey-validation"), { runtime });
}

export const journeyValidationTemplateFlow: FlowDefinition = compileJourneyValidationFlow();
