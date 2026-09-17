import type { ActionContext } from "../../../../packages/registry/platform.js";
import { setOwnRepo as declareOwnRepo } from "../../../../packages/capabilities/workspaces.js";
import { codeConfigOf } from "../config.js";

/**
 * `PATCH workspace` — mode `own_repo` : le participant déclare (ou change)
 * l'URL du dépôt GitHub public qui porte son livrable. Réservé aux membres
 * (accès déclaré dans `index.ts`) ; servi par la capacité `workspaces`.
 */
export async function setOwnRepo({ request, challenge, user }: ActionContext) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    raw = null;
  }
  return declareOwnRepo(challenge.uuid, user.id, raw, codeConfigOf(challenge).workspace_mode);
}
