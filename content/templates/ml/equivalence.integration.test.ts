import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Challenge } from "../../../packages/database-service/domain/entities.js";
import {
  ChallengeRepoRepository,
  ChallengeRepository,
  ChallengeTeamRepository,
  ContributionMemberRepository,
  ContributionRepository,
  RepoRepository,
  RewardEntryRepository,
} from "../../../packages/database-service/repositories/index.js";
import { DEFAULT_ML_REWARD_RULES } from "../../../packages/database-service/domain/mlRewardRules.js";
import { integrationScope } from "../../../packages/database-service/testing/integration.js";
import { dispatchChallengeAction } from "../../../packages/capabilities/challenge-actions.js";
import { submitToStep } from "../../../packages/capabilities/submissions.js";
import { PlatformRegistry } from "../../../packages/registry/platform.js";
import { defaultRuntime } from "../../../packages/interpreter/compile/runtime.js";
import { MlRewardsService } from "../../../packages/services/challenge/ml-rewards.service.js";
import { ML_ROLE_RULE } from "../../../packages/services/challenge/mlRoles.js";
import { mlCreationRepos } from "../../flows/ml/repos.js";
import { compileMlFlow } from "./index.js";

/**
 * Parité P5 sur Postgres — le flow écrit à la main contre le template
 * -------------------------------------------------------------------
 * Deux challenges ML identiques, les mêmes dépôts d'étape, les mêmes
 * soumissions dans le même ordre (un dataset, sa réutilisation, deux modèles
 * sur les datasets d'une autre, un groupe, un seuil qui ferme les soumissions) :
 * l'un par `submitToStep` puis `MlRewardsService.award`, l'autre par
 * `PATCH workspace` sur le template compilé. Seuls l'agent et la carte Kaggle
 * sont remplacés, par les mêmes valeurs des deux côtés. Ledger, contributions,
 * parts, complétion, `workspace_meta` et équipes sont les mêmes.
 */

const scope = integrationScope();
const RULES = { ...DEFAULT_ML_REWARD_RULES, model: { ...DEFAULT_ML_REWARD_RULES.model, metric: { name: "auc" as const, baseline: 0.5, blockThreshold: 0.9 } } };
const DS_A = "https://www.kaggle.com/datasets/alice/knee-mri";
const MODEL_B = "https://www.kaggle.com/models/bob/knee-net";
const scheduled: (() => Promise<void>)[] = [];
const measures = new Map<string, number>();
let users: Record<string, string>;
let handwritten: Challenge;
let templated: Challenge;
const repoIds = new Map<string, Record<string, string>>();

/** La valeur d'une URL : la note de l'agent, ou la métrique de la carte. */
const measureOf = (url: string) => {
  const value = measures.get(url);
  if (value === undefined) throw new Error(`no measure for ${url}`);
  return value;
};

async function seed(challenge: Challenge) {
  const { repos } = mlCreationRepos({ challenge, input: {} });
  const ids: Record<string, string> = {};
  for (const definition of repos) {
    const repo = await new RepoRepository().create({ title: definition.title, type: definition.type, project_id: challenge.project_id } as never);
    await new ChallengeRepoRepository().create({ challenge_id: challenge.uuid, repo_id: repo.uuid, role: definition.role } as never);
    ids[definition.role!] = repo.uuid;
  }
  repoIds.set(challenge.uuid, ids);
  // Un groupe : Dan porte, Erin contribue.
  const teams = new ChallengeTeamRepository();
  const group = crypto.randomUUID();
  await teams.create({ challenge_id: challenge.uuid, user_id: users.dan, group_id: group } as never);
  await teams.create({ challenge_id: challenge.uuid, user_id: users.erin, group_id: group } as never);
}

beforeAll(async () => {
  users = await scope.users(["alice", "bob", "carol", "dan", "erin"]);
  handwritten = await scope.challenge({ type: "ml", pool: 2000, flowConfig: {}, rewardRules: RULES });
  templated = await scope.challenge({ type: "ml", pool: 2000, flowConfig: {}, rewardRules: RULES });
  await seed(handwritten);
  await seed(templated);

  const runtime = defaultRuntime({
    evaluate: async (request) => {
      const url = String(request.inputs[0]);
      const score = measureOf(url);
      const evaluation = { scores: [], globalScore: score * 9 };
      return { score, evaluation };
    },
    observe: async (capability, args) => {
      if (capability !== "kaggle_metadata") throw new Error(capability);
      return { metrics: { auc: measureOf(String(args.url)), f1: 0, accuracy: 0 } };
    },
    challengesOf: async () => [await new ChallengeRepository().findById(templated.uuid)].filter((c): c is Challenge => c !== null),
  });
  runtime.evaluations = { ...runtime.evaluations, schedule: (task) => void scheduled.push(task) };
  PlatformRegistry.reset();
  PlatformRegistry.install({ flows: [compileMlFlow(runtime)] });
});

afterAll(async () => {
  PlatformRegistry.reset();
  await scope.cleanup();
});

const service = new MlRewardsService({
  readMetric: async (url) => measureOf(url),
  runAgent: async ({ url, contribution }) => {
    const score = measureOf(url);
    // Ce que l'agent par défaut écrit sur la contribution, avant de rendre la note.
    await new ContributionRepository().update(contribution.uuid, { evaluation: { scores: [], globalScore: score * 9 } as never });
    return score;
  },
});

/** Le flow écrit à la main : la capacité qu'il appelle, puis l'attribution. */
async function patchHandwritten(user: string, body: Record<string, unknown>) {
  const challenge = (await new ChallengeRepository().findById(handwritten.uuid))!;
  const threshold = RULES.model.metric.blockThreshold;
  const result = await submitToStep(challenge, user, body, ML_ROLE_RULE, {
    selectionRole: "dataset",
    async closed(role) {
      if (!["dataset", "model", "model_code"].includes(role)) return null;
      const best = await new RewardEntryRepository().maxMetaNumber(challenge.uuid, { ruleKey: "model_metric", field: "metricValue" });
      return best != null && best >= threshold ? "Metric threshold reached - dataset and model submissions are closed, only API packaging is accepted" : null;
    },
  });
  if (result instanceof Response) return result.status;
  // Une note qui échoue marque la contribution `failed`, comme le run planifié du flow.
  if (result.submission) await service.award({ challengeId: challenge.uuid, userId: user, repoId: result.submission.repoId, url: result.submission.url }).catch(() => undefined);
  return 200;
}

/** Le template : le geste, puis la soumission planifiée. */
async function patchTemplated(user: string, body: Record<string, unknown>) {
  const response = await dispatchChallengeAction(
    {
      request: new Request(`http://localhost/api/challenges/${templated.uuid}/flow/workspace`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      challengeId: templated.uuid,
      scope: { kind: "flow" },
      segments: ["workspace"],
      user: { id: user, role: "contributor" },
    },
    {
      findChallenge: async () => (await new ChallengeRepository().findById(templated.uuid))!,
      isManager: async () => false,
      isMember: async () => false,
      holds: async () => false,
    }
  );
  while (scheduled.length) await scheduled.shift()!().catch(() => undefined);
  return response.status;
}

/** La même soumission des deux côtés : les identifiants de dépôt de chacun. */
async function both(user: string, role: string, body: Record<string, unknown>) {
  const hand = await patchHandwritten(user, { repo_id: repoIds.get(handwritten.uuid)![role], ...body });
  const templ = await patchTemplated(user, { repo_id: repoIds.get(templated.uuid)![role], ...body });
  expect(templ).toBe(hand);
  return hand;
}

async function snapshot(challenge: Challenge) {
  const contributions = await new ContributionRepository().findByChallenge(challenge.uuid);
  const contributionKey = new Map(contributions.map((row) => [row.uuid, `${row.user_id}:${row.type}`]));
  const entries = await new RewardEntryRepository().findByChallenge(challenge.uuid);
  const shares = await new ContributionMemberRepository().findByContributions(contributions.map((row) => row.uuid));
  const repos = await new ChallengeRepoRepository().findByChallengeWithRepo(challenge.uuid);
  const teams = await new ChallengeTeamRepository().findByChallenge(challenge.uuid);
  const fresh = await new ChallengeRepository().findById(challenge.uuid);
  const key = (value: unknown) => JSON.stringify(value);
  return {
    ledger: entries
      .map((row) => ({ user: row.user_id, contribution: contributionKey.get(row.contribution_id ?? ""), rule_key: row.rule_key, points: row.points, source: row.source_user_id ?? null, meta: row.meta }))
      .sort((a, b) => key(a).localeCompare(key(b))),
    contributions: contributions
      .map((row) => ({ user: row.user_id, type: row.type, title: row.title, description: row.description, artifact: row.artifact_url, status: row.evaluation_status, evaluation: row.evaluation, reward: row.reward }))
      .sort((a, b) => key(a).localeCompare(key(b))),
    shares: shares.map((row) => ({ contribution: contributionKey.get(row.contribution_id), user: row.user_id, share: Number(row.share_cp) })).sort((a, b) => key(a).localeCompare(key(b))),
    repos: repos.map((row) => ({ role: row.role, title: row.repo_title.replace(challenge.title, "<title>"), meta: row.workspace_meta ?? null })).sort((a, b) => String(a.role).localeCompare(String(b.role))),
    teams: teams.map((row) => row.user_id).sort(),
    completion: fresh?.completion,
  };
}

describe("the ml template and the ml flow, side by side on Postgres (template parity P5)", () => {
  it("write the same submissions, ledger, contributions, shares and completion", async () => {
    measures.set(DS_A, 0.7);
    measures.set(MODEL_B, 0.8);
    measures.set("https://github.com/dan/knee-code", 0.6);
    measures.set("https://www.kaggle.com/models/carol/knee-best", 0.95);

    expect(await both(users.alice, "dataset", { workspace_url: DS_A })).toBe(200);
    // Bob colle le dataset d'Alice, puis le coche pour son modèle.
    expect(await both(users.bob, "dataset", { workspace_url: `${DS_A}/` })).toBe(200);
    expect(await both(users.bob, "dataset", { dataset_urls: [DS_A] })).toBe(200);
    expect(await both(users.bob, "model", { workspace_url: MODEL_B })).toBe(200);
    // Carol réutilise le modèle de Bob, sur le dataset d'Alice.
    expect(await both(users.carol, "dataset", { dataset_urls: [DS_A] })).toBe(200);
    expect(await both(users.carol, "model", { workspace_url: MODEL_B })).toBe(200);
    // Le groupe de Dan : Erin soumet le code, sur le dataset d'Alice.
    expect(await both(users.erin, "dataset", { dataset_urls: [DS_A] })).toBe(200);
    expect(await both(users.erin, "model_code", { workspace_url: "https://github.com/dan/knee-code" })).toBe(200);
    // Carol dépasse le seuil : les soumissions de dataset et de modèle se ferment, pas l'API.
    expect(await both(users.carol, "model", { workspace_url: "https://www.kaggle.com/models/carol/knee-best" })).toBe(200);
    expect(await both(users.alice, "dataset", { workspace_url: DS_A })).toBe(403);
    expect(await both(users.alice, "dataset", { workspace_url: null })).toBe(200);
    expect(await both(users.alice, "api", { workspace_url: "unscored" })).toBe(200);
    // Les refus de forme.
    expect(await both(users.alice, "api", {})).toBe(400);
    expect(await both(users.alice, "model", { dataset_urls: [DS_A] })).toBe(400);

    const hand = await snapshot(handwritten);
    const templ = await snapshot(templated);
    expect(templ).toEqual(hand);
    expect(hand.ledger.map((row) => row.rule_key)).toEqual(expect.arrayContaining(["dataset", "model_metric", "beat_best", "reuse_dataset", "reuse_model", "model_code"]));
    expect(hand.contributions.find((row) => row.user === users.bob && row.type === "dataset")?.status).toBe("skipped_reuse");
    expect(hand.shares.length).toBeGreaterThan(0);
  });
});
