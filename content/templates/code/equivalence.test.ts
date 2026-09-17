import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Challenge } from "../../../packages/database-service/domain/entities.js";
import { splitShares } from "../../../packages/database-service/domain/share.js";
import { groupMultiplier } from "../../../packages/database-service/domain/groupPolicy.js";
import { dispatchChallengeAction } from "../../../packages/capabilities/challenge-actions.js";
import { PlatformRegistry } from "../../../packages/registry/platform.js";
import { memoryRuntime, type MemoryRuntime } from "../../../packages/interpreter/testing/memory-runtime.js";
import { computeCodeAward } from "../../flows/code/reward.js";
import { codeFlow } from "../../flows/code/index.js";
import { compileCodeFlow } from "./index.js";

/**
 * Parité P3 — le template `code` contre le flow écrit à la main
 * -------------------------------------------------------------
 * Run après run, ce que le template verse est ce que `computeCodeAward` aurait
 * versé sur le même ledger, avec le bonus de groupe ; les parts d'un groupe
 * sont celles de `splitShares` ; les refus portent les raisons de
 * `canEvaluate`. Les écritures Postgres et les services sont comparés dans
 * `equivalence.integration.test.ts`.
 */

const CHALLENGE = "44444444-4444-4444-8444-444444444444";
const flow = () => PlatformRegistry.flow("code")!;

afterAll(() => PlatformRegistry.reset());

describe("the code template, run for run against the code flow", () => {
  let runtime: MemoryRuntime;
  let challenge: Challenge;
  const scores: number[] = [];

  beforeEach(() => {
    scores.length = 0;
    runtime = memoryRuntime({
      evaluate: async () => {
        const score = scores.shift() ?? 0;
        return { score, evaluation: { scores: [], globalScore: score * 9 } };
      },
    });
    challenge = {
      uuid: CHALLENGE,
      title: "Build the app",
      slug: "build-the-app",
      status: "active",
      type: "code",
      contribution_points_reward: 1000,
      completion: 0,
      project_id: "project-1",
      flow_config: { workspace_mode: "provided_repo" },
      flow_config_version: 1,
      reward_rules: { version: 1, delivery: { fixed: 25, cap: 75 } },
      created_at: new Date(),
    } as Challenge;
    runtime.challenges.push(challenge);
    PlatformRegistry.reset();
    PlatformRegistry.install({ flows: [compileCodeFlow(runtime)] });
  });

  const readyBranch = (user: string, group: string | null = null) => ({
    challenge_id: CHALLENGE,
    user_id: user,
    group_id: group,
    workspace_provider: "github",
    workspace_ref: `contrib/001-${user}`,
    workspace_url: `https://github.com/acme/app/tree/contrib/001-${user}`,
    workspace_status: "ready",
  });
  const boardOf = (holder: string, statuses: string[]) => statuses.forEach((status) => runtime.tasks.push({ challenge_id: CHALLENGE, user_id: holder, status }));

  async function launch(user: string) {
    const response = await dispatchChallengeAction(
      {
        request: new Request(`http://localhost/api/challenges/${CHALLENGE}/flow/project_evaluation`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
        challengeId: CHALLENGE,
        scope: { kind: "flow" },
        segments: ["project_evaluation"],
        user: { id: user, role: "contributor" },
      } as never,
      {
        findChallenge: async () => challenge,
        isManager: async () => false,
        isMember: async (userId) => runtime.teams.some((team) => team.user_id === userId),
        holds: async () => false,
      }
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  const contribution = (holder: string) => `contribution-${CHALLENGE}-${holder}-project`;
  const rows = (holder: string) => runtime.ledgerRows.filter((row) => row.user_id === holder).map((row) => ({ rule_key: row.rule_key, points: row.points, meta: row.meta }));

  /** Ce que le flow code verserait maintenant pour ce porteur. */
  function codeFlowWould(holder: string, score10: number, members: number) {
    const paid = (key: string) => runtime.ledgerRows.filter((row) => row.user_id === holder && row.rule_key === key).reduce((sum, row) => sum + row.points, 0);
    const distributed = runtime.ledgerRows.reduce((sum, row) => sum + row.points, 0);
    return computeCodeAward({
      rules: challenge.reward_rules as never,
      challengeId: CHALLENGE,
      userId: holder,
      contributionId: contribution(holder),
      score: score10,
      alreadyAwarded: { code_fixed: paid("code_fixed"), code_quality: paid("code_quality") },
      remainingPool: challenge.contribution_points_reward - distributed,
      groupMultiplier: groupMultiplier(members),
    }).map((draft) => ({ rule_key: draft.rule_key, points: draft.points, meta: draft.meta }));
  }

  async function evaluate(caller: string, holder: string, score: number, members = 1) {
    scores.push(score);
    const want = codeFlowWould(holder, score * 10, members);
    const before = rows(holder).length;
    const response = await launch(caller);
    await runtime.evaluations.settle();
    expect(runtime.evaluations.errors).toEqual([]);
    return { response, written: rows(holder).slice(before), want };
  }

  it("declares what the code flow declares", () => {
    const compiled = flow();
    expect(compiled.ruleKeys?.map((key) => [key.key, key.consumesPool])).toEqual(codeFlow.ruleKeys?.map((key) => [key.key, key.consumesPool]));
    expect(compiled.contributionTypes).toEqual(codeFlow.contributionTypes);
    expect(compiled.deliverables).toEqual(codeFlow.deliverables);
    expect(compiled.uses).toEqual(codeFlow.uses);
    expect(compiled.evaluationHandlers?.map((handler) => handler.key)).toEqual(codeFlow.evaluationHandlers?.map((handler) => handler.key));
    expect(compiled.actions?.find((action) => action.path === "workspace")).toMatchObject({ method: "PATCH", access: { member: true } });
    expect(compiled.rules?.parse({ version: 1, delivery: { fixed: 25, cap: 75 } })).toMatchObject({ delivery: { fixed: 25, cap: 75 } });
    expect(compiled.descriptor).toMatchObject({ key: "code", icon: "code", briefRequired: true, publiclyVisible: true });
  });

  it("pays a solo participant exactly what the code flow pays, run after run", async () => {
    runtime.teams.push(readyBranch("alice"));
    boardOf("alice", ["done", "done"]);

    const first = await evaluate("alice", "alice", 0.8);
    expect(first.response).toEqual({ status: 202, body: { scheduled: true } });
    expect(first.written).toEqual(first.want);
    expect(runtime.evaluations.at(-1)).toMatchObject({ grid: "code", inputs: ["https://github.com/acme/app/tree/contrib/001-alice"], snapshot: "history" });
    expect(runtime.evaluations.at(-1)?.origin?.handler).toBe("project");

    const better = await evaluate("alice", "alice", 0.9);
    expect(better.written).toEqual(better.want);
    const worse = await evaluate("alice", "alice", 0.4);
    expect(worse.written).toEqual(worse.want);
    expect(worse.written).toEqual([]);
    expect(runtime.completions.get(CHALLENGE)).toBeCloseTo(93 / 1000);
  });

  it("pays a group through its holder with the group bonus, and splits each run's delta like the code flow", async () => {
    runtime.teams.push(readyBranch("alice", "g1"), { challenge_id: CHALLENGE, user_id: "bob", group_id: "g1" });
    boardOf("alice", ["done"]);

    // Bob lance : c'est le workspace, la contribution et le ledger d'Alice.
    const pair = await evaluate("bob", "alice", 0.8, 2);
    expect(pair.written).toEqual(pair.want);
    expect(pair.written.map((row) => row.points)).toEqual([35, 84]);
    const expectedShares = splitShares(119, ["alice", "bob"], "alice");
    expect(runtime.shares.get(`${contribution("alice")}:alice`)).toBe(expectedShares.get("alice"));
    expect(runtime.shares.get(`${contribution("alice")}:bob`)).toBe(expectedShares.get("bob"));

    // Un troisième membre : le bonus monte à 1.8, le complément se partage entre les trois.
    runtime.teams.push({ challenge_id: CHALLENGE, user_id: "carol", group_id: "g1" });
    const trio = await evaluate("carol", "alice", 0.8, 3);
    expect(trio.written).toEqual(trio.want);
    const delta = trio.written.reduce((sum, row) => sum + row.points, 0);
    const third = splitShares(delta, ["alice", "bob", "carol"], "alice");
    expect(runtime.shares.get(`${contribution("alice")}:carol`)).toBe(third.get("carol"));
    expect(runtime.shares.get(`${contribution("alice")}:bob`)).toBe((expectedShares.get("bob") ?? 0) + (third.get("bob") ?? 0));
  });

  it("clamps to the pool and completes a clamped fixed part later, like the code flow", async () => {
    challenge = { ...challenge, contribution_points_reward: 20 };
    runtime.challenges[0] = challenge;
    runtime.teams.push(readyBranch("alice"));
    boardOf("alice", ["done"]);
    const first = await evaluate("alice", "alice", 0.8);
    expect(first.written).toEqual(first.want);

    challenge = { ...challenge, contribution_points_reward: 500 };
    runtime.challenges[0] = challenge;
    const second = await evaluate("alice", "alice", 0.8);
    expect(second.written).toEqual(second.want);
  });

  it("refuses with the code flow's reasons, before any evaluation", async () => {
    runtime.teams.push({ ...readyBranch("alice"), workspace_status: "pending" });
    expect(await launch("alice")).toEqual({ status: 400, body: { error: "Cannot start evaluation", reason: "workspace_not_ready" } });

    runtime.teams[0] = readyBranch("alice");
    expect(await launch("alice")).toEqual({ status: 400, body: { error: "Cannot start evaluation", reason: "no_tasks" } });

    boardOf("alice", ["done", "in_progress"]);
    expect(await launch("alice")).toEqual({ status: 400, body: { error: "Cannot start evaluation", reason: "tasks_not_done" } });

    challenge = { ...challenge, status: "completed" };
    expect(await launch("alice")).toEqual({ status: 400, body: { error: "Cannot start evaluation", reason: "challenge_closed" } });
    expect(runtime.evaluations).toHaveLength(0);

    challenge = { ...challenge, status: "active" };
    runtime.tasks = runtime.tasks.map((task) => ({ ...task, status: "done" }));
    runtime.evaluations.status.set(contribution("alice"), { status: "running", since: runtime.clock, artifactUrl: null });
    expect(await launch("alice")).toEqual({ status: 409, body: { error: "Cannot start evaluation", reason: "already_running" } });
  });

  it("reads an own_repo workspace as the code flow resolves it", async () => {
    runtime.teams.push({ challenge_id: CHALLENGE, user_id: "alice", workspace_provider: "external", workspace_url: "https://github.com/alice/app/pulls" });
    boardOf("alice", ["done"]);
    expect((await launch("alice")).body).toMatchObject({ reason: "workspace_not_ready" });

    runtime.teams[0] = { ...runtime.teams[0], workspace_url: "https://github.com/alice/app" };
    const run = await evaluate("alice", "alice", 0.7);
    expect(run.written).toEqual(run.want);
  });

  it("replays a failed run of the hand-written flow from its {challengeId, userId} payload", async () => {
    runtime.teams.push(readyBranch("alice"));
    boardOf("alice", ["todo"]);
    scores.push(0.8);
    // Le rejeu contourne les préconditions du bouton, comme le handler du flow code.
    const outcome = await flow().evaluationHandlers![0].retry({ challengeId: CHALLENGE, userId: "alice" });
    expect(outcome).toEqual({ ok: true });
    await runtime.evaluations.settle();
    expect(rows("alice").map((row) => row.points)).toEqual([25, 60]);
  });
});
