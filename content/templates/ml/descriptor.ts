import { describeTemplate } from "../../../packages/interpreter/describe.js";
import { templateSource } from "./template.source.js";

/**
 * Le template ml, décrit — sans rien exécuter
 * -------------------------------------------
 * Importable par le client : descripteur, schémas et surface. Le flow compilé
 * est dans `index.ts`, côté serveur.
 */
export const mlTemplate = describeTemplate(templateSource, "ml");

export const ML_TEMPLATE_KEY = mlTemplate.descriptor.key;
