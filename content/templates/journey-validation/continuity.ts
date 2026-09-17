import { sql } from "drizzle-orm";
import { db } from "../../../packages/database-service/db/drizzle.js";

/**
 * La continuité du flow journey-validation (parité P4)
 * ----------------------------------------------------
 * Ce que le flow écrit à la main a rangé dans ses tables, copié en ressources
 * du template sous les mêmes identifiants : les lignes de ledger déjà payées
 * (`meta.runId`) désignent toujours la bonne walkthrough, et une walkthrough
 * brouillon se reprend là où elle s'était arrêtée. Idempotent (`ON CONFLICT
 * DO NOTHING`), non destructif : les anciennes tables restent telles quelles.
 *
 *   validation_targets        → app          {contribution, app_url}
 *   validation_scenario_steps → step         {position, title, instructions}
 *   validation_scenario_runs  → walkthrough  {app}, fermée `completed` avec `global_feedback`
 *   validation_step_feedbacks → step_result  {walkthrough, step, result, comment, medical_comment}
 */
export async function migrateJourneyChallenge(challengeId: string): Promise<{ apps: number; steps: number; walkthroughs: number; step_results: number }> {
  const apps = await db.execute(sql`
    INSERT INTO resource_instances (uuid, challenge_id, resource_type, payload, state, created_by, created_at)
    SELECT t.uuid, t.validation_challenge_id, 'app',
           jsonb_build_object('contribution', t.contribution_id::text, 'app_url', c.live_endpoint_url),
           'open', NULL, COALESCE(t.created_at, now())
    FROM validation_targets t JOIN contributions c ON c.uuid = t.contribution_id
    WHERE t.validation_challenge_id = ${challengeId}
    ON CONFLICT (uuid) DO NOTHING`);
  const steps = await db.execute(sql`
    INSERT INTO resource_instances (uuid, challenge_id, resource_type, payload, state, created_by, created_at)
    SELECT s.uuid, s.validation_challenge_id, 'step',
           jsonb_build_object('position', s.position, 'title', s.title, 'instructions', s.instructions),
           'open', NULL, COALESCE(s.created_at, now())
    FROM validation_scenario_steps s
    WHERE s.validation_challenge_id = ${challengeId}
    ON CONFLICT (uuid) DO NOTHING`);
  // Une walkthrough désigne l'app exposée pour sa contribution ; complétée, elle est fermée.
  const walkthroughs = await db.execute(sql`
    INSERT INTO resource_instances (uuid, challenge_id, resource_type, payload, state, verdict, resolution, created_by, created_at, closed_at)
    SELECT r.uuid, r.validation_challenge_id, 'walkthrough',
           jsonb_build_object('app', t.uuid::text),
           CASE WHEN r.completed_at IS NULL THEN 'open' ELSE 'closed' END,
           CASE WHEN r.completed_at IS NULL THEN NULL ELSE 'completed' END,
           CASE WHEN r.completed_at IS NULL THEN NULL ELSE jsonb_build_object('global_feedback', r.global_feedback) END,
           r.validator_user_id, COALESCE(r.created_at, now()), r.completed_at
    FROM validation_scenario_runs r
    JOIN validation_targets t ON t.validation_challenge_id = r.validation_challenge_id AND t.contribution_id = r.contribution_id
    WHERE r.validation_challenge_id = ${challengeId}
    ON CONFLICT (uuid) DO NOTHING`);
  const results = await db.execute(sql`
    INSERT INTO resource_instances (uuid, challenge_id, resource_type, payload, state, created_by, created_at)
    SELECT f.uuid, r.validation_challenge_id, 'step_result',
           jsonb_build_object('walkthrough', f.run_id::text, 'step', f.step_id::text, 'result', f.result, 'comment', f.comment, 'medical_comment', f.medical_comment),
           'open', r.validator_user_id, COALESCE(f.created_at, now())
    FROM validation_step_feedbacks f JOIN validation_scenario_runs r ON r.uuid = f.run_id
    WHERE r.validation_challenge_id = ${challengeId}
      AND EXISTS (SELECT 1 FROM validation_targets t WHERE t.validation_challenge_id = r.validation_challenge_id AND t.contribution_id = r.contribution_id)
    ON CONFLICT (uuid) DO NOTHING`);
  return { apps: apps.rowCount ?? 0, steps: steps.rowCount ?? 0, walkthroughs: walkthroughs.rowCount ?? 0, step_results: results.rowCount ?? 0 };
}
