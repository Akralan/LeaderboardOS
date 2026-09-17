import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { Challenge } from "../../../packages/database-service/domain/entities.js";
import { PlatformRegistry } from "../../../packages/registry/platform.js";
import { dispatchChallengeAction, type ActionDispatchDeps } from "../../../packages/capabilities/challenge-actions.js";
import { checkTemplateSource, compileTemplate } from "../../../packages/interpreter/index.js";
import { ObserverRefusal } from "../../../packages/interpreter/compile/runtime.js";
import { memoryRuntime, type MemoryRuntime } from "../../../packages/interpreter/testing/memory-runtime.js";
import { templateSource } from "./template.source.js";

/**
 * endpoint-check, en mémoire
 * --------------------------
 * Le parcours d'un validateur tel que le flow écrit à la main le sert : le
 * claim d'un cas appelle l'endpoint, l'observation précède le reveal, le reveal
 * ouvre le résultat attendu, le verdict alimente le quorum, la majorité est
 * payée dans l'ordre d'arrivée et bornée au pool.
 */

type User = { id: string; role: string };

const ADMIN: User = { id: "admin", role: "admin" };
const author: User = { id: "author", role: "contributor" };
const [r1, r2, r3, r4]: User[] = ["r1", "r2", "r3", "r4"].map((id) => ({ id, role: "contributor" }));
const outsider: User = { id: "outsider", role: "contributor" };
const QUALIFIED = new Set(["author", "r1", "r2", "r3", "r4"]);

function dispatcher(challenge: Challenge) {
  const deps: ActionDispatchDeps = {
    findChallenge: async () => challenge,
    isManager: async () => false,
    // Aucun relecteur n'est membre : la lane de relecture ne le demande pas, ses lectures non plus.
    isMember: async () => false,
    holds: async (userId, qualification) => qualification === "medical_pro" && QUALIFIED.has(userId),
  };
  const send = async (method: "GET" | "POST", user: User, actionPath: string, body?: unknown) => {
    const response = await dispatchChallengeAction(
      {
        request: new Request(`http://localhost/api/challenges/${challenge.uuid}/flow/${actionPath}`, {
          method,
          ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
        }),
        challengeId: challenge.uuid,
        scope: { kind: "flow" },
        segments: actionPath.split("?")[0].split("/"),
        user,
      } as never,
      deps
    );
    const json = (response.headers.get("Content-Type") ?? "").includes("json");
    return { status: response.status, body: (json ? await response.json() : await response.text()) as any };
  };
  return {
    post: (user: User, path: string, body: unknown) => send("POST", user, path, body),
    get: (user: User, path: string) => send("GET", user, path),
  };
}

const asFile = (text: string, filename: string) => ({
  content_base64: Buffer.from(text).toString("base64"),
  content_type: "text/plain",
  filename,
});

afterAll(() => PlatformRegistry.reset());

describe("endpoint-check, a reviewer's run", () => {
  let runtime: MemoryRuntime;
  let api: ReturnType<typeof dispatcher>;
  let probes: unknown[];
  let down: boolean;
  let answer: number;

  beforeEach(() => {
    probes = [];
    down = false;
    answer = 200;
    runtime = memoryRuntime({
      observe: async (_capability, args, rt) => {
        if (down) throw new ObserverRefusal(502, "The API did not respond correctly: unreachable");
        probes.push(args.to);
        const response = await rt.blobs.store({ challengeId: "c-check", bytes: Buffer.from("tumor"), contentType: "text/plain", retentionDays: 365 });
        return { status: answer, ok: answer < 300, content_type: "text/plain", response: response as never };
      },
    });
    PlatformRegistry.reset();
    PlatformRegistry.install({ flows: [compileTemplate(checkTemplateSource(templateSource, "endpoint-check"), { runtime })] });
    const challenge = {
      uuid: "c-check",
      title: "Check",
      slug: "check",
      status: "active",
      type: "endpoint-check",
      contribution_points_reward: 25,
      completion: 0,
      project_id: "project-1",
      source_challenge_id: "c-source",
      flow_config: { cp_per_validation: 10, required_validations: 3, reviewer_qualification: "medical_pro" },
      flow_config_version: 1,
      created_at: new Date(),
    } as Challenge;
    runtime.challenges.push(challenge);
    runtime.contributionRows.push(
      { id: "sub-1", author: "dev", url: "https://model.dev/predict", kind: "code", challenge: "c-source", capabilities: ["endpoint"] },
      { id: "sub-r1", author: "r1", url: "https://r1.dev/predict", kind: "code", challenge: "c-source", capabilities: ["endpoint"] },
      { id: "other", author: "dev", url: null, kind: "doc", challenge: "c-source", capabilities: [] }
    );
    api = dispatcher(challenge);
  });

  const expose = (contribution = "sub-1") =>
    api.post(ADMIN, "admin/expose", { contribution, endpoint_url: `https://${contribution}.dev/predict` });
  const writeCase = (user: User = author, n = 1) =>
    api.post(user, "author/submit_case", { input: asFile(`scan ${n}`, "scan.txt"), expected_output: asFile("tumor", "expected.txt") });
  const idOf = (type: string, n = 0) => runtime.instances.filter((instance) => instance.resource_type === type)[n].uuid;

  const fullRun = async (user: User, verdict: "works" | "broken", caseIndex: number) => {
    const picked = await api.post(user, "reviewer/pick", { target: idOf("target"), case: idOf("reference_case", caseIndex) });
    if (picked.status !== 200) return picked;
    const claimId = picked.body.claim.claim_id;
    expect((await api.post(user, "reviewer/observation", { claim_id: claimId, text: "it said tumor" })).status).toBe(200);
    return api.post(user, "reviewer/verdict", { claim_id: claimId, verdict, description: "matches" });
  };

  it("exposes eligible submissions once, managers only", async () => {
    expect((await expose()).status).toBe(200);
    expect((await expose()).status).toBe(409);
    expect((await api.post(ADMIN, "admin/expose", { contribution: "other", endpoint_url: "https://x.dev" })).status).toBe(400);
    expect((await api.post(r1, "admin/expose", { contribution: "sub-r1", endpoint_url: "https://x.dev" })).status).toBe(403);
    const options = await api.get(ADMIN, "admin/options?field=expose.contribution");
    expect(options.body.options.map((option: { id: string }) => option.id)).toEqual(["sub-r1"]);
  });

  it("caps reference cases at the quorum, qualified authors only", async () => {
    for (let n = 0; n < 3; n++) expect((await writeCase(author, n)).status).toBe(200);
    expect((await writeCase(author, 4)).status).toBe(409);
    expect((await writeCase(outsider)).status).toBe(403);
    expect(runtime.instances).toHaveLength(3);
  });

  it("claims a case by probing the endpoint, then observation, reveal, verdict", async () => {
    await expose();
    await writeCase();
    const picked = await api.post(r1, "reviewer/pick", { target: idOf("target"), case: idOf("reference_case") });
    expect(picked.status).toBe(200);
    expect(probes).toEqual(["https://sub-1.dev/predict"]);
    // Le résultat attendu reste caché jusqu'au reveal.
    expect(picked.body.claim.resource.expected_output).toBeUndefined();
    const claimId = picked.body.claim.claim_id;

    expect((await api.post(r1, "reviewer/verdict", { claim_id: claimId, verdict: "works", description: "ok" })).status).toBe(400);
    expect((await api.post(r1, "reviewer/observation", { claim_id: claimId, text: "  " })).status).toBe(400);
    expect((await api.post(r1, "reviewer/observation", { claim_id: claimId, text: "it said tumor" })).status).toBe(200);
    expect((await api.post(r1, "reviewer/observation", { claim_id: claimId, text: "again" })).status).toBe(409);

    const claim = await api.get(r1, `reviewer/claim?claim_id=${claimId}`);
    expect(claim.body.claim.resource.expected_output).toMatchObject({ filename: "expected.txt" });
    expect(await api.get(r1, `reviewer/file?claim_id=${claimId}&path=resource.expected_output`)).toEqual({ status: 200, body: "tumor" });
    expect(await api.get(r1, `reviewer/file?claim_id=${claimId}&path=context.probe.response.response`)).toEqual({ status: 200, body: "tumor" });
    expect((await api.get(r2, `reviewer/file?claim_id=${claimId}&path=resource.expected_output`)).status).toBe(404);

    const voted = await api.post(r1, "reviewer/verdict", { claim_id: claimId, verdict: "works", description: "matches" });
    expect(voted.status).toBe(200);
    expect(voted.body.cp_awarded).toBe(0);
  });

  it("refuses what the hand-written flow refuses", async () => {
    await expose();
    await expose("sub-r1");
    await writeCase(author);
    await writeCase(r2, 2);
    const target = idOf("target");
    const [authored, byR2] = [idOf("reference_case", 0), idOf("reference_case", 1)];

    expect((await api.post(outsider, "reviewer/pick", { target, case: authored })).status).toBe(403);
    expect((await api.post(ADMIN, "reviewer/pick", { target, case: authored })).status).toBe(403);
    expect((await api.post(r2, "reviewer/pick", { target, case: byR2 })).status).toBe(403);
    expect((await api.post(r1, "reviewer/pick", { target: idOf("target", 1), case: authored })).status).toBe(403);

    down = true;
    expect((await api.post(r1, "reviewer/pick", { target, case: authored })).status).toBe(502);
    expect(runtime.claims).toEqual([]);
    down = false;

    expect((await api.post(r1, "reviewer/pick", { target, case: authored })).status).toBe(200);
    expect((await api.post(r3, "reviewer/pick", { target, case: authored })).status).toBe(409);
  });

  it("lists pickable cases per target, without held combinations, with the quorum state", async () => {
    await expose();
    await writeCase(author, 0);
    await writeCase(author, 1);
    const target = idOf("target");
    await api.post(r1, "reviewer/pick", { target, case: idOf("reference_case", 0) });

    const cases = await api.get(r2, `reviewer/options?field=pick.case&target=${target}`);
    expect(cases.body.options.map((option: { id: string }) => option.id)).toEqual([idOf("reference_case", 1)]);
    expect(cases.body.options[0].expected_output).toBeUndefined();

    const targets = await api.get(r2, "reviewer/options?field=pick.target");
    expect(targets.body.options).toHaveLength(1);
    expect(targets.body.options[0]).toMatchObject({ id: target, endpoint_url: "https://sub-1.dev/predict", aggregates: { quorum: { count: 0 } } });
    expect(targets.body.options[0].aggregates.quorum.split).toBeUndefined();
  });

  it("resolves at quorum: pays the majority earliest first, and nothing late", async () => {
    await expose();
    for (let n = 0; n < 3; n++) await writeCase(author, n);
    expect((await fullRun(r1, "works", 0)).body.cp_awarded).toBe(0);
    expect((await fullRun(r2, "broken", 1)).body.cp_awarded).toBe(0);
    expect((await fullRun(r3, "works", 2)).status).toBe(200);

    const target = runtime.instances.find((instance) => instance.resource_type === "target")!;
    expect([target.state, target.verdict]).toEqual(["closed", "works"]);
    expect(runtime.ledgerRows.map((row) => [row.user_id, row.points, row.rule_key])).toEqual([
      ["r1", 10, "endpoint_check"],
      ["r3", 10, "endpoint_check"],
    ]);

    expect((await fullRun(r4, "works", 0)).status).not.toBe(200);
    expect(runtime.ledgerRows).toHaveLength(2);
  });

  it("clamps the last payee to what is left in the pool", async () => {
    await expose();
    for (let n = 0; n < 3; n++) await writeCase(author, n);
    runtime.challenges[0].contribution_points_reward = 15;
    await fullRun(r1, "works", 0);
    await fullRun(r2, "works", 1);
    await fullRun(r3, "broken", 2);
    expect(runtime.ledgerRows.map((row) => [row.user_id, row.points])).toEqual([
      ["r1", 10],
      ["r2", 5],
    ]);
  });

  it("records one verdict per reviewer per target", async () => {
    await expose();
    for (let n = 0; n < 2; n++) await writeCase(author, n);
    expect((await fullRun(r1, "works", 0)).status).toBe(200);
    expect((await fullRun(r1, "works", 1)).status).toBe(409);
  });

  // ── Parité P6 : ce que le flow écrit à la main tranchait encore seul ─────

  it("keeps a 4xx/5xx answer as a valid claim: a failing endpoint is evidence, not an outage", async () => {
    await expose();
    await writeCase();
    answer = 500;
    const picked = await api.post(r1, "reviewer/pick", { target: idOf("target"), case: idOf("reference_case") });
    expect(picked.status).toBe(200);
    expect(picked.body.claim.context.probe.response).toMatchObject({ status: 500, ok: false });
  });

  it("resolves a tie left by concurrent verdicts as broken, and pays the broken side", async () => {
    await expose();
    for (let n = 0; n < 3; n++) await writeCase(author, n);
    const target = idOf("target");
    await fullRun(r1, "works", 0);
    await fullRun(r2, "broken", 1);
    // Un verdict concurrent, livré sans avoir résolu, et un quatrième cas né d'une course sur le quota.
    runtime.claims.push({
      uuid: "raced", resource_id: idOf("reference_case", 2), challenge_id: "c-check", user_id: "r3",
      result: { verdict: "works", description: "raced" }, claimed_at: runtime.clock, expires_at: null,
      consumed_at: new Date(runtime.clock.getTime() + 10_000), released_at: null,
      scope_key: `target=${target}`, scope_exclusive: true, context: { $emits: { quorum: target }, observation: { text: "raced" } },
    });
    const [first] = runtime.instances.filter((instance) => instance.resource_type === "reference_case");
    await runtime.resources.createMany("c-check", "reference_case", [{ payload: { ...first.payload } }], { createdBy: "author" });
    runtime.clock = new Date(runtime.clock.getTime() + 60_000);

    expect((await fullRun(r4, "broken", 3)).status).toBe(200);
    const resolved = runtime.instances.find((instance) => instance.uuid === target)!;
    expect([resolved.state, resolved.verdict]).toEqual(["closed", "broken"]);
    expect(runtime.ledgerRows.map((row) => [row.user_id, row.points])).toEqual([["r2", 10], ["r4", 10]]);
  });

  it("removes a target nobody voted on and a case nobody claimed, and refuses the rest", async () => {
    await expose();
    await expose("sub-r1");
    for (let n = 0; n < 3; n++) await writeCase(author, n);
    const [voted, untouched] = [idOf("target", 0), idOf("target", 1)];
    const [claimed, free] = [idOf("reference_case", 0), idOf("reference_case", 2)];
    await fullRun(r1, "works", 0);

    expect(await api.post(ADMIN, "withdraw_target/target_removal", { target: voted })).toEqual({ status: 409, body: { error: "Cannot remove a target that already has 1 vote(s)" } });
    expect((await api.post(ADMIN, "withdraw_target/target_removal", { target: untouched })).status).toBe(200);
    expect(await api.post(ADMIN, "withdraw_case/case_removal", { case: claimed })).toEqual({ status: 409, body: { error: "Cannot remove a reference case that already has 1 claim(s)" } });
    expect((await api.post(author, "withdraw_own_case/own_case_removal", { case: claimed })).status).toBe(409);
    // Pas l'auteur : le cas n'est pas un choix.
    expect((await api.post(r2, "withdraw_own_case/own_case_removal", { case: free })).status).toBe(400);
    expect((await api.post(r2, "withdraw_case/case_removal", { case: free })).status).toBe(403);
    expect((await api.post(author, "withdraw_own_case/own_case_removal", { case: free })).status).toBe(200);
    expect(runtime.instances.map((instance) => instance.uuid)).not.toContain(free);
    expect(runtime.instances.map((instance) => instance.uuid)).not.toContain(untouched);
  });

  it("serves managers the evidence of every verdict: context, result and response bytes", async () => {
    await expose();
    for (let n = 0; n < 3; n++) await writeCase(author, n);
    await fullRun(r1, "works", 0);

    const evidence = await api.get(ADMIN, "resources?type=reference_case");
    expect(evidence.status).toBe(200);
    const claims = evidence.body.instances.flatMap((instance: { claims?: unknown[] }) => instance.claims ?? []);
    expect(claims).toEqual([
      expect.objectContaining({ user_id: "r1", result: { verdict: "works", description: "matches" }, context: expect.objectContaining({ observation: { text: "it said tumor" } }) }),
    ]);
    const claimId = claims[0].claim_id;
    expect(await api.get(ADMIN, `reviewer/file?claim_id=${claimId}&path=context.probe.response.response`)).toEqual({ status: 200, body: "tumor" });
    expect((await api.get(r2, `reviewer/file?claim_id=${claimId}&path=context.probe.response.response`)).status).toBe(404);
    expect((await api.get(r2, "resources?type=reference_case")).status).toBe(403);
  });
});
