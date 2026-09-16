import type { Challenge, RewardEntry, RewardEntryDraft } from "../../database-service/domain/entities.js";
import { ClaimNotConsumableError, claimState, type ResourceClaim, type ResourceInstance } from "../../capabilities/resources.js";
import { outOfPoolRuleKeys } from "../../capabilities/pool.js";
import type { Value } from "../expr/evaluator.js";
import type { EvaluateBinding, TemplateRuntime } from "../compile/runtime.js";

/**
 * Un runtime en mémoire, pour les tests
 * -------------------------------------
 * Reproduit ce que les capacités garantissent : `k` compte les réclamations
 * actives et consommées, une personne n'a qu'une réclamation vivante par
 * ressource, l'échéance est paresseuse, un tirage prend d'abord ce que
 * l'appelant n'a jamais réclamé puis l'ordre de création, `close` et
 * `stampResolution` sont premiers arrivés ; `close` remplace `resolution`,
 * `stampResolution` ne marque qu'une ressource fermée. Le hasard et l'horloge sont fixés
 * par le test.
 */

export interface MemoryRuntime extends TemplateRuntime {
  instances: ResourceInstance[];
  claims: ResourceClaim[];
  ledgerRows: RewardEntry[];
  challenges: Challenge[];
  clock: Date;
  /** Les tirages successifs de `random()`, puis 0.99. */
  dice: number[];
  evaluations: EvaluateBinding[];
}

export function memoryRuntime(options: {
  evaluate?: (request: EvaluateBinding) => Promise<number>;
  observe?: (capability: string, args: Record<string, Value>) => Promise<Value>;
} = {}): MemoryRuntime {
  let sequence = 0;
  const id = (prefix: string) => `${prefix}-${++sequence}`;

  const runtime: MemoryRuntime = {
    instances: [],
    claims: [],
    ledgerRows: [],
    challenges: [],
    clock: new Date("2026-09-16T12:00:00Z"),
    dice: [],
    evaluations: [],

    resources: {
      async createMany(challengeId, type, items, opts) {
        for (const item of items) {
          runtime.instances.push({
            uuid: id(type),
            challenge_id: challengeId,
            resource_type: type,
            payload: item.payload,
            class: item.class ?? null,
            state: "open",
            verdict: null,
            resolution: null,
            created_by: opts?.createdBy ?? null,
            created_at: new Date(runtime.clock.getTime() + sequence),
            closed_at: null,
          });
        }
        return items.length;
      },

      async draw(challengeId, userId, options) {
        const now = runtime.clock;
        const live = (claim: ResourceClaim) => !claim.released_at && (claim.consumed_at || claimState(claim, now) === "active");
        const candidates = runtime.instances
          .filter((instance) => instance.challenge_id === challengeId && instance.resource_type === options.type && instance.state === "open")
          .filter((instance) => options.class === undefined || instance.class === options.class)
          .filter((instance) => !runtime.claims.some((claim) => claim.resource_id === instance.uuid && claim.user_id === userId && live(claim)))
          .filter((instance) => options.k === undefined || runtime.claims.filter((claim) => claim.resource_id === instance.uuid && live(claim)).length < options.k)
          .sort((a, b) => {
            const seen = (instance: ResourceInstance) => runtime.claims.some((claim) => claim.resource_id === instance.uuid && claim.user_id === userId);
            return Number(seen(a)) - Number(seen(b)) || a.created_at.getTime() - b.created_at.getTime();
          });
        const chosen = candidates[0];
        if (!chosen) return null;
        const expiresAt = options.ttlHours ? new Date(now.getTime() + options.ttlHours * 3_600_000) : null;
        const claim: ResourceClaim = {
          uuid: id("claim"),
          resource_id: chosen.uuid,
          challenge_id: challengeId,
          user_id: userId,
          result: null,
          claimed_at: now,
          expires_at: expiresAt,
          consumed_at: null,
          released_at: null,
        };
        runtime.claims.push(claim);
        return { claimId: claim.uuid, resourceId: chosen.uuid, payload: chosen.payload, expiresAt };
      },

      async activeClaim(challengeId, userId) {
        const claim = runtime.claims.find(
          (candidate) => candidate.challenge_id === challengeId && candidate.user_id === userId && claimState(candidate, runtime.clock) === "active"
        );
        if (!claim) return null;
        return { claim, resource: runtime.instances.find((instance) => instance.uuid === claim.resource_id)! };
      },

      async consume(claimId, userId, result) {
        const claim = runtime.claims.find((candidate) => candidate.uuid === claimId);
        if (!claim || claim.user_id !== userId) throw new ClaimNotConsumableError("not_found");
        const state = claimState(claim, runtime.clock);
        if (state !== "active") throw new ClaimNotConsumableError(state === "consumed" ? "consumed" : "lapsed");
        claim.consumed_at = new Date(runtime.clock.getTime() + ++sequence);
        claim.result = JSON.parse(JSON.stringify(result));
        return claim;
      },

      async release(claimId, userId) {
        const claim = runtime.claims.find((candidate) => candidate.uuid === claimId && candidate.user_id === userId);
        if (!claim || claimState(claim, runtime.clock) !== "active") return false;
        claim.released_at = runtime.clock;
        return true;
      },

      async close(resourceId, verdict, resolution) {
        const instance = runtime.instances.find((candidate) => candidate.uuid === resourceId);
        if (!instance || instance.state !== "open") return null;
        Object.assign(instance, { state: "closed", verdict, resolution: resolution ?? null, closed_at: runtime.clock });
        return instance as never;
      },

      async stampResolution(resourceId, key, value) {
        const instance = runtime.instances.find((candidate) => candidate.uuid === resourceId);
        // Comme le repository : une marque ne se pose que sur une ressource fermée.
        if (!instance || instance.state !== "closed" || (instance.resolution && key in instance.resolution)) return null;
        instance.resolution = { ...(instance.resolution ?? {}), [key]: value };
        return instance as never;
      },

      async resource(resourceId) {
        return runtime.instances.find((instance) => instance.uuid === resourceId) ?? null;
      },

      async claim(claimId) {
        return runtime.claims.find((claim) => claim.uuid === claimId) ?? null;
      },

      async consumedClaims(resourceId) {
        return consumed().filter((claim) => claim.resource_id === resourceId);
      },

      async consumedBy(filter) {
        return consumed(filter.challengeId)
          .filter((claim) => filter.userId === undefined || claim.user_id === filter.userId)
          .filter((claim) => filter.type === undefined || claim.resource_type === filter.type);
      },

      async list(filter) {
        return runtime.instances
          .filter((instance) => filter.challengeId === undefined || instance.challenge_id === filter.challengeId)
          .filter((instance) => filter.type === undefined || instance.resource_type === filter.type)
          .filter((instance) => filter.state === undefined || instance.state === filter.state)
          .filter((instance) => filter.verdict === undefined || instance.verdict === filter.verdict)
          .filter((instance) => !filter.withoutResolutionKey || !(instance.resolution && filter.withoutResolutionKey in instance.resolution));
      },
    },

    ledger: {
      async distributed(challengeId) {
        const outOfPool = new Set(outOfPoolRuleKeys());
        return runtime.ledgerRows
          .filter((row) => row.challenge_id === challengeId && !outOfPool.has(row.rule_key))
          .reduce((sum, row) => sum + row.points, 0);
      },
      async entries(challengeId) {
        return runtime.ledgerRows.filter((row) => row.challenge_id === challengeId);
      },
      async contribution(challenge, userId, type) {
        return `contribution-${challenge.uuid}-${userId}-${type}`;
      },
      async write(drafts: RewardEntryDraft[]) {
        for (const draft of drafts) runtime.ledgerRows.push({ ...draft, uuid: id("entry"), created_at: runtime.clock });
      },
    },

    async evaluate(request) {
      runtime.evaluations.push(request);
      if (!options.evaluate) throw new Error("no evaluation binding in this test");
      return options.evaluate(request);
    },

    async observe(capability, args) {
      if (!options.observe) throw new Error(`no binding for ${capability} in this test`);
      return options.observe(capability, args);
    },

    async challengesOf(flowKey) {
      return runtime.challenges.filter((challenge) => challenge.type === flowKey);
    },

    random: () => runtime.dice.shift() ?? 0.99,
    now: () => runtime.clock,
  };

  function consumed(challengeId?: string) {
    return runtime.claims
      .filter((claim) => claim.consumed_at && (challengeId === undefined || claim.challenge_id === challengeId))
      .map((claim) => {
        const instance = runtime.instances.find((candidate) => candidate.uuid === claim.resource_id)!;
        return {
          claim_id: claim.uuid,
          resource_id: claim.resource_id,
          resource_type: instance.resource_type,
          user_id: claim.user_id,
          payload: instance.payload,
          result: claim.result ?? {},
          consumed_at: claim.consumed_at!,
        };
      })
      .sort((a, b) => b.consumed_at.getTime() - a.consumed_at.getTime());
  }

  return runtime;
}
