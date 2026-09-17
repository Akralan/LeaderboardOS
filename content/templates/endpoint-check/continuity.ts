import { sql } from "drizzle-orm";
import { db } from "../../../packages/database-service/db/drizzle.js";

/**
 * La retraite d'endpoint-validation, avec continuité (parité P6)
 * --------------------------------------------------------------
 * Un challenge `endpoint-validation` passe au template `endpoint-check` : ses
 * données sont copiées dans la forme que le template lit, sous les mêmes
 * identifiants, puis son type change — en une transaction, donc tout ou rien,
 * et une seconde passe ne trouve plus rien à faire. Les anciennes tables
 * restent telles quelles ; le ledger déjà versé (`validation`) aussi.
 *
 *   validation_targets        → target          {contribution, endpoint_url}, fermée works|broken avec son consensus
 *   validation_reference_cases → reference_case  {input, expected_output} en blobs (conservés 365 jours)
 *   validation_case_claims    → resource_claims  scope target, contexte {pick, probe, observation}, grant du reveal
 *   validation_attempts       → le résultat {verdict, description} de la réclamation, livrée à la date du verdict
 *
 * Un challenge dont le source a déjà un `endpoint-check` n'est pas migré (un
 * seul challenge de validation par type et par source) : il est rendu `skipped`.
 */

const RETENTION_DAYS = 365;

export type EndpointMigration =
  | { migrated: true; targets: number; cases: number; claims: number; verdicts: number }
  | { migrated: false; reason: "not_endpoint_validation" | "source_taken" };

type Row = Record<string, unknown>;

export async function migrateEndpointValidationChallenge(challengeId: string): Promise<EndpointMigration> {
  return db.transaction(async (tx) => {
    const rows = async (query: ReturnType<typeof sql>) => (await tx.execute(query)).rows as Row[];
    const [challenge] = await rows(sql`SELECT uuid, type, source_challenge_id FROM challenges WHERE uuid = ${challengeId} FOR UPDATE`);
    if (!challenge || challenge.type !== "endpoint-validation") return { migrated: false, reason: "not_endpoint_validation" } as const;
    const [taken] = await rows(sql`SELECT 1 FROM challenges WHERE source_challenge_id = ${challenge.source_challenge_id} AND type = 'endpoint-check'`);
    if (taken) return { migrated: false, reason: "source_taken" } as const;

    const blob = async (bytes: unknown, contentType: unknown, filename: unknown, purged: unknown) => {
      const buffer = bytes instanceof Buffer ? bytes : null;
      const [inserted] = await rows(sql`
        INSERT INTO blobs (challenge_id, content_type, filename, size, bytes, retention_days, purged_at)
        VALUES (${challengeId}, ${String(contentType)}, ${filename === null ? null : String(filename)}, ${buffer?.length ?? 0},
                ${purged ? null : buffer}, ${RETENTION_DAYS}, ${purged ?? null})
        RETURNING uuid`);
      return { blob_id: String(inserted.uuid), content_type: String(contentType), filename: filename === null ? null : String(filename), size: buffer?.length ?? 0 };
    };

    // ── Cibles ───────────────────────────────────────────────────────────
    const targets = await rows(sql`
      SELECT t.uuid, t.contribution_id, t.outcome, t.resolved_at, t.created_at, c.live_endpoint_url
      FROM validation_targets t JOIN contributions c ON c.uuid = t.contribution_id
      WHERE t.validation_challenge_id = ${challengeId}`);
    const targetOf = new Map<string, string>();
    for (const target of targets) {
      targetOf.set(String(target.contribution_id), String(target.uuid));
      const resolved = target.outcome === "works" || target.outcome === "broken";
      await tx.execute(sql`
        INSERT INTO resource_instances (uuid, challenge_id, resource_type, payload, state, verdict, resolution, created_by, created_at, closed_at)
        VALUES (${target.uuid}, ${challengeId}, 'target',
                ${JSON.stringify({ contribution: String(target.contribution_id), endpoint_url: target.live_endpoint_url ?? null })}::jsonb,
                ${resolved ? "closed" : "open"}, ${resolved ? String(target.outcome) : null},
                ${resolved ? JSON.stringify({ consensus: target.outcome }) : null}::jsonb,
                NULL, ${target.created_at ?? new Date()}, ${resolved ? target.resolved_at ?? new Date() : null})`);
    }

    // ── Cas de référence ────────────────────────────────────────────────
    const cases = await rows(sql`
      SELECT uuid, author_user_id, input_bytes, input_filename, input_content_type,
             expected_output_bytes, expected_output_filename, expected_output_content_type, created_at, purged_at
      FROM validation_reference_cases WHERE validation_challenge_id = ${challengeId}`);
    for (const reference of cases) {
      const input = await blob(reference.input_bytes, reference.input_content_type, reference.input_filename, reference.purged_at);
      const expected = await blob(reference.expected_output_bytes, reference.expected_output_content_type, reference.expected_output_filename, reference.purged_at);
      await tx.execute(sql`
        INSERT INTO resource_instances (uuid, challenge_id, resource_type, payload, state, created_by, created_at)
        VALUES (${reference.uuid}, ${challengeId}, 'reference_case', ${JSON.stringify({ input, expected_output: expected })}::jsonb,
                'open', ${reference.author_user_id ?? null}, ${reference.created_at ?? new Date()})`);
    }

    // ── Réclamations, reveals et verdicts ───────────────────────────────
    const claims = await rows(sql`
      SELECT k.uuid, k.reference_case_id, k.contribution_id, k.validator_user_id, k.response_bytes, k.response_content_type,
             k.response_status, k.observation, k.revealed_at, k.created_at, k.purged_at,
             a.verdict, a.description, a.created_at AS voted_at
      FROM validation_case_claims k
      JOIN validation_reference_cases r ON r.uuid = k.reference_case_id
      LEFT JOIN validation_attempts a ON a.reference_case_claim_id = k.uuid
      WHERE r.validation_challenge_id = ${challengeId}`);
    let verdicts = 0;
    for (const claim of claims) {
      const target = targetOf.get(String(claim.contribution_id));
      if (!target) continue;
      const status = Number(claim.response_status);
      const response = await blob(claim.response_bytes, claim.response_content_type, "response", claim.purged_at);
      const voted = typeof claim.verdict === "string";
      if (voted) verdicts++;
      // La forme que le template garde sur une réclamation : le choix, l'observation de l'endpoint, le texte observé, la cible du vote.
      const context = {
        pick: { target: { $resource: target }, case: { $resource: String(claim.reference_case_id) } },
        probe: { response: { status, ok: status >= 200 && status < 300, content_type: String(claim.response_content_type), response } },
        ...(typeof claim.observation === "string" ? { observation: { text: claim.observation } } : {}),
        ...(voted ? { $emits: { quorum: target } } : {}),
      };
      await tx.execute(sql`
        INSERT INTO resource_claims (uuid, resource_id, challenge_id, user_id, result, claimed_at, consumed_at, scope_key, scope_exclusive, context)
        VALUES (${claim.uuid}, ${claim.reference_case_id}, ${challengeId}, ${claim.validator_user_id},
                ${voted ? JSON.stringify({ verdict: claim.verdict, description: claim.description ?? "" }) : null}::jsonb,
                ${claim.created_at ?? new Date()}, ${voted ? claim.voted_at ?? new Date() : null},
                ${`target=${target}`}, true, ${JSON.stringify(context)}::jsonb)`);
      // Le template ouvre le résultat attendu avec l'observation : une réclamation observée est révélée.
      if (claim.revealed_at || typeof claim.observation === "string") {
        await tx.execute(sql`
          INSERT INTO resource_field_grants (resource_id, field, participation, granted_by, created_at)
          VALUES (${claim.reference_case_id}, 'expected_output', ${claim.validator_user_id}, 'reveal', ${claim.revealed_at ?? new Date()})
          ON CONFLICT DO NOTHING`);
      }
    }

    await tx.execute(sql`UPDATE challenges SET type = 'endpoint-check' WHERE uuid = ${challengeId}`);
    return { migrated: true, targets: targets.length, cases: cases.length, claims: claims.length, verdicts } as const;
  });
}
