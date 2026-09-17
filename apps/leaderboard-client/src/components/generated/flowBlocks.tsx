'use client';

import type { SurfaceBlock } from '../../../../../packages/interpreter/describe';
import { AnnotationCampaignPanel } from '@/components/admin/AnnotationCampaignPanel';
import { AnnotationWorkbench, type LabelOption } from '@/components/challenges/AnnotationWorkbench';
import { CodeChallengePanel } from '@/components/challenges/CodeChallengePanel';
import { ComputeRequestPanel } from '@/components/challenges/ComputeRequestPanel';
import { ComputeRequestsPanel } from '@/components/challenges/ComputeRequestsPanel';
import { MLChallengeFlow } from '@/components/challenges/MLChallengeFlow';
import { MlSubmissionsTab } from '@/components/challenges/manage/MlSubmissionsTab';
import { flowConfigView } from '@/lib/flowConfig';
import { configOf, workspaceModeOf, type ScreenRuntime } from './GeneratedScreen';
import { fgAt } from './format';

/**
 * Les écrans écrits à la main des flows code, ml et data-annotation, entrés
 * au catalogue UI tels quels : chaque bloc monte le composant de la
 * distribution avec ce que l'écran composé sait déjà (le challenge, le
 * contexte du contributeur, l'équipe). Les composants ne changent pas ; ils
 * jouent les lanes du template dont ils portent le nom, que le validateur
 * exige (`expects` dans le catalogue).
 */

function Hint({ children }: { children: string }) {
  return <p className="text-xs" style={{ color: fgAt(0.4) }}>{children}</p>;
}

/** Les réponses possibles d'une annotation : le paramètre `{options: [{key, label}]}` que le bloc nomme. */
function optionsOf(runtime: ScreenRuntime, block: SurfaceBlock): LabelOption[] {
  const param = typeof block.props.schema_param === 'string' && block.props.schema_param ? block.props.schema_param : 'label_schema';
  const schema = configOf(runtime.challenge)[param] as { options?: unknown } | undefined;
  const options = Array.isArray(schema?.options) ? schema.options : [];
  return options.filter((option): option is LabelOption => typeof option?.key === 'string' && typeof option?.label === 'string');
}

export function ProjectBlock({ runtime }: { block: SurfaceBlock; runtime: ScreenRuntime }) {
  const contributor = runtime.contributor;
  if (!contributor) return <Hint>The project panel is a contributor screen.</Hint>;
  return (
    <CodeChallengePanel
      challengeId={runtime.challengeId}
      workspaceMode={workspaceModeOf(runtime) ?? 'provided_repo'}
      myTasks={contributor.myTasks}
      templateTasks={contributor.templateTasks}
      myParticipation={contributor.myParticipation}
      myProjectContribution={contributor.myProjectContribution}
      isMember={contributor.isMember}
      onReload={contributor.reloadBoard}
    />
  );
}

export function SubmissionsBlock({ runtime }: { block: SurfaceBlock; runtime: ScreenRuntime }) {
  return <MLChallengeFlow challengeId={runtime.challengeId} />;
}

export function SubmissionListBlock({ runtime }: { block: SurfaceBlock; runtime: ScreenRuntime }) {
  return <MlSubmissionsTab challengeId={runtime.challengeId} team={runtime.data.team} />;
}

export function ComputeBlock({ runtime }: { block: SurfaceBlock; runtime: ScreenRuntime }) {
  if (runtime.screen === 'contributor') return <ComputeRequestPanel challengeId={runtime.challengeId} />;
  if (!runtime.data.computeConnected) return <Hint>Connect Scaleway to decide compute requests here.</Hint>;
  if (!flowConfigView(runtime.challenge).compute_enabled) return <Hint>Compute is not enabled on this challenge.</Hint>;
  return <ComputeRequestsPanel challengeId={runtime.challengeId} open />;
}

export function AnnotationBlock({ block, runtime }: { block: SurfaceBlock; runtime: ScreenRuntime }) {
  return <AnnotationWorkbench challengeId={runtime.challengeId} isMember={runtime.contributor?.isMember ?? false} options={optionsOf(runtime, block)} />;
}

export function CampaignBlock({ block, runtime }: { block: SurfaceBlock; runtime: ScreenRuntime }) {
  return <AnnotationCampaignPanel challengeId={runtime.challengeId} options={optionsOf(runtime, block)} />;
}
