import type { HeroStat } from '@/components/challenges/HeroStats';
import type { ChallengeRewards, FlowUiSlots, SlotChallenge } from '@/lib/flowSlots';
import { AnnotationWorkbench, type LabelOption } from '@/components/challenges/AnnotationWorkbench';
import { AnnotationCampaignPanel } from '@/components/admin/AnnotationCampaignPanel';
import { AnnotationRules } from '@/components/challenges/rules/AnnotationRules';

/**
 * Les slots du template data-annotation. Les composants restent ceux de
 * MyTwin ; leur contrat de données est la surface que l'interpréteur génère
 * (chemins, formes et noms du template).
 */

/** La mesure du hero : les items labellisés sur le total importé (`rewards.summarize` généré : `resources.item`). */
function labeledStat(rewards: ChallengeRewards | null): HeroStat {
  const resources = rewards?.resources as Record<string, { total?: number; verdicts?: Record<string, number> }> | undefined;
  const total = resources?.item?.total ?? 0;
  const labeled = resources?.item?.verdicts?.labeled ?? 0;
  return {
    key: 'labeled',
    label: 'Labeled',
    value: String(labeled),
    unit: `/ ${total}`,
    meta: 'items settled by agreement',
    barWidth: total > 0 ? `${Math.round((labeled / total) * 100)}%` : '0%',
  };
}

/** Les réponses possibles : le paramètre `label_schema` du template, fixé à la création. */
function optionsOf(challenge: SlotChallenge): LabelOption[] {
  const schema = (challenge.flow_config as { label_schema?: { options?: unknown } } | null | undefined)?.label_schema;
  const options = Array.isArray(schema?.options) ? schema.options : [];
  return options.filter(
    (option): option is LabelOption => typeof option?.key === 'string' && typeof option?.label === 'string'
  );
}

/** Annotation : une image à la fois, des cas de contrôle cachés, l'accord qui tranche. */
export const dataAnnotationSlots: FlowUiSlots = {
  readsRewards: true,

  contributorTabs: (ctx) => [
    {
      label: 'Label',
      panel: <AnnotationWorkbench challengeId={ctx.challengeId} isMember={ctx.isMember} options={optionsOf(ctx.challenge)} />,
    },
  ],
  contributorHeroStat: (ctx) => labeledStat(ctx.rewards),

  // Aucune image n'est montrée hors adhésion : le brief suffit.
  anonymousView: () => (
    <p className="py-6 text-sm" style={{ color: 'color-mix(in srgb, var(--foreground) 45%, transparent)' }}>
      Sign in and join the challenge to start labeling.
    </p>
  ),

  manageTabs: (ctx) => [
    ctx.common.overview,
    { label: 'Campaign', panel: <AnnotationCampaignPanel challengeId={ctx.challengeId} options={optionsOf(ctx.challenge)} /> },
    ctx.common.rankings,
  ],
  manageHeroStat: (ctx) => labeledStat(ctx.rewards),

  rulesView: AnnotationRules,
};
