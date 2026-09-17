import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Challenge } from "../../../packages/database-service/domain/entities.js";
import { challenges, db, user_qualifications } from "../../../packages/database-service/db/drizzle.js";
import { ChallengeRepository, ContributionRepository, RewardEntryRepository } from "../../../packages/database-service/repositories/index.js";
import { ReferenceCaseRepository } from "../../../packages/database-service/repositories/referenceCase.repo.js";
import { CaseClaimRepository } from "../../../packages/database-service/repositories/caseClaim.repo.js";
import { ValidationAttemptRepository } from "../../../packages/database-service/repositories/validationAttempt.repo.js";
import { ValidationTargetRepository } from "../../../packages/database-service/repositories/validationTarget.repo.js";
import { integrationScope } from "../../../packages/database-service/testing/integration.js";
import { hasQualification } from "../../../packages/capabilities/qualifications.js";
import { dispatchChallengeAction } from "../../../packages/capabilities/challenge-actions.js";
import { PlatformRegistry } from "../../../packages/registry/platform.js";
import { platform, MEDICAL_PRO } from "../../../apps/leaderboard-client/src/distribution/mytwin.platform.js";
import { migrateEndpointValidationChallenge } from "./continuity.js";

/**
 * Parité P6 sur Postgres — la retraite d'endpoint-validation, avec continuité
 * ---------------------------------------------------------------------------
 * Une campagne à moitié jouée sous le flow écrit à la main — deux verdicts sur
 * trois, une réclamation observée qui n'a pas encore voté — passe au template
 * `endpoint-check`. Le template la reprend là où elle était : le troisième
 * relecteur vote, la cible se résout, la majorité est payée ; les preuves, les
 * fichiers et le quorum se lisent comme ils ont été écrits.
 */

const scope = integrationScope();
let people: Record<string, string>;
let challenge: Challenge;
let target: string;
const claims: Record<string, string> = {};
const cases: string[] = [];

async function call(user: string, actionPath: string, json?: unknown) {
  const response = await dispatchChallengeAction(
    {
      request: new Request(`http://localhost/api/challenges/${challenge.uuid}/flow/${actionPath}`, {
        method: json === undefined ? "GET" : "POST",
        ...(json !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) } : {}),
      }),
      challengeId: challenge.uuid,
      scope: { kind: "flow" },
      segments: actionPath.split("?")[0].split("/"),
      user: { id: people[user], role: user === "admin" ? "admin" : "contributor" },
    },
    {
      findChallenge: async (id) => new ChallengeRepository().findById(id),
      isManager: async () => false,
      isMember: async () => false,
      holds: async (userId, qualification) => hasQualification(userId, qualification),
    }
  );
  // Un fichier servi garde son type (ici du JSON écrit en texte) : le corps se lit en texte, puis en JSON s'il en est.
  const text = await response.text();
  const disposition = response.headers.get("Content-Disposition") ?? "";
  let body: any = text;
  if (!disposition.startsWith("attachment")) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

beforeAll(async () => {
  people = await scope.users(["admin", "dev", "author", "r1", "r2", "r3"]);
  await db.insert(user_qualifications).values(["author", "r1", "r2", "r3"].map((name) => ({ user_id: people[name], key: MEDICAL_PRO })));
  const source = await scope.challenge({ type: "ml", pool: 0, flowConfig: {}, rewardRules: null });
  const submission = await new ContributionRepository().create({
    title: "API", type: "api_packaging", reward: 0, user_id: people.dev, challenge_id: source.uuid, submitted_at: new Date(), evaluation_status: "done", live_endpoint_url: "https://api.example.org/predict",
  } as never);
  const created = await scope.challenge({ type: "endpoint-validation", pool: 100, flowConfig: { cp_per_validation: 40, required_validations: 3, reviewer_qualification: MEDICAL_PRO }, rewardRules: null });
  await db.update(challenges).set({ source_challenge_id: source.uuid }).where(eq(challenges.uuid, created.uuid));
  challenge = (await new ChallengeRepository().findById(created.uuid))!;

  // ── La campagne, telle que le flow écrit à la main l'a laissée ──────────
  target = (await new ValidationTargetRepository().create({ validation_challenge_id: challenge.uuid, contribution_id: submission.uuid, position: 0 })).uuid;
  for (let n = 1; n <= 3; n++) {
    const reference = await new ReferenceCaseRepository().create({
      validation_challenge_id: challenge.uuid, author_user_id: people.author,
      input_bytes: Buffer.from(`scan ${n}`), input_filename: `scan-${n}.json`, input_content_type: "application/json",
      expected_output_bytes: Buffer.from(`expected ${n}`), expected_output_filename: `expected-${n}.json`, expected_output_content_type: "application/json",
    });
    cases.push(reference.uuid);
  }
  const claimRepo = new CaseClaimRepository();
  for (const [index, reviewer] of ["r1", "r2", "r3"].entries()) {
    const claim = (await claimRepo.create({
      reference_case_id: cases[index], contribution_id: submission.uuid, validator_user_id: people[reviewer],
      response_bytes: Buffer.from(`answer ${reviewer}`), response_content_type: "application/json", response_status: reviewer === "r2" ? 500 : 200,
    }))!;
    claims[reviewer] = claim.uuid;
    await claimRepo.markObserved(claim.uuid, `observed by ${reviewer}`);
    if (reviewer !== "r3") {
      await claimRepo.markRevealed(claim.uuid);
      await new ValidationAttemptRepository().create({
        validation_challenge_id: challenge.uuid, contribution_id: submission.uuid, validator_user_id: people[reviewer],
        verdict: reviewer === "r1" ? "works" : "broken", description: `why ${reviewer}`, reference_case_claim_id: claim.uuid,
        file_bytes: null, file_filename: null, file_content_type: null, response_bytes: null, response_content_type: null, response_status: null,
      });
    }
  }

  PlatformRegistry.reset();
  PlatformRegistry.install(platform);
});

afterAll(async () => {
  PlatformRegistry.reset();
  await scope.cleanup();
});

describe("endpoint-validation retires into endpoint-check with its data (template parity P6)", () => {
  it("migrates once, all or nothing", async () => {
    expect(await migrateEndpointValidationChallenge(challenge.uuid)).toEqual({ migrated: true, targets: 1, cases: 3, claims: 3, verdicts: 2 });
    expect(await migrateEndpointValidationChallenge(challenge.uuid)).toEqual({ migrated: false, reason: "not_endpoint_validation" });
    challenge = (await new ChallengeRepository().findById(challenge.uuid))!;
    expect(challenge.type).toBe("endpoint-check");
  });

  it("reads the quorum, the evidence and the files as they were written", async () => {
    const options = await call("r3", "reviewer/options?field=pick.target");
    expect(options.body.options).toEqual([expect.objectContaining({ id: target, aggregates: { quorum: { count: 2 } } })]);

    const evidence = await call("admin", "resources?type=reference_case");
    const verdicts = evidence.body.instances.flatMap((instance: { claims: { user_id: string; result: unknown }[] }) => instance.claims.map((claim) => [claim.user_id, claim.result]));
    expect(verdicts).toEqual(expect.arrayContaining([
      [people.r1, { verdict: "works", description: "why r1" }],
      [people.r2, { verdict: "broken", description: "why r2" }],
    ]));
    expect(await call("r1", `reviewer/file?claim_id=${claims.r1}&path=resource.expected_output`)).toEqual({ status: 200, body: "expected 1" });
    expect(await call("admin", `reviewer/file?claim_id=${claims.r2}&path=context.probe.response.response`)).toEqual({ status: 200, body: "answer r2" });
  });

  it("lets the observed reviewer vote, resolves the target and pays the majority under the template's key", async () => {
    // L'observation est déjà là : un second texte est refusé, le verdict est la suite.
    expect((await call("r3", "reviewer/observation", { claim_id: claims.r3, text: "again" })).status).toBe(409);
    const voted = await call("r3", "reviewer/verdict", { claim_id: claims.r3, verdict: "works", description: "why r3" });
    expect(voted.status).toBe(200);

    const options = await call("admin", "resources?type=target");
    expect(options.body.instances).toEqual([expect.objectContaining({ id: target, open: false, verdict: "works" })]);
    const ledger = await new RewardEntryRepository().findByChallenge(challenge.uuid);
    expect(ledger.map((row) => [row.user_id, row.rule_key, row.points]).sort()).toEqual([
      [people.r1, "endpoint_check", 40],
      [people.r3, "endpoint_check", 40],
    ].sort());
  });
});
