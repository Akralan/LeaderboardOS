import type { FlowUiSlots } from '@/lib/flowSlots';
import { ScenarioChallengeFlow } from '@/components/challenges/ScenarioChallengeFlow';
import { ValidationTargetsEditor } from '@/components/admin/ValidationTargetsEditor';
import { ScenarioStepsEditor } from '@/components/admin/ScenarioStepsEditor';
import { ValidationRewardsPanel } from '@/components/admin/ValidationRewardsPanel';
import { ScenarioWalkthroughsPanel } from '@/components/admin/ScenarioWalkthroughsPanel';
import { ValidationRules } from '@/components/challenges/rules/ValidationRules';
import { contributionsStat } from './stats';
import { journeyRewards, journeyRoutesOf, journeyTargets, type JourneyRoutes } from '@/lib/journeyTemplateApi';
import { journeyValidationTemplate } from '../../../../../content/templates/journey-validation/descriptor';

/** Le forfait et la qualification des avis experts, lus dans la configuration du challenge. */
function journeyConfig(challenge: { flow_config?: unknown }) {
  const config = challenge.flow_config && typeof challenge.flow_config === 'object' ? (challenge.flow_config as Record<string, unknown>) : {};
  return {
    cpPerValidation: typeof config.cp_per_validation === 'number' ? config.cp_per_validation : 0,
    expertQualification: typeof config.expert_comment_qualification === 'string' ? config.expert_comment_qualification : null,
  };
}

/**
 * Les routes du template système, résolues une fois sur sa surface : les mêmes
 * que le bloc `ui` du template désigne, sans passer par un écran composé.
 */
function routesOf(props: Record<string, string>): JourneyRoutes {
  const routes = journeyRoutesOf(journeyValidationTemplate.surface, props);
  if (typeof routes === 'string') throw new Error(`[journey-validation] ${routes}`);
  return routes;
}
const CONTRIBUTOR_ROUTES = routesOf({ targets: 'app', steps: 'step', open: 'open', record: 'record', complete: 'complete' });
const MANAGE_ROUTES = routesOf({ targets: 'app', steps: 'step', expose: 'apps', withdraw: 'withdraw', add: 'add_step', edit: 'edit_step', remove: 'remove_step' });

/**
 * Parcours de scénario : des validateurs parcourent le même scénario dans chaque
 * application déployée. Le flow est compilé depuis son template (parité P4) ;
 * ses écrans restent ceux-ci, sur les routes du template (`lib/journeyTemplateApi.ts`).
 * Le template compose aussi ces écrans dans son bloc `ui` (composants
 * `walkthrough`, `targets`, `steps`, `walkthroughs` du catalogue) : la
 * distribution garde ses onglets écrits à la main, une copie du template en
 * base joue la version composée.
 */
export const journeyValidationSlots: FlowUiSlots = {
  contributorTabs: (ctx) => [
    { label: 'Walkthrough', panel: <ScenarioChallengeFlow challengeId={ctx.challengeId} routes={CONTRIBUTOR_ROUTES} {...journeyConfig(ctx.challenge)} /> },
  ],
  contributorHeroStat: (ctx) => contributionsStat(ctx.contributions.length),

  manageTabs: (ctx) => [
    ctx.common.overview,
    {
      label: 'Scenario',
      panel: (
        <div className="space-y-6">
          <ValidationTargetsEditor challengeId={ctx.challengeId} open source={journeyTargets(ctx.challengeId, MANAGE_ROUTES)} />
          <ScenarioStepsEditor challengeId={ctx.challengeId} routes={MANAGE_ROUTES} open />
          <ValidationRewardsPanel challengeId={ctx.challengeId} open load={() => journeyRewards(ctx.challengeId, MANAGE_ROUTES, journeyConfig(ctx.challenge).cpPerValidation)} />
        </div>
      ),
    },
    { label: 'Walkthroughs', panel: <ScenarioWalkthroughsPanel challengeId={ctx.challengeId} routes={MANAGE_ROUTES} open /> },
  ],
  manageHeroStat: (ctx) => contributionsStat(ctx.contributions.length),

  rulesView: ValidationRules,
};
