import type { Challenge } from "../../database-service/domain/entities.js";
import { flowConfigOf } from "../../capabilities/flow-config.js";
import { jsonError } from "./responses.js";
import type {
  ActionAccess,
  ActionContext,
  ChallengeActionDeclaration,
  FlowDefinition,
  JobDeclaration,
  RuleKeyDeclaration,
} from "../../registry/platform.js";
import { readsRoot } from "../expr/ast.js";
import { EvalError, type Value } from "../expr/evaluator.js";
import { parseExpr } from "../expr/parser.js";
import type { Type } from "../expr/types.js";
import type { ExprSource, FieldDecl, RewardBody } from "../format/schema.js";
import type { TemplateReport } from "../check.js";
import { descriptorOf } from "../describe.js";
import type { LaneModel, NodeModel, TemplateModel } from "../validate/format.js";
import { Deferred, Engine, Refusal, newState, scoreOf, type CompiledTemplate, type ReplaySpec, type RunState } from "./engine.js";
import { artifactOf } from "./bindings.js";
import type { EvaluationDetail } from "./runtime.js";
import { compileParams, poolParamOf, zodOf, type CompiledParams } from "./params.js";
import { defaultRuntime, type TemplateRuntime } from "./runtime.js";
import { generatedActions, generatedPathConflicts, resourceCounts } from "./reads.js";
import { gestureFields, isGesture, segmentsOf, type Segment } from "./segments.js";
import { project, resourceValue } from "./values.js";

/**
 * Le compilateur — J2
 * -------------------
 * Un template valide devient un `FlowDefinition`, l'objet exact qu'un flow
 * écrit à la main exporte (compromis 1 : compiler, jamais un second chemin
 * d'exécution). Ce qu'il produit :
 *
 * - une action par segment de lane : `POST flow/<lane>` pour un segment qui
 *   commence par un pas serveur (un tirage), `POST flow/<lane>/<nœud>` pour un
 *   geste (les champs des collects du segment, à plat). Un segment après un
 *   claim reçoit `claim_id` ;
 * - un job par lane cron, un hook `onClose` pour les aggregates résolus à la
 *   clôture ;
 * - le schéma de `flow_config`, `rules.parse`, les clés de ledger et un type
 *   de contribution.
 *
 * Un template qui utilise ce que la v1 ne compile pas (`report.gaps`) est
 * refusé à l'installation, comme tout conflit.
 */

export class CompileError extends Error {}

export interface CompileOptions {
  runtime?: TemplateRuntime;
  /**
   * Un template en base, publié sous cette version. Ses clés de ledger et son
   * type de contribution déclarés sont préfixés par sa clé (`<clé>.<rule_key>`) :
   * la clé ne contient jamais de point, le premier sépare donc toujours le
   * préfixe, et deux versions produisent les mêmes clés. Ses jobs ne
   * parcourent que les challenges de cette version. Absent : un template
   * système, dont les clés nues sont celles de la distribution.
   */
  published?: { version: string };
  /** Présentation : le template n'en dit rien. */
  icon?: string;
  publiclyVisible?: boolean;
}

const SCHEDULES: Record<string, string> = { hourly: "0 * * * *", daily: "0 3 * * *", weekly: "0 4 * * 1" };

/** Toutes les chaînes d'un nœud qui se lisent comme une expression. */
function expressionsOf(value: unknown): ReturnType<typeof parseExpr>[] {
  if (typeof value === "string") {
    try {
      return [parseExpr(value)];
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.flatMap(expressionsOf);
  // Un `id` nomme un nœud, il ne se lit pas.
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => (key === "id" ? [] : expressionsOf(item)));
  return [];
}

export function compileTemplate(report: TemplateReport, options: CompileOptions = {}): FlowDefinition {
  if (!report.valid || !report.model || !report.types) {
    throw new CompileError(`[interpreter] ${report.name} is not valid: ${report.errors.map((e) => e.message).join("; ")}`);
  }
  if (report.gaps.length > 0) {
    throw new CompileError(`[interpreter] ${report.name} uses what v1 does not compile: ${report.gaps.map((gap) => gap.feature).join(", ")}`);
  }
  const model = report.model;
  const types = report.types;
  const { shell } = model;
  const flowKey = shell.template.id;
  const runtime = options.runtime ?? defaultRuntime();
  // Une clé déclarée d'un template en base porte son préfixe ; les clés par défaut l'ont déjà.
  const declared = (key: string) => (options.published ? `${flowKey}.${key}` : key);

  // ── Récompenses : clés de ledger, pool ──────────────────────────────────
  const rewards: { body: RewardBody; key: string; ref?: string }[] = [];
  const collectRewards = (nodes: readonly NodeModel[], owner: string) => {
    for (const node of nodes) {
      if (node.family === "reward") rewards.push({ body: node.body, key: node.body.rule_key ? declared(node.body.rule_key) : `${flowKey}.${owner}.${node.id}`, ref: `${owner}.${node.id}` });
      if (node.family === "gate") for (const branch of node.branches ?? []) collectRewards(branch.nodes, owner);
    }
  };
  for (const lane of model.lanes) collectRewards(lane.nodes, lane.id);
  for (const aggregate of model.aggregates) {
    aggregate.then.forEach((effect, i) => {
      if (effect.family === "reward") rewards.push({ body: effect.body, key: effect.body.rule_key ? declared(effect.body.rule_key) : `${flowKey}.${aggregate.decl.id}.${i}` });
    });
  }
  model.onClose.forEach((effect, i) => {
    if (effect.family === "reward") rewards.push({ body: effect.body, key: effect.body.rule_key ? declared(effect.body.rule_key) : `${flowKey}.close.${effect.body.id ?? i}` });
  });

  const poolParam = poolParamOf(model);
  if (poolParam === undefined) throw new CompileError(`[interpreter] ${flowKey}: v1 compiles a single pool`);

  const ruleKeys: RuleKeyDeclaration[] = [];
  for (const { body, key } of rewards) {
    const declared = ruleKeys.find((ruleKey) => ruleKey.key === key);
    const consumesPool = body.pool !== undefined;
    if (declared && declared.consumesPool !== consumesPool) {
      throw new CompileError(`[interpreter] ${flowKey}: rule key ${key} is written both from and outside the pool`);
    }
    if (!declared) ruleKeys.push({ key, consumesPool, label: key });
  }

  const params = compileParams(shell, types.params, poolParam);
  const compiled: CompiledTemplate = {
    model,
    flowKey,
    runtime,
    resourceTypes: types.resources,
    ruleKeys: new Map(rewards.map((reward) => [reward.body, reward.key])),
    reversedKeys: new Map(
      rewards.flatMap(({ body }) => {
        if (typeof body.amount !== "object" || !("reverse" in body.amount)) return [];
        const target = body.amount.reverse;
        const reversed = rewards.find((reward) => reward.body.rule_key === target || reward.ref === target)!;
        return [[body, reversed.key] as const];
      })
    ),
    counterWrites: model.lanes.flatMap((lane) => counterWritesOf(lane.nodes)),
    replays: replaysOf(flowKey, model.lanes, types.nodeFields),
    crossEmits: crossEmitsOf(model, types.nodeFields),
    contribution: shell.presentation?.contribution
      ? { ...shell.presentation.contribution, type: declared(shell.presentation.contribution.type) }
      : { type: flowKey, title: shell.template.name },
    version: options.published?.version ?? null,
  };
  const engine = new Engine(compiled);

  // ── Actions ─────────────────────────────────────────────────────────────
  const actions: ChallengeActionDeclaration[] = [];
  const jobs: JobDeclaration[] = [];

  for (const lane of model.lanes) {
    if (lane.entry.trigger === "cron") {
      jobs.push(cronJob(lane, compiled, engine, params));
      continue;
    }
    const segments = segmentsOf(lane);
    const persisted = checkSegments(flowKey, lane, segments);
    const claimAct = lane.nodes.find((node) => node.family === "act" && node.body.claim) as Extract<NodeModel, { family: "act" }> | undefined;

    segments.forEach((segment, index) => {
      const afterClaim = Boolean(claimAct && segments.slice(0, index).some((earlier) => earlier.nodes.includes(claimAct)));
      actions.push({
        path: segment.path,
        method: "POST",
        access: accessOf(lane, params),
        handle: (ctx) =>
          runSegment(
            {
              ctx,
              lane,
              segment,
              claimAct: afterClaim ? claimAct! : null,
              persist: persisted[index],
              earlier: segments.slice(0, index).flatMap((previous, i) => persisted[i].filter((id) => previous.gestures.some((gesture) => gesture.id === id))),
            },
            compiled,
            engine,
            params,
            types.nodeFields
          ),
      });
    });
  }

  // ── Surfaces générées : release, progress, overview, export ─────────────
  const conflicts = generatedPathConflicts(model.lanes, actions.map((action) => action.path));
  if (conflicts.length > 0) {
    throw new CompileError(`[interpreter] ${flowKey}: ${conflicts.join(", ")} would shadow a generated read or release`);
  }
  actions.push(...generatedActions(compiled, engine, params, types, (lane) => accessOf(lane, params)));

  // ── Aggregates résolus à la clôture ─────────────────────────────────────
  const lifecycleAggregates = model.aggregates.filter(
    (aggregate) => typeof aggregate.decl.resolve.when === "string" && !readsRoot(parseExpr(aggregate.decl.resolve.when), "inputs")
  );

  return {
    descriptor: {
      ...descriptorOf(shell),
      ...(options.icon ? { icon: options.icon } : {}),
      ...(options.publiclyVisible !== undefined ? { publiclyVisible: options.publiclyVisible } : {}),
    },
    config: { version: 1, schema: params.configSchema },
    rules: { parse: (raw) => (params.rulesSchema.safeParse(raw ?? {}).success ? params.rulesSchema.parse(raw ?? {}) : null) },
    ruleKeys,
    contributionTypes: [{ key: compiled.contribution.type, countsAsContribution: true }],
    uses: { board: false, groups: false },
    ...(deliverableOf(shell) ? { requires: { deliverableCapability: deliverableOf(shell)! } } : {}),
    rewards: {
      // L'avancement du challenge, comme `overview.resources` : le hero le lit.
      async summarize({ challenge }) {
        return { resources: resourceCounts(shell, await runtime.resources.list({ challengeId: challenge.uuid })) };
      },
    },
    actions,
    jobs,
    ...(hasBackground(model)
      ? {
          evaluationHandlers: [
            {
              key: CONTINUE_HANDLER,
              // La relance d'un run échoué : reprendre l'évaluation (toujours une à la fois) et rejouer la suite.
              async retry(payload: Record<string, unknown>) {
                const continuation = payload as Continuation;
                if (typeof continuation.contributionId !== "string" || typeof continuation.challengeId !== "string") {
                  return { ok: false as const, reason: "invalid_payload" };
                }
                const artifact = (continuation.inputs ?? []).map((input) => artifactOf(input)).find(Boolean) ?? null;
                if (!(await runtime.evaluations.claim(continuation.contributionId, artifact?.url ?? null))) {
                  return { ok: false as const, reason: "already_running" };
                }
                runtime.evaluations.schedule(() => continueEvaluation(continuation, compiled, engine, params));
                return { ok: true as const };
              },
            },
          ],
        }
      : {}),
    hooks:
      lifecycleAggregates.length > 0
        ? {
            async onClose(challenge) {
              const values = params.valuesOf(challenge, flowConfigOf(challenge));
              if (!values) return;
              for (const aggregate of lifecycleAggregates) {
                const open = await runtime.resources.list({ challengeId: challenge.uuid, type: aggregate.decl.over, state: "open" });
                for (const instance of open) await engine.resolve(aggregate.decl.id, instance.uuid, challenge, values, true);
              }
            },
          }
        : undefined,
  };
}

function hasBackground(model: TemplateModel): boolean {
  return model.lanes.some((lane) => lane.nodes.some((node) => node.family === "assess" && Boolean(node.body.background)));
}

function counterWritesOf(nodes: readonly NodeModel[]): { node: string; counter: string; add: ExprSource }[] {
  return nodes.flatMap((node) => {
    if (node.family === "gate") return (node.branches ?? []).flatMap((branch) => counterWritesOf(branch.nodes));
    if (node.family !== "assess" || !node.body.counters) return [];
    return Object.entries(node.body.counters).map(([counter, update]) => ({ node: node.id, counter, add: update.add }));
  });
}

/**
 * Ce qui traverse un geste. Un segment ne relit d'un segment passé que ce qui
 * est gardé sur le claim : les champs collectés après le tirage, et les sorties
 * que l'analyse de portée voit lues plus loin. La persistance dérive donc de la
 * lecture, jamais d'une déclaration. Sans claim pour la porter, une lecture à
 * travers un geste est refusée. Rend, par segment, les nœuds à garder.
 */
function checkSegments(flowKey: string, lane: LaneModel, segments: Segment[]): string[][] {
  const claimSegment = segments.findIndex((segment) => segment.nodes.some((node) => node.family === "act" && node.body.claim));
  const persisted: string[][] = segments.map(() => []);
  const all = (nodes: readonly NodeModel[]): NodeModel[] =>
    nodes.flatMap((node) => [node, ...(node.family === "gate" ? (node.branches ?? []).flatMap((b) => all(b.nodes)) : [])]);
  segments.forEach((segment, index) => {
    const names = new Set<string>();
    for (const gesture of segment.gestures) {
      for (const field of Object.keys(gestureFields(gesture))) {
        if (names.has(field) || field === "claim_id") {
          throw new CompileError(`[interpreter] ${flowKey}: field '${field}' is collected twice in one gesture of lane ${lane.id}`);
        }
        names.add(field);
      }
    }
    const later = segments.slice(index + 1).flatMap((next) => all(next.nodes));
    for (const node of all(segment.nodes)) {
      const observed = node.family === "act" && node.body.kind === "observer";
      if (node.family === "act" && node.body.claim && !observed) continue;
      const readLater = later.some((reader) => expressionsOf(reader.body).some((ast) => readsRoot(ast, node.id)));
      const heldHere = claimSegment >= 0 && index >= claimSegment && !segment.final;
      if (readLater && !heldHere) {
        throw new CompileError(`[interpreter] ${flowKey}: lane ${lane.id} reads '${node.id}' across a gesture, with no claim to keep it`);
      }
      // Ce qui a été collecté ou observé une fois le claim tenu reste sur le claim, lu ou non : c'est la trace du travail.
      if (heldHere && (readLater || isGesture(node) || observed)) persisted[index].push(node.id);
    }
    for (const node of all(segment.nodes)) {
      if (node.family === "act" && node.body.create && later.some((reader) => reader !== node && expressionsOf(reader.body).some((ast) => readsRoot(ast, node.id)))) {
        throw new CompileError(`[interpreter] ${flowKey}: the output of create '${node.id}' is not readable in v1`);
      }
    }
  });
  return persisted;
}

function accessOf(lane: LaneModel, params: CompiledParams): ActionAccess {
  if (lane.entry.trigger === "admin") return { roles: ["admin"], manager: true };
  const access = lane.entry.access!;
  if (access.mode === "role") {
    const param = /^\s*params\.([a-z][a-z0-9_]*)\s*$/.exec(String(access.role))?.[1];
    // La qualification seule : un admin ou un manager ne relit ni ne vote à la place d'un qualifié.
    return {
      qualification: (challenge: Challenge) => {
        const value = param ? params.valuesOf(challenge, flowConfigOf(challenge))?.[param] : null;
        return typeof value === "string" ? value : null;
      },
    };
  }
  return { member: true };
}

interface SegmentCall {
  ctx: ActionContext;
  lane: LaneModel;
  segment: Segment;
  /** L'Act de claim d'un segment précédent, dont `claim_id` reprend la réclamation. */
  claimAct: Extract<NodeModel, { family: "act" }> | null;
  /** Ce que ce segment garde sur le claim pour les segments suivants. */
  persist: readonly string[];
  /** Les gestes des segments précédents, gardés sur le claim : leur absence dit qu'une étape manque. */
  earlier: readonly string[];
}

async function runSegment(
  call: SegmentCall,
  t: CompiledTemplate,
  engine: Engine,
  params: CompiledParams,
  nodeFields: ReadonlyMap<NodeModel, Record<string, Type>>
): Promise<unknown> {
  const { ctx, segment, claimAct } = call;
  const values = params.valuesOf(ctx.challenge, flowConfigOf(ctx.challenge));
  if (!values) return jsonError(409, "This challenge has no readable configuration or rules");

  const body = await readBody(ctx.request);
  if (!body) return jsonError(400, "The body is a JSON object or a multipart form");
  const state = newState(ctx.challenge, ctx.user.id, values);
  let kept: Record<string, Value> = {};

  try {
    if (claimAct) {
      const claimId = typeof body.claim_id === "string" ? body.claim_id : null;
      const claim = claimId ? await t.runtime.resources.claim(claimId) : null;
      if (!claim || claim.user_id !== ctx.user.id || claim.challenge_id !== ctx.challenge.uuid) return jsonError(404, "Claim not found");
      // L'ordre de la lane, tenu par le claim : chaque geste une fois, et jamais avant le précédent.
      const kept = claim.context ?? {};
      if (call.earlier.some((id) => !(id in kept))) return jsonError(400, "An earlier step of this lane is missing");
      if (segment.gestures.some((gesture) => gesture.id in kept)) return jsonError(409, "This step is already recorded");
      if (engine.isDraw(claimAct.body.claim!)) {
        await engine.hold(claimAct.id, claimAct.body.claim!, claim.uuid, claim.resource_id, state);
        await engine.restore(claim.context, state);
      } else {
        await engine.holdDesignated(claimAct.id, claim.uuid, claim.resource_id, claim.context, state);
      }
    }

    for (const gesture of segment.gestures) {
      const fields = gestureFields(gesture);
      const bound = await readGesture(fields, nodeFields.get(gesture) ?? {}, body, state, engine, t);
      state.bindings[gesture.id] = bound;
      Object.assign(state.result, bound);
    }

    await engine.run(segment.nodes, state);
    if (segment.final) await engine.deliver(state);
    else kept = await engine.persist(call.persist, state);
  } catch (error) {
    if (error instanceof Deferred) return deferEvaluation(error, call.lane, state, t, engine, params);
    if (error instanceof Refusal) return jsonError(error.status, error.message);
    if (error instanceof GestureError) return jsonError(400, error.message);
    if (error instanceof EvalError) throw new Error(`[interpreter] ${t.flowKey}: ${error.message}`);
    throw error;
  }

  if (state.drawn && !state.claim?.consumed) {
    const instance = await t.runtime.resources.resource(state.drawn.resourceId);
    const decl = instance ? t.model.shell.resources[instance.resource_type] : null;
    const value = instance ? await resourceValue(instance, t.runtime, t.resourceTypes) : null;
    const granted = instance ? (await t.runtime.resources.grantsFor([instance.uuid], ctx.user.id))[instance.uuid] : undefined;
    return {
      claim: {
        claim_id: state.drawn.claimId,
        expires_at: state.drawn.expiresAt,
        // L'opacité des substitutions : jamais le type, seulement ce que le claimant peut lire.
        resource: value && decl ? await project(value, decl, { ...viewerOf(ctx, values, true), granted }) : null,
        ...(Object.keys(kept).length > 0 ? { context: kept } : {}),
      },
    };
  }
  return { ok: true, cp_awarded: state.awarded, ...(Object.keys(kept).length > 0 ? { context: kept } : {}) };
}

/**
 * Ce qu'une évaluation en arrière-plan garde pour reprendre : où la lane
 * s'est arrêtée, ce que les nœuds passés ont lié, ce qu'il faut noter. C'est
 * aussi la charge du run d'évaluation, que la relance d'un run échoué rejoue.
 */
export interface Continuation {
  [key: string]: unknown;
  version: string | null;
  challengeId: string;
  userId: string;
  lane: string;
  node: string;
  grid: string;
  inputs: Value[];
  bindings: Record<string, Value>;
  contributionId: string;
}

export const CONTINUE_HANDLER = "continue";

/** Ce qui ne se recalcule pas à la reprise : les liaisons des nœuds passés, sans les paramètres ni l'état du challenge. */
function carried(bindings: Record<string, Value>): Record<string, Value> {
  const { params: _params, challenge: _challenge, participation: _participation, counters: _counters, ...rest } = bindings;
  return JSON.parse(JSON.stringify(rest)) as Record<string, Value>;
}

/** Le geste a passé tous ses contrôles : l'évaluation se prend (une à la fois), se planifie, et le geste répond 202. */
async function deferEvaluation(deferred: Deferred, lane: LaneModel, state: RunState, t: CompiledTemplate, engine: Engine, params: CompiledParams): Promise<Response> {
  const userId = state.userId!;
  const contributionId = await t.runtime.ledger.contribution(state.challenge, userId, t.contribution);
  const artifact = deferred.inputs.map((input) => artifactOf(input)).find(Boolean) ?? null;
  if (!(await t.runtime.evaluations.claim(contributionId, artifact?.url ?? null))) {
    return jsonError(409, "An evaluation is already running");
  }
  const continuation: Continuation = {
    version: t.version,
    challengeId: state.challenge.uuid,
    userId,
    lane: lane.id,
    node: deferred.node.id,
    grid: deferred.grid,
    inputs: deferred.inputs,
    bindings: carried(state.bindings),
    contributionId,
  };
  t.runtime.evaluations.schedule(() => continueEvaluation(continuation, t, engine, params));
  return Response.json({ scheduled: true }, { status: 202 });
}

/**
 * La suite d'une évaluation en arrière-plan : noter, stocker le détail sur la
 * contribution, puis reprendre la lane au nœud suivant avec les règles du
 * moment — comme le challenge code recalcule son plan au lancement du run. Un
 * refus plus loin (un plancher) termine le run sans paiement ; une erreur le
 * marque en échec et le laisse rejouable.
 */
export async function continueEvaluation(continuation: Continuation, t: CompiledTemplate, engine: Engine, params: CompiledParams): Promise<void> {
  const { runtime } = t;
  const challenge = (await runtime.challengesOf(t.flowKey)).find((candidate) => candidate.uuid === continuation.challengeId);
  const lane = t.model.lanes.find((candidate) => candidate.id === continuation.lane);
  const index = lane ? lane.nodes.findIndex((node) => node.id === continuation.node) : -1;
  const node = lane && index >= 0 ? lane.nodes[index] : null;
  let evaluation: EvaluationDetail | undefined;
  try {
    if (!challenge || !lane || !node || node.family !== "assess") {
      throw new Error(`[interpreter] ${t.flowKey}: nothing to continue at ${continuation.lane}.${continuation.node}`);
    }
    const values = params.valuesOf(challenge, flowConfigOf(challenge));
    if (!values) throw new Error(`[interpreter] ${t.flowKey}: challenge ${challenge.uuid} has no readable configuration`);

    const result = scoreOf(
      await runtime.evaluate({
        challenge,
        userId: continuation.userId,
        grid: continuation.grid,
        inputs: continuation.inputs,
        ...(node.body.snapshot ? { snapshot: node.body.snapshot } : {}),
        contributionId: continuation.contributionId,
        origin: { handler: CONTINUE_HANDLER, payload: continuation },
      })
    );
    evaluation = (result.evaluation as EvaluationDetail | null) ?? undefined;

    const state = newState(challenge, continuation.userId, values);
    Object.assign(state.bindings, continuation.bindings, { [node.id]: { score: result.score } });
    try {
      await engine.run(lane.nodes.slice(index + 1), state);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
    }
    await runtime.evaluations.finish(continuation.contributionId, { status: "done", ...(evaluation ? { evaluation } : {}) });
  } catch (error) {
    await runtime.evaluations.finish(continuation.contributionId, { status: "failed", ...(evaluation ? { evaluation } : {}) });
    throw error;
  }
}

function viewerOf(ctx: ActionContext, values: Record<string, Value>, claimant: boolean) {
  return {
    userId: ctx.user.id,
    isAdmin: ctx.access.isAdmin(),
    claimant,
    holdsRole: async (param: string) => {
      const qualification = values[param];
      return typeof qualification === "string" && (await ctx.access.holds(qualification));
    },
  };
}

class GestureError extends Error {}

/** Les champs d'un geste : validés par leur type, `when`, `check` et, pour un `ref`, l'instance et son `where`. */
async function readGesture(
  fields: Record<string, FieldDecl>,
  types: Record<string, Type>,
  body: Record<string, unknown>,
  state: RunState,
  engine: Engine,
  t: CompiledTemplate
): Promise<Record<string, Value>> {
  const bound: Record<string, Value> = {};
  for (const [name, decl] of Object.entries(fields)) {
    const type = types[name];
    const raw = body[name];
    if (decl.when !== undefined && (await engine.eval(decl.when, state, bound)) !== true) {
      bound[name] = null;
      continue;
    }
    if (raw === undefined || raw === null) throw new GestureError(`${name} is required`);
    if (type.kind === "file") {
      // Un fichier entre par un formulaire multipart (ou en base64 dans un JSON) et ressort en référence de blob.
      bound[name] = await storeGestureFile(name, raw, decl, state, t);
      continue;
    }
    const parsed = zodOf(type).safeParse(raw);
    if (!parsed.success) throw new GestureError(`${name}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    let value = parsed.data as Value;

    if (type.kind === "contribution") {
      // Un `link` : une contribution du challenge source qui porte le livrable exigé.
      const capability = decl.deliverable ?? deliverableOf(t.model.shell);
      const eligible = capability ? await t.runtime.contributions.eligible(state.challenge, capability) : [];
      const found = eligible.find((contribution) => contribution.id === String(value));
      if (!found) throw new GestureError(`${name}: not an eligible submission of the source challenge`);
      value = found;
    }
    if (type.kind === "resource") {
      const instance = await t.runtime.resources.resource(String(value));
      if (!instance || instance.challenge_id !== state.challenge.uuid || instance.resource_type !== type.name) {
        throw new GestureError(`${name}: no such ${type.name}`);
      }
      value = await resourceValue(instance, t.runtime, t.resourceTypes);
      if (decl.where !== undefined && (await engine.eval(decl.where, state, { [name]: value })) !== true) {
        throw new GestureError(`${name}: this ${type.name} is not eligible`);
      }
    }
    if (decl.check !== undefined && (await engine.eval(decl.check, state, { value })) !== true) {
      throw new GestureError(`${name} fails its check`);
    }
    bound[name] = value;
  }
  return bound;
}

/** Le corps d'un geste : un JSON, ou un formulaire multipart dont les champs texte se lisent en JSON quand ils le sont. */
async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    if (!form) return null;
    const body: Record<string, unknown> = {};
    for (const [key, entry] of form.entries()) {
      if (typeof entry !== "string") {
        body[key] = entry;
        continue;
      }
      try {
        body[key] = JSON.parse(entry);
      } catch {
        body[key] = entry;
      }
    }
    return body;
  }
  const body = await request.json().catch(() => ({}));
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

async function storeGestureFile(name: string, raw: unknown, decl: FieldDecl, state: RunState, t: CompiledTemplate): Promise<Value> {
  let bytes: Buffer;
  let contentType: string;
  let filename: string | null;
  if (typeof raw === "object" && raw !== null && "arrayBuffer" in raw && typeof (raw as Blob).arrayBuffer === "function") {
    const file = raw as File;
    bytes = Buffer.from(await file.arrayBuffer());
    contentType = file.type || "application/octet-stream";
    filename = file.name || null;
  } else if (typeof raw === "object" && raw !== null && typeof (raw as { content_base64?: unknown }).content_base64 === "string") {
    const encoded = raw as { content_base64: string; content_type?: string; filename?: string };
    bytes = Buffer.from(encoded.content_base64, "base64");
    contentType = encoded.content_type ?? "application/octet-stream";
    filename = encoded.filename ?? null;
  } else {
    throw new GestureError(`${name} is a file`);
  }
  if (bytes.length === 0) throw new GestureError(`${name} is empty`);
  try {
    const ref = await t.runtime.blobs.store({
      challengeId: state.challenge.uuid,
      bytes,
      contentType,
      filename,
      retentionDays: decl.retention?.days_after_close ?? null,
    });
    return ref as unknown as Value;
  } catch (error) {
    const { BlobTooLargeError } = await import("../../capabilities/blobs.js");
    if (error instanceof BlobTooLargeError) throw new Refusal(413, `${name} is too large`);
    throw error;
  }
}

function cronJob(lane: LaneModel, t: CompiledTemplate, engine: Engine, params: CompiledParams): JobDeclaration {
  const over = lane.entry.over;
  const schedule = SCHEDULES[lane.entry.schedule ?? ""] ?? lane.entry.schedule ?? "0 3 * * *";
  // La marque d'une instance traitée porte le nom de la lane (`audit`), comme le flow écrit à la main.
  const cursorKey = lane.id;

  return {
    key: `${t.flowKey}.${lane.id}`,
    schedule,
    async run() {
      const summary = { challenges: 0, instances: 0, ran: 0 };
      for (const challenge of await t.runtime.challengesOf(t.flowKey)) {
        if (challenge.status !== "active") continue;
        // Chaque version exécute ses propres challenges : le registre réunit le même job de toutes les versions.
        if ((challenge.template_version ?? null) !== t.version) continue;
        const values = params.valuesOf(challenge, flowConfigOf(challenge));
        if (!values) continue;
        summary.challenges++;

        if (!over) {
          await engine.run(lane.nodes, newState(challenge, null, values));
          summary.ran++;
          continue;
        }
        const instances = await t.runtime.resources.list({
          challengeId: challenge.uuid,
          type: over.resource,
          ...(lane.entry.cursor === "engine" ? { withoutResolutionKey: cursorKey } : {}),
        });
        for (const instance of instances) {
          const state = newState(challenge, null, values);
          state.bindings[over.resource] = await resourceValue(instance, t.runtime, t.resourceTypes);
          state.bindings.aggregates = await aggregatesOf(over.resource, instance.uuid, instance.resolution, t, engine, values);
          if (over.where !== undefined && (await engine.eval(over.where, state)) !== true) continue;
          summary.instances++;

          const sampled = over.sample === undefined || t.runtime.random() < ((await engine.eval(over.sample, state)) as number);
          // La marque d'abord : deux passages concurrents ne traitent jamais deux fois la même instance.
          if (lane.entry.cursor === "engine") {
            const stamped = await t.runtime.resources.stampResolution(instance.uuid, cursorKey, { at: t.runtime.now().toISOString(), sampled });
            if (!stamped) continue;
          }
          if (!sampled) continue;
          await runCronNodes(lane.nodes, state, engine, instance.uuid, lane.id);
          summary.ran++;
        }
      }
      return summary;
    },
  };
}

/** Un job paie par instance : la clé naturelle de ses lignes est la ressource. */
async function runCronNodes(nodes: readonly NodeModel[], state: RunState, engine: Engine, resourceId: string, laneId: string) {
  for (const node of nodes) {
    if (node.family === "reward") {
      await engine.pay(node.body, state, { resource_id: resourceId, node: node.id, lane: laneId });
      continue;
    }
    await engine.run([node], state);
  }
}

/**
 * Ce qu'il faut rejouer des claims de chaque type tiré : le segment qui suit le
 * tirage. Un nœud rejoué ne lit que les paramètres, le claim, les gestes du
 * segment et ce que le rejeu a déjà produit — sinon le rejeu ne serait pas pur.
 */
/** Le livrable qu'exige un champ `link` du template, s'il y en a un : le `requires` du flow. */
export function deliverableOf(shell: TemplateModel["shell"]): string | null {
  for (const resource of Object.values(shell.resources)) {
    for (const field of Object.values(resource.fields)) if (field.deliverable) return field.deliverable;
  }
  return null;
}

/** Le type de ressource d'un claim : le nom d'un tirage, ou le type du champ `ref` qu'un claim désigné lit (`pick.case`). */
function claimedTypesOf(flowKey: string, claimAct: Extract<NodeModel, { family: "act" }>, lane: LaneModel, nodeFields: ReadonlyMap<NodeModel, Record<string, Type>>): string[] {
  const claim = claimAct.body.claim!;
  if (/^[a-z][a-z0-9_]*$/.test(claim.resource)) return [claim.resource, claim.substitute?.resource].filter((type): type is string => Boolean(type));
  const match = /^\s*([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\s*$/.exec(claim.resource);
  const all = (nodes: readonly NodeModel[]): NodeModel[] =>
    nodes.flatMap((node) => [node, ...(node.family === "gate" ? (node.branches ?? []).flatMap((b) => all(b.nodes)) : [])]);
  const gesture = match ? all(lane.nodes).find((node) => node.id === match[1]) : undefined;
  const type = gesture ? nodeFields.get(gesture)?.[match![2]] : undefined;
  if (!type || type.kind !== "resource") {
    throw new CompileError(`[interpreter] ${flowKey}: a designated claim reads a collected ref field (<collect>.<field>), got '${claim.resource}'`);
  }
  return [type.name];
}

/** Les aggregates qu'une lane alimente depuis un claim posé sur une autre ressource que celle de l'aggregate. */
function crossEmitsOf(model: TemplateModel, nodeFields: ReadonlyMap<NodeModel, Record<string, Type>>): Set<string> {
  const cross = new Set<string>();
  const all = (nodes: readonly NodeModel[]): NodeModel[] =>
    nodes.flatMap((node) => [node, ...(node.family === "gate" ? (node.branches ?? []).flatMap((b) => all(b.nodes)) : [])]);
  for (const lane of model.lanes) {
    const claimAct = all(lane.nodes).find((node) => node.family === "act" && node.body.claim) as Extract<NodeModel, { family: "act" }> | undefined;
    if (!claimAct) continue;
    const claimed = claimedTypesOf(model.shell.template.id, claimAct, lane, nodeFields);
    for (const node of all(lane.nodes)) {
      if (node.family !== "assess" || !node.body.emit) continue;
      const aggregateId = node.body.emit.to.replace(/^lifecycle\./, "");
      const over = model.aggregates.find((aggregate) => aggregate.decl.id === aggregateId)?.decl.over;
      if (over && !claimed.includes(over)) cross.add(aggregateId);
    }
  }
  return cross;
}

function replaysOf(flowKey: string, lanes: readonly LaneModel[], nodeFields: ReadonlyMap<NodeModel, Record<string, Type>>): Map<string, ReplaySpec> {
  const replays = new Map<string, ReplaySpec>();
  const all = (nodes: readonly NodeModel[]): NodeModel[] =>
    nodes.flatMap((node) => [node, ...(node.family === "gate" ? (node.branches ?? []).flatMap((b) => all(b.nodes)) : [])]);

  for (const lane of lanes) {
    if (lane.entry.trigger === "cron") continue;
    const segments = segmentsOf(lane);
    const index = segments.findIndex((segment) => segment.nodes.some((node) => node.family === "act" && node.body.claim));
    if (index < 0) continue;
    const claimAct = segments[index].nodes.find((node) => node.family === "act" && node.body.claim) as Extract<NodeModel, { family: "act" }>;
    // Tout ce qui suit le tirage : un segment de livraison pour l'annotation, deux (observation, verdict) pour la validation.
    const after = segments.slice(index + 1);
    const deliveryNodes = after.flatMap((segment) => segment.nodes);
    const gestures = after.flatMap((segment) =>
      segment.gestures.map((gesture) => ({ id: gesture.id, fields: Object.keys(gestureFields(gesture)), final: segment.final }))
    );
    const spec: ReplaySpec = { claimActId: claimAct.id, claim: claimAct.body.claim!, gestures, nodes: deliveryNodes };
    const delivery = { nodes: deliveryNodes };

    const replayed = all(delivery.nodes).filter((node) => node.family === "gate" || (node.family === "assess" && (node.body.counters || node.body.emit)));
    const allowed = new Set(["params", "value", claimAct.id, ...gestures.map((gesture) => gesture.id), ...replayed.map((node) => node.id)]);
    const forbidden = all(lane.nodes).map((node) => node.id).filter((id) => !allowed.has(id));
    for (const node of replayed) {
      const sources: unknown[] =
        node.family === "gate"
          ? (node.branches ?? []).map((branch) => branch.when)
          : node.family === "assess"
            ? [node.body.value, node.body.from, ...Object.values(node.body.counters ?? {}).map((update) => update.add)]
            : [];
      for (const ast of expressionsOf(sources)) {
        const read = [...forbidden, "counters", "challenge", "participation", "aggregates"].find((name) => readsRoot(ast, name));
        if (read) throw new CompileError(`[interpreter] ${flowKey}: ${node.id} is replayed from stored claims and cannot read '${read}'`);
      }
    }

    for (const type of claimedTypesOf(flowKey, claimAct, lane, nodeFields)) {
      if (replays.has(type)) throw new CompileError(`[interpreter] ${flowKey}: ${type} is drawn by two lanes; v1 replays one`);
      replays.set(type, spec);
    }
  }
  return replays;
}

async function aggregatesOf(
  resource: string,
  resourceId: string,
  resolution: Record<string, unknown> | null,
  t: CompiledTemplate,
  engine: Engine,
  params: Record<string, Value>
): Promise<Record<string, Value>> {
  const aggregates: Record<string, Value> = {};
  for (const aggregate of t.model.aggregates) {
    if (aggregate.decl.over !== resource) continue;
    const inputs = await engine.inputs(aggregate.decl.id, resourceId, params);
    aggregates[aggregate.decl.id] = { verdict: (resolution?.consensus as Value) ?? null, inputs, count: inputs.length };
  }
  return aggregates;
}

