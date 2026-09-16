import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import type { Challenge } from "../database-service/domain/entities.js";
import { db, template_versions } from "../database-service/db/drizzle.js";
import { ChallengeRepository, RewardEntryRepository, TemplateRepository, TemplateStoreError } from "../database-service/repositories/index.js";
import { integrationScope } from "../database-service/testing/integration.js";
import { PlatformRegistry } from "../registry/platform.js";
import { platform } from "../../apps/leaderboard-client/src/distribution/mytwin.platform.js";
import { dispatchChallengeAction } from "./challenge-actions.js";
import { templates, TemplatePublishError } from "./templates.js";

/**
 * T1 — les templates en base, sur Postgres
 * ----------------------------------------
 * La preuve de la note (docs/input/templates-in-db-design-note.md, §5) : un
 * YAML chargé à la main — aucun éditeur n'existe —, publié, un challenge créé
 * dessus et joué ; puis une v2 publiée, et les deux versions servent chacune
 * leurs challenges côte à côte, sous les mêmes clés de ledger préfixées, avec
 * un seul job d'audit qui les exécute toutes deux. Autour : ce que la base
 * tient seule (immuabilité, ordre des versions, un brouillon, une référence
 * toujours publiée), le rattrapage d'une instance qui n'a pas vu la
 * publication, et la version qui ne compile plus — écartée, jamais fatale.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ANNOTATION = readFileSync(path.join(ROOT, "content/templates/data-annotation/template.yaml"), "utf8").replace(/\r\n/g, "\n");
const BROKEN = readFileSync(path.join(ROOT, "packages/interpreter/conformance/bug-bounty.yaml"), "utf8").replace(/\r\n/g, "\n");

const FLOW_CONFIG = {
  k: 1,
  ttl_hours: 48,
  label_schema: { kind: "single_choice", options: [{ key: "mass", label: "Mass" }, { key: "normal", label: "Normal" }] },
  sensitive_clearance: { min_seen: 2, min_accuracy: 0.5 },
};
const REWARD_RULES = { per_unit_cp: 10, gold_rate: 0, audit_rate: 1 };

const scope = integrationScope();
const repo = new TemplateRepository();
const service = templates();
let people: Record<string, string>;
let key: string;

/** Le template d'annotation sous une autre clé et une autre version ; la v2 paie double. */
function annotationAs(templateKey: string, version: string, double = false): string {
  let yaml = ANNOTATION.replace("id: data-annotation", `id: ${templateKey}`).replace("version: 1.0.0", `version: ${version}`);
  if (double) yaml = yaml.replace("            params.per_unit_cp\n            * (counters", "            params.per_unit_cp * 2.0\n            * (counters");
  return yaml;
}

/** Le refus vient de la base : drizzle enveloppe l'erreur de Postgres, qui porte le message du trigger. */
const refusedBecause = (pattern: RegExp) => (error: unknown) => pattern.test(String((error as { cause?: { message?: string } }).cause?.message ?? error));

function boot() {
  PlatformRegistry.reset();
  PlatformRegistry.install(platform);
}

async function call(challenge: Challenge, user: string, actionPath: string, payload?: unknown, method = "POST") {
  const response = await dispatchChallengeAction(
    {
      request: new Request(`http://localhost/api/challenges/${challenge.uuid}/flow/${actionPath}`, {
        method,
        ...(method === "GET" ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload ?? {}) }),
      }),
      challengeId: challenge.uuid,
      scope: { kind: "flow" },
      segments: actionPath.split("?")[0].split("/"),
      user: { id: people[user], role: user === "admin" ? "admin" : "contributor" },
    },
    {
      findChallenge: async (id) => new ChallengeRepository().findById(id),
      isManager: async () => false,
      isMember: async () => true,
      holds: async () => false,
      ensureFlowFor: (challenge) => service.ensureFlowFor(challenge),
    }
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/** Importe un item, le tire, le labellise : ce que la version paie. */
async function labelOne(challenge: Challenge, user: string, image: string) {
  expect((await call(challenge, "admin", "import/batch", { kind: "items", class: "standard", file: [{ image_url: image }] })).status).toBe(200);
  const drawn = await call(challenge, user, "annotator");
  expect(drawn.status).toBe(200);
  const labeled = await call(challenge, user, "annotator/label", { claim_id: drawn.body.claim.claim_id, value: "mass" });
  expect(labeled.status).toBe(200);
  return labeled.body.cp_awarded as number;
}

beforeAll(async () => {
  people = await scope.users(["admin", "u1"]);
  key = scope.templateKey("rating");
  boot();
});

afterAll(async () => {
  await scope.cleanup();
  boot();
});

describe("templates in the database", () => {
  it("publishes a hand-loaded YAML, instantiates it and plays it under prefixed ledger keys", async () => {
    const created = await service.create({ key, name: "Rating", yaml: annotationAs(key, "1.0.0"), by: people.admin });
    expect(created.draft).toMatchObject({ status: "draft", version: null });
    expect(created.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    const published = await service.publish(key, people.admin);
    expect(published).toMatchObject({ status: "published", version: "1.0.0", published_by: people.admin });

    const flow = PlatformRegistry.flow(key)!;
    expect(flow.ruleKeys!.map((ruleKey) => ruleKey.key)).toEqual([`${key}.annotation`, `${key}.annotation_clawback`]);
    expect(PlatformRegistry.latestTemplateVersion(key)).toBe("1.0.0");

    const challenge = await scope.challenge({ type: key, pool: 2000, flowConfig: FLOW_CONFIG, rewardRules: REWARD_RULES, templateVersion: "1.0.0" });
    expect(challenge.template_version).toBe("1.0.0");
    expect(await labelOne(challenge, "u1", "https://img.test/v1.png")).toBe(10);
    const ledger = await new RewardEntryRepository().findByChallenge(challenge.uuid);
    expect(ledger.map((row) => [row.rule_key, row.points])).toEqual([[`${key}.annotation`, 10]]);
  });

  it("serves v1 and v2 side by side, each challenge under its own version, one audit job for both", async () => {
    await service.saveDraft(key, annotationAs(key, "1.1.0", true), people.admin);
    await service.publish(key, people.admin);
    expect(PlatformRegistry.templateVersions(key)).toEqual(["1.0.0", "1.1.0"]);

    const onV1 = await scope.challenge({ type: key, pool: 2000, flowConfig: FLOW_CONFIG, rewardRules: REWARD_RULES, templateVersion: "1.0.0" });
    const onV2 = await scope.challenge({ type: key, pool: 2000, flowConfig: FLOW_CONFIG, rewardRules: REWARD_RULES, templateVersion: "1.1.0" });
    expect(await labelOne(onV1, "u1", "https://img.test/a.png")).toBe(10);
    expect(await labelOne(onV2, "u1", "https://img.test/b.png")).toBe(20);

    // Mêmes clés d'une version à l'autre : le ledger du template ne se fragmente pas.
    expect((await new RewardEntryRepository().findByChallenge(onV2.uuid)).map((row) => row.rule_key)).toEqual([`${key}.annotation`]);

    const audits = PlatformRegistry.jobs().filter((job) => job.key === `${key}.audit`);
    expect(audits).toHaveLength(1);
    const reports = (await audits[0].run()) as { challenges: number }[];
    // Chaque version n'a parcouru que ses challenges : v1 en porte deux, v2 un.
    expect(reports.map((report) => report.challenges)).toEqual([2, 1]);
  });

  it("holds its invariants in the database: immutable, increasing, one draft, a published reference", async () => {
    await expect(
      db.update(template_versions).set({ yaml: "tampered" }).where(and(eq(template_versions.template_key, key), eq(template_versions.version, "1.0.0")))
    ).rejects.toSatisfy(refusedBecause(/is published: it is immutable/));
    await expect(
      db.delete(template_versions).where(and(eq(template_versions.template_key, key), eq(template_versions.version, "1.0.0")))
    ).rejects.toSatisfy(refusedBecause(/is published: it is immutable/));

    await service.saveDraft(key, annotationAs(key, "1.0.5"), people.admin);
    await expect(service.publish(key, people.admin)).rejects.toMatchObject({ reason: "version_order" });
    await expect(db.insert(template_versions).values({ template_key: key, yaml: "x", checksum: "x" })).rejects.toThrow();

    // Un challenge ne référence ni un brouillon ni une version absente.
    await expect(scope.challenge({ type: key, pool: 1, flowConfig: FLOW_CONFIG, rewardRules: REWARD_RULES, templateVersion: "1.0.5" })).rejects.toThrow();
    await expect(repo.createTemplate({ key: "Bad.Key", name: "x", createdBy: null })).rejects.toBeInstanceOf(TemplateStoreError);

    // La clé du document doit être celle du template.
    await service.saveDraft(key, annotationAs("other-key", "2.0.0"), people.admin);
    await expect(service.publish(key, people.admin)).rejects.toBeInstanceOf(TemplatePublishError);
    const semver = (await db.execute(sql`SELECT string_to_array('1.10.0', '.')::int[] > string_to_array('1.9.0', '.')::int[] AS greater`)).rows[0];
    expect(semver).toEqual({ greater: true });
  });

  it("catches up a version published after an instance booted, and survives one that no longer compiles", async () => {
    const [onV2] = (await new ChallengeRepository().findAll()).filter((challenge) => challenge.type === key && challenge.template_version === "1.1.0");

    // Une autre instance : elle a démarré sans rien voir.
    boot();
    expect(PlatformRegistry.flowFor(onV2)).toBeUndefined();
    const progress = await call(onV2, "u1", "progress", undefined, "GET");
    expect(progress.status).toBe(200);
    expect(PlatformRegistry.templateVersions(key)).toEqual(["1.1.0"]);

    // Une version publiée en contournant la validation, qui ne compile pas : écartée au démarrage, 503 pour ses challenges.
    const brokenKey = scope.templateKey("broken");
    await repo.createTemplate({ key: brokenKey, name: "Broken", createdBy: null });
    await repo.saveDraft(brokenKey, BROKEN.replace(/id: bug-bounty/, `id: ${brokenKey}`), null);
    await repo.publishDraft(brokenKey, "1.0.0", null);
    const onBroken = await scope.challenge({ type: brokenKey, pool: 1, flowConfig: {}, rewardRules: null, templateVersion: "1.0.0" });

    boot();
    const loaded = await service.loadPublished();
    expect(loaded.unservable).toBeGreaterThanOrEqual(1);
    expect(PlatformRegistry.templateVersions(key)).toEqual(["1.0.0", "1.1.0"]);
    expect(PlatformRegistry.templateVersions(brokenKey)).toEqual([]);
    const refused = await call(onBroken, "u1", "progress", undefined, "GET");
    expect(refused.status).toBe(503);
    expect(refused.body.error).toMatch(/cannot be served/);
  });
});
