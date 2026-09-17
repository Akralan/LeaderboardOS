'use client';

import { useMemo } from 'react';
import type { SurfaceBlock } from '../../../../../packages/interpreter/describe';
import { ScenarioStepsEditor } from '@/components/admin/ScenarioStepsEditor';
import { ScenarioWalkthroughsPanel } from '@/components/admin/ScenarioWalkthroughsPanel';
import { ValidationTargetsEditor } from '@/components/admin/ValidationTargetsEditor';
import { ScenarioChallengeFlow } from '@/components/challenges/ScenarioChallengeFlow';
import { journeyRoutesOf, journeyTargets } from '@/lib/journeyTemplateApi';
import type { ScreenRuntime } from './GeneratedScreen';
import { fgAt } from './format';

/**
 * Les blocs du scénario (catalogue UI : walkthrough, targets, steps,
 * walkthroughs) : les écrans de journey-validation, joués sur les routes que
 * les arguments du bloc désignent. Un bloc dont les routes ne se résolvent pas
 * dit pourquoi, à la place de l'écran.
 */

function configOf(challenge: { flow_config?: unknown }): Record<string, unknown> {
  return challenge.flow_config && typeof challenge.flow_config === 'object' ? (challenge.flow_config as Record<string, unknown>) : {};
}

function useRoutes(block: SurfaceBlock, runtime: ScreenRuntime) {
  const surface = runtime.description.surface;
  return useMemo(() => journeyRoutesOf(surface, block.props), [surface, block.props]);
}

function Unresolved({ why }: { why: string }) {
  return <p className="text-xs" style={{ color: fgAt(0.4) }}>{why}</p>;
}

export function WalkthroughBlock({ block, runtime }: { block: SurfaceBlock; runtime: ScreenRuntime }) {
  const routes = useRoutes(block, runtime);
  if (typeof routes === 'string') return <Unresolved why={routes} />;
  const config = configOf(runtime.challenge);
  const rewardParam = typeof block.props.reward_param === 'string' ? block.props.reward_param : 'cp_per_validation';
  const expertParam = typeof block.props.expert_param === 'string' ? block.props.expert_param : 'expert_comment_qualification';
  const cpPerValidation = typeof config[rewardParam] === 'number' ? (config[rewardParam] as number) : 0;
  const expertQualification = typeof config[expertParam] === 'string' ? (config[expertParam] as string) : null;
  return <ScenarioChallengeFlow challengeId={runtime.challengeId} routes={routes} cpPerValidation={cpPerValidation} expertQualification={expertQualification} />;
}

export function TargetsBlock({ block, runtime }: { block: SurfaceBlock; runtime: ScreenRuntime }) {
  const routes = useRoutes(block, runtime);
  const source = useMemo(() => (typeof routes === 'string' ? null : journeyTargets(runtime.challengeId, routes)), [routes, runtime.challengeId]);
  if (typeof routes === 'string' || !source) return <Unresolved why={typeof routes === 'string' ? routes : 'Unresolved routes.'} />;
  return <ValidationTargetsEditor challengeId={runtime.challengeId} open source={source} />;
}

export function StepsBlock({ block, runtime }: { block: SurfaceBlock; runtime: ScreenRuntime }) {
  const routes = useRoutes(block, runtime);
  if (typeof routes === 'string') return <Unresolved why={routes} />;
  return <ScenarioStepsEditor challengeId={runtime.challengeId} routes={routes} open />;
}

export function WalkthroughsBlock({ block, runtime }: { block: SurfaceBlock; runtime: ScreenRuntime }) {
  const routes = useRoutes(block, runtime);
  if (typeof routes === 'string') return <Unresolved why={routes} />;
  return <ScenarioWalkthroughsPanel challengeId={runtime.challengeId} routes={routes} open />;
}
