import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { blobs, db } from "../db/drizzle.js";

/** Ce qu'on sait d'un blob sans en lire les octets. */
export interface BlobRecord {
  uuid: string;
  challenge_id: string | null;
  content_type: string;
  filename: string | null;
  size: number;
  retention_days: number | null;
  created_at: Date;
  purged_at: Date | null;
}

/** Un blob et ses octets ; `bytes` à `null` une fois purgé. */
export interface StoredBlob extends BlobRecord {
  bytes: Buffer | null;
}

const METADATA = {
  uuid: blobs.uuid,
  challenge_id: blobs.challenge_id,
  content_type: blobs.content_type,
  filename: blobs.filename,
  size: blobs.size,
  retention_days: blobs.retention_days,
  created_at: blobs.created_at,
  purged_at: blobs.purged_at,
};

export class BlobRepository {
  async create(values: {
    challengeId: string | null;
    contentType: string;
    filename: string | null;
    bytes: Buffer;
    retentionDays: number | null;
  }): Promise<BlobRecord> {
    const [row] = await db
      .insert(blobs)
      .values({
        challenge_id: values.challengeId,
        content_type: values.contentType,
        filename: values.filename,
        size: values.bytes.length,
        bytes: values.bytes,
        retention_days: values.retentionDays,
      })
      .returning(METADATA);
    return row;
  }

  async find(blobId: string): Promise<StoredBlob | null> {
    const [row] = await db.select().from(blobs).where(eq(blobs.uuid, blobId));
    return row ?? null;
  }

  async delete(blobId: string): Promise<boolean> {
    const deleted = await db.delete(blobs).where(eq(blobs.uuid, blobId)).returning({ uuid: blobs.uuid });
    return deleted.length > 0;
  }

  /**
   * Vide les octets des blobs dont la rétention est échue : le challenge est
   * fermé depuis plus de `retention_days` jours. Les métadonnées restent.
   * Idempotente par la garde `purged_at IS NULL`. Renvoie le nombre de blobs purgés.
   */
  async purgeExpired(now: Date): Promise<number> {
    const purged = await db
      .update(blobs)
      .set({ bytes: null, purged_at: now })
      .where(
        and(
          isNull(blobs.purged_at),
          isNotNull(blobs.retention_days),
          sql`EXISTS (
            SELECT 1 FROM challenges c
            WHERE c.uuid = ${blobs.challenge_id}
              AND c.closed_at IS NOT NULL
              AND c.closed_at < ${now}::timestamp - make_interval(days => ${blobs.retention_days})
          )`
        )
      )
      .returning({ uuid: blobs.uuid });
    return purged.length;
  }
}
