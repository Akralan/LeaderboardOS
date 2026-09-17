import { z } from "zod";
import type { Challenge } from "../../database-service/domain/entities.js";
import { evaluate, type Value } from "../expr/evaluator.js";
import { parseExpr } from "../expr/parser.js";
import { OPTIONAL_TYPES, type Type } from "../expr/types.js";
import type { DocumentShell, RewardBody } from "../format/schema.js";
import type { NodeModel, TemplateModel } from "../validate/format.js";

/**
 * Paramètres d'un template compilé
 * --------------------------------
 * Compromis 4 de la note : un paramètre `mutable: false` va dans le schéma de
 * `flow_config`, fixé à la création ; un paramètre `mutable: true` dans
 * `rules.parse`, les `reward_rules` éditables. Une seule source chacun.
 *
 * Le paramètre qu'une récompense nomme comme pool n'est ni l'un ni l'autre :
 * c'est le pool du challenge (`contribution_points_reward`), que le core gère.
 */

/** Le schéma zod d'une valeur d'un type déclaré. Une référence se transmet par son id. */
export function zodOf(type: Type): z.ZodType {
  const schema = baseZodOf(type);
  return OPTIONAL_TYPES.has(type) ? schema.optional() : schema;
}

function baseZodOf(type: Type): z.ZodType {
  switch (type.kind) {
    case "int":
      return z.number().int();
    case "number":
      return z.number();
    case "bool":
      return z.boolean();
    case "enum":
      return type.values && type.values.length > 0 ? z.enum(type.values as [string, ...string[]]) : z.string();
    case "list":
      return z.array(zodOf(type.of));
    case "record": {
      const shape: Record<string, z.ZodType> = {};
      for (const [key, field] of Object.entries(type.fields)) shape[key] = zodOf(field);
      return z.object(shape);
    }
    case "url":
      return z.string().regex(/^https?:\/\/\S+$/, "an http(s) URL");
    case "null":
      return z.null();
    case "dyn":
    case "file":
      return z.unknown();
    default:
      return z.string().min(1);
  }
}

export interface CompiledParams {
  configSchema: z.ZodObject;
  rulesSchema: z.ZodObject;
  /** Le paramètre servi par le pool du challenge, s'il y en a un. */
  poolParam: string | null;
  /** Les valeurs des paramètres d'un challenge ; `null` si sa configuration ou ses règles ne se lisent pas. */
  valuesOf(challenge: Challenge, config: Record<string, unknown> | null): Record<string, Value> | null;
}

export function compileParams(shell: DocumentShell, types: Readonly<Record<string, Type>>, poolParam: string | null): CompiledParams {
  const config: Record<string, z.ZodType> = {};
  const rules: Record<string, z.ZodType> = {};
  // Le challenge source n'est pas de la configuration : c'est la colonne `source_challenge_id`, que la création pose.
  const sourceParam = Object.keys(shell.params).find((name) => types[name]?.kind === "challenge") ?? null;
  for (const [name, param] of Object.entries(shell.params)) {
    if (name === poolParam || name === sourceParam) continue;
    let schema = zodOf(types[name]);
    // Les checks du template font partie du schéma : une valeur qui en échoue un ne se stocke ni ne se lit.
    const checks = [
      ...(typeof param.check === "string" ? [["check", param.check] as const] : []),
      ...Object.entries(param.checks ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ];
    for (const [check, source] of checks) {
      const ast = parseExpr(source);
      const passes = (value: unknown) => {
        try {
          return evaluate(ast, { value: value as Value }) === true;
        } catch {
          return false;
        }
      };
      schema = schema.refine(passes, { message: check === "check" ? `${name} fails its check` : `${name}: ${check.replace(/_/g, " ")}` });
    }
    if (param.default !== undefined) schema = schema.default(param.default);
    (param.mutable ? rules : config)[name] = schema;
  }
  const configSchema = z.object(config);
  const rulesSchema = z.object(rules);

  return {
    configSchema,
    rulesSchema,
    poolParam,
    valuesOf(challenge, storedConfig) {
      const parsedConfig = configSchema.safeParse(storedConfig ?? {});
      const parsedRules = rulesSchema.safeParse(challenge.reward_rules ?? {});
      if (!parsedConfig.success || !parsedRules.success) return null;
      const values = { ...parsedConfig.data, ...parsedRules.data } as Record<string, Value>;
      if (poolParam) values[poolParam] = challenge.contribution_points_reward;
      if (sourceParam) values[sourceParam] = challenge.source_challenge_id ?? null;
      return values;
    },
  };
}

/**
 * Le paramètre qu'une récompense nomme comme pool : `null` sans pool,
 * `undefined` quand les récompenses en nomment plusieurs (la v1 n'en compile qu'un).
 */
export function poolParamOf(model: TemplateModel): string | null | undefined {
  const bodies: RewardBody[] = [];
  const walk = (nodes: readonly NodeModel[]) => {
    for (const node of nodes) {
      if (node.family === "reward") bodies.push(node.body);
      if (node.family === "gate") for (const branch of node.branches ?? []) walk(branch.nodes);
    }
  };
  for (const lane of model.lanes) walk(lane.nodes);
  for (const effect of [...model.aggregates.flatMap((aggregate) => aggregate.then), ...model.onClose]) {
    if (effect.family === "reward") bodies.push(effect.body);
  }
  const pools = new Set(bodies.map((body) => body.pool).filter((pool) => pool !== undefined).map(String));
  if (pools.size > 1) return undefined;
  if (pools.size === 0) return null;
  return /^\s*params\.([a-z][a-z0-9_]*)\s*$/.exec([...pools][0])?.[1] ?? null;
}
