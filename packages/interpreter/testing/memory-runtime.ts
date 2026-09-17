import type { Challenge, RewardEntry, RewardEntryDraft } from "../../database-service/domain/entities.js";
import { ClaimNotConsumableError, claimState, type ResourceClaim, type ResourceInstance } from "../../capabilities/resources.js";
import { outOfPoolRuleKeys } from "../../capabilities/pool.js";
import type { Value } from "../expr/evaluator.js";
import { workspaceView, type EvaluateBinding, type EvaluateResult, type EvaluationDetail, type RuntimeEvaluations, type TemplateRuntime } from "../compile/runtime.js";
import { groupContextFrom } from "../../database-service/domain/groupPolicy.js";
import { scopeKeyOf } from "../../capabilities/resources.js";
import type { StoredBlob } from "../../capabilities/blobs.js";
import { lineageFrom } from "../../capabilities/submissions.js";

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
  grants: { resource_id: string; field: string; participation: string; granted_by: string }[];
  /** Les contributions des challenges sources : `challenge` est le challenge source, `capabilities` ce qu'elles livrent. */
  contributionRows: { id: string; author: string; title?: string; url: string | null; kind: string; challenge: string; capabilities: string[]; members?: string[] }[];
  blobRows: StoredBlob[];
  ledgerRows: RewardEntry[];
  challenges: Challenge[];
  clock: Date;
  /** Les tirages successifs de `random()`, puis 0.99. */
  dice: number[];
  evaluations: RuntimeEvaluationsLog;
  /** Les participations, comme `challenge_teams` : groupe et workspace. */
  teams: { challenge_id: string; user_id: string; group_id?: string | null; workspace_provider?: string | null; workspace_url?: string | null; workspace_ref?: string | null; workspace_status?: string | null }[];
  /** Les tâches personnelles : `user_id` est le porteur du board. */
  tasks: { challenge_id: string; user_id: string; status: string }[];
  /** Les parts cumulées par (contribution, membre). */
  shares: Map<string, number>;
  completions: Map<string, number>;
  /** Les dépôts d'étape : `role` par `repo_id`, et la sélection de datasets par porteur (déjà normalisée). */
  stepRepos: { challenge_id: string; repo_id: string; role: string; selections?: Record<string, string[]> }[];
  /** Les contributions d'étape, comme `contributions` : ce que la lignée et la note lisent. */
  stepContributions: { uuid: string; challenge_id: string; user_id: string; type: string; title: string; description: string | null; artifact_url?: string; submitted_at: Date }[];
  /** Le statut d'évaluation écrit sur chaque contribution d'étape, dans l'ordre. */
  statuses: { contribution: string; status: string }[];
}

/**
 * Les évaluations demandées, et l'état d'évaluation des contributions : ce
 * que le port `evaluations` garantit — une à la fois, reprise après 30 minutes.
 * Les tâches planifiées attendent `settle()`.
 */
export interface RuntimeEvaluationsLog extends Array<EvaluateBinding>, RuntimeEvaluations {
  status: Map<string, { status: "running" | "done" | "failed"; since: Date; evaluation?: EvaluationDetail; artifactUrl: string | null }>;
  pending: Promise<void>[];
  errors: unknown[];
  settle(): Promise<void>;
}

export function memoryRuntime(options: {
  evaluate?: (request: EvaluateBinding) => Promise<EvaluateResult>;
  observe?: (capability: string, args: Record<string, Value>, runtime: MemoryRuntime) => Promise<Value>;
} = {}): MemoryRuntime {
  let sequence = 0;
  const id = (prefix: string) => `${prefix}-${++sequence}`;

  const runtime: MemoryRuntime = {
    instances: [],
    claims: [],
    grants: [],
    contributionRows: [],
    blobRows: [],
    ledgerRows: [],
    challenges: [],
    clock: new Date("2026-09-16T12:00:00Z"),
    dice: [],
    teams: [],
    tasks: [],
    shares: new Map(),
    completions: new Map(),
    stepRepos: [],
    stepContributions: [],
    statuses: [],
    // Le journal des demandes porte aussi le port `evaluations` : l'état des contributions, les tâches planifiées.
    evaluations: Object.assign([] as EvaluateBinding[], {
      status: new Map(),
      pending: [] as Promise<void>[],
      errors: [] as unknown[],
      async settle(this: RuntimeEvaluationsLog) {
        while (this.pending.length) await this.pending.shift();
      },
      async claim(contributionId: string, artifactUrl: string | null) {
        const log = runtime.evaluations;
        const current = log.status.get(contributionId);
        if (current?.status === "running" && runtime.clock.getTime() - current.since.getTime() < 30 * 60 * 1000) return false;
        log.status.set(contributionId, { ...current, status: "running", since: runtime.clock, artifactUrl });
        return true;
      },
      async finish(contributionId: string, outcome: { status: "done" | "failed" | "running" | "skipped_reuse"; evaluation?: EvaluationDetail }) {
        runtime.statuses.push({ contribution: contributionId, status: outcome.status });
        if (outcome.status === "running" || outcome.status === "skipped_reuse") return;
        const log = runtime.evaluations;
        const current = log.status.get(contributionId);
        log.status.set(contributionId, {
          since: current?.since ?? runtime.clock,
          artifactUrl: current?.artifactUrl ?? null,
          ...(current?.evaluation ? { evaluation: current.evaluation } : {}),
          status: outcome.status,
          ...(outcome.evaluation ? { evaluation: outcome.evaluation } : {}),
        });
      },
      schedule(task: () => Promise<void>) {
        const log = runtime.evaluations;
        log.pending.push(task().catch((error) => void log.errors.push(error)));
      },
      async read(challengeId: string, userId: string, contributionType: string) {
        const current = runtime.evaluations.status.get(`contribution-${challengeId}-${userId}-${contributionType}`);
        return current ? { status: current.status, since: current.since, evaluation: current.evaluation ?? null, artifactUrl: current.artifactUrl } : null;
      },
    }) as RuntimeEvaluationsLog,

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
          scope_key: "",
          scope_exclusive: false,
          context: null,
        };
        runtime.claims.push(claim);
        return { claimId: claim.uuid, resourceId: chosen.uuid, payload: chosen.payload, expiresAt };
      },

      async claimScoped(challengeId, userId, options) {
        const scopeKey = scopeKeyOf(options.scope);
        const instance = runtime.instances.find((candidate) => candidate.uuid === options.resourceId);
        if (!instance || instance.challenge_id !== challengeId || instance.state !== "open") return null;
        const now = runtime.clock;
        // L'échéance libère la combinaison, comme `releaseExpiredOn`.
        for (const claim of runtime.claims) {
          if (claim.resource_id === options.resourceId && claim.scope_key === scopeKey && (options.exclusive || claim.user_id === userId)
            && !claim.consumed_at && !claim.released_at && claim.expires_at && claim.expires_at.getTime() < now.getTime()) {
            claim.released_at = claim.expires_at;
          }
        }
        const live = runtime.claims.filter((claim) => claim.resource_id === options.resourceId && !claim.released_at);
        if (live.some((claim) => claim.user_id === userId && claim.scope_key === scopeKey)) return null;
        if (options.exclusive && live.some((claim) => claim.scope_exclusive && claim.scope_key === scopeKey)) return null;
        const expiresAt = options.ttlHours ? new Date(now.getTime() + options.ttlHours * 3_600_000) : null;
        const claim: ResourceClaim = {
          uuid: id("claim"),
          resource_id: options.resourceId,
          challenge_id: challengeId,
          user_id: userId,
          result: null,
          claimed_at: now,
          expires_at: expiresAt,
          consumed_at: null,
          released_at: null,
          scope_key: scopeKey,
          scope_exclusive: options.exclusive,
          context: null,
        };
        runtime.claims.push(claim);
        return { claimId: claim.uuid, resourceId: instance.uuid, payload: instance.payload, expiresAt };
      },

      async heldInScope(resourceIds, scope, userId) {
        const scopeKey = scopeKeyOf(scope);
        const held = runtime.claims.filter(
          (claim) => resourceIds.includes(claim.resource_id) && claim.scope_key === scopeKey && !claim.released_at
            && (claim.consumed_at || claimState(claim, runtime.clock) === "active")
            && (claim.scope_exclusive || claim.user_id === userId)
        );
        return new Set(held.map((claim) => claim.resource_id));
      },

      async updateContext(claimId, userId, patch) {
        const claim = runtime.claims.find((candidate) => candidate.uuid === claimId && candidate.user_id === userId);
        if (!claim || claimState(claim, runtime.clock) !== "active") return false;
        claim.context = { ...(claim.context ?? {}), ...JSON.parse(JSON.stringify(patch)) };
        return true;
      },

      async grant(resourceId, field, participation, grantedBy) {
        if (runtime.grants.some((row) => row.resource_id === resourceId && row.field === field && row.participation === participation)) return false;
        runtime.grants.push({ resource_id: resourceId, field, participation, granted_by: grantedBy });
        return true;
      },

      async grantsFor(resourceIds, participation) {
        const grants: Record<string, string[]> = {};
        for (const row of runtime.grants) {
          if (row.participation === participation && resourceIds.includes(row.resource_id)) (grants[row.resource_id] ??= []).push(row.field);
        }
        return grants;
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

      async reclose(resourceId, fromVerdict, verdict, resolution) {
        const instance = runtime.instances.find((candidate) => candidate.uuid === resourceId);
        if (!instance || instance.state !== "closed" || instance.verdict !== fromVerdict) return null;
        // Comme le repository : le verdict change, `resolution` se fusionne.
        Object.assign(instance, { verdict, resolution: { ...(instance.resolution ?? {}), ...resolution } });
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

      async upsert(challengeId, type, item, options) {
        const same = (instance: ResourceInstance) =>
          instance.challenge_id === challengeId && instance.resource_type === type &&
          options.by.every((name) => (name === "author" ? instance.created_by === options.createdBy : JSON.stringify(instance.payload[name] ?? null) === JSON.stringify(item.payload[name] ?? null)));
        const existing = runtime.instances.find(same);
        if (existing) {
          if (options.overwrite) Object.assign(existing, { payload: JSON.parse(JSON.stringify(item.payload)), class: item.class ?? null });
          return { id: existing.uuid, created: false };
        }
        await runtime.resources.createMany(challengeId, type, [item], { createdBy: options.createdBy });
        return { id: runtime.instances[runtime.instances.length - 1].uuid, created: true };
      },

      async update(resourceId, patch) {
        const instance = runtime.instances.find((candidate) => candidate.uuid === resourceId);
        if (!instance) return false;
        instance.payload = { ...instance.payload, ...JSON.parse(JSON.stringify(patch)) };
        return true;
      },

      async claimCount(resourceId) {
        return runtime.claims.filter((claim) => claim.resource_id === resourceId && (claim.consumed_at || claimState(claim, runtime.clock) === "active")).length;
      },

      async remove(resourceId) {
        const index = runtime.instances.findIndex((candidate) => candidate.uuid === resourceId);
        if (index < 0) return false;
        runtime.instances.splice(index, 1);
        runtime.claims = runtime.claims.filter((claim) => claim.resource_id !== resourceId);
        runtime.grants = runtime.grants.filter((grant) => grant.resource_id !== resourceId);
        return true;
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

    blobs: {
      async store(input) {
        const row: StoredBlob = {
          uuid: id("blob"),
          challenge_id: input.challengeId,
          content_type: input.contentType,
          filename: input.filename ?? null,
          size: input.bytes.length,
          bytes: input.bytes,
          retention_days: input.retentionDays ?? null,
          created_at: runtime.clock,
          purged_at: null,
        };
        runtime.blobRows.push(row);
        return { blob_id: row.uuid, content_type: row.content_type, filename: row.filename, size: row.size };
      },
      async get(blobId) {
        return runtime.blobRows.find((row) => row.uuid === blobId) ?? null;
      },
    },

    contributions: {
      async find(contributionId) {
        const row = runtime.contributionRows.find((candidate) => candidate.id === contributionId);
        return row ? { id: row.id, author: row.author, author_name: `name of ${row.author}`, title: row.title ?? null, url: row.url, kind: row.kind, members: row.members ?? [] } : null;
      },
      async eligible(challenge, capability) {
        return runtime.contributionRows
          .filter((row) => row.challenge === challenge.source_challenge_id && row.capabilities.includes(capability))
          .map((row) => ({ id: row.id, author: row.author, author_name: `name of ${row.author}`, title: row.title ?? null, url: row.url, kind: row.kind, members: row.members ?? [] }));
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
      async contribution(challenge, userId, { type }) {
        return `contribution-${challenge.uuid}-${userId}-${type}`;
      },
      async write(drafts: RewardEntryDraft[]) {
        for (const draft of drafts) runtime.ledgerRows.push({ ...draft, uuid: id("entry"), created_at: runtime.clock });
      },
      async max(challengeId, query) {
        const values = runtime.ledgerRows
          .filter((row) => row.challenge_id === challengeId && row.rule_key === query.ruleKey)
          .filter((row) => (query.excludeUserId === undefined || row.user_id !== query.excludeUserId) && (query.onlyUserId === undefined || row.user_id === query.onlyUserId))
          .map((row) => Number((row.meta as Record<string, unknown> | undefined)?.[query.field]))
          .filter((value) => Number.isFinite(value));
        return values.length ? Math.max(...values) : null;
      },
      async syncCompletion(challenge) {
        const distributed = await runtime.ledger.distributed(challenge.uuid);
        runtime.completions.set(challenge.uuid, challenge.contribution_points_reward > 0 ? Math.min(1, distributed / challenge.contribution_points_reward) : 0);
      },
    },

    participations: {
      async context(challengeId, userId) {
        const teams = runtime.teams.filter((team) => team.challenge_id === challengeId);
        const group = groupContextFrom(teams as never, userId);
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
        const tasks = runtime.tasks.filter((task) => task.challenge_id === challengeId && task.user_id === holderId);
        return { total: tasks.length, done: tasks.filter((task) => task.status === "done").length };
      },
      async addShares(contributionId, shares) {
        for (const share of shares) {
          const key = `${contributionId}:${share.userId}`;
          runtime.shares.set(key, (runtime.shares.get(key) ?? 0) + share.points);
        }
      },
    },

    submissions: {
      async read() {
        throw new Error("no submissions read in this test");
      },
      async submit() {
        throw new Error("no submission route in this test");
      },
      async role(challengeId, repoId) {
        return runtime.stepRepos.find((repo) => repo.challenge_id === challengeId && repo.repo_id === repoId)?.role ?? null;
      },
      async contribution(challengeId, holderId, type) {
        const found = runtime.stepContributions.find((row) => row.challenge_id === challengeId && row.user_id === holderId && row.type === type);
        return found ? { id: found.uuid, title: found.title, description: found.description } : null;
      },
      async lineage(challengeId, holderId, table, selectionRole) {
        const selection = selectionRole && table[selectionRole]
          ? {
              contributionType: table[selectionRole].contributionType,
              urls: runtime.stepRepos.filter((repo) => repo.challenge_id === challengeId && repo.role === selectionRole).flatMap((repo) => repo.selections?.[holderId] ?? []),
            }
          : null;
        return lineageFrom(runtime.stepContributions.filter((row) => row.challenge_id === challengeId) as never, holderId, table, selection);
      },
    },

    async evaluate(request) {
      runtime.evaluations.push(request);
      if (!options.evaluate) throw new Error("no evaluation binding in this test");
      return options.evaluate(request);
    },

    async observe(capability, args, _context) {
      if (!options.observe) throw new Error(`no binding for ${capability} in this test`);
      return options.observe(capability, args, runtime);
    },

    async challengesOf(flowKey) {
      return runtime.challenges.filter((challenge) => challenge.type === flowKey);
    },

    async names(userIds) {
      return Object.fromEntries(userIds.map((userId) => [userId, `name of ${userId}`]));
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
          context: claim.context,
        };
      })
      .sort((a, b) => b.consumed_at.getTime() - a.consumed_at.getTime());
  }

  return runtime;
}
