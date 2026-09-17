import type { ActionContext } from "../../../../packages/registry/platform.js";
import { RewardEntryRepository } from "../../../../packages/database-service/repositories/index.js";
import { parseMlRewardRules } from "../../../../packages/database-service/domain/mlRewardRules.js";
import { ML_ROLE_RULE } from "../../../../packages/services/challenge/mlRoles.js";
import { readSubmissions, submitToStep, type SubmissionTable } from "../../../../packages/capabilities/submissions.js";

/** Rôles fermés une fois le seuil de métrique du challenge atteint. */
const BLOCKABLE_ROLES = ["dataset", "model", "model_code"];

/*
 * Rôle du repo → contribution qu'il alimente : `ML_ROLE_RULE`, la table
 * partagée du flux ML, que la capacité `submissions` lit.
 *
 * L'étape modèle a deux repos (Kaggle + GitHub) mais une seule contribution :
 * les deux notes s'additionnent sur la même ligne, jusqu'à `model.cap`.
 */
const ML_SUBMISSION_TABLE: SubmissionTable = ML_ROLE_RULE;

const rewardRepo = new RewardEntryRepository();

/** `GET workspace` — les repos du challenge, avec les URLs soumises par participant. */
export async function readWorkspace({ challenge, user }: ActionContext) {
  return readSubmissions(challenge.uuid, user.id);
}

/** `PATCH workspace` — enregistre l'URL de l'appelant (ou de son groupe) pour une étape. */
export async function submitWorkspace({ request, challenge, user }: ActionContext) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const result = await submitToStep(challenge, user.id, body, ML_SUBMISSION_TABLE, {
    selectionRole: "dataset",
    // Une fois le seuil de métrique atteint, les soumissions dataset/modèle se
    // ferment — seul le packaging d'API reste ouvert.
    async closed(role) {
      if (!BLOCKABLE_ROLES.includes(role)) return null;
      const threshold = parseMlRewardRules(challenge.reward_rules)?.model.metric.blockThreshold;
      if (threshold == null) return null;
      const best = await rewardRepo.maxMetaNumber(challenge.uuid, { ruleKey: "model_metric", field: "metricValue" });
      return best != null && best >= threshold
        ? "Metric threshold reached - dataset and model submissions are closed, only API packaging is accepted"
        : null;
    },
  });
  if (result instanceof Response) return result;

  // Les points s'attribuent au fil de l'eau, mais l'appel à l'agent prend
  // des dizaines de secondes : la progression vit sur evaluation_status.
  if (result.submission) {
    const { MlRewardsService } = await import("../../../../packages/services/challenge/ml-rewards.service.js");
    new MlRewardsService().scheduleAward({
      challengeId: challenge.uuid,
      userId: user.id, // le service re-résout le porteur lui-même
      repoId: result.submission.repoId,
      url: result.submission.url,
    });
  }
  return { repo: result.repo };
}
