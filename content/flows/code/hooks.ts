import type { ChallengeGroupJoinContext, ChallengeJoinContext } from "../../../packages/registry/platform.js";
import { provisionWorkspace as provision, reprotectGroupBranch as reprotect } from "../../../packages/capabilities/workspaces.js";
import { codeConfigOf } from "./config.js";

/**
 * Hooks de join du flow code : le workspace de chaque participant, servi par la
 * capacité `workspaces` du core (que le template `code` utilise aussi).
 * Chargés à la demande par `index.ts`, pour que déclarer le flow ne charge pas
 * le provisioner.
 */

export function provisionWorkspace(ctx: ChallengeJoinContext): Promise<void> {
  return provision(ctx, codeConfigOf(ctx.challenge).workspace_mode);
}

export function reprotectGroupBranch(ctx: ChallengeGroupJoinContext): Promise<{ missingGithub: string[] }> {
  return reprotect(ctx);
}
