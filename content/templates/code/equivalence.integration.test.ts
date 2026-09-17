import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Challenge } from "../../../packages/database-service/domain/entities.js";
import {
  ChallengeRepository,
  ChallengeTeamRepository,
  ContributionMemberRepository,
  ContributionRepository,
  RewardEntryRepository,
  TaskRepository,
} from "../../../packages/database-service/repositories/index.js";
import { integrationScope } from "../../../packages/database-service/testing/integration.js";
import { dispatchChallengeAction } from "../../../packages/capabilities/challenge-actions.js";
import { PlatformRegistry } from "../../../packages/registry/platform.js";
import { defaultRuntime } from "../../../packages/interpreter/compile/runtime.js";
import { CodeRewardsService } from "../../../packages/services/challenge/code-rewards.service.js";
import { compileCodeFlow } from "./index.js";

/**
 * Parité P3 sur Postgres — le service écrit à la main contre le template
 * ----------------------------------------------------------------------
 * Deux challenges `code` identiques, les mêmes participations (un solo, un
 * groupe de deux), les mêmes boards, les mêmes notes : l'un est joué par
 * `CodeRewardsService`, l'autre par le template compilé. Après chaque run, le
 * ledger, les contributions, les parts de groupe et la complétion sont les
 * mêmes. Seul l'agent est remplacé, par la même note des deux côtés.
 */

const scope = integrationScope();
const RULES = { version: 1, delivery: { fixed: 25, cap: 75 } };
const pending: Promise<void>[] = [];
const templateScores: number[] = [];
let handwritten: Challenge;
let templated: Challenge;
let users: Record<string, string>;

async function seed(challenge: Challenge) {
  const teams = new ChallengeTeamRepository();
  const tasks = new TaskRepository();
  const group = randomUUID();
  const branch = (user: string) => ({
    workspace_provider: "github" as const,
    workspace_ref: `contrib/001-${user.slice(0, 8)}`,
    workspace_url: `https://github.com/acme/app/tree/contrib/001-${user.slice(0, 8)}`,
    workspace_status: "ready" as const,
  });
  await teams.create({ challenge_id: challenge.uuid, user_id: users.dave, ...branch(users.dave) });
  await teams.create({ challenge_id: challenge.uuid, user_id: users.alice, group_id: group, ...branch(users.alice) });
  await teams.create({ challenge_id: challenge.uuid, user_id: users.bob, group_id: group });
  for (const holder of [users.dave, users.alice]) {
    await tasks.create({ challenge_id: challenge.uuid, user_id: holder, title: "Ship it", status: "done" });
  }
}

beforeAll(async () => {
  users = await scope.users(["alice", "bob", "dave"]);
  handwritten = await scope.challenge({ type: "code", pool: 400, flowConfig: { workspace_mode: "provided_repo" }, rewardRules: RULES });
  templated = await scope.challenge({ type: "code", pool: 400, flowConfig: { workspace_mode: "provided_repo" }, rewardRules: RULES });
  await seed(handwritten);
  await seed(templated);

  const runtime = defaultRuntime({
    evaluate: async () => {
      const score = templateScores.shift() ?? 0;
      return { score, evaluation: { scores: [], globalScore: score * 9 } };
    },
    challengesOf: async () => [await new ChallengeRepository().findById(templated.uuid)].filter((c): c is Challenge => c !== null),
  });
  runtime.evaluations = { ...runtime.evaluations, schedule: (task) => void pending.push(task()) };
  PlatformRegistry.reset();
  PlatformRegistry.install({ flows: [compileCodeFlow(runtime)] });
});

afterAll(async () => {
  PlatformRegistry.reset();
  await scope.cleanup();
});

/** Le flow écrit à la main : le bouton, puis le run attendu. */
async function runHandwritten(caller: string, score: number) {
  const service = new CodeRewardsService({ runAgent: async () => ({ score10: score * 10, evaluation: { scores: [], globalScore: score * 9 } }) });
  const check = await service.canEvaluate(handwritten.uuid, caller);
  if (!check.ok) return check.reason;
  const claim = await service.claim({ challengeId: handwritten.uuid, userId: caller });
  if (!claim.ok) return claim.reason;
  await service.run({ challengeId: handwritten.uuid, userId: caller });
  return "scheduled";
}

/** Le template : le geste, puis la suite planifiée. */
async function runTemplated(caller: string, score: number) {
  templateScores.push(score);
  const response = await dispatchChallengeAction(
    {
      request: new Request(`http://localhost/api/challenges/${templated.uuid}/flow/project_evaluation`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
      challengeId: templated.uuid,
      scope: { kind: "flow" },
      segments: ["project_evaluation"],
      user: { id: caller, role: "contributor" },
    } as never,
    {
      findChallenge: async () => (await new ChallengeRepository().findById(templated.uuid))!,
      isManager: async () => false,
      isMember: async (userId) => !!(await new ChallengeTeamRepository().findByChallengeAndUser(templated.uuid, userId)),
      holds: async () => false,
    }
  );
  while (pending.length) await pending.shift();
  const body = (await response.json()) as { scheduled?: boolean; reason?: string };
  return body.scheduled ? "scheduled" : body.reason;
}

/** Ce qu'un challenge porte, sans ses identifiants : de quoi comparer les deux côte à côte. */
async function snapshot(challenge: Challenge) {
  const entries = await new RewardEntryRepository().findByChallenge(challenge.uuid);
  const contributions = (await new ContributionRepository().findByChallenge(challenge.uuid)).filter((row) => row.type === "project");
  const shares = await new ContributionMemberRepository().findByContributions(contributions.map((row) => row.uuid));
  const fresh = await new ChallengeRepository().findById(challenge.uuid);
  return {
    ledger: entries
      .map((row) => ({ user: row.user_id, rule_key: row.rule_key, points: row.points, meta: row.meta }))
      .sort((a, b) => `${a.user}${a.rule_key}${a.points}`.localeCompare(`${b.user}${b.rule_key}${b.points}`)),
    contributions: contributions
      .map((row) => ({
        user: row.user_id,
        title: row.title,
        description: row.description?.replace(challenge.title, "<title>"),
        status: row.evaluation_status,
        artifact: row.artifact_url,
        reward: row.reward,
        evaluation: row.evaluation,
      }))
      .sort((a, b) => a.user.localeCompare(b.user)),
    shares: shares.map((row) => ({ user: row.user_id, share: Number(row.share_cp) })).sort((a, b) => a.user.localeCompare(b.user)),
    completion: fresh?.completion,
  };
}

describe("the code template and the code flow, side by side on Postgres (template parity P3)", () => {
  it("write the same ledger, contributions, group shares and completion, run after run", async () => {
    const plays: Array<[string, number]> = [
      ["dave", 0.8],
      ["bob", 0.8],
      ["dave", 0.9],
      ["alice", 0.5],
      ["dave", 0.3],
      ["bob", 1],
    ];
    for (const [name, score] of plays) {
      expect(await runTemplated(users[name], score)).toBe(await runHandwritten(users[name], score));
      expect(await snapshot(templated)).toEqual(await snapshot(handwritten));
    }
    const final = await snapshot(templated);
    expect(final.ledger.length).toBeGreaterThan(4);
    expect(final.shares.length).toBe(2);
  });

  it("refuse the same launches", async () => {
    const tasks = new TaskRepository();
    for (const challenge of [handwritten, templated]) {
      await tasks.create({ challenge_id: challenge.uuid, user_id: users.dave, title: "One more", status: "todo" });
    }
    expect(await runTemplated(users.dave, 0.9)).toBe("tasks_not_done");
    expect(await runHandwritten(users.dave, 0.9)).toBe("tasks_not_done");
  });
});
