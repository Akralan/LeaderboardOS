import { flowActionUrl } from '@/lib/challengeActions';
import type { SurfaceLane, TemplateSurface } from '../../../../packages/interpreter/describe';
import type { ScenarioResult } from '@/components/challenges/scenarioResult';
import type { WalkthroughStepView } from '@/components/challenges/scenarioWalkthroughState';

/**
 * Le parcours de scénario, lu et écrit par les routes d'un template
 * -----------------------------------------------------------------
 * Les écrans du scénario (composants `walkthrough`, `targets`, `steps`,
 * `walkthroughs` du catalogue UI) jouent un template dont ils connaissent la
 * forme — des cibles, des étapes ordonnées, une walkthrough par cible qui se
 * ferme sur un retour global, un résultat par étape — mais pas les noms : ce
 * module reçoit les **routes** (types de ressources, chemins des gestes,
 * champs de référence) que `journeyRoutesOf` tire de la surface du template
 * et des arguments du bloc, et traduit les lectures générées (`options`,
 * `mine`, `counts`, `resources`) dans les formes que les écrans manipulent.
 */

export class JourneyApiError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string) {
    super(message);
  }
}

/** Ce qu'un écran du scénario sait du template qu'il joue. */
export interface JourneyRoutes {
  /** Les types de ressources. */
  targets: string;
  steps: string;
  walkthroughs: string;
  results: string;
  /** Les champs de référence : `app` sur une walkthrough, `walkthrough` et `step` sur un résultat. */
  fields: { url: string; contribution: string; walkthroughTarget: string; resultWalkthrough: string; resultStep: string };
  /** Les gestes : le chemin d'un segment (`open/start`) et les champs de ses références. */
  open: { path: string; target: string };
  record: { path: string; walkthrough: string; step: string };
  complete: { path: string; walkthrough: string };
  expose: { path: string; contribution: string; url: string } | null;
  withdraw: { path: string; target: string } | null;
  addStep: { path: string } | null;
  editStep: { path: string; step: string } | null;
  removeStep: { path: string; step: string } | null;
}

/** Le chemin `options` d'un champ : `open/options?field=start.app`. */
function optionsOf(path: string, field: string) {
  const [lane, gesture] = path.split('/');
  return `${lane}/options?field=${gesture}.${field}`;
}

/**
 * Les routes d'un bloc du scénario, résolues sur la surface du template : les
 * ressources par leurs champs de référence, les lanes par leur premier
 * segment. Une chaîne est la raison pour laquelle le bloc ne peut pas jouer.
 */
export function journeyRoutesOf(surface: TemplateSurface, props: Record<string, unknown>): JourneyRoutes | string {
  const text = (name: string) => (typeof props[name] === 'string' ? (props[name] as string) : null);
  const resource = (type: string | null) => (type ? surface.resources.find((candidate) => candidate.type === type) ?? null : null);
  const targetsType = text('targets');
  const stepsType = text('steps');
  const targets = resource(targetsType);
  const steps = resource(stepsType);
  const walkthroughs = targetsType ? surface.resources.find((candidate) => candidate.fields.some((field) => field.kind === 'ref' && field.resource === targetsType)) ?? null : null;
  const results = walkthroughs && stepsType
    ? surface.resources.find((candidate) => candidate.fields.some((field) => field.kind === 'ref' && field.resource === walkthroughs.type) && candidate.fields.some((field) => field.kind === 'ref' && field.resource === stepsType)) ?? null
    : null;

  const lane = (name: string): SurfaceLane | null => {
    const id = text(name);
    return id ? surface.lanes.find((candidate) => candidate.id === id) ?? null : null;
  };
  const segment = (candidate: SurfaceLane | null) => candidate?.segments[0] ?? null;
  const refField = (candidate: SurfaceLane | null, type: string | null) => segment(candidate)?.fields.find((field) => field.kind === 'ref' && field.resource === type)?.name ?? null;
  const kindField = (candidate: SurfaceLane | null, kind: string) => segment(candidate)?.fields.find((field) => field.kind === kind)?.name ?? null;
  const fieldOf = (candidate: { fields: { name: string; kind: string; resource?: string }[] } | null, match: (field: { kind: string; resource?: string }) => boolean) =>
    candidate?.fields.find(match)?.name ?? null;

  const open = lane('open');
  const record = lane('record');
  const complete = lane('complete');
  const expose = lane('expose');
  const withdraw = lane('withdraw');
  const add = lane('add');
  const edit = lane('edit');
  const remove = lane('remove');

  const contributor = 'open' in props || 'record' in props || 'complete' in props;
  const manager = 'expose' in props || 'add' in props;

  if (!targets && targetsType) return `No resource '${targetsType}' on this template.`;
  if (!steps && stepsType) return `No resource '${stepsType}' on this template.`;
  if (targetsType && !walkthroughs && !manager) return `No resource refers to '${targetsType}': nothing records a walkthrough.`;
  if (contributor && (!open || !record || !complete)) return 'The open, record and complete lanes must exist on this template.';

  const openTarget = refField(open, targetsType);
  const recordWalkthrough = walkthroughs ? refField(record, walkthroughs.type) : null;
  const recordStep = refField(record, stepsType);
  const completeWalkthrough = walkthroughs ? refField(complete, walkthroughs.type) : null;
  if (contributor && (!openTarget || !recordWalkthrough || !recordStep || !completeWalkthrough)) {
    return 'The open lane picks an app, the record lane a walkthrough and a step, the complete lane a walkthrough.';
  }

  return {
    targets: targetsType ?? '',
    steps: stepsType ?? '',
    walkthroughs: walkthroughs?.type ?? '',
    results: results?.type ?? '',
    fields: {
      url: fieldOf(targets, (field) => field.kind === 'url') ?? 'app_url',
      contribution: fieldOf(targets, (field) => field.kind === 'link') ?? 'contribution',
      walkthroughTarget: fieldOf(walkthroughs, (field) => field.kind === 'ref' && field.resource === targetsType) ?? 'app',
      resultWalkthrough: fieldOf(results, (field) => field.kind === 'ref' && field.resource === walkthroughs?.type) ?? 'walkthrough',
      resultStep: fieldOf(results, (field) => field.kind === 'ref' && field.resource === stepsType) ?? 'step',
    },
    open: { path: segment(open)?.path ?? '', target: openTarget ?? '' },
    record: { path: segment(record)?.path ?? '', walkthrough: recordWalkthrough ?? '', step: recordStep ?? '' },
    complete: { path: segment(complete)?.path ?? '', walkthrough: completeWalkthrough ?? '' },
    expose: expose && segment(expose) ? { path: segment(expose)!.path, contribution: kindField(expose, 'link') ?? 'contribution', url: kindField(expose, 'url') ?? 'app_url' } : null,
    withdraw: withdraw && segment(withdraw) ? { path: segment(withdraw)!.path, target: refField(withdraw, targetsType) ?? 'app' } : null,
    addStep: add && segment(add) ? { path: segment(add)!.path } : null,
    editStep: edit && segment(edit) ? { path: segment(edit)!.path, step: refField(edit, stepsType) ?? 'step' } : null,
    removeStep: remove && segment(remove) ? { path: segment(remove)!.path, step: refField(remove, stepsType) ?? 'step' } : null,
  };
}

interface Linked {
  id: string;
  author: string;
  author_name: string | null;
  title: string | null;
  url: string | null;
  members: string[];
}

interface Ref { id: string }

interface Instance<F> {
  id: string;
  author: string | null;
  author_name: string | null;
  open: boolean;
  verdict: string | null;
  resolution: Record<string, unknown> | null;
  created_at: string;
  fields: F;
}

export interface JourneyStep { id: string; position: number; title: string; instructions: string | null }

export interface JourneyApp {
  id: string;
  contributionId: string;
  submitterUserId: string | null;
  submitterName: string;
  endpointUrl: string | null;
}

async function send<T>(challengeId: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(flowActionUrl(challengeId, path), body === undefined
    ? undefined
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new JourneyApiError(typeof data.error === 'string' ? data.error : `Request failed (${res.status})`, res.status, data.reason);
  return data as T;
}

const appOf = (id: string, contribution: Linked | null, appUrl: string | null): JourneyApp => ({
  id,
  contributionId: contribution?.id ?? '',
  submitterUserId: contribution?.author ?? null,
  submitterName: contribution?.author_name ?? contribution?.title ?? 'Unknown',
  endpointUrl: appUrl ?? contribution?.url ?? null,
});

/** Une instance de cible, telle que `resources` ou `options` la rendent : son lien et son URL, sous les noms du template. */
function appFrom(routes: JourneyRoutes, id: string, fields: Record<string, unknown>): JourneyApp {
  const contribution = fields[routes.fields.contribution];
  const url = fields[routes.fields.url];
  return appOf(id, contribution && typeof contribution === 'object' ? (contribution as Linked) : null, typeof url === 'string' ? url : null);
}

const byPosition = <S extends { position: number }>(steps: S[]) => [...steps].sort((a, b) => a.position - b.position);

// ── Validateur ───────────────────────────────────────────────────────────────

/** Les applications exposées, telles qu'un validateur peut les ouvrir. */
export async function listApps(challengeId: string, routes: JourneyRoutes): Promise<JourneyApp[]> {
  const { options } = await send<{ options: ({ id: string } & Record<string, unknown>)[] }>(challengeId, optionsOf(routes.open.path, routes.open.target));
  return options.map((option) => appFrom(routes, option.id, option));
}

/** Le scénario, dans son ordre : lisible de tout compte connecté. */
export async function listSteps(challengeId: string, routes: JourneyRoutes): Promise<JourneyStep[]> {
  const { options } = await send<{ options: JourneyStep[] }>(challengeId, optionsOf(routes.record.path, routes.record.step));
  return byPosition(options.map(({ id, position, title, instructions }) => ({ id, position, title, instructions: instructions ?? null })));
}

/** Combien de walkthroughs chaque application compte, brouillons compris. */
export async function walkthroughCounts(challengeId: string, routes: JourneyRoutes): Promise<Record<string, number>> {
  return (await send<{ counts: Record<string, number> }>(challengeId, `counts?type=${routes.walkthroughs}&by=${routes.fields.walkthroughTarget}`)).counts;
}

interface MyWalkthrough { id: string; target: Ref | null; open: boolean; created_at: string; resolution: Record<string, unknown> | null }
interface MyStepResult { id: string; walkthrough: Ref | null; step: Ref | null; result: ScenarioResult; comment: string | null; medical_comment: string | null }

/** Ce que l'appelant a créé : ses walkthroughs et ses retours d'étape. */
export async function mine(challengeId: string, routes: JourneyRoutes): Promise<{ walkthroughs: MyWalkthrough[]; results: MyStepResult[] }> {
  const { resources } = await send<{ resources: Record<string, (Record<string, unknown> & { id: string; open: boolean; created_at: string; resolution: Record<string, unknown> | null })[]> }>(challengeId, 'mine');
  const walkthroughs = (resources[routes.walkthroughs] ?? []).map((row) => ({
    id: row.id,
    target: (row[routes.fields.walkthroughTarget] as Ref | null) ?? null,
    open: row.open,
    created_at: row.created_at,
    resolution: row.resolution,
  }));
  const results = (resources[routes.results] ?? []).map((row) => ({
    id: row.id,
    walkthrough: (row[routes.fields.resultWalkthrough] as Ref | null) ?? null,
    step: (row[routes.fields.resultStep] as Ref | null) ?? null,
    result: row.result as ScenarioResult,
    comment: (row.comment as string | null) ?? null,
    medical_comment: (row.medical_comment as string | null) ?? null,
  }));
  return { walkthroughs, results };
}

export interface WalkthroughState {
  runId: string;
  completed: boolean;
  globalFeedback: string | null;
  steps: WalkthroughStepView[];
}

/** L'état d'une walkthrough : le scénario, et ce que j'ai répondu à chaque étape. */
export async function walkthroughState(challengeId: string, routes: JourneyRoutes, runId: string): Promise<WalkthroughState> {
  const [steps, own] = await Promise.all([listSteps(challengeId, routes), mine(challengeId, routes)]);
  const run = own.walkthroughs.find((walkthrough) => walkthrough.id === runId);
  const answers = new Map(own.results.filter((result) => result.walkthrough?.id === runId).map((result) => [result.step?.id, result]));
  return {
    runId,
    completed: run ? !run.open : false,
    globalFeedback: typeof run?.resolution?.global_feedback === 'string' ? run.resolution.global_feedback : null,
    steps: steps.map((step) => {
      const answer = answers.get(step.id);
      return {
        stepId: step.id,
        position: step.position,
        title: step.title,
        instructions: step.instructions,
        result: answer?.result ?? null,
        comment: answer?.comment ?? null,
        medicalComment: answer?.medical_comment ?? null,
      };
    }),
  };
}

/** Ouvre ma walkthrough sur cette application, ou rend celle que j'ai déjà (terminée comprise). */
export async function openWalkthrough(challengeId: string, routes: JourneyRoutes, appId: string): Promise<string> {
  const { created } = await send<{ created: Record<string, string> }>(challengeId, routes.open.path, { [routes.open.target]: appId });
  const id = Object.values(created)[0];
  if (!id) throw new JourneyApiError('The walkthrough was not created', 500);
  return id;
}

export async function saveStep(challengeId: string, routes: JourneyRoutes, runId: string, step: Pick<WalkthroughStepView, 'stepId' | 'result' | 'comment' | 'medicalComment'>): Promise<void> {
  await send(challengeId, routes.record.path, {
    [routes.record.walkthrough]: runId,
    [routes.record.step]: step.stepId,
    result: step.result,
    comment: step.comment,
    medical_comment: step.medicalComment,
  });
}

export async function completeWalkthrough(challengeId: string, routes: JourneyRoutes, runId: string, globalFeedback: string): Promise<number> {
  const { cp_awarded } = await send<{ cp_awarded: number }>(challengeId, routes.complete.path, { [routes.complete.walkthrough]: runId, global_feedback: globalFeedback });
  return cp_awarded;
}

// ── Managers ─────────────────────────────────────────────────────────────────

async function resources<F>(challengeId: string, type: string): Promise<Instance<F>[]> {
  return (await send<{ instances: Instance<F>[] }>(challengeId, `resources?type=${type}`)).instances;
}

export interface ManagedScenario { steps: JourneyStep[]; frozen: boolean }

/** Le scénario pour son éditeur : ses étapes, et s'il est gelé (une walkthrough existe). */
export async function managedScenario(challengeId: string, routes: JourneyRoutes): Promise<ManagedScenario> {
  const [steps, walkthroughs] = await Promise.all([
    resources<{ position: number; title: string; instructions: string | null }>(challengeId, routes.steps),
    routes.walkthroughs ? resources(challengeId, routes.walkthroughs) : Promise.resolve([]),
  ]);
  return {
    steps: byPosition(steps.map((step) => ({ id: step.id, position: step.fields.position, title: step.fields.title, instructions: step.fields.instructions ?? null }))),
    frozen: walkthroughs.length > 0,
  };
}

const unavailable = (what: string) => Promise.reject(new JourneyApiError(`This template has no lane to ${what}`, 400));

export const addStep = (challengeId: string, routes: JourneyRoutes, title: string, instructions: string | null) =>
  routes.addStep ? send(challengeId, routes.addStep.path, { title, ...(instructions ? { instructions } : {}) }) : unavailable('add a step');

export const editStep = (challengeId: string, routes: JourneyRoutes, stepId: string, patch: Record<string, unknown>) =>
  routes.editStep ? send(challengeId, routes.editStep.path, { [routes.editStep.step]: stepId, ...patch }) : unavailable('edit a step');

export const removeStep = (challengeId: string, routes: JourneyRoutes, stepId: string) =>
  routes.removeStep ? send(challengeId, routes.removeStep.path, { [routes.removeStep.step]: stepId }) : unavailable('remove a step');

export interface ManagedRun {
  id: string;
  contributionId: string;
  submitterName: string;
  endpointUrl: string | null;
  validatorId: string;
  validatorName: string;
  isExpert: boolean;
  expertLabel: string | null;
  completedAt: string | null;
  globalFeedback: string | null;
  answeredCount: number;
  stepFeedbacks: { stepId: string; result: ScenarioResult; comment: string | null; medicalComment: string | null }[];
}

/** Toutes les walkthroughs, avec leurs retours dans l'ordre du scénario : le panneau de supervision. */
export async function managedRuns(challengeId: string, routes: JourneyRoutes): Promise<{ steps: JourneyStep[]; runs: ManagedRun[] }> {
  const [scenario, apps, walkthroughs, results] = await Promise.all([
    managedScenario(challengeId, routes),
    resources<Record<string, unknown>>(challengeId, routes.targets),
    resources<Record<string, unknown>>(challengeId, routes.walkthroughs),
    resources<Record<string, unknown>>(challengeId, routes.results),
  ]);
  const appsById = new Map(apps.map((app) => [app.id, appFrom(routes, app.id, app.fields)]));
  const order = new Map(scenario.steps.map((step, index) => [step.id, index]));
  return {
    steps: scenario.steps,
    runs: walkthroughs.map((run) => {
      const target = run.fields[routes.fields.walkthroughTarget] as Ref | null;
      const app = target ? appsById.get(target.id) : undefined;
      const feedbacks = results
        .filter((result) => (result.fields[routes.fields.resultWalkthrough] as Ref | null)?.id === run.id)
        .sort((a, b) => (order.get((a.fields[routes.fields.resultStep] as Ref | null)?.id ?? '') ?? 0) - (order.get((b.fields[routes.fields.resultStep] as Ref | null)?.id ?? '') ?? 0))
        .map((result) => ({
          stepId: (result.fields[routes.fields.resultStep] as Ref | null)?.id ?? '',
          result: result.fields.result as ScenarioResult,
          comment: (result.fields.comment as string | null) ?? null,
          medicalComment: (result.fields.medical_comment as string | null) ?? null,
        }));
      return {
        id: run.id,
        contributionId: app?.contributionId ?? '',
        submitterName: app?.submitterName ?? 'Unknown',
        endpointUrl: app?.endpointUrl ?? null,
        validatorId: run.author ?? '',
        validatorName: run.author_name ?? 'Unknown',
        // Seul un validateur qualifié peut écrire un avis expert : en avoir écrit un le désigne.
        isExpert: feedbacks.some((feedback) => Boolean(feedback.medicalComment)),
        expertLabel: null,
        completedAt: run.open ? null : run.created_at,
        globalFeedback: typeof run.resolution?.global_feedback === 'string' ? run.resolution.global_feedback : null,
        answeredCount: feedbacks.length,
        stepFeedbacks: feedbacks,
      };
    }),
  };
}

export interface ManagedTarget {
  id: string;
  contributionId: string;
  submitterName: string;
  verdictCount: number;
  outcome: 'pending' | 'works' | 'broken';
  walkthroughCount?: number;
}

/** Les applications exposées et, pour l'éditeur, le travail déjà fait sur chacune. */
export async function managedApps(challengeId: string, routes: JourneyRoutes): Promise<ManagedTarget[]> {
  const [apps, counts] = await Promise.all([
    resources<Record<string, unknown>>(challengeId, routes.targets),
    routes.walkthroughs ? walkthroughCounts(challengeId, routes).catch(() => ({}) as Record<string, number>) : Promise.resolve({} as Record<string, number>),
  ]);
  return apps.map((app) => {
    const view = appFrom(routes, app.id, app.fields);
    return { id: app.id, contributionId: view.contributionId, submitterName: view.submitterName, verdictCount: 0, outcome: 'pending', walkthroughCount: counts[app.id] ?? 0 };
  });
}

/** Les soumissions du challenge source encore exposables. */
export async function eligibleApps(challengeId: string, routes: JourneyRoutes): Promise<{ contributionId: string; userId: string; userName: string }[]> {
  if (!routes.expose) return [];
  const { options } = await send<{ options: Linked[] }>(challengeId, optionsOf(routes.expose.path, routes.expose.contribution));
  return options.map((option) => ({ contributionId: option.id, userId: option.author, userName: option.author_name ?? option.title ?? 'Unknown' }));
}

export const exposeApp = (challengeId: string, routes: JourneyRoutes, contributionId: string, appUrl: string) =>
  routes.expose ? send(challengeId, routes.expose.path, { [routes.expose.contribution]: contributionId, [routes.expose.url]: appUrl }) : unavailable('expose an app');

export const withdrawApp = (challengeId: string, routes: JourneyRoutes, appId: string) =>
  routes.withdraw ? send(challengeId, routes.withdraw.path, { [routes.withdraw.target]: appId }) : unavailable('withdraw an app');

/** L'état du pool et ce que chaque validateur a gagné, noms compris. */
export async function poolState(challengeId: string): Promise<{ pool: number; distributed: number; remaining: number; breakdown: { userId: string; points: number }[] } | null> {
  const res = await fetch(`/api/challenges/${challengeId}/rewards`);
  return res.ok ? res.json() : null;
}

/** Les cibles de l'éditeur partagé (`ValidationTargetsEditor`), sur les routes du template. */
export function journeyTargets(challengeId: string, routes: JourneyRoutes) {
  return {
    list: () => managedApps(challengeId, routes),
    eligible: () => eligibleApps(challengeId, routes),
    add: (contributionId: string, url: string) => exposeApp(challengeId, routes, contributionId, url),
    remove: (appId: string) => withdrawApp(challengeId, routes, appId),
  };
}
