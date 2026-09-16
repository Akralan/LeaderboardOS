import type { Challenge } from "../../database-service/domain/entities.js";
import { flowConfigOf } from "../../capabilities/flow-config.js";
import { jsonError } from "../../capabilities/challenge-actions.js";
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
import type { TemplateReport } from "../index.js";
import type { LaneModel, NodeModel } from "../validate/format.js";
import { Engine, Refusal, newState, type CompiledTemplate, type RunState } from "./engine.js";
import { compileParams, zodOf, type CompiledParams } from "./params.js";
import { defaultRuntime, type TemplateRuntime } from "./runtime.js";
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
  /** Présentation : le template n'en dit rien. */
  icon?: string;
  publiclyVisible?: boolean;
}

const SCHEDULES: Record<string, string> = { hourly: "0 * * * *", daily: "0 3 * * *", weekly: "0 4 * * 1" };

const gestureFields = (node: NodeModel): Record<string, FieldDecl> =>
  node.family === "collect" || node.family === "assess" ? node.body.fields ?? {} : {};

const isGesture = (node: NodeModel) =>
  node.family === "collect" || (node.family === "assess" && node.body.kind === "human" && Boolean(node.body.fields));

/** Un segment : ce qu'un seul appel exécute, du geste (s'il y en a un) au prochain. */
interface Segment {
  nodes: NodeModel[];
  gestures: NodeModel[];
  path: string;
  final: boolean;
}

function segmentsOf(lane: LaneModel): Segment[] {
  const segments: { nodes: NodeModel[]; serverStep: boolean }[] = [];
  for (const node of lane.nodes) {
    const current = segments[segments.length - 1];
    if (!current || (isGesture(node) && current.serverStep)) {
      segments.push({ nodes: [node], serverStep: !isGesture(node) && node.family !== "gate" });
      continue;
    }
    current.nodes.push(node);
    if (!isGesture(node) && node.family !== "gate") current.serverStep = true;
  }
  return segments.map((segment, index) => {
    const first = segment.nodes[0];
    return {
      nodes: segment.nodes,
      gestures: segment.nodes.filter(isGesture),
      path: isGesture(first) ? `${lane.id}/${first.id}` : lane.id,
      final: index === segments.length - 1,
    };
  });
}

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

  // ── Récompenses : clés de ledger, pool ──────────────────────────────────
  const rewards: { body: RewardBody; key: string; ref?: string }[] = [];
  const collectRewards = (nodes: readonly NodeModel[], owner: string) => {
    for (const node of nodes) {
      if (node.family === "reward") rewards.push({ body: node.body, key: node.body.rule_key ?? `${flowKey}.${owner}.${node.id}`, ref: `${owner}.${node.id}` });
      if (node.family === "gate") for (const branch of node.branches ?? []) collectRewards(branch.nodes, owner);
    }
  };
  for (const lane of model.lanes) collectRewards(lane.nodes, lane.id);
  for (const aggregate of model.aggregates) {
    aggregate.then.forEach((effect, i) => {
      if (effect.family === "reward") rewards.push({ body: effect.body, key: effect.body.rule_key ?? `${flowKey}.${aggregate.decl.id}.${i}` });
    });
  }
  model.onClose.forEach((effect, i) => {
    if (effect.family === "reward") rewards.push({ body: effect.body, key: effect.body.rule_key ?? `${flowKey}.close.${effect.body.id ?? i}` });
  });

  const pools = new Set(rewards.map((reward) => reward.body.pool).filter((pool): pool is ExprSource => pool !== undefined).map(String));
  if (pools.size > 1) throw new CompileError(`[interpreter] ${flowKey}: v1 compiles a single pool, got ${[...pools].join(", ")}`);
  const poolParam = pools.size === 1 ? /^\s*params\.([a-z][a-z0-9_]*)\s*$/.exec([...pools][0])?.[1] ?? null : null;

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
    contributionType: flowKey,
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
    checkSegments(flowKey, lane, segments);
    const claimAct = lane.nodes.find((node) => node.family === "act" && node.body.claim);

    segments.forEach((segment, index) => {
      const afterClaim = Boolean(claimAct && segments.slice(0, index).some((earlier) => earlier.nodes.includes(claimAct)));
      actions.push({
        path: segment.path,
        method: "POST",
        access: accessOf(lane, params),
        handle: (ctx) =>
          runSegment({ ctx, lane, segment, claimAct: afterClaim ? (claimAct as Extract<NodeModel, { family: "act" }>) : null }, compiled, engine, params, types.nodeFields),
      });
    });
  }

  // ── Aggregates résolus à la clôture ─────────────────────────────────────
  const lifecycleAggregates = model.aggregates.filter(
    (aggregate) => typeof aggregate.decl.resolve.when === "string" && !readsRoot(parseExpr(aggregate.decl.resolve.when), "inputs")
  );

  return {
    descriptor: {
      key: flowKey,
      label: shell.template.name,
      longLabel: shell.template.name,
      icon: options.icon ?? "sparkles",
      briefRequired: true,
      publiclyVisible: options.publiclyVisible ?? false,
    },
    config: { version: 1, schema: params.configSchema },
    rules: { parse: (raw) => (params.rulesSchema.safeParse(raw ?? {}).success ? params.rulesSchema.parse(raw ?? {}) : null) },
    ruleKeys,
    contributionTypes: [{ key: flowKey, countsAsContribution: true }],
    uses: { board: false, groups: false },
    actions,
    jobs,
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

function counterWritesOf(nodes: readonly NodeModel[]): { node: string; counter: string; add: ExprSource }[] {
  return nodes.flatMap((node) => {
    if (node.family === "gate") return (node.branches ?? []).flatMap((branch) => counterWritesOf(branch.nodes));
    if (node.family !== "assess" || !node.body.counters) return [];
    return Object.entries(node.body.counters).map(([counter, update]) => ({ node: node.id, counter, add: update.add }));
  });
}

/** Un segment ne lit d'un segment passé que le claim : rien d'autre ne survit entre deux appels. */
function checkSegments(flowKey: string, lane: LaneModel, segments: Segment[]) {
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
    const earlier = segments.slice(0, index).flatMap((previous) => all(previous.nodes));
    const later = segments.slice(index).flatMap((next) => all(next.nodes));
    for (const node of earlier) {
      const carried = node.family === "act" && node.body.claim;
      if (carried) continue;
      if (later.some((reader) => expressionsOf(reader.body).some((ast) => readsRoot(ast, node.id)))) {
        throw new CompileError(`[interpreter] ${flowKey}: lane ${lane.id} reads '${node.id}' across a gesture; only a claim survives between calls`);
      }
    }
    for (const node of all(segment.nodes)) {
      if (node.family === "act" && node.body.create && later.some((reader) => reader !== node && expressionsOf(reader.body).some((ast) => readsRoot(ast, node.id)))) {
        throw new CompileError(`[interpreter] ${flowKey}: the output of create '${node.id}' is not readable in v1`);
      }
    }
  });
}

function accessOf(lane: LaneModel, params: CompiledParams): ActionAccess {
  if (lane.entry.trigger === "admin") return { roles: ["admin"], manager: true };
  const access = lane.entry.access!;
  if (access.mode === "role") {
    const param = /^\s*params\.([a-z][a-z0-9_]*)\s*$/.exec(String(access.role))?.[1];
    return {
      roles: ["admin"],
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

  const body = (await ctx.request.json().catch(() => ({}))) as Record<string, unknown>;
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError(400, "The body is a JSON object");
  const state = newState(ctx.challenge, ctx.user.id, values);

  try {
    if (claimAct) {
      const claimId = typeof body.claim_id === "string" ? body.claim_id : null;
      const claim = claimId ? await t.runtime.resources.claim(claimId) : null;
      if (!claim || claim.user_id !== ctx.user.id || claim.challenge_id !== ctx.challenge.uuid) return jsonError(404, "Claim not found");
      await engine.hold(claimAct.id, claimAct.body.claim!, claim.uuid, claim.resource_id, state);
    }

    for (const gesture of segment.gestures) {
      const fields = gestureFields(gesture);
      const bound = await readGesture(fields, nodeFields.get(gesture) ?? {}, body, state, engine, t);
      state.bindings[gesture.id] = bound;
      state.result.fields[gesture.id] = bound;
    }

    await engine.run(segment.nodes, state);
    if (segment.final) await engine.deliver(state);
  } catch (error) {
    if (error instanceof Refusal) return jsonError(error.status, error.message);
    if (error instanceof GestureError) return jsonError(400, error.message);
    if (error instanceof EvalError) throw new Error(`[interpreter] ${t.flowKey}: ${error.message}`);
    throw error;
  }

  if (state.drawn && !state.claim?.consumed) {
    const instance = await t.runtime.resources.resource(state.drawn.resourceId);
    const decl = instance ? t.model.shell.resources[instance.resource_type] : null;
    const value = instance ? await resourceValue(instance, t.runtime.resources, t.resourceTypes) : null;
    return {
      claim: {
        claim_id: state.drawn.claimId,
        expires_at: state.drawn.expiresAt,
        // L'opacité des substitutions : jamais le type, seulement ce que le claimant peut lire.
        resource: value && decl ? await project(value, decl, viewerOf(ctx, values, true)) : null,
      },
    };
  }
  return { ok: true, cp_awarded: state.awarded };
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
    const parsed = zodOf(type).safeParse(raw);
    if (!parsed.success) throw new GestureError(`${name}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    let value = parsed.data as Value;

    if (type.kind === "resource") {
      const instance = await t.runtime.resources.resource(String(value));
      if (!instance || instance.challenge_id !== state.challenge.uuid || instance.resource_type !== type.name) {
        throw new GestureError(`${name}: no such ${type.name}`);
      }
      value = await resourceValue(instance, t.runtime.resources, t.resourceTypes);
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

function cronJob(lane: LaneModel, t: CompiledTemplate, engine: Engine, params: CompiledParams): JobDeclaration {
  const over = lane.entry.over;
  const schedule = SCHEDULES[lane.entry.schedule ?? ""] ?? lane.entry.schedule ?? "0 3 * * *";
  const cursorKey = `cursor.${lane.id}`;

  return {
    key: `${t.flowKey}.${lane.id}`,
    schedule,
    async run() {
      const summary = { challenges: 0, instances: 0, ran: 0 };
      for (const challenge of await t.runtime.challengesOf(t.flowKey)) {
        if (challenge.status !== "active") continue;
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
          state.bindings[over.resource] = await resourceValue(instance, t.runtime.resources, t.resourceTypes);
          state.bindings.aggregates = await aggregatesOf(over.resource, instance.uuid, instance.resolution, t, engine);
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

async function aggregatesOf(
  resource: string,
  resourceId: string,
  resolution: Record<string, unknown> | null,
  t: CompiledTemplate,
  engine: Engine
): Promise<Record<string, Value>> {
  const aggregates: Record<string, Value> = {};
  for (const aggregate of t.model.aggregates) {
    if (aggregate.decl.over !== resource) continue;
    const inputs = await engine.inputs(aggregate.decl.id, resourceId);
    aggregates[aggregate.decl.id] = { verdict: (resolution?.verdict as Value) ?? null, inputs, count: inputs.length };
  }
  return aggregates;
}

