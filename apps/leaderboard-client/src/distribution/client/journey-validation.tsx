import type { FlowUiSlots } from '@/lib/flowSlots';
import { ScenarioChallengeFlow } from '@/components/challenges/ScenarioChallengeFlow';
import { ValidationTargetsEditor } from '@/components/admin/ValidationTargetsEditor';
import { ScenarioStepsEditor } from '@/components/admin/ScenarioStepsEditor';
import { ValidationRewardsPanel } from '@/components/admin/ValidationRewardsPanel';
import { ScenarioWalkthroughsPanel } from '@/components/admin/ScenarioWalkthroughsPanel';
import { ValidationRules } from '@/components/challenges/rules/ValidationRules';
import { contributionsStat } from './stats';
import { journeyRewards, journeyTargets } from '@/lib/journeyTemplateApi';

/** Le forfait et la qualification des avis experts, lus dans la configuration du challenge. */
function journeyConfig(challenge: { flow_config?: unknown }) {
  const config = challenge.flow_config && typeof challenge.flow_config === 'object' ? (challenge.flow_config as Record<string, unknown>) : {};
  return {
    cpPerValidation: typeof config.cp_per_validation === 'number' ? config.cp_per_validation : 0,
    expertQualification: typeof config.expert_comment_qualification === 'string' ? config.expert_comment_qualification : null,
  };
}

/**
 * Parcours de scénario : des validateurs parcourent le même scénario dans chaque
 * application déployée. Le flow est compilé depuis son template (parité P4) ;
 * ses écrans restent ceux-ci, sur les routes du template (`lib/journeyTemplateApi.ts`).
 */
export const journeyValidationSlots: FlowUiSlots = {
  contributorTabs: (ctx) => [
    { label: 'Walkthrough', panel: <ScenarioChallengeFlow challengeId={ctx.challengeId} {...journeyConfig(ctx.challenge)} /> },
  ],
  contributorHeroStat: (ctx) => contributionsStat(ctx.contributions.length),

  manageTabs: (ctx) => [
    ctx.common.overview,
    {
      label: 'Scenario',
      panel: (
        <div className="space-y-6">
          <ValidationTargetsEditor challengeId={ctx.challengeId} open source={journeyTargets(ctx.challengeId)} />
          <ScenarioStepsEditor challengeId={ctx.challengeId} open />
          <ValidationRewardsPanel challengeId={ctx.challengeId} open load={() => journeyRewards(ctx.challengeId, journeyConfig(ctx.challenge).cpPerValidation)} />
        </div>
      ),
    },
    { label: 'Walkthroughs', panel: <ScenarioWalkthroughsPanel challengeId={ctx.challengeId} open /> },
  ],
  manageHeroStat: (ctx) => contributionsStat(ctx.contributions.length),

  rulesView: ValidationRules,
};
