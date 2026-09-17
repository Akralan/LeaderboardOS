import type { ChallengeGroupJoinContext, ChallengeJoinContext, RepoDefinition } from "../registry/platform.js";
import type { Challenge } from "../database-service/domain/entities.js";

/**
 * Capacité `workspaces` — où un participant livre son code
 * --------------------------------------------------------
 * Deux modes, venus du challenge code :
 * - `provided_repo` : le dépôt GitHub du challenge, créé à sa création ; chaque
 *   participant (le porteur, pour un groupe) y reçoit une branche perso,
 *   protégée pour lui, reprotégée pour tout le groupe quand un membre arrive ;
 * - `own_repo` : chacun déclare l'URL de son propre dépôt GitHub public.
 *
 * Tout s'écrit sur les colonnes `workspace_*` de `challenge_teams`. Un flow
 * écrit à la main et un template compilé (bloc `workspace`) passent par ici :
 * les mêmes lignes, les mêmes refus.
 */

export type WorkspaceMode = "provided_repo" | "own_repo";

/** Le mode lu d'une valeur de configuration : le mode historique quand elle ne se lit pas. */
export function workspaceModeOf(value: unknown): WorkspaceMode {
  return value === "own_repo" ? "own_repo" : "provided_repo";
}

/** `owner/repo`, depuis une URL GitHub ou un slug déjà nu. */
export function parseGithubSlug(input: unknown): string | undefined {
  if (typeof input !== "string" || !input) return undefined;
  const match = input.match(/github\.com\/([^/?#]+\/[^/?#]+)/);
  if (match) return match[1].replace(/\.git$/, "");
  if (/^[^/]+\/[^/]+$/.test(input)) return input;
  return undefined;
}

/**
 * Les dépôts d'un challenge à sa création : un seul, partagé, sur lequel chaque
 * participant reçoit sa branche. En `own_repo`, aucun. `github_repo` est l'URL
 * ou le slug saisi par le créateur.
 */
export function workspaceCreationRepos(challenge: Pick<Challenge, "title">, input: Readonly<Record<string, unknown>>, mode: WorkspaceMode): RepoDefinition[] {
  if (mode === "own_repo") return [];
  return [{ title: `${challenge.title} — Code`, type: "github", external_repo_id: parseGithubSlug(input.github_repo) }];
}

async function repositories() {
  return import("../database-service/repositories/index.js");
}

async function sharedCodeRepo(challengeId: string) {
  const { ChallengeRepoRepository } = await repositories();
  const repos = await new ChallengeRepoRepository().findByChallengeWithRepo(challengeId);
  return repos.find((r) => r.repo_type === "github" && r.repo_external_id);
}

/**
 * Au join d'un participant solo ou d'un créateur de groupe. En `own_repo`, il
 * déclarera son propre dépôt. Sinon sa branche perso est créée sur le dépôt du
 * challenge et protégée pour lui ; un échec de provisioning marque le
 * workspace `failed` sans faire échouer le join.
 */
export async function provisionWorkspace({ challenge, userId }: ChallengeJoinContext, mode: WorkspaceMode): Promise<void> {
  const { ChallengeTeamRepository, UserRepository } = await repositories();
  const challengeTeamRepo = new ChallengeTeamRepository();
  const challengeId = challenge.uuid;
  if (mode === "own_repo") {
    await challengeTeamRepo.updateWorkspace(challengeId, userId, { workspace_provider: "external" });
    return;
  }

  await challengeTeamRepo.updateWorkspace(challengeId, userId, { workspace_provider: "github", workspace_status: "pending" });
  const codeRepo = await sharedCodeRepo(challengeId);
  if (!codeRepo) {
    await challengeTeamRepo.updateWorkspace(challengeId, userId, { workspace_status: "failed" });
    return;
  }

  const { mapRepoTypeToWorkspaceType, provisionContributorWorkspace, ProvisionerRegistry } = await import("../provisioner/src/index.js");
  const user = await new UserRepository().findById(userId);
  try {
    const result = await provisionContributorWorkspace({
      challengeIndex: challenge.index ?? 0,
      username: user?.github_username || user?.full_name || userId,
      repoExternalId: codeRepo.repo_external_id!,
      repoType: codeRepo.repo_type,
      challengeBranchRef: codeRepo.workspace_ref,
    });
    await challengeTeamRepo.updateWorkspace(challengeId, userId, {
      workspace_ref: result.ref,
      workspace_url: result.url,
      workspace_status: result.status,
    });
    if (result.status === "ready" && result.ref && user?.github_username) {
      try {
        const provider = ProvisionerRegistry.getProvider(mapRepoTypeToWorkspaceType(codeRepo.repo_type));
        if (provider.protect) {
          await provider.protect(codeRepo.repo_external_id!, result.ref, [user.github_username]);
        }
      } catch (protectError) {
        console.warn("[workspaces] Workspace protection failed:", protectError);
      }
    }
  } catch (provisionError) {
    console.error("[workspaces] Provisioning failed:", provisionError);
    await challengeTeamRepo.updateWorkspace(challengeId, userId, { workspace_status: "failed" });
  }
}

/**
 * À l'arrivée d'un membre dans un groupe : la branche du porteur se rouvre à
 * tous les membres. Rapporte les membres sans compte GitHub, qui resteront
 * bloqués.
 */
export async function reprotectGroupBranch({ challenge, groupId }: ChallengeGroupJoinContext): Promise<{ missingGithub: string[] }> {
  const { ChallengeTeamRepository, UserRepository } = await repositories();
  const { pickGroupOwner } = await import("./groups.js");
  const challengeId = challenge.uuid;
  const members = await new ChallengeTeamRepository().findByGroup(challengeId, groupId);
  const owner = members.find((m) => m.user_id === pickGroupOwner(members));
  if (!owner?.workspace_ref) return { missingGithub: [] };

  const codeRepo = await sharedCodeRepo(challengeId);
  if (!codeRepo) return { missingGithub: [] };

  const userRepo = new UserRepository();
  const users = await Promise.all(members.map((m) => userRepo.findById(m.user_id)));
  const usernames = users.map((u) => u?.github_username).filter((n): n is string => !!n);
  const missingGithub = users.filter((u) => u && !u.github_username).map((u) => u!.full_name);

  if (usernames.length > 0) {
    try {
      const { mapRepoTypeToWorkspaceType, ProvisionerRegistry } = await import("../provisioner/src/index.js");
      const provider = ProvisionerRegistry.getProvider(mapRepoTypeToWorkspaceType(codeRepo.repo_type));
      if (provider.protect) {
        await provider.protect(codeRepo.repo_external_id!, owner.workspace_ref, usernames);
      }
    } catch (error) {
      // Non bloquant : l'appartenance au groupe compte plus que l'ACL Git.
      console.warn("[workspaces] Group branch re-protection failed:", error);
    }
  }
  return { missingGithub };
}

export const OWN_REPO_URL = /^https:\/\/github\.com\/[^/?#]+\/[^/?#]+/;

/**
 * `PATCH workspace` en `own_repo` : le participant déclare (ou change) l'URL du
 * dépôt GitHub public qui porte son livrable, sur la participation du porteur.
 */
export async function setOwnRepo(challengeId: string, userId: string, body: unknown, mode: WorkspaceMode): Promise<Response | { participation: unknown }> {
  if (mode !== "own_repo") {
    return Response.json({ error: "This challenge does not accept contributor repos" }, { status: 400 });
  }
  const raw = body && typeof body === "object" ? (body as { repo_url?: unknown }).repo_url : undefined;
  const repoUrl = typeof raw === "string" ? raw.trim() : "";
  if (!OWN_REPO_URL.test(repoUrl)) {
    return Response.json({ error: typeof raw === "string" ? "repo_url must be a public GitHub repository URL" : "Invalid input: expected string, received undefined" }, { status: 400 });
  }
  const { ChallengeTeamRepository } = await repositories();
  const { resolveWorkspaceOwner } = await import("./groups.js");
  const challengeTeamRepo = new ChallengeTeamRepository();
  const ownerId = await resolveWorkspaceOwner(challengeId, userId, { challengeTeamRepo });
  const participation = await challengeTeamRepo.updateWorkspace(challengeId, ownerId, {
    workspace_provider: "external",
    workspace_url: repoUrl,
    workspace_status: "ready",
  });
  return { participation };
}
