import { createHash } from "node:crypto";
import { and, count, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { challenges, db, system_template_checksums, template_versions, templates } from "../db/drizzle.js";

/**
 * Les templates en base (challenge 021, T1)
 * -----------------------------------------
 * Le texte YAML fait foi. Les invariants ne sont pas tenus ici mais par la
 * base : une version publiée est immuable et strictement croissante (trigger
 * `template_versions_guard`), un seul brouillon par template (index partiel),
 * une clé kebab-case sans point (check), un challenge ne référence qu'une
 * version publiée (clé étrangère composite). Le repository traduit leurs refus.
 */

export interface TemplateRecord {
  key: string;
  name: string;
  created_by: string | null;
  created_at: Date;
  archived_at: Date | null;
}

export interface TemplateVersionRecord {
  uuid: string;
  template_key: string;
  status: "draft" | "published";
  version: string | null;
  yaml: string;
  checksum: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
  published_by: string | null;
}

export interface PublishedTemplateVersion extends TemplateVersionRecord {
  status: "published";
  version: string;
  published_at: Date;
}

/** La base a refusé l'écriture : clé prise ou invalide, version non croissante, ligne publiée touchée. */
export class TemplateStoreError extends Error {
  constructor(
    readonly reason: "key_taken" | "key_invalid" | "draft_exists" | "version_order" | "immutable" | "not_found",
    message: string
  ) {
    super(message);
  }
}

export function checksumOf(yaml: string): string {
  return createHash("sha256").update(yaml.replace(/\r\n/g, "\n")).digest("hex");
}

function pgError(error: unknown): { code?: string; constraint?: string; message: string } {
  const cause = (error as { cause?: unknown })?.cause ?? error;
  const record = cause as { code?: string; constraint?: string; message?: string };
  return { code: record?.code, constraint: record?.constraint, message: record?.message ?? String(error) };
}

function translate(error: unknown): never {
  const { code, constraint, message } = pgError(error);
  if (code === "23505" && constraint === "templates_pkey") throw new TemplateStoreError("key_taken", "This template key is taken");
  if (code === "23505" && constraint === "idx_template_versions_draft") throw new TemplateStoreError("draft_exists", "This template already has a draft");
  if (code === "23505" && constraint === "idx_template_versions_version") throw new TemplateStoreError("version_order", message);
  if (code === "23514" && constraint === "templates_key_kebab") throw new TemplateStoreError("key_invalid", "A template key is kebab-case, without dots");
  if (code === "23514" && /is published: it is immutable/.test(message)) throw new TemplateStoreError("immutable", message);
  if (code === "23514" && /must be greater than the last published/.test(message)) throw new TemplateStoreError("version_order", message);
  throw error;
}

export class TemplateRepository {
  async createTemplate(values: { key: string; name: string; createdBy: string | null }): Promise<TemplateRecord> {
    try {
      const [row] = await db.insert(templates).values({ key: values.key, name: values.name, created_by: values.createdBy }).returning();
      return row;
    } catch (error) {
      translate(error);
    }
  }

  async findTemplate(key: string): Promise<TemplateRecord | null> {
    const [row] = await db.select().from(templates).where(eq(templates.key, key));
    return row ?? null;
  }

  async listTemplates(): Promise<TemplateRecord[]> {
    return db.select().from(templates);
  }

  /** Écrit le brouillon du template : le crée s'il n'y en a pas, le remplace sinon. */
  async saveDraft(key: string, yaml: string, by: string | null): Promise<TemplateVersionRecord> {
    const checksum = checksumOf(yaml);
    try {
      const [updated] = await db
        .update(template_versions)
        .set({ yaml, checksum, updated_at: new Date() })
        .where(and(eq(template_versions.template_key, key), eq(template_versions.status, "draft")))
        .returning();
      if (updated) return updated as TemplateVersionRecord;
      const [inserted] = await db.insert(template_versions).values({ template_key: key, yaml, checksum, created_by: by }).returning();
      return inserted as TemplateVersionRecord;
    } catch (error) {
      translate(error);
    }
  }

  /** Toutes les lignes d'un template, brouillon compris. */
  async listVersions(key: string): Promise<TemplateVersionRecord[]> {
    const rows = await db.select().from(template_versions).where(eq(template_versions.template_key, key));
    return rows as TemplateVersionRecord[];
  }

  async findDraft(key: string): Promise<TemplateVersionRecord | null> {
    const [row] = await db
      .select()
      .from(template_versions)
      .where(and(eq(template_versions.template_key, key), eq(template_versions.status, "draft")));
    return (row as TemplateVersionRecord) ?? null;
  }

  /**
   * Publie le brouillon sous `version` : la même ligne passe en publiée. Le
   * trigger refuse une version qui ne dépasse pas la dernière publiée.
   */
  async publishDraft(key: string, version: string, by: string | null): Promise<PublishedTemplateVersion> {
    try {
      const [row] = await db
        .update(template_versions)
        .set({ status: "published", version, published_at: new Date(), published_by: by, updated_at: new Date() })
        .where(and(eq(template_versions.template_key, key), eq(template_versions.status, "draft")))
        .returning();
      if (!row) throw new TemplateStoreError("not_found", `Template ${key} has no draft to publish`);
      return row as PublishedTemplateVersion;
    } catch (error) {
      if (error instanceof TemplateStoreError) throw error;
      translate(error);
    }
  }

  async findPublished(key: string, version: string): Promise<PublishedTemplateVersion | null> {
    const [row] = await db
      .select()
      .from(template_versions)
      .where(and(eq(template_versions.template_key, key), eq(template_versions.version, version), eq(template_versions.status, "published")));
    return (row as PublishedTemplateVersion) ?? null;
  }

  /** Toutes les versions publiées, texte compris : le chargement au démarrage. */
  async listPublished(): Promise<PublishedTemplateVersion[]> {
    const rows = await db.select().from(template_versions).where(eq(template_versions.status, "published"));
    return rows as PublishedTemplateVersion[];
  }

  /**
   * Les seules références `(clé, version)` publiées : le rattrapage compare
   * à ce qu'il a chargé, sans dépendre d'aucune horloge.
   */
  async listPublishedRefs(): Promise<{ template_key: string; version: string }[]> {
    const rows = await db
      .select({ template_key: template_versions.template_key, version: template_versions.version })
      .from(template_versions)
      .where(eq(template_versions.status, "published"));
    return rows as { template_key: string; version: string }[];
  }

  /** Les challenges qui référencent chaque version publiée d'un template. */
  async usage(key: string): Promise<Record<string, number>> {
    const rows = await db
      .select({ version: challenges.template_version, count: count() })
      .from(challenges)
      .where(and(eq(challenges.type, key), isNotNull(challenges.template_version)))
      .groupBy(challenges.template_version);
    return Object.fromEntries(rows.map((row) => [row.version!, Number(row.count)]));
  }

  async systemChecksums(keys: readonly string[]): Promise<Record<string, string>> {
    if (keys.length === 0) return {};
    const rows = await db.select().from(system_template_checksums).where(inArray(system_template_checksums.key, [...keys]));
    return Object.fromEntries(rows.map((row) => [row.key, row.checksum]));
  }

  async recordSystemChecksum(key: string, checksum: string): Promise<void> {
    await db
      .insert(system_template_checksums)
      .values({ key, checksum, updated_at: new Date() })
      .onConflictDoUpdate({ target: system_template_checksums.key, set: { checksum, updated_at: new Date() } });
  }

  /** Les challenges vivants (ni clos ni archivés) d'un type : ce qu'une dérive de template système touche. */
  async liveChallengesOf(type: string): Promise<{ uuid: string; title: string }[]> {
    return db
      .select({ uuid: challenges.uuid, title: challenges.title })
      .from(challenges)
      .where(and(eq(challenges.type, type), notInArray(challenges.status, ["completed", "archived"])));
  }
}
