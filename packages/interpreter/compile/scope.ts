import type { ExprSource } from "../format/schema.js";

/**
 * Le scope d'un claim désigné, lu depuis les autres champs d'un geste : pour
 * `scope: {target: pick.target}` et le champ `pick.case`, la valeur de
 * `pick.target` vient du paramètre `target` de la requête. `null` quand une
 * dimension ne se lit pas ainsi : le picker ne filtre alors rien.
 */
export function scopeKeyOfFields(
  scope: Readonly<Record<string, ExprSource>>,
  gestureId: string,
  query: URLSearchParams
): Record<string, string> | null {
  const values: Record<string, string> = {};
  for (const [dimension, source] of Object.entries(scope)) {
    const match = new RegExp(`^\\s*${gestureId}\\.([a-z][a-z0-9_]*)\\s*$`).exec(String(source));
    const value = match ? query.get(match[1]) : null;
    if (!value) return null;
    values[dimension] = value;
  }
  return values;
}
