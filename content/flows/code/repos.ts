import type { ChallengeCreateContext, RepoDefinition } from "../../../packages/registry/platform.js";
import { workspaceCreationRepos } from "../../../packages/capabilities/workspaces.js";
import { codeConfigOf } from "./config.js";

export { parseGithubSlug } from "../../../packages/capabilities/workspaces.js";

/**
 * Les dépôts d'un challenge code, à sa création : un seul, partagé, sur lequel
 * chaque participant reçoit sa branche. En `own_repo`, aucun : chacun apporte
 * le sien. `github_repo` est l'URL ou le slug saisi par le créateur.
 */
export function codeCreationRepos({ challenge, input }: ChallengeCreateContext): { repos: RepoDefinition[] } {
  return { repos: workspaceCreationRepos(challenge, input, codeConfigOf(challenge).workspace_mode) };
}
