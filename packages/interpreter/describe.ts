import type { z } from "zod";
import type { FlowDescriptor } from "../registry/flows.js";
import { checkTemplateSource, type TemplateTypes } from "./check.js";
import { compileParams, poolParamOf } from "./compile/params.js";
import { gestureFields, segmentsOf } from "./compile/segments.js";
import type { Type } from "./expr/types.js";
import type { DocumentShell } from "./format/schema.js";
import type { TemplateModel } from "./validate/format.js";

/**
 * Décrire un template, sans rien exécuter
 * ---------------------------------------
 * Ce qu'un client affiche d'un template installé : son descripteur (nom,
 * icône, brief, visibilité), tiré du bloc \`presentation\`, les schémas de
 * sa configuration et de ses règles, tirés de ses paramètres — les mêmes que
 * le flow compilé installe côté serveur —, et sa surface, d'où le client
 * génère ses écrans. Pur : aucune capacité, aucun repository, importable par
 * un composant client.
 */

export interface TemplateDescription {
  descriptor: FlowDescriptor;
  /** \`flow_config\` : les paramètres \`mutable: false\`, hors pool. */
  configSchema: z.ZodObject;
  /** \`reward_rules\` : les paramètres \`mutable: true\`. */
  rulesSchema: z.ZodObject;
  /** Ce que le client génère : les lanes, leurs segments et leurs champs typés, les ressources. */
  surface: TemplateSurface;
}

/**
 * La surface d'un template, pour l'UI générée (note §5)
 * ----------------------------------------------------
 * Un segment est un appel (\`POST flow/<path>\`) ; ses champs sont ceux de ses
 * gestes, à plat, typés pour choisir un contrôle. Un segment après le claim
 * reçoit \`claim_id\`. Les lectures (\`<lane>/claim\`, \`<lane>/file\`,
 * \`<lane>/options\`, \`progress\`, \`overview\`, \`export\`) sont celles que le
 * compilateur génère.
 */
export type SurfaceFieldKind = "string" | "int" | "number" | "bool" | "enum" | "url" | "file" | "json" | "ref" | "link" | "date";

export interface SurfaceField {
  name: string;
  /** Le geste qui le collecte : \`<geste>.<champ>\` nomme le champ pour \`options\`. */
  gesture: string;
  kind: SurfaceFieldKind;
  /** Pour \`enum\` : les valeurs, quand le template les écrit. */
  values?: readonly string[];
  /** Pour \`ref\` : le type de ressource. */
  resource?: string;
  /** Conditionnel (\`when\`) : le serveur l'ignore quand sa condition est fausse. */
  conditional?: boolean;
}

export interface SurfaceSegment {
  path: string;
  fields: SurfaceField[];
  /** Le segment pose le claim : sa réponse porte \`claim.claim_id\`. */
  opensClaim: boolean;
  /** Le segment reprend un claim posé plus tôt : \`claim_id\` est requis. */
  needsClaim: boolean;
  final: boolean;
}

export interface SurfaceLane {
  id: string;
  trigger: "user" | "admin";
  segments: SurfaceSegment[];
  /** La lane pose un claim : \`<lane>/claim\`, \`<lane>/file\` et \`<lane>/release\` existent. */
  claims: boolean;
  /** Pour une lane réservée à une qualification : le paramètre de configuration qui la nomme. */
  role?: string;
}

export interface SurfaceResource {
  type: string;
  fields: { name: string; kind: SurfaceFieldKind }[];
  /** Les aggregates qui résolvent ce type : leur état vient avec les options. */
  aggregates: string[];
}

/**
 * Un paramètre, tel qu'un formulaire d'instanciation le génère : pas le schéma
 * zod (il ne traverse pas HTTP et `z.toJSONSchema` perd les checks nommés),
 * mais la déclaration. Le serveur revalide avec le vrai schéma à la création.
 */
export interface SurfaceParam {
  name: string;
  /** Ce que le contrôle saisit : un nombre, un texte, une énumération, une qualification, une structure (JSON)… */
  kind: "int" | "number" | "bool" | "string" | "url" | "enum" | "role" | "challenge" | "grid" | "json";
  values?: readonly string[];
  default?: unknown;
  /** Où va la valeur : le pool du challenge, son challenge source, sa configuration figée, ses règles éditables. */
  binding: "pool" | "source" | "config" | "rules";
  /** Les noms des checks nommés : les messages que le serveur renverra. */
  checks: string[];
}

export interface TemplateSurface {
  lanes: SurfaceLane[];
  resources: SurfaceResource[];
  params: SurfaceParam[];
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
  return {
    descriptor: descriptorOf(report.model.shell),
    configSchema: params.configSchema,
    rulesSchema: params.rulesSchema,
    surface: surfaceOf(report.model, report.types),
  };
}

function kindOf(type: Type | undefined, declared: unknown): SurfaceFieldKind {
  switch (type?.kind) {
    case "int":
    case "number":
    case "bool":
    case "url":
    case "file":
    case "date":
    case "string":
    case "enum":
      return type.kind;
    case "resource":
      return "ref";
    case "contribution":
      return "link";
    default:
      return declared === "json" ? "json" : "string";
  }
}

function roleOf(lane: TemplateModel["lanes"][number]): { role?: string } {
  const access = lane.entry.access;
  if (access?.mode !== "role") return {};
  const param = /^\s*params\.([a-z][a-z0-9_]*)\s*$/.exec(String(access.role))?.[1];
  return param ? { role: param } : {};
}

export function surfaceOf(model: TemplateModel, types: TemplateTypes): TemplateSurface {
  const lanes: SurfaceLane[] = [];
  for (const lane of model.lanes) {
    const trigger = lane.entry.trigger;
    if (trigger !== "user" && trigger !== "admin") continue;
    const segments = segmentsOf(lane);
    const claimIndex = segments.findIndex((segment) => segment.nodes.some((node) => node.family === "act" && node.body.claim));
    lanes.push({
      id: lane.id,
      trigger,
      claims: claimIndex >= 0,
      ...roleOf(lane),
      segments: segments.map((segment, index) => ({
        path: segment.path,
        opensClaim: index === claimIndex,
        needsClaim: claimIndex >= 0 && index > claimIndex,
        final: segment.final,
        fields: segment.gestures.flatMap((gesture) =>
          Object.entries(gestureFields(gesture)).map(([name, decl]): SurfaceField => {
            const type = types.nodeFields.get(gesture)?.[name];
            return {
              name,
              gesture: gesture.id,
              kind: kindOf(type, decl.type),
              ...(type?.kind === "enum" && type.values ? { values: type.values } : {}),
              ...(type?.kind === "resource" ? { resource: type.name } : {}),
              ...(decl.when !== undefined ? { conditional: true } : {}),
            };
          })
        ),
      })),
    });
  }
  const resources = Object.entries(model.shell.resources).map(([type, decl]) => ({
    type,
    fields: Object.entries(decl.fields).map(([name, field]) => ({ name, kind: kindOf(types.resources.get(type)?.[name], field.type) })),
    aggregates: model.aggregates.filter((aggregate) => aggregate.decl.over === type).map((aggregate) => aggregate.decl.id),
  }));
  const poolParam = poolParamOf(model);
  const params = Object.entries(model.shell.params).map(([name, decl]): SurfaceParam => {
    const type = types.params[name];
    const kind: SurfaceParam["kind"] =
      type?.kind === "int" || type?.kind === "number" || type?.kind === "bool" || type?.kind === "url" || type?.kind === "enum" || type?.kind === "role" || type?.kind === "challenge" || type?.kind === "grid"
        ? type.kind
        : type?.kind === "string"
          ? "string"
          : "json";
    return {
      name,
      kind,
      ...(type?.kind === "enum" && type.values ? { values: type.values } : {}),
      ...(decl.default !== undefined ? { default: decl.default } : {}),
      binding: name === poolParam ? "pool" : kind === "challenge" ? "source" : decl.mutable ? "rules" : "config",
      checks: Object.keys(decl.checks ?? {}),
    };
  });
  return { lanes, resources, params };
}
