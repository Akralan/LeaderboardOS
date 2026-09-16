import { describeTemplate } from "../../../packages/interpreter/describe.js";
import { templateSource } from "./template.source.js";

/**
 * Le template data-annotation, décrit — sans rien exécuter
 * --------------------------------------------------------
 * Importable par le client : le descripteur (nom, icône, brief, visibilité)
 * vient du bloc `presentation` du template, les schémas de configuration et de
 * règles de ses paramètres. Le flow compilé est dans `index.ts`, côté serveur.
 */
export const dataAnnotationTemplate = describeTemplate(templateSource, "data-annotation");

export const DATA_ANNOTATION_FLOW_KEY = dataAnnotationTemplate.descriptor.key;
export const dataAnnotationFlowDescriptor = dataAnnotationTemplate.descriptor;
