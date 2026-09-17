import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Challenge } from "../database-service/domain/entities.js";
import { computeCodeAward } from "../../content/flows/code/reward.js";
import { dispatchChallengeAction, type ActionDispatchDeps } from "../capabilities/challenge-actions.js";
import { PlatformRegistry } from "../registry/platform.js";
import { checkTemplateSource } from "./check.js";
import { compileTemplate } from "./compile/compile.js";
import { memoryRuntime, type MemoryRuntime } from "./testing/memory-runtime.js";

/**
 * Parité P2 — l'évaluation en arrière-plan et le paiement en différentiel
 * -----------------------------------------------------------------------
 * Un template de la forme du challenge code : un geste pose l'URL du dépôt, la
 * note tourne hors de la requête (202, une à la fois), puis la lane reprend et
 * verse `fixed` et `cap × score` en différentiel — comparés, run après run, à
 * `computeCodeAward`, la fonction du flow écrit à la main.
 */

const TOY_CODE = `
format: leaderboardos/1
template: {id: toy-code, version: 1.0.0, name: Toy code, summary: "A background grade, paid as a delta."}
params:
  pool:  {type: points, mutable: false}
  grid:  {type: grid_ref, mutable: false}
  fixed: {type: points, mutable: true}
  cap:   {type: points, mutable: true}
requires: {core: 1}
presentation: {contribution: {type: project, title: Project delivery}}
lanes:
  - id: delivery
    entry: {trigger: user, access: {mode: open}}
    nodes:
      - collect: {id: submit, fields: {repo_url: {type: url}}}
      - gate: {id: open, all: ['challenge.state == "open"']}
      - assess: {id: grade, kind: ai_grid, grid: params.grid, input: [submit.repo_url], background: true}
      - reward:
          id: pay_fixed
          rule_key: code_fixed
          amount: params.fixed
          basis: delta
          pool: params.pool
          clamp: pool
          meta: {agentScore: "grade.score * 10"}
      - reward:
          id: pay_quality
          rule_key: code_quality
          amount: "params.cap * grade.score"
          basis: delta
          pool: params.pool
          clamp: pool
          meta: {agentScore: "grade.score * 10"}
`;

function dispatcher(challenge: () => Challenge) {
  const deps: ActionDispatchDeps = {
    findChallenge: async () => challenge(),
    isManager: async () => false,
    isMember: async () => true,
    holds: async () => false,
  };
  return async (userId: string, body: unknown) => {
    const response = await dispatchChallengeAction(
      {
        request: new Request(`http://localhost/api/challenges/${challenge().uuid}/flow/delivery/submit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        challengeId: challenge().uuid,
        scope: { kind: "flow" },
        segments: ["delivery", "submit"],
        user: { id: userId, role: "contributor" },
      } as never,
      deps
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
}

afterAll(() => PlatformRegistry.reset());

describe("a background evaluation paid as a delta (template parity P2)", () => {
  let runtime: MemoryRuntime;
  let challenge: Challenge;
  let call: ReturnType<typeof dispatcher>;
  const scores: number[] = [];
  let failNext = false;

  beforeEach(() => {
    scores.length = 0;
    failNext = false;
    runtime = memoryRuntime({
      evaluate: async () => {
        if (failNext) {
          failNext = false;
          throw new Error("agent unavailable");
        }
        const score = scores.shift() ?? 0;
        return { score, evaluation: { scores: [{ criterion: "c", score: score * 9 }], globalScore: score * 9 } };
      },
    });
    challenge = {
      uuid: "33333333-3333-4333-8333-333333333333",
      title: "Toy code",
      slug: "toy-code",
      status: "active",
      type: "toy-code",
      contribution_points_reward: 1000,
      completion: 0,
      project_id: "project-1",
      flow_config: { grid: "code" },
      flow_config_version: 1,
      reward_rules: { fixed: 25, cap: 75 },
      created_at: new Date(),
    } as Challenge;
    runtime.challenges.push(challenge);
    PlatformRegistry.reset();
    PlatformRegistry.install({ flows: [compileTemplate(checkTemplateSource(TOY_CODE, "toy-code"), { runtime })] });
    call = dispatcher(() => challenge);
  });

  async function get(userId: string, path: string) {
    const response = await dispatchChallengeAction(
      {
        request: new Request(`http://localhost/api/challenges/${challenge.uuid}/flow/${path}`, { method: "GET" }),
        challengeId: challenge.uuid,
        scope: { kind: "flow" },
        segments: path.split("/"),
        user: { id: userId, role: "contributor" },
      } as never,
      { findChallenge: async () => challenge, isManager: async () => false, isMember: async () => true, holds: async () => false }
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  const contribution = (userId: string) => `contribution-${challenge.uuid}-${userId}-project`;
  const ledger = (userId: string) =>
    runtime.ledgerRows.filter((row) => row.user_id === userId).map((row) => ({ rule_key: row.rule_key, points: row.points, meta: row.meta }));

  /** Ce que le flow code aurait écrit pour ce run, sur le ledger courant. */
  function expected(userId: string, score10: number): { rule_key: string; points: number; meta: unknown }[] {
    const already = (key: string) => runtime.ledgerRows.filter((row) => row.user_id === userId && row.rule_key === key).reduce((sum, row) => sum + row.points, 0);
    const distributed = runtime.ledgerRows.reduce((sum, row) => sum + row.points, 0);
    return computeCodeAward({
      rules: { version: 1, delivery: challenge.reward_rules as { fixed: number; cap: number } },
      challengeId: challenge.uuid,
      userId,
      contributionId: contribution(userId),
      score: score10,
      alreadyAwarded: { code_fixed: already("code_fixed"), code_quality: already("code_quality") },
      remainingPool: challenge.contribution_points_reward - distributed,
    }).map((draft) => ({ rule_key: draft.rule_key, points: draft.points, meta: draft.meta }));
  }

  async function run(userId: string, score: number) {
    scores.push(score);
    const want = expected(userId, score * 10);
    const before = ledger(userId).length;
    const response = await call(userId, { repo_url: "https://github.com/alice/app" });
    await runtime.evaluations.settle();
    return { response, written: ledger(userId).slice(before), want };
  }

  it("answers 202, grades in the background, then resumes the lane and pays exactly what the code flow pays", async () => {
    const first = await run("alice", 0.8);
    expect(first.response).toEqual({ status: 202, body: { scheduled: true } });
    expect(first.written).toEqual(first.want);
    expect(first.written.map((row) => row.points)).toEqual([25, 60]);
    expect(runtime.evaluations.status.get(contribution("alice"))).toMatchObject({ status: "done", artifactUrl: "https://github.com/alice/app", evaluation: { globalScore: 7.2 } });

    // Une meilleure note : seul le complément de qualité.
    const second = await run("alice", 0.9);
    expect(second.written).toEqual(second.want);
    expect(second.written.map((row) => [row.rule_key, row.points])).toEqual([["code_quality", 8]]);

    // Une note plus basse : rien, et rien n'est repris.
    const third = await run("alice", 0.5);
    expect(third.written).toEqual([]);
    expect(third.want).toEqual([]);

    // Ce que l'UI générée relit : l'état du dernier run, sa note et les CP de la participation.
    const read = await get("alice", "delivery/evaluation");
    expect(read).toMatchObject({ status: 200, body: { status: "done", running: false, score: 0.5, artifact_url: "https://github.com/alice/app", cp: 93 } });
  });

  it("clamps to the pool like the code flow, and pays the clamped remainder on a later run", async () => {
    challenge = { ...challenge, contribution_points_reward: 60 };
    runtime.challenges[0] = challenge;
    const first = await run("alice", 0.8);
    expect(first.written).toEqual(first.want);
    expect(first.written.map((row) => [row.rule_key, row.points, (row.meta as Record<string, unknown>).clampedTo])).toEqual([
      ["code_fixed", 25, undefined],
      ["code_quality", 35, 35],
    ]);

    challenge = { ...challenge, contribution_points_reward: 200 };
    runtime.challenges[0] = challenge;
    const second = await run("alice", 0.8);
    expect(second.written).toEqual(second.want);
    expect(second.written.map((row) => [row.rule_key, row.points])).toEqual([["code_quality", 25]]);
  });

  it("pays a rule raised after a run with the rules in force when the run resumes", async () => {
    await run("alice", 0.8);
    challenge = { ...challenge, reward_rules: { fixed: 40, cap: 75 } };
    runtime.challenges[0] = challenge;
    const second = await run("alice", 0.8);
    expect(second.written).toEqual(second.want);
    expect(second.written.map((row) => [row.rule_key, row.points])).toEqual([["code_fixed", 15]]);
  });

  it("runs one evaluation at a time per participation, and takes over a stale one after 30 minutes", async () => {
    scores.push(0.8);
    const pending = runtime.evaluations.pending;
    runtime.evaluations.status.set(contribution("alice"), { status: "running", since: runtime.clock, artifactUrl: null });
    expect(await call("alice", { repo_url: "https://github.com/alice/app" })).toEqual({ status: 409, body: { error: "An evaluation is already running" } });
    expect(pending).toHaveLength(0);

    runtime.clock = new Date(runtime.clock.getTime() + 31 * 60 * 1000);
    expect((await call("alice", { repo_url: "https://github.com/alice/app" })).status).toBe(202);
    await runtime.evaluations.settle();
    expect(ledger("alice").map((row) => row.points)).toEqual([25, 60]);
  });

  it("refuses synchronously what the lane refuses before the evaluation, with no run", async () => {
    challenge = { ...challenge, status: "completed" };
    runtime.challenges[0] = challenge;
    expect(await call("alice", { repo_url: "https://github.com/alice/app" })).toEqual({ status: 422, body: { error: "Refused by open" } });
    expect(runtime.evaluations).toHaveLength(0);
    expect(runtime.evaluations.status.size).toBe(0);
  });

  it("marks a failed evaluation, and the retry handler replays the stored continuation", async () => {
    failNext = true;
    expect((await call("alice", { repo_url: "https://github.com/alice/app" })).status).toBe(202);
    await runtime.evaluations.settle();
    expect(runtime.evaluations.status.get(contribution("alice"))?.status).toBe("failed");
    expect(ledger("alice")).toEqual([]);

    const failed = runtime.evaluations.at(-1)!;
    expect(failed.origin?.handler).toBe("continue");
    const handler = PlatformRegistry.evaluationHandler("toy-code", "continue");
    scores.push(0.8);
    expect(await handler!.retry(failed.origin!.payload)).toEqual({ ok: true });
    await runtime.evaluations.settle();
    expect(runtime.evaluations.status.get(contribution("alice"))?.status).toBe("done");
    expect(ledger("alice").map((row) => row.points)).toEqual([25, 60]);
  });
});

describe("what a background evaluation refuses to validate", () => {
  const lane = (nodes: string) => `
format: leaderboardos/1
template: {id: bad-bg, version: 1.0.0, name: Bad, summary: "Bad."}
params:
  pool: {type: points, mutable: false}
  grid: {type: grid_ref, mutable: false}
requires: {core: 1}
lanes:
  - id: l
    entry: {trigger: user, access: {mode: open}}
    nodes:
${nodes}
`;

  it("a gesture after it, a branch around it, or a metric marked background", () => {
    const after = checkTemplateSource(lane(`      - collect: {id: a, fields: {u: {type: url}}}
      - assess: {id: g, kind: ai_grid, grid: params.grid, input: [a.u], background: true}
      - collect: {id: b, fields: {x: {type: string}}}`), "bad-bg");
    expect(after.errors.map((error) => error.message)).toContain("no gesture follows a background evaluation: the lane resumes without the participant");

    const metric = checkTemplateSource(lane(`      - assess: {id: m, kind: metric, value: "1", background: true}`), "bad-bg");
    expect(metric.errors.map((error) => error.message)).toContain("background applies to an ai_grid assessment");
  });
});
