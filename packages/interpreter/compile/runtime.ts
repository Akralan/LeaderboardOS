import type { Challenge, RewardEntry, RewardEntryDraft } from "../../database-service/domain/entities.js";
import type { Resources } from "../../capabilities/resources.js";
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
  | "activeClaim"
  | "consume"
  | "release"
  | "close"
  | "stampResolution"
  | "resource"
  | "claim"
  | "consumedClaims"
  | "consumedBy"
  | "list"
>;

export interface RuntimeLedger {
  /** Ce qui a déjà été pris sur le pool du challenge. */
  distributed(challengeId: string): Promise<number>;
  entries(challengeId: string): Promise<RewardEntry[]>;
  /** La contribution qui porte les lignes d'un participant ; créée au premier paiement. */
  contribution(challenge: Challenge, userId: string, type: string): Promise<string>;
  write(drafts: RewardEntryDraft[]): Promise<void>;
}

export interface EvaluateBinding {
  challenge: Challenge;
  userId: string;
  grid: string;
  inputs: Value[];
}

export interface TemplateRuntime {
  resources: RuntimeResources;
  ledger: RuntimeLedger;
  /** Le score global d'une évaluation par grille. */
  evaluate(request: EvaluateBinding): Promise<number>;
  /** Un observateur du catalogue (`http_proxy`, un connecteur…). */
  observe(capability: string, args: Record<string, Value>): Promise<Value>;
  /** Les challenges d'un flow, pour ses jobs. */
  challengesOf(flowKey: string): Promise<Challenge[]>;
  random(): number;
  now(): Date;
}

export class RuntimeBindingError extends Error {}

/** Le port branché sur les capacités et les repositories du core. */
export function defaultRuntime(bindings: Partial<Pick<TemplateRuntime, "evaluate" | "observe">> = {}): TemplateRuntime {
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
      activeClaim: lazy("activeClaim"),
      consume: lazy("consume"),
      release: lazy("release"),
      close: lazy("close"),
      stampResolution: lazy("stampResolution"),
      resource: lazy("resource"),
      claim: lazy("claim"),
      consumedClaims: lazy("consumedClaims"),
      consumedBy: lazy("consumedBy"),
      list: lazy("list"),
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
      async contribution(challenge, userId, type) {
        const { ContributionRepository } = await repositories();
        const { contribution } = await new ContributionRepository().createIfAbsent({
          title: challenge.title,
          type,
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
    },
    evaluate:
      bindings.evaluate ??
      (async ({ grid }) => {
        throw new RuntimeBindingError(`no evaluation binding installed for grid ${grid}`);
      }),
    observe:
      bindings.observe ??
      (async (capability) => {
        throw new RuntimeBindingError(`no binding installed for capability ${capability}`);
      }),
    async challengesOf(flowKey) {
      const { ChallengeRepository } = await repositories();
      return (await new ChallengeRepository().findAll()).filter((challenge) => challenge.type === flowKey);
    },
    random: Math.random,
    now: () => new Date(),
  };
}
