import { describeTemplate } from "../../../packages/interpreter/describe.js";
import { templateSource } from "./template.source.js";

/**
 * Le template journey-validation, décrit — sans rien exécuter
 * -----------------------------------------------------------
 * Importable par le client : descripteur, schémas et surface d'où l'UI
 * générée se construit. Le flow compilé est dans `index.ts`, côté serveur.
 */
export const journeyValidationTemplate = describeTemplate(templateSource, "journey-validation");

export const JOURNEY_VALIDATION_TEMPLATE_KEY = journeyValidationTemplate.descriptor.key;
