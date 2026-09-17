# Template Parity — Gap Analysis

**What it would take to run the hand-written flows (`ml`, `code`, `endpoint-validation`, `journey-validation`) as `leaderboardos/1` templates**

Draft — September 2026. Companions: `interpreter-design-note.md` (the format, the validator, the compiler), `templates-in-db-design-note.md`, `spec-graph-editor.md`, `template-author-design-note.md`. Sources: the code as of branch `challenge-022-graph-editor` (commit `f71fe2d`); file references are relative to the repository root.

---

## 0. Summary

Two flows already run from templates: `data-annotation` (flipped, J4) and `endpoint-check` (new endpoint validations, parity with `endpoint-validation` proven in J5). The other three hand-written flows cannot be reproduced exactly today.

| Flow | Reproducible today | Main blockers |
|---|---|---|
| `ml` | Steps, caps, pool clamp | AI grading and Kaggle reads not bound at runtime; best-of-challenge bonus; reuse credit transfers; groups; first-submitter ownership |
| `code` | Repo URL submission, simple pay | AI grading not bound; pay-the-delta; task board; GitHub branch provisioning; groups; async evaluation |
| `endpoint-validation` | Yes, as `endpoint-check` | Residual: admin deletions, managers' evidence view, two edge behaviors to compare |
| `journey-validation` | Steps created by admin, pay on completion | Updating/deleting resources; multi-request draft walkthrough; field reserved to a qualification; platform-role access; groups |

**Blocking finding.** `assess: {kind: ai_grid}` validates and compiles, but no evaluation binding is installed at runtime: `defaultRuntime` throws `no evaluation binding installed for grid …` (`packages/interpreter/compile/runtime.ts:204-208`). Likewise `github_fetch` and `kaggle_metadata` are marked `v1: true` in the catalog (`packages/interpreter/catalog.ts`) but only `http_proxy` is bound (`runtime.ts:209-214`). A template using them publishes, then fails on its first gesture — and the template author agent advertises them as executable.

---

## 1. `ml` — the flow as it runs

Sources: `content/flows/ml/reward.ts`, `packages/database-service/domain/mlRewardRules.ts`, `packages/services/challenge/ml-rewards.service.ts`, `packages/services/challenge/lineage.ts`, `docs/ml-rewards.md`.

### 1.1 Rules (`DEFAULT_ML_REWARD_RULES`)

| Rule | Default |
|---|---|
| `dataset.cap` | 300 |
| `model.cap` | 500, of which `kaggleShare` 0.5 for the metric |
| `model.metric` | `auc` (or `f1`, `accuracy`), `baseline` 0.5, optional `blockThreshold` |
| `model.beatBestBonus` | 50 |
| `apiPackaging.cap` | 200 |
| `reuse` | `datasetShare` 0.2, `modelShare` 0.2, `minKeepShare` 0.5 |

### 1.2 Steps and pay

Four repos are provisioned at creation (`content/flows/ml/repos.ts`): Kaggle dataset, Kaggle model, GitHub model code, and GitHub API.

1. **Dataset** (Kaggle URL) — AI grid, pays `dataset.cap × score`. A URL belongs to whoever submitted it first in the challenge; pasting someone else's URL is a reuse: no agent call, **0 points** (`ml-rewards.service.ts:143`).
2. **Model metric** (Kaggle URL) — reads the metric of the latest model version that reports it (`ml-rewards.service.ts:285-296`). `normalized = clamp((value − baseline) / (1 − baseline), 0, 1)`, pays `model.cap × kaggleShare × normalized`.
   - **Beat-best bonus** (`reward.ts` `takesTheLead`): `beatBestBonus` when `normalized > 0`, the value is above the best of every *other* contributor, and the contributor was not already leading. Never revoked; can fire again when the lead changes hands.
3. **Model code** (GitHub) — `code` grid, pays `model.cap × (1 − kaggleShare) × score`.
4. **API packaging** (GitHub) — `code` grid, pays `apiPackaging.cap × score`.

### 1.3 Pool, reuse, groups

- **Pool** — each award is clamped to the remaining pool, in arrival order; the clamp comes before the reuse splits.
- **Reuse credit** — on model-step awards only (`model_metric`, `model_code`, `beat_best`):
  - the contributor attaches datasets to their model build (`workspace_meta.datasetUrls`); each weighs `1/N`;
  - for each dataset first submitted by someone else: debit `award × datasetShare × 1/N` from the contributor, credit it to that author;
  - if the model URL was first submitted by someone else: debit `award × modelShare`, credited to that author;
  - the contributor always keeps at least `minKeepShare` of the award;
  - transfers do not consume the pool (debit + credit sum to zero).
- **Groups** — the award is multiplied by the group bonus then split; the reuse base excludes the group bonus.
- **Limitations** — metrics are self-reported on the Kaggle card; concurrent submissions can race on the pool and on the best score.

### 1.4 Reproducible as a template v1?

| Rule | Verdict |
|---|---|
| Four steps, caps, pool clamp | Yes |
| AI grading (dataset, code, API) | **No until the evaluation binding exists** |
| Kaggle metric read | **No until `kaggle_metadata` is bound**; its output is `dyn`, so the metric path is not type-checked |
| First submitter owns a URL, reuse accepted with 0 points | No — `match-or-create` is not compiled in v1 (`validate/analyze.ts:364, 933`) |
| Beat-best bonus, `blockThreshold` | No — counters are per participant; an aggregate resolves over one resource, never a challenge-wide maximum |
| Reuse credit transfers with `1/N` weights and floor | No — a reward can pay someone else (`to:`), but not an off-pool debit/credit pair with a floor |
| Dataset selection (list of references) | To verify |
| Groups | No — `group participation` is not compiled in v1 (`analyze.ts:591`) |

### 1.5 Description for "Describe a flow"

```
ML challenge in four steps, open to everyone. Every award is paid immediately from the pool and clamped to what remains, in arrival order.

Params (all editable after creation): pool; dataset_cap = 300; model_cap = 500; kaggle_share = 0.5; metric = auc; baseline = 0.5; beat_best_bonus = 50; api_cap = 200; reuse_dataset_share = 0.2; reuse_model_share = 0.2; min_keep_share = 0.5.

1. Dataset — a contributor submits a Kaggle dataset URL. A URL belongs to whoever submitted it first in this challenge. If the URL was already submitted by someone else, it is a reuse: no AI scoring and no points for this step. Otherwise an AI grid (grid "dataset") scores it 0–1 and pays dataset_cap × score.
2. Model metric — a contributor submits a Kaggle model URL and selects the datasets the model was built on (their own and/or other contributors' datasets). The platform reads the AUC of the latest model version that reports it. normalized = clamp((auc − baseline) / (1 − baseline), 0, 1); pay model_cap × kaggle_share × normalized. If normalized > 0 and the AUC is strictly above the best AUC reached by every other contributor, and this contributor was not already the leader, also pay beat_best_bonus (never taken back; it can fire again when the lead changes hands).
3. Model code — a GitHub repository of the training code, scored by an AI grid (grid "code"), pays model_cap × (1 − kaggle_share) × score.
4. API packaging — a GitHub repository packaging the model as an API, scored by the "code" grid, pays api_cap × score.

Reuse credit, on every model-step award (metric, bonus, code): for each selected dataset authored by someone else, take award × reuse_dataset_share × (1 / number of selected datasets) from the contributor and credit it to that dataset's first author; if the model URL was first submitted by someone else, take award × reuse_model_share and credit it to that model's first author. Reusing your own artifact takes nothing. The contributor always keeps at least min_keep_share of the award. These transfers do not consume the pool.
```

With today's format the agent will cover the steps, caps and grading, and turn the bonus, the reuse credit and the groups into open questions or approximations — read "Choices made" closely.

---

## 2. `code` — the flow as it runs

Sources: `content/flows/code/**`, `packages/services/challenge/code-rewards.service.ts`, `packages/capabilities/{board,evaluation,bundle,pool,groups}.ts`, `packages/provisioner/src/index.ts`, `content/workspace-providers/github-branch/provider.ts`, `content/bundle-sources/github-snapshot/index.ts`, `packages/evaluator/openai/evaluate.agent.ts`, `apps/leaderboard-client/src/app/api/challenges/**`, `apps/leaderboard-client/src/app/api/tasks/**`.

### 2.1 Declaration (`content/flows/code/index.ts`)

- Rule keys `code_fixed` and `code_quality`, both consuming the pool.
- Contribution type `project`, deliverable capability `deployed_app`.
- `uses: {board: true, groups: true}`.
- Hooks `onCreate` (repos), `onJoin` (`provisionWorkspace`) and `onGroupJoin` (`reprotectGroupBranch`); no `onClose`, no jobs.
- Actions: `PATCH workspace` (members) and `POST project-evaluation` (any signed-in user).
- Event `evaluation.requested`, feeding the onboarding quest.
- Proposable from sandboxes.

### 2.2 Creation

- **Access** — admin, or the manager of the project (`api/challenges/route.ts:103-108`). `docs/auth.md` says managers cannot create challenges; the code allows it.
- **Pool** — `contribution_points_reward`.
- **`reward_rules`** — `{version: 1, delivery: {fixed, cap}}`. `DEFAULT_CODE_REWARD_RULES = {fixed: 25, cap: 75}` exists only in the UI form; the server applies no default, and a challenge without rules cannot be evaluated (`no_rules`).
- **`workspace_mode`**:
  - `provided_repo` (default) creates one repo link from `github_repo` (`repos.ts:18-23`), with no GitHub call at creation;
  - `own_repo` creates no repo.
- **Template tasks** — `user_id NULL`, flushed after save.

### 2.3 Join (`api/challenges/[id]/join/route.ts`)

**Refusals**:
- 401 without a session;
- 403 when the challenge is `completed` or `archived` (`draft` is not blocked);
- 409 when already a participant;
- 400 for a group on a flow without groups.

**Joining a group**: up to 3 members (soft cap), no board copy, no provisioning; runs `reprotectGroupBranch`.

**Solo join, or creating a group**:
- copies every template task as `todo` on the joiner's board (`board.ts:35-60`);
- runs `provisionWorkspace` (`hooks.ts:36-78`):
  - in `own_repo`, it sets `workspace_provider: external`;
  - in `provided_repo`:
    - it creates branch `contrib/<index padded to 3>-<username slug>` from the challenge branch or `main`, or reuses it if it exists;
    - it stores `workspace_ref`, `workspace_url` and `workspace_status`;
    - it protects the branch for the user's GitHub username;
    - any failure leaves `workspace_status: failed`. **No route or job re-provisions it.**

### 2.4 Tasks board (`/api/tasks`)

- **Statuses** — `todo | in_progress | done`. Tasks never influence the score; they only gate the evaluation.
- **Ownership** — the board belongs to the group holder. Members and admins can edit personal tasks; admins and managers edit template tasks.
- **Concurrency** — conditional updates (`from_status`) return 409 on conflict.
- **Deletion** — deletes one row; subtasks become orphans (no FK).
- **No status check** — tasks can be edited on a closed challenge.

### 2.5 Workspace (`own_repo`) — `PATCH flow/workspace`

- Members only.
- `repo_url` must match `^https://github.com/<owner>/<repo>` (prefix match); visibility is not checked.
- Written on the holder's row as `external` and `ready`; changeable any number of times.

### 2.6 Launching the evaluation — `POST flow/project-evaluation`

`canEvaluate` (`code-rewards.service.ts:125-160`), in order:

| # | Condition | Reason |
|---|---|---|
| 1 | Not a `code` challenge | `not_code_challenge` |
| 2 | Status `completed` or `archived` | `challenge_closed` |
| 3 | No readable rules | `no_rules` |
| 4-5 | Caller or holder not a participant | `not_participant` |
| 6 | Workspace not ready (`external` needs a URL, otherwise `ready`) | `workspace_not_ready` |
| 7 | No personal task (subtasks and orphans counted) | `no_tasks` |
| 8 | Not every task `done` | `tasks_not_done` |
| 9 | A run `running` for less than 30 minutes | `already_running` |

- **Claim** — creates the holder's `project` contribution under an advisory lock if absent, then a compare-and-set to `running`.
- **Responses** — 409 for `already_running`, 400 for other refusals, 202 on success. The run is fire-and-forget.
- **No limits** — no cooldown and no cap on relaunches; re-evaluation is unlimited once the board is done again.
- **Unparseable `own_repo` URL** — a URL with an unparseable suffix (e.g. `/pulls`) passes the PATCH but fails the claim with `workspace_not_ready`.

### 2.7 Evaluation

1. **Run and record** — records an `evaluation_runs` row; loads the published `code` grid from the database.
2. **Snapshot** (`github-snapshot`) — the first 100 commits (newest first) of the branch. For each changed file:
   - not removed, text extension, not binary;
   - last-write-wins over a newest-first list, so the blob kept is the one from the **oldest** commit touching the file.
3. **Agent** — 3 attempts. OpenAI `gpt-5.6-luna`, tool loop on `gpt-5-nano`, one `read_file` tool. Output `{scores: [{criterion, score 0-9, comment}]}`.
   - Weights by index: `category.weight / subcriteria count`; scores beyond the criteria count weigh 1.
   - `globalScore = Σ score × weight`.
   - `score10 = clamp(globalScore / 9 × 10, 0, 10)`.
4. **Grid `code`** — 15 criteria in 6 categories; seed weights sum to 0.97, so the maximum `score10` is 9.7.
5. **Stored** — `contributions.evaluation = {scores, globalScore}`, `evaluation_status` `running → done | failed`.
6. **Closed challenge** — a run in flight when the challenge closes still pays.

### 2.8 Pay (`content/flows/code/reward.ts` `computeCodeAward`)

```
multiplier  = 1 + 0.4 × (min(max(1, group size), 3) − 1)     # 1 / 1.4 / 1.8
raw_fixed   = round(fixed × multiplier)
raw_quality = round(cap × score10 × multiplier / 10)
for rule in [code_fixed, code_quality]:
    delta  = max(0, raw − already paid for rule)
    points = min(delta, remaining pool)
    write a ledger row if points > 0; remaining pool −= points
```

- **Fixed part** — paid on the first successful run, whatever the score. If the pool clamped it, the rest is paid on a later run.
- **Quality part** — only the positive delta over what was already paid; a lower score pays nothing; nothing is ever clawed back.
- **Raised rules or group size** — the difference is paid on the next run.
- **Group shares** — the run's delta is split equally (floor, the remainder to the holder first), cumulatively on `contribution_members`.
- **Consistency** — no transaction around ledger, shares and status; concurrent runs of different holders can overdraw the pool.

### 2.9 Lifecycle and admin

- **Closed** means `completed` or `archived`.
  - Blocked when closed: join, evaluation launch, group invites.
  - Not blocked: tasks, workspace edits, in-flight runs, admin retry.
- **Closing** — computes and pays nothing. `PUT` can reopen and edit pool, rules, dates, title and slug; `workspace_mode` and the repo are fixed.
- **Groups** — the holder is the member with a `workspace_ref`, else a `workspace_url`, else the lowest `user_id`. Removing a member deletes only the team row.
- **Promotion from a sandbox proposal**:
  - `workspace_mode: own_repo`;
  - the author row pre-filled with the sandbox repo;
  - a `sandbox_rewards` promotion row;
  - **no board copy**, so the author must create at least one task.
- **Admin** — retry of a *failed* run only (`POST /api/evaluation-runs/:id/retry`). It bypasses `canEvaluate` (closed status, board completeness).
- **Not available anywhere** — score override, ledger correction, contribution reset, workspace re-provisioning.
- **Around the flow**:
  - onboarding quests (`task.created`, `evaluation.requested`, `contribution.evaluated`);
  - Slack signals (out of pool);
  - digest;
  - no GitHub webhooks.

### 2.10 Reproducible as a template v1?

| Rule | Verdict |
|---|---|
| Repo URL submission, blocked when closed (`challenge.state == "open"`) | Yes |
| AI grading of the repository | **No until the evaluation binding exists**, and an input "repository snapshot" must be defined |
| Fixed + quality pay clamped to the pool | Yes as a plain payment |
| Pay only the improvement per rule, rest paid later when the pool clamped | Approximable with a "paid so far" counter; not exact when the pool clamps |
| Personal task board copied from the template, gate "every task done" | No |
| Provisioned and protected GitHub branch (`provided_repo`) | No — `github_workspace` is not compiled in v1 |
| Groups (holder, multiplier, shares) | No |
| One run at a time, 30-minute stale takeover, admin retry of failed runs | No — the engine has no asynchronous evaluation |
| Promotion from a sandbox, onboarding quests | No — outside the format |

---

## 3. `endpoint-validation` — the flow as it runs

Retired: no new challenge can be created (`api/challenges/route.ts:121-123`); it serves existing challenges. New endpoint validations run on the `endpoint-check` template. Sources: `content/flows/endpoint-validation/**`, `content/kits/validation/**`, `packages/services/challenge/{reference-case,validation-challenge}.service.ts`, `packages/capabilities/http-proxy/**`.

### 3.1 Configuration and actors

- **Config**:
  - `cp_per_validation` int > 0;
  - `required_validations` int > 0 and odd;
  - `reviewer_qualification` (MyTwin default `medical_pro`);
  - source challenge required, one validation challenge of a kind per source (409).
- **Admin / project manager** — exposes and removes targets, sees all cases, inputs, runs and the works/broken split.
- **Qualified reviewer** — authors cases, claims, observes, reveals, votes; no membership needed.
- **Status** — no action checks the challenge status: everything keeps working after close.

### 3.2 Steps

1. **Expose a target** (`POST targets`, managers):
   - `{contribution_id, live_endpoint_url}` on an `api_packaging` contribution of the source challenge;
   - SSRF guard (public http(s) only);
   - 409 when already exposed;
   - writes `live_endpoint_url` on the source contribution.
2. **Author a reference case** (`POST reference-cases`, reviewers):
   - multipart `input` + `expected_output`, 25 MiB each;
   - quota = `required_validations` **cases for the whole challenge**. It is read then inserted, so concurrent posts can exceed it; deleting an unclaimed case frees a slot.
3. **Claim + probe** (`POST targets/:id/claim`):
   - refused for your own submission (403) or your own case (403); 410 on a purged case;
   - probes the endpoint: multipart field `file`, 15 s timeout, no redirects, 10 MiB response cap;
   - failures → 502 and no claim. **4xx/5xx responses are stored as a valid claim**;
   - one claim per (case, target) for all reviewers; no TTL, no release.
4. **Observation** (`POST case-claims/:id/observation`) — once, never edited (409 if repeated).
5. **Reveal** (`POST case-claims/:id/reveal`) — requires the observation (400); returns the expected output; idempotent.
6. **Verdict** (`POST verdicts`):
   - `works | broken` + description;
   - requires a revealed claim of the caller on this target;
   - one verdict per reviewer per target (409).

### 3.3 Resolution and pay

- **Resolution** — when the verdict count reaches `required_validations` on a pending target: `works` if `works × 2 > count`, else `broken`.
  - A tie after a race (even count) resolves to `broken`.
  - Permanent; no reset path.
- **Late verdicts** — recorded, unpaid.
- **Pay** — every majority verdict, earliest first, `min(cp_per_validation, remaining pool)`, rule key `validation`, on the validator's `validation` contribution. The minority and the author get nothing.
- **No expiry** — a target without enough verdicts stays pending forever. If one reviewer takes several cases on a target, the quorum can become unreachable.

### 3.4 Visibility, retention, overrides

- **Visibility**:
  - verdict count visible to everyone;
  - outcome visible to everyone once resolved;
  - works/broken split only to managers, before and after resolution;
  - the endpoint URL is never sent to reviewers;
  - the expected output only through the reveal.
- **Retention** — daily job at 05:00 UTC purges claim responses and case bytes of challenges closed more than 12 months ago; verdicts and CP are kept.
- **Overrides** — none. No verdict change, reopen, withdrawal or clawback; admins can only delete an unclaimed case and remove a target without verdicts.

### 3.5 Parity with `endpoint-check`

Parity was proven in J5 (browser smoke test). Residual gaps:
- **Admin deletions** — of an unclaimed case, and of a target without verdicts: the format has no delete action.
- **Managers' evidence view** — `GET runs`, input and response bytes per verdict.
- **To compare** — 4xx/5xx probe responses accepted as claims, and the tie → `broken` rule vs the template's `majority()`.

---

## 4. `journey-validation` — the flow as it runs

Sources: `content/flows/journey-validation/**`, `packages/services/challenge/{scenario-steps,scenario-walkthrough}.service.ts`, `content/kits/validation/**`. **The canonical `journey-validation.yaml` of the conformance corpus is not this flow**: it resolves a quorum by majority, production does not.

### 4.1 Configuration and actors

- **Config**:
  - `cp_per_validation` int > 0;
  - `eligible_roles` (default `["contributor", "admin"]`);
  - `expert_comment_qualification` (MyTwin default `medical_pro`);
  - no quorum.
- **Admin / manager** — writes the scenario, exposes apps (`project` contributions of a source code challenge), reads every walkthrough.
- **Validator** — the user's **platform role** is in `eligible_roles`; never on their own app or their group's app.
- **Expert** — a validator holding `expert_comment_qualification` may fill an expert comment.

### 4.2 Scenario

- **Steps** — ordered: `position`, `title`, optional `instructions`. One scenario per challenge, shared by all apps.
- **Editing** — add (appended), edit, reorder (positions renumbered densely), delete (renumbered).
- **Frozen** as soon as any walkthrough exists, draft or completed (409).
- **Visibility** — to every signed-in user.

### 4.3 Walkthrough

- **Open** (`POST scenario-runs`):
  - the target must be exposed, the role eligible, the scenario non-empty;
  - refused on one's own app or one's group's app;
  - returns the existing run if any, including a completed one.
  - One run per (validator, app); no limit on validators; no TTL.
- **Step feedback** (`PUT scenario-runs/:run/steps/:step`):
  - `result: passed | failed | blocked`, optional `comment`, `medical_comment` (non-blank requires the qualification, else 403);
  - upsert per (run, step): revisiting overwrites;
  - omitted comments are overwritten with null.
- **Complete** (`POST scenario-runs/:run/complete`):
  - `global_feedback` required;
  - role and own-app checks re-run;
  - every step must have a result (400 with `missingStepIds`);
  - completion is immutable.

### 4.4 Resolution and pay

- **No resolution**: no quorum, no aggregation; the target stays `pending` forever.
- **Pay** — at completion, to the validator, `min(cp_per_validation, remaining pool)`, rule key `validation`. The walkthrough completes even when the pool is empty. Not transactional: concurrent completions can overdraw the pool.

### 4.5 Visibility and overrides

- **Visibility**:
  - the app URL is exposed to every signed-in user (loaded in an iframe);
  - `walkthroughCount` includes drafts;
  - validators see only their own walkthrough;
  - managers see every run with step results, comments, expert opinions and global feedback.
- **Server-side** — no server call to the app, no retention job.
- **Overrides** — none: no edit, reopen or deletion of runs, no unfreezing, no clawback.

### 4.6 Reproducible as a template v1?

| Rule | Verdict |
|---|---|
| Steps created by the admin, apps exposed, pay on completion | Yes |
| "Every step answered" before completing | Probably (count of reports), to verify |
| Scenario frozen once a walkthrough started | Probably (gate on existence), to verify |
| Edit, reorder, delete a step; overwrite a step result | No — resources cannot be updated or deleted |
| Draft walkthrough over several requests, variable number of steps | Not as such — `multi-segment run` is not compiled (`analyze.ts:659`); only the corpus workaround (one lane run per step) |
| Field reserved to a qualification (expert comment) | No — a `when` field is ignored, not refused |
| Access by platform role | No — role access in the format goes through a qualification |
| Exclude the author's group members | No — groups |
| App shown in an iframe | No — the generated UI shows a link |

---

## 5. Consolidated gaps

### Status

| Milestone | Gaps | State |
|---|---|---|
| P1 — runtime bindings | A1, A2 | **Done** (Sept. 17): `packages/interpreter/compile/bindings.ts`; `ai_grid` scores on 0..1 with `snapshot: history \| latest`; `kaggle_metadata` and `github_fetch` typed; a test holds the catalog to its bindings. Verified live: Kaggle read, and a real `dataset` grid evaluation (62 s — synchronous inside the gesture, hence P2). |
| P2 — background evaluation, delta pay | B3, D13 | **Done** (Sept. 17): `assess: {background: true}` (202, one run per participation, 30-min takeover, `continue` retry handler, `<lane>/evaluation` read, generated UI polling); `reward: {basis: delta, meta}`; equivalence with `computeCodeAward` run after run (`packages/interpreter/background.test.ts`). |
| P3 — `code` | B6, D10, E14 (+ flip) | **Done** (Sept. 17): `packages/capabilities/workspaces.ts` (moved out of the code flow); `access.group: true`, `workspace`, `presentation.board`, gate reasons; `content/templates/code` installed in place of the hand-written flow, with continuity. Equivalence: in memory against `computeCodeAward`/`splitShares`, and on Postgres side by side with `CodeRewardsService` (ledger, contributions, shares, completion, refusals). Remaining differences: a non-member launching gets 403 (the code flow: 400 `not_participant`); unreadable rules give 409 (the code flow: 400 `no_rules`); the evaluation route is `POST flow/project_evaluation` (was `project-evaluation`, the panel follows). |
| P4 — `journey-validation`, resource edits | C8, D11, D12 (+ flip) | **Done** (Sept. 17): `act.update`/`act.delete`, `create.upsert`, `ordered_by`, field `optional`/`trim`/`public`, `access.mode: signed_in`, `participation.role`/`.qualified`, link `members`; generated `GET mine` and `GET resources?type=` (managers' browser), app frame and resource tables in the generated UI. `content/templates/journey-validation` installed in place of the hand-written flow, with continuity: `db:migrate-journey-resources` (postdeploy) copies targets, steps, runs and step feedbacks into resources under the same uuids. Equivalence: rules in memory (`template.test.ts`), and on Postgres side by side with `ScenarioStepsService`/`ScenarioWalkthroughService` across a migrated half-done walkthrough (ledger, contributions, steps, walkthroughs, step results). The multi-request run is modeled as resources (a walkthrough, keyed step results), not as `flow_runs`. Remaining differences: a foreign or completed walkthrough, and an unknown step or app, answer 400 (the flow: 403/409/404); an incomplete walkthrough answers 400 with `reason: incomplete` but no `missingStepIds` (the screen marks the unanswered steps itself); an empty edit is a no-op 200 (the flow: 400); blank `instructions` clear the field (the flow: 400); routes are the generated gestures (`apps/expose`, `add_step/new_step`, `open/start`, `record/feedback`, `complete/finish`…): the scenario screens are kept and read them through `apps/leaderboard-client/src/lib/journeyTemplateApi.ts` (with the generated `counts` read and a link's `author_name`); the managers' panel marks as expert a validator who wrote an expert opinion (the flow: who holds the qualification); `live_endpoint_url` is no longer written on the source contribution at exposure (the app URL lives on the `app` resource). |
| P5 — `ml` | B4, B5, C7, C9 (+ flip) | **Done** (Sept. 17): `packages/capabilities/submissions.ts` (the ML workspace PATCH/GET moved to the core, the ML flow delegates), `submissions` declaration and `trigger: submission` lanes, `best`/`best_of_others`/`best_of_mine`, `reward.multiplier`/`transfers`/`record_clamp`/`label`, `optional(...)` record fields and camelCase params. `content/templates/ml` installed in place of the hand-written flow, with continuity (same repos, `workspace_meta`, contributions, ledger keys and meta, `submission` handler); the distribution keeps the flow's `rewards.summarize` (metric timeline, threshold) and sandbox proposal, and the ML screens (same routes). Equivalence: in memory against `computeMlAward` + `resolveLineage` (reuse, lead changes, groups, clamp, floor, failure), and on Postgres side by side with `submitToStep` + `MlRewardsService` (ledger, contributions and statuses, shares, completion, `workspace_meta`, teams, 403/400 refusals). Fixed on the way: `ChallengeRepository.update` re-applied zod defaults (`type: 'code'`, `completion: 0`) to fields the caller did not give. Remaining differences: the Kaggle metric reads the model ref from `artifactOf` (the flow: `extractArtifactRef`); rules missing `kaggleShare`, `baseline` or `minKeepShare` are refused instead of defaulted. |
| P6 — `endpoint-validation` residuals | 3.5 (+ retirement) | **Done** (Sept. 17): guarded `act.delete` (`unclaimed`, `without_inputs`), claims in the managers' `resources` read and claim files for managers; `endpoint-check` gains `withdraw_target`, `withdraw_case` (admins) and `withdraw_own_case` (authors). Decisions, with tests: a 4xx/5xx endpoint answer stays a valid claim (evidence of a broken endpoint); a tie after a race resolves `broken` and pays the broken side (the quorum is `>=`, the verdict a strict majority of works). Retirement with continuity: `db:migrate-endpoint-validation` (postdeploy, one transaction per challenge) copies targets, cases (bytes into blobs), claims, reveals and verdicts into `endpoint-check` resources under the same uuids and switches the challenge type; verified on Postgres by resuming a half-done campaign (the third reviewer votes, the target resolves, the majority is paid) and run on the dev database. Remaining differences: CP already paid stay under the `validation` key, so the template's overview counts only what it pays (`endpoint_check`); a manager (not only an admin) may remove a case; `endpoint-validation` stays installed, retired and serving no challenge, until every environment has migrated. |

### A. Runtime (blocking)

1. **Bind AI grid evaluation** at runtime, and define how a GitHub repository (snapshot) is given to it — `code`, `ml`.
2. **Bind `github_fetch` and `kaggle_metadata`**, and type the Kaggle metric read — `ml`. Align the capability catalog and the template author's grounding with what is actually bound.

### B. Economy

3. **Pay the delta** per rule over what was already paid, including the rest of an award the pool clamped — `code`.
4. **Challenge-wide reads** (best score so far across participants) — `ml` beat-best bonus, `blockThreshold`.
5. **Off-pool transfer** (debit + credit) with a floor and weights — `ml` reuse credit.
6. **Groups**: holder, multiplier, shares, exclusion of members — `code`, `ml`, `journey-validation`.

### C. Resources

7. **First submitter owns an artifact, reuse accepted** (`match-or-create`, already declared not compiled) — `ml`.
8. **Update and delete a resource**: scenario steps, overwritable step results, admin deletions — `journey-validation`, `endpoint-validation`.
9. **Weighted list of references** (selected datasets) — `ml`, to verify.

### D. Run structure

10. **Personal task board** copied from the template, gate on "all done" — `code`.
11. **Multi-request run** with a resumable draft (`multi-segment run`, already declared not compiled) — `journey-validation`.
12. **Field reserved to a qualification; access by platform role** — `journey-validation`.
13. **Asynchronous evaluation**: one run at a time, stale takeover, admin retry — `code`, `ml`.

### E. Around the flow

14. **Provisioned and protected GitHub branch** (`github_workspace`) — `code`.
15. **Promotion from a sandbox proposal, onboarding quest events** — `code`, `ml`.
16. **Specific UI**: kanban board, iframe, score out of 10, managers' evidence view.

### Proposed order

1. **A1–A2** — without them, half of the format is misleading.
2. **B3 + D13** — the `code` flow becomes feasible, except the board and groups.
3. **C8** — `journey-validation` and admin deletions.
4. **B4–B6 + C7** — exact `ml`.
5. **D10, D11, E14** — the largest pieces.

---

## 6. Doc ≠ code discrepancies found on the way

1. **Endpoint probe** — `docs/validation-challenges.md:159,307` says a non-2xx response records no claim. In code only redirects, timeouts, network, SSRF and oversize failures abort; 4xx/5xx create a claim (`packages/capabilities/http-proxy/endpoint-proxy.ts:94-106`).
2. **Reveal before observation** — the doc says 409 (`validation-challenges.md:140`); the code returns 400 (`content/flows/endpoint-validation/actions/claims.ts:52`).
3. **Validation pool** — the doc says it is locked after creation (`validation-challenges.md:93`); `PUT /api/challenges/:id` accepts `contribution_points_reward`.
4. **Reference cases** — "exactly `required_validations` cases" is a non-atomic maximum on the challenge total, with no minimum before claiming.
5. **`distributed` in `GET targets` / `GET rewards`** — sums every ledger row of the challenge; payment uses `distributedFromPool`, which excludes off-pool rule keys.
6. **Challenge creation** — `docs/auth.md` says managers cannot create challenges; `POST /api/challenges` allows the project's manager.
7. **Code rules default** — `DEFAULT_CODE_REWARD_RULES` exists only in the creation form; the server stores `null` and such a challenge cannot be evaluated.
