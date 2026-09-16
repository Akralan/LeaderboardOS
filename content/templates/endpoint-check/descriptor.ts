import { describeTemplate } from "../../../packages/interpreter/describe.js";
import { templateSource } from "./template.source.js";

/**
 * Le template endpoint-check, décrit — sans rien exécuter
 * -------------------------------------------------------
 * Importable par le client : le descripteur vient du bloc `presentation` du
 * template, le schéma de configuration de ses paramètres. Le flow compilé est
 * dans `index.ts`, côté serveur.
 */
export const endpointCheckTemplate = describeTemplate(templateSource, "endpoint-check");

export const ENDPOINT_CHECK_FLOW_KEY = endpointCheckTemplate.descriptor.key;
export const endpointCheckFlowDescriptor = endpointCheckTemplate.descriptor;
