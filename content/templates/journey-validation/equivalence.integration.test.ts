import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { challenges, db } from "../../../packages/database-service/db/drizzle.js";
import type { Challenge } from "../../../packages/database-service/domain/entities.js";
import {
  ChallengeRepository,
  ContributionMemberRepository,
  ContributionRepository,
  ResourceRepository,
  RewardEntryRepository,
  ScenarioRunRepository,
  ScenarioStepRepository,
  StepFeedbackRepository,
  ValidationTargetRepository,
} from "../../../packages/database-service/repositories/index.js";
import { integrationScope } from "../../../packages/database-service/testing/integration.js";
import { dispatchChallengeAction } from "../../../packages/capabilities/challenge-actions.js";
import { PlatformRegistry } from "../../../packages/registry/platform.js";
import { ScenarioStepsService } from "../../../packages/services/challenge/scenario-steps.service.js";
import { ScenarioWalkthroughService } from "../../../packages/services/challenge/scenario-walkthrough.service.js";
import { SelfWalkthroughError } from "../../../packages/services/challenge/scenario-errors.js";
import { migrateJourneyChallenge } from "./continuity.js";
import { compileJourneyValidationFlow } from "./index.js";

/**
 * Parité P4 sur Postgres — les services écrits à la main contre le template
 * -------------------------------------------------------------------------
 * Deux challenges journey-validation identiques commencent sous le flow écrit
 * à la main : une app exposée, un scénario réordonné, une walkthrough
 * brouillon à moitié remplie. Le second est alors migré (continuité) et
 * continue sous le template ; le premier continue sous les services. Les
 * deux finissent avec le même ledger, les mêmes contributions d'agrégat, et
 * les mêmes étapes, walkthroughs et retours — tables d'un côté, ressources de
 * l'autre.
 */

const scope = integrationScope();
const CONFIG = { cp_per_validation: 100, eligible_roles: ["contributor", "admin"], expert_comment_qualification: "medical_pro" };
let users: Record<string, string>;
let handwritten: Challenge;
let templated: Challenge;
/** L'application exposée de chaque côté : un challenge source par challenge de validation (un seul par source et par type). */
const projects = new Map<string, string>();
const steps = new ScenarioStepsService();
const walkthroughs = new ScenarioWalkthroughService();

beforeAll(async () => {
  users = await scope.users(["author", "teammate", "vera", "wes"]);
  for (const which of ["handwritten", "templated"] as const) {
    const source = await scope.challenge({ type: "code", pool: 0, flowConfig: { workspace_mode: "provided_repo" }, rewardRules: { version: 1, delivery: { fixed: 0, cap: 0 } } });
    const contribution = await new ContributionRepository().create({
      title: "Project delivery",
      type: "project",
      reward: 0,
      user_id: users.author,
      challenge_id: source.uuid,
      submitted_at: new Date(),
      evaluation_status: "done",
      live_endpoint_url: "https://mycoach.example.org/",
    } as never);
    await new ContributionMemberRepository().addShares([{ contribution_id: contribution.uuid, user_id: users.teammate, share_cp: 0 }] as never);

    const created = await scope.challenge({ type: "journey-validation", pool: 150, flowConfig: CONFIG, rewardRules: null });
    // Directement : `ChallengeRepository.update` repasse par le schéma, dont le type par défaut est `code`.
    await db.update(challenges).set({ source_challenge_id: source.uuid }).where(eq(challenges.uuid, created.uuid));
    const challenge = (await new ChallengeRepository().findById(created.uuid))!;
    projects.set(challenge.uuid, contribution.uuid);
    if (which === "handwritten") handwritten = challenge;
    else templated = challenge;
  }

  PlatformRegistry.reset();
  PlatformRegistry.install({ flows: [compileJourneyValidationFlow()] });
});

afterAll(async () => {
  PlatformRegistry.reset();
  await scope.cleanup();
});

/** Ce que les deux vivent sous le flow écrit à la main : app, scénario réordonné, brouillon à moitié rempli. */
async function startUnderTheHandwrittenFlow(challenge: Challenge) {
  const project = projects.get(challenge.uuid)!;
  await new ValidationTargetRepository().create({ validation_challenge_id: challenge.uuid, contribution_id: project, position: 0 });
  const first = await steps.addStep({ validationChallengeId: challenge.uuid, title: "Open the home screen", instructions: null });
  await steps.addStep({ validationChallengeId: challenge.uuid, title: "Run an exercise", instructions: "Allow the camera" });
  const third = await steps.addStep({ validationChallengeId: challenge.uuid, title: "Read the summary", instructions: null });
  await steps.editStep({ validationChallengeId: challenge.uuid, stepId: third.uuid, position: 0 });
  const run = await walkthroughs.openWalkthrough({ validationChallengeId: challenge.uuid, contributionId: project, validatorUserId: users.vera });
  await walkthroughs.saveStepFeedback({ validationChallengeId: challenge.uuid, runId: run.runId, stepId: first.uuid, validatorUserId: users.vera, result: "passed", comment: "Clear", medicalComment: null });
  return run.runId;
}

async function gesture(challenge: Challenge, user: string, path: string, body: Record<string, unknown>) {
  const response = await dispatchChallengeAction(
    {
      request: new Request(`http://localhost/api/challenges/${challenge.uuid}/flow/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      challengeId: challenge.uuid,
      scope: { kind: "flow" },
      segments: path.split("/"),
      user: { id: user, role: "contributor" },
    },
    {
      findChallenge: async () => (await new ChallengeRepository().findById(challenge.uuid))!,
      isManager: async () => false,
      isMember: async () => false,
      holds: async () => false,
    }
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/** Ce qu'un challenge porte, identifiants de walkthrough rendus par leur validateur. */
async function snapshot(challenge: Challenge, runOwner: Map<string, string>) {
  const entries = await new RewardEntryRepository().findByChallenge(challenge.uuid);
  const contributions = (await new ContributionRepository().findByChallenge(challenge.uuid)).filter((row) => row.type === "validation");
  return {
    ledger: entries
      .map((row) => ({
        user: row.user_id,
        rule_key: row.rule_key,
        points: row.points,
        meta: { ...row.meta, runId: runOwner.get(String(row.meta?.runId)), targetContributionId: row.meta?.targetContributionId === projects.get(challenge.uuid) ? "<app>" : row.meta?.targetContributionId },
      }))
      .sort((a, b) => a.user.localeCompare(b.user)),
    contributions: contributions
      .map((row) => ({ user: row.user_id, title: row.title, description: row.description?.replace(challenge.title, "<title>"), reward: row.reward }))
      .sort((a, b) => a.user.localeCompare(b.user)),
  };
}

describe("the journey-validation template and the hand-written flow, side by side on Postgres (template parity P4)", () => {
  it("continue a half-done walkthrough and end with the same ledger, contributions and scenario data", async () => {
    const handRun = await startUnderTheHandwrittenFlow(handwritten);
    const templRun = await startUnderTheHandwrittenFlow(templated);

    // ── La bascule : le second challenge passe au template, avec ses données.
    expect(await migrateJourneyChallenge(templated.uuid)).toEqual({ apps: 1, steps: 3, walkthroughs: 1, step_results: 1 });
    expect(await migrateJourneyChallenge(templated.uuid)).toEqual({ apps: 0, steps: 0, walkthroughs: 0, step_results: 0 });

    const handSteps = await new ScenarioStepRepository().findByChallenge(handwritten.uuid);
    const resources = new ResourceRepository();
    const byType = async (type: string) => resources.listResources({ challengeId: templated.uuid, type });
    const app = (await byType("app"))[0];
    const orderedSteps = (await byType("step")).sort((a, b) => (a.payload.position as number) - (b.payload.position as number));
    expect(orderedSteps.map((step) => step.payload)).toEqual(handSteps.map((step) => ({ position: step.position, title: step.title, instructions: step.instructions })));

    // ── Le groupe de l'auteur est refusé des deux côtés.
    await expect(walkthroughs.openWalkthrough({ validationChallengeId: handwritten.uuid, contributionId: projects.get(handwritten.uuid)!, validatorUserId: users.teammate })).rejects.toBeInstanceOf(SelfWalkthroughError);
    expect((await gesture(templated, users.teammate, "open/start", { app: app.uuid })).status).toBe(403);

    // ── Le brouillon repris : même walkthrough, le reste des étapes, la clôture.
    expect((await gesture(templated, users.vera, "open/start", { app: app.uuid })).body.created.open_run).toBe(templRun);
    const handIds = handSteps.map((step) => step.uuid);
    const templIds = orderedSteps.map((step) => step.uuid);
    for (const [index, result] of [[0, "failed"], [2, "blocked"]] as const) {
      await walkthroughs.saveStepFeedback({ validationChallengeId: handwritten.uuid, runId: handRun, stepId: handIds[index], validatorUserId: users.vera, result, comment: null, medicalComment: null });
      expect((await gesture(templated, users.vera, "record/feedback", { walkthrough: templRun, step: templIds[index], result })).status).toBe(200);
    }
    await walkthroughs.completeWalkthrough({ validationChallengeId: handwritten.uuid, runId: handRun, validatorUserId: users.vera, globalFeedback: "Usable" });
    expect((await gesture(templated, users.vera, "complete/finish", { walkthrough: templRun, global_feedback: "Usable" })).body.cp_awarded).toBe(100);

    // ── Un second validateur, entièrement sous chaque flow : écrêté à 50.
    const handSecond = await walkthroughs.openWalkthrough({ validationChallengeId: handwritten.uuid, contributionId: projects.get(handwritten.uuid)!, validatorUserId: users.wes });
    const templSecond = (await gesture(templated, users.wes, "open/start", { app: app.uuid })).body.created.open_run as string;
    for (let index = 0; index < 3; index++) {
      await walkthroughs.saveStepFeedback({ validationChallengeId: handwritten.uuid, runId: handSecond.runId, stepId: handIds[index], validatorUserId: users.wes, result: "passed", comment: "ok", medicalComment: null });
      await gesture(templated, users.wes, "record/feedback", { walkthrough: templSecond, step: templIds[index], result: "passed", comment: "ok" });
    }
    const handPaid = await walkthroughs.completeWalkthrough({ validationChallengeId: handwritten.uuid, runId: handSecond.runId, validatorUserId: users.wes, globalFeedback: "Fine" });
    const templPaid = await gesture(templated, users.wes, "complete/finish", { walkthrough: templSecond, global_feedback: "Fine" });
    expect(templPaid.body.cp_awarded).toBe(handPaid.cpAwarded);

    // ── Mêmes écritures.
    const hand = await snapshot(handwritten, new Map([[handRun, "vera"], [handSecond.runId, "wes"]]));
    const templ = await snapshot(templated, new Map([[templRun, "vera"], [templSecond, "wes"]]));
    expect(templ).toEqual(hand);
    expect(hand.ledger.map((row) => row.points)).toEqual(expect.arrayContaining([100, 50]));

    const handRuns = await new ScenarioRunRepository().findByChallenge(handwritten.uuid);
    const handFeedbacks = await new StepFeedbackRepository().findByRuns(handRuns.map((run) => run.uuid));
    const position = (stepId: string, ids: string[]) => ids.indexOf(stepId);
    const templWalkthroughs = await byType("walkthrough");
    const templResults = await byType("step_result");
    const who = (id: string | null) => (id === users.vera ? "vera" : id === users.wes ? "wes" : id);
    expect(templWalkthroughs.map((row) => ({ who: who(row.created_by), state: row.state, feedback: row.resolution?.global_feedback })).sort((a, b) => String(a.who).localeCompare(String(b.who)))).toEqual(
      handRuns.map((run) => ({ who: who(run.validator_user_id), state: run.completed_at ? "closed" : "open", feedback: run.global_feedback })).sort((a, b) => String(a.who).localeCompare(String(b.who)))
    );
    const runOwner = (runId: string) => who(handRuns.find((run) => run.uuid === runId)?.validator_user_id ?? null);
    const walkOwner = (id: string) => who(templWalkthroughs.find((row) => row.uuid === id)?.created_by ?? null);
    const key = (row: { who: unknown; step: number }) => `${row.who}:${row.step}`;
    expect(templResults.map((row) => ({ who: walkOwner(String(row.payload.walkthrough)), step: position(String(row.payload.step), templIds), result: row.payload.result, comment: row.payload.comment, medical: row.payload.medical_comment })).sort((a, b) => key(a).localeCompare(key(b)))).toEqual(
      handFeedbacks.map((row) => ({ who: runOwner(row.run_id), step: position(row.step_id, handIds), result: row.result, comment: row.comment, medical: row.medical_comment })).sort((a, b) => key(a).localeCompare(key(b)))
    );
  });
});
