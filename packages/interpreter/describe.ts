import type { z } from "zod";
import type { FlowDescriptor } from "../registry/flows.js";
import { checkTemplateSource } from "./check.js";
import { compileParams, poolParamOf } from "./compile/params.js";
import type { DocumentShell } from "./format/schema.js";

/**
 * Décrire un template, sans rien exécuter
 * ---------------------------------------
 * Ce qu'un client affiche d'un template installé : son descripteur (nom,
 * icône, brief, visibilité), tiré du bloc \`presentation\`, et les schémas de
 * sa configuration et de ses règles, tirés de ses paramètres — les mêmes que
 * le flow compilé installe côté serveur. Pur : aucune capacité, aucun
 * repository, importable par un composant client.
 */

export interface TemplateDescription {
  descriptor: FlowDescriptor;
  /** \`flow_config\` : les paramètres \`mutable: false\`, hors pool. */
  configSchema: z.ZodObject;
  /** \`reward_rules\` : les paramètres \`mutable: true\`. */
  rulesSchema: z.ZodObject;
}

export function descriptorOf(shell: DocumentShell): FlowDescriptor {
  const presentation = shell.presentation ?? {};
  return {
    key: shell.template.id,
    label: shell.template.name,
    longLabel: presentation.long_label ?? shell.template.name,
    icon: presentation.icon ?? "sparkles",
    briefRequired: presentation.brief_required ?? true,
    publiclyVisible: presentation.public ?? false,
    ...(presentation.join_caption ? { joinCaption: presentation.join_caption } : {}),
  };
}

export function describeTemplate(source: string, name: string): TemplateDescription {
  const report = checkTemplateSource(source, name);
  if (!report.valid || !report.model || !report.types) {
    throw new Error(`[interpreter] ${name} is not valid: ${report.errors.map((error) => error.message).join("; ")}`);
  }
  const poolParam = poolParamOf(report.model);
  if (poolParam === undefined) throw new Error(`[interpreter] ${name}: v1 compiles a single pool`);
  const params = compileParams(report.model.shell, report.types.params, poolParam);
  return { descriptor: descriptorOf(report.model.shell), configSchema: params.configSchema, rulesSchema: params.rulesSchema };
}
