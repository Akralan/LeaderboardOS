import { describe, it, expect } from "vitest";
import { BlobTooLargeError, MAX_BLOB_BYTES, blobs, type BlobStore } from "./blobs.js";
import type { StoredBlob } from "../database-service/repositories/index.js";

/** Un store en mémoire : la capacité se vérifie sans base, sa purge sur Postgres (`blobs.integration.test.ts`). */
function memoryStore(): BlobStore & { rows: StoredBlob[] } {
  const rows: StoredBlob[] = [];
  return {
    rows,
    async create(values) {
      const row: StoredBlob = {
        uuid: `blob-${rows.length + 1}`,
        challenge_id: values.challengeId,
        content_type: values.contentType,
        filename: values.filename,
        size: values.bytes.length,
        bytes: values.bytes,
        retention_days: values.retentionDays,
        created_at: new Date(),
        purged_at: null,
      };
      rows.push(row);
      const { bytes: _bytes, ...record } = row;
      return record;
    },
    async find(blobId) {
      return rows.find((row) => row.uuid === blobId) ?? null;
    },
    async delete(blobId) {
      const index = rows.findIndex((row) => row.uuid === blobId);
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    },
    async purgeExpired() {
      return 0;
    },
  };
}

describe("blobs", () => {
  it("stores a file and hands back a reference, never the bytes", async () => {
    const store = memoryStore();
    const ref = await blobs(store).store({
      challengeId: "c1",
      bytes: Buffer.from("hello"),
      contentType: "text/plain",
      filename: "hello.txt",
      retentionDays: 365,
    });
    expect(ref).toEqual({ blob_id: "blob-1", content_type: "text/plain", filename: "hello.txt", size: 5 });
    expect("bytes" in ref).toBe(false);
    expect((await blobs(store).get(ref.blob_id))?.bytes?.toString()).toBe("hello");
    expect(store.rows[0].retention_days).toBe(365);
  });

  it("refuses a file larger than the limit before writing anything", async () => {
    const store = memoryStore();
    await expect(
      blobs(store).store({ challengeId: null, bytes: Buffer.alloc(MAX_BLOB_BYTES + 1), contentType: "application/octet-stream" })
    ).rejects.toBeInstanceOf(BlobTooLargeError);
    expect(store.rows).toEqual([]);
  });

  it("deletes a blob once", async () => {
    const store = memoryStore();
    const ref = await blobs(store).store({ challengeId: null, bytes: Buffer.from("x"), contentType: "text/plain" });
    expect(await blobs(store).delete(ref.blob_id)).toBe(true);
    expect(await blobs(store).delete(ref.blob_id)).toBe(false);
    expect(await blobs(store).get(ref.blob_id)).toBeNull();
  });
});
