import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, inArray } from "drizzle-orm";
import type { Challenge } from "../../../packages/database-service/domain/entities.js";
import { config } from "../../../packages/config/index.js";
import { challenges, contributions, db, user_qualifications } from "../../../packages/database-service/db/drizzle.js";
import { ChallengeRepository, RewardEntryRepository } from "../../../packages/database-service/repositories/index.js";
import { ReferenceCaseRepository } from "../../../packages/database-service/repositories/referenceCase.repo.js";
import { ValidationTargetRepository } from "../../../packages/database-service/repositories/validationTarget.repo.js";
import { integrationScope } from "../../../packages/database-service/testing/integration.js";
import { hasQualification } from "../../../packages/capabilities/qualifications.js";
import { resources } from "../../../packages/capabilities/resources.js";
import { dispatchChallengeAction } from "../../../packages/capabilities/challenge-actions.js";
import { PlatformRegistry } from "../../../packages/registry/platform.js";
import { platform, MEDICAL_PRO } from "../../../apps/leaderboard-client/src/distribution/mytwin.platform.js";

/**
 * J5 — endpoint-check face au flow écrit à la main, sur Postgres
 * --------------------------------------------------------------
 * Un retrait par attrition : pas de relais en vol, les deux implémentations ne
 * partagent aucune donnée. L'équivalence est comportementale, sur des
 * challenges neufs, deux démarrages : la même campagne — exposer, écrire les
 * cas, réclamer en appelant un vrai endpoint local, observer, révéler, voter —
 * se joue une fois sur chaque flow, et doit rendre les mêmes refus, les mêmes
 * octets, la même résolution et le même ledger (par personne, dans l'ordre).
 *
 * Une divergence assumée, qui corrige l'ancien flow : lire le résultat attendu
 * avant l'observation. Le flow écrit à la main répond 400 (« l'étape manque ») :
 * il dit que le fichier existe, pas encore pour toi — une micro-fuite. Le
 * template répond 404 : sous « politique ou grant », un champ non accordé
 * n'existe pas pour le lecteur. Le test l'affirme de chaque côté, hors comparaison.
 */

type Implementation = "hand-written" | "template";
type Outcome = { status: number; body: any; headers: Headers };

const FLOW_CONFIG = { cp_per_validation: 10, required_validations: 3, reviewer_qualification: MEDICAL_PRO };
const QUALIFIED = ["author", "r1", "r2", "r3"];

let people: Record<string, string>;
let endpoint: string;
let server: Server;
const scope = integrationScope();
const privateEndpoints = config.validation as { allowPrivateEndpoints: boolean };
const previousPrivate = privateEndpoints.allowPrivateEndpoints;

/**
 * Un démarrage de la distribution MyTwin telle qu'elle est livrée : le flow écrit
 * à la main y est retiré mais installé — il sert ses challenges —, le template
 * y sert les nouveaux. Chaque campagne redémarre le registre.
 */
function boot() {
  PlatformRegistry.reset();
  PlatformRegistry.install(platform);
}

async function call(challenge: Challenge, user: string, actionPath: string, init: { method?: string; json?: unknown; form?: FormData } = {}): Promise<Outcome> {
  const method = init.method ?? "POST";
  const response = await dispatchChallengeAction(
    {
      request: new Request(`http://localhost/api/challenges/${challenge.uuid}/flow/${actionPath}`, {
        method,
        ...(init.form ? { body: init.form } : {}),
        ...(init.json !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.json) } : {}),
      }),
      challengeId: challenge.uuid,
      scope: { kind: "flow" },
      segments: actionPath.split("?")[0].split("/"),
      user: { id: people[user], role: user === "admin" ? "admin" : "contributor" },
    },
    {
      findChallenge: async (id) => new ChallengeRepository().findById(id),
      isManager: async () => false,
      // Aucun relecteur n'est membre : ni l'un ni l'autre flow ne le demande.
      isMember: async () => false,
      holds: async (userId, qualification) => hasQualification(userId, qualification),
    }
  );
  const type = response.headers.get("Content-Type") ?? "";
  const body = type.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer()).toString("utf8");
  return { status: response.status, body, headers: response.headers };
}

/** Les gestes d'un validateur, sous les noms de chaque implémentation. */
interface Adapter {
  expose(contributionId: string, url: string): Promise<number>;
  writeCase(user: string, input: string, expected: string): Promise<number>;
  caseIds(): Promise<string[]>;
  claim(user: string, contributionId: string, caseId: string): Promise<{ status: number; claim: string | null; response: string | null }>;
  observe(user: string, claim: string, text: string): Promise<number>;
  reveal(user: string, claim: string): Promise<{ status: number; bytes: string | null }>;
  verdict(user: string, claim: string, contributionId: string, verdict: "works" | "broken", description: string): Promise<number>;
  outcome(contributionId: string): Promise<string>;
}

function adapter(implementation: Implementation, challenge: Challenge): Adapter {
  if (implementation === "hand-written") {
    const targetOf = async (contributionId: string) => (await new ValidationTargetRepository().findByChallengeAndContribution(challenge.uuid, contributionId))?.uuid ?? "missing";
    return {
      expose: async (contribution_id, live_endpoint_url) =>
        (await call(challenge, "admin", "targets", { json: { contribution_id, live_endpoint_url } })).status,
      async writeCase(user, input, expected) {
        const form = new FormData();
        form.append("input", new Blob([input], { type: "text/plain" }), "input.txt");
        form.append("expected_output", new Blob([expected], { type: "text/plain" }), "expected.txt");
        return (await call(challenge, user, "reference-cases", { form })).status;
      },
      caseIds: async () => (await new ReferenceCaseRepository().findByChallenge(challenge.uuid)).map((c) => c.uuid),
      async claim(user, contributionId, caseId) {
        const result = await call(challenge, user, `targets/${await targetOf(contributionId)}/claim`, { json: { reference_case_id: caseId } });
        const ok = result.status === 200;
        return { status: result.status, claim: ok ? result.headers.get("X-Claim-Id") : null, response: ok ? result.body : null };
      },
      observe: async (user, claim, observation) => (await call(challenge, user, `case-claims/${claim}/observation`, { json: { observation } })).status,
      async reveal(user, claim) {
        const result = await call(challenge, user, `case-claims/${claim}/reveal`);
        return { status: result.status, bytes: result.status === 200 ? result.body : null };
      },
      verdict: async (user, claim, contribution_id, verdict, description) =>
        (await call(challenge, user, "verdicts", { json: { contribution_id, verdict, description, reference_case_claim_id: claim } })).status,
      outcome: async (contributionId) => (await new ValidationTargetRepository().findByChallengeAndContribution(challenge.uuid, contributionId))?.outcome ?? "missing",
    };
  }

  const asFile = (text: string, filename: string) => ({ content_base64: Buffer.from(text).toString("base64"), content_type: "text/plain", filename });
  const targetOf = async (contributionId: string) => {
    const targets = await resources().list({ challengeId: challenge.uuid, type: "target" });
    return targets.find((target) => target.payload.contribution === contributionId);
  };
  return {
    expose: async (contribution, endpoint_url) => (await call(challenge, "admin", "admin/expose", { json: { contribution, endpoint_url } })).status,
    writeCase: async (user, input, expected) =>
      (await call(challenge, user, "author/submit_case", { json: { input: asFile(input, "input.txt"), expected_output: asFile(expected, "expected.txt") } })).status,
    caseIds: async () =>
      (await resources().list({ challengeId: challenge.uuid, type: "reference_case" }))
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
        .map((instance) => instance.uuid),
    async claim(user, contributionId, caseId) {
      const result = await call(challenge, user, "reviewer/pick", { json: { target: (await targetOf(contributionId))?.uuid ?? "missing", case: caseId } });
      if (result.status !== 200) return { status: result.status, claim: null, response: null };
      const claim = result.body.claim.claim_id as string;
      const bytes = await call(challenge, user, `reviewer/file?claim_id=${claim}&path=context.probe.response.response`, { method: "GET" });
      return { status: 200, claim, response: bytes.body };
    },
    observe: async (user, claim, text) => (await call(challenge, user, "reviewer/observation", { json: { claim_id: claim, text } })).status,
    async reveal(user, claim) {
      const result = await call(challenge, user, `reviewer/file?claim_id=${claim}&path=resource.expected_output`, { method: "GET" });
      return { status: result.status, bytes: result.status === 200 ? result.body : null };
    },
    verdict: async (user, claim, _contributionId, verdict, description) =>
      (await call(challenge, user, "reviewer/verdict", { json: { claim_id: claim, verdict, description } })).status,
    async outcome(contributionId) {
      const target = await targetOf(contributionId);
      return target ? (target.state === "closed" ? target.verdict ?? "closed" : "pending") : "missing";
    },
  };
}

/** Une campagne complète ; ce qu'elle rend, normalisé : statuts, octets, résolution, ledger. */
async function campaign(implementation: Implementation) {
  boot();
  const source = await scope.challenge({ type: "ml", pool: 0, flowConfig: {}, rewardRules: null });
  const type = implementation === "hand-written" ? "endpoint-validation" : "endpoint-check";
  const challenge = await scope.challenge({ type, pool: 15, flowConfig: FLOW_CONFIG, rewardRules: null });
  await db.update(challenges).set({ source_challenge_id: source.uuid }).where(eq(challenges.uuid, challenge.uuid));
  const fresh = (await new ChallengeRepository().findById(challenge.uuid))!;
  const [dev, own, down, other] = await db
    .insert(contributions)
    .values([
      { title: "model", type: "api_packaging", user_id: people.dev, challenge_id: source.uuid },
      { title: "r1 model", type: "api_packaging", user_id: people.r1, challenge_id: source.uuid },
      { title: "down model", type: "api_packaging", user_id: people.dev, challenge_id: source.uuid },
      { title: "other model", type: "api_packaging", user_id: people.dev, challenge_id: source.uuid },
    ])
    .returning({ uuid: contributions.uuid });
  const api = adapter(implementation, fresh);
  const ok = (status: number) => (status >= 200 && status < 300 ? "ok" : status);
  const trace: Record<string, unknown> = {};

  trace.expose = [
    ok(await api.expose(dev.uuid, `${endpoint}/predict`)),
    ok(await api.expose(dev.uuid, `${endpoint}/predict`)),
    ok(await api.expose(own.uuid, `${endpoint}/predict`)),
    ok(await api.expose(down.uuid, "http://127.0.0.1:9/predict")),
    ok(await api.expose(other.uuid, `${endpoint}/predict`)),
  ];
  trace.cases = [
    ok(await api.writeCase("author", "scan 1", "tumor")),
    ok(await api.writeCase("author", "scan 2", "tumor")),
    ok(await api.writeCase("author", "plain 3", "normal")),
    ok(await api.writeCase("author", "scan 4", "tumor")),
    ok(await api.writeCase("outsider", "scan 5", "tumor")),
  ];
  const cases = await api.caseIds();

  const refusals = {
    outsider: (await api.claim("outsider", dev.uuid, cases[0])).status,
    ownSubmission: (await api.claim("r1", own.uuid, cases[0])).status,
    ownCase: (await api.claim("author", dev.uuid, cases[0])).status,
    unreachable: (await api.claim("r1", down.uuid, cases[0])).status,
  };
  trace.refusals = refusals;

  const first = await api.claim("r1", dev.uuid, cases[0]);
  trace.firstClaim = { status: first.status, response: first.response };
  trace.taken = (await api.claim("r2", dev.uuid, cases[0])).status;
  trace.verdictTooEarly = await api.verdict("r1", first.claim!, dev.uuid, "works", "early");
  trace.revealTooEarly = (await api.reveal("r1", first.claim!)).status;
  trace.observe = [ok(await api.observe("r1", first.claim!, "tumor seen")), await api.observe("r1", first.claim!, "again")];
  trace.reveal = await api.reveal("r1", first.claim!);
  trace.reveal2 = (await api.reveal("r2", first.claim!)).status >= 400;

  const run = async (user: string, caseId: string, verdict: "works" | "broken", target = dev.uuid) => {
    const claimed = await api.claim(user, target, caseId);
    if (claimed.status !== 200) return [claimed.status];
    return [ok(await api.observe(user, claimed.claim!, "seen")), (await api.reveal(user, claimed.claim!)).bytes, ok(await api.verdict(user, claimed.claim!, target, verdict, "because"))];
  };
  trace.firstVerdict = ok(await api.verdict("r1", first.claim!, dev.uuid, "works", "matches"));
  // Un second vote sur la même cible : sur une autre cible, pour ne pas bloquer un cas de celle qu'on résout.
  trace.otherTarget = [await run("r1", cases[0], "broken", other.uuid), await run("r1", cases[1], "broken", other.uuid)];
  trace.pendingAfterOne = await api.outcome(dev.uuid);
  trace.r2 = await run("r2", cases[1], "broken");
  trace.r3 = await run("r3", cases[2], "works");
  trace.outcome = await api.outcome(dev.uuid);

  const ledger = await new RewardEntryRepository().findByChallenge(fresh.uuid);
  trace.ledger = ledger
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
    .map((row) => [Object.entries(people).find(([, id]) => id === row.user_id)?.[0], row.points]);
  return trace;
}

beforeAll(async () => {
  privateEndpoints.allowPrivateEndpoints = true;
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end(Buffer.concat(chunks).toString("utf8").includes("scan") ? "tumor" : "normal");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  people = await scope.users(["admin", "author", "r1", "r2", "r3", "outsider", "dev"]);
  await db.insert(user_qualifications).values(QUALIFIED.map((name) => ({ user_id: people[name], key: MEDICAL_PRO })));
});

afterAll(async () => {
  privateEndpoints.allowPrivateEndpoints = previousPrivate;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (people) await db.delete(user_qualifications).where(inArray(user_qualifications.user_id, Object.values(people)));
  await scope.cleanup();
  boot();
});

describe("endpoint-check against the hand-written endpoint-validation, on Postgres", () => {
  it("plays the same campaign to the same refusals, bytes, resolution and ledger", async () => {
    const handWritten = await campaign("hand-written");
    const template = await campaign("template");

    expect(handWritten.refusals).toEqual({ outsider: 403, ownSubmission: 403, ownCase: 403, unreachable: 502 });
    expect(handWritten.firstClaim).toEqual({ status: 200, response: "tumor" });
    expect(handWritten.outcome).toBe("works");
    expect(handWritten.ledger).toEqual([["r1", 10], ["r3", 5]]);
    // La divergence assumée : 400 à la main, 404 dans le template ; tout le reste est identique.
    const { revealTooEarly: handWrittenEarly, ...handWrittenRest } = handWritten;
    const { revealTooEarly: templateEarly, ...templateRest } = template;
    expect([handWrittenEarly, templateEarly]).toEqual([400, 404]);
    expect(templateRest).toEqual(handWrittenRest);
  });
});
