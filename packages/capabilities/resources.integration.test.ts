import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../database-service/db/drizzle.js";
import { integrationScope } from "../database-service/testing/integration.js";
import { ClaimNotConsumableError, resources } from "./resources.js";

/**
 * La capacité `resources` sur Postgres
 * ------------------------------------
 * Les invariants que spec-annotation-flow exigeait dès M1, éprouvés là où ils
 * tiennent vraiment — le verrou `FOR UPDATE SKIP LOCKED`, le recomptage sous
 * le verrou, l'index unique partiel des claims vivants, les UPDATE
 * conditionnels — et sous concurrence réelle, pas dans un store en mémoire.
 */

const res = resources();
let challengeId: string;
let people: Record<string, string>;

const USERS = Array.from({ length: 12 }, (_, i) => `u${i + 1}`);

const scope = integrationScope();

beforeEach(async () => {
  people = await scope.users(USERS);
  challengeId = (await scope.challenge({ type: "data-annotation", pool: 100, flowConfig: {}, rewardRules: {} })).uuid;
});

afterEach(() => scope.cleanup());

async function oneItem(type = "item") {
  await res.createMany(challengeId, type, [{ payload: { image_url: "https://img.test/1.png" }, class: "standard" }]);
  const [instance] = await res.list({ challengeId, type });
  return instance.uuid;
}

const liveClaims = async (resourceId: string) =>
  (await db.execute(sql`SELECT count(*)::int AS n FROM resource_claims WHERE resource_id = ${resourceId} AND released_at IS NULL`)).rows[0].n;

describe("resources on Postgres, under concurrency", () => {
  it("never exceeds k, whatever the number of simultaneous draws", async () => {
    const resourceId = await oneItem();
    const draws = await Promise.all(USERS.map((user) => res.draw(challengeId, people[user], { type: "item", k: 3, ttlHours: 48 })));
    expect(draws.filter(Boolean)).toHaveLength(3);
    expect(await liveClaims(resourceId)).toBe(3);
  });

  it("gives one person one live claim per resource, even when they draw many times at once", async () => {
    const resourceId = await oneItem();
    const draws = await Promise.all(Array.from({ length: 8 }, () => res.draw(challengeId, people.u1, { type: "item" })));
    expect(draws.filter(Boolean)).toHaveLength(1);
    expect(await liveClaims(resourceId)).toBe(1);
  });

  it("frees the slot of an expired claim, never the slot of a consumed one", async () => {
    const resourceId = await oneItem();
    const first = await res.draw(challengeId, people.u1, { type: "item", k: 1, ttlHours: 1 });
    expect(first).not.toBeNull();
    expect(await res.draw(challengeId, people.u2, { type: "item", k: 1, ttlHours: 1 })).toBeNull();

    await db.execute(sql`UPDATE resource_claims SET expires_at = now() - interval '1 minute' WHERE uuid = ${first!.claimId}`);
    const second = await res.draw(challengeId, people.u2, { type: "item", k: 1, ttlHours: 1 });
    expect(second?.resourceId).toBe(resourceId);
    await expect(res.consume(first!.claimId, people.u1, { value: "late" })).rejects.toMatchObject({ reason: "lapsed" });

    await res.consume(second!.claimId, people.u2, { value: "mass" });
    expect(await res.draw(challengeId, people.u3, { type: "item", k: 1, ttlHours: 1 })).toBeNull();
    // Et jamais resservie à son propre annotateur.
    expect(await res.draw(challengeId, people.u2, { type: "item" })).toBeNull();
  });

  it("consumes a claim once: of two simultaneous deliveries, one wins and the other is told why", async () => {
    await oneItem();
    const drawn = await res.draw(challengeId, people.u1, { type: "item", k: 3 });
    const outcomes = await Promise.allSettled([
      res.consume(drawn!.claimId, people.u1, { value: "a" }),
      res.consume(drawn!.claimId, people.u1, { value: "b" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ClaimNotConsumableError);
    expect(rejected.reason.reason).toBe("consumed");
  });

  it("closes, recloses and stamps first-wins", async () => {
    const resourceId = await oneItem();
    const closes = await Promise.all(Array.from({ length: 10 }, (_, i) => res.close(resourceId, i % 2 ? "labeled" : "contested", { run: i })));
    expect(closes.filter(Boolean)).toHaveLength(1);

    const verdict = (await res.resource(resourceId))!.verdict!;
    const other = verdict === "labeled" ? "contested" : "labeled";
    const recloses = await Promise.all(Array.from({ length: 10 }, () => res.reclose(resourceId, verdict, other, { by: "admin" })));
    expect(recloses.filter(Boolean)).toHaveLength(1);

    const stamps = await Promise.all(Array.from({ length: 10 }, (_, i) => res.stampResolution(resourceId, "audit", { run: i })));
    expect(stamps.filter(Boolean)).toHaveLength(1);
    const final = (await res.resource(resourceId))!;
    expect(final).toMatchObject({ state: "closed", verdict: other });
    expect(Object.keys(final.resolution ?? {}).sort()).toEqual(["audit", "by", "run"]);
  });

  it("scoped and exclusive: one live claim per (case, target) for everyone, and the same case still serves another target", async () => {
    const caseId = await oneItem("reference_case");
    const claims = await Promise.all(
      USERS.map((user) => res.claimScoped(challengeId, people[user], { resourceId: caseId, scope: { target: "t1" }, exclusive: true, ttlHours: 1 }))
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = USERS[claims.findIndex(Boolean)];
    await res.consume(claims.find(Boolean)!.claimId, people[winner], { verdict: "works" });

    // Consommée, la claim reste vivante pour toujours sur (case, t1) — mais pas sur t2, ni pour son auteur.
    expect(await res.claimScoped(challengeId, people.u1, { resourceId: caseId, scope: { target: "t1" }, exclusive: true })).toBeNull();
    expect(await res.claimScoped(challengeId, people[winner], { resourceId: caseId, scope: { target: "t2" }, exclusive: true })).not.toBeNull();
  });

  it("scoped, not exclusive: the person stays in the uniqueness", async () => {
    const stepId = await oneItem("journey_step");
    const twice = await Promise.all([1, 2, 3].map(() => res.claimScoped(challengeId, people.u1, { resourceId: stepId, scope: { target: "t1" }, exclusive: false })));
    expect(twice.filter(Boolean)).toHaveLength(1);
    expect(await res.claimScoped(challengeId, people.u2, { resourceId: stepId, scope: { target: "t1" }, exclusive: false })).not.toBeNull();
  });

  it("scoped: an expired, unconsumed claim frees its combination", async () => {
    const caseId = await oneItem("reference_case");
    const first = await res.claimScoped(challengeId, people.u1, { resourceId: caseId, scope: { target: "t1" }, exclusive: true, ttlHours: 1 });
    expect(await res.claimScoped(challengeId, people.u2, { resourceId: caseId, scope: { target: "t1" }, exclusive: true, ttlHours: 1 })).toBeNull();
    await db.execute(sql`UPDATE resource_claims SET expires_at = now() - interval '1 minute' WHERE uuid = ${first!.claimId}`);
    expect(await res.claimScoped(challengeId, people.u2, { resourceId: caseId, scope: { target: "t1" }, exclusive: true, ttlHours: 1 })).not.toBeNull();
  });

  it("draws in a stable order: never-claimed first, then creation order", async () => {
    for (const i of [1, 2, 3]) {
      await res.createMany(challengeId, "item", [{ payload: { image_url: `https://img.test/${i}.png` }, class: "standard" }]);
    }
    const first = await res.draw(challengeId, people.u1, { type: "item", k: 3 });
    expect(first?.payload.image_url).toBe("https://img.test/1.png");
    await res.release(first!.claimId, people.u1);
    const next = await res.draw(challengeId, people.u1, { type: "item", k: 3 });
    expect(next?.payload.image_url).toBe("https://img.test/2.png");
  });
});
