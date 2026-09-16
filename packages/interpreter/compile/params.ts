import { z } from "zod";
import type { Challenge } from "../../database-service/domain/entities.js";
import type { Value } from "../expr/evaluator.js";
import type { Type } from "../expr/types.js";
import type { DocumentShell } from "../format/schema.js";

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
  for (const [name, param] of Object.entries(shell.params)) {
    if (name === poolParam) continue;
    let schema = zodOf(types[name]);
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
      return values;
    },
  };
}
