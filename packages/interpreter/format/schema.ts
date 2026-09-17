import { z } from "zod";

/**
 * La structure d'un document `leaderboardos/1`
 * -------------------------------------------
 * La première passe : la forme du document, avant tout sens. Les expressions
 * sont des chaînes (ou un nombre, un booléen écrits nus en YAML), lues plus
 * tard. Les nœuds ne sont pas décrits par une union zod — ses erreurs sont
 * illisibles — mais un par un : `validateFormat` repère la famille d'un nœud
 * par sa clé unique, puis applique le schéma de cette famille, pour que le
 * chemin d'une erreur désigne le nœud fautif.
 *
 * La forme canonique (les écarts d'écriture avec la suite de conformance 0.2)
 * est décrite dans `conformance/CANONICAL.md`.
 */

export const exprSource = z.union([z.string(), z.number(), z.boolean()]);
export type ExprSource = z.infer<typeof exprSource>;

const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/, "an identifier is lower_snake_case");
const duration = z.string().regex(/^[0-9]+[mhd]$/, "a duration is a number followed by m, h or d");
const typeSpec = z.union([z.string(), z.record(z.string(), z.unknown())]);

export const fieldDecl = z.strictObject({
  type: typeSpec,
  /** Pour un champ `link` : le livrable exigé du challenge source (`endpoint`). */
  deliverable: identifier.optional(),
  /** Deux instances ne portent jamais la même valeur de ce champ ; une seconde création est refusée (409). */
  unique: z.boolean().optional(),
  /** Pour un champ `file` : la conservation des octets, en jours après la fermeture du challenge. */
  retention: z.strictObject({ days_after_close: z.number().int().min(1) }).optional(),
  from: exprSource.optional(),
  visibility: z.array(z.string()).optional(),
  where: exprSource.optional(),
  when: exprSource.optional(),
  check: exprSource.optional(),
});
export type FieldDecl = z.infer<typeof fieldDecl>;

const fields = z.record(identifier, fieldDecl);

export const claimDecl = z.strictObject({
  mode: z.enum(["exclusive", "k_bounded", "unique_per", "unbounded"]),
  k: exprSource.optional(),
  /** Une durée écrite (`48h`), ou une expression en heures (`params.ttl_hours`). */
  ttl: exprSource.optional(),
  dimensions: z.array(identifier).optional(),
  where: exprSource.optional(),
});

const closer = z.enum(["aggregate", "transition", "admin_act"]);

export const resourceDecl = z.strictObject({
  fields,
  created_by: z.array(z.string()).optional(),
  claim: claimDecl.optional(),
  closure: z
    .strictObject({
      by: z.union([closer, z.array(closer)]),
      verdict: z.array(identifier).optional(),
      permanent: z.boolean().optional(),
    })
    .optional(),
  cardinality: z.strictObject({ exactly: exprSource }).optional(),
  match_or_create: z.strictObject({ by: z.string() }).optional(),
});
export type ResourceDecl = z.infer<typeof resourceDecl>;

export const claimUse = z.strictObject({
  resource: z.string(),
  where: exprSource.optional(),
  scope: z.record(identifier, exprSource).optional(),
  substitute: z.strictObject({ resource: identifier, rate: exprSource }).optional(),
});
export type ClaimUse = z.infer<typeof claimUse>;

export const transitionBody = z.strictObject({
  resource: exprSource,
  to: z.enum(["open", "closed"]),
  verdict: z.string().optional(),
  /** Sur une ressource déjà fermée : change son verdict, seulement s'il vaut encore celui-ci (premier arrivé). */
  from: identifier.optional(),
  /** Ce que la transition ajoute à `resolution`, clé par clé. */
  resolution: z.record(identifier, exprSource).optional(),
});
export type TransitionBody = z.infer<typeof transitionBody>;

const counterUpdates = z.record(identifier, z.strictObject({ add: exprSource }));

const tiersMapping = z.strictObject({
  mapping: z.literal("tiers"),
  tiers: exprSource,
  key: identifier,
  match: z.enum(["at_least", "equals"]),
  input: exprSource,
});
const rankMapping = z.strictObject({
  mapping: z.literal("rank"),
  over: identifier,
  by: exprSource,
  order: z.enum(["asc", "desc"]),
  amounts: exprSource,
});

export const rewardBody = z.strictObject({
  id: identifier.optional(),
  to: exprSource.optional(),
  /** `reverse` : l'exact négatif de ce qu'une récompense a versé pour le claim de chaque destinataire (spec §3.5, clawback). */
  amount: z.union([exprSource, tiersMapping, rankMapping, z.strictObject({ reverse: z.string().min(1) })]),
  pool: exprSource.optional(),
  clamp: z.literal("pool").optional(),
  order: z.literal("commit_time").optional(),
  rule_key: z.string().regex(/^[a-z][a-z0-9_.]*$/).optional(),
});
export type RewardBody = z.infer<typeof rewardBody>;

export const collectBody = z.strictObject({ id: identifier, fields });

/** Un Act garde ses clés inconnues : ce sont les arguments de sa capacité. */
export const actBody = z.looseObject({
  id: identifier,
  kind: z.enum(["observer", "effector", "grant"]).optional(),
  capability: z.string().optional(),
  store: identifier.optional(),
  create: identifier.optional(),
  from: z.union([exprSource, z.array(exprSource)]).optional(),
  set: z.record(identifier, exprSource).optional(),
  many: z.strictObject({ from_file: exprSource }).optional(),
  claim: claimUse.optional(),
  transition: transitionBody.optional(),
  grant: z.strictObject({ field: exprSource, to: z.literal("participation") }).optional(),
  match_or_create: z.strictObject({ resource: identifier, decision: identifier }).optional(),
  attach: exprSource.optional(),
});
export type ActBody = z.infer<typeof actBody>;
export const ACT_KEYS = new Set(Object.keys(actBody.shape));

export const assessBody = z.strictObject({
  id: identifier,
  kind: z.enum(["ai_grid", "human", "metric", "self"]),
  grid: exprSource.optional(),
  input: z.array(exprSource).optional(),
  /** `ai_grid` sur un dépôt : son historique récent (défaut GitHub) ou son dernier état (défaut Kaggle). */
  snapshot: z.enum(["history", "latest"]).optional(),
  fields: fields.optional(),
  from: identifier.optional(),
  value: exprSource.optional(),
  emit: z.strictObject({ to: z.string(), scope: exprSource }).optional(),
  counters: counterUpdates.optional(),
  gating: z.boolean().optional(),
  claim: claimUse.optional(),
});
export type AssessBody = z.infer<typeof assessBody>;

/** `branch` se valide nœud par nœud : ses sous-séquences sont des listes de nœuds. */
export const gateBody = z.strictObject({
  id: identifier,
  all: z.array(exprSource).min(1).optional(),
  /** Le statut d'un refus de `all` : 422 par défaut, 403 quand la règle dit « pas toi ». */
  refuse: z.union([z.literal(403), z.literal(409), z.literal(422)]).optional(),
  branch: z.array(z.record(z.string(), z.unknown())).min(1).optional(),
});
export type GateBody = z.infer<typeof gateBody>;

export const NODE_FAMILIES = {
  collect: collectBody,
  act: actBody,
  assess: assessBody,
  gate: gateBody,
  reward: rewardBody,
} as const;
export type NodeFamily = keyof typeof NODE_FAMILIES;

export const accessDecl = z.strictObject({
  mode: z.enum(["open", "role", "author_of"]),
  role: exprSource.optional(),
  resource: identifier.optional(),
  group: exprSource.optional(),
  stake: z.strictObject({ amount: exprSource }).optional(),
  runs_per_participation: z.number().int().min(1).optional(),
});
export type AccessDecl = z.infer<typeof accessDecl>;

export const entryDecl = z.strictObject({
  trigger: z.enum(["user", "admin", "cron", "webhook"]),
  access: accessDecl.optional(),
  schedule: z.string().optional(),
  over: z
    .strictObject({ resource: identifier, where: exprSource.optional(), sample: exprSource.optional() })
    .optional(),
  cursor: z.literal("engine").optional(),
  dedup: z.strictObject({ by: identifier, window: duration }).optional(),
});
export type EntryDecl = z.infer<typeof entryDecl>;

export const laneShell = z.strictObject({
  id: identifier,
  entry: entryDecl,
  nodes: z.array(z.record(z.string(), z.unknown())),
});

export const aggregateDecl = z.strictObject({
  id: identifier,
  over: identifier,
  per_participation: z.number().int().min(1).optional(),
  resolve: z.strictObject({
    when: exprSource,
    verdict: exprSource.optional(),
    then: z.array(z.record(z.string(), z.unknown())).optional(),
  }),
  state_visibility: z
    .strictObject({
      count: z.enum(["everyone", "admin", "author"]).optional(),
      split: z.enum(["everyone", "admin", "author"]).optional(),
    })
    .optional(),
});
export type AggregateDecl = z.infer<typeof aggregateDecl>;

/** Ce qu'un Aggregate résolu ou la fermeture du challenge déclenchent. */
export const EFFECT_FAMILIES = {
  transition: transitionBody,
  reward: rewardBody,
  counters: z.strictObject({ on: exprSource, update: counterUpdates }),
} as const;
export type EffectFamily = keyof typeof EFFECT_FAMILIES;

export const paramDecl = z.strictObject({
  type: typeSpec,
  mutable: z.boolean(),
  check: exprSource.optional(),
  /** Des checks nommés : le nom d'un check qui échoue est le message qu'un formulaire affiche. */
  checks: z.record(identifier, exprSource).optional(),
  default: z.unknown().optional(),
});

export const templateHeader = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "a template id is kebab-case"),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/, "a template version is semver"),
  name: z.string().min(1),
  summary: z.string().min(1),
});

export const requiresDecl = z.strictObject({ core: z.number().int().min(1) });

export const counterDecl = z.strictObject({
  type: z.enum(["int", "number", "ratio", "points"]),
  /** Les `lag` claims livrés les plus récents ne comptent pas encore : un compteur qui ne trahit pas le geste qui l'a fait bouger. */
  lag: z.number().int().min(0).optional(),
});

/** Ce que le template dit de sa présentation, hors du programme. */
export const presentationDecl = z.strictObject({
  icon: z.string().optional(),
  /** Le nom dans une phrase ; `template.name` à défaut. */
  long_label: z.string().min(1).optional(),
  /** Ce que rejoindre implique, affiché sous le brief. */
  join_caption: z.string().min(1).optional(),
  /** Un non-membre passe par le brief et le `Join` ; vrai par défaut. */
  brief_required: z.boolean().optional(),
  /** Un visiteur anonyme peut ouvrir un challenge public de ce flow ; faux par défaut. */
  public: z.boolean().optional(),
  /** La contribution qui porte les lignes du ledger d'un participant. */
  contribution: z.strictObject({ type: identifier, title: z.string().min(1) }).optional(),
});

export const statesDecl = z.union([z.literal("standard"), z.strictObject({ close_at: exprSource.optional() })]);

/** Les clés d'un document : ce que le parse de sauvetage lit section par section (validate/format.ts). */
export const DOCUMENT_KEYS = ["format", "template", "params", "requires", "resources", "counters", "presentation", "lifecycle", "lanes"] as const;
export const LIFECYCLE_KEYS = ["states", "aggregates", "on_close"] as const;

export const documentShell = z.strictObject({
  format: z.literal("leaderboardos/1"),
  template: templateHeader,
  params: z.record(identifier, paramDecl).default({}),
  requires: requiresDecl,
  resources: z.record(identifier, resourceDecl).default({}),
  counters: z.record(identifier, counterDecl).default({}),
  presentation: presentationDecl.optional(),
  lifecycle: z
    .strictObject({
      states: statesDecl.optional(),
      aggregates: z.array(aggregateDecl).default([]),
      on_close: z.array(z.record(z.string(), z.unknown())).default([]),
    })
    .default({ aggregates: [], on_close: [] }),
  lanes: z.array(laneShell).min(1),
});
export type DocumentShell = z.infer<typeof documentShell>;
