import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Challenge } from "../database-service/domain/entities.js";
import { PlatformRegistry } from "../registry/platform.js";
import { dispatchChallengeAction, type ActionDispatchDeps } from "../capabilities/challenge-actions.js";
import { CompileError, checkTemplateSource, compileTemplate } from "./index.js";
import { memoryRuntime, type MemoryRuntime } from "./testing/memory-runtime.js";

/**
 * J2 — un template compilé, installé, exécuté de bout en bout
 * -----------------------------------------------------------
 * Le template passe par `compileTemplate`, s'installe dans le registre comme
 * n'importe quel flow, et se sert par le dispatcher d'actions du core. Seul le
 * port d'exécution est en mémoire.
 */

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "conformance");
const source = (id: string) => readFileSync(path.join(DIR, `${id}.yaml`), "utf8");

const ADMIN = { id: "admin", role: "admin" };

function dispatcher(challenge: Challenge, qualifications: Record<string, string[]> = {}) {
  const deps: ActionDispatchDeps = {
    findChallenge: async () => challenge,
    isManager: async () => false,
    isMember: async () => true,
    holds: async (userId, qualification) => Boolean(qualification && qualifications[userId]?.includes(qualification)),
  };
  return async (user: { id: string; role: string }, actionPath: string, body: unknown) => {
    const response = await dispatchChallengeAction(
      {
        request: new Request(`http://localhost/api/challenges/${challenge.uuid}/flow/${actionPath}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        challengeId: challenge.uuid,
        scope: { kind: "flow" },
        segments: actionPath.split("/"),
        user,
      } as never,
      deps
    );
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
}

afterAll(() => PlatformRegistry.reset());

describe("compiling data-annotation", () => {
  let runtime: MemoryRuntime;
  let challenge: Challenge;
  let call: ReturnType<typeof dispatcher>;

  beforeEach(() => {
    runtime = memoryRuntime();
    const flow = compileTemplate(checkTemplateSource(source("data-annotation"), "data-annotation"), { runtime, icon: "tag" });
    PlatformRegistry.reset();
    PlatformRegistry.install({ flows: [flow] });
    challenge = {
      uuid: "11111111-1111-4111-8111-111111111111",
      title: "Mammography",
      slug: "mammography",
      status: "active",
      type: "data-annotation",
      contribution_points_reward: 100,
      completion: 0,
      project_id: "project-1",
      flow_config: { redundancy: 3 },
      flow_config_version: 1,
      reward_rules: { per_unit: 5, gold_rate: 0.1, clearance: { min_seen: 1, min_accuracy: 0.5 }, audit_rate: 1 },
      created_at: new Date(),
    } as Challenge;
    runtime.challenges.push(challenge);
    call = dispatcher(challenge);
  });

  // Le corpus déclare un vrai fichier : le lot part encodé, le serveur le lit.
  const asFile = (rows: unknown) => ({ content_base64: Buffer.from(JSON.stringify(rows)).toString("base64"), content_type: "application/json", filename: "batch.json" });

  const importBatches = async () => {
    const items = await call(ADMIN, "import/batch", {
      kind: "items",
      class: "standard",
      file: asFile([{ payload: { image_url: "https://img/1.png" } }, { payload: { image_url: "https://img/2.png" } }]),
    });
    const golds = await call(ADMIN, "import/batch", {
      kind: "golds",
      class: "standard",
      file: asFile([{ payload: { image_url: "https://img/g.png" }, expected: "mass" }]),
    });
    return { items, golds };
  };

  it("declares what the core reads: config, rules, rule keys, actions, the audit job", () => {
    const flow = PlatformRegistry.flow("data-annotation")!;
    expect(flow.actions!.map((action) => `${action.method} ${action.path}`)).toEqual([
      "POST import/batch",
      "POST annotator",
      "POST annotator/label",
      "POST annotator/release",
      "GET progress",
      "GET overview",
      "GET annotator/claim",
      "GET annotator/file",
      "GET file",
      "GET mine",
      "GET resources",
      "GET export",
    ]);
    expect(flow.jobs!.map((job) => [job.key, job.schedule])).toEqual([["data-annotation.audit", "0 4 * * 1"]]);
    expect(PlatformRegistry.ruleKeys().map((key) => [key.key, key.consumesPool])).toEqual([
      ["data-annotation.annotator.pay", true],
      ["clawback", true],
    ]);
    expect(flow.rules!.parse({ per_unit: 5, gold_rate: 0.1, clearance: { min_seen: 1, min_accuracy: 0.5 }, audit_rate: 0.1 })).not.toBeNull();
    expect(flow.rules!.parse({ per_unit: "five" })).toBeNull();
  });

  it("imports items and golds through a branching gate, admin only", async () => {
    const { items, golds } = await importBatches();
    expect([items.status, golds.status]).toEqual([200, 200]);
    expect(runtime.instances.map((instance) => [instance.resource_type, instance.class])).toEqual([
      ["item", "standard"],
      ["item", "standard"],
      ["gold", null],
    ]);
    expect((await call({ id: "u1", role: "contributor" }, "import/batch", { kind: "items", class: "standard", file: [] })).status).toBe(403);
  });

  it("substitutes a gold, hides its type and its expected answer, and pays by accuracy", async () => {
    await importBatches();
    const u1 = { id: "u1", role: "contributor" };

    runtime.dice.push(0.05); // sous gold_rate : un gold
    const drawn = await call(u1, "annotator", {});
    expect(drawn.status).toBe(200);
    expect(drawn.body.claim.resource).toEqual({ id: expect.stringMatching(/^gold-/), payload: { image_url: "https://img/g.png" } });

    // Tirer encore rend la même réclamation.
    expect((await call(u1, "annotator", {})).body.claim.claim_id).toBe(drawn.body.claim.claim_id);

    const labeled = await call(u1, "annotator/label", { claim_id: drawn.body.claim.claim_id, value: "mass" });
    expect(labeled).toEqual({ status: 200, body: { ok: true, cp_awarded: 5 } });
    // La forme du flow écrit à la main : les champs du geste, à plat ; la métrique se rejoue.
    expect(runtime.claims[0].result).toEqual({ value: "mass" });

    // Le même geste rejoué est refusé, sans seconde paie.
    const replay = await call(u1, "annotator/label", { claim_id: drawn.body.claim.claim_id, value: "mass" });
    expect(replay.status).toBe(409);
    expect(runtime.ledgerRows).toHaveLength(1);

    // Un mauvais gold fait tomber la précision : 1 juste sur 2.
    runtime.instances.push({ ...runtime.instances[2], uuid: "gold-x", payload: { image_url: "g2", expected: "calc" } });
    runtime.dice.push(0.05);
    const second = await call(u1, "annotator", {});
    const wrong = await call(u1, "annotator/label", { claim_id: second.body.claim.claim_id, value: "mass" });
    expect(wrong.body.cp_awarded).toBe(3); // round(5 × 1/2)
  });

  it("resolves an item by agreement at k labels and closes it", async () => {
    await importBatches();
    const label = async (user: string, value: string) => {
      const drawn = await call({ id: user, role: "contributor" }, "annotator", {});
      return call({ id: user, role: "contributor" }, "annotator/label", { claim_id: drawn.body.claim.claim_id, value });
    };
    await label("u1", "mass");
    await label("u2", "mass");
    expect(runtime.instances[0].state).toBe("open");
    await label("u3", "calc");

    expect(runtime.instances[0]).toMatchObject({ state: "closed", verdict: "labeled", resolution: { consensus: "mass" } });
    expect(runtime.ledgerRows.map((row) => [row.user_id, row.points])).toEqual([["u1", 5], ["u2", 5], ["u3", 5]]);
  });

  it("refuses a claim that is not the caller's, and a missing field", async () => {
    await importBatches();
    const drawn = await call({ id: "u1", role: "contributor" }, "annotator", {});
    expect((await call({ id: "u2", role: "contributor" }, "annotator/label", { claim_id: drawn.body.claim.claim_id, value: "x" })).status).toBe(404);
    expect((await call({ id: "u1", role: "contributor" }, "annotator/label", { claim_id: drawn.body.claim.claim_id })).status).toBe(400);
  });

  it("audits closed items once: clawback on the disagreeing label, never twice", async () => {
    await importBatches();
    for (const [user, value] of [["u1", "mass"], ["u2", "mass"], ["u3", "calc"]]) {
      const drawn = await call({ id: user, role: "contributor" }, "annotator", {});
      await call({ id: user, role: "contributor" }, "annotator/label", { claim_id: drawn.body.claim.claim_id, value });
    }
    const audit = PlatformRegistry.flow("data-annotation")!.jobs![0];

    expect(await audit.run()).toEqual({ challenges: 1, instances: 1, ran: 1 });
    expect(runtime.ledgerRows.filter((row) => row.rule_key === "clawback").map((row) => [row.user_id, row.points])).toEqual([["u3", -5]]);

    await audit.run();
    expect(runtime.ledgerRows.filter((row) => row.rule_key === "clawback")).toHaveLength(1);
  });
});

const TOY = `
format: leaderboardos/1
template: {id: toy-graded, version: 1.0.0, name: Toy graded, summary: "A probe, a grade, a clamped pay."}
params:
  pool:      {type: points, mutable: false}
  rate:      {type: number, mutable: true}
  min_score: {type: number, mutable: true}
  reviewer:  {type: role, mutable: false}
  grid:      {type: grid_ref, mutable: false}
requires: {core: 1}
lanes:
  - id: submit
    entry: {trigger: user, access: {mode: role, role: params.reviewer}}
    nodes:
      - collect: {id: entry, fields: {url: {type: url}}}
      - act: {id: probe, kind: observer, capability: http_proxy, to: entry.url}
      - gate: {id: live, all: ["probe.status == 200"]}
      - assess: {id: grade, kind: ai_grid, grid: params.grid, input: [entry.url]}
      - gate: {id: floor, all: ["grade.score >= params.min_score"]}
      - reward: {id: pay, amount: "params.rate * grade.score", pool: params.pool, clamp: pool}
`;

describe("compiling a toy template over evaluate, observers, qualifications and the pool", () => {
  let runtime: MemoryRuntime;
  let call: ReturnType<typeof dispatcher>;
  const scores: number[] = [];
  const statuses: number[] = [];

  beforeEach(() => {
    scores.length = 0;
    statuses.length = 0;
    runtime = memoryRuntime({
      evaluate: async () => scores.shift() ?? 0,
      observe: async (capability, args) => ({ status: statuses.shift() ?? 200, ok: true, body: { capability, to: args.to } }),
    });
    PlatformRegistry.reset();
    PlatformRegistry.install({ flows: [compileTemplate(checkTemplateSource(TOY, "toy"), { runtime })] });
    const challenge = {
      uuid: "22222222-2222-4222-8222-222222222222",
      title: "Toy",
      slug: "toy",
      status: "active",
      type: "toy-graded",
      contribution_points_reward: 100,
      completion: 0,
      project_id: "project-1",
      flow_config: { reviewer: "medical_pro", grid: "code@1" },
      flow_config_version: 1,
      reward_rules: { rate: 10, min_score: 5 },
      created_at: new Date(),
    } as Challenge;
    call = dispatcher(challenge, { pro: ["medical_pro"] });
  });

  const pro = { id: "pro", role: "contributor" };

  it("gates the lane on the qualification the config names", async () => {
    expect((await call({ id: "anon", role: "contributor" }, "submit/entry", { url: "https://x.dev" })).status).toBe(403);
  });

  it("grades, pays rate × score, and clamps the pay to what is left in the pool", async () => {
    scores.push(8, 9);
    expect((await call(pro, "submit/entry", { url: "https://x.dev" })).body).toEqual({ ok: true, cp_awarded: 80 });
    expect(runtime.evaluations[0]).toMatchObject({ grid: "code@1", inputs: ["https://x.dev"] });
    expect((await call(pro, "submit/entry", { url: "https://y.dev" })).body).toEqual({ ok: true, cp_awarded: 20 });
  });

  it("refuses without side effect when a gate fails", async () => {
    statuses.push(500);
    expect(await call(pro, "submit/entry", { url: "https://down.dev" })).toEqual({ status: 422, body: { error: "Refused by live" } });
    scores.push(3);
    expect((await call(pro, "submit/entry", { url: "https://x.dev" })).status).toBe(422);
    expect(runtime.ledgerRows).toEqual([]);
  });

  it("validates the gesture against the declared field types", async () => {
    expect((await call(pro, "submit/entry", { url: 42 })).status).toBe(400);
  });
});

describe("what the compiler refuses", () => {
  it("a template that uses what v1 does not compile", () => {
    expect(() => compileTemplate(checkTemplateSource(source("bug-bounty"), "bug-bounty"), { runtime: memoryRuntime() })).toThrow(CompileError);
  });

  it("an invalid template", () => {
    expect(() => compileTemplate(checkTemplateSource("format: leaderboardos/1\n", "empty"))).toThrow("is not valid");
  });
});
