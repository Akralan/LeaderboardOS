import { checkTemplateSource } from "../interpreter/check.js";
import { DEFAULT_CATALOG, type CapabilityCatalog } from "../interpreter/catalog.js";
import { showType } from "../interpreter/expr/types.js";
import { corpus } from "./corpus.source.js";

/**
 * Le contexte de l'agent auteur (note §0.3)
 * -----------------------------------------
 * Ce que le modèle sait, et rien d'autre : une grammaire condensée de
 * `leaderboardos/1`, le catalogue des capacités que le moteur exécute, les
 * registres vivants qu'un template peut référencer (qualifications, grilles),
 * et le corpus complet — assez petit pour tenir dans le contexte, sans
 * machinerie de recherche. L'agent ne propose que ce que la plateforme sait
 * faire tourner, par construction de ce qu'il lit.
 */

export interface AuthorRegistries {
  /** Les clés de qualification connues : ce qu'un param `role` peut valoir. */
  qualifications: readonly string[];
  /** Les grilles d'évaluation existantes : ce qu'un Assess `ai_grid` peut référencer. */
  grids: readonly { id: string; slug: string; name: string }[];
}

export const GRAMMAR = `
# leaderboardos/1 — condensed grammar

A template is ONE YAML document. Top-level keys, in this order:

format: leaderboardos/1
template: {id: <kebab-case key>, version: <semver>, name: <short name>, summary: <one or two sentences>}
params:            # the configuration surface, set when a challenge is created
  <snake_name>: {type: <type>, mutable: <bool>, default?: <value>, check?: "<expr on value>", checks?: {<message_as_snake_case>: "<expr on value>"}}
requires: {core: 1}
presentation?:     {icon?, long_label?, join_caption?, brief_required?: bool, public?: bool, contribution?: {type: <snake>, title: <text>}}
resources:         # shared work units
  <snake_name>:
    fields: {<field>: {type: <type>, visibility?: [claimant | author | admin | "role(params.x)"], check?, from?, deliverable?, unique?, retention?: {days_after_close: N}}}
    created_by?: [<lane_id>.<act_id>]          # the ACT nodes that create it
    claim?: {mode: exclusive | k_bounded | unique_per | unbounded, k?: <expr>, ttl?: 48h | <expr in hours>, dimensions?: [self, <scope key>]}
    closure?: {by: aggregate | transition | admin_act | [..], verdict?: [<snake>...], permanent?: bool}
    cardinality?: {exactly: <expr>}
counters?:         # derived per-participant stats, updated by assess nodes
  <snake_name>: {type: int | number | ratio | points, lag?: N}
lifecycle?:
  states?: standard | {close_at: <expr>}
  aggregates?:
    - id: <snake>
      over: <resource type>
      per_participation?: 1
      resolve: {when: "<expr on inputs>", verdict?: "<expr>", then?: [ {transition: {...}} | {reward: {...}} ]}
      state_visibility?: {count?: everyone | admin | author, split?: everyone | admin | author}
  on_close?: [ effects ]
lanes:             # at least one
  - id: <snake>
    entry: {trigger: user | admin | cron, access?: {mode: open | role | author_of, role?: params.<role param>, resource?: <type>, runs_per_participation?: N},
            schedule?: "<cron>", over?: {resource: <type>, where?: <expr>, sample?: <expr>}, cursor?: engine}
    nodes: [ <node>, ... ]   # a strict top-down sequence; no cycles

A node is a mapping with exactly ONE family key:
- collect: {id, fields: {<field>: {type, when?: <expr>, check?: <expr>, where?: <expr>}}}      # a form the actor fills
- gate:    {id, all: ["<expr>", ...], refuse?: 403 | 409 | 422}                                 # blocking check
- gate:    {id, branch: [ {when: "<expr>", nodes: [...]}, ..., {else: {nodes: [...]}} ]}        # routing; branches reconverge below the gate
- act:     {id, kind?: effector | observer | grant, ...}
    claim: {resource: <type or ref field like pick.case>, where?: <expr>, scope?: {<key>: <expr>}, substitute?: {resource: <type>, rate: <expr>}}
    create: <type>, from?: <collect id>, many?: {from_file: <expr>}, set?: {<field>: <expr>}
    transition: {resource: <expr>, to: closed | open, verdict?: <expr or word>, from?: <verdict>, resolution?: {<key>: <expr>}}
    grant: {field: <resource field expr>, to: participation}
    capability: <catalog name>, store?: <snake>, <capability args>: <expr>
- assess:  {id, kind: human | metric | ai_grid | self, fields?: {...}, from?: <collect id>, value?: <expr>, grid?: <expr>, input?: [<artifact URL expr>, ...], snapshot?: history | latest,
            emit?: {to: lifecycle.<aggregate id>, scope: <expr of the resource>}, counters?: {<counter>: {add: "<expr>"}}, gating?: bool}
- reward:  {id?, amount: "<expr>" | {reverse: <rule_key>} | {mapping: tiers, tiers, key, match: at_least | equals, input} | {mapping: rank, over, by, order: asc | desc, amounts},
            to?: <expr>, pool?: params.pool, clamp?: pool, order?: commit_time, rule_key?: <snake>}

Types: string int number ratio points bool url file json date duration role capability grid_ref template_ref challenge_ref link,
       "enum(a, b)", "enum(params.x)", "ref(<resource>)", "list(<type>)", "{field: type, ...}" or a YAML mapping.

Expressions are a closed CEL-like subset, always YAML strings when they contain spaces or operators:
  literals, && || ! == != < <= > >= + - * / %, cond ? a : b, lists [..], member a.b, index a[0]
  methods: .map(x, e) .filter(x, e) .exists(x, e) .all(x, e) .size() .trim()
  functions: size count exists majority mode mean min max has age int double string now()
  Enum literals are quoted strings: 'judge.outcome == "failed"'. A bare word is a name.
In scope: params.*, counters.*, challenge.state, participation.user, aggregates.<id>.inputs / .verdict,
  every upstream node by id (collect fields: form.field; claim: draw.<type>, draw.substituted; stored observation: probe.<store>; assess: check.value; ai_grid: grade.score on 0..1),
  in a param check: value; in an aggregate: inputs, verdict.

Conventions that validation enforces:
- ids are lower_snake_case and unique; the template id and keys are kebab-case.
- A template declares exactly one pool param: {type: points, mutable: false}, and rewards write pool: params.pool, clamp: pool.
- A node only reads nodes ABOVE it in its lane.
- created_by names the creating act; an emitting assess needs an aggregate over the same resource.
- Quote flow scalars that contain commas: {type: "enum(works, broken)"}.
`.trim();

function catalogText(catalog: CapabilityCatalog): string {
  const entries = Object.entries(catalog).filter(([, entry]) => entry.v1);
  return entries
    .map(([name, entry]) => `- ${name} (${entry.kind}) args: ${Object.entries(entry.args).map(([arg, spec]) => `${arg}${spec.required ? "" : "?"}`).join(", ") || "none"} → ${showType(entry.output)}`)
    .join("\n");
}

/** Ce que le corpus utilise sans que la v1 le compile : dit au modèle pour qu'il ne le recopie pas. */
function corpusText(): string {
  return corpus
    .map((entry) => {
      const report = checkTemplateSource(entry.yaml, entry.name);
      const gaps = [...new Set(report.gaps.map((gap) => gap.feature))];
      const note =
        entry.origin === "installed"
          ? "installed in production — executable, the most reliable reference"
          : gaps.length
            ? `canonical example — NOT executable in v1 (uses ${gaps.join(", ")}); do not copy those parts`
            : "canonical example — executable";
      return `## ${entry.name} (${note})\n\`\`\`yaml\n${entry.yaml.trim()}\n\`\`\``;
    })
    .join("\n\n");
}

export const RESPONSE_CONTRACT = `
Answer with ONE JSON object and nothing else:
{
  "name": "<short template name>",
  "yaml": "<the complete template YAML>"            // OR, to change an existing document:
  "edits": [ {"op": "set", "path": ["lanes", 1, "nodes", 0, "act", "claim", "resource"], "value": <json value>},
             {"op": "insert", "path": ["lanes", 1, "nodes"], "index": 2, "value": <json value>},
             {"op": "delete", "path": ["params", "unused"]} ],
  "choices": ["every assumption you made that the description did not state, one short sentence each"],
  "open_questions": ["only what was genuinely ambiguous or missing from the platform, one sentence each"]
}
Give "yaml" or "edits", never both. Paths address the YAML document: map keys are strings, sequence positions are numbers.
`.trim();

export function systemPrompt(registries: AuthorRegistries, catalog: CapabilityCatalog = DEFAULT_CATALOG): string {
  const qualifications = registries.qualifications.length ? registries.qualifications.join(", ") : "(none declared)";
  const grids = registries.grids.length ? registries.grids.map((grid) => `${grid.slug} (${grid.name}, id ${grid.id})`).join("; ") : "(none)";
  return [
    "You are the template author of LeaderboardOS. You write challenge templates in the leaderboardos/1 format: YAML documents a validator checks statically and an engine executes.",
    "You produce data, never code. You only use what the grammar, the capability catalog and the registries below provide. You never invent a platform object: a qualification, a grid or a capability that is not listed becomes an open question, not a reference.",
    "Keep templates small and conventional: follow the corpus. Prefer the patterns of the installed templates.",
    GRAMMAR,
    `# Capability catalog (executable in v1 — nothing else may appear in \`capability:\`)\n${catalogText(catalog)}\nWebhook triggers, stake access and spawn_challenge are not executable yet.`,
    `# Platform registries\nQualification keys (a role param's value at challenge creation): ${qualifications}\nEvaluation grids: ${grids}`,
    `# Corpus\n${corpusText()}`,
    RESPONSE_CONTRACT,
  ].join("\n\n");
}
