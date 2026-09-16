import type { BlobRecord, BlobRepository, StoredBlob } from "../database-service/repositories/index.js";

export type { BlobRecord, StoredBlob } from "../database-service/repositories/index.js";

/**
 * Capacité `blobs` — des fichiers opaques
 * ---------------------------------------
 * Un flow range un fichier et n'en garde qu'une référence (`blob_id`, type,
 * taille) : jamais d'octets dans une charge JSON ni dans un contexte de claim.
 * La rétention se déclare au stockage — tant de jours après la fermeture du
 * challenge — et le tick la purge (`core.blobs.retention`) : les octets
 * partent, les métadonnées restent.
 *
 * La capacité ne décide pas qui lit : un flow protège la référence par la
 * visibilité du champ qui la porte. Le backend v1 est Postgres (`bytea`) ;
 * l'interface ne dit rien du stockage, un backend objet peut la reprendre.
 */

export type BlobStore = Pick<BlobRepository, "create" | "find" | "delete" | "purgeExpired">;

/** Au-delà, `store` refuse : un blob n'est pas une archive. */
export const MAX_BLOB_BYTES = 10 * 1024 * 1024;

export class BlobTooLargeError extends Error {
  constructor(readonly size: number) {
    super(`Blob of ${size} bytes exceeds ${MAX_BLOB_BYTES}`);
  }
}

/** Une référence : ce qu'un flow stocke à la place du fichier. */
export interface BlobRef {
  blob_id: string;
  content_type: string;
  filename: string | null;
  size: number;
}

async function defaultStore(): Promise<BlobStore> {
  const { BlobRepository } = await import("../database-service/repositories/index.js");
  return new BlobRepository();
}

export const refOf = (record: BlobRecord): BlobRef => ({
  blob_id: record.uuid,
  content_type: record.content_type,
  filename: record.filename,
  size: record.size,
});

export function blobs(store?: BlobStore) {
  const storeOf = async () => store ?? defaultStore();

  return {
    async store(input: {
      challengeId: string | null;
      bytes: Buffer;
      contentType: string;
      filename?: string | null;
      /** Jours de conservation après la fermeture du challenge ; absent : pas de purge. */
      retentionDays?: number | null;
    }): Promise<BlobRef> {
      if (input.bytes.length > MAX_BLOB_BYTES) throw new BlobTooLargeError(input.bytes.length);
      const record = await (await storeOf()).create({
        challengeId: input.challengeId,
        contentType: input.contentType,
        filename: input.filename ?? null,
        bytes: input.bytes,
        retentionDays: input.retentionDays ?? null,
      });
      return refOf(record);
    },

    /** Le blob et ses octets ; `null` s'il n'existe pas. Un blob purgé revient avec `bytes: null`. */
    async get(blobId: string): Promise<StoredBlob | null> {
      return (await storeOf()).find(blobId);
    },

    async delete(blobId: string): Promise<boolean> {
      return (await storeOf()).delete(blobId);
    },

    async purgeExpired(now = new Date()): Promise<number> {
      return (await storeOf()).purgeExpired(now);
    },
  };
}

export type Blobs = ReturnType<typeof blobs>;
