import { describeTemplate } from "../../../packages/interpreter/describe.js";
import { templateSource } from "./template.source.js";

/**
 * Le template code, décrit — sans rien exécuter
 * ---------------------------------------------
 * Importable par le client : le descripteur vient du bloc `presentation` du
 * template, le schéma de configuration de ses paramètres. Le flow compilé est
 * dans `index.ts`, côté serveur.
 */
export const codeTemplate = describeTemplate(templateSource, "code");

export const CODE_FLOW_KEY = codeTemplate.descriptor.key;
export const codeTemplateDescriptor = codeTemplate.descriptor;
