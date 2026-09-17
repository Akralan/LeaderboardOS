import type { ChallengeRepo, Challenge, Contribution } from "../database-service/domain/entities.js";
import { normalizeArtifactUrl } from "./artifact-url.js";

/**
 * Capacité `submissions` — des étapes soumises par URL
 * ----------------------------------------------------
 * Un challenge à étapes (le challenge ML) crée un dépôt par étape, chacun avec
 * son rôle. Un participant soumet l'URL d'une étape :
 *
 * - l'URL vit sous le porteur (en groupe) dans `challenge_repos.workspace_meta.userUrls` ;
 * - l'étape de sélection garde aussi `datasetUrls[porteur]`, l'ensemble des
 *   datasets attachés à la construction d'un modèle (le sien et ceux cochés) ;
 * - la contribution du type de l'étape est créée ou remise `pending`, avec une
 *   description qui rassemble les URLs de ses étapes et, pour une étape
 *   d'artefact, l'`artifact_url` normalisée ;
 * - soumettre fait entrer dans l'équipe (pas de join préalable).
 *
 * Ce qui se passe ensuite (noter, payer) appartient au flow : la capacité rend
 * la soumission à planifier. La lignée (`lineageOf`) dit qui est l'auteur de
 * chaque artefact : le premier à l'avoir soumis sur le challenge.
 *
 * Déplacée du flow ML (`content/flows/ml/actions/workspace.ts`) pour qu'un
 * template la déclare (`submissions`) : les mêmes écritures, les mêmes réponses.
 */

export interface SubmissionStepRule {
  contributionType: string;
  title: string;
  /** L'URL identifie l'artefact : c'est elle qui décide d'une réutilisation. */
  isArtifact: boolean;
}

export type SubmissionTable = Readonly<Record<string, SubmissionStepRule>>;

export interface SubmissionOptions {
  /** L'étape dont le dépôt porte la sélection (`dataset_urls`). */
  selectionRole: string | null;
  /** Le refus d'une soumission de cette étape (un seuil atteint), ou `null`. */
  closed?: (role: string) => Promise<string | null>;
}

/** Ce qu'une soumission acceptée laisse à planifier. */
export interface AcceptedSubmission {
  repoId: string;
  role: string;
  url: string;
}

const repositories = () => import("../database-service/repositories/index.js");

/** `GET workspace` — les dépôts du challenge, avec les URLs soumises par participant. */
export async function readSubmissions(challengeId: string, userId: string) {
  const { ChallengeRepoRepository, UserRepository, ChallengeTeamRepository } = await repositories();
  const { resolveWorkspaceOwner } = await import("./groups.js");
  const repos = await new ChallengeRepoRepository().findByChallengeWithRepo(challengeId);

  const allUserIds = new Set<string>();
  for (const r of repos) {
    const userUrls = (r.workspace_meta as { userUrls?: Record<string, string> } | null)?.userUrls ?? {};
    Object.keys(userUrls).forEach((uid) => allUserIds.add(uid));
  }

  const submitterUsers = await new UserRepository().findByIds([...allUserIds]);
  const usersMap = Object.fromEntries(
    submitterUsers.map((u) => [u.uuid, { fullName: u.full_name, avatarUrl: u.avatar_url ?? undefined }])
  );

  // Le workspace lu par le front est celui du groupe : les URLs vivent sous
  // le porteur, pas sous chaque membre. `currentUserId` reste l'identité de
  // l'appelant, `workspaceOwnerId` la clé de lecture de workspace_meta.
  const workspaceOwnerId = await resolveWorkspaceOwner(challengeId, userId, { challengeTeamRepo: new ChallengeTeamRepository() });

  return {
    currentUserId: userId,
    workspaceOwnerId,
    repos: repos.map((r) => ({
      repo_id: r.repo_id,
      repo_type: r.repo_type,
      repo_external_id: r.repo_external_id,
      role: r.role ?? null,
      workspace_meta: r.workspace_meta ?? {},
    })),
    users: usersMap,
  };
}

/**
 * `PATCH workspace` — enregistre l'URL de l'appelant (ou de son groupe) pour
 * une étape, ou sa sélection de datasets. Une `Response` est un refus ;
 * sinon, le dépôt à jour et la soumission à planifier (`null` quand rien
 * n'est à noter : une URL retirée, une sélection).
 */
export async function submitToStep(
  challenge: Challenge,
  userId: string,
  body: unknown,
  table: SubmissionTable,
  options: SubmissionOptions
): Promise<Response | { repo: ChallengeRepo; submission: AcceptedSubmission | null }> {
  const challengeId = challenge.uuid;
  if (!body || typeof body !== "object") {
    return Response.json({ error: "repo_id is required" }, { status: 400 });
  }
  const { repo_id, workspace_url, dataset_urls } = body as Record<string, any>;

  if (!repo_id || typeof repo_id !== "string") {
    return Response.json({ error: "repo_id is required" }, { status: 400 });
  }
  const hasWorkspaceUrl = Object.prototype.hasOwnProperty.call(body, "workspace_url");
  const hasDatasetUrls = Object.prototype.hasOwnProperty.call(body, "dataset_urls");
  if (!hasWorkspaceUrl && !hasDatasetUrls) {
    return Response.json({ error: "workspace_url or dataset_urls is required" }, { status: 400 });
  }
  if (hasWorkspaceUrl && workspace_url !== null && (typeof workspace_url !== "string" || !workspace_url.trim())) {
    return Response.json({ error: "workspace_url must be a non-empty string or null" }, { status: 400 });
  }
  const isValidDatasetUrls =
    dataset_urls === null ||
    (Array.isArray(dataset_urls) && dataset_urls.every((u) => typeof u === "string" && u.trim()));
  if (hasDatasetUrls && !isValidDatasetUrls) {
    return Response.json({ error: "dataset_urls must be an array of non-empty strings, or null" }, { status: 400 });
  }

  const { ChallengeRepoRepository, ChallengeTeamRepository, ContributionRepository } = await repositories();
  const { resolveWorkspaceOwner } = await import("./groups.js");
  const challengeRepoRepo = new ChallengeRepoRepository();
  const challengeTeamRepo = new ChallengeTeamRepository();
  const contributionRepo = new ContributionRepository();

  const existing = await challengeRepoRepo.findByChallengeAndRepo(challengeId, repo_id);
  if (!existing) {
    return Response.json({ error: "Repo not found for this challenge" }, { status: 404 });
  }
  if (hasDatasetUrls && existing.role !== options.selectionRole) {
    return Response.json({ error: "dataset_urls only applies to dataset repos" }, { status: 400 });
  }

  // Une soumission fermée (un seuil atteint) : seules les vraies soumissions
  // (une workspace_url non nulle) sont refusées ; effacer sa propre URL et
  // cocher un dataset communautaire restent permis.
  if (hasWorkspaceUrl && workspace_url !== null && existing.role && options.closed) {
    const refusal = await options.closed(existing.role);
    if (refusal) return Response.json({ error: refusal }, { status: 403 });
  }

  // Pas de join préalable : soumettre est ce qui fait de quelqu'un un
  // participant. Fait seulement une fois la requête validée, pour qu'un PATCH
  // refusé n'ait aucun effet.
  const existingTeam = await challengeTeamRepo.findByChallenge(challengeId);
  if (!existingTeam.some((m) => m.user_id === userId)) {
    await challengeTeamRepo.create({ challenge_id: challengeId, user_id: userId });
  }

  // Un groupe partage sa vue de progression : les URLs vivent sous le porteur,
  // pas sous chaque membre. Résolu après le join implicite ci-dessus.
  const ownerId = await resolveWorkspaceOwner(challengeId, userId, { challengeTeamRepo });

  let current = existing;

  if (hasWorkspaceUrl) {
    const existingMeta = (current.workspace_meta as Record<string, unknown>) ?? {};
    const existingUserUrls = (existingMeta.userUrls as Record<string, string>) ?? {};
    const previousOwnUrl = existingUserUrls[ownerId];

    // null = retirer l'URL (réinitialiser l'étape)
    const updatedUserUrls = { ...existingUserUrls };
    if (workspace_url === null) {
      delete updatedUserUrls[ownerId];
    } else {
      updatedUserUrls[ownerId] = workspace_url.trim();
    }

    const updatedMeta: Record<string, unknown> = { ...existingMeta, userUrls: updatedUserUrls };

    // Étape de sélection : garder l'ensemble (datasetUrls, lu pour répartir la
    // récompense d'un modèle) aligné sur l'URL propre saisie — remplacer
    // l'ancienne entrée propre, ou la retirer, sans toucher aux datasets
    // communautaires déjà cochés.
    if (existing.role === options.selectionRole) {
      const existingDatasetUrls = (existingMeta.datasetUrls as Record<string, string[]>) ?? {};
      const mySet = new Set(existingDatasetUrls[ownerId] ?? []);
      if (previousOwnUrl) mySet.delete(previousOwnUrl);
      if (workspace_url !== null) mySet.add(workspace_url.trim());

      const updatedDatasetUrls = { ...existingDatasetUrls };
      if (mySet.size > 0) {
        updatedDatasetUrls[ownerId] = [...mySet];
      } else {
        delete updatedDatasetUrls[ownerId];
      }
      // Pas de clé vide quand la multi-sélection n'a jamais servi sur ce repo.
      if (Object.keys(updatedDatasetUrls).length > 0 || "datasetUrls" in existingMeta) {
        updatedMeta.datasetUrls = updatedDatasetUrls;
      }
    }

    current = (await challengeRepoRepo.updateWorkspace(challengeId, repo_id, { workspace_meta: updatedMeta })) ?? current;
  }

  // Étape de sélection seulement — cocher ou décocher un dataset communautaire.
  // Ne touche ni userUrls, ni la contribution, ni l'attribution : seulement la
  // répartition d'une future récompense de modèle.
  if (hasDatasetUrls) {
    const existingMeta = (current.workspace_meta as Record<string, unknown>) ?? {};
    const existingDatasetUrls = (existingMeta.datasetUrls as Record<string, string[]>) ?? {};

    const updatedDatasetUrls = { ...existingDatasetUrls };
    if (dataset_urls === null || dataset_urls.length === 0) {
      delete updatedDatasetUrls[ownerId];
    } else {
      updatedDatasetUrls[ownerId] = [...new Set<string>(dataset_urls.map((u: string) => u.trim()))];
    }

    current = (await challengeRepoRepo.updateWorkspace(challengeId, repo_id, {
      workspace_meta: { ...existingMeta, datasetUrls: updatedDatasetUrls },
    })) ?? current;
  }

  // Crée ou met à jour la contribution de l'étape.
  if (hasWorkspaceUrl && workspace_url !== null && existing.role) {
    const cfg = table[existing.role];
    if (cfg) {
      const url = workspace_url.trim();
      const challengeContribs = await contributionRepo.findByChallenge(challengeId);
      const contribution = challengeContribs.find((c) => c.user_id === ownerId && c.type === cfg.contributionType);

      // La description rassemble tous les dépôts de l'étape : un modèle montre
      // ses liens Kaggle et GitHub sur une seule contribution.
      const allRepos = await challengeRepoRepo.findByChallengeWithRepo(challengeId);
      const stepRepos = allRepos.filter((r) => r.role && table[r.role]?.contributionType === cfg.contributionType);
      const description = stepRepos
        .map((r) => {
          const urls = (r.workspace_meta as { userUrls?: Record<string, string> } | null)?.userUrls ?? {};
          const u = r.repo_id === repo_id ? url : urls[ownerId];
          return u ? `${r.role}: ${u}` : null;
        })
        .filter(Boolean)
        .join("\n");

      const artifactPatch = cfg.isArtifact ? { artifact_url: normalizeArtifactUrl(url) } : {};

      if (contribution) {
        await contributionRepo.update(contribution.uuid, { description, evaluation_status: "pending", ...artifactPatch });
      } else {
        await contributionRepo.create({
          title: cfg.title,
          type: cfg.contributionType,
          description,
          reward: 0,
          user_id: ownerId,
          challenge_id: challengeId,
          submitted_at: new Date(),
          evaluation_status: "pending",
          ...artifactPatch,
        });
      }
      return { repo: current, submission: { repoId: repo_id, role: existing.role, url } };
    }
  }

  return { repo: current, submission: null };
}

/** L'auteur d'un artefact réutilisé : sa personne, sa contribution, le poids de sa part. */
export interface ArtifactAuthor {
  author: string;
  contribution: string;
  weight: number;
}

export interface SubmissionLineage {
  /** Par type de contribution d'artefact : l'auteur premier de l'URL du porteur, quand ce n'est pas lui. */
  artifacts: Record<string, ArtifactAuthor | null>;
  /** Les datasets sélectionnés dont l'auteur premier n'est pas le porteur, chacun pesant `1/N` de la sélection. */
  selection: ArtifactAuthor[];
}

type LineageContribution = Pick<Contribution, "uuid" | "user_id" | "type" | "artifact_url" | "submitted_at">;

/**
 * Qui est l'auteur de quoi, pour un porteur. Sur un même challenge, un
 * artefact appartient à qui l'a soumis en premier (date, puis uuid) ; coller
 * la même URL après lui est une réutilisation. La lecture du flow ML
 * (`services/challenge/lineage.ts`), étendue à tous les types d'artefact.
 */
export function lineageFrom(
  contributions: readonly LineageContribution[],
  holderId: string,
  table: SubmissionTable,
  selection: { contributionType: string; urls: readonly string[] } | null
): SubmissionLineage {
  const firstAuthor = (type: string, url: string) =>
    contributions.filter((c) => c.type === type && c.artifact_url === url).sort(byFirstSubmitted)[0];

  const artifacts: Record<string, ArtifactAuthor | null> = {};
  for (const type of new Set(Object.values(table).filter((step) => step.isArtifact).map((step) => step.contributionType))) {
    const mine = contributions.find((c) => c.user_id === holderId && c.type === type);
    const author = mine?.artifact_url ? firstAuthor(type, mine.artifact_url) : undefined;
    artifacts[type] = author && author.user_id !== holderId ? { author: author.user_id, contribution: author.uuid, weight: 1 } : null;
  }

  const chosen: ArtifactAuthor[] = [];
  const urls = [...new Set(selection?.urls ?? [])];
  if (selection && urls.length > 0) {
    const weight = 1 / urls.length;
    for (const url of urls) {
      const author = firstAuthor(selection.contributionType, url);
      if (author && author.user_id !== holderId) chosen.push({ author: author.user_id, contribution: author.uuid, weight });
    }
  }
  return { artifacts, selection: chosen };
}

/** La lignée d'un porteur, lue en base : ses contributions et la sélection de l'étape qui la porte. */
export async function lineageOf(challengeId: string, holderId: string, table: SubmissionTable, selectionRole: string | null): Promise<SubmissionLineage> {
  const { ChallengeRepoRepository, ContributionRepository } = await repositories();
  const contributions = await new ContributionRepository().findByChallenge(challengeId);
  const selectionStep = selectionRole ? table[selectionRole] : undefined;
  let selection: { contributionType: string; urls: string[] } | null = null;
  if (selectionRole && selectionStep) {
    // workspace_meta.datasetUrls garde les URLs brutes ; normalisées ici pour
    // correspondre à contribution.artifact_url, normalisée à la soumission.
    const repos = await new ChallengeRepoRepository().findByChallengeAndRole(challengeId, selectionRole as never);
    const urls = repos
      .flatMap((repo) => (repo.workspace_meta as { datasetUrls?: Record<string, string[]> } | undefined)?.datasetUrls?.[holderId] ?? [])
      .map((url) => normalizeArtifactUrl(url))
      .filter((url): url is string => Boolean(url));
    selection = { contributionType: selectionStep.contributionType, urls };
  }
  return lineageFrom(contributions, holderId, table, selection);
}

/** Départage par date de soumission, puis par uuid : sans ordre total, le premier auteur changerait d'un appel à l'autre. */
function byFirstSubmitted(a: LineageContribution, b: LineageContribution): number {
  const diff = a.submitted_at.getTime() - b.submitted_at.getTime();
  return diff !== 0 ? diff : a.uuid.localeCompare(b.uuid);
}
