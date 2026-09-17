import { compareVersions, PlatformRegistry, type FlowDefinition, type FlowReference } from "../registry/platform.js";
import type { PublishedTemplateVersion, TemplateRecord, TemplateRepository, TemplateVersionRecord } from "../database-service/repositories/template.repo.js";

/**
 * Capacité `templates` — les templates en base (challenge 021, T1)
 * ----------------------------------------------------------------
 * Publier, c'est figer : une version publiée est une ligne immuable, et un
 * challenge la référence sans rien copier (docs/input/templates-in-db-design-note.md).
 *
 * - **Chargement.** Chaque instance charge au démarrage toutes les versions
 *   publiées, compilées, à côté des flows fichiers : le registre reste
 *   synchrone pour ses lecteurs. Une version publiée après le démarrage se
 *   rattrape à la demande (`ensureFlowFor`, au dispatch) ou au tick
 *   (`refreshPublishedTemplates`, avant d'itérer les jobs).
 * - **Version non servable.** Une version qui ne compile plus (le catalogue a
 *   bougé depuis sa publication) ne fait jamais échouer le démarrage : elle
 *   est écartée avec une alerte structurée, et ses challenges répondent 503.
 * - **Publication.** Validation stricte du texte, clé du document égale à la
 *   clé du template, version lue dans le YAML, compilation et installation à
 *   blanc contre le registre vivant ; la base tient ensuite l'ordre des
 *   versions et l'immuabilité.
 */

export interface TemplateDiagnostic {
  severity: "error" | "advisory";
  /** La passe du validateur, ou `publish` pour ce que la publication ajoute. */
  code: string;
  /** Le chemin logique dans le document : `lanes.1.nodes.0.gate.all.0`. */
  path: string;
  message: string;
}

export class TemplatePublishError extends Error {
  constructor(readonly diagnostics: TemplateDiagnostic[]) {
    super(`Template cannot be published: ${diagnostics.filter((d) => d.severity === "error").map((d) => d.message).join("; ")}`);
  }
}

type Store = Pick<
  TemplateRepository,
  | "createTemplate"
  | "findTemplate"
  | "saveDraft"
  | "findDraft"
  | "publishDraft"
  | "findPublished"
  | "listTemplates"
  | "listVersions"
  | "usage"
  | "listPublished"
  | "listPublishedRefs"
  | "systemChecksums"
  | "recordSystemChecksum"
  | "liveChallengesOf"
>;

async function defaultStore(): Promise<Store> {
  const { TemplateRepository } = await import("../database-service/repositories/template.repo.js");
  return new TemplateRepository();
}

/** Ce qu'une instance sait des versions en base : les écartées, et pourquoi. */
interface LoaderState {
  unservable: Map<string, string>;
}

const STATE_KEY = "__leaderboardTemplateLoader";
function loader(): LoaderState {
  const holder = globalThis as unknown as Record<string, LoaderState | undefined>;
  return (holder[STATE_KEY] ??= { unservable: new Map() });
}

const refOf = (key: string, version: string) => `${key}@${version}`;

/** Compile une version publiée, telle qu'elle sera servie : clés préfixées, jobs restreints à ses challenges. */
async function compileVersion(yaml: string, key: string, version: string): Promise<FlowDefinition> {
  const { checkTemplateSource, compileTemplate } = await import("../interpreter/index.js");
  return compileTemplate(checkTemplateSource(yaml, key), { published: { version } });
}

function warn(event: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ level: "warn", event, ...fields }));
}

async function install(row: Pick<PublishedTemplateVersion, "template_key" | "version" | "yaml">): Promise<boolean> {
  const ref = refOf(row.template_key, row.version);
  if (PlatformRegistry.templateVersion(row.template_key, row.version)) return true;
  try {
    PlatformRegistry.installTemplateVersion(row.version, await compileVersion(row.yaml, row.template_key, row.version));
    loader().unservable.delete(ref);
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    loader().unservable.set(ref, reason);
    warn("template_version_unservable", { template: row.template_key, version: row.version, reason });
    return false;
  }
}

export function templates(store?: Store) {
  const storeOf = async () => store ?? (await defaultStore());

  return {
    /** Le démarrage : toutes les versions publiées. Ne lève jamais pour une version cassée. */
    async loadPublished(): Promise<{ loaded: number; unservable: number }> {
      const rows = (await (await storeOf()).listPublished()).sort(
        (a, b) => a.template_key.localeCompare(b.template_key) || compareVersions(a.version, b.version)
      );
      let loaded = 0;
      for (const row of rows) if (await install(row)) loaded++;
      return { loaded, unservable: rows.length - loaded };
    },

    /** Le tick : les versions publiées que cette instance n'a pas encore, sans horloge. */
    async refreshPublished(): Promise<number> {
      const repo = await storeOf();
      let loaded = 0;
      for (const ref of await repo.listPublishedRefs()) {
        if (PlatformRegistry.templateVersion(ref.template_key, ref.version) || loader().unservable.has(refOf(ref.template_key, ref.version))) continue;
        const row = await repo.findPublished(ref.template_key, ref.version);
        if (row && (await install(row))) loaded++;
      }
      return loaded;
    },

    /**
     * Le rattrapage d'un challenge : sa version, chargée si elle ne l'est pas.
     * `unservable` quand elle existe mais ne compile pas.
     */
    async ensureFlowFor(challenge: FlowReference): Promise<{ flow: FlowDefinition } | { unservable: string } | null> {
      const existing = PlatformRegistry.flowFor(challenge);
      if (existing) return { flow: existing };
      if (!challenge.type || !challenge.template_version) return null;
      const ref = refOf(challenge.type, challenge.template_version);
      const known = loader().unservable.get(ref);
      if (known) return { unservable: known };
      const row = await (await storeOf()).findPublished(challenge.type, challenge.template_version);
      if (!row) return null;
      if (await install(row)) return { flow: PlatformRegistry.flowFor(challenge)! };
      return { unservable: loader().unservable.get(ref)! };
    },

    /** La raison pour laquelle cette instance ne sert pas une version, si elle l'a écartée. */
    unservableReason(key: string, version: string): string | null {
      return loader().unservable.get(refOf(key, version)) ?? null;
    },

    /** Crée un template et son premier brouillon. La clé ne doit servir aucun flow installé. */
    async create(input: { key: string; name: string; yaml: string; by: string | null }): Promise<{ template: TemplateRecord; draft: TemplateVersionRecord; diagnostics: TemplateDiagnostic[] }> {
      if (PlatformRegistry.flow(input.key)) {
        throw new TemplatePublishError([{ severity: "error", code: "publish", path: "template.id", message: `The key ${input.key} is already served by an installed flow` }]);
      }
      const repo = await storeOf();
      const template = await repo.createTemplate({ key: input.key, name: input.name, createdBy: input.by });
      const draft = await repo.saveDraft(input.key, input.yaml, input.by);
      return { template, draft, diagnostics: await diagnose(input.yaml, input.key) };
    },

    /**
     * La bibliothèque : les templates système (lecture seule, duplicables) et
     * ceux de la base, avec leurs versions publiées, leur brouillon et leur
     * usage. Un template archivé n'y figure plus.
     */
    async library(system: readonly { key: string; yaml: string }[]) {
      const repo = await storeOf();
      const { describeTemplate } = await import("../interpreter/describe.js");
      const described = (yaml: string, key: string) => {
        try {
          const { descriptor, surface } = describeTemplate(yaml, key);
          return { descriptor, surface };
        } catch {
          return null;
        }
      };
      const records = (await repo.listTemplates()).filter((template) => !template.archived_at);
      const database = await Promise.all(
        records.map(async (template) => {
          const rows = await repo.listVersions(template.key);
          const published = rows
            .filter((row): row is PublishedTemplateVersion => row.status === "published")
            .sort((a, b) => compareVersions(a.version, b.version));
          const newest = published.at(-1);
          const usage = await repo.usage(template.key);
          const latestDescription = newest ? described(newest.yaml, template.key) : null;
          const draft = rows.find((row) => row.status === "draft");
          const edited = rows.map((row) => new Date(row.updated_at).getTime()).filter(Number.isFinite);
          return {
            key: template.key,
            name: template.name,
            origin: "database" as const,
            versions: published.map((row) => ({ version: row.version, published_at: row.published_at, challenges: usage[row.version] ?? 0 })),
            draft: !!draft,
            /** La version que le brouillon porte dans son YAML, quand elle se lit. */
            draft_version: draft ? (await headerOf(draft.yaml)).version ?? null : null,
            edited_at: edited.length ? new Date(Math.max(...edited)) : template.created_at,
            latest: newest && latestDescription ? { version: newest.version, ...latestDescription } : null,
          };
        })
      );
      const systemTemplates = system.map((source) => {
        const description = described(source.yaml, source.key);
        return { key: source.key, name: description?.descriptor.label ?? source.key, origin: "system" as const, readonly: true, descriptor: description?.descriptor ?? null };
      });
      return { system: systemTemplates, templates: database };
    },

    /** Un template en base : ses versions, son brouillon et les diagnostics de ce brouillon. */
    async detail(key: string) {
      const repo = await storeOf();
      const template = await repo.findTemplate(key);
      if (!template) return null;
      const rows = await repo.listVersions(key);
      const draft = rows.find((row) => row.status === "draft") ?? null;
      const usage = await repo.usage(key);
      return {
        template,
        versions: rows
          .filter((row): row is PublishedTemplateVersion => row.status === "published")
          .sort((a, b) => compareVersions(a.version, b.version))
          .map((row) => ({ version: row.version, published_at: row.published_at, published_by: row.published_by, checksum: row.checksum, challenges: usage[row.version] ?? 0 })),
        draft: draft ? { yaml: draft.yaml, updated_at: draft.updated_at, diagnostics: await diagnose(draft.yaml, key) } : null,
      };
    },

    /**
     * Le texte d'un nouveau brouillon : une copie d'un template système ou
     * d'une version publiée, sous la clé du nouveau template.
     */
    async seedYaml(seed: { key: string; version?: string }, key: string, system: readonly { key: string; yaml: string }[]): Promise<string | null> {
      let source = system.find((candidate) => candidate.key === seed.key)?.yaml ?? null;
      if (!source) {
        const repo = await storeOf();
        const rows = (await repo.listVersions(seed.key))
          .filter((row): row is PublishedTemplateVersion => row.status === "published")
          .sort((a, b) => compareVersions(a.version, b.version));
        source = (seed.version ? rows.find((row) => row.version === seed.version) : rows.at(-1))?.yaml ?? null;
      }
      if (source === null) return null;
      const { parseDocument } = await import("yaml");
      const document = parseDocument(source);
      if (document.hasIn(["template", "id"])) document.setIn(["template", "id"], key);
      return document.toString();
    },

    /** La description d'un brouillon — la prévisualisation passe par les mêmes composants générés. */
    async describeDraft(key: string) {
      const draft = await (await storeOf()).findDraft(key);
      if (!draft) return null;
      const { describeTemplate } = await import("../interpreter/describe.js");
      try {
        const { descriptor, surface } = describeTemplate(draft.yaml, key);
        return { ok: true as const, descriptor, surface };
      } catch {
        return { ok: false as const, diagnostics: await diagnose(draft.yaml, key) };
      }
    },

    /** Écrit le brouillon ; les diagnostics reviennent avec chaque écriture. */
    async saveDraft(key: string, yaml: string, by: string | null): Promise<{ draft: TemplateVersionRecord; diagnostics: TemplateDiagnostic[] }> {
      const draft = await (await storeOf()).saveDraft(key, yaml, by);
      return { draft, diagnostics: await diagnose(yaml, key) };
    },

    /**
     * Publie le brouillon. Refusée avec les diagnostics qu'afficherait
     * l'éditeur, plus ce que la publication ajoute : clé du document, version,
     * compilation, conflits avec le registre. Installée dans cette instance ;
     * les autres la rattrapent.
     */
    async publish(key: string, by: string | null): Promise<PublishedTemplateVersion> {
      const repo = await storeOf();
      const draft = await repo.findDraft(key);
      if (!draft) throw new TemplatePublishError([{ severity: "error", code: "publish", path: "", message: `Template ${key} has no draft` }]);

      // Exactement la liste que l'éditeur affiche pour ce brouillon : la porte et l'éditeur ne divergent jamais.
      const diagnostics = (await diagnose(draft.yaml, key)).filter((diagnostic) => diagnostic.severity === "error");
      if (diagnostics.length > 0) throw new TemplatePublishError(diagnostics);
      const version = (await headerOf(draft.yaml)).version as string;

      let flow: FlowDefinition;
      try {
        flow = await compileVersion(draft.yaml, key, version!);
      } catch (error) {
        throw new TemplatePublishError([{ severity: "error", code: "publish", path: "", message: error instanceof Error ? error.message : String(error) }]);
      }
      const conflict = PlatformRegistry.templateVersionConflict(version!, flow);
      if (conflict) throw new TemplatePublishError([{ severity: "error", code: "publish", path: "", message: conflict }]);

      const published = await repo.publishDraft(key, version!, by);
      PlatformRegistry.installTemplateVersion(version!, flow);
      return published;
    },

    /**
     * La dérive des templates système : leur texte a changé depuis le dernier
     * démarrage. Les challenges en cours suivent le déploiement (arbitrage 7) ;
     * l'alerte les nomme.
     */
    async checkSystemDrift(sources: readonly { key: string; yaml: string }[]): Promise<string[]> {
      const repo = await storeOf();
      const { checksumOf } = await import("../database-service/repositories/template.repo.js");
      const known = await repo.systemChecksums(sources.map((source) => source.key));
      const drifted: string[] = [];
      for (const source of sources) {
        const checksum = checksumOf(source.yaml);
        if (known[source.key] === checksum) continue;
        if (known[source.key]) {
          drifted.push(source.key);
          const live = await repo.liveChallengesOf(source.key);
          warn("system_template_drift", { template: source.key, previous: known[source.key], checksum, live_challenges: live });
        }
        await repo.recordSystemChecksum(source.key, checksum);
      }
      return drifted;
    },
  };
}

/** Les diagnostics d'un texte : le validateur en mode collecteur (T2 y ajoutera le modèle partiel). */
async function headerOf(yaml: string): Promise<{ id?: unknown; version?: unknown }> {
  const { parse } = await import("yaml");
  try {
    const document = parse(yaml) as { template?: { id?: unknown; version?: unknown } } | null;
    return document && typeof document.template === "object" && document.template ? document.template : {};
  } catch {
    return {};
  }
}

/**
 * Les diagnostics d'un brouillon : le validateur en mode collecteur sur le
 * modèle partiel, ce que la v1 ne compile pas, et ce que la publication exige
 * en plus (la clé du document est celle du template). C'est la liste que
 * l'éditeur affiche à chaque écriture et celle qui refuse une publication.
 */
export async function diagnose(yaml: string, key: string): Promise<TemplateDiagnostic[]> {
  const { checkTemplateSource } = await import("../interpreter/check.js");
  const report = checkTemplateSource(yaml, key);
  const path = (segments: readonly (string | number)[]) => segments.join(".");
  const header = await headerOf(yaml);
  const publication: TemplateDiagnostic[] =
    typeof header.id === "string" && header.id !== key
      ? [{ severity: "error", code: "publish", path: "template.id", message: `template.id must be ${key}` }]
      : [];
  return [
    ...publication,
    ...report.errors.map((issue) => ({ severity: "error" as const, code: issue.pass, path: path(issue.path), message: issue.message })),
    ...report.gaps.map((gap) => ({ severity: "error" as const, code: "support", path: path(gap.path), message: `${gap.feature}: ${gap.message}` })),
    ...report.advisories.map((issue) => ({ severity: "advisory" as const, code: issue.pass, path: path(issue.path), message: issue.message })),
  ];
}
