import type { ActionAccess, ActionContext, ChallengeActionDeclaration } from "../../registry/platform.js";

import { flowConfigOf } from "../../capabilities/flow-config.js";
import { jsonError } from "./responses.js";
import type { Value } from "../expr/evaluator.js";
import type { Type } from "../expr/types.js";
import type { LaneModel, NodeModel } from "../validate/format.js";
import { Engine, newState, type CompiledTemplate } from "./engine.js";
import type { CompiledParams } from "./params.js";
import { scopeKeyOfFields } from "./scope.js";
import { project, resourceValue, type Viewer } from "./values.js";

/** Comme `contribution.repo.ts` : un run d'évaluation plus vieux se reprend. */
const EVALUATION_STALE_AFTER_MS = 30 * 60 * 1000;

/**
 * Les surfaces générées (compromis 10)
 * ------------------------------------
 * Les lanes décrivent le programme ; les lectures se génèrent. Le compilateur
 * tire des déclarations — ressources, claims, compteurs, visibilité, clés de
 * ledger — ce que tout flow à claims expose :
 *
 * - `POST <lane>/release` : l'abandon explicite d'un claim, sur toute lane qui
 *   tire (l'échéance couvre l'abandon silencieux) ;
 * - `GET progress` : ce que l'appelant a livré, gagné, ses compteurs tels
 *   qu'il a le droit de les voir (décalés), les classes qu'il peut tirer, son
 *   claim actif ;
 * - `GET overview` : l'avancement par type de ressource, le pool, chaque
 *   participant avec son nom et ses compteurs sans décalage, et les
 *   ressources qu'une lane admin attend de trancher ;
 * - `rewards.summarize` : l'avancement par type de ressource, sous le même nom
 *   que dans `overview` — ce que le hero d'un challenge lit.
 * - `GET export?type=` : les instances fermées d'un type, en CSV, avec ce
 *   qu'un admin peut en lire, leur verdict, leur consensus et leurs entrées ;
 * - `GET <lane>/claim?claim_id=` : le claim en cours de l'appelant, sa
 *   ressource projetée (« sa politique ou un grant » — ce que le reveal ouvre)
 *   et ce que la lane en a gardé ;
 * - `GET <lane>/file?claim_id=&path=` et `GET file?resource_id=&field=` : les
 *   octets d'un fichier, sous la même règle de visibilité ; purgé, 410 ;
 * - `GET mine` : les instances que l'appelant a créées, par type, projetées
 *   pour lui — ce qu'un participant reprend (une walkthrough en cours) ;
 * - `GET resources?type=` : toutes les instances d'un type pour un manager,
 *   brouillons compris, avec leur auteur, leur état et leur résolution ;
 * - `GET <lane>/options?field=<geste>.<champ>` : les choix d'un champ `ref` ou
 *   `link` pour l'appelant — le `where` évalué côté serveur, les combinaisons
 *   qu'un claim désigné refuserait déjà retirées (les autres champs du geste en
 *   paramètres), chaque choix projeté et, pour la ressource d'un aggregate, son
 *   état selon `state_visibility` (le décompte pour tous, la répartition pour l'admin).
 */

const MANAGERS: ActionAccess = { roles: ["admin"], manager: true };
const PARTICIPANTS: ActionAccess = { roles: ["admin"], manager: true, member: true };
export const GENERATED_PATHS = ["progress", "overview", "export", "file", "mine", "resources"] as const;

export function generatedActions(
  t: CompiledTemplate,
  engine: Engine,
  params: CompiledParams,
  types: { nodeFields: ReadonlyMap<NodeModel, Record<string, Type>> },
  entryAccess: (lane: LaneModel) => ActionAccess
): ChallengeActionDeclaration[] {
  const { shell } = t.model;
  // Ce qu'une lane lit, qui peut y entrer le lit : un relecteur qualifié n'a pas à être membre.
  const laneAccess = (lane: LaneModel): ActionAccess =>
    lane.entry.trigger === "admin" ? MANAGERS : lane.entry.access?.mode === "signed_in" ? {} : { ...PARTICIPANTS, ...entryAccess(lane) };
  const signedInLanes = t.model.lanes.some((lane) => lane.entry.trigger === "user" && lane.entry.access?.mode === "signed_in");
  const qualifiedLanes = t.model.lanes.filter((lane) => lane.entry.trigger === "user" && entryAccess(lane).qualification);
  const ANYONE_WHO_ENTERS: ActionAccess = signedInLanes
    ? {}
    : qualifiedLanes.length
      ? { ...PARTICIPANTS, qualification: (challenge) => entryAccess(qualifiedLanes[0]).qualification!(challenge) }
      : PARTICIPANTS;
  const actions: ChallengeActionDeclaration[] = [];
  const valuesOr409 = (ctx: ActionContext) => params.valuesOf(ctx.challenge, flowConfigOf(ctx.challenge));
  const ruleKeys = new Set(t.ruleKeys.values());
  const claimable = new Set(t.replays.keys());

  // ── release ─────────────────────────────────────────────────────────────
  for (const lane of t.model.lanes) {
    const drawing = lane.nodes.some((node) => node.family === "act" && node.body.claim);
    if (!drawing || lane.entry.trigger === "cron" || lane.entry.trigger === "submission") continue;
    actions.push({
      path: `${lane.id}/release`,
      method: "POST",
      access: laneAccess(lane),
      async handle({ request, challenge, user }) {
        const body = (await request.json().catch(() => ({}))) as { claim_id?: unknown };
        const claim = typeof body.claim_id === "string" ? await t.runtime.resources.claim(body.claim_id) : null;
        if (!claim || claim.user_id !== user.id || claim.challenge_id !== challenge.uuid) return jsonError(404, "Claim not found");
        if (!(await t.runtime.resources.release(claim.uuid, user.id))) return jsonError(409, "This claim is no longer active");
        return { released: true };
      },
    });
  }

  // ── evaluation : l'état d'une évaluation en arrière-plan ─────────────────
  for (const lane of t.model.lanes) {
    const background = lane.nodes.some((node) => node.family === "assess" && Boolean(node.body.background));
    if (!background) continue;
    actions.push({
      path: `${lane.id}/evaluation`,
      method: "GET",
      access: laneAccess(lane),
      async handle({ challenge, user }) {
        const [state, entries] = await Promise.all([
          t.runtime.evaluations.read(challenge.uuid, user.id, t.contribution.type),
          t.runtime.ledger.entries(challenge.uuid),
        ]);
        const since = state?.since ?? null;
        // Comme le challenge code : un run de plus de 30 minutes se reprend au prochain lancement.
        const stale = state?.status === "running" && since !== null && t.runtime.now().getTime() - since.getTime() >= EVALUATION_STALE_AFTER_MS;
        return {
          status: state?.status ?? null,
          running: state?.status === "running" && !stale,
          started_at: since,
          score: state?.evaluation ? Math.min(1, Math.max(0, state.evaluation.globalScore / 9)) : null,
          evaluation: state?.evaluation ?? null,
          artifact_url: state?.artifactUrl ?? null,
          cp: entries.filter((entry) => entry.user_id === user.id && ruleKeys.has(entry.rule_key)).reduce((sum, entry) => sum + entry.points, 0),
        };
      },
    });
  }

  // ── progress ────────────────────────────────────────────────────────────
  actions.push({
    path: "progress",
    method: "GET",
    access: ANYONE_WHO_ENTERS,
    async handle(ctx) {
      const values = valuesOr409(ctx);
      if (!values) return jsonError(409, "This challenge has no readable configuration or rules");
      const { challenge, user } = ctx;
      const [delivered, entries, active] = await Promise.all([
        t.runtime.resources.consumedBy({ challengeId: challenge.uuid, userId: user.id }),
        t.runtime.ledger.entries(challenge.uuid),
        t.runtime.resources.activeClaim(challenge.uuid, user.id),
      ]);
      const holding = active && claimable.has(active.resource.resource_type) ? active : null;
      return {
        delivered: delivered.length,
        cp: entries.filter((entry) => entry.user_id === user.id && ruleKeys.has(entry.rule_key)).reduce((sum, entry) => sum + entry.points, 0),
        counters: await engine.counters(newState(challenge, user.id, values)),
        eligible_classes: await engine.eligibleClasses(newState(challenge, user.id, values)),
        active_claim: holding ? { claim_id: holding.claim.uuid, expires_at: holding.claim.expires_at } : null,
      };
    },
  });

  // ── overview ────────────────────────────────────────────────────────────
  /** Les verdicts qu'une lane admin attend : le `from` de ses transitions. */
  const awaited = new Set<string>();
  const collectFrom = (nodes: readonly NodeModel[]) => {
    for (const node of nodes) {
      if (node.family === "act" && node.body.transition?.from) awaited.add(node.body.transition.from);
      if (node.family === "gate") for (const branch of node.branches ?? []) collectFrom(branch.nodes);
    }
  };
  for (const lane of t.model.lanes) if (lane.entry.trigger === "admin") collectFrom(lane.nodes);

  actions.push({
    path: "overview",
    method: "GET",
    access: MANAGERS,
    async handle(ctx) {
      const values = valuesOr409(ctx);
      if (!values) return jsonError(409, "This challenge has no readable configuration or rules");
      const { challenge } = ctx;
      const [instances, delivered, entries, distributed] = await Promise.all([
        t.runtime.resources.list({ challengeId: challenge.uuid }),
        t.runtime.resources.consumedBy({ challengeId: challenge.uuid }),
        t.runtime.ledger.entries(challenge.uuid),
        t.runtime.ledger.distributed(challenge.uuid),
      ]);

      const resources = resourceCounts(shell, instances);

      const users = [...new Set(delivered.map((claim) => claim.user_id))];
      const names = await t.runtime.names(users);
      const participants = await Promise.all(
        users.map(async (userId) => ({
          user_id: userId,
          name: names[userId] ?? null,
          delivered: delivered.filter((claim) => claim.user_id === userId).length,
          cp: entries.filter((entry) => entry.user_id === userId && ruleKeys.has(entry.rule_key)).reduce((sum, entry) => sum + entry.points, 0),
          // Le manager voit tout : sans décalage.
          counters: await engine.counters(newState(challenge, userId, values), { lag: false }),
        }))
      );

      const viewer = adminViewer(ctx, values);
      const pending = [];
      for (const instance of instances) {
        if (instance.state !== "closed" || !instance.verdict || !awaited.has(instance.verdict)) continue;
        const decl = shell.resources[instance.resource_type];
        if (!decl) continue;
        const value = await resourceValue(instance, t.runtime, t.resourceTypes);
        const inputs: Record<string, Value[]> = {};
        for (const aggregate of t.model.aggregates) {
          if (aggregate.decl.over !== instance.resource_type) continue;
          inputs[aggregate.decl.id] = (await engine.inputs(aggregate.decl.id, instance.uuid, values)).map(withoutEngineKeys);
        }
        pending.push({ resource_id: instance.uuid, type: instance.resource_type, verdict: instance.verdict, fields: await project(value, decl, viewer), inputs });
      }

      return {
        resources,
        pool: { pool: challenge.contribution_points_reward, distributed, remaining: Math.max(0, challenge.contribution_points_reward - distributed) },
        participants: participants.sort((a, b) => b.delivered - a.delivered),
        pending,
      };
    },
  });

  // ── options d'un champ ref ou link ────────────────────────────────────────
  const gesturesOf = (lane: LaneModel) => {
    const all = (nodes: readonly NodeModel[]): NodeModel[] =>
      nodes.flatMap((node) => [node, ...(node.family === "gate" ? (node.branches ?? []).flatMap((b) => all(b.nodes)) : [])]);
    return all(lane.nodes);
  };

  for (const lane of t.model.lanes) {
    if (lane.entry.trigger === "cron" || lane.entry.trigger === "submission") continue;
    const nodes = gesturesOf(lane);
    const refFields = nodes.flatMap((node) =>
      (node.family === "collect" || node.family === "assess") && node.body.fields
        ? Object.entries(node.body.fields)
            .filter(([name]) => {
              const type = types.nodeFields.get(node)?.[name];
              return type?.kind === "resource" || type?.kind === "contribution";
            })
            .map(([name, decl]) => ({ node, name, decl, type: types.nodeFields.get(node)![name] }))
        : []
    );
    if (refFields.length === 0) continue;

    actions.push({
      path: `${lane.id}/options`,
      method: "GET",
      access: laneAccess(lane),
      async handle(ctx) {
        const values = valuesOr409(ctx);
        if (!values) return jsonError(409, "This challenge has no readable configuration or rules");
        const query = new URL(ctx.request.url).searchParams;
        const wanted = query.get("field") ?? "";
        const ref = refFields.find((candidate) => `${candidate.node.id}.${candidate.name}` === wanted);
        if (!ref) return jsonError(404, `No choice field ${wanted} in lane ${lane.id}`);
        const state = newState(ctx.challenge, ctx.user.id, values);

        if (ref.type.kind === "contribution") {
          const capability = ref.decl.deliverable ?? deliverableOfShell(shell);
          const eligible = capability ? await t.runtime.contributions.eligible(ctx.challenge, capability) : [];
          // Une soumission déjà prise par un champ `unique` n'est plus un choix.
          const taken = new Set<string>();
          for (const [type, resource] of Object.entries(shell.resources)) {
            const unique = Object.entries(resource.fields).filter(([name, field]) => field.unique && name === ref.name).map(([name]) => name);
            if (unique.length === 0) continue;
            for (const instance of await t.runtime.resources.list({ challengeId: ctx.challenge.uuid, type })) {
              for (const name of unique) taken.add(String(instance.payload[name]));
            }
          }
          return { options: eligible.filter((contribution) => !taken.has(contribution.id)) };
        }

        const typeName = (ref.type as { name: string }).name;
        const decl = shell.resources[typeName];
        const instances = await engine.instancesOf(ctx.challenge.uuid, typeName);
        const hydrated = await Promise.all(instances.map((instance) => resourceValue(instance, t.runtime, t.resourceTypes)));
        let eligible = hydrated;
        if (ref.decl.where !== undefined) {
          const kept = [];
          for (const value of hydrated) if ((await engine.eval(ref.decl.where, state, { [ref.name]: value })) === true) kept.push(value);
          eligible = kept;
        }

        // Un claim désigné sur ce champ : les combinaisons déjà tenues ne sont pas proposées.
        const claimAct = nodes.find((node) => node.family === "act" && node.body.claim?.resource.trim() === wanted);
        const claim = claimAct?.family === "act" ? claimAct.body.claim : undefined;
        if (claim?.scope) {
          const scope = scopeKeyOfFields(claim.scope, ref.node.id, query);
          if (scope) {
            const held = await t.runtime.resources.heldInScope(eligible.map((value) => String(value.id)), scope, ctx.user.id);
            eligible = eligible.filter((value) => !held.has(String(value.id)));
          }
        }

        const isAdmin = ctx.access.isAdmin() || (await ctx.access.isManager());
        const options = [];
        for (const value of eligible) {
          const granted = (await t.runtime.resources.grantsFor([String(value.id)], ctx.user.id))[String(value.id)] ?? [];
          const option: Record<string, Value> = await project(value, decl, { ...participantViewer(ctx, values, false), granted });
          const states: Record<string, Value> = {};
          for (const aggregate of t.model.aggregates) {
            if (aggregate.decl.over !== typeName) continue;
            const visibility = aggregate.decl.state_visibility;
            const sees = (who: string | undefined) => who === "everyone" || (who === "admin" && isAdmin) || (who === "author" && value.author === ctx.user.id);
            if (!sees(visibility?.count) && !sees(visibility?.split)) continue;
            const inputs = await engine.inputs(aggregate.decl.id, String(value.id), values);
            const view: Record<string, Value> = {};
            if (sees(visibility?.count)) view.count = inputs.length;
            if (sees(visibility?.split)) view.split = splitOf(inputs);
            states[aggregate.decl.id] = view;
          }
          if (Object.keys(states).length > 0) option.aggregates = states;
          options.push(option);
        }
        return { options };
      },
    });
  }

  // ── claim en cours, fichiers ─────────────────────────────────────────────
  const holderOf = async (ctx: ActionContext) => {
    const claimId = new URL(ctx.request.url).searchParams.get("claim_id");
    const claim = claimId ? await t.runtime.resources.claim(claimId) : null;
    return claim && claim.user_id === ctx.user.id && claim.challenge_id === ctx.challenge.uuid ? claim : null;
  };
  const projectedFor = async (ctx: ActionContext, values: Record<string, Value>, resourceId: string, claimant: boolean) => {
    const instance = await t.runtime.resources.resource(resourceId);
    const decl = instance ? shell.resources[instance.resource_type] : undefined;
    if (!instance || !decl || instance.challenge_id !== ctx.challenge.uuid) return null;
    const granted = (await t.runtime.resources.grantsFor([instance.uuid], ctx.user.id))[instance.uuid] ?? [];
    const viewer = { ...participantViewer(ctx, values, claimant), granted };
    const value = await resourceValue(instance, t.runtime, t.resourceTypes);
    return { instance, decl, projected: await project(value, decl, viewer) };
  };

  for (const lane of t.model.lanes) {
    if (lane.entry.trigger === "cron" || lane.entry.trigger === "submission" || !lane.nodes.some((node) => node.family === "act" && node.body.claim)) continue;
    const access = laneAccess(lane);

    actions.push({
      path: `${lane.id}/claim`,
      method: "GET",
      access,
      async handle(ctx) {
        const values = valuesOr409(ctx);
        if (!values) return jsonError(409, "This challenge has no readable configuration or rules");
        const claim = await holderOf(ctx);
        if (!claim) return jsonError(404, "Claim not found");
        const view = await projectedFor(ctx, values, claim.resource_id, true);
        const context = Object.fromEntries(Object.entries(claim.context ?? {}).filter(([key]) => !key.startsWith("$")));
        return {
          claim: {
            claim_id: claim.uuid,
            expires_at: claim.expires_at,
            consumed: claim.consumed_at !== null,
            released: claim.released_at !== null,
            resource: view?.projected ?? null,
            context,
          },
        };
      },
    });

    actions.push({
      path: `${lane.id}/file`,
      method: "GET",
      access,
      async handle(ctx) {
        const values = valuesOr409(ctx);
        if (!values) return jsonError(409, "This challenge has no readable configuration or rules");
        const claim = await holderOf(ctx);
        if (!claim) return jsonError(404, "Claim not found");
        const path = (new URL(ctx.request.url).searchParams.get("path") ?? "").split(".");
        if (path[0] === "resource" && path.length === 2) {
          const view = await projectedFor(ctx, values, claim.resource_id, true);
          return serveBlob(t, view?.projected[path[1]] ?? null);
        }
        if (path[0] === "context" && path.length >= 2) {
          let value: unknown = claim.context ?? {};
          for (const key of path.slice(1)) value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
          return serveBlob(t, (value ?? null) as Value);
        }
        return jsonError(400, "path is resource.<field> or context.<node>.<key>");
      },
    });
  }

  actions.push({
    path: "file",
    method: "GET",
    access: ANYONE_WHO_ENTERS,
    async handle(ctx) {
      const values = valuesOr409(ctx);
      if (!values) return jsonError(409, "This challenge has no readable configuration or rules");
      const params = new URL(ctx.request.url).searchParams;
      const resourceId = params.get("resource_id");
      const field = params.get("field");
      if (!resourceId || !field) return jsonError(400, "resource_id and field are required");
      // Réclamant : une réclamation, en cours ou livrée, de l'appelant sur cette instance.
      const mine = await t.runtime.resources.consumedBy({ challengeId: ctx.challenge.uuid, userId: ctx.user.id });
      const active = await t.runtime.resources.activeClaim(ctx.challenge.uuid, ctx.user.id);
      const claimant = mine.some((claim) => claim.resource_id === resourceId) || active?.resource.uuid === resourceId;
      const view = await projectedFor(ctx, values, resourceId, claimant);
      if (!view) return jsonError(404, "Resource not found");
      return serveBlob(t, view.projected[field] ?? null);
    },
  });

  // ── mine : ce que l'appelant a créé ───────────────────────────────────────
  actions.push({
    path: "mine",
    method: "GET",
    access: ANYONE_WHO_ENTERS,
    async handle(ctx) {
      const values = valuesOr409(ctx);
      if (!values) return jsonError(409, "This challenge has no readable configuration or rules");
      const viewer = participantViewer(ctx, values, false);
      const resources: Record<string, Record<string, Value>[]> = {};
      for (const [type, decl] of Object.entries(shell.resources)) {
        const own = (await engine.instancesOf(ctx.challenge.uuid, type)).filter((instance) => instance.created_by === ctx.user.id);
        if (own.length === 0) continue;
        resources[type] = await Promise.all(
          own.map(async (instance) => ({
            ...(await project(await resourceValue(instance, t.runtime, t.resourceTypes), decl, viewer)),
            open: instance.state === "open",
            verdict: instance.verdict,
            resolution: (instance.resolution ?? null) as Value,
            created_at: instance.created_at.toISOString(),
          }))
        );
      }
      return { resources };
    },
  });

  // ── resources : le navigateur d'un manager ───────────────────────────────
  actions.push({
    path: "resources",
    method: "GET",
    access: MANAGERS,
    async handle(ctx) {
      const values = valuesOr409(ctx);
      if (!values) return jsonError(409, "This challenge has no readable configuration or rules");
      const type = new URL(ctx.request.url).searchParams.get("type") ?? "";
      const decl = shell.resources[type];
      if (!decl) return jsonError(404, `No resource type ${type}`);
      const viewer = adminViewer(ctx, values);
      const instances = await engine.instancesOf(ctx.challenge.uuid, type);
      const names = await t.runtime.names([...new Set(instances.map((instance) => instance.created_by).filter((id): id is string => Boolean(id)))]);
      return {
        type,
        instances: await Promise.all(
          instances.map(async (instance) => ({
            id: instance.uuid,
            author: instance.created_by,
            author_name: instance.created_by ? names[instance.created_by] ?? null : null,
            open: instance.state === "open",
            verdict: instance.verdict,
            resolution: (instance.resolution ?? null) as Value,
            created_at: instance.created_at.toISOString(),
            fields: await project(await resourceValue(instance, t.runtime, t.resourceTypes), decl, viewer),
          }))
        ),
      };
    },
  });

  // ── export ──────────────────────────────────────────────────────────────
  const defaultType = t.model.aggregates[0]?.decl.over ?? Object.keys(shell.resources)[0];
  actions.push({
    path: "export",
    method: "GET",
    access: MANAGERS,
    async handle(ctx) {
      const values = valuesOr409(ctx);
      if (!values) return jsonError(409, "This challenge has no readable configuration or rules");
      const type = new URL(ctx.request.url).searchParams.get("type") ?? defaultType;
      const decl = type ? shell.resources[type] : undefined;
      if (!type || !decl) return jsonError(404, `No resource type ${type}`);

      // Ce qu'un admin peut lire ; un champ que personne ne lit (\`[]\`) ne sort jamais.
      const columns = Object.entries(decl.fields)
        .filter(([, field]) => field.visibility === undefined || field.visibility.length > 0)
        .map(([name]) => name);
      const viewer = adminViewer(ctx, values);
      const closed = await t.runtime.resources.list({ challengeId: ctx.challenge.uuid, type, state: "closed" });
      const rows: (string | number)[][] = [];
      for (const instance of closed) {
        const projected = await project(await resourceValue(instance, t.runtime, t.resourceTypes), decl, viewer);
        const inputs = (await t.runtime.resources.consumedClaims(instance.uuid)).length;
        rows.push([
          ...columns.map((column) => cell(projected[column])),
          instance.verdict ?? "",
          cell((instance.resolution?.consensus as Value) ?? null),
          inputs,
        ]);
      }
      const csv = [[...columns, "verdict", "consensus", "inputs"], ...rows].map((row) => row.map(csvField).join(",")).join("\n");
      return new Response(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${t.flowKey}-${type}-${ctx.challenge.slug || ctx.challenge.uuid}.csv"`,
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  });

  return actions;
}

/** L'avancement par type de ressource : `{ item: { total, open, closed, verdicts: { labeled: n } } }`. */
export function resourceCounts(
  shell: CompiledTemplate["model"]["shell"],
  instances: readonly { resource_type: string; state: "open" | "closed"; verdict: string | null }[]
): Record<string, { total: number; open: number; closed: number; verdicts: Record<string, number> }> {
  const resources: Record<string, { total: number; open: number; closed: number; verdicts: Record<string, number> }> = {};
  for (const type of Object.keys(shell.resources)) resources[type] = { total: 0, open: 0, closed: 0, verdicts: {} };
  for (const instance of instances) {
    const row = resources[instance.resource_type];
    if (!row) continue;
    row.total++;
    row[instance.state]++;
    if (instance.verdict) row.verdicts[instance.verdict] = (row.verdicts[instance.verdict] ?? 0) + 1;
  }
  return resources;
}

/** Les chemins générés ne doivent croiser aucun geste du template. */
export function generatedPathConflicts(lanes: readonly LaneModel[], declared: readonly string[]): string[] {
  const generated = new Set<string>(GENERATED_PATHS);
  for (const lane of lanes) {
    generated.add(`${lane.id}/options`);
    generated.add(`${lane.id}/release`);
    generated.add(`${lane.id}/claim`);
    generated.add(`${lane.id}/file`);
    generated.add(`${lane.id}/evaluation`);
  }
  return declared.filter((path) => generated.has(path));
}

/** La répartition des entrées d'un aggregate sur leur premier champ énuméré (`verdict`, `value`…). */
function splitOf(inputs: Value[]): Record<string, number> {
  const split: Record<string, number> = {};
  for (const input of inputs) {
    if (!input || typeof input !== "object" || Array.isArray(input)) continue;
    const key = ["verdict", "value", "outcome"].find((name) => typeof input[name] === "string");
    if (!key) continue;
    const bucket = String(input[key]);
    split[bucket] = (split[bucket] ?? 0) + 1;
  }
  return split;
}

function deliverableOfShell(shell: CompiledTemplate["model"]["shell"]): string | null {
  for (const resource of Object.values(shell.resources)) {
    for (const field of Object.values(resource.fields)) if (field.deliverable) return field.deliverable;
  }
  return null;
}

function participantViewer(ctx: ActionContext, values: Record<string, Value>, claimant: boolean): Viewer {
  return {
    userId: ctx.user.id,
    isAdmin: ctx.access.isAdmin(),
    claimant,
    holdsRole: async (param) => {
      const qualification = values[param];
      return typeof qualification === "string" && (await ctx.access.holds(qualification));
    },
  };
}

/** Les octets d'une référence de blob lisible : 404 si le lecteur ne la voit pas, 410 si elle est purgée. */
async function serveBlob(t: CompiledTemplate, ref: Value): Promise<Response> {
  const blobId = ref && typeof ref === "object" && !Array.isArray(ref) && typeof ref.blob_id === "string" ? ref.blob_id : null;
  if (!blobId) return jsonError(404, "No readable file here");
  const blob = await t.runtime.blobs.get(blobId);
  if (!blob) return jsonError(404, "File not found");
  if (!blob.bytes) return jsonError(410, "This file has been purged");
  return new Response(new Uint8Array(blob.bytes), {
    status: 200,
    headers: {
      "Content-Type": blob.content_type,
      "Content-Disposition": `attachment; filename="${(blob.filename ?? "file").replace(/"/g, "")}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function adminViewer(ctx: ActionContext, values: Record<string, Value>): Viewer {
  return {
    userId: ctx.user.id,
    isAdmin: true,
    claimant: false,
    holdsRole: async (param) => {
      const qualification = values[param];
      return typeof qualification === "string" && (await ctx.access.holds(qualification));
    },
  };
}

function withoutEngineKeys(input: Value): Value {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const { participation: _participation, author: _author, claim: _claim, ...rest } = input;
  return rest;
}

function cell(value: Value | undefined): string | number {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "string") return value;
  return JSON.stringify(value);
}

/** Un champ CSV : entre guillemets s'il le faut, et jamais interprété comme formule par un tableur. */
function csvField(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text) && typeof value === "string") text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
