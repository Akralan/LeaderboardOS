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
      const uuid = await h.runtime.ledger.contribution({ uuid: entity.challenge_id } as Challenge, entity.user_id, { type: entity.type, title: entity.title });
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
  importItems(rows: typeof ITEMS): Promise<number | "refused">;
  importGolds(rows: typeof GOLDS): Promise<number | "refused">;
  draw(user: string): Promise<{ claimId: string; image: string } | null>;
  label(user: string, claimId: string, value: string): Promise<{ status: number; cp: number | null }>;
  release(user: string, claimId: string): Promise<number>;
  /** Trancher à la main un item contesté. */
  resolve(resourceId: string, value: string): Promise<number>;
  audit(): Promise<void>;
}

async function post(user: { id: string; role: string }, actionPath: string, payload: unknown, method = "POST") {
  const response = await dispatchChallengeAction(
    {
      request: new Request(`http://localhost/api/challenges/${CHALLENGE.uuid}/flow/${actionPath}`, {
        method,
        ...(method === "GET" ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
      }),
      challengeId: CHALLENGE.uuid,
      scope: { kind: "flow" },
      segments: actionPath.split("?")[0].split("/"),
      user,
    },
    {
      findChallenge: async () => ({ ...CHALLENGE }),
      isManager: async () => false,
      isMember: async () => true,
      holds: async () => false,
    }
  );
  const text = await response.text();
  let body: Record<string, any>;
  try {
    body = JSON.parse(text);
  } catch {
    body = { text };
  }
  return { status: response.status, body };
}

const ADMIN = { id: "admin", role: "admin" };
const annotator = (id: string) => ({ id, role: "contributor" });

type Implementation = "hand-written" | "template";

/** Une base neuve : un runtime en mémoire, la campagne, le hasard partagé par les deux implémentations. */
function freshStore() {
  h.runtime = memoryRuntime();
  const random = seeded(2026);
  h.runtime.random = random;
  vi.spyOn(Math, "random").mockImplementation(random);
  h.runtime.challenges.push({ ...CHALLENGE });
}

/** Installe une implémentation sur la base courante, sans la toucher : un démarrage. */
function attach(implementation: Implementation): Adapter {
  const flow: FlowDefinition =
    implementation === "hand-written"
      ? dataAnnotationFlow
      : compileTemplate(checkTemplateSource(TEMPLATE, "data-annotation"), { runtime: h.runtime });
  PlatformRegistry.reset();
  PlatformRegistry.install({ flows: [flow] });
  const audit = async () => {
    await PlatformRegistry.flow("data-annotation")!.jobs![0].run();
  };

  if (implementation === "hand-written") {
    return {
      async importItems(rows) {
        const csv = ["image_url,class", ...rows.map((row) => `${row.image_url},${row.class}`)].join("\n");
        const { status, body } = await post(ADMIN, "batches", { kind: "items", csv });
        return status === 200 ? body.created : "refused";
      },
      async importGolds(rows) {
        const csv = ["image_url,expected", ...rows.map((row) => `${row.image_url},${row.expected}`)].join("\n");
        const { status, body } = await post(ADMIN, "batches", { kind: "golds", csv });
        return status === 200 ? body.created : "refused";
      },
      async draw(user) {
        const { body } = await post(annotator(user), "draw", {});
        return body.claim ? { claimId: body.claim.claim_id, image: body.claim.image_url } : null;
      },
      async label(user, claimId, value) {
        const { status, body } = await post(annotator(user), `claims/${claimId}/label`, { value });
        return { status, cp: status === 200 ? body.cp_awarded : null };
      },
      async release(user, claimId) {
        return (await post(annotator(user), `claims/${claimId}/release`, {})).status;
      },
      async resolve(resourceId, value) {
        return (await post(ADMIN, `items/${resourceId}/resolve`, { value })).status;
      },
      audit,
    };
  }
  return {
    async importItems(rows) {
      const { status } = await post(ADMIN, "import/batch", { kind: "items", class: "standard", file: rows });
      return status === 200 ? rows.length : "refused";
    },
    async importGolds(rows) {
      const { status } = await post(ADMIN, "import/batch", { kind: "golds", file: rows });
      return status === 200 ? rows.length : "refused";
    },
    async draw(user) {
      const { status, body } = await post(annotator(user), "annotator", {});
      return status === 200 && body.claim ? { claimId: body.claim.claim_id, image: body.claim.resource.image_url } : null;
    },
    async label(user, claimId, value) {
      const { status, body } = await post(annotator(user), "annotator/label", { claim_id: claimId, value });
      return { status, cp: status === 200 ? body.cp_awarded : null };
    },
    async release(user, claimId) {
      return (await post(annotator(user), "annotator/release", { claim_id: claimId })).status;
    },
    async resolve(resourceId, value) {
      return (await post(ADMIN, "resolve/decide", { item: resourceId, value })).status;
    },
    audit,
  };
}

/** Un relais : à ce tour, cet annotateur a tiré sur l'ancienne implémentation et labellise sur la nouvelle. */
interface Handoff {
  turn: number;
  user: string;
  to: Implementation;
}

/**
 * Le scénario : import, trente tours de tirage et de label par annotateur, un
 * geste rejoué, deux audits. Avec des relais, la même base change
 * d'implémentation en pleine campagne, claims actifs compris.
 */
async function play(first: Implementation, handoffs: readonly Handoff[] = []) {
  freshStore();
  let adapter = attach(first);
  let current = first;
  /** Les lectures générées, prises quand le template sert la campagne. */
  const reads: Record<string, any> = {};
  const transcript: string[] = [];
  // Des lots invalides, refusés en entier : rien n'est créé.
  transcript.push(`bad expected ${await adapter.importGolds([GOLDS[0], { image_url: "https://img.test/bad.png", expected: "tumor" }])}`);
  transcript.push(`bad url ${await adapter.importItems([{ image_url: "ftp://img.test/bad.png", class: "standard" }])}`);
  transcript.push(`bad class ${await adapter.importItems([{ image_url: "https://img.test/bad.png", class: "secret" }])}`);
  transcript.push(`empty batch ${await adapter.importItems([])}`);
  transcript.push(`nothing created ${h.runtime.instances.length === 0}`);
  transcript.push(`import items ${await adapter.importItems(ITEMS)}`);
  transcript.push(`import golds ${await adapter.importGolds(GOLDS)}`);

  for (let turn = 0; turn < 30; turn++) {
    for (const user of USERS) {
      const drawn = await adapter.draw(user);
      const handoff = handoffs.find((candidate) => candidate.turn === turn && candidate.user === user);
      if (handoff) {
        adapter = attach(handoff.to);
        current = handoff.to;
      }
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

  // Un abandon explicite, puis un second refusé ; le prochain tirage passe à autre chose.
  const held = await adapter.draw("u1");
  if (held) {
    transcript.push(`release ${held.image} -> ${await adapter.release("u1", held.claimId)}`);
    transcript.push(`release again -> ${await adapter.release("u1", held.claimId)}`);
    transcript.push(`release by another -> ${await adapter.release("u2", held.claimId)}`);
    transcript.push(`after release draws ${(await adapter.draw("u1"))?.image ?? "nothing"}`);
  }

  // Trancher les items contestés : un mauvais choix refusé, le bon accepté, puis plus rien à trancher.
  const contested = h.runtime.instances.filter((instance) => instance.verdict === "contested").map((instance) => instance.uuid);
  if (current === "template") reads.overviewBefore = (await post(ADMIN, "overview", null, "GET")).body;
  for (const [index, resourceId] of contested.entries()) {
    const value = OPTIONS[index % 3];
    transcript.push(`resolve bad value -> ${await adapter.resolve(resourceId, "tumor")}`);
    transcript.push(`resolve ${value} -> ${await adapter.resolve(resourceId, value)}`);
    transcript.push(`resolve again -> ${await adapter.resolve(resourceId, value)}`);
  }
  const labeled = h.runtime.instances.find((instance) => instance.verdict === "labeled" && !contested.includes(instance.uuid));
  if (labeled) transcript.push(`resolve a labeled item -> ${await adapter.resolve(labeled.uuid, "mass")}`);

  await adapter.audit();
  const afterFirstAudit = h.runtime.ledgerRows.length;
  await adapter.audit();
  transcript.push(`second audit adds ${h.runtime.ledgerRows.length - afterFirstAudit} rows`);
  if (current === "template") {
    reads.progress = (await post(annotator("u1"), "progress", null, "GET")).body;
    reads.overview = (await post(ADMIN, "overview", null, "GET")).body;
    reads.itemsCsv = (await post(ADMIN, "export", null, "GET")).body.text;
    reads.goldsCsv = (await post(ADMIN, "export?type=gold", null, "GET")).body.text;
    reads.progressAsAnnotatorOfOverview = (await post(annotator("u1"), "overview", null, "GET")).status;
    reads.summary = await PlatformRegistry.flow("data-annotation")!.rewards!.summarize({ challenge: { ...CHALLENGE }, entries: [], maxMetaNumber: async () => null } as never);
    reads.progressU4 = (await post(annotator("u4"), "progress", null, "GET")).body;
  }


  const image = (resourceId: string) => h.runtime.instances.find((instance) => instance.uuid === resourceId)!.payload.image_url;
  // Les données telles qu'elles sont stockées. Seules les heures diffèrent : le flow écrit à la main lit l'horloge réelle.
  const withoutAuditTime = (resolution: Record<string, unknown> | null) => {
    if (!resolution) return resolution;
    const timed: Record<string, unknown> = { ...resolution };
    if (typeof timed.resolved_at === "string") timed.resolved_at = "time";
    if (typeof timed.audit === "object" && timed.audit !== null) {
      const { at, ...audit } = timed.audit as Record<string, unknown>;
      timed.audit = { ...audit, at: typeof at };
    }
    return timed;
  };
  const data = {
    resources: h.runtime.instances.map((instance) => ({
      type: instance.resource_type,
      payload: instance.payload,
      class: instance.class,
      state: instance.state,
      verdict: instance.verdict,
      resolution: withoutAuditTime(instance.resolution),
      created_by: instance.created_by,
    })),
    claims: h.runtime.claims.map((claim) => ({
      user: claim.user_id,
      image: image(claim.resource_id),
      result: claim.result,
      consumed: claim.consumed_at !== null,
      expires_at: claim.expires_at,
    })),
    // Triées : l'ordre des lignes d'un même lot d'audit ne dit rien ; celui des paies geste par geste est dans le transcript.
    ledger: h.runtime.ledgerRows
      .map((row) => ({
        user: row.user_id,
        rule_key: row.rule_key,
        points: row.points,
        meta: row.meta,
        contribution: row.contribution_id,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
  vi.restoreAllMocks();
  return { transcript, data, reads };
}

afterAll(() => {
  PlatformRegistry.reset();
  vi.restoreAllMocks();
});

describe("data-annotation: the template replaces the hand-written flow", () => {
  let handWritten: Awaited<ReturnType<typeof play>>;
  let template: Awaited<ReturnType<typeof play>>;
  let handoff: Awaited<ReturnType<typeof play>>;
  let roundTrip: Awaited<ReturnType<typeof play>>;

  beforeEach(async () => {
    if (handWritten) return;
    handWritten = await play("hand-written");
    template = await play("template");
    // Relais en vol : u2 tire sur le flow écrit à la main et labellise sur le template.
    handoff = await play("hand-written", [{ turn: 12, user: "u2", to: "template" }]);
    // Et le retour arrière : le flip se défait sans que les données s'en aperçoivent.
    roundTrip = await play("hand-written", [
      { turn: 9, user: "u3", to: "template" },
      { turn: 20, user: "u1", to: "hand-written" },
    ]);
  });

  it("exercises every path of the flow", () => {
    const lines = handWritten.transcript.join("\n");
    expect(lines).toMatch(/g\d+\.png/); // des golds tirés
    expect(lines).toMatch(/x\d+\.png/); // des items sensibles, après clearance
    expect(lines).toContain("replay -> 409");
    for (const refused of ["bad expected refused", "bad url refused", "bad class refused", "empty batch refused", "nothing created true"]) {
      expect(handWritten.transcript).toContain(refused);
    }
    const { resources, ledger } = handWritten.data;
    // Des items contestés, tranchés à la main : il n'en reste aucun, et un item déjà labellisé ne se tranche pas.
    expect(lines).toMatch(/resolve (mass|calc|normal) -> 200/);
    expect(lines).toContain("resolve again -> 409");
    expect(lines).toContain("resolve bad value -> 400");
    expect(lines).toContain("resolve a labeled item -> 409");
    expect(resources.some((resource) => resource.verdict === "contested")).toBe(false);
    expect(lines).toContain("release again -> 409");
    expect(resources.some((resource) => resource.verdict === "labeled")).toBe(true);
    expect(ledger.some((row) => row.rule_key === "annotation_clawback")).toBe(true);
    // La précision décalée finit par peser sur la paie.
    expect(ledger.some((row) => row.rule_key === "annotation" && row.points > 0 && row.points < 10)).toBe(true);
  });

  it("draws the same images and pays the same CP, gesture by gesture", () => {
    expect(template.transcript).toEqual(handWritten.transcript);
  });

  it("writes the same data: resources, claim results, resolutions, ledger rows and metas", () => {
    expect(template.data).toEqual(handWritten.data);
  });

  it("takes over a campaign in flight: an uninterrupted campaign, gesture by gesture and row by row", () => {
    expect(handoff.transcript).toEqual(handWritten.transcript);
    expect(handoff.data).toEqual(handWritten.data);
  });

  it("generates progress, overview and export from the declarations", () => {
    const { reads, data } = template;
    const u1 = data.claims.filter((claim) => claim.user === "u1" && claim.consumed).length;
    expect(reads.progress).toMatchObject({ delivered: u1, active_claim: { claim_id: expect.any(String) } });
    const cp = data.ledger.filter((row) => row.user === "u1").reduce((sum, row) => sum + row.points, 0);
    expect(reads.progress.cp).toBe(cp);
    expect(Object.keys(reads.progress.counters)).toEqual(["gold_seen", "gold_correct"]);
    // L'éligibilité par classe, tirée de la clearance du claim : u1 a gagné les items sensibles, u4 (qui rate les golds) non.
    expect(reads.progress.eligible_classes).toEqual({ item: ["standard", "sensitive"] });
    expect(reads.progressU4.eligible_classes).toEqual({ item: ["standard"] });

    // Le manager voit les compteurs sans décalage, le pool et les items qu'une lane admin attend.
    const overviewU1 = reads.overview.participants.find((row: { user_id: string }) => row.user_id === "u1");
    expect(overviewU1.name).toBe("name of u1");
    // Le hero lit le même avancement que l'overview.
    expect(reads.summary).toEqual({ resources: reads.overview.resources });
    expect(overviewU1.counters.gold_seen).toBeGreaterThan(reads.progress.counters.gold_seen);
    expect(reads.overview.resources.item).toMatchObject({ total: 50 });
    expect(reads.overview.resources.gold).toMatchObject({ total: 12 });
    expect(reads.overview.pool.distributed).toBe(data.ledger.reduce((sum, row) => sum + row.points, 0));
    expect(reads.overviewBefore.pending.length).toBe(data.resources.filter((r) => r.resolution && "resolved_by" in r.resolution).length);
    expect(reads.overviewBefore.pending[0].inputs.agreement).toHaveLength(3);
    expect(reads.overview.pending).toEqual([]);
    expect(reads.progressAsAnnotatorOfOverview).toBe(403);

    // L'export ne sort jamais un champ que personne ne lit : la réponse attendue d'un gold reste cachée.
    const [itemHeader, ...itemRows] = reads.itemsCsv.split(/\n/);
    expect(itemHeader).toBe("image_url,class,verdict,consensus,inputs");
    expect(itemRows).toHaveLength(data.resources.filter((r) => r.type === "item" && r.state === "closed").length);
    expect(reads.goldsCsv.split(/\n/)[0]).toBe("image_url,verdict,consensus,inputs");
    expect(reads.goldsCsv).not.toContain("expected");
  });

  it("hands the campaign back to the hand-written flow just as cleanly", () => {
    expect(roundTrip.transcript).toEqual(handWritten.transcript);
    expect(roundTrip.data).toEqual(handWritten.data);
  });
});
