import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Challenge } from "../../../packages/database-service/domain/entities.js";
import { DEFAULT_ML_REWARD_RULES, type MlRewardRules } from "../../../packages/database-service/domain/mlRewardRules.js";
import { groupMultiplier } from "../../../packages/database-service/domain/groupPolicy.js";
import { splitShares } from "../../../packages/database-service/domain/share.js";
import { resolveLineage } from "../../../packages/services/challenge/lineage.js";
import { ML_ROLE_RULE } from "../../../packages/services/challenge/mlRoles.js";
import { PlatformRegistry } from "../../../packages/registry/platform.js";
import { memoryRuntime, type MemoryRuntime } from "../../../packages/interpreter/testing/memory-runtime.js";
import { computeMlAward } from "../../flows/ml/reward.js";
import { mlFlow } from "../../flows/ml/index.js";
import { compileMlFlow } from "./index.js";

/**
 * Parité P5 — le template `ml` contre le flow écrit à la main
 * -----------------------------------------------------------
 * Soumission après soumission, les lignes que le template écrit sont celles
 * que `computeMlAward` aurait produites sur le même ledger : la lignée de
 * `resolveLineage`, la meilleure métrique des autres et la sienne, le bonus de
 * groupe, le reliquat du pool. Les parts d'un groupe sont celles de
 * `splitShares`. Les écritures Postgres (dépôts, contributions, statuts) sont
 * comparées dans `equivalence.integration.test.ts`.
 */

const CHALLENGE = "77777777-7777-4777-8777-777777777777";
const REPOS = { dataset: "repo-dataset", model: "repo-model", model_code: "repo-code", api: "repo-api" } as const;
type Role = keyof typeof REPOS;

afterAll(() => PlatformRegistry.reset());

describe("the ml template, submission for submission against the ml flow", () => {
  let runtime: MemoryRuntime;
  let challenge: Challenge;
  const scores: number[] = [];
  const metrics: number[] = [];
  let clock = 0;

  beforeEach(() => {
    scores.length = 0;
    metrics.length = 0;
    clock = 0;
    runtime = memoryRuntime({
      evaluate: async () => {
        const score = scores.shift() ?? 0;
        return { score, evaluation: { scores: [], globalScore: score * 9 } };
      },
      observe: async (capability) => {
        if (capability !== "kaggle_metadata") throw new Error(capability);
        return { metrics: { auc: metrics.shift() ?? 0, f1: 0, accuracy: 0 } };
      },
    });
    challenge = rulesChallenge(DEFAULT_ML_REWARD_RULES, 10_000);
    runtime.challenges.push(challenge);
    for (const [role, repo] of Object.entries(REPOS)) runtime.stepRepos.push({ challenge_id: CHALLENGE, repo_id: repo, role, selections: {} });
    PlatformRegistry.reset();
    PlatformRegistry.install({ flows: [compileMlFlow(runtime)] });
  });

  function rulesChallenge(rules: MlRewardRules, pool: number): Challenge {
    return {
      uuid: CHALLENGE,
      title: "Knee MRI",
      slug: "knee-mri",
      status: "active",
      type: "ml",
      contribution_points_reward: pool,
      completion: 0,
      flow_config: { extensions: { compute: { enabled: false } } },
      flow_config_version: 1,
      reward_rules: rules,
      created_at: new Date(),
    } as Challenge;
  }

  const setRules = (rules: MlRewardRules, pool = challenge.contribution_points_reward) => {
    Object.assign(challenge, rulesChallenge(rules, pool));
  };

  /** Ce que `PATCH workspace` aurait écrit : la contribution de l'étape du porteur, son artefact. */
  function submitted(holder: string, role: Role, url: string) {
    const rule = ML_ROLE_RULE[role];
    let row = runtime.stepContributions.find((candidate) => candidate.user_id === holder && candidate.type === rule.contributionType);
    if (!row) {
      row = { uuid: `c-${holder}-${rule.contributionType}`, challenge_id: CHALLENGE, user_id: holder, type: rule.contributionType, title: rule.title, description: null, submitted_at: new Date(Date.UTC(2026, 8, 17, 12, 0, clock++)) };
      runtime.stepContributions.push(row);
    }
    if (rule.isArtifact) row.artifact_url = url;
    return row.uuid;
  }

  const select = (holder: string, urls: string[]) => {
    runtime.stepRepos.find((repo) => repo.role === "dataset")!.selections![holder] = urls;
  };

  const group = (holder: string, members: string[]) => {
    for (const user of [holder, ...members]) {
      runtime.teams.push({ challenge_id: CHALLENGE, user_id: user, group_id: `group-${holder}`, workspace_provider: user === holder ? "external" : null, workspace_url: user === holder ? "https://github.com/x/y" : null });
    }
  };

  const rows = () => runtime.ledgerRows.map((row) => ({ user_id: row.user_id, contribution_id: row.contribution_id, rule_key: row.rule_key, points: row.points, source_user_id: row.source_user_id, meta: row.meta }));

  /** Joue la soumission par le handler du template, et rend ce que le flow écrit à la main aurait écrit avant elle. */
  async function submit(caller: string, holder: string, role: Role, url: string, measure: number, members = 1) {
    const contributionId = submitted(holder, role, url);
    const rules = challenge.reward_rules as MlRewardRules;
    const metric = (user: string, mine: boolean) => {
      const values = runtime.ledgerRows.filter((row) => row.rule_key === "model_metric" && (mine ? row.user_id === user : row.user_id !== user)).map((row) => Number(row.meta?.metricValue));
      return values.length ? Math.max(...values) : null;
    };
    const selection = runtime.stepRepos.find((repo) => repo.role === "dataset")!.selections![holder];
    const lineage = resolveLineage(runtime.stepContributions as never, holder, selection);
    const reused = role === "dataset" && lineage.datasetAuthorId && lineage.datasetAuthorId !== holder;
    const distributed = runtime.ledgerRows.reduce((sum, row) => sum + row.points, 0);
    const want = reused
      ? []
      : computeMlAward({
          rule: ML_ROLE_RULE[role].rule,
          rules,
          challengeId: CHALLENGE,
          userId: holder,
          contributionId,
          remainingPool: Math.max(0, challenge.contribution_points_reward - distributed),
          bestOtherMetricValue: metric(holder, false),
          myBestMetricValue: metric(holder, true),
          lineage,
          groupMultiplier: groupMultiplier(members),
          ...(role === "model" ? { metricValue: measure } : { agentScore: measure }),
        }).map((draft) => ({ user_id: draft.user_id, contribution_id: draft.contribution_id, rule_key: draft.rule_key, points: draft.points, source_user_id: draft.source_user_id, meta: draft.meta }));

    if (role === "model") metrics.push(measure);
    else if (!reused) scores.push(measure);
    const before = runtime.ledgerRows.length;
    const outcome = await PlatformRegistry.flow("ml")!.evaluationHandlers![0].retry({ challengeId: CHALLENGE, userId: caller, repoId: REPOS[role], url });
    expect(outcome).toEqual({ ok: true });
    await runtime.evaluations.settle();
    expect(runtime.evaluations.errors).toEqual([]);
    return { written: rows().slice(before), want, contributionId };
  }

  it("declares what the ml flow declares", () => {
    const compiled = PlatformRegistry.flow("ml")!;
    const byKey = (keys: { key: string; consumesPool: boolean; label?: string }[] = []) => [...keys].sort((a, b) => a.key.localeCompare(b.key)).map((key) => [key.key, key.consumesPool, key.label]);
    expect(byKey(compiled.ruleKeys)).toEqual(byKey(mlFlow.ruleKeys));
    expect(compiled.contributionTypes).toEqual(mlFlow.contributionTypes);
    expect(compiled.deliverables).toEqual(mlFlow.deliverables);
    expect(compiled.uses).toEqual({ board: false, ...mlFlow.uses });
    expect(compiled.descriptor).toEqual(mlFlow.descriptor);
    expect(compiled.evaluationHandlers?.map((handler) => handler.key)).toEqual(mlFlow.evaluationHandlers?.map((handler) => handler.key));
    expect(compiled.actions?.filter((action) => action.path === "workspace").map((action) => [action.method, action.access])).toEqual(mlFlow.actions?.map((action) => [action.method, action.access]));
    expect(compiled.hooks!.onCreate!({ challenge, input: { api_packaging_enabled: false } } as never)).toEqual(mlFlow.hooks!.onCreate!({ challenge, input: { api_packaging_enabled: false } } as never));
    expect(compiled.hooks!.onCreate!({ challenge, input: {} } as never)).toEqual(mlFlow.hooks!.onCreate!({ challenge, input: {} } as never));
    expect(compiled.rules!.parse(DEFAULT_ML_REWARD_RULES)).toEqual(DEFAULT_ML_REWARD_RULES);
    expect(compiled.rules!.parse({ ...DEFAULT_ML_REWARD_RULES, model: { ...DEFAULT_ML_REWARD_RULES.model, metric: { name: "auc", baseline: 0.5, blockThreshold: 0.9 } } })).not.toBeNull();
  });

  it("pays datasets, reuses and model metrics with lead bonuses and reuse credit, exactly", async () => {
    const DS_A = "https://kaggle.com/datasets/alice/knee";
    const DS_C = "https://kaggle.com/datasets/carol/knee-extra";
    const MODEL_B = "https://kaggle.com/models/bob/knee-net";

    let step = await submit("alice", "alice", "dataset", DS_A, 0.73);
    expect(step.written).toEqual(step.want);
    expect(step.written).toHaveLength(1);

    // Bob colle le dataset d'Alice : aucune note, aucun point, `skipped_reuse`.
    step = await submit("bob", "bob", "dataset", DS_A, 0.99);
    expect(step.written).toEqual([]);
    expect(runtime.statuses.filter((row) => row.contribution === step.contributionId).map((row) => row.status)).toEqual(["skipped_reuse"]);
    expect(runtime.evaluations).toHaveLength(1);

    // Bob : son modèle, sur le dataset d'Alice — métrique, bonus de tête, crédits à Alice.
    select("bob", [DS_A]);
    step = await submit("bob", "bob", "model", MODEL_B, 0.8);
    expect(step.written).toEqual(step.want);
    expect(step.written.map((row) => row.rule_key)).toEqual(["model_metric", "reuse_dataset", "reuse_dataset", "beat_best", "reuse_dataset", "reuse_dataset"]);

    // Carol réutilise le modèle de Bob et deux datasets (le sien, celui d'Alice) : pas de tête, crédits à Alice (1/2) et à Bob.
    await submit("carol", "carol", "dataset", DS_C, 0.5);
    select("carol", [DS_A, DS_C]);
    step = await submit("carol", "carol", "model", MODEL_B, 0.7);
    expect(step.written).toEqual(step.want);
    expect(step.written.some((row) => row.rule_key === "beat_best")).toBe(false);
    expect(step.written.filter((row) => row.rule_key === "reuse_model" && row.points > 0).map((row) => row.user_id)).toEqual(["bob"]);

    // Carol prend la tête, puis s'améliore sans bonus.
    step = await submit("carol", "carol", "model", MODEL_B, 0.9);
    expect(step.written).toEqual(step.want);
    expect(step.written.some((row) => row.rule_key === "beat_best")).toBe(true);
    step = await submit("carol", "carol", "model", MODEL_B, 0.95);
    expect(step.written).toEqual(step.want);
    expect(step.written.some((row) => row.rule_key === "beat_best")).toBe(false);

    // Sous la baseline : rien.
    step = await submit("dave", "dave", "model", "https://kaggle.com/models/dave/random", 0.4);
    expect(step.written).toEqual([]);
    expect(step.want).toEqual([]);

    // Code du modèle et packaging d'API, notés.
    step = await submit("bob", "bob", "model_code", "https://github.com/bob/knee-net", 0.62);
    expect(step.written).toEqual(step.want);
    step = await submit("bob", "bob", "api", "https://github.com/bob/knee-api", 0.41);
    expect(step.written).toEqual(step.want);
  });

  it("multiplies a group's payment, keeps reuse credit on the base, and splits the net between members", async () => {
    const DS_A = "https://kaggle.com/datasets/alice/knee";
    await submit("alice", "alice", "dataset", DS_A, 0.8);
    group("dan", ["erin", "finn"]);
    select("dan", [DS_A]);

    const step = await submit("erin", "dan", "model_code", "https://github.com/dan/knee", 0.66, 3);
    expect(step.written).toEqual(step.want);
    const net = step.written.filter((row) => row.user_id === "dan").reduce((sum, row) => sum + row.points, 0);
    const shares = splitShares(net, ["dan", "erin", "finn"], "dan");
    for (const [user, points] of shares) expect(runtime.shares.get(`${step.contributionId}:${user}`)).toBe(points);
  });

  it("clamps to the pool before splitting, and keeps the reuser's floor", async () => {
    const DS_A = "https://kaggle.com/datasets/alice/knee";
    setRules({ ...DEFAULT_ML_REWARD_RULES, reuse: { datasetShare: 0.6, modelShare: 0.6, minKeepShare: 0.5 } }, 400);
    await submit("alice", "alice", "dataset", DS_A, 0.9);
    // Bob est l'auteur du modèle (sa soumission n'a encore rien rapporté) ; il reste 130 CP.
    submitted("bob", "model", "https://kaggle.com/models/bob/knee-net");
    select("carol", [DS_A]);
    const step = await submit("carol", "carol", "model", "https://kaggle.com/models/bob/knee-net", 1);
    expect(step.written).toEqual(step.want);
    expect(step.written.find((row) => row.rule_key === "model_metric")?.meta).toMatchObject({ clampedTo: expect.any(Number), rawPoints: expect.any(Number) });
    expect(runtime.completions.get(CHALLENGE)).toBe(1);
  });

  it("marks a failed evaluation failed, writes nothing, and replays", async () => {
    runtime = memoryRuntime({ evaluate: async () => { throw new Error("agent down"); } });
    runtime.challenges.push(challenge);
    for (const [role, repo] of Object.entries(REPOS)) runtime.stepRepos.push({ challenge_id: CHALLENGE, repo_id: repo, role });
    PlatformRegistry.reset();
    PlatformRegistry.install({ flows: [compileMlFlow(runtime)] });
    const contributionId = submitted("alice", "dataset", "https://kaggle.com/datasets/alice/knee");
    await PlatformRegistry.flow("ml")!.evaluationHandlers![0].retry({ challengeId: CHALLENGE, userId: "alice", repoId: REPOS.dataset, url: "https://kaggle.com/datasets/alice/knee" });
    await runtime.evaluations.settle();
    expect(runtime.evaluations.errors).toHaveLength(1);
    expect(runtime.statuses.map((row) => row.status)).toEqual(["running", "failed"]);
    expect(runtime.ledgerRows).toEqual([]);
    expect(runtime.evaluations[0]).toMatchObject({ contributionId, grid: "dataset", snapshot: "latest", origin: { handler: "submission", payload: { challengeId: CHALLENGE, userId: "alice", repoId: REPOS.dataset } } });
  });
});
