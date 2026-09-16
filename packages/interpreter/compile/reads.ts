import type { ActionAccess, ActionContext, ChallengeActionDeclaration } from "../../registry/platform.js";
import { flowConfigOf } from "../../capabilities/flow-config.js";
import { jsonError } from "../../capabilities/challenge-actions.js";
import type { Value } from "../expr/evaluator.js";
import type { LaneModel, NodeModel } from "../validate/format.js";
import { Engine, newState, type CompiledTemplate } from "./engine.js";
import type { CompiledParams } from "./params.js";
import { project, resourceValue, type Viewer } from "./values.js";

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
 *   qu'il a le droit de les voir (décalés), son claim actif ;
 * - `GET overview` : l'avancement par type de ressource, le pool, chaque
 *   participant avec ses compteurs sans décalage, et les ressources qu'une
 *   lane admin attend de trancher ;
 * - `GET export?type=` : les instances fermées d'un type, en CSV, avec ce
 *   qu'un admin peut en lire, leur verdict, leur consensus et leurs entrées.
 */

const MANAGERS: ActionAccess = { roles: ["admin"], manager: true };
const PARTICIPANTS: ActionAccess = { roles: ["admin"], manager: true, member: true };
export const GENERATED_PATHS = ["progress", "overview", "export"] as const;

export function generatedActions(t: CompiledTemplate, engine: Engine, params: CompiledParams): ChallengeActionDeclaration[] {
  const { shell } = t.model;
  const actions: ChallengeActionDeclaration[] = [];
  const valuesOr409 = (ctx: ActionContext) => params.valuesOf(ctx.challenge, flowConfigOf(ctx.challenge));
  const ruleKeys = new Set(t.ruleKeys.values());
  const claimable = new Set(t.replays.keys());

  // ── release ─────────────────────────────────────────────────────────────
  for (const lane of t.model.lanes) {
    const drawing = lane.nodes.some((node) => node.family === "act" && node.body.claim);
    if (!drawing || lane.entry.trigger === "cron") continue;
    actions.push({
      path: `${lane.id}/release`,
      method: "POST",
      access: lane.entry.trigger === "admin" ? MANAGERS : PARTICIPANTS,
      async handle({ request, challenge, user }) {
        const body = (await request.json().catch(() => ({}))) as { claim_id?: unknown };
        const claim = typeof body.claim_id === "string" ? await t.runtime.resources.claim(body.claim_id) : null;
        if (!claim || claim.user_id !== user.id || claim.challenge_id !== challenge.uuid) return jsonError(404, "Claim not found");
        if (!(await t.runtime.resources.release(claim.uuid, user.id))) return jsonError(409, "This claim is no longer active");
        return { released: true };
      },
    });
  }

  // ── progress ────────────────────────────────────────────────────────────
  actions.push({
    path: "progress",
    method: "GET",
    access: PARTICIPANTS,
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

      const resources: Record<string, { total: number; open: number; closed: number; verdicts: Record<string, number> }> = {};
      for (const type of Object.keys(shell.resources)) resources[type] = { total: 0, open: 0, closed: 0, verdicts: {} };
      for (const instance of instances) {
        const row = resources[instance.resource_type];
        if (!row) continue;
        row.total++;
        row[instance.state]++;
        if (instance.verdict) row.verdicts[instance.verdict] = (row.verdicts[instance.verdict] ?? 0) + 1;
      }

      const users = [...new Set(delivered.map((claim) => claim.user_id))];
      const participants = await Promise.all(
        users.map(async (userId) => ({
          user_id: userId,
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
        const value = await resourceValue(instance, t.runtime.resources, t.resourceTypes);
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
        const projected = await project(await resourceValue(instance, t.runtime.resources, t.resourceTypes), decl, viewer);
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

/** Les chemins générés ne doivent croiser aucun geste du template. */
export function generatedPathConflicts(lanes: readonly LaneModel[], declared: readonly string[]): string[] {
  const generated = new Set<string>(GENERATED_PATHS);
  for (const lane of lanes) generated.add(`${lane.id}/release`);
  return declared.filter((path) => generated.has(path));
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
