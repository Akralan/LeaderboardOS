import type { ResourceInstance } from "../../capabilities/resources.js";
import type { Value } from "../expr/evaluator.js";
import type { Type } from "../expr/types.js";
import type { ResourceDecl } from "../format/schema.js";
import type { RuntimeResources } from "./runtime.js";

/**
 * Les ressources vues par les expressions et par les réponses
 * -----------------------------------------------------------
 * Une instance devient une valeur : `id`, ses champs déclarés (tirés de la
 * charge, `class` de sa colonne), et les colonnes du moteur que le vérificateur
 * connaît (`author`, `open`, `closed`, `verdict`, `created_at`). Un champ
 * `ref(...)` est hydraté sur un niveau : `take.translation.string.source` se lit.
 *
 * Une réponse ne sert jamais une valeur telle quelle : `project` n'en garde que
 * ce que la visibilité déclarée permet au lecteur.
 */

export type ResourceTypes = ReadonlyMap<string, Readonly<Record<string, Type>>>;

export async function resourceValue(
  instance: ResourceInstance,
  resources: RuntimeResources,
  types: ResourceTypes,
  depth = 1
): Promise<{ [key: string]: Value }> {
  const fields = types.get(instance.resource_type) ?? {};
  const value: { [key: string]: Value } = {
    id: instance.uuid,
    author: instance.created_by,
    open: instance.state === "open",
    closed: instance.state === "closed",
    verdict: instance.verdict,
    created_at: instance.created_at.toISOString(),
  };
  for (const [name, type] of Object.entries(fields)) {
    if (name in value) continue;
    const raw = name === "class" && instance.class !== null ? instance.class : (instance.payload[name] as Value | undefined) ?? null;
    if (type.kind === "resource" && typeof raw === "string" && depth > 0) {
      const target = await resources.resource(raw);
      value[name] = target ? await resourceValue(target, resources, types, depth - 1) : null;
    } else {
      value[name] = raw;
    }
  }
  return value;
}

export interface Viewer {
  userId: string | null;
  isAdmin: boolean;
  /** Le lecteur tient une réclamation sur cette instance. */
  claimant: boolean;
  /** `role(params.x)` : le lecteur détient-il la qualification que ce paramètre nomme ? */
  holdsRole(param: string): Promise<boolean>;
}

/** Les champs qu'un lecteur voit. Un champ sans visibilité déclarée est public ; `[]` n'est lisible par personne. */
export async function project(
  value: { [key: string]: Value },
  decl: ResourceDecl,
  viewer: Viewer
): Promise<{ [key: string]: Value }> {
  const projected: { [key: string]: Value } = { id: value.id };
  for (const [name, field] of Object.entries(decl.fields)) {
    if (await visible(field.visibility, value, viewer)) projected[name] = value[name] ?? null;
  }
  return projected;
}

async function visible(policy: readonly string[] | undefined, value: { [key: string]: Value }, viewer: Viewer): Promise<boolean> {
  if (policy === undefined) return true;
  for (const entry of policy) {
    if (entry === "everyone") return true;
    if (entry === "admin" && viewer.isAdmin) return true;
    if (entry === "author" && viewer.userId !== null && value.author === viewer.userId) return true;
    if (entry === "claimant" && viewer.claimant) return true;
    const role = /^role\(\s*params\.([a-z][a-z0-9_]*)\s*\)$/.exec(entry);
    if (role && (await viewer.holdsRole(role[1]))) return true;
  }
  return false;
}
