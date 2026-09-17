import { T, type Type } from "./expr/types.js";

/**
 * Le catalogue des capacités
 * --------------------------
 * Le core n'a pas de registre de capacités : `packages/capabilities/*` sont des
 * modules importés. L'interpréteur tient ici sa propre table, contrat de
 * compilation et rien de plus : pour chaque nom qu'un template peut écrire
 * dans `capability:`, sa nature, ses arguments, sa sortie et, pour un
 * effecteur, s'il est create-or-get par clé naturelle — condition pour être
 * compilé (note de conception §4).
 *
 * J1 livre la moitié statique ; les liaisons exécutables arrivent en J2.
 * `v1` dit si la capacité fait partie de ce que la v1 compile.
 */

export interface CapabilityArgument {
  /** `expr` : une expression typée ; `literal` : un mot parmi `values`. */
  form: "expr" | "literal";
  type?: Type;
  values?: readonly string[];
  required?: boolean;
}

export interface CapabilityEntry {
  kind: "observer" | "effector";
  args: Readonly<Record<string, CapabilityArgument>>;
  output: Type;
  /** Un effecteur doit être create-or-get par clé naturelle pour être compilé. */
  createOrGet?: boolean;
  v1: boolean;
}

export type CapabilityCatalog = Readonly<Record<string, CapabilityEntry>>;

export const DEFAULT_CATALOG: CapabilityCatalog = {
  http_proxy: {
    kind: "observer",
    args: {
      to: { form: "expr", type: T.url, required: true },
      send: { form: "expr", type: T.file },
      /** Conservation de la réponse, en jours après la fermeture du challenge. */
      retention_days: { form: "expr", type: T.int },
    },
    // La réponse est un fichier : un blob, jamais des octets dans le contexte.
    output: T.record({ status: T.int, ok: T.bool, content_type: T.string, response: T.file }),
    v1: true,
  },
  // Liées par compile/bindings.ts, sur les connecteurs GitHub et Kaggle.
  github_fetch: {
    kind: "observer",
    args: { url: { form: "expr", type: T.url, required: true } },
    output: T.record({ slug: T.string, url: T.url, branch: T.string, commits: T.int, last_commit: T.string, last_commit_at: T.string }),
    v1: true,
  },
  kaggle_metadata: {
    kind: "observer",
    args: { url: { form: "expr", type: T.url, required: true } },
    // Les métriques d'un modèle : la dernière version qui publie chacune, 0 sinon — comme le flow ML.
    output: T.record({
      ref: T.string,
      kind: T.enum(["dataset", "model"]),
      url: T.url,
      title: T.string,
      versions: T.int,
      metrics: T.record({ auc: T.number, f1: T.number, accuracy: T.number }),
    }),
    v1: true,
  },
  social_metadata: {
    kind: "observer",
    args: { url: { form: "expr", type: T.url, required: true } },
    output: T.record({ platform: T.string, handle: T.string, age_days: T.int, engagement: T.number }),
    v1: false,
  },
  github_check: {
    kind: "observer",
    args: {
      check: { form: "literal", values: ["fork_exists", "pr_open"], required: true },
      of: { form: "expr", type: T.url },
      url: { form: "expr", type: T.url },
      by: { form: "expr", type: T.string, required: true },
    },
    output: T.record({ ok: T.bool }),
    v1: false,
  },
  github_workspace: {
    kind: "effector",
    args: { repo: { form: "expr", type: T.url, required: true } },
    output: T.record({ branch: T.string, url: T.url }),
    createOrGet: true,
    v1: false,
  },
  spawn_challenge: {
    kind: "effector",
    args: {
      template: { form: "expr", type: T.template, required: true },
      params: { form: "expr", type: T.dyn },
      auto_join: { form: "expr", type: T.user },
    },
    output: T.record({ challenge: T.challenge }),
    createOrGet: true,
    v1: false,
  },
};
