import { describe, it, expect, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../database-service/db/drizzle.js";
import { integrationScope } from "../database-service/testing/integration.js";
import { blobs } from "./blobs.js";

/**
 * La capacité `blobs` sur Postgres : les octets aller-retour en `bytea`, et la
 * rétention comptée depuis la fermeture du challenge. Non destructif : la purge
 * ne touche que ce qui est échu, et ce test n'échoit que ses propres blobs.
 */

const scope = integrationScope();
afterAll(() => scope.cleanup());

describe("blobs on Postgres", () => {
  it("round-trips bytes and purges them once the challenge has been closed longer than the retention", async () => {
    const closed = await scope.challenge({ type: "endpoint-validation-template", pool: 0, flowConfig: {}, rewardRules: {}, status: "completed" });
    const open = await scope.challenge({ type: "endpoint-validation-template", pool: 0, flowConfig: {}, rewardRules: {} });
    await db.execute(sql`UPDATE challenges SET closed_at = now() - interval '400 days' WHERE uuid = ${closed.uuid}`);

    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    const expired = await blobs().store({ challengeId: closed.uuid, bytes, contentType: "application/octet-stream", filename: "case.bin", retentionDays: 365 });
    const kept = await blobs().store({ challengeId: closed.uuid, bytes, contentType: "application/octet-stream", retentionDays: 500 });
    const stillOpen = await blobs().store({ challengeId: open.uuid, bytes, contentType: "application/octet-stream", retentionDays: 1 });
    const forever = await blobs().store({ challengeId: closed.uuid, bytes, contentType: "application/octet-stream" });

    expect(Buffer.compare((await blobs().get(expired.blob_id))!.bytes!, bytes)).toBe(0);

    const purged = await blobs().purgeExpired();
    expect(purged).toBeGreaterThanOrEqual(1);
    const after = await blobs().get(expired.blob_id);
    expect(after).toMatchObject({ bytes: null, filename: "case.bin", size: 5 });
    expect(after!.purged_at).not.toBeNull();
    for (const ref of [kept, stillOpen, forever]) expect((await blobs().get(ref.blob_id))!.bytes).not.toBeNull();

    // Idempotente : une seconde purge ne retouche pas ce qui est déjà purgé.
    const again = await blobs().purgeExpired();
    expect((await blobs().get(expired.blob_id))!.purged_at).toEqual(after!.purged_at);
    expect(again).toBe(0);
  });
});
