/**
 * L'interpréteur
 * --------------
 * Lire et valider un template (`check.ts`, J1), le compiler en
 * `FlowDefinition` sur les capacités du core (`compile/`, J2), et en tirer
 * ce qu'un client affiche sans rien exécuter (`describe.ts`). Un client
 * importe `describe.ts` directement : cette entrée-ci charge le compilateur et
 * son runtime, donc le core serveur.
 */

export * from "./check.js";
export { DEFAULT_CATALOG, type CapabilityCatalog } from "./catalog.js";
export { formatIssue, type SupportGap, type TemplateIssue } from "./issues.js";
export type { TemplateModel } from "./validate/format.js";
export { CompileError, compileTemplate, type CompileOptions } from "./compile/compile.js";
export { defaultRuntime, RuntimeBindingError, type TemplateRuntime } from "./compile/runtime.js";
export { describeTemplate, type TemplateDescription } from "./describe.js";
