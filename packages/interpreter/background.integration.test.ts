import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Challenge } from "../database-service/domain/entities.js";
import { ContributionRepository, RewardEntryRepository } from "../database-service/repositories/index.js";
import { integrationScope } from "../database-service/testing/integration.js";
import { dispatchChallengeAction } from "../capabilities/challenge-actions.js";
import { PlatformRegistry } from "../registry/platform.js";
import { checkTemplateSource } from "./check.js";
import { compileTemplate } from "./compile/compile.js";
import { defaultRuntime } from "./compile/runtime.js";

/**
 * Parité P2, sur Postgres
 * -----------------------
 * Le port `evaluations` par défaut sur les vraies contributions : la prise
 * une-à-la-fois (`claimEvaluation`), le détail et le statut écrits, la lecture
 * générée, et le ledger versé en différentiel par la reprise de la lane. Seule
 * l'évaluation par l'agent est remplacée par une note fixée.
 */

const TOY_CODE = `
format: leaderboardos/1
template: {id: itest-toy-code, version: 1.0.0, name: Toy code, summary: "A background grade, paid as a delta."}
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
      - assess: {id: grade, kind: ai_grid, grid: params.grid, input: [submit.repo_url], background: true}
      - reward: {id: pay_fixed, rule_key: code_fixed, amount: params.fixed, basis: delta, pool: params.pool, clamp: pool, meta: {agentScore: "grade.score * 10"}}
      - reward: {id: pay_quality, rule_key: code_quality, amount: "params.cap * grade.score", basis: delta, pool: params.pool, clamp: pool, meta: {agentScore: "grade.score * 10"}}
`;

const scope = integrationScope();
const pending: Promise<void>[] = [];
const scores: number[] = [];
/** L'évaluation attend ce verrou : le test choisit quand le run se termine. */
let release: () => void = () => {};
let gate: Promise<void> = Promise.resolve();
const hold = () => {
  gate = new Promise((resolve) => (release = resolve));
};
let challenge: Challenge;
let alice: string;

async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const response = await dispatchChallengeAction(
    {
      request: new Request(`http://localhost/api/challenges/${challenge.uuid}/flow/${path}`, {
        method,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      }),
      challengeId: challenge.uuid,
      scope: { kind: "flow" },
      segments: path.split("/"),
      user: { id: alice, role: "contributor" },
    } as never,
    { findChallenge: async () => challenge, isManager: async () => false, isMember: async () => true, holds: async () => false }
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  ({ alice } = await scope.users(["alice"]));
  challenge = await scope.challenge({ type: "itest-toy-code", pool: 1000, flowConfig: { grid: "code" }, rewardRules: { fixed: 25, cap: 75 } });

  const runtime = defaultRuntime({
    evaluate: async () => {
      await gate;
      const score = scores.shift() ?? 0;
      return { score, evaluation: { scores: [{ criterion: "c", score: score * 9, comment: "" }], globalScore: score * 9 } };
    },
    challengesOf: async () => [challenge],
  });
  runtime.evaluations = { ...runtime.evaluations, schedule: (task) => void pending.push(task()) };
  PlatformRegistry.reset();
  PlatformRegistry.install({ flows: [compileTemplate(checkTemplateSource(TOY_CODE, "itest-toy-code"), { runtime })] });
});

afterAll(async () => {
  PlatformRegistry.reset();
  await scope.cleanup();
});

const settle = async () => {
  while (pending.length) await pending.shift();
};

describe("a background evaluation on Postgres (template parity P2)", () => {
  it("claims the evaluation on the contribution, stores its detail, and pays the delta on resume", async () => {
    scores.push(0.8);
    hold();
    expect(await call("POST", "delivery/submit", { repo_url: "https://github.com/alice/app" })).toEqual({ status: 202, body: { scheduled: true } });

    // Pendant le run : un second lancement est refusé par la garde SQL.
    expect((await call("POST", "delivery/submit", { repo_url: "https://github.com/alice/app" })).status).toBe(409);
    expect(await call("GET", "delivery/evaluation")).toMatchObject({ status: 200, body: { status: "running", running: true } });
    release();
    await settle();

    const contribution = (await new ContributionRepository().findByChallenge(challenge.uuid)).find((row) => row.user_id === alice)!;
    expect(contribution).toMatchObject({ type: "project", evaluation_status: "done", artifact_url: "https://github.com/alice/app" });
    expect((contribution.evaluation as { globalScore: number }).globalScore).toBeCloseTo(7.2);

    const rows = (await new RewardEntryRepository().findByChallenge(challenge.uuid)).map((row) => [row.rule_key, row.points, row.meta]);
    expect(rows).toEqual(expect.arrayContaining([["code_fixed", 25, { agentScore: 8, rawPoints: 25 }], ["code_quality", 60, { agentScore: 8, rawPoints: 60 }]]));

    scores.push(0.9);
    expect((await call("POST", "delivery/submit", { repo_url: "https://github.com/alice/app" })).status).toBe(202);
    await settle();
    const after = await new RewardEntryRepository().findByChallenge(challenge.uuid);
    expect(after.filter((row) => row.rule_key === "code_quality").map((row) => row.points).sort((a, b) => a - b)).toEqual([8, 60]);

    expect(await call("GET", "delivery/evaluation")).toMatchObject({ status: 200, body: { status: "done", running: false, cp: 93 } });
  });
});
