import { eq } from "drizzle-orm";
import { challenges, db } from "../packages/database-service/db/drizzle.js";
import { migrateJourneyChallenge } from "../content/templates/journey-validation/continuity.js";

/**
 * Copie les données des challenges journey-validation écrits à la main en
 * ressources du template (parité P4). Idempotent et non destructif : pensé
 * pour tourner à chaque déploiement (postdeploy), les anciennes tables restent.
 *
 * Usage : npx tsx scripts/db-migrate-journey-resources.ts
 */
async function main() {
  console.log("🧭 Continuité journey-validation : tables du scénario → ressources");
  const rows = await db.select({ uuid: challenges.uuid, title: challenges.title }).from(challenges).where(eq(challenges.type, "journey-validation"));
  for (const row of rows) {
    const copied = await migrateJourneyChallenge(row.uuid);
    console.log(`  ${row.title}: ${copied.apps} app(s), ${copied.steps} step(s), ${copied.walkthroughs} walkthrough(s), ${copied.step_results} step result(s) copied`);
  }
  console.log(`✅ ${rows.length} challenge(s) checked`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
