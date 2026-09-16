import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { Challenge } from "../../../packages/database-service/domain/entities.js";
import { runAnnotationAudit } from "../../flows/data-annotation/audit.js";
import { db } from "../../../packages/database-service/db/drizzle.js";
import { ChallengeRepository, RewardEntryRepository } from "../../../packages/database-service/repositories/index.js";
import { integrationScope } from "../../../packages/database-service/testing/integration.js";
import { resources } from "../../../packages/capabilities/resources.js";
import { dispatchChallengeAction } from "../../../packages/capabilities/challenge-actions.js";
import { PlatformRegistry, type PlatformDefinitions } from "../../../packages/registry/platform.js";
import { checkTemplateSource, compileTemplate, defaultRuntime } from "../../../packages/interpreter/index.js";
import { platform } from "../../../apps/leaderboard-client/src/distribution/mytwin.platform.js";

/**
 * J4 — le retrait, sur Postgres
 * -----------------------------
 * La porte du retrait du flow écrit à la main. Rien n'est simulé : les
 * repositories, la capacité `resources`, le ledger et le dispatcher du core
 * tournent sur la base de `DATABASE_URL`, et la distribution MyTwin est installée
 * telle quelle, puis avec son flow data-annotation remplacé par le template
 * compilé — le flip lui-même.
 *
 * Deux paliers :
 * - séquentiel : trois campagnes jouées avec le même hasard — entièrement sur
 *   le flow écrit à la main, relayée en vol vers le template (un claim tiré
 *   d'un côté, livré de l'autre), entièrement sur le template — doivent
 *   produire les mêmes gestes et les mêmes données ;
 * - concurrent : sur chaque implémentation, des annotateurs simultanés ne
 *   franchissent aucun invariant (k, unicité, consensus, une paie par claim,
 *   un audit qui ne reprend jamais deux fois).
 */

const TEMPLATE = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "template.yaml"), "utf8");

type Implementation = "hand-written" | "template";

const OPTIONS = ["mass", "calc", "normal"];
const FLOW_CONFIG = {
  k: 3,
  ttl_hours: 48,
  label_schema: { kind: "single_choice", options: OPTIONS.map((key) => ({ key, label: key })) },
  sensitive_clearance: { min_seen: 2, min_accuracy: 0.5 },
};
const REWARD_RULES = { per_unit_cp: 10, gold_rate: 0.25, audit_rate: 0.5 };
const ITEMS = [
  ...Array.from({ length: 4 }, (_, i) => ({ image_url: `https://img.test/x${i}.png`, class: "sensitive" })),
  ...Array.from({ length: 26 }, (_, i) => ({ image_url: `https://img.test/s${i}.png`, class: "standard" })),
];
const GOLDS = Array.from({ length: 6 }, (_, i) => ({ image_url: `https://img.test/g${i}.png`, expected: OPTIONS[i % 3] }));
const ANNOTATORS = ["u1", "u2", "u3", "u4", "u5"];

let people: Record<string, string>;
const scope = integrationScope();
/** Les challenges du test : les audits ne voient qu'eux, jamais une campagne réelle de la base. */
const ours: string[] = [];
const ourChallenges = async () =>
  (await Promise.all(ours.map((id) => new ChallengeRepository().findById(id)))).filter((challenge): challenge is Challenge => challenge !== null);
const nameOf = (uuid: string) => Object.entries(people).find(([, id]) => id === uuid)?.[0] ?? uuid;

function truth(image: string): string {
  const gold = GOLDS.find((candidate) => candidate.image_url === image);
  if (gold) return gold.expected;
  return OPTIONS[[...image].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 3];
}
function answer(user: string, image: string, turn: number): string {
  if (user === "u4") return "normal";
  if (user === "u5") return "calc";
  if (user === "u3" && turn % 2 === 1) return OPTIONS[(OPTIONS.indexOf(truth(image)) + 1) % 3];
  return truth(image);
}

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Le hasard courant, partagé par le flow écrit à la main (`Math.random`) et le template (son runtime). */
let dice: () => number = Math.random;

/** Installe la distribution MyTwin, avec le flow écrit à la main ou le template compilé à sa place. */
function install(implementation: Implementation) {
  const flows =
    implementation === "hand-written"
      ? platform.flows
      : platform.flows!.map((flow) =>
          flow.descriptor.key === "data-annotation"
            ? compileTemplate(checkTemplateSource(TEMPLATE, "data-annotation"), { runtime: defaultRuntime({ random: () => dice(), challengesOf: ourChallenges }) })
            : flow
        );
  PlatformRegistry.reset();
  PlatformRegistry.install({ ...platform, flows } as PlatformDefinitions);
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
    }
  );
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as Record<string, any> };
  } catch {
    return { status: response.status, body: { text } as Record<string, any> };
  }
}

interface Adapter {
  importItem(row: (typeof ITEMS)[number]): Promise<number>;
  importGold(row: (typeof GOLDS)[number]): Promise<number>;
  draw(user: string): Promise<{ claimId: string; image: string } | null>;
  label(user: string, claimId: string, value: string): Promise<{ status: number; cp: number | null }>;
  release(user: string, claimId: string): Promise<number>;
  resolve(resourceId: string, value: string): Promise<number>;
  audit(): Promise<void>;
}

function adapter(implementation: Implementation, challenge: Challenge): Adapter {
  // Le job du template lit `challengesOf`, restreint ; celui du flow écrit à la main reçoit le même périmètre.
  const audit = async () => {
    if (implementation === "template") await PlatformRegistry.flow("data-annotation")!.jobs!.find((job) => job.key.endsWith("audit"))!.run();
    else await runAnnotationAudit({ challengeRepo: { findAll: ourChallenges } });
  };
  if (implementation === "hand-written") {
    return {
      // Une ligne par lot : \`created_at\` fixe alors l'ordre de tirage, identique d'une campagne à l'autre.
      importItem: async (row) => (await call(challenge, "admin", "batches", { kind: "items", csv: `image_url,class\n${row.image_url},${row.class}` })).status,
      importGold: async (row) => (await call(challenge, "admin", "batches", { kind: "golds", csv: `image_url,expected\n${row.image_url},${row.expected}` })).status,
      async draw(user) {
        const { body } = await call(challenge, user, "draw");
        return body.claim ? { claimId: body.claim.claim_id, image: body.claim.image_url } : null;
      },
      async label(user, claimId, value) {
        const { status, body } = await call(challenge, user, `claims/${claimId}/label`, { value });
        return { status, cp: status === 200 ? body.cp_awarded : null };
      },
      release: async (user, claimId) => (await call(challenge, user, `claims/${claimId}/release`)).status,
      resolve: async (resourceId, value) => (await call(challenge, "admin", `items/${resourceId}/resolve`, { value })).status,
      audit,
    };
  }
  return {
    importItem: async (row) => (await call(challenge, "admin", "import/batch", { kind: "items", class: "standard", file: [row] })).status,
    importGold: async (row) => (await call(challenge, "admin", "import/batch", { kind: "golds", file: [row] })).status,
    async draw(user) {
      const { status, body } = await call(challenge, user, "annotator");
      return status === 200 && body.claim ? { claimId: body.claim.claim_id, image: body.claim.resource.image_url } : null;
    },
    async label(user, claimId, value) {
      const { status, body } = await call(challenge, user, "annotator/label", { claim_id: claimId, value });
      return { status, cp: status === 200 ? body.cp_awarded : null };
    },
    release: async (user, claimId) => (await call(challenge, user, "annotator/release", { claim_id: claimId })).status,
    resolve: async (resourceId, value) => (await call(challenge, "admin", "resolve/decide", { item: resourceId, value })).status,
    audit,
  };
}

const res = resources();

/** Une campagne séquentielle ; \`handoff\` relaie vers l'autre implémentation après le tirage de cet annotateur, à ce tour. */
async function campaign(first: Implementation, handoff?: { turn: number; user: string }) {
  const challenge = await scope.challenge({ type: "data-annotation", pool: 2000, flowConfig: FLOW_CONFIG, rewardRules: REWARD_RULES });
  ours.push(challenge.uuid);
  dice = seeded(2026);
  const spy = vi.spyOn(Math, "random").mockImplementation(() => dice());
  let current = first;
  install(current);
  let act = adapter(current, challenge);
  const transcript: string[] = [];

  for (const row of ITEMS) transcript.push(`item ${await act.importItem(row)}`);
  for (const row of GOLDS) transcript.push(`gold ${await act.importGold(row)}`);
  transcript.push(`bad gold ${await act.importGold({ image_url: "https://img.test/bad.png", expected: "tumor" })}`);

  for (let turn = 0; turn < 22; turn++) {
    for (const user of ANNOTATORS) {
      const drawn = await act.draw(user);
      if (handoff && handoff.turn === turn && handoff.user === user) {
        current = current === "hand-written" ? "template" : "hand-written";
        install(current);
        act = adapter(current, challenge);
      }
      if (!drawn) {
        transcript.push(`${turn} ${user} draws nothing`);
        continue;
      }
      const again = await act.draw(user);
      const value = answer(user, drawn.image, turn);
      const labeled = await act.label(user, drawn.claimId, value);
      transcript.push(`${turn} ${user} ${drawn.image} again=${again?.image === drawn.image} ${value} -> ${labeled.status} ${labeled.cp}`);
    }
  }

  const held = await act.draw("u1");
  if (held) {
    transcript.push(`release -> ${await act.release("u1", held.claimId)} again -> ${await act.release("u1", held.claimId)}`);
  }
  const contested = await res.list({ challengeId: challenge.uuid, type: "item", verdict: "contested" });
  for (const [index, item] of contested.entries()) {
    transcript.push(`resolve ${item.payload.image_url} -> ${await act.resolve(item.uuid, OPTIONS[index % 3])} again -> ${await act.resolve(item.uuid, "mass")}`);
  }
  await act.audit();
  await act.audit();
  spy.mockRestore();

  // Les données, dites sans identifiants générés : une ressource par son image, une personne par son nom.
  const instances = await res.list({ challengeId: challenge.uuid });
  const imageOf = new Map(instances.map((instance) => [instance.uuid, String(instance.payload.image_url)]));
  const claims = (await db.execute(sql`SELECT * FROM resource_claims WHERE challenge_id = ${challenge.uuid}`)).rows as Record<string, any>[];
  const claimImage = new Map(claims.map((claim) => [claim.uuid, `${imageOf.get(claim.resource_id)}:${nameOf(claim.user_id)}`]));
  const untimed = (resolution: Record<string, any> | null) => {
    if (!resolution) return resolution;
    const copy: Record<string, any> = { ...resolution };
    if ("resolved_at" in copy) copy.resolved_at = typeof copy.resolved_at;
    if ("resolved_by" in copy) copy.resolved_by = nameOf(copy.resolved_by);
    if (copy.audit) copy.audit = { ...copy.audit, at: typeof copy.audit.at };
    return copy;
  };
  const ledger = await new RewardEntryRepository().findByChallenge(challenge.uuid);
  const data = {
    resources: instances
      .map((instance) => ({ image: imageOf.get(instance.uuid), type: instance.resource_type, payload: instance.payload, class: instance.class, state: instance.state, verdict: instance.verdict, resolution: untimed(instance.resolution) }))
      .sort((a, b) => String(a.image).localeCompare(String(b.image))),
    claims: claims
      .map((claim) => ({ at: claimImage.get(claim.uuid), result: claim.result, consumed: claim.consumed_at !== null, released: claim.released_at !== null }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ledger: ledger
      .map((row) => ({ user: nameOf(row.user_id), rule_key: row.rule_key, points: row.points, claim: claimImage.get(String(row.meta?.claim_id)) }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
  return { transcript, data };
}

beforeAll(async () => {
  people = await scope.users(["admin", ...ANNOTATORS, "u6", "u7", "u8"]);
});

afterAll(async () => {
  await scope.cleanup();
  PlatformRegistry.reset();
  PlatformRegistry.install(platform);
});

describe("data-annotation on Postgres: sequential tier", () => {
  let handWritten: Awaited<ReturnType<typeof campaign>>;
  let relayed: Awaited<ReturnType<typeof campaign>>;
  let template: Awaited<ReturnType<typeof campaign>>;

  beforeAll(async () => {
    handWritten = await campaign("hand-written");
    relayed = await campaign("hand-written", { turn: 6, user: "u2" });
    template = await campaign("template");
  });

  it("plays a campaign that reaches golds, sensitive items, contested items and clawbacks", () => {
    const lines = handWritten.transcript.join("\n");
    expect(lines).toMatch(/g\d\.png/);
    expect(lines).toMatch(/x\d\.png/);
    expect(lines).toContain("bad gold 400");
    expect(lines).toMatch(/resolve .* -> 200 again -> 409/);
    expect(handWritten.data.ledger.some((row) => row.rule_key === "annotation_clawback")).toBe(true);
  });

  it("the template replays the hand-written campaign, gesture by gesture and row by row", () => {
    expect(template.transcript).toEqual(handWritten.transcript);
    expect(template.data).toEqual(handWritten.data);
  });

  it("a campaign relayed in flight ends exactly like an uninterrupted one", () => {
    expect(relayed.transcript).toEqual(handWritten.transcript);
    expect(relayed.data).toEqual(handWritten.data);
  });
});

describe("data-annotation on Postgres: concurrent tier", () => {
  const CONCURRENT = ["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8"];

  async function crowd(implementation: Implementation) {
    install(implementation);
    dice = Math.random;
    const challenge = await scope.challenge({ type: "data-annotation", pool: 5000, flowConfig: FLOW_CONFIG, rewardRules: REWARD_RULES });
    ours.push(challenge.uuid);
    const act = adapter(implementation, challenge);
    for (const row of ITEMS.slice(0, 10)) await act.importItem(row);
    for (const row of GOLDS.slice(0, 3)) await act.importGold(row);

    await Promise.all(
      CONCURRENT.map(async (user) => {
        for (let turn = 0; turn < 8; turn++) {
          const drawn = await act.draw(user);
          if (!drawn) return;
          await act.label(user, drawn.claimId, OPTIONS[Math.floor(Math.random() * 3)]);
        }
      })
    );
    await Promise.all([act.audit(), act.audit()]);
    return challenge;
  }

  it.each<Implementation>(["hand-written", "template"])("%s holds every invariant under simultaneous annotators", async (implementation) => {
    const challenge = await crowd(implementation);
    const claims = (await db.execute(sql`SELECT * FROM resource_claims WHERE challenge_id = ${challenge.uuid}`)).rows as Record<string, any>[];
    const instances = await res.list({ challengeId: challenge.uuid });
    const consumed = claims.filter((claim) => claim.consumed_at !== null);

    for (const instance of instances.filter((candidate) => candidate.resource_type === "item")) {
      const labels = consumed.filter((claim) => claim.resource_id === instance.uuid).map((claim) => String(claim.result.value));
      // k jamais dépassé.
      expect(labels.length).toBeLessThanOrEqual(3);
      if (instance.state === "closed") {
        expect(labels).toHaveLength(3);
        const tally = OPTIONS.map((option) => labels.filter((label) => label === option).length).sort((a, b) => b - a);
        const plurality = tally[0] > tally[1];
        expect(instance.verdict).toBe(plurality ? "labeled" : "contested");
        if (plurality) expect(labels.filter((label) => label === instance.resolution?.consensus)).toHaveLength(tally[0]);
      } else {
        expect(labels.length).toBeLessThan(3);
      }
    }

    // Une personne, un claim vivant par ressource.
    const live = claims.filter((claim) => claim.released_at === null).map((claim) => `${claim.resource_id}:${claim.user_id}`);
    expect(new Set(live).size).toBe(live.length);

    const ledger = await new RewardEntryRepository().findByChallenge(challenge.uuid);
    const pay = ledger.filter((row) => row.rule_key === "annotation");
    const clawbacks = ledger.filter((row) => row.rule_key === "annotation_clawback");
    // Une paie par claim livré, jamais plus que le forfait.
    const paidClaims = pay.map((row) => String(row.meta?.claim_id));
    expect(new Set(paidClaims).size).toBe(paidClaims.length);
    expect(paidClaims.every((claimId) => consumed.some((claim) => claim.uuid === claimId))).toBe(true);
    expect(pay.every((row) => row.points > 0 && row.points <= 10)).toBe(true);
    // Deux audits simultanés : une reprise par claim au plus, jamais au-delà de ce qui a été payé.
    const reversed = clawbacks.map((row) => String(row.meta?.claim_id));
    expect(new Set(reversed).size).toBe(reversed.length);
    for (const row of clawbacks) {
      const paid = pay.filter((entry) => entry.meta?.claim_id === row.meta?.claim_id).reduce((sum, entry) => sum + entry.points, 0);
      expect(-row.points).toBeLessThanOrEqual(paid);
    }
    expect(ledger.reduce((sum, row) => sum + row.points, 0)).toBeLessThanOrEqual(challenge.contribution_points_reward);
  });
});
