import type { Challenge, RewardEntryDraft } from "../../database-service/domain/entities.js";
import { ClaimNotConsumableError } from "../../capabilities/resources.js";
import { readsRoot, type Expr } from "../expr/ast.js";
import { evaluate, type Value } from "../expr/evaluator.js";
import { parseExpr } from "../expr/parser.js";
import type { AggregateDecl, ClaimUse, ExprSource, RewardBody, TransitionBody } from "../format/schema.js";
import type { EffectModel, NodeModel, TemplateModel } from "../validate/format.js";
import type { TemplateRuntime } from "./runtime.js";
import { resourceValue, type ResourceTypes } from "./values.js";

/**
 * Le moteur d'un template compilé
 * -------------------------------
 * Exécute une suite de nœuds sur les capacités, dans l'ordre de la lane. Les
 * trois issues de la spec (§3.4) sont littérales : un succès continue, un
 * refus (`Refusal`) répond un 4xx sans effet, une erreur remonte en 5xx.
 *
 * Le travail d'un claim est livré (`consume`) au premier nœud qui en a besoin
 * — une évaluation qui écrit des compteurs, une émission vers un aggregate, une
 * récompense — ou en fin de lane. Le résultat du claim garde ce que les nœuds
 * ont produit : les champs collectés, la valeur des métriques qui écrivent des
 * compteurs, les entrées émises. Les compteurs se dérivent de ces résultats ;
 * rien n'est stocké à part (compromis 5).
 */

export class Refusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface CompiledTemplate {
  model: TemplateModel;
  flowKey: string;
  contributionType: string;
  runtime: TemplateRuntime;
  resourceTypes: ResourceTypes;
  /** La clé de ledger de chaque récompense. */
  ruleKeys: ReadonlyMap<RewardBody, string>;
  /** Les métriques qui écrivent des compteurs : `(nœud, compteur, incrément)`. */
  counterWrites: readonly { node: string; counter: string; add: ExprSource }[];
}

interface ClaimHold {
  actId: string;
  claimId: string;
  resourceId: string;
  consumed: boolean;
}

export interface RunState {
  challenge: Challenge;
  /** `null` pour un job : personne n'agit. */
  userId: string | null;
  bindings: Record<string, Value>;
  claim: ClaimHold | null;
  result: { fields: Record<string, Value>; metrics: Record<string, Value>; inputs: Record<string, Value> };
  /** Les points versés à l'appelant pendant cette exécution. */
  awarded: number;
  /** Ce que la réponse peut dire du claim tiré. */
  drawn: { claimId: string; resourceId: string; expiresAt: Date | null } | null;
}

export function newState(challenge: Challenge, userId: string | null, params: Record<string, Value>): RunState {
  const state = challenge.status === "completed" || challenge.status === "archived" ? "closed" : "open";
  return {
    challenge,
    userId,
    bindings: { params, challenge: { state }, participation: { user: userId } },
    claim: null,
    result: { fields: {}, metrics: {}, inputs: {} },
    awarded: 0,
    drawn: null,
  };
}

const astCache = new Map<string, Expr>();
function astOf(source: string): Expr {
  let ast = astCache.get(source);
  if (!ast) {
    ast = parseExpr(source);
    astCache.set(source, ast);
  }
  return ast;
}

const TTL_UNITS: Record<string, number> = { m: 1 / 60, h: 1, d: 24 };
const ttlHours = (ttl: string | undefined) => (ttl ? Number.parseInt(ttl, 10) * TTL_UNITS[ttl.slice(-1)] : undefined);

export class Engine {
  constructor(private readonly t: CompiledTemplate) {}

  private get shell() {
    return this.t.model.shell;
  }

  // ── Expressions ─────────────────────────────────────────────────────────

  /** Évalue une expression ; charge d'abord les compteurs ou les collections de ressources qu'elle lit. */
  async eval(source: ExprSource, state: RunState, extra: Record<string, Value> = {}): Promise<Value> {
    if (typeof source !== "string") return source;
    const ast = astOf(source);
    const bindings = { ...state.bindings, ...extra };
    if (!("counters" in bindings) && readsRoot(ast, "counters")) {
      state.bindings.counters = await this.counters(state);
      bindings.counters = state.bindings.counters;
    }
    for (const name of Object.keys(this.shell.resources)) {
      if (!(name in bindings) && readsRoot(ast, name)) {
        const instances = await this.t.runtime.resources.list({ challengeId: state.challenge.uuid, type: name });
        bindings[name] = await Promise.all(instances.map((instance) => resourceValue(instance, this.t.runtime.resources, this.t.resourceTypes)));
      }
    }
    return evaluate(ast, bindings, { now: this.t.runtime.now() });
  }

  private async number(source: ExprSource, state: RunState, extra?: Record<string, Value>): Promise<number> {
    const value = await this.eval(source, state, extra);
    if (typeof value !== "number") throw new Error(`[interpreter] expected a number from '${source}', got ${JSON.stringify(value)}`);
    return value;
  }

  /** Les compteurs de l'appelant, dérivés des résultats de ses claims consommés. */
  private async counters(state: RunState): Promise<Record<string, Value>> {
    const counters: Record<string, Value> = Object.fromEntries(Object.keys(this.shell.counters).map((name) => [name, 0]));
    if (!state.userId) return counters;
    const claims = await this.t.runtime.resources.consumedBy({ challengeId: state.challenge.uuid, userId: state.userId });
    for (const claim of claims) {
      const metrics = (claim.result?.metrics ?? {}) as Record<string, Value>;
      for (const write of this.t.counterWrites) {
        if (!(write.node in metrics)) continue;
        const added = await this.eval(write.add, { ...state, bindings: { params: state.bindings.params } }, { value: metrics[write.node] });
        counters[write.counter] = (counters[write.counter] as number) + (added as number);
      }
    }
    return counters;
  }

  // ── Nœuds ───────────────────────────────────────────────────────────────

  async run(nodes: readonly NodeModel[], state: RunState): Promise<void> {
    for (const node of nodes) await this.node(node, state);
  }

  private async node(node: NodeModel, state: RunState): Promise<void> {
    switch (node.family) {
      case "collect":
        if (!(node.id in state.bindings)) throw new Error(`[interpreter] collect ${node.id} ran without its gesture`);
        return;

      case "act":
        return this.act(node, state);

      case "assess":
        return this.assess(node, state);

      case "gate":
        if (node.body.all) {
          for (const condition of node.body.all) {
            if ((await this.eval(condition, state)) !== true) throw new Refusal(422, `Refused by ${node.id}`);
          }
          return;
        }
        for (const branch of node.branches ?? []) {
          if (branch.when === null || (await this.eval(branch.when, state)) === true) {
            await this.run(branch.nodes, state);
            return;
          }
        }
        return;

      case "reward":
        await this.deliver(state);
        await this.pay(node.body, state, { claim_id: state.claim?.claimId ?? null, node: node.id });
        return;
    }
  }

  private async act(node: Extract<NodeModel, { family: "act" }>, state: RunState): Promise<void> {
    const { body } = node;
    if (body.claim) await this.draw(node.id, body.claim, state);

    if (body.capability !== undefined) {
      const args: Record<string, Value> = {};
      for (const [key, value] of Object.entries(body)) {
        if (["id", "kind", "capability", "store", "claim"].includes(key)) continue;
        args[key] = await this.eval(value as ExprSource, state);
      }
      const output = await this.t.runtime.observe(body.capability, args);
      state.bindings[node.id] = body.store ? { [body.store]: output } : output;
      return;
    }

    if (body.create !== undefined) {
      await this.create(body.create, body, state);
      return;
    }

    if (body.transition) {
      await this.transition(body.transition, state, null);
    }
  }

  private async draw(actId: string, claim: ClaimUse, state: RunState): Promise<void> {
    const { runtime } = this.t;
    const main = claim.resource;
    const substitute = claim.substitute?.resource;
    const userId = state.userId!;

    // Un tirage répété rend la réclamation active : le geste est idempotent.
    const active = await runtime.resources.activeClaim(state.challenge.uuid, userId);
    if (active && (active.resource.resource_type === main || active.resource.resource_type === substitute)) {
      await this.hold(actId, claim, active.claim.uuid, active.resource.uuid, state);
      state.drawn = { claimId: active.claim.uuid, resourceId: active.resource.uuid, expiresAt: active.claim.expires_at };
      return;
    }

    const options = async (type: string) => {
      const decl = this.shell.resources[type].claim!;
      const k = decl.mode === "exclusive" ? 1 : decl.mode === "k_bounded" && decl.k !== undefined ? await this.number(decl.k, state) : undefined;
      return { type, k, ttlHours: ttlHours(decl.ttl) };
    };

    let drawn = null;
    if (substitute && runtime.random() < (await this.number(claim.substitute!.rate, state))) {
      drawn = await runtime.resources.draw(state.challenge.uuid, userId, await options(substitute));
    }
    if (!drawn) {
      const mainOptions: { type: string; k?: number; ttlHours?: number; class?: string } = await options(main);
      if (claim.where !== undefined) mainOptions.class = await this.classFilter(claim.where, state);
      drawn = await runtime.resources.draw(state.challenge.uuid, userId, mainOptions);
    }
    if (!drawn) throw new Refusal(409, "Nothing left to claim");
    await this.hold(actId, claim, drawn.claimId, drawn.resourceId, state);
    state.drawn = { claimId: drawn.claimId, resourceId: drawn.resourceId, expiresAt: drawn.expiresAt };
  }

  /** `R.class == "x" || <condition>` : pas de filtre quand la condition tient, sinon la classe. */
  private async classFilter(where: ExprSource, state: RunState): Promise<string | undefined> {
    const ast = astOf(String(where));
    const alternative = ast.k === "binary" && ast.op === "||" ? ast.right : null;
    const test = alternative && ast.k === "binary" ? ast.left : ast;
    const literal = test.k === "binary" && test.right.k === "lit" ? String(test.right.value) : undefined;
    if (alternative) {
      if (!("counters" in state.bindings) && readsRoot(alternative, "counters")) state.bindings.counters = await this.counters(state);
      if (evaluate(alternative, state.bindings, { now: this.t.runtime.now() }) === true) return undefined;
    }
    return literal;
  }

  /** Lie la sortie d'un Act de claim : l'instance sous son type, l'autre à `null`, `substituted`. */
  async hold(actId: string, claim: ClaimUse, claimId: string, resourceId: string, state: RunState): Promise<void> {
    const instance = await this.t.runtime.resources.resource(resourceId);
    if (!instance) throw new Refusal(404, "Claimed resource not found");
    const value = await resourceValue(instance, this.t.runtime.resources, this.t.resourceTypes);
    const output: Record<string, Value> = { [claim.resource]: null };
    if (claim.substitute) {
      output[claim.substitute.resource] = null;
      output.substituted = instance.resource_type === claim.substitute.resource;
    }
    output[instance.resource_type] = value;
    state.bindings[actId] = output;
    state.claim = { actId, claimId, resourceId, consumed: false };
  }

  private async create(type: string, body: Extract<NodeModel, { family: "act" }>["body"], state: RunState): Promise<void> {
    const fields = Object.keys(this.shell.resources[type].fields);
    const base: Record<string, unknown> = {};
    for (const source of body.from === undefined ? [] : [body.from].flat()) {
      const value = await this.eval(source, state);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const name of fields) if (name in value) base[name] = (value as Record<string, Value>)[name];
      }
    }
    for (const [name, source] of Object.entries(body.set ?? {})) {
      const value = await this.eval(source, state);
      base[name] = value && typeof value === "object" && !Array.isArray(value) && "id" in value ? value.id : value;
    }

    const rows: Record<string, unknown>[] = [];
    if (body.many) {
      const file = await this.eval(body.many.from_file, state);
      if (!Array.isArray(file)) throw new Refusal(400, "A batch is a list of rows");
      for (const row of file) {
        if (!row || typeof row !== "object" || Array.isArray(row)) throw new Refusal(400, "Each row of a batch is an object");
        const payload = { ...base };
        for (const name of fields) if (name in row) payload[name] = (row as Record<string, Value>)[name];
        rows.push(payload);
      }
    } else {
      rows.push(base);
    }

    const items = rows.map((payload) => {
      const { class: klass, ...rest } = payload;
      return { payload: fields.includes("class") ? payload : rest, class: typeof klass === "string" ? klass : null };
    });
    await this.t.runtime.resources.createMany(state.challenge.uuid, type, items, { createdBy: state.userId });
  }

  private async transition(body: TransitionBody, state: RunState, aggregateVerdict: Value): Promise<boolean> {
    const target = await this.eval(body.resource, state);
    const id = target && typeof target === "object" && !Array.isArray(target) ? target.id : null;
    if (typeof id !== "string") throw new Error(`[interpreter] transition on a non-resource: ${body.resource}`);
    if (body.to !== "closed") throw new Error("[interpreter] reopening a resource is not compiled in v1");

    const instance = await this.t.runtime.resources.resource(id);
    const verdicts = (instance && this.shell.resources[instance.resource_type]?.closure?.verdict) ?? [];
    let verdict: string;
    if (body.verdict !== undefined) {
      verdict = verdicts.includes(body.verdict) ? body.verdict : String(await this.eval(body.verdict, state));
    } else if (typeof aggregateVerdict === "string" && verdicts.includes(aggregateVerdict)) {
      verdict = aggregateVerdict;
    } else {
      verdict = "closed";
    }
    const closed = await this.t.runtime.resources.close(id, verdict, aggregateVerdict === null ? undefined : { verdict: aggregateVerdict });
    return closed !== null;
  }

  private async assess(node: Extract<NodeModel, { family: "assess" }>, state: RunState): Promise<void> {
    const { body } = node;
    let output: Value = {};
    switch (body.kind) {
      case "ai_grid": {
        const grid = await this.eval(body.grid!, state);
        const inputs = await Promise.all((body.input ?? []).map((input) => this.eval(input, state)));
        const score = await this.t.runtime.evaluate({ challenge: state.challenge, userId: state.userId!, grid: String(grid), inputs });
        output = { score };
        break;
      }
      case "human":
        output = body.from ? state.bindings[body.from] ?? {} : state.bindings[node.id] ?? {};
        break;
      case "metric": {
        const value = await this.eval(body.value!, state);
        output = { value };
        if (body.counters) {
          if (state.claim?.consumed) throw new Error(`[interpreter] metric ${node.id} writes counters after the work was delivered`);
          state.result.metrics[node.id] = value;
          await this.deliver(state);
        }
        break;
      }
      case "self":
        throw new Error("[interpreter] self assessment is not compiled in v1");
    }
    state.bindings[node.id] = output;

    if (body.emit) {
      const aggregateId = body.emit.to.replace(/^lifecycle\./, "");
      const target = await this.eval(body.emit.scope, state);
      const resourceId = target && typeof target === "object" && !Array.isArray(target) ? target.id : null;
      if (typeof resourceId !== "string") throw new Error(`[interpreter] emit scope is not a resource`);
      if (state.claim?.consumed) throw new Error(`[interpreter] ${node.id} emits after the work was delivered`);
      state.result.inputs[aggregateId] = output;
      await this.deliver(state);
      await this.resolve(aggregateId, resourceId, state.challenge, state.bindings.params as Record<string, Value>);
    }
  }

  /** Livre le travail du claim tenu : une seule fois, avec tout ce que la lane a produit jusque-là. */
  async deliver(state: RunState): Promise<void> {
    const hold = state.claim;
    if (!hold || hold.consumed || !state.userId) return;
    try {
      await this.t.runtime.resources.consume(hold.claimId, state.userId, state.result as unknown as Record<string, unknown>);
    } catch (error) {
      if (!(error instanceof ClaimNotConsumableError)) throw error;
      if (error.reason === "consumed") throw new Refusal(409, "This work was already delivered");
      if (error.reason === "lapsed") throw new Refusal(410, "This claim expired or was released; claim again");
      throw new Refusal(404, "Claim not found");
    }
    hold.consumed = true;
    delete state.bindings.counters;
  }

  // ── Aggregates ──────────────────────────────────────────────────────────

  private aggregate(id: string): { decl: AggregateDecl; then: EffectModel[] } {
    const aggregate = this.t.model.aggregates.find((candidate) => candidate.decl.id === id);
    if (!aggregate) throw new Error(`[interpreter] unknown aggregate ${id}`);
    return aggregate;
  }

  /** Les entrées d'un aggregate sur une instance, dans l'ordre de livraison. */
  async inputs(aggregateId: string, resourceId: string): Promise<Value[]> {
    const claims = await this.t.runtime.resources.consumedClaims(resourceId);
    return [...claims]
      .sort((a, b) => a.consumed_at.getTime() - b.consumed_at.getTime())
      .filter((claim) => claim.result?.inputs && aggregateId in (claim.result.inputs as Record<string, unknown>))
      .map((claim) => ({
        ...((claim.result.inputs as Record<string, Record<string, Value>>)[aggregateId] ?? {}),
        participation: { user: claim.user_id },
        author: claim.user_id,
      }));
  }

  /** Vérifie la condition de résolution, et résout : dans le geste qui apporte l'entrée décisive. */
  async resolve(aggregateId: string, resourceId: string, challenge: Challenge, params: Record<string, Value>, lifecycle = false): Promise<void> {
    const { decl, then } = this.aggregate(aggregateId);
    const instance = await this.t.runtime.resources.resource(resourceId);
    if (!instance || instance.state !== "open") return;

    const state = newState(challenge, null, params);
    if (lifecycle) state.bindings.challenge = { state: "closed" };
    state.bindings.inputs = await this.inputs(aggregateId, resourceId);
    state.bindings[decl.over] = await resourceValue(instance, this.t.runtime.resources, this.t.resourceTypes);
    if ((await this.eval(decl.resolve.when, state)) !== true) return;

    const verdict = decl.resolve.verdict !== undefined ? await this.eval(decl.resolve.verdict, state) : null;
    state.bindings.verdict = verdict;
    for (const effect of then) {
      if (effect.family === "transition") {
        // Premier arrivé : une résolution concurrente qui a fermé d'abord a déjà tout fait.
        if (!(await this.transition(effect.body, state, verdict))) return;
      } else if (effect.family === "reward") {
        await this.pay(effect.body, state, { resource_id: resourceId, aggregate: aggregateId });
      }
    }
  }

  // ── Ledger ──────────────────────────────────────────────────────────────

  /** Les destinataires d'une récompense : l'appelant, ou ce que `to` désigne. */
  private async recipients(body: RewardBody, state: RunState): Promise<string[]> {
    if (body.to === undefined) return state.userId ? [state.userId] : [];
    const value = await this.eval(body.to, state);
    const userOf = (item: Value): string | null => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const participation = item.participation;
        if (participation && typeof participation === "object" && !Array.isArray(participation) && typeof participation.user === "string") {
          return participation.user;
        }
        if (typeof item.author === "string") return item.author;
      }
      return null;
    };
    return (Array.isArray(value) ? value : [value]).map(userOf).filter((user): user is string => user !== null);
  }

  async pay(body: RewardBody, state: RunState, meta: Record<string, Value>): Promise<void> {
    if (typeof body.amount === "object") throw new Error("[interpreter] mapped rewards are not compiled in v1");
    const { runtime } = this.t;
    const ruleKey = this.t.ruleKeys.get(body)!;
    const recipients = await this.recipients(body, state);
    if (recipients.length === 0) return;

    const challengeId = state.challenge.uuid;
    const existing = await runtime.ledger.entries(challengeId);
    let distributed = await runtime.ledger.distributed(challengeId);
    const drafts: RewardEntryDraft[] = [];

    for (const userId of recipients) {
      const entryMeta = { ...meta, template: this.t.flowKey };
      // Rejouer le geste ne paie pas deux fois : même clé, même méta, même personne.
      // Sans clé naturelle (ni claim ni ressource), chaque geste paie.
      const keyed = Boolean(meta.claim_id || meta.resource_id);
      const duplicate = keyed && existing.some(
        (entry) => entry.rule_key === ruleKey && entry.user_id === userId && sameMeta(entry.meta as Record<string, unknown> | undefined, entryMeta)
      );
      if (duplicate) continue;

      let points = Math.round(await this.number(body.amount, state));
      if (body.clamp === "pool" && points > 0) {
        points = Math.min(points, Math.max(0, state.challenge.contribution_points_reward - distributed));
      }
      if (points === 0) continue;

      const contributionId = await runtime.ledger.contribution(state.challenge, userId, this.t.contributionType);
      drafts.push({ challenge_id: challengeId, user_id: userId, contribution_id: contributionId, rule_key: ruleKey, points, meta: entryMeta });
      if (body.pool !== undefined) distributed += points;
      if (userId === state.userId) state.awarded += points;
    }
    if (drafts.length > 0) await runtime.ledger.write(drafts);
  }
}

function sameMeta(stored: Record<string, unknown> | undefined, meta: Record<string, Value>): boolean {
  if (!stored) return false;
  return Object.entries(meta).every(([key, value]) => (stored[key] ?? null) === value);
}
