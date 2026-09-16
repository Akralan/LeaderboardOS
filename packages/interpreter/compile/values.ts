import type { ResourceInstance } from "../../capabilities/resources.js";
import type { Value } from "../expr/evaluator.js";
import type { Type } from "../expr/types.js";
import type { ResourceDecl } from "../format/schema.js";
import type { RuntimeContributions, RuntimeResources } from "./runtime.js";

/** Ce que l'hydratation lit : les ressources, et les contributions qu'un champ `link` désigne. */
export interface ValueRuntime {
  resources: Pick<RuntimeResources, "resource">;
  contributions?: Pick<RuntimeContributions, "find">;
}

/**
 * Les ressources vues par les expressions et par les réponses
 * -----------------------------------------------------------
 * Une instance devient une valeur : `id`, ses champs déclarés (tirés de la
 * charge, `class` de sa colonne), et les colonnes du moteur que le vérificateur
 * connaît (`author`, `open`, `closed`, `verdict`, `created_at`). Un champ
 * `ref(...)` est hydraté sur un niveau : `take.translation.string.source` se lit.
 *
 * Une réponse ne sert jamais une valeur telle quelle : `project` n'en garde que
 * ce que la visibilité déclarée — ou un grant — permet au lecteur.
 *
 * Le contexte d'un claim ne garde jamais une ressource hydratée, seulement sa
 * référence (`{ "$resource": "<uuid>" }`) : ce qu'il stocke ne doit rien
 * révéler que la ressource elle-même cacherait.
 */

/** Les valeurs sorties de `resourceValue` : ce que la sérialisation réduit à une référence. */
const hydrated = new WeakSet<object>();

export function isResourceValue(value: Value): value is { [key: string]: Value } {
  return value !== null && typeof value === "object" && hydrated.has(value);
}

export type ResourceTypes = ReadonlyMap<string, Readonly<Record<string, Type>>>;

export async function resourceValue(
  instance: ResourceInstance,
  runtime: ValueRuntime,
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
      const target = await runtime.resources.resource(raw);
      value[name] = target ? await resourceValue(target, runtime, types, depth - 1) : null;
    } else if (type.kind === "contribution" && typeof raw === "string" && runtime.contributions) {
      // Un `link` : la contribution du challenge source, lue telle que le vérificateur la connaît.
      value[name] = (await runtime.contributions.find(raw)) ?? null;
    } else {
      value[name] = raw;
    }
  }
  hydrated.add(value);
  return value;
}

/** Une valeur rangeable dans le contexte d'un claim : les ressources y deviennent des références. */
export function serializeValue(value: Value): Value {
  if (isResourceValue(value)) return { $resource: value.id };
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as { [key: string]: Value }).map(([key, item]) => [key, serializeValue(item)]));
  }
  return value;
}

/** L'inverse : chaque référence est relue et hydratée. Une ressource disparue revient à `null`. */
export async function deserializeValue(value: Value, runtime: ValueRuntime, types: ResourceTypes): Promise<Value> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => deserializeValue(item, runtime, types)));
  if (value !== null && typeof value === "object") {
    if (typeof value.$resource === "string" && Object.keys(value).length === 1) {
      const instance = await runtime.resources.resource(value.$resource);
      return instance ? resourceValue(instance, runtime, types) : null;
    }
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, item]) => [key, await deserializeValue(item, runtime, types)] as const)
    );
    return Object.fromEntries(entries);
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
  /** Les champs de cette instance accordés au lecteur par un nœud `grant` (le reveal). */
  granted?: readonly string[];
}

/** Les champs qu'un lecteur voit. Un champ sans visibilité déclarée est public ; `[]` n'est lisible par personne. */
export async function project(
  value: { [key: string]: Value },
  decl: ResourceDecl,
  viewer: Viewer
): Promise<{ [key: string]: Value }> {
  const projected: { [key: string]: Value } = { id: value.id };
  for (const [name, field] of Object.entries(decl.fields)) {
    // Sa politique, ou un grant pour ce lecteur.
    const readable = viewer.granted?.includes(name) || (await visible(field.visibility, value, viewer));
    // Une ressource référencée ne sort que par sa référence : ses propres champs ont leur propre visibilité.
    if (readable) projected[name] = serializeReference(value[name] ?? null);
  }
  return projected;
}

function serializeReference(value: Value): Value {
  return isResourceValue(value) ? { id: value.id } : value;
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
