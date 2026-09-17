import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Challenge } from "../../../packages/database-service/domain/entities.js";
import { dispatchChallengeAction } from "../../../packages/capabilities/challenge-actions.js";
import { PlatformRegistry } from "../../../packages/registry/platform.js";
import { memoryRuntime, type MemoryRuntime } from "../../../packages/interpreter/testing/memory-runtime.js";
import { validationKit } from "../../kits/validation/index.js";
import { journeyValidationFlow } from "../../flows/journey-validation/index.js";
import { compileJourneyValidationFlow } from "./index.js";

/**
 * Parité P4 — les règles du flow journey-validation, compilées
 * ------------------------------------------------------------
 * Ce que `ScenarioStepsService` et `ScenarioWalkthroughService` garantissent,
 * rejoué sur le template en mémoire : positions denses, gel, rôle éligible,
 * ni sa propre application ni celle de son groupe, reprise idempotente,
 * retours écrasés, avis expert réservé, complétion immuable payée au forfait
 * écrêté. Les écritures Postgres sont comparées côte à côte dans
 * `equivalence.integration.test.ts`.
 */

const CHALLENGE = "55555555-5555-4555-8555-555555555555";
const SOURCE = "66666666-6666-4666-8666-666666666666";
const ADMIN = "admin-1";
const AUTHOR = "author-1";
const TEAMMATE = "teammate-1";
const VALIDATOR = "validator-1";
const EXPERT = "expert-1";
const VIEWER = "viewer-1";

afterAll(() => PlatformRegistry.reset());

describe("the journey-validation template, rule for rule", () => {
  let runtime: MemoryRuntime;
  let challenge: Challenge;
  const roles: Record<string, string> = { [ADMIN]: "admin", [AUTHOR]: "contributor", [TEAMMATE]: "contributor", [VALIDATOR]: "contributor", [EXPERT]: "contributor", [VIEWER]: "viewer" };

  beforeEach(() => {
    runtime = memoryRuntime();
    challenge = {
      uuid: CHALLENGE,
      title: "Walk MyCoach",
      slug: "walk-mycoach",
      status: "active",
      type: "journey-validation",
      contribution_points_reward: 250,
      completion: 0,
      source_challenge_id: SOURCE,
      flow_config: { cp_per_validation: 100, eligible_roles: ["contributor", "admin"], expert_comment_qualification: "medical_pro" },
      flow_config_version: 1,
      reward_rules: null,
      created_at: new Date(),
    } as Challenge;
    runtime.challenges.push(challenge);
    runtime.contributionRows.push({ id: "project-1", author: AUTHOR, title: "MyCoach", url: null, kind: "project", challenge: SOURCE, capabilities: ["deployed_app"], members: [AUTHOR, TEAMMATE] });
    PlatformRegistry.reset();
    PlatformRegistry.install({ flows: [compileJourneyValidationFlow(runtime)] });
  });

  async function call(user: string, method: "GET" | "POST", path: string, body?: Record<string, unknown>) {
    const response = await dispatchChallengeAction(
      {
        request: new Request(`http://localhost/api/challenges/${CHALLENGE}/flow/${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        challengeId: CHALLENGE,
        scope: { kind: "flow" },
        segments: path.split("?")[0].split("/"),
        user: { id: user, role: roles[user] },
      },
      {
        findChallenge: async () => challenge,
        isManager: async () => false,
        isMember: async () => false,
        holds: async (userId, qualification) => userId === EXPERT && qualification === "medical_pro",
      }
    );
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  }

  const steps = () =>
    runtime.instances
      .filter((instance) => instance.resource_type === "step")
      .sort((a, b) => (a.payload.position as number) - (b.payload.position as number))
      .map((instance) => [instance.payload.position, instance.payload.title]);
  const app = () => runtime.instances.find((instance) => instance.resource_type === "app")!;
  const seedApp = () => runtime.resources.createMany(CHALLENGE, "app", [{ payload: { contribution: "project-1", app_url: "https://mycoach.example.org/" } }], { createdBy: ADMIN });
  const seedScenario = async (count = 2) => {
    await seedApp();
    for (let i = 0; i < count; i++) expect((await call(ADMIN, "POST", "add_step/new_step", { title: `Step ${i}` })).status).toBe(200);
  };
  const open = async (user: string) => call(user, "POST", "open/start", { app: app().uuid });
  const stepIds = () => runtime.instances.filter((instance) => instance.resource_type === "step").map((instance) => instance.uuid);

  it("declares what the hand-written flow and its kit declare", () => {
    const compiled = PlatformRegistry.flow("journey-validation")!;
    expect(compiled.ruleKeys?.map((key) => [key.key, key.consumesPool])).toEqual(validationKit.ruleKeys?.map((key) => [key.key, key.consumesPool]));
    expect(compiled.contributionTypes).toEqual(validationKit.contributionTypes);
    expect(compiled.requires).toEqual(journeyValidationFlow.requires);
    expect(compiled.descriptor).toMatchObject({ key: "journey-validation", label: "Validation", longLabel: "Journey validation", icon: "shield", briefRequired: false, publiclyVisible: false });
    expect(compiled.config.schema.parse({ cp_per_validation: 5, expert_comment_qualification: "medical_pro" })).toEqual({ cp_per_validation: 5, eligible_roles: ["contributor", "admin"], expert_comment_qualification: "medical_pro" });
  });

  it("keeps step positions dense: appended, moved, removed", async () => {
    await seedScenario(3);
    expect(steps()).toEqual([[0, "Step 0"], [1, "Step 1"], [2, "Step 2"]]);
    const [first, , third] = stepIds();

    // Déplacer la dernière en tête, en la renommant.
    expect((await call(ADMIN, "POST", "edit_step/step_edit", { step: third, position: 0, title: "  Now first  " })).status).toBe(200);
    expect(steps()).toEqual([[0, "Now first"], [1, "Step 0"], [2, "Step 1"]]);
    // Une position hors bornes est bornée.
    expect((await call(ADMIN, "POST", "edit_step/step_edit", { step: third, position: 99 })).status).toBe(200);
    expect(steps()).toEqual([[0, "Step 0"], [1, "Step 1"], [2, "Now first"]]);
    // `instructions: null` vide, absent laisse tel quel.
    await call(ADMIN, "POST", "edit_step/step_edit", { step: first, instructions: "Read the screen" });
    await call(ADMIN, "POST", "edit_step/step_edit", { step: first, title: "Step zero" });
    expect(runtime.instances.find((instance) => instance.uuid === first)!.payload).toMatchObject({ title: "Step zero", instructions: "Read the screen" });
    await call(ADMIN, "POST", "edit_step/step_edit", { step: first, instructions: null });
    expect(runtime.instances.find((instance) => instance.uuid === first)!.payload.instructions).toBeNull();

    expect((await call(ADMIN, "POST", "remove_step/step_removal", { step: first })).status).toBe(200);
    expect(steps()).toEqual([[0, "Step 1"], [1, "Now first"]]);
    expect((await call(ADMIN, "POST", "add_step/new_step", { title: "   " })).status).toBe(400);
    expect((await call(ADMIN, "POST", "edit_step/step_edit", { step: third, title: null })).status).toBe(400);
  });

  it("freezes the scenario as soon as a walkthrough exists, draft included", async () => {
    await seedScenario();
    expect((await open(VALIDATOR)).status).toBe(200);
    const frozen = "A walkthrough has already started on this challenge - the scenario is frozen";
    expect(await call(ADMIN, "POST", "add_step/new_step", { title: "Late" })).toEqual({ status: 409, body: { error: frozen } });
    expect((await call(ADMIN, "POST", "edit_step/step_edit", { step: stepIds()[0], title: "x" })).status).toBe(409);
    expect((await call(ADMIN, "POST", "remove_step/step_removal", { step: stepIds()[0] })).status).toBe(409);
    expect((await call(ADMIN, "POST", "withdraw/withdraw_app", { app: app().uuid })).status).toBe(409);
  });

  it("opens a walkthrough only for an eligible role, never on one's own or one's group's app", async () => {
    await seedApp();
    expect(await open(VALIDATOR)).toEqual({ status: 400, body: { error: "This challenge has no scenario step yet" } });
    await call(ADMIN, "POST", "add_step/new_step", { title: "Only step" });
    expect(await open(VIEWER)).toEqual({ status: 403, body: { error: "Your role cannot walk through this scenario" } });
    expect(await open(AUTHOR)).toEqual({ status: 403, body: { error: "You cannot walk through your own application" } });
    expect(await open(TEAMMATE)).toEqual({ status: 403, body: { error: "You cannot walk through your own group's application" } });
    expect((await call(VALIDATOR, "POST", "open/start", { app: "not-an-app" })).status).toBe(400);

    const first = await open(VALIDATOR);
    const again = await open(VALIDATOR);
    expect(first.status).toBe(200);
    expect(again.body.created.open_run).toBe(first.body.created.open_run);
    expect(runtime.instances.filter((instance) => instance.resource_type === "walkthrough")).toHaveLength(1);
    // Un admin est un rôle éligible par défaut.
    expect((await open(ADMIN)).status).toBe(200);
  });

  it("overwrites a step result on revisit, with omitted comments cleared and expert opinions reserved", async () => {
    await seedScenario();
    const run = (await open(VALIDATOR)).body.created.open_run;
    const [step] = stepIds();
    const record = (user: string, body: Record<string, unknown>) => call(user, "POST", "record/feedback", { walkthrough: run, step, ...body });

    expect((await record(VALIDATOR, { result: "failed", comment: "  crashes  " })).status).toBe(200);
    expect((await record(VALIDATOR, { result: "passed" })).status).toBe(200);
    const results = runtime.instances.filter((instance) => instance.resource_type === "step_result");
    expect(results).toHaveLength(1);
    expect(results[0].payload).toEqual({ walkthrough: run, step, result: "passed", comment: null, medical_comment: null });

    expect(await record(VALIDATOR, { result: "passed", medical_comment: "Clinically fine" })).toEqual({ status: 403, body: { error: "Only qualified experts can leave an expert opinion" } });
    expect((await record(VALIDATOR, { result: "passed", medical_comment: "   " })).status).toBe(200);
    // Pas ma walkthrough.
    expect((await record(ADMIN, { result: "passed" })).status).toBe(400);

    const expertRun = (await open(EXPERT)).body.created.open_run;
    expect((await call(EXPERT, "POST", "record/feedback", { walkthrough: expertRun, step, result: "blocked", medical_comment: "Clinically fine" })).status).toBe(200);
  });

  it("completes once, with every step answered and an overall feedback, paying the fixed amount clamped to the pool", async () => {
    await seedScenario(2);
    const [a, b] = stepIds();
    const walk = async (user: string) => {
      const run = (await open(user)).body.created.open_run as string;
      await call(user, "POST", "record/feedback", { walkthrough: run, step: a, result: "passed" });
      return run;
    };

    const run = await walk(VALIDATOR);
    expect(await call(VALIDATOR, "POST", "complete/finish", { walkthrough: run, global_feedback: "Good" })).toEqual({ status: 400, body: { error: "Some steps still have no result", reason: "incomplete" } });
    await call(VALIDATOR, "POST", "record/feedback", { walkthrough: run, step: b, result: "blocked" });
    expect((await call(VALIDATOR, "POST", "complete/finish", { walkthrough: run, global_feedback: "   " })).status).toBe(400);

    const done = await call(VALIDATOR, "POST", "complete/finish", { walkthrough: run, global_feedback: "  Good overall  " });
    expect(done).toEqual({ status: 200, body: { ok: true, cp_awarded: 100 } });
    const walkthrough = runtime.instances.find((instance) => instance.uuid === run)!;
    expect(walkthrough).toMatchObject({ state: "closed", verdict: "completed", resolution: { global_feedback: "Good overall" } });
    expect(runtime.ledgerRows.map((row) => ({ user: row.user_id, rule: row.rule_key, points: row.points, meta: row.meta, contribution: row.contribution_id }))).toEqual([
      { user: VALIDATOR, rule: "validation", points: 100, meta: { targetContributionId: "project-1", runId: run }, contribution: `contribution-${CHALLENGE}-${VALIDATOR}-validation` },
    ]);

    // Immuable : ni second paiement, ni retour d'étape, et la réouverture rend la walkthrough complétée.
    expect((await call(VALIDATOR, "POST", "complete/finish", { walkthrough: run, global_feedback: "Again" })).status).toBe(400);
    expect((await call(VALIDATOR, "POST", "record/feedback", { walkthrough: run, step: a, result: "failed" })).status).toBe(400);
    expect((await open(VALIDATOR)).body.created.open_run).toBe(run);

    // 250 - 100 = 150 : le deuxième est payé plein, le troisième écrêté à 50, le quatrième complète sans rien toucher.
    const paid: number[] = [];
    for (const user of [ADMIN, EXPERT]) {
      const next = await walk(user);
      await call(user, "POST", "record/feedback", { walkthrough: next, step: b, result: "passed" });
      paid.push((await call(user, "POST", "complete/finish", { walkthrough: next, global_feedback: "ok" })).body.cp_awarded);
    }
    expect(paid).toEqual([100, 50]);
    roles["late-1"] = "contributor";
    const late = await walk("late-1");
    await call("late-1", "POST", "record/feedback", { walkthrough: late, step: b, result: "passed" });
    expect(await call("late-1", "POST", "complete/finish", { walkthrough: late, global_feedback: "ok" })).toEqual({ status: 200, body: { ok: true, cp_awarded: 0 } });
    expect(runtime.ledgerRows.filter((row) => row.user_id === "late-1")).toEqual([]);
    expect(runtime.instances.find((instance) => instance.uuid === late)!.state).toBe("closed");
  });

  it("serves validators their own walkthroughs and managers every one", async () => {
    await seedScenario(1);
    const run = (await open(VALIDATOR)).body.created.open_run;
    await call(VALIDATOR, "POST", "record/feedback", { walkthrough: run, step: stepIds()[0], result: "failed", comment: "Broken link" });
    await open(EXPERT);

    const mine = await call(VALIDATOR, "GET", "mine");
    expect(mine.body.resources.walkthrough).toEqual([expect.objectContaining({ id: run, app: { id: app().uuid }, open: true })]);
    expect(mine.body.resources.step_result).toEqual([expect.objectContaining({ result: "failed", comment: "Broken link" })]);
    expect((await call(VALIDATOR, "GET", "resources?type=walkthrough")).status).toBe(403);

    const options = await call(VALIDATOR, "GET", "record/options?field=feedback.walkthrough");
    expect(options.body.options.map((option: { id: string }) => option.id)).toEqual([run]);
  });

  it("refuses to expose a non-public app URL", async () => {
    const refused = await call(ADMIN, "POST", "apps/expose", { contribution: "project-1", app_url: "http://127.0.0.1:3000/" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/^app_url is not reachable\/allowed/);
  });
});
