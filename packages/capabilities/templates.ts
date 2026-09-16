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

      const diagnostics = (await diagnose(draft.yaml, key)).filter((diagnostic) => diagnostic.severity === "error");
      const { parseDocument } = await import("yaml");
      const header = (parseDocument(draft.yaml).toJS() as { template?: { id?: unknown; version?: unknown } } | null)?.template;
      if (header?.id !== key) diagnostics.push({ severity: "error", code: "publish", path: "template.id", message: `template.id must be ${key}` });
      const version = typeof header?.version === "string" ? header.version : null;
      if (!version) diagnostics.push({ severity: "error", code: "publish", path: "template.version", message: "template.version is required" });
      if (diagnostics.length > 0) throw new TemplatePublishError(diagnostics);

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
async function diagnose(yaml: string, key: string): Promise<TemplateDiagnostic[]> {
  const { checkTemplateSource } = await import("../interpreter/check.js");
  const report = checkTemplateSource(yaml, key);
  const path = (segments: readonly (string | number)[]) => segments.join(".");
  return [
    ...report.errors.map((issue) => ({ severity: "error" as const, code: issue.pass, path: path(issue.path), message: issue.message })),
    ...report.gaps.map((gap) => ({ severity: "error" as const, code: "support", path: path(gap.path), message: `${gap.feature}: ${gap.message}` })),
    ...report.advisories.map((issue) => ({ severity: "advisory" as const, code: issue.pass, path: path(issue.path), message: issue.message })),
  ];
}
