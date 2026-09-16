import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Challenge, RewardEntryDraft } from "../../../packages/database-service/domain/entities.js";
import type { FlowDefinition } from "../../../packages/registry/platform.js";
import type { MemoryRuntime } from "../../../packages/interpreter/testing/memory-runtime.js";

/**
 * J3 — la preuve d'équivalence
 * ----------------------------
 * Le flow écrit à la main (`content/flows/data-annotation`) et ce template,
 * compilé par l'interpréteur, jouent le même scénario séquentiel sur la même
 * campagne, avec le même hasard : chacun démarre sur un registre vide et un
 * runtime en mémoire neuf. Le flow écrit à la main y est branché en redirigeant
 * la capacité `resources` et les repositories vers ce runtime.
 *
 * Les deux implémentations n'ont ni les mêmes routes ni les mêmes corps de
 * requête ; un adaptateur par implémentation traduit chaque geste (importer,
 * tirer, labelliser, auditer). L'équivalence se juge sur ce que le geste
 * produit : l'image tirée, les CP versés, l'état et le verdict de chaque
 * ressource, le consensus, et les lignes du ledger — pas sur la forme interne
 * des résultats de claims, qui diffère.
 */

const h = vi.hoisted(() => ({ runtime: null as unknown as MemoryRuntime, random: () => 0.5 }));

vi.mock("../../../packages/capabilities/resources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../packages/capabilities/resources.js")>()),
  resources: () =>
    new Proxy({}, { get: (_target, key) => (...args: unknown[]) => (h.runtime.resources as unknown as Record<string, (...a: unknown[]) => unknown>)[key as string](...args) }),
}));

vi.mock("../../../packages/database-service/repositories/index.js", () => ({
  ContributionRepository: class {
    async createIfAbsent(entity: { challenge_id: string; user_id: string; type: string; title: string }) {
      const uuid = await h.runtime.ledger.contribution({ uuid: entity.challenge_id } as Challenge, entity.user_id, entity.type);
      return { contribution: { uuid }, created: true };
    }
  },
  RewardEntryRepository: class {
    findByChallenge(challengeId: string) {
      return h.runtime.ledger.entries(challengeId);
    }
    async findByUserAndChallenge(userId: string, challengeId: string) {
      return (await h.runtime.ledger.entries(challengeId)).filter((entry) => entry.user_id === userId);
    }
    async sumByChallenge(challengeId: string, opts?: { excludeRuleKeys?: string[] }) {
      return (await h.runtime.ledger.entries(challengeId))
        .filter((entry) => !opts?.excludeRuleKeys?.includes(entry.rule_key))
        .reduce((sum, entry) => sum + entry.points, 0);
    }
    async createManyAndSyncRewards(drafts: RewardEntryDraft[]) {
      await h.runtime.ledger.write(drafts);
      return [];
    }
  },
  ChallengeRepository: class {
    async findAll() {
      return h.runtime.challenges;
    }
  },
  UserRepository: class {},
  ProjectRepository: class {},
  ChallengeTeamRepository: class {},
  UserQualificationRepository: class {},
}));

const { PlatformRegistry } = await import("../../../packages/registry/platform.js");
const { dispatchChallengeAction } = await import("../../../packages/capabilities/challenge-actions.js");
const { memoryRuntime } = await import("../../../packages/interpreter/testing/memory-runtime.js");
const { checkTemplateSource, compileTemplate } = await import("../../../packages/interpreter/index.js");
const { dataAnnotationFlow } = await import("../../flows/data-annotation/index.js");

const TEMPLATE = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "template.yaml"), "utf8");

const CHALLENGE = {
  uuid: "33333333-3333-4333-8333-333333333333",
  title: "Mammography",
  slug: "mammography",
  status: "active",
  type: "data-annotation",
  contribution_points_reward: 3000,
  completion: 0,
  project_id: "project-1",
  flow_config: {
    k: 3,
    ttl_hours: 48,
    label_schema: {
      kind: "single_choice",
      options: [
        { key: "mass", label: "Mass" },
        { key: "calc", label: "Calcification" },
        { key: "normal", label: "Normal" },
      ],
    },
    sensitive_clearance: { min_seen: 2, min_accuracy: 0.5 },
  },
  flow_config_version: 1,
  reward_rules: { per_unit_cp: 10, gold_rate: 0.25, audit_rate: 0.5 },
  created_at: new Date("2026-09-01T00:00:00Z"),
} as Challenge;

const OPTIONS = ["mass", "calc", "normal"];
// Les sensibles d'abord : le tirage suit l'ordre de création, seule la clearance les écarte.
const ITEMS = [
  ...Array.from({ length: 10 }, (_, i) => ({ image_url: `https://img.test/x${i}.png`, class: "sensitive" })),
  ...Array.from({ length: 40 }, (_, i) => ({ image_url: `https://img.test/s${i}.png`, class: "standard" })),
];
const GOLDS = Array.from({ length: 12 }, (_, i) => ({ image_url: `https://img.test/g${i}.png`, expected: OPTIONS[i % 3] }));
const USERS = ["u1", "u2", "u3", "u4", "u5"];

/** La vraie réponse d'une image, et ce que chaque annotateur répond. */
function truth(image: string): string {
  const golden = GOLDS.find((gold) => gold.image_url === image);
  if (golden) return golden.expected;
  return OPTIONS[[...image].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 3];
}
function answer(user: string, image: string, turn: number): string {
  if (user === "u4") return "normal"; // répond toujours pareil
  if (user === "u5") return "calc";
  if (user === "u3" && turn % 2 === 1) return OPTIONS[(OPTIONS.indexOf(truth(image)) + 1) % 3]; // bruité
  if (user === "u2" && turn % 7 === 6) return OPTIONS[(OPTIONS.indexOf(truth(image)) + 2) % 3];
  return truth(image);
}

/** Un hasard reproductible (mulberry32). */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Adapter {
  importItems(rows: typeof ITEMS): Promise<number>;
  importGolds(rows: typeof GOLDS): Promise<number>;
  draw(user: string): Promise<{ claimId: string; image: string } | null>;
  label(user: string, claimId: string, value: string): Promise<{ status: number; cp: number | null }>;
  audit(): Promise<void>;
}

async function post(user: { id: string; role: string }, actionPath: string, body: unknown) {
  const response = await dispatchChallengeAction(
    {
      request: new Request(`http://localhost/api/challenges/${CHALLENGE.uuid}/flow/${actionPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      challengeId: CHALLENGE.uuid,
      scope: { kind: "flow" },
      segments: actionPath.split("/"),
      user,
    },
    {
      findChallenge: async () => ({ ...CHALLENGE }),
      isManager: async () => false,
      isMember: async () => true,
      holds: async () => false,
    }
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const ADMIN = { id: "admin", role: "admin" };
const annotator = (id: string) => ({ id, role: "contributor" });

function boot(implementation: "hand-written" | "template"): Adapter {
  h.runtime = memoryRuntime();
  const random = seeded(2026);
  h.runtime.random = random;
  vi.spyOn(Math, "random").mockImplementation(random);
  h.runtime.challenges.push({ ...CHALLENGE });

  let flow: FlowDefinition;
  if (implementation === "hand-written") {
    flow = dataAnnotationFlow;
  } else {
    const report = checkTemplateSource(TEMPLATE, "data-annotation");
    flow = compileTemplate(report, { runtime: h.runtime, icon: "tag" });
  }
  PlatformRegistry.reset();
  PlatformRegistry.install({ flows: [flow] });
  const audit = async () => {
    await PlatformRegistry.flow("data-annotation")!.jobs![0].run();
  };

  if (implementation === "hand-written") {
    return {
      async importItems(rows) {
        const csv = ["image_url,class", ...rows.map((row) => `${row.image_url},${row.class}`)].join("\n");
        return (await post(ADMIN, "batches", { kind: "items", csv })).body.created;
      },
      async importGolds(rows) {
        const csv = ["image_url,expected", ...rows.map((row) => `${row.image_url},${row.expected}`)].join("\n");
        return (await post(ADMIN, "batches", { kind: "golds", csv })).body.created;
      },
      async draw(user) {
        const { body } = await post(annotator(user), "draw", {});
        return body.claim ? { claimId: body.claim.claim_id, image: body.claim.image_url } : null;
      },
      async label(user, claimId, value) {
        const { status, body } = await post(annotator(user), `claims/${claimId}/label`, { value });
        return { status, cp: status === 200 ? body.cp_awarded : null };
      },
      audit,
    };
  }
  return {
    async importItems(rows) {
      const { status } = await post(ADMIN, "import/batch", { kind: "items", class: "standard", file: rows });
      return status === 200 ? rows.length : 0;
    },
    async importGolds(rows) {
      const { status } = await post(ADMIN, "import/batch", { kind: "golds", file: rows });
      return status === 200 ? rows.length : 0;
    },
    async draw(user) {
      const { status, body } = await post(annotator(user), "annotator", {});
      return status === 200 && body.claim ? { claimId: body.claim.claim_id, image: body.claim.resource.image_url } : null;
    },
    async label(user, claimId, value) {
      const { status, body } = await post(annotator(user), "annotator/label", { claim_id: claimId, value });
      return { status, cp: status === 200 ? body.cp_awarded : null };
    },
    audit,
  };
}

/** Le scénario : import, trente tours de tirage et de label par annotateur, un geste rejoué, deux audits. */
async function play(adapter: Adapter) {
  const transcript: string[] = [];
  transcript.push(`import items ${await adapter.importItems(ITEMS)}`);
  transcript.push(`import golds ${await adapter.importGolds(GOLDS)}`);

  for (let turn = 0; turn < 30; turn++) {
    for (const user of USERS) {
      const drawn = await adapter.draw(user);
      if (!drawn) {
        transcript.push(`${turn} ${user} draws nothing`);
        continue;
      }
      // Tirer une seconde fois resservirait la même image.
      const again = await adapter.draw(user);
      const value = answer(user, drawn.image, turn);
      const labeled = await adapter.label(user, drawn.claimId, value);
      transcript.push(`${turn} ${user} ${drawn.image} again=${again?.image === drawn.image} ${value} -> ${labeled.status} ${labeled.cp}`);
      if (turn === 5 && user === "u1") {
        const replay = await adapter.label(user, drawn.claimId, value);
        transcript.push(`${turn} ${user} replay -> ${replay.status}`);
      }
    }
  }

  await adapter.audit();
  const afterFirstAudit = h.runtime.ledgerRows.length;
  await adapter.audit();
  transcript.push(`second audit adds ${h.runtime.ledgerRows.length - afterFirstAudit} rows`);

  const resources = h.runtime.instances.map((instance) => ({
    image: instance.payload.image_url,
    type: instance.resource_type,
    class: instance.class,
    state: instance.state,
    verdict: instance.verdict,
    consensus: instance.resolution?.consensus ?? instance.resolution?.verdict ?? null,
    audited: Boolean(instance.resolution?.audit ?? instance.resolution?.["cursor.audit"]),
  }));
  const ledger = h.runtime.ledgerRows.map((row) => [row.user_id, row.rule_key, row.points]);
  return { transcript, resources, ledger };
}

afterAll(() => {
  PlatformRegistry.reset();
  vi.restoreAllMocks();
});

describe("data-annotation: the template is equivalent to the hand-written flow", () => {
  let handWritten: Awaited<ReturnType<typeof play>>;
  let template: Awaited<ReturnType<typeof play>>;

  beforeEach(async () => {
    if (handWritten && template) return;
    handWritten = await play(boot("hand-written"));
    vi.restoreAllMocks();
    template = await play(boot("template"));
    vi.restoreAllMocks();
  });

  it("exercises every path of the flow", () => {
    const lines = handWritten.transcript.join("\n");
    expect(lines).toMatch(/g\d+\.png/); // des golds tirés
    expect(lines).toMatch(/x\d+\.png/); // des items sensibles, après clearance
    expect(lines).toContain("replay -> 409");
    expect(handWritten.resources.some((resource) => resource.verdict === "contested")).toBe(true);
    expect(handWritten.resources.some((resource) => resource.verdict === "labeled")).toBe(true);
    expect(handWritten.ledger.some(([, key]) => key === "annotation_clawback")).toBe(true);
    // La précision décalée finit par peser sur la paie.
    expect(handWritten.ledger.some(([, key, points]) => key === "annotation" && Number(points) > 0 && Number(points) < 10)).toBe(true);
  });

  it("draws the same images and pays the same CP, gesture by gesture", () => {
    expect(template.transcript).toEqual(handWritten.transcript);
  });

  it("leaves every resource in the same state, verdict and consensus", () => {
    expect(template.resources).toEqual(handWritten.resources);
  });

  it("writes the same ledger rows, clawbacks included", () => {
    expect(template.ledger).toEqual(handWritten.ledger);
  });
});
