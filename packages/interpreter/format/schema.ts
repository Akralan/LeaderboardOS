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
/** Un nom de paramètre : lower_snake_case, ou camelCase quand il reprend une clé de `reward_rules` qu'un flow écrit à la main stocke (`apiPackaging`). */
export const PARAM_NAME = /^[a-z][a-zA-Z0-9_]*$/;
const paramName = z.string().regex(PARAM_NAME, "a param name is lower_snake_case or camelCase");
const duration = z.string().regex(/^[0-9]+[mhd]$/, "a duration is a number followed by m, h or d");
const typeSpec = z.union([z.string(), z.record(z.string(), z.unknown())]);

export const fieldDecl = z.strictObject({
  type: typeSpec,
  /** Pour un champ `link` : le livrable exigé du challenge source (`endpoint`). */
  deliverable: identifier.optional(),
  /** Deux instances ne portent jamais la même valeur de ce champ ; une seconde création est refusée (409). */
  unique: z.boolean().optional(),
  /** Le champ peut manquer : `null`, jamais refusé (un commentaire, une instruction). */
  optional: z.boolean().optional(),
  /** Une chaîne collectée est rognée ; vide après rognage, un champ optionnel vaut `null`. */
  trim: z.boolean().optional(),
  /** Pour un champ `url` collecté : une adresse publique, vérifiée côté serveur (garde SSRF) avant d'être gardée. */
  public: z.boolean().optional(),
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
  /**
   * Un champ `int` qui ordonne les instances, gardé dense (0..n-1) par le moteur :
   * une création s'ajoute à la fin, un `update` qui le change déplace l'instance,
   * un `delete` renumérote (les étapes d'un scénario).
   */
  ordered_by: identifier.optional(),
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
  /**
   * `delta` : ne verse que ce qui dépasse ce que cette clé a déjà versé à ce
   * destinataire sur le challenge — un montant rogné par le pool se complète
   * plus tard, une baisse ne reprend rien (le challenge code).
   */
  basis: z.literal("delta").optional(),
  /**
   * Le bonus de groupe : `amount` (arrondi) est l'assiette, le versé est
   * `round(assiette × multiplier)`. Les transferts se calculent sur l'assiette,
   * jamais sur le bonus (le challenge ML).
   */
  multiplier: exprSource.optional(),
  /** Un montant rogné par le pool garde `rawPoints` et `clampedTo` dans sa méta. */
  record_clamp: z.boolean().optional(),
  /** Le libellé de la clé de ledger, lu par les écrans de récompense. */
  label: z.string().min(1).optional(),
  /**
   * Des crédits de réutilisation hors pool : pour chaque élément de `from`
   * (`{author, contribution, weight?}`), `round(assiette versée × weight × share)`
   * est prélevé au destinataire et crédité à l'auteur, sous `rule_key`. Un auteur
   * qui est le destinataire ne prélève rien ; le destinataire garde au moins
   * `floor` de ce qui lui a été versé (les prélèvements sont alors réduits au prorata).
   */
  transfers: z
    .strictObject({
      floor: exprSource.optional(),
      to: z
        .array(
          z.strictObject({
            rule_key: z.string().regex(/^[a-z][a-z0-9_.]*$/),
            label: z.string().min(1).optional(),
            from: exprSource,
            share: exprSource,
          })
        )
        .min(1),
    })
    .optional(),
  /** Ce que la ligne de ledger garde, clé par clé (`agentScore`…). */
  // Les clés sont celles que les flows écrits à la main posent (`agentScore`) : la forme de leurs données fait foi.
  meta: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "a meta key is an identifier"), exprSource).optional(),
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
  /**
   * Avec `create` : une instance par combinaison de ces champs (`author` : le
   * créateur). Déjà là, elle est rendue telle quelle, ou réécrite avec `overwrite`.
   */
  upsert: z.strictObject({ by: z.array(identifier).min(1), overwrite: z.boolean().optional() }).optional(),
  /**
   * Réécrit des champs d'une instance : `from` un geste (seulement les champs
   * que la requête porte, `null` compris), `set` des expressions.
   */
  update: z.strictObject({ resource: exprSource, from: identifier.optional(), set: z.record(identifier, exprSource).optional() }).optional(),
  /**
   * Supprime une instance (et ses réclamations). Les gardes que seul le moteur
   * sait lire se déclarent ici, avec leur message (`{count}` y est remplacé) :
   * `unclaimed`, aucune réclamation vivante ou livrée ; `without_inputs`, aucune
   * entrée de cet aggregate. Refusée, 409.
   */
  delete: z
    .union([
      exprSource,
      z.strictObject({
        resource: exprSource,
        unclaimed: z.string().min(1).optional(),
        without_inputs: z.strictObject({ aggregate: identifier, message: z.string().min(1) }).optional(),
      }),
    ])
    .optional(),
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
  /**
   * `ai_grid` hors de la requête : le geste répond 202, l'évaluation tourne en
   * arrière-plan (une à la fois par participation, reprise après 30 min), puis
   * la lane reprend au nœud suivant. Rejouable par la relance d'un run échoué.
   */
  background: z.boolean().optional(),
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
  refuse: z.union([z.literal(400), z.literal(403), z.literal(409), z.literal(422)]).optional(),
  /** Le message du refus (`Refused by <id>` sinon) et la raison lisible par une interface. */
  message: z.string().min(1).optional(),
  reason: identifier.optional(),
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
  /** `signed_in` : tout compte connecté, membre ou non (un validateur qui ne rejoint pas). */
  mode: z.enum(["open", "role", "author_of", "signed_in"]),
  role: exprSource.optional(),
  resource: identifier.optional(),
  group: exprSource.optional(),
  stake: z.strictObject({ amount: exprSource }).optional(),
  runs_per_participation: z.number().int().min(1).optional(),
});
export type AccessDecl = z.infer<typeof accessDecl>;

export const entryDecl = z.strictObject({
  /** `submission` : joué en arrière-plan après qu'un participant a soumis l'URL d'une étape (capacité `submissions`). */
  trigger: z.enum(["user", "admin", "cron", "webhook", "submission"]),
  /** Pour `trigger: submission` : l'étape déclarée dans `submissions.steps`. */
  step: identifier.optional(),
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
  contribution: z
    .strictObject({
      type: identifier,
      title: z.string().min(1),
      /** Une expression sur `challenge` : la description écrite à la création de la contribution. */
      description: exprSource.optional(),
      /** Ce que cette contribution livre, qu'un challenge de validation peut éprouver (`deployed_app`). */
      deliverables: z.array(identifier).optional(),
    })
    .optional(),
  /** Un board personnel par participant (le porteur, en groupe), copié du template au join ; `board.total`, `board.done`. */
  board: z.boolean().optional(),
  /** La clé du handler qui rejoue une évaluation en arrière-plan échouée (`continue` sinon) : celle d'un flow repris. */
  evaluation_handler: identifier.optional(),
});

/**
 * Où un participant livre son code (capacité `workspaces`) : `provided_repo`,
 * une branche perso sur le dépôt du challenge, ou `own_repo`, son propre dépôt
 * déclaré par `PATCH workspace`. `participation.workspace` le lit.
 */
export const workspaceDecl = z.strictObject({ mode: exprSource });

/**
 * Des étapes à soumettre (capacité `submissions`) : un dépôt par étape créé
 * avec le challenge, une URL par participant (le porteur, en groupe) gardée
 * dans `challenge_repos.workspace_meta`, une contribution par type écrite à la
 * soumission, puis la lane `trigger: submission` de l'étape jouée en
 * arrière-plan. `GET/PATCH workspace` sont générés.
 */
export const submissionStepDecl = z.strictObject({
  /** Le type du dépôt créé avec le challenge (`kaggle_dataset`, `github`…). */
  repo: z.string().min(1),
  /** Ce qui suit le titre du challenge dans le titre du dépôt (`Dataset`). */
  repo_title: z.string().min(1),
  /** Le type de contribution que l'étape alimente ; deux étapes peuvent en partager un. */
  contribution: identifier,
  title: z.string().min(1),
  /** L'URL identifie l'artefact : le premier à la soumettre en est l'auteur, les suivants le réutilisent. */
  artifact: z.boolean().optional(),
  /** Ce que la contribution livre à une validation (`endpoint`). */
  deliverables: z.array(identifier).optional(),
  /** Une soumission n'est acceptée que si l'expression tient (403 `closed_message` sinon) ; retirer son URL reste permis. */
  open: exprSource.optional(),
  /** Le champ de création qui retire l'étape quand il vaut `false` (`api_packaging_enabled`). */
  unless_input: identifier.optional(),
});

export const submissionsDecl = z.strictObject({
  steps: z.record(identifier, submissionStepDecl),
  /** L'étape dont le dépôt garde la sélection de datasets (`dataset_urls`), lue par `submission.lineage.selection`. */
  selection: identifier.optional(),
  closed_message: z.string().min(1).optional(),
  /** La clé du handler qui rejoue une soumission échouée (`{challengeId, userId, repoId, url}`). */
  evaluation_handler: identifier.optional(),
});

export const statesDecl = z.union([z.literal("standard"), z.strictObject({ close_at: exprSource.optional() })]);

/**
 * Les écrans composés d'un template (note §5, catalogue UI)
 * ---------------------------------------------------------
 * Sans bloc `ui`, le client empile ses écrans générés. Avec, un écran
 * (`contributor`, `manage`) est une grille de 12 colonnes où le template pose
 * des composants du catalogue (`ui/catalog.ts`) : lequel, où, à quelle taille,
 * avec quels arguments. Le catalogue est fermé — un template ne porte pas de
 * code, il compose. Un écran absent reste généré.
 */
const gridInt = z.number().int();
export const uiPlacement = z.strictObject({
  x: gridInt.min(0).max(11),
  y: gridInt.min(0),
  w: gridInt.min(1).max(12),
  h: gridInt.min(1),
});
export type UiPlacement = z.infer<typeof uiPlacement>;

/**
 * Un bloc peut choisir quelque chose pour l'écran (`selects: app`) ; un autre
 * bloc lit ce choix dans un argument (`url: $app.app_url`, `walkthrough: $run`).
 * Les variables sont celles de l'écran ; le validateur en connaît le type.
 */
export const uiBlockDecl = z.strictObject({
  id: identifier,
  component: identifier,
  at: uiPlacement,
  props: z.record(identifier, z.unknown()).optional(),
  selects: identifier.optional(),
});
export type UiBlockDecl = z.infer<typeof uiBlockDecl>;

export const uiScreenDecl = z.strictObject({ blocks: z.array(uiBlockDecl) });
export type UiScreenDecl = z.infer<typeof uiScreenDecl>;

export const UI_SCREENS = ["contributor", "manage"] as const;
export type UiScreen = (typeof UI_SCREENS)[number];

export const uiDecl = z.strictObject({
  contributor: uiScreenDecl.optional(),
  manage: uiScreenDecl.optional(),
});
export type UiDecl = z.infer<typeof uiDecl>;

/** Les clés d'un document : ce que le parse de sauvetage lit section par section (validate/format.ts). */
export const DOCUMENT_KEYS = ["format", "template", "params", "requires", "resources", "counters", "presentation", "workspace", "submissions", "lifecycle", "lanes", "ui"] as const;
export const LIFECYCLE_KEYS = ["states", "aggregates", "on_close"] as const;

export const documentShell = z.strictObject({
  format: z.literal("leaderboardos/1"),
  template: templateHeader,
  params: z.record(paramName, paramDecl).default({}),
  requires: requiresDecl,
  resources: z.record(identifier, resourceDecl).default({}),
  counters: z.record(identifier, counterDecl).default({}),
  presentation: presentationDecl.optional(),
  workspace: workspaceDecl.optional(),
  submissions: submissionsDecl.optional(),
  lifecycle: z
    .strictObject({
      states: statesDecl.optional(),
      aggregates: z.array(aggregateDecl).default([]),
      on_close: z.array(z.record(z.string(), z.unknown())).default([]),
    })
    .default({ aggregates: [], on_close: [] }),
  lanes: z.array(laneShell).min(1),
  ui: uiDecl.optional(),
});
export type DocumentShell = z.infer<typeof documentShell>;
