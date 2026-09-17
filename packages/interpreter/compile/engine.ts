import type { Challenge, RewardEntryDraft } from "../../database-service/domain/entities.js";
import { ClaimNotConsumableError, type ConsumedClaim } from "../../capabilities/resources.js";
import { readsRoot, type Expr } from "../expr/ast.js";
import { LEDGER_FUNCTIONS, evaluate, ledgerKey, type Value } from "../expr/evaluator.js";
import { parseExpr } from "../expr/parser.js";
import type { AggregateDecl, ClaimUse, ExprSource, RewardBody, TransitionBody } from "../format/schema.js";
import type { EffectModel, NodeModel, TemplateModel } from "../validate/format.js";
import { ObserverRefusal, type EvaluationDetail, type ParticipationContext, type TemplateRuntime } from "./runtime.js";
import { splitShares } from "../../database-service/domain/share.js";
import { parseCsv } from "./csv.js";
import { zodOf } from "./params.js";
import { deserializeValue, resourceValue, serializeValue, type ResourceTypes } from "./values.js";

/**
 * Le moteur d'un template compilé
 * -------------------------------
 * Exécute une suite de nœuds sur les capacités, dans l'ordre de la lane. Les
 * trois issues de la spec (§3.4) sont littérales : un succès continue, un
 * refus (`Refusal`) répond un 4xx sans effet, une erreur remonte en 5xx.
 *
 * Le travail d'un claim est livré (`consume`) au premier nœud qui en a besoin
 * — une évaluation qui écrit des compteurs, une émission vers un aggregate, une
 * récompense — ou en fin de lane. Le résultat du claim ne garde que les champs
 * du geste, à plat : la forme qu'un flow écrit à la main stocke (compromis 11).
 * Les métriques et les entrées d'aggregate ne sont pas stockées : elles se
 * rejouent, à la lecture, depuis ces champs et la charge de la ressource
 * (`replay`). Les compteurs se dérivent ainsi (compromis 5).
 */

export class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** La raison lisible par une interface (`tasks_not_done`…). */
    readonly reason?: string
  ) {
    super(message);
  }
}

/**
 * Une évaluation en arrière-plan : le geste s'arrête là. Les nœuds déjà passés
 * ont tout vérifié ; l'appelant prend l'évaluation, planifie la suite et répond 202.
 */
export class Deferred extends Error {
  constructor(
    readonly node: Extract<NodeModel, { family: "assess" }>,
    readonly grid: string,
    readonly inputs: Value[]
  ) {
    super(`[interpreter] ${node.id} continues in the background`);
  }
}

/** Le score d'une liaison d'évaluation, avec son détail s'il est connu. */
export function scoreOf(result: number | { score: number; evaluation: unknown }): { score: number; evaluation: unknown } {
  return typeof result === "number" ? { score: result, evaluation: null } : result;
}

export interface CompiledTemplate {
  model: TemplateModel;
  flowKey: string;
  runtime: TemplateRuntime;
  resourceTypes: ResourceTypes;
  /** La clé de ledger de chaque récompense. */
  ruleKeys: ReadonlyMap<RewardBody, string>;
  /** Pour une récompense `reverse`, la clé de ledger qu'elle reprend. */
  reversedKeys: ReadonlyMap<RewardBody, string>;
  /** Les métriques qui écrivent des compteurs : `(nœud, compteur, incrément)`. */
  counterWrites: readonly { node: string; counter: string; add: ExprSource }[];
  /** Par type de ressource tirée : ce qu'il faut rejouer d'un claim livré. */
  replays: ReadonlyMap<string, ReplaySpec>;
  /** La version publiée d'un template en base ; `null` pour un template système. */
  version: string | null;
  /** Le type et le titre de la contribution qui porte les lignes du ledger. */
  contribution: { type: string; title: string };
  /** Les aggregates qui reçoivent des entrées d'un claim posé sur une autre ressource (un case, émis vers un target). */
  crossEmits: ReadonlySet<string>;
  /** Le template lit la participation (groupe, workspace, board) : elle se charge avant chaque exécution. */
  participationContext: boolean;
  /** Les lanes jouées en groupe (`access.group: true`) : le porteur agit pour tous. */
  groupLanes: ReadonlySet<string>;
  /** La description de la contribution, une expression sur `challenge`. */
  contributionDescription: ExprSource | null;
  /** La clé de ledger de chaque transfert déclaré. */
  transferKeys: ReadonlyMap<object, string>;
  /** Les paramètres de type `role` : ce que `participation.qualified` lit. */
  roleParams: readonly string[];
  /** Une lane lit `participation.qualified` : les qualifications se vérifient avant chaque geste. */
  readsQualified: boolean;
}

/** Le segment qui livre le travail d'un claim : l'Act qui l'a tiré, les gestes qui l'ont rempli, les nœuds à rejouer. */
export interface ReplaySpec {
  claimActId: string;
  claim: ClaimUse;
  /** Les gestes après le claim : ceux du dernier segment se relisent du résultat, les autres du contexte. */
  gestures: readonly { id: string; fields: readonly string[]; final: boolean }[];
  nodes: readonly NodeModel[];
}

/** Ce qu'un claim livré a produit, rejoué. */
interface Replayed {
  metrics: Record<string, Value>;
  inputs: Record<string, Record<string, Value>>;
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
  /** Les champs des gestes du segment, à plat : le résultat du claim livré. */
  result: Record<string, Value>;
  /** Les points versés à l'appelant pendant cette exécution. */
  awarded: number;
  /** Ce que la réponse peut dire du claim tiré. */
  drawn: { claimId: string; resourceId: string; expiresAt: Date | null } | null;
  /** Qui a fait le geste ; `userId` est le porteur quand la lane se joue en groupe. */
  caller: string | null;
  /** Le groupe du porteur, dans une lane jouée en groupe. */
  group: ParticipationContext | null;
  /** Par geste, les champs que la requête portait vraiment : ce qu'un `update from` réécrit. */
  sent: Record<string, readonly string[]>;
  /** Les instances qu'un `create` à `upsert` a créées ou retrouvées, par Act : ce que la réponse rend. */
  created: Record<string, string>;
  /**
   * Une lane jouée pour une soumission : la contribution de l'étape (ses lignes
   * de ledger, sa note) et ce qu'un run d'évaluation rejoue.
   */
  submission: { contributionId: string; origin: { handler: string; payload: Record<string, unknown> } } | null;
  /** Le détail de la dernière évaluation par grille, à écrire sur la contribution. */
  evaluation: EvaluationDetail | null;
}

export function newState(challenge: Challenge, userId: string | null, params: Record<string, Value>): RunState {
  const state = challenge.status === "completed" || challenge.status === "archived" ? "closed" : "open";
  return {
    challenge,
    userId,
    bindings: { params, challenge: { state, title: challenge.title }, participation: { user: userId } },
    claim: null,
    result: {},
    awarded: 0,
    drawn: null,
    caller: userId,
    group: null,
    sent: {},
    created: {},
    submission: null,
    evaluation: null,
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
const DURATION = /^[0-9]+[mhd]$/;

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
        const instances = await this.instancesOf(state.challenge.uuid, name);
        bindings[name] = await Promise.all(instances.map((instance) => resourceValue(instance, this.t.runtime, this.t.resourceTypes)));
      }
    }
    return evaluate(ast, bindings, { now: this.t.runtime.now(), ledger: await this.ledgerReads(ast, state) });
  }

  /**
   * `best`, `best_of_others`, `best_of_mine` : le plus grand `meta.<champ>` d'une
   * clé de ledger sur le challenge, pour tous, pour les autres que le porteur,
   * pour lui seul — lu avant l'évaluation, comme le flow ML lit la meilleure métrique.
   */
  private async ledgerReads(ast: Expr, state: RunState): Promise<Record<string, number | null> | undefined> {
    const calls: { callee: string; rule: string; field: string }[] = [];
    const visit = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      const candidate = node as { k?: string; callee?: string; args?: { k: string; value?: unknown }[] };
      if (candidate.k === "call" && (LEDGER_FUNCTIONS as readonly string[]).includes(candidate.callee ?? "")) {
        const [rule, field] = candidate.args ?? [];
        if (typeof rule?.value === "string" && typeof field?.value === "string") calls.push({ callee: candidate.callee!, rule: rule.value, field: field.value });
      }
      for (const value of Object.values(node)) Array.isArray(value) ? value.forEach(visit) : visit(value);
    };
    visit(ast);
    if (calls.length === 0) return undefined;
    const reads: Record<string, number | null> = {};
    for (const { callee, rule, field } of calls) {
      const key = ledgerKey(callee, rule, field);
      if (key in reads) continue;
      const holder = state.userId ?? undefined;
      reads[key] = await this.t.runtime.ledger.max(state.challenge.uuid, {
        ruleKey: rule,
        field,
        ...(callee === "best_of_others" && holder ? { excludeUserId: holder } : {}),
        ...(callee === "best_of_mine" && holder ? { onlyUserId: holder } : {}),
      });
    }
    return reads;
  }

  /** Les instances d'un type, dans leur ordre : `ordered_by` quand le type en déclare un, la création sinon. */
  async instancesOf(challengeId: string, type: string) {
    const instances = await this.t.runtime.resources.list({ challengeId, type });
    const field = this.shell.resources[type]?.ordered_by;
    if (!field) return instances;
    const position = (instance: { payload: Record<string, unknown> }) => (typeof instance.payload[field] === "number" ? (instance.payload[field] as number) : Number.MAX_SAFE_INTEGER);
    return [...instances].sort((a, b) => position(a) - position(b) || a.created_at.getTime() - b.created_at.getTime());
  }

  private async number(source: ExprSource, state: RunState, extra?: Record<string, Value>): Promise<number> {
    const value = await this.eval(source, state, extra);
    if (typeof value !== "number") throw new Error(`[interpreter] expected a number from '${source}', got ${JSON.stringify(value)}`);
    return value;
  }

  /** Les compteurs de l'appelant, dérivés des résultats de ses claims consommés ; `lag: false` pour la vue du manager. */
  async counters(state: RunState, options: { lag?: boolean } = {}): Promise<Record<string, Value>> {
    const counters: Record<string, Value> = Object.fromEntries(Object.keys(this.shell.counters).map((name) => [name, 0]));
    if (!state.userId) return counters;
    // Les plus récents d'abord : un compteur à `lag` saute ses `lag` premiers.
    const claims = await this.t.runtime.resources.consumedBy({ challengeId: state.challenge.uuid, userId: state.userId });
    for (const [index, claim] of claims.entries()) {
      const { metrics } = await this.replay(claim, state.bindings.params as Record<string, Value>);
      for (const write of this.t.counterWrites) {
        if (!(write.node in metrics)) continue;
        if (options.lag !== false && index < (this.shell.counters[write.counter]?.lag ?? 0)) continue;
        const added = await this.eval(write.add, { ...state, bindings: { params: state.bindings.params } }, { value: metrics[write.node] });
        counters[write.counter] = (counters[write.counter] as number) + (added as number);
      }
    }
    return counters;
  }

  /**
   * Rejoue le segment de livraison d'un claim sur ses champs stockés : les
   * branches prises, la valeur des métriques qui écrivent des compteurs, les
   * entrées émises. Pur : le compilateur a vérifié que ces nœuds ne lisent que
   * les paramètres, le claim et les gestes.
   */
  async replay(claim: ConsumedClaim, params: Record<string, Value>): Promise<Replayed> {
    const replayed: Replayed = { metrics: {}, inputs: {} };
    const spec = this.t.replays.get(claim.resource_type);
    if (!spec) return replayed;

    const drawn: Record<string, Value> = { [spec.claim.resource]: null };
    if (spec.claim.substitute) {
      drawn[spec.claim.substitute.resource] = null;
      drawn.substituted = claim.resource_type === spec.claim.substitute.resource;
    }
    drawn[claim.resource_type] = { ...(claim.payload as Record<string, Value>), id: claim.resource_id };
    const bindings: Record<string, Value> = { params, [spec.claimActId]: drawn };
    const result = (claim.result ?? {}) as Record<string, Value>;
    const stored = (claim.context ?? {}) as Record<string, Value>;
    for (const gesture of spec.gestures) {
      const source = gesture.final ? result : ((stored[gesture.id] ?? {}) as Record<string, Value>);
      bindings[gesture.id] = Object.fromEntries(gesture.fields.map((field) => [field, source[field] ?? null]));
    }
    const context = { now: this.t.runtime.now() };
    const run = (source: ExprSource) => (typeof source === "string" ? evaluate(astOf(source), bindings, context) : source);

    const walk = (nodes: readonly NodeModel[]) => {
      for (const node of nodes) {
        if (node.family === "gate" && node.branches) {
          const taken = node.branches.find((branch) => branch.when === null || run(branch.when) === true);
          if (taken) walk(taken.nodes);
          continue;
        }
        if (node.family !== "assess") continue;
        const { body } = node;
        let output: Record<string, Value> | null = null;
        if (body.kind === "metric" && (body.counters || body.emit)) {
          const value = run(body.value!);
          if (body.counters) replayed.metrics[node.id] = value;
          output = { value };
        } else if (body.kind === "human" && body.emit) {
          output = (bindings[body.from ?? node.id] ?? {}) as Record<string, Value>;
        }
        if (output) bindings[node.id] = output;
        if (body.emit && output) replayed.inputs[body.emit.to.replace(/^lifecycle./, "")] = output;
      }
    };
    walk(spec.nodes);
    return replayed;
  }

  // ── Participation ───────────────────────────────────────────────────────

  /**
   * La participation de l'appelant (capacités `groups`, `workspaces`, `board`) :
   * son porteur, son groupe, le workspace et le board du porteur. Dans une lane
   * jouée en groupe, le porteur agit pour tous — contribution, ledger et
   * évaluation sont les siens, comme au challenge code.
   */
  async bindParticipation(state: RunState, laneId: string): Promise<void> {
    if (!this.t.participationContext || !state.caller) return;
    const { runtime } = this.t;
    const context = await runtime.participations.context(state.challenge.uuid, state.caller);
    const group = { size: context.members.length, multiplier: context.multiplier, members: context.members };
    state.bindings.participation = {
      user: state.caller,
      holder: context.holder,
      group,
      workspace: { ...(context.workspace ?? { provider: "", url: "", ref: "", status: "", ready: false }) } as Record<string, Value>,
    };
    if (this.t.groupLanes.has(laneId)) {
      state.userId = context.holder;
      state.group = context;
      state.bindings.group = group;
    }
    if (this.shell.presentation?.board) state.bindings.board = await runtime.participations.board(state.challenge.uuid, context.holder);
  }

  /** La contribution qui porte le travail et le ledger d'un participant ; créée au premier besoin. */
  async contributionFor(state: RunState, userId: string): Promise<string> {
    // Une soumission : la contribution de son étape, écrite par la capacité `submissions`.
    if (state.submission && userId === state.userId) return state.submission.contributionId;
    const description = this.t.contributionDescription === null ? null : String(await this.eval(this.t.contributionDescription, state));
    return this.t.runtime.ledger.contribution(state.challenge, userId, { ...this.t.contribution, description });
  }

  /**
   * Les parts d'un groupe : ce que l'exécution a versé au porteur, réparti entre
   * les membres présents (`splitShares`, le reste au porteur), cumulé sur la
   * contribution. Rien pour un solo.
   */
  async settleShares(state: RunState): Promise<void> {
    const group = state.group;
    if (!group || group.members.length <= 1 || state.awarded <= 0 || !state.userId) return;
    const contributionId = await this.contributionFor(state, state.userId);
    const shares = splitShares(state.awarded, group.members, group.holder);
    await this.t.runtime.participations.addShares(contributionId, [...shares].map(([userId, points]) => ({ userId, points })));
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
            if ((await this.eval(condition, state)) !== true) {
              throw new Refusal(node.body.refuse ?? 422, node.body.message ?? `Refused by ${node.id}`, node.body.reason);
            }
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
        // Une ligne payée sur un claim ne porte que lui : la forme du flow écrit à la main.
        await this.pay(node.body, state, state.claim ? { claim_id: state.claim.claimId } : { node: node.id });
        return;
    }
  }

  /** Un tirage (`resource: item`, le moteur choisit) ou une instance désignée (`resource: pick.case`). */
  isDraw(claim: ClaimUse): boolean {
    return /^[a-z][a-z0-9_]*$/.test(claim.resource) && claim.resource in this.shell.resources;
  }

  private async act(node: Extract<NodeModel, { family: "act" }>, state: RunState): Promise<void> {
    const { body } = node;
    const designated = body.claim !== undefined && !this.isDraw(body.claim);
    if (body.claim && !designated) await this.draw(node.id, body.claim, state);

    if (body.capability !== undefined) {
      const args: Record<string, Value> = {};
      for (const [key, value] of Object.entries(body)) {
        if (["id", "kind", "capability", "store", "claim"].includes(key)) continue;
        args[key] = await this.eval(value as ExprSource, state);
      }
      let output: Value;
      try {
        output = await this.t.runtime.observe(body.capability, args, { challenge: state.challenge, userId: state.userId });
      } catch (error) {
        if (error instanceof ObserverRefusal) throw new Refusal(error.status, error.message);
        throw error;
      }
      state.bindings[node.id] = body.store ? { [body.store]: output } : output;
    }

    // L'observation d'abord, la réclamation ensuite : un endpoint injoignable ne
    // laisse aucune réclamation, et une course perdue a seulement observé.
    if (designated) await this.claimDesignated(node.id, body.claim!, state);
    if (body.capability !== undefined) return;

    if (body.grant) {
      await this.grant(node.id, body.grant.field, state);
      return;
    }

    if (body.create !== undefined) {
      await this.create(node.id, body.create, body, state);
      return;
    }

    if (body.update) {
      await this.update(body.update, state);
      return;
    }

    if (body.delete !== undefined) {
      const guarded = typeof body.delete === "object" ? body.delete : null;
      const instance = await this.designated(guarded ? guarded.resource : (body.delete as ExprSource), state);
      const refuse = (message: string, count: number) => new Refusal(409, message.replace(/\{count\}/g, String(count)));
      if (guarded?.unclaimed) {
        const claims = await this.t.runtime.resources.claimCount(instance.uuid);
        if (claims > 0) throw refuse(guarded.unclaimed, claims);
      }
      if (guarded?.without_inputs) {
        const inputs = await this.inputs(guarded.without_inputs.aggregate, instance.uuid, state.bindings.params as Record<string, Value>);
        if (inputs.length > 0) throw refuse(guarded.without_inputs.message, inputs.length);
      }
      if (!(await this.t.runtime.resources.remove(instance.uuid))) throw new Refusal(404, `This ${instance.resource_type} no longer exists`);
      if (this.shell.resources[instance.resource_type]?.ordered_by) await this.renumber(state.challenge.uuid, instance.resource_type, null);
      return;
    }

    if (body.transition) {
      // La fermeture sert de verrou : un geste qui arrive après une autre fermeture est refusé.
      if (!(await this.transition(body.transition, state, undefined))) {
        throw new Refusal(409, "This resource is not in the state this gesture expects");
      }
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
      return { type, k, ttlHours: await this.ttlHours(type, state) };
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

  /**
   * Les classes que l'appelant peut tirer, par type de ressource tirée : toutes
   * les valeurs du champ `class` quand aucun filtre ne le retient, sinon la
   * seule classe que le filtre laisse passer. La déclaration de clearance du
   * claim, évaluée pour lui.
   */
  async eligibleClasses(state: RunState): Promise<Record<string, string[]>> {
    const eligible: Record<string, string[]> = {};
    for (const spec of new Set(this.t.replays.values())) {
      const type = spec.claim.resource;
      const field = this.t.resourceTypes.get(type)?.class;
      if (!field || field.kind !== "enum" || !field.values) continue;
      const only = spec.claim.where === undefined ? undefined : await this.classFilter(spec.claim.where, state);
      eligible[type] = only === undefined ? [...field.values] : [only];
    }
    return eligible;
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

  private async ttlHours(type: string, state: RunState): Promise<number | undefined> {
    const decl = this.shell.resources[type].claim;
    if (!decl || decl.ttl === undefined) return undefined;
    if (typeof decl.ttl === "string" && DURATION.test(decl.ttl)) return Number.parseInt(decl.ttl, 10) * TTL_UNITS[decl.ttl.slice(-1)];
    return this.number(decl.ttl, state);
  }

  /**
   * Réclame une instance désignée dans son scope (`unique_per`) : la personne
   * sort de l'unicité quand les dimensions ne la nomment pas. Une combinaison
   * déjà tenue est un refus (409), jamais une seconde réclamation.
   */
  private async claimDesignated(actId: string, claim: ClaimUse, state: RunState): Promise<void> {
    const target = await this.eval(claim.resource, state);
    const resourceId = target && typeof target === "object" && !Array.isArray(target) ? target.id : null;
    if (typeof resourceId !== "string") throw new Refusal(404, "Nothing to claim");
    const instance = await this.t.runtime.resources.resource(resourceId);
    const decl = instance ? this.shell.resources[instance.resource_type]?.claim : undefined;
    if (!instance || !decl) throw new Refusal(404, "Nothing to claim");

    const scope: Record<string, string> = {};
    for (const [dimension, source] of Object.entries(claim.scope ?? {})) {
      const value = await this.eval(source, state);
      scope[dimension] = value && typeof value === "object" && !Array.isArray(value) ? String(value.id) : String(value);
    }
    const claimed = await this.t.runtime.resources.claimScoped(state.challenge.uuid, state.userId!, {
      resourceId,
      scope,
      exclusive: !(decl.dimensions ?? []).includes("participation"),
      ttlHours: await this.ttlHours(instance.resource_type, state),
    });
    if (!claimed) throw new Refusal(409, "This combination is already claimed");
    if (!(actId in state.bindings)) state.bindings[actId] = {};
    state.claim = { actId, claimId: claimed.claimId, resourceId, consumed: false };
    state.drawn = { claimId: claimed.claimId, resourceId, expiresAt: claimed.expiresAt };
  }

  /** Le reveal : le champ désigné devient lisible à l'appelant. */
  private async grant(nodeId: string, field: ExprSource, state: RunState): Promise<void> {
    const ast = astOf(String(field));
    if (ast.k !== "member") throw new Error(`[interpreter] grant ${nodeId} does not name a resource field`);
    const owner = evaluate(ast.object, state.bindings, { now: this.t.runtime.now() });
    const resourceId = owner && typeof owner === "object" && !Array.isArray(owner) ? owner.id : null;
    if (typeof resourceId !== "string") throw new Error(`[interpreter] grant ${nodeId} does not name a resource`);
    await this.t.runtime.resources.grant(resourceId, ast.name, state.userId!, nodeId);
  }

  /** Reprend un claim désigné d'un segment précédent : la réclamation, et ce que la lane en a gardé. */
  async holdDesignated(actId: string, claimId: string, resourceId: string, context: Record<string, unknown> | null, state: RunState): Promise<void> {
    state.claim = { actId, claimId, resourceId, consumed: false };
    state.bindings[actId] = {};
    await this.restore(context, state);
  }

  /** Remet dans le contexte d'exécution ce qu'un segment précédent a gardé sur le claim. */
  async restore(context: Record<string, unknown> | null, state: RunState): Promise<void> {
    for (const [key, value] of Object.entries(context ?? {})) {
      if (key.startsWith("$")) continue;
      state.bindings[key] = await deserializeValue(value as Value, this.t.runtime, this.t.resourceTypes);
    }
  }

  /** Garde sur le claim ce que les segments suivants liront. Les ressources n'y entrent que par leur référence. */
  async persist(ids: readonly string[], state: RunState): Promise<Record<string, Value>> {
    const hold = state.claim;
    const patch: Record<string, Value> = {};
    for (const id of ids) if (id in state.bindings) patch[id] = serializeValue(state.bindings[id]);
    if (!hold || hold.consumed || !state.userId || Object.keys(patch).length === 0) return patch;
    if (!(await this.t.runtime.resources.updateContext(hold.claimId, state.userId, patch))) {
      throw new Refusal(410, "This claim expired or was released; claim again");
    }
    return patch;
  }

  /** Lie la sortie d'un Act de claim : l'instance sous son type, l'autre à `null`, `substituted`. */
  async hold(actId: string, claim: ClaimUse, claimId: string, resourceId: string, state: RunState): Promise<void> {
    const instance = await this.t.runtime.resources.resource(resourceId);
    if (!instance) throw new Refusal(404, "Claimed resource not found");
    const value = await resourceValue(instance, this.t.runtime, this.t.resourceTypes);
    const output: Record<string, Value> = { [claim.resource]: null };
    if (claim.substitute) {
      output[claim.substitute.resource] = null;
      output.substituted = instance.resource_type === claim.substitute.resource;
    }
    output[instance.resource_type] = value;
    state.bindings[actId] = output;
    state.claim = { actId, claimId, resourceId, consumed: false };
  }

  /** L'instance qu'une expression désigne, sur ce challenge ; 404 sinon. */
  private async designated(source: ExprSource, state: RunState) {
    const target = await this.eval(source, state);
    const id = target && typeof target === "object" && !Array.isArray(target) ? target.id : null;
    const instance = typeof id === "string" ? await this.t.runtime.resources.resource(id) : null;
    if (!instance || instance.challenge_id !== state.challenge.uuid || !this.shell.resources[instance.resource_type]) {
      throw new Refusal(404, "Resource not found");
    }
    return instance;
  }

  /** Une valeur de champ telle que la charge la garde : une ressource ou une contribution par son id. */
  private stored(value: Value): unknown {
    return value && typeof value === "object" && !Array.isArray(value) && "id" in value && !("blob_id" in value) ? (value as { id: unknown }).id : value;
  }

  /** Les erreurs d'une valeur de champ : requise sauf `optional`, de son type, conforme à son `check`. */
  private async fieldErrors(type: string, name: string, value: unknown, state: RunState): Promise<string | null> {
    const field = this.shell.resources[type].fields[name];
    if (value === undefined || value === null) return field.optional ? null : `${name} is required`;
    const parsed = zodOf((this.t.resourceTypes.get(type) ?? {})[name]).safeParse(value);
    if (!parsed.success) return `${name}: ${parsed.error.issues[0]?.message ?? "invalid"}`;
    if (field.check !== undefined && (await this.checks(field.check, value as Value, state)) !== true) return `${name} fails its check`;
    return null;
  }

  /**
   * `update` : les champs qu'un geste a vraiment portés (`from`) puis `set`,
   * validés comme à la création. Un champ `ordered_by` réécrit déplace
   * l'instance à cet index (borné) et renumérote la fratrie.
   */
  private async update(body: NonNullable<Extract<NodeModel, { family: "act" }>["body"]["update"]>, state: RunState): Promise<void> {
    const instance = await this.designated(body.resource, state);
    const type = instance.resource_type;
    const decl = this.shell.resources[type];
    const patch: Record<string, unknown> = {};
    if (body.from !== undefined) {
      const gesture = state.bindings[body.from];
      const values = gesture && typeof gesture === "object" && !Array.isArray(gesture) ? (gesture as Record<string, Value>) : {};
      for (const name of state.sent[body.from] ?? []) if (name in decl.fields && name in values) patch[name] = this.stored(values[name]);
    }
    for (const [name, source] of Object.entries(body.set ?? {})) patch[name] = this.stored(await this.eval(source, state));

    const errors: string[] = [];
    for (const [name, value] of Object.entries(patch)) {
      const error = await this.fieldErrors(type, name, value, state);
      if (error) errors.push(error);
    }
    if (errors.length > 0) throw new Refusal(400, errors.join("; "));

    const order = decl.ordered_by;
    const move = order !== undefined && order in patch ? (patch[order] as number) : null;
    if (order !== undefined) delete patch[order];
    if (Object.keys(patch).length > 0 && !(await this.t.runtime.resources.update(instance.uuid, patch))) {
      throw new Refusal(404, `This ${type} no longer exists`);
    }
    if (move !== null) await this.renumber(state.challenge.uuid, type, { id: instance.uuid, to: move });
  }

  /**
   * Des positions denses (0..n-1) : l'instance déplacée réinsérée à son index
   * borné, puis toute la fratrie réécrite là où elle diffère — deux positions
   * égales laisseraient l'ordre à la date de création.
   */
  private async renumber(challengeId: string, type: string, moving: { id: string; to: number } | null): Promise<void> {
    const field = this.shell.resources[type].ordered_by!;
    const ordered = await this.instancesOf(challengeId, type);
    let sequence = ordered;
    if (moving) {
      const moved = ordered.find((instance) => instance.uuid === moving.id);
      const others = ordered.filter((instance) => instance.uuid !== moving.id);
      const at = Math.max(0, Math.min(moving.to, others.length));
      sequence = moved ? [...others.slice(0, at), moved, ...others.slice(at)] : others;
    }
    for (const [index, instance] of sequence.entries()) {
      if (instance.payload[field] !== index) await this.t.runtime.resources.update(instance.uuid, { [field]: index });
    }
  }

  private async create(actId: string, type: string, body: Extract<NodeModel, { family: "act" }>["body"], state: RunState): Promise<void> {
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
    // Une ressource ou une contribution référencée se range par son id, jamais hydratée.
    for (const [name, value] of Object.entries(base)) {
      if (value && typeof value === "object" && !Array.isArray(value) && "id" in value && !("blob_id" in value)) base[name] = (value as { id: unknown }).id;
    }

    const rows: Record<string, unknown>[] = [];
    if (body.many) {
      const file = await this.rowsOf(await this.eval(body.many.from_file, state));
      if (!Array.isArray(file)) throw new Refusal(400, "A batch is a list of rows");
      if (file.length === 0) throw new Refusal(400, "The batch has no rows");
      for (const row of file) {
        if (!row || typeof row !== "object" || Array.isArray(row)) throw new Refusal(400, "Each row of a batch is an object");
        const payload = { ...base };
        for (const name of fields) if (name in row) payload[name] = (row as Record<string, Value>)[name];
        rows.push(payload);
      }
    } else {
      rows.push(base);
    }

    // `ordered_by` : une création s'ajoute à la fin, quelle que soit la position écrite.
    const order = this.shell.resources[type].ordered_by;
    if (order !== undefined) {
      const count = (await this.t.runtime.resources.list({ challengeId: state.challenge.uuid, type })).length;
      rows.forEach((row, index) => (row[order] = count + index));
    }

    // Tout ou rien : une ligne qui ne tient pas son type ou son `check` refuse le lot entier.
    const errors: string[] = [];
    for (const [index, row] of rows.entries()) {
      const where = body.many ? `Row ${index + 1}: ` : "";
      for (const name of Object.keys(this.shell.resources[type].fields)) {
        const error = await this.fieldErrors(type, name, row[name], state);
        if (error) errors.push(`${where}${error}`);
        // Un champ optionnel absent se garde à `null` : la forme qu'un flow écrit à la main stocke.
        else if (row[name] === undefined) row[name] = null;
      }
    }
    if (errors.length > 0) throw new Refusal(400, errors.slice(0, 50).join("; "));

    // `unique: true` : une valeur ne sert qu'une instance (un target par soumission).
    const uniqueFields = Object.entries(this.shell.resources[type].fields).filter(([, field]) => field.unique).map(([name]) => name);
    if (uniqueFields.length > 0) {
      const existing = await this.t.runtime.resources.list({ challengeId: state.challenge.uuid, type });
      for (const name of uniqueFields) {
        const idOf = (value: unknown) => (value && typeof value === "object" && "id" in value ? String((value as { id: unknown }).id) : JSON.stringify(value));
        const taken = new Set(existing.map((instance) => idOf(instance.payload[name])));
        for (const row of rows) {
          if (taken.has(idOf(row[name]))) throw new Refusal(409, `This ${name} is already a ${type}`);
          taken.add(idOf(row[name]));
        }
      }
    }

    // `cardinality: {exactly: N}` : au plus N instances ; au-delà, un refus (le quota de cas d'une validation).
    const cardinality = this.shell.resources[type].cardinality;
    if (cardinality) {
      const limit = await this.number(cardinality.exactly, state);
      const existing = (await this.t.runtime.resources.list({ challengeId: state.challenge.uuid, type })).length;
      if (existing + rows.length > limit) throw new Refusal(409, `At most ${limit} ${type} for this challenge`);
    }

    // `class` vit dans sa colonne, que le tirage filtre ; jamais dans la charge.
    const items = rows.map(({ class: klass, ...payload }) => ({ payload, class: typeof klass === "string" ? klass : null }));
    if (body.upsert) {
      // Une par combinaison, sous verrou : un double clic retrouve l'instance au lieu d'en créer une seconde.
      const { id } = await this.t.runtime.resources.upsert(state.challenge.uuid, type, items[0], {
        createdBy: state.userId,
        by: body.upsert.by,
        overwrite: body.upsert.overwrite === true,
      });
      state.created[actId] = id;
      return;
    }
    await this.t.runtime.resources.createMany(state.challenge.uuid, type, items, { createdBy: state.userId });
  }

  /** Les lignes d'un lot : déjà des lignes, ou un fichier (un blob JSON, sinon CSV) lu côté serveur. */
  private async rowsOf(file: Value): Promise<Value> {
    const ref = file && typeof file === "object" && !Array.isArray(file) && typeof file.blob_id === "string" ? file.blob_id : null;
    if (!ref) return file;
    const blob = await this.t.runtime.blobs.get(ref);
    if (!blob?.bytes) throw new Refusal(410, "The batch file is no longer available");
    const text = blob.bytes.toString("utf8");
    try {
      return JSON.parse(text) as Value;
    } catch {
      return parseCsv(text) as Value;
    }
  }

  /** Le `check` d'un champ : la valeur et les paramètres, rien d'autre ; une erreur d'évaluation échoue le check. */
  private async checks(source: ExprSource, value: Value, state: RunState): Promise<Value> {
    if (typeof source !== "string") return source;
    try {
      return evaluate(astOf(source), { params: state.bindings.params, value }, { now: this.t.runtime.now() });
    } catch {
      return false;
    }
  }

  /** `aggregateVerdict` : `undefined` hors d'un aggregate ; `null` quand l'aggregate n'a pas tranché. */
  private async transition(body: TransitionBody, state: RunState, aggregateVerdict: Value | undefined): Promise<boolean> {
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
    const declared: Record<string, Value> = {};
    for (const [key, source] of Object.entries(body.resolution ?? {})) declared[key] = await this.eval(source, state);

    if (body.from !== undefined) {
      const reclosed = await this.t.runtime.resources.reclose(id, body.from, verdict, declared);
      return reclosed !== null;
    }
    // Le consensus d'un aggregate vit dans `resolution.consensus`, vide sans verdict.
    const aggregate = aggregateVerdict === undefined ? undefined : aggregateVerdict === null ? {} : { consensus: aggregateVerdict };
    const resolution = body.resolution ? { ...(aggregate ?? {}), ...declared } : aggregate;
    const closed = await this.t.runtime.resources.close(id, verdict, resolution);
    return closed !== null;
  }

  private async assess(node: Extract<NodeModel, { family: "assess" }>, state: RunState): Promise<void> {
    const { body } = node;
    let output: Value = {};
    switch (body.kind) {
      case "ai_grid": {
        const grid = await this.eval(body.grid!, state);
        const inputs = await Promise.all((body.input ?? []).map((input) => this.eval(input, state)));
        if (body.background) throw new Deferred(node, String(grid), inputs);
        let score: number;
        try {
          const result = scoreOf(
            await this.t.runtime.evaluate({
              challenge: state.challenge,
              userId: state.userId!,
              grid: String(grid),
              inputs,
              ...(body.snapshot ? { snapshot: body.snapshot } : {}),
              // Une soumission : le run se rattache à la contribution de l'étape, et se rejoue depuis la soumission.
              ...(state.submission ? { contributionId: state.submission.contributionId, origin: state.submission.origin } : {}),
            })
          );
          score = result.score;
          if (result.evaluation) state.evaluation = result.evaluation as EvaluationDetail;
        } catch (error) {
          // Dans une soumission, une évaluation qui échoue est une panne : le run passe `failed`, rejouable.
          if (state.submission) throw error;
          if (error instanceof ObserverRefusal) throw new Refusal(error.status, error.message);
          throw error;
        }
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
      if (state.claim && state.claim.resourceId !== resourceId) await this.emitElsewhere(aggregateId, resourceId, state);
      await this.deliver(state);
      await this.resolve(aggregateId, resourceId, state.challenge, state.bindings.params as Record<string, Value>);
    }
  }

  /**
   * Une entrée vers une autre ressource que celle réclamée (le verdict d'un case
   * vise son target) : `per_participation` est vérifié ici, et la cible est
   * gardée sur le claim (`$emits`) pour que les entrées de l'aggregate la retrouvent.
   */
  private async emitElsewhere(aggregateId: string, resourceId: string, state: RunState): Promise<void> {
    const hold = state.claim!;
    const { decl } = this.aggregate(aggregateId);
    if (decl.per_participation !== undefined) {
      const inputs = await this.inputs(aggregateId, resourceId, state.bindings.params as Record<string, Value>);
      const mine = inputs.filter((input) => input && typeof input === "object" && !Array.isArray(input) && input.author === state.userId);
      if (mine.length >= decl.per_participation) throw new Refusal(409, "Already recorded for this resource");
    }
    const current = await this.t.runtime.resources.claim(hold.claimId);
    const emits = { ...((current?.context?.$emits as Record<string, string> | undefined) ?? {}), [aggregateId]: resourceId };
    if (!(await this.t.runtime.resources.updateContext(hold.claimId, state.userId!, { $emits: emits }))) {
      throw new Refusal(410, "This claim expired or was released; claim again");
    }
  }

  /** Livre le travail du claim tenu : une seule fois, avec tout ce que la lane a produit jusque-là. */
  async deliver(state: RunState): Promise<void> {
    const hold = state.claim;
    if (!hold || hold.consumed || !state.userId) return;
    try {
      await this.t.runtime.resources.consume(hold.claimId, state.userId, state.result);
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
  async inputs(aggregateId: string, resourceId: string, params: Record<string, Value>): Promise<Value[]> {
    const own = await this.t.runtime.resources.consumedClaims(resourceId);
    const elsewhere: ConsumedClaim[] = [];
    if (this.t.crossEmits.has(aggregateId)) {
      const instance = await this.t.runtime.resources.resource(resourceId);
      if (instance) {
        for (const claim of await this.t.runtime.resources.consumedBy({ challengeId: instance.challenge_id })) {
          const emits = claim.context?.$emits as Record<string, unknown> | undefined;
          if (claim.resource_id !== resourceId && emits?.[aggregateId] === resourceId) elsewhere.push(claim);
        }
      }
    }
    const claims = [...own, ...elsewhere].sort((a, b) => a.consumed_at.getTime() - b.consumed_at.getTime());
    const inputs: Value[] = [];
    for (const claim of claims) {
      const { inputs: emitted } = await this.replay(claim, params);
      const input = emitted[aggregateId];
      if (input) inputs.push({ ...input, participation: { user: claim.user_id }, claim: claim.claim_id, author: claim.user_id });
    }
    return inputs;
  }

  /** Vérifie la condition de résolution, et résout : dans le geste qui apporte l'entrée décisive. */
  async resolve(aggregateId: string, resourceId: string, challenge: Challenge, params: Record<string, Value>, lifecycle = false): Promise<void> {
    const { decl, then } = this.aggregate(aggregateId);
    const instance = await this.t.runtime.resources.resource(resourceId);
    if (!instance || instance.state !== "open") return;

    const state = newState(challenge, null, params);
    if (lifecycle) state.bindings.challenge = { state: "closed" };
    state.bindings.inputs = await this.inputs(aggregateId, resourceId, params);
    state.bindings[decl.over] = await resourceValue(instance, this.t.runtime, this.t.resourceTypes);
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

  /** Les destinataires d'une récompense : l'appelant, ou ce que `to` désigne, avec le claim de chacun s'il en porte un. */
  private async recipients(body: RewardBody, state: RunState): Promise<{ user: string; claim: string | null }[]> {
    if (body.to === undefined) return state.userId ? [{ user: state.userId, claim: state.claim?.claimId ?? null }] : [];
    const value = await this.eval(body.to, state);
    const claimOf = (item: Value) =>
      item && typeof item === "object" && !Array.isArray(item) && typeof item.claim === "string" ? item.claim : null;
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
    return (Array.isArray(value) ? value : [value])
      .map((item) => ({ user: userOf(item), claim: claimOf(item) }))
      .filter((recipient): recipient is { user: string; claim: string | null } => recipient.user !== null);
  }

  async pay(body: RewardBody, state: RunState, meta: Record<string, Value>): Promise<void> {
    const { runtime } = this.t;
    if (typeof body.amount === "object" && "reverse" in body.amount) return this.reverse(body, state);
    if (typeof body.amount === "object") throw new Error("[interpreter] mapped rewards are not compiled in v1");
    const amount = body.amount;
    const ruleKey = this.t.ruleKeys.get(body)!;
    const recipients = await this.recipients(body, state);
    if (recipients.length === 0) return;

    const challengeId = state.challenge.uuid;
    const existing = await runtime.ledger.entries(challengeId);
    let distributed = await runtime.ledger.distributed(challengeId);
    const drafts: RewardEntryDraft[] = [];

    const written: Record<string, Value> = {};
    for (const [key, source] of Object.entries(body.meta ?? {})) written[key] = await this.eval(source, state);

    for (const { user: userId } of recipients) {
      // Une clé versée en différentiel n'a pas de clé naturelle : ce qui la distingue est ce qui est déjà versé.
      // Une méta déclarée est la forme de la ligne (celle d'un flow repris) ; seule la clé naturelle d'un claim ou d'une ressource s'y ajoute.
      const natural = Object.fromEntries(Object.entries(meta).filter(([key]) => key === "claim_id" || key === "resource_id" || key === "aggregate"));
      const entryMeta: Record<string, Value> = body.basis === "delta" ? { ...written } : body.meta ? { ...natural, ...written } : { ...meta, ...written };
      // Rejouer le geste ne paie pas deux fois : même clé, même méta, même personne.
      // Sans clé naturelle (ni claim ni ressource), chaque geste paie.
      const keyed = Boolean(meta.claim_id || meta.resource_id);
      const duplicate = keyed && existing.some(
        (entry) => entry.rule_key === ruleKey && entry.user_id === userId && sameMeta(entry.meta as Record<string, unknown> | undefined, entryMeta)
      );
      if (duplicate) continue;

      const raw = Math.round(await this.number(amount, state));
      // Le bonus de groupe multiplie le versé, jamais l'assiette des transferts.
      const multiplier = body.multiplier === undefined ? null : await this.number(body.multiplier, state);
      let points = multiplier === null ? raw : Math.round(raw * multiplier);
      if (body.basis === "delta") {
        // Le challenge code : seul ce qui dépasse le déjà versé sur cette clé, jamais de reprise.
        const paid = existing
          .filter((entry) => entry.rule_key === ruleKey && entry.user_id === userId)
          .reduce((sum, entry) => sum + entry.points, 0);
        points = Math.max(0, raw - paid);
        entryMeta.rawPoints = raw;
      }
      const due = points;
      if (body.clamp === "pool" && points > 0) {
        points = Math.min(points, Math.max(0, state.challenge.contribution_points_reward - distributed));
      }
      if (body.basis === "delta" && points < due) entryMeta.clampedTo = points;
      if (body.record_clamp && points < due) Object.assign(entryMeta, { rawPoints: due, clampedTo: points });
      if (points === 0) continue;

      const contributionId = await this.contributionFor(state, userId);
      drafts.push({ challenge_id: challengeId, user_id: userId, contribution_id: contributionId, rule_key: ruleKey, points, meta: entryMeta });
      if (body.pool !== undefined) distributed += points;
      if (userId === state.userId) state.awarded += points;

      if (body.transfers && points > 0) {
        // L'assiette rognée dans la même proportion que le versé : un montant coupé de moitié ne reverse pas une part de points jamais versés.
        const base = Math.round(raw * (due === 0 ? 0 : points / due));
        const transfers = await this.transfers(body.transfers, state, { userId, contributionId, ruleKey, points, base });
        drafts.push(...transfers);
        if (userId === state.userId) state.awarded += transfers.filter((draft) => draft.user_id === userId).reduce((sum, draft) => sum + draft.points, 0);
      }
    }
    if (drafts.length > 0) await runtime.ledger.write(drafts);
  }

  /**
   * Les crédits de réutilisation d'un montant versé : pour chaque auteur amont,
   * `round(assiette × weight × share)` prélevé au destinataire et crédité à
   * l'auteur, hors pool (la paire s'annule). Le destinataire garde au moins
   * `floor` de ce qui lui a été versé : au-delà, les prélèvements sont réduits
   * au prorata (arrondis vers le bas). Le calcul de `computeReuseSplits`.
   */
  private async transfers(
    spec: NonNullable<RewardBody["transfers"]>,
    state: RunState,
    award: { userId: string; contributionId: string; ruleKey: string; points: number; base: number }
  ): Promise<RewardEntryDraft[]> {
    let deductions: { ruleKey: string; author: string; contribution: string | undefined; amount: number }[] = [];
    for (const target of spec.to) {
      const items = await this.eval(target.from, state);
      const share = await this.number(target.share, state);
      for (const item of Array.isArray(items) ? items : []) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const author = typeof item.author === "string" ? item.author : null;
        const weight = typeof item.weight === "number" ? item.weight : 1;
        const part = weight * share;
        // Réutiliser son propre artefact ne prélève rien.
        if (!author || author === award.userId || !(part > 0)) continue;
        deductions.push({
          ruleKey: this.t.transferKeys.get(target)!,
          author,
          contribution: typeof item.contribution === "string" ? item.contribution : undefined,
          amount: Math.round(award.base * part),
        });
      }
    }
    if (deductions.length === 0) return [];

    const floor = spec.floor === undefined ? 0 : await this.number(spec.floor, state);
    const maxDeductible = award.points - Math.round(award.points * floor);
    const total = deductions.reduce((sum, deduction) => sum + deduction.amount, 0);
    if (total > maxDeductible) {
      const ratio = total === 0 ? 0 : maxDeductible / total;
      deductions = deductions.map((deduction) => ({ ...deduction, amount: Math.floor(deduction.amount * ratio) }));
    }

    const challengeId = state.challenge.uuid;
    const drafts: RewardEntryDraft[] = [];
    for (const deduction of deductions) {
      if (deduction.amount <= 0) continue;
      const meta = { rawPoints: award.points, sourceRule: award.ruleKey };
      drafts.push({ challenge_id: challengeId, user_id: award.userId, contribution_id: award.contributionId, rule_key: deduction.ruleKey, points: -deduction.amount, source_user_id: deduction.author, meta });
      drafts.push({ challenge_id: challengeId, user_id: deduction.author, contribution_id: deduction.contribution, rule_key: deduction.ruleKey, points: deduction.amount, source_user_id: award.userId, meta: { ...meta } });
    }
    return drafts;
  }

  /**
   * L'exact négatif de ce que la récompense reprise a versé pour le claim de
   * chaque destinataire, net des reprises déjà écrites : rejouer ne reprend
   * rien de plus, un claim qui n'a rien rapporté n'est pas repris.
   */
  private async reverse(body: RewardBody, state: RunState): Promise<void> {
    const { runtime } = this.t;
    const ruleKey = this.t.ruleKeys.get(body)!;
    const reversed = this.t.reversedKeys.get(body)!;
    const recipients = await this.recipients(body, state);
    if (recipients.length === 0) return;

    const entries = await runtime.ledger.entries(state.challenge.uuid);
    const drafts: RewardEntryDraft[] = [];
    for (const { user, claim } of recipients) {
      if (!claim) continue;
      const own = entries.filter(
        (entry) => (entry.rule_key === reversed || entry.rule_key === ruleKey) && entry.user_id === user && entry.meta?.claim_id === claim
      );
      const net = own.reduce((sum, entry) => sum + entry.points, 0);
      if (net <= 0) continue;
      const contributionId = own.find((entry) => entry.contribution_id)?.contribution_id
        ?? (await this.contributionFor(state, user));
      drafts.push({
        challenge_id: state.challenge.uuid,
        user_id: user,
        contribution_id: contributionId,
        rule_key: ruleKey,
        points: -net,
        meta: { claim_id: claim },
      });
    }
    if (drafts.length > 0) await runtime.ledger.write(drafts);
  }
}

function sameMeta(stored: Record<string, unknown> | undefined, meta: Record<string, Value>): boolean {
  if (!stored) return false;
  return Object.entries(meta).every(([key, value]) => (stored[key] ?? null) === value);
}
