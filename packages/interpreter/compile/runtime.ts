import type { Challenge, RewardEntry, RewardEntryDraft } from "../../database-service/domain/entities.js";
import type { Resources } from "../../capabilities/resources.js";
import type { Blobs } from "../../capabilities/blobs.js";
import type { AcceptedSubmission, SubmissionLineage, SubmissionOptions, SubmissionTable } from "../../capabilities/submissions.js";
import type { ChallengeRepo } from "../../database-service/domain/entities.js";
import type { Value } from "../expr/evaluator.js";

/**
 * Le port d'exécution d'un template compilé
 * -----------------------------------------
 * Tout ce qu'un flow compilé touche hors de lui-même passe par ce port : les
 * ressources et leurs claims, le ledger, l'évaluation par grille, les
 * observateurs, le hasard et l'horloge. `defaultRuntime()` le branche sur les
 * capacités du core ; un test lui substitue une mémoire.
 *
 * C'est la moitié exécutable du catalogue (note de conception §1) : une
 * capacité qu'aucune liaison ne sert échoue à l'appel, jamais en silence.
 */

export type RuntimeResources = Pick<
  Resources,
  | "createMany"
  | "draw"
  | "claimScoped"
  | "heldInScope"
  | "updateContext"
  | "grant"
  | "grantsFor"
  | "activeClaim"
  | "consume"
  | "release"
  | "close"
  | "reclose"
  | "stampResolution"
  | "resource"
  | "claim"
  | "consumedClaims"
  | "consumedBy"
  | "list"
  | "upsert"
  | "update"
  | "remove"
>;

export interface RuntimeLedger {
  /** Ce qui a déjà été pris sur le pool du challenge. */
  distributed(challengeId: string): Promise<number>;
  entries(challengeId: string): Promise<RewardEntry[]>;
  /** La contribution qui porte les lignes d'un participant ; créée au premier paiement. */
  contribution(challenge: Challenge, userId: string, contribution: { type: string; title: string; description?: string | null }): Promise<string>;
  write(drafts: RewardEntryDraft[]): Promise<void>;
  /** Le plus grand nombre `meta[field]` des lignes de cette clé, sans ou seulement une personne ; `null` sans ligne. */
  max(challengeId: string, query: { ruleKey: string; field: string; excludeUserId?: string; onlyUserId?: string }): Promise<number | null>;
  /** `challenges.completion` : la part du pool drainée. */
  syncCompletion(challenge: Challenge): Promise<void>;
}

/** Le workspace du porteur, tel que `challenge_teams` le garde. */
export interface WorkspaceView {
  provider: string | null;
  url: string | null;
  ref: string | null;
  status: string | null;
  /** Évaluable : une URL GitHub lisible (`external`), ou une branche prête (`github`). */
  ready: boolean;
}

/** Ce que la participation d'un appelant engage : son groupe, son porteur, le workspace de celui-ci. */
export interface ParticipationContext {
  /** L'appelant a une participation. */
  participant: boolean;
  /** Le porteur du workspace, du board, de la contribution et du ledger : l'appelant en solo. */
  holder: string;
  groupId: string | null;
  /** Tous les membres, porteur inclus ; `[appelant]` en solo. */
  members: string[];
  /** Le bonus de groupe de la plateforme : 1, 1.4, 1.8. */
  multiplier: number;
  workspace: WorkspaceView | null;
}

/** Les capacités `groups`, `board` et `workspaces` du core, lues depuis un template. */
export interface RuntimeParticipations {
  context(challengeId: string, userId: string): Promise<ParticipationContext>;
  /** L'avancement du board personnel du porteur. */
  board(challengeId: string, holderId: string): Promise<{ total: number; done: number }>;
  /** Les parts d'un delta de CP entre les membres d'un groupe, cumulées sur la contribution. */
  addShares(contributionId: string, shares: readonly { userId: string; points: number }[]): Promise<void>;
}

export interface EvaluateBinding {
  challenge: Challenge;
  userId: string;
  grid: string;
  inputs: Value[];
  /** Ce qui est noté d'un dépôt : son historique récent (défaut GitHub), ou son dernier état (défaut Kaggle). */
  snapshot?: "history" | "latest";
  /** La contribution évaluée : le run s'y rattache. */
  contributionId?: string;
  /** Qui rejoue le run s'il échoue : le handler du flow et sa charge (une évaluation en arrière-plan). */
  origin?: { handler: string; payload: Record<string, unknown> };
}

/** Ce que l'évaluation stocke sur la contribution : le détail des critères et le score brut sur 0–9. */
export interface EvaluationDetail {
  scores: unknown;
  globalScore: number;
}

export interface EvaluationState {
  status: "running" | "done" | "failed" | "pending" | "skipped_reuse" | null;
  /** Le début du dernier run : un `running` plus vieux que 30 minutes se reprend. */
  since: Date;
  evaluation: EvaluationDetail | null;
  artifactUrl: string | null;
}

/** Le score sur 0..1, avec son détail quand la liaison le connaît. */
export type EvaluateResult = number | { score: number; evaluation: EvaluationDetail };

/**
 * L'évaluation d'une participation, hors de la requête (le challenge code) :
 * une à la fois par contribution, reprise après 30 minutes, son statut et son
 * détail écrits sur la contribution.
 */
export interface RuntimeEvaluations {
  /** Prend l'évaluation : `false` quand une autre tourne depuis moins de 30 minutes. */
  claim(contributionId: string, artifactUrl: string | null): Promise<boolean>;
  /** Le statut final, et le détail quand l'évaluation en a produit un ; `skipped_reuse` pour une soumission réutilisée. */
  finish(contributionId: string, outcome: { status: "done" | "failed" | "running" | "skipped_reuse"; evaluation?: EvaluationDetail }): Promise<void>;
  /** L'état d'évaluation d'une participation, sans rien créer : `null` avant la première évaluation. */
  read(challengeId: string, userId: string, contributionType: string): Promise<EvaluationState | null>;
  /** Lance une tâche après la réponse ; ses erreurs sont journalisées, jamais renvoyées au geste. */
  schedule(task: () => Promise<void>): void;
}

export type RuntimeBlobs = Pick<Blobs, "store" | "get">;

/** La contribution qu'une étape soumise alimente, telle que la note la présente. */
export interface StepContribution {
  id: string;
  title: string;
  description: string | null;
}

/** La capacité `submissions` du core : les dépôts d'étape, leurs URLs, les contributions d'étape, la lignée. */
export interface RuntimeSubmissions {
  read(challengeId: string, userId: string): Promise<unknown>;
  submit(challenge: Challenge, userId: string, body: unknown, table: SubmissionTable, options: SubmissionOptions): Promise<Response | { repo: ChallengeRepo; submission: AcceptedSubmission | null }>;
  /** Le rôle du dépôt d'étape `repoId` sur ce challenge, ou `null`. */
  role(challengeId: string, repoId: string): Promise<string | null>;
  /** La contribution de ce type du porteur, ou `null` (une soumission retirée entre-temps). */
  contribution(challengeId: string, holderId: string, type: string): Promise<StepContribution | null>;
  lineage(challengeId: string, holderId: string, table: SubmissionTable, selectionRole: string | null): Promise<SubmissionLineage>;
}

/** Une contribution telle qu'un `link` la lit : son auteur, son URL, son type. */
export interface LinkedContribution {
  [key: string]: Value;
  id: string;
  author: string;
  /** Son titre : ce qu'un sélecteur en affiche. */
  title: string | null;
  url: string | null;
  kind: string;
  /** Les membres du groupe qui la porte (`contribution_members`) ; vide en solo. */
  members: string[];
}

export interface RuntimeContributions {
  find(contributionId: string): Promise<LinkedContribution | null>;
  /**
   * Les contributions du challenge source que ce challenge peut prendre pour
   * cible : du type qui porte le livrable exigé (`deliverables`).
   */
  eligible(challenge: Challenge, capability: string): Promise<LinkedContribution[]>;
}

export interface TemplateRuntime {
  resources: RuntimeResources;
  /** Les fichiers : un champ `file` porte une référence, jamais des octets. */
  blobs: RuntimeBlobs;
  /** Les contributions d'un challenge source, pour les champs `link`. */
  contributions: RuntimeContributions;
  ledger: RuntimeLedger;
  participations: RuntimeParticipations;
  submissions: RuntimeSubmissions;
  /** Le score d'une évaluation par grille, sur 0..1. */
  evaluate(request: EvaluateBinding): Promise<EvaluateResult>;
  evaluations: RuntimeEvaluations;
  /** Un observateur du catalogue (`http_proxy`, un connecteur…). */
  observe(capability: string, args: Record<string, Value>, context: ObserveContext): Promise<Value>;
  /** Les challenges d'un flow, pour ses jobs. */
  challengesOf(flowKey: string): Promise<Challenge[]>;
  /** Le nom affiché de chaque compte : l'identité du core, pour les lectures d'un manager. */
  names(userIds: readonly string[]): Promise<Record<string, string>>;
  random(): number;
  now(): Date;
}

export class RuntimeBindingError extends Error {}

/**
 * Un observateur qui refuse : un modèle, pas une panne — un endpoint injoignable
 * (502), un fichier purgé (410). Le moteur le rend tel quel, sans effet.
 */
export class ObserverRefusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Ce qu'un observateur sait de l'appel : le challenge, pour y ranger ce qu'il produit. */
export interface ObserveContext {
  challenge: Challenge;
  userId: string | null;
}

/**
 * Le workspace d'une ligne `challenge_teams`. Prêt comme le challenge code le
 * lit : une URL GitHub lisible en `external`, une branche prête et son URL en
 * `github`.
 */
export function workspaceView(row: { workspace_provider?: string | null; workspace_url?: string | null; workspace_ref?: string | null; workspace_status?: string | null }): WorkspaceView {
  const url = row.workspace_url ?? null;
  const readable = !!url && /github\.com\/[^/?#]+\/[^/?#]+?(?:\.git)?(?:\/tree\/[^?#]+)?(?:[?#]|$)/.test(url);
  const ready = row.workspace_provider === "external" ? readable : row.workspace_status === "ready" && !!row.workspace_ref && readable;
  return { provider: row.workspace_provider ?? null, url, ref: row.workspace_ref ?? null, status: row.workspace_status ?? null, ready };
}

/** Le port branché sur les capacités et les repositories du core. */
export function defaultRuntime(
  bindings: Partial<Pick<TemplateRuntime, "evaluate" | "evaluations" | "observe" | "random" | "now" | "challengesOf">> = {}
): TemplateRuntime {
  const repositories = () => import("../../database-service/repositories/index.js");
  let resourcesCapability: Resources | null = null;
  const res = async () => {
    if (!resourcesCapability) resourcesCapability = (await import("../../capabilities/resources.js")).resources();
    return resourcesCapability;
  };
  const lazy = <K extends keyof RuntimeResources>(name: K) =>
    (async (...args: unknown[]) => ((await res())[name] as (...a: unknown[]) => unknown)(...args)) as unknown as RuntimeResources[K];

  return {
    resources: {
      createMany: lazy("createMany"),
      draw: lazy("draw"),
      claimScoped: lazy("claimScoped"),
      heldInScope: lazy("heldInScope"),
      updateContext: lazy("updateContext"),
      grant: lazy("grant"),
      grantsFor: lazy("grantsFor"),
      activeClaim: lazy("activeClaim"),
      consume: lazy("consume"),
      release: lazy("release"),
      close: lazy("close"),
      reclose: lazy("reclose"),
      stampResolution: lazy("stampResolution"),
      resource: lazy("resource"),
      claim: lazy("claim"),
      consumedClaims: lazy("consumedClaims"),
      consumedBy: lazy("consumedBy"),
      list: lazy("list"),
      upsert: lazy("upsert"),
      update: lazy("update"),
      remove: lazy("remove"),
    },
    blobs: {
      async store(input) {
        const { blobs } = await import("../../capabilities/blobs.js");
        return blobs().store(input);
      },
      async get(blobId) {
        const { blobs } = await import("../../capabilities/blobs.js");
        return blobs().get(blobId);
      },
    },
    contributions: {
      async find(contributionId) {
        const { ContributionRepository } = await repositories();
        const { ContributionMemberRepository } = await repositories();
        const contribution = await new ContributionRepository().findById(contributionId);
        if (!contribution) return null;
        const members = await new ContributionMemberRepository().findByContribution(contribution.uuid);
        return linked(contribution, members.map((member) => member.user_id));
      },
      async eligible(challenge, capability) {
        if (!challenge.source_challenge_id) return [];
        const { ChallengeRepository, ContributionRepository } = await repositories();
        const { PlatformRegistry } = await import("../../registry/platform.js");
        const source = await new ChallengeRepository().findById(challenge.source_challenge_id);
        const deliverable = (source ? PlatformRegistry.flowFor(source) : undefined)?.deliverables?.find((candidate) => candidate.capabilities.includes(capability));
        if (!source || !deliverable) return [];
        const contributions = await new ContributionRepository().findByChallenge(source.uuid);
        return contributions.filter((contribution) => contribution.type === deliverable.contributionType).map((contribution) => linked(contribution));
      },
    },
    ledger: {
      async distributed(challengeId) {
        const { RewardEntryRepository } = await repositories();
        const { distributedFromPool } = await import("../../capabilities/pool.js");
        return distributedFromPool(new RewardEntryRepository(), challengeId);
      },
      async entries(challengeId) {
        const { RewardEntryRepository } = await repositories();
        return new RewardEntryRepository().findByChallenge(challengeId);
      },
      async contribution(challenge, userId, { type, title, description }) {
        const { ContributionRepository } = await repositories();
        const { contribution } = await new ContributionRepository().createIfAbsent({
          title,
          type,
          ...(description ? { description } : {}),
          reward: 0,
          user_id: userId,
          challenge_id: challenge.uuid,
          submitted_at: new Date(),
          evaluation_status: "done",
        });
        return contribution.uuid;
      },
      async write(drafts) {
        const { RewardEntryRepository } = await repositories();
        await new RewardEntryRepository().createManyAndSyncRewards(drafts);
      },
      async max(challengeId, query) {
        const { RewardEntryRepository } = await repositories();
        return new RewardEntryRepository().maxMetaNumber(challengeId, query);
      },
      async syncCompletion(challenge) {
        const { RewardEntryRepository, ChallengeRepository } = await repositories();
        const { distributedFromPool, poolCompletion } = await import("../../capabilities/pool.js");
        const distributed = await distributedFromPool(new RewardEntryRepository(), challenge.uuid);
        await new ChallengeRepository().update(challenge.uuid, { completion: poolCompletion(challenge.contribution_points_reward, distributed) });
      },
    },
    participations: {
      async context(challengeId, userId) {
        const { ChallengeTeamRepository } = await repositories();
        const { groupContextFrom } = await import("../../capabilities/groups.js");
        const teams = await new ChallengeTeamRepository().findByChallenge(challengeId);
        const group = groupContextFrom(teams, userId);
        const row = teams.find((team) => team.user_id === group.ownerId);
        return {
          participant: teams.some((team) => team.user_id === userId),
          holder: group.ownerId,
          groupId: group.groupId,
          members: group.memberIds,
          multiplier: group.multiplier,
          workspace: row ? workspaceView(row) : null,
        };
      },
      async board(challengeId, holderId) {
        const { boardProgress } = await import("../../capabilities/board.js");
        return boardProgress(challengeId, holderId);
      },
      async addShares(contributionId, shares) {
        const { ContributionMemberRepository } = await repositories();
        await new ContributionMemberRepository().addShares(shares.map((share) => ({ contribution_id: contributionId, user_id: share.userId, share_cp: share.points })));
      },
    },
    submissions: {
      async read(challengeId, userId) {
        return (await import("../../capabilities/submissions.js")).readSubmissions(challengeId, userId);
      },
      async submit(challenge, userId, body, table, options) {
        return (await import("../../capabilities/submissions.js")).submitToStep(challenge, userId, body, table, options);
      },
      async role(challengeId, repoId) {
        const { ChallengeRepoRepository } = await repositories();
        return (await new ChallengeRepoRepository().findByChallengeAndRepo(challengeId, repoId))?.role ?? null;
      },
      async contribution(challengeId, holderId, type) {
        const { ContributionRepository } = await repositories();
        const found = (await new ContributionRepository().findByChallenge(challengeId)).find((candidate) => candidate.user_id === holderId && candidate.type === type);
        return found ? { id: found.uuid, title: found.title, description: found.description ?? null } : null;
      },
      async lineage(challengeId, holderId, table, selectionRole) {
        return (await import("../../capabilities/submissions.js")).lineageOf(challengeId, holderId, table, selectionRole);
      },
    },
    evaluate:
      bindings.evaluate ??
      (async (request) => (await import("./bindings.js")).evaluateGrid(request)),
    evaluations: bindings.evaluations ?? {
      async claim(contributionId, artifactUrl) {
        const { ContributionRepository } = await repositories();
        return (await new ContributionRepository().claimEvaluation(contributionId, { artifact_url: artifactUrl })) !== null;
      },
      async finish(contributionId, { status, evaluation }) {
        const { ContributionRepository } = await repositories();
        // Le détail d'abord, le statut ensuite : l'ordre du flow ML, qui écrit la note dès qu'elle revient.
        if (evaluation) await new ContributionRepository().update(contributionId, { evaluation: evaluation as never });
        await new ContributionRepository().update(contributionId, { evaluation_status: status });
      },
      schedule(task) {
        void task().catch((error) => console.error("[interpreter] background evaluation failed:", error));
      },
      async read(challengeId, userId, contributionType) {
        const { ContributionRepository } = await repositories();
        const contribution = (await new ContributionRepository().findByChallenge(challengeId)).find(
          (candidate) => candidate.user_id === userId && candidate.type === contributionType
        );
        if (!contribution) return null;
        const evaluation = contribution.evaluation as EvaluationDetail | null | undefined;
        return {
          status: (contribution.evaluation_status as EvaluationState["status"]) ?? null,
          since: contribution.submitted_at,
          evaluation: evaluation && typeof evaluation === "object" && "globalScore" in evaluation ? evaluation : null,
          artifactUrl: contribution.artifact_url ?? null,
        };
      },
    },
    observe:
      bindings.observe ??
      (async (capability, args, context) => {
        if (capability === "http_proxy") return httpProxy(args, context);
        const { BOUND_CAPABILITIES, observeConnector } = await import("./bindings.js");
        if (BOUND_CAPABILITIES.has(capability)) return observeConnector(capability, args);
        throw new RuntimeBindingError(`no binding installed for capability ${capability}`);
      }),
    challengesOf: bindings.challengesOf ?? (async (flowKey) => {
      const { ChallengeRepository } = await repositories();
      return (await new ChallengeRepository().findAll()).filter((challenge) => challenge.type === flowKey);
    }),
    async names(userIds) {
      const { UserRepository } = await repositories();
      const users = await new UserRepository().findByIds([...userIds]);
      return Object.fromEntries(users.map((user) => [user.uuid, user.full_name]));
    },
    random: bindings.random ?? (() => Math.random()),
    now: bindings.now ?? (() => new Date()),
  };
}

/**
 * `http_proxy` : envoie un fichier à un endpoint par le proxy du core (SSRF
 * gardé, DNS épinglé, redirections refusées, 15 s, 10 Mo), et range la réponse
 * en blob. Un endpoint injoignable est un refus (502), un fichier purgé aussi (410).
 */
async function httpProxy(args: Record<string, Value>, context: ObserveContext): Promise<Value> {
  const { blobs } = await import("../../capabilities/blobs.js");
  const { proxyFileToEndpoint, EndpointCallError } = await import("../../capabilities/http-proxy/endpoint-proxy.js");
  const to = typeof args.to === "string" ? args.to : null;
  if (!to) throw new ObserverRefusal(400, "http_proxy needs an endpoint URL");

  const sent = args.send as { blob_id?: unknown } | null | undefined;
  let file: { buffer: Buffer; filename: string; mimeType: string } = { buffer: Buffer.alloc(0), filename: "input", mimeType: "application/octet-stream" };
  if (sent && typeof sent.blob_id === "string") {
    const blob = await blobs().get(sent.blob_id);
    if (!blob) throw new ObserverRefusal(404, "The file to send does not exist");
    if (!blob.bytes) throw new ObserverRefusal(410, "The file to send has been purged");
    file = { buffer: blob.bytes, filename: blob.filename ?? "input", mimeType: blob.content_type };
  }

  let result;
  try {
    result = await proxyFileToEndpoint(to, file);
  } catch (error) {
    if (error instanceof EndpointCallError) throw new ObserverRefusal(502, `The endpoint could not be reached: ${error.message}`);
    throw error;
  }
  const response = await blobs().store({
    challengeId: context.challenge.uuid,
    bytes: result.body,
    contentType: result.contentType,
    filename: "response",
    retentionDays: typeof args.retention_days === "number" ? args.retention_days : null,
  });
  return { status: result.status, ok: result.status >= 200 && result.status < 300, content_type: result.contentType, response: response as unknown as Value };
}

function linked(contribution: { uuid: string; user_id: string; title?: string | null; artifact_url?: string | null; live_endpoint_url?: string | null; type: string }, members: string[] = []): LinkedContribution {
  return {
    id: contribution.uuid,
    author: contribution.user_id,
    title: contribution.title ?? null,
    url: contribution.live_endpoint_url ?? contribution.artifact_url ?? null,
    kind: contribution.type,
    members,
  };
}
