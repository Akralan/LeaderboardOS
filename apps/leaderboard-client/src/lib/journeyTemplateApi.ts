import { flowActionUrl } from '@/lib/challengeActions';
import type { ScenarioResult } from '@/components/challenges/scenarioResult';
import type { WalkthroughStepView } from '@/components/challenges/scenarioWalkthroughState';

/**
 * Le parcours de scénario, lu et écrit par les routes du template
 * ---------------------------------------------------------------
 * `journey-validation` est servi par son template (parité P4) : ses gestes
 * sont `apps/expose`, `add_step/new_step`, `open/start`, `record/feedback`,
 * `complete/finish`…, ses lectures `mine`, `counts`, `resources` et les
 * `options` de ses lanes. Ce module les traduit dans les formes que les écrans
 * du scénario manipulent (étapes, cibles, walkthroughs), pour qu'ils restent
 * ceux d'avant le passage au template.
 */

export class JourneyApiError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string) {
    super(message);
  }
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

const byPosition = <S extends { position: number }>(steps: S[]) => [...steps].sort((a, b) => a.position - b.position);

// ── Validateur ───────────────────────────────────────────────────────────────

/** Les applications exposées, telles qu'un validateur peut les ouvrir. */
export async function listApps(challengeId: string): Promise<JourneyApp[]> {
  const { options } = await send<{ options: { id: string; contribution: Linked | null; app_url: string | null }[] }>(challengeId, 'open/options?field=start.app');
  return options.map((option) => appOf(option.id, option.contribution, option.app_url));
}

/** Le scénario, dans son ordre : lisible de tout compte connecté. */
export async function listSteps(challengeId: string): Promise<JourneyStep[]> {
  const { options } = await send<{ options: JourneyStep[] }>(challengeId, 'record/options?field=feedback.step');
  return byPosition(options.map(({ id, position, title, instructions }) => ({ id, position, title, instructions: instructions ?? null })));
}

/** Combien de walkthroughs chaque application compte, brouillons compris. */
export async function walkthroughCounts(challengeId: string): Promise<Record<string, number>> {
  return (await send<{ counts: Record<string, number> }>(challengeId, 'counts?type=walkthrough&by=app')).counts;
}

interface MyWalkthrough { id: string; app: Ref | null; open: boolean; created_at: string; resolution: Record<string, unknown> | null }
interface MyStepResult { id: string; walkthrough: Ref | null; step: Ref | null; result: ScenarioResult; comment: string | null; medical_comment: string | null }

/** Ce que l'appelant a créé : ses walkthroughs et ses retours d'étape. */
export async function mine(challengeId: string): Promise<{ walkthroughs: MyWalkthrough[]; results: MyStepResult[] }> {
  const { resources } = await send<{ resources: { walkthrough?: MyWalkthrough[]; step_result?: MyStepResult[] } }>(challengeId, 'mine');
  return { walkthroughs: resources.walkthrough ?? [], results: resources.step_result ?? [] };
}

export interface WalkthroughState {
  runId: string;
  completed: boolean;
  globalFeedback: string | null;
  steps: WalkthroughStepView[];
}

/** L'état d'une walkthrough : le scénario, et ce que j'ai répondu à chaque étape. */
export async function walkthroughState(challengeId: string, runId: string): Promise<WalkthroughState> {
  const [steps, own] = await Promise.all([listSteps(challengeId), mine(challengeId)]);
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
export async function openWalkthrough(challengeId: string, appId: string): Promise<string> {
  const { created } = await send<{ created: { open_run: string } }>(challengeId, 'open/start', { app: appId });
  return created.open_run;
}

export async function saveStep(challengeId: string, runId: string, step: Pick<WalkthroughStepView, 'stepId' | 'result' | 'comment' | 'medicalComment'>): Promise<void> {
  await send(challengeId, 'record/feedback', {
    walkthrough: runId,
    step: step.stepId,
    result: step.result,
    comment: step.comment,
    medical_comment: step.medicalComment,
  });
}

export async function completeWalkthrough(challengeId: string, runId: string, globalFeedback: string): Promise<number> {
  const { cp_awarded } = await send<{ cp_awarded: number }>(challengeId, 'complete/finish', { walkthrough: runId, global_feedback: globalFeedback });
  return cp_awarded;
}

// ── Managers ─────────────────────────────────────────────────────────────────

async function resources<F>(challengeId: string, type: string): Promise<Instance<F>[]> {
  return (await send<{ instances: Instance<F>[] }>(challengeId, `resources?type=${type}`)).instances;
}

export interface ManagedScenario { steps: JourneyStep[]; frozen: boolean }

/** Le scénario pour son éditeur : ses étapes, et s'il est gelé (une walkthrough existe). */
export async function managedScenario(challengeId: string): Promise<ManagedScenario> {
  const [steps, walkthroughs] = await Promise.all([
    resources<{ position: number; title: string; instructions: string | null }>(challengeId, 'step'),
    resources(challengeId, 'walkthrough'),
  ]);
  return {
    steps: byPosition(steps.map((step) => ({ id: step.id, position: step.fields.position, title: step.fields.title, instructions: step.fields.instructions ?? null }))),
    frozen: walkthroughs.length > 0,
  };
}

export const addStep = (challengeId: string, title: string, instructions: string | null) =>
  send(challengeId, 'add_step/new_step', { title, ...(instructions ? { instructions } : {}) });

export const editStep = (challengeId: string, stepId: string, patch: Record<string, unknown>) =>
  send(challengeId, 'edit_step/step_edit', { step: stepId, ...patch });

export const removeStep = (challengeId: string, stepId: string) => send(challengeId, 'remove_step/step_removal', { step: stepId });

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
export async function managedRuns(challengeId: string): Promise<{ steps: JourneyStep[]; runs: ManagedRun[] }> {
  const [scenario, apps, walkthroughs, results] = await Promise.all([
    managedScenario(challengeId),
    resources<{ contribution: Linked | null; app_url: string | null }>(challengeId, 'app'),
    resources<{ app: Ref | null }>(challengeId, 'walkthrough'),
    resources<{ walkthrough: Ref | null; step: Ref | null; result: ScenarioResult; comment: string | null; medical_comment: string | null }>(challengeId, 'step_result'),
  ]);
  const appsById = new Map(apps.map((app) => [app.id, appOf(app.id, app.fields.contribution, app.fields.app_url)]));
  const order = new Map(scenario.steps.map((step, index) => [step.id, index]));
  return {
    steps: scenario.steps,
    runs: walkthroughs.map((run) => {
      const app = run.fields.app ? appsById.get(run.fields.app.id) : undefined;
      const feedbacks = results
        .filter((result) => result.fields.walkthrough?.id === run.id)
        .sort((a, b) => (order.get(a.fields.step?.id ?? '') ?? 0) - (order.get(b.fields.step?.id ?? '') ?? 0))
        .map((result) => ({ stepId: result.fields.step?.id ?? '', result: result.fields.result, comment: result.fields.comment, medicalComment: result.fields.medical_comment }));
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
export async function managedApps(challengeId: string): Promise<ManagedTarget[]> {
  const [apps, counts] = await Promise.all([
    resources<{ contribution: Linked | null; app_url: string | null }>(challengeId, 'app'),
    walkthroughCounts(challengeId),
  ]);
  return apps.map((app) => {
    const view = appOf(app.id, app.fields.contribution, app.fields.app_url);
    return { id: app.id, contributionId: view.contributionId, submitterName: view.submitterName, verdictCount: 0, outcome: 'pending', walkthroughCount: counts[app.id] ?? 0 };
  });
}

/** Les soumissions du challenge source encore exposables. */
export async function eligibleApps(challengeId: string): Promise<{ contributionId: string; userId: string; userName: string }[]> {
  const { options } = await send<{ options: Linked[] }>(challengeId, 'apps/options?field=expose.contribution');
  return options.map((option) => ({ contributionId: option.id, userId: option.author, userName: option.author_name ?? option.title ?? 'Unknown' }));
}

export const exposeApp = (challengeId: string, contributionId: string, appUrl: string) =>
  send(challengeId, 'apps/expose', { contribution: contributionId, app_url: appUrl });

export const withdrawApp = (challengeId: string, appId: string) => send(challengeId, 'withdraw/withdraw_app', { app: appId });

/** L'état du pool et ce que chaque validateur a gagné, noms compris. */
export async function poolState(challengeId: string): Promise<{ pool: number; distributed: number; remaining: number; breakdown: { userId: string; points: number }[] } | null> {
  const res = await fetch(`/api/challenges/${challengeId}/rewards`);
  return res.ok ? res.json() : null;
}

/** Les cibles de l'éditeur partagé (`ValidationTargetsEditor`), sur les routes du template. */
export function journeyTargets(challengeId: string) {
  return {
    list: () => managedApps(challengeId),
    eligible: () => eligibleApps(challengeId),
    add: (contributionId: string, url: string) => exposeApp(challengeId, contributionId, url),
    remove: (appId: string) => withdrawApp(challengeId, appId),
  };
}

/** L'état du pool du panneau partagé (`ValidationRewardsPanel`) : les validateurs payés, nommés. */
export async function journeyRewards(challengeId: string, cpPerValidation: number) {
  const [rewards, walkthroughs] = await Promise.all([poolState(challengeId), resources(challengeId, 'walkthrough').catch(() => [])]);
  if (!rewards) return null;
  const names = new Map(walkthroughs.map((run) => [run.author, run.author_name]));
  return {
    pool: rewards.pool,
    distributed: rewards.distributed,
    remaining: rewards.remaining,
    requiredValidations: 0,
    cpPerValidation,
    breakdown: rewards.breakdown.map((row) => ({ ...row, userName: names.get(row.userId) ?? 'Unknown' })),
  };
}
