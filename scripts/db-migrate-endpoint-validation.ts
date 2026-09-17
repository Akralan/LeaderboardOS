import { eq } from "drizzle-orm";
import { challenges, db } from "../packages/database-service/db/drizzle.js";
import { migrateEndpointValidationChallenge } from "../content/templates/endpoint-check/continuity.js";

/**
 * Fait passer les challenges endpoint-validation au template endpoint-check,
 * avec leurs données (parité P6). Idempotent : un challenge migré a changé de
 * type ; chaque challenge est une transaction. Les anciennes tables restent.
 *
 * Usage : npx tsx scripts/db-migrate-endpoint-validation.ts
 */
async function main() {
  console.log("🔁 Retraite d'endpoint-validation : → endpoint-check");
  const rows = await db.select({ uuid: challenges.uuid, title: challenges.title }).from(challenges).where(eq(challenges.type, "endpoint-validation"));
  for (const row of rows) {
    const outcome = await migrateEndpointValidationChallenge(row.uuid);
    console.log(
      outcome.migrated
        ? `  ${row.title}: ${outcome.targets} target(s), ${outcome.cases} case(s), ${outcome.claims} claim(s), ${outcome.verdicts} verdict(s)`
        : `  ${row.title}: skipped (${outcome.reason})`
    );
  }
  console.log(`✅ ${rows.length} challenge(s) checked`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
