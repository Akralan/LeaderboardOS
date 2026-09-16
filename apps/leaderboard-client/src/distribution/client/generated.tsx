'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { TemplateDescription } from '../../../../../packages/interpreter/describe';
import type { HeroStat } from '@/components/challenges/HeroStats';
import type { ChallengeRewards, FlowUiSlots, RulesChallenge, SlotChallenge } from '@/lib/flowSlots';
import { GeneratedLane } from '@/components/generated/GeneratedLane';
import { GeneratedOverview } from '@/components/generated/GeneratedOverview';
import { FlowArrow, FlowBox, SectionLabel } from '@/components/challenges/rules/RuleFlow';
import { fgAt, humanize } from '@/components/generated/format';

/** Ce que les slots générés lisent d'un template : son descripteur et sa surface — ce que `describe` sert en JSON. */
export type DescribedTemplate = Pick<TemplateDescription, 'descriptor' | 'surface'>;

/**
 * Les slots générés d'un template (note §5)
 * -----------------------------------------
 * Le défaut de tout flow compilé que la distribution n'habille pas à la main :
 * - l'onglet contributeur empile ses lanes \`user\` — une lane réservée à une
 *   qualification ne s'affiche qu'à qui la détient ;
 * - l'onglet manager empile ses lanes \`admin\` et l'overview généré ;
 * - le hero lit \`rewards.summarize\` (les instances fermées du type résolu) ;
 * - les règles décrivent les lanes et les paramètres du challenge.
 */

function configOf(challenge: { flow_config?: unknown }): Record<string, unknown> {
  return challenge.flow_config && typeof challenge.flow_config === 'object' ? (challenge.flow_config as Record<string, unknown>) : {};
}

/** Les lanes réservées : visibles seulement de qui détient la qualification que la configuration nomme. */
function QualifiedLanes({ challenge, lanes, render }: { challenge: SlotChallenge; lanes: DescribedTemplate['surface']['lanes']; render: (lane: DescribedTemplate['surface']['lanes'][number]) => ReactNode }) {
  const [held, setHeld] = useState<string[] | null>(null);
  const needsQualification = lanes.some((lane) => lane.role);

  useEffect(() => {
    if (!needsQualification) return;
    fetch('/api/contributors/me')
      .then(async (res) => (res.ok ? await res.json() : null))
      .then((me) => setHeld(Array.isArray(me?.qualifications) ? me.qualifications : []))
      .catch(() => setHeld([]));
  }, [needsQualification]);

  const visible = lanes.filter((lane) => {
    if (!lane.role) return true;
    const key = configOf(challenge)[lane.role];
    return held !== null && typeof key === 'string' && held.includes(key);
  });
  if (visible.length === 0) {
    return (
      <p className="py-6 text-sm" style={{ color: fgAt(0.45) }}>
        {needsQualification && held === null ? 'Loading…' : 'Nothing to do here for your account.'}
      </p>
    );
  }
  return <div className="space-y-4">{visible.map((lane) => <div key={lane.id}>{render(lane)}</div>)}</div>;
}

function heroStat(description: DescribedTemplate, rewards: ChallengeRewards | null, contributions: number): HeroStat {
  const counts = rewards?.resources as Record<string, { total?: number; closed?: number }> | undefined;
  const resolved = description.surface.resources.find((resource) => resource.aggregates.length > 0) ?? description.surface.resources[0];
  const row = resolved ? counts?.[resolved.type] : undefined;
  if (!resolved || !row) {
    return { key: 'contributions', label: 'Contributions', value: String(contributions), meta: 'recorded' };
  }
  const total = row.total ?? 0;
  const closed = row.closed ?? 0;
  return {
    key: resolved.type,
    label: humanize(resolved.type),
    value: String(closed),
    unit: `/ ${total}`,
    meta: 'resolved',
    barWidth: total > 0 ? `${Math.round((closed / total) * 100)}%` : '0%',
  };
}

function rulesOf(description: DescribedTemplate) {
  return function GeneratedRules({ challenge }: { challenge: RulesChallenge }) {
    const params = { ...configOf(challenge), ...(challenge.reward_rules && typeof challenge.reward_rules === 'object' ? (challenge.reward_rules as Record<string, unknown>) : {}) };
    const lanes = description.surface.lanes;
    return (
      <div className="space-y-6">
        <div>
          <SectionLabel>How it works</SectionLabel>
          {lanes.map((lane, index) => (
            <div key={lane.id}>
              {index > 0 && <FlowArrow />}
              <FlowBox icon={<span className="text-sm">{lane.trigger === 'admin' ? '🛠️' : '✍️'}</span>} title={humanize(lane.id)}>
                {lane.segments.map((segment) => humanize(segment.path.split('/')[1] ?? 'start')).join(' → ')}
              </FlowBox>
            </div>
          ))}
        </div>
        <div>
          <SectionLabel>Parameters</SectionLabel>
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between gap-4"><dt style={{ color: fgAt(0.5) }}>Pool</dt><dd className="text-white">{challenge.contribution_points_reward} CP</dd></div>
            {Object.entries(params)
              .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
              .map(([key, value]) => (
                <div key={key} className="flex justify-between gap-4"><dt style={{ color: fgAt(0.5) }}>{humanize(key)}</dt><dd className="text-white">{String(value)}</dd></div>
              ))}
          </dl>
        </div>
      </div>
    );
  };
}

export function generatedSlots(description: DescribedTemplate): FlowUiSlots {
  const userLanes = description.surface.lanes.filter((lane) => lane.trigger === 'user');
  const adminLanes = description.surface.lanes.filter((lane) => lane.trigger === 'admin');

  return {
    readsRewards: true,

    contributorTabs: (ctx) => [
      {
        label: description.descriptor.label,
        panel: <QualifiedLanes challenge={ctx.challenge} lanes={userLanes} render={(lane) => <GeneratedLane challengeId={ctx.challengeId} lane={lane} />} />,
      },
    ],
    contributorHeroStat: (ctx) => heroStat(description, ctx.rewards, ctx.contributions.length),

    anonymousView: () => (
      <p className="py-6 text-sm" style={{ color: fgAt(0.45) }}>Sign in to take part in this challenge.</p>
    ),

    manageTabs: (ctx) => [
      ctx.common.overview,
      {
        label: 'Manage',
        panel: (
          <div className="space-y-4">
            {adminLanes.map((lane) => <GeneratedLane key={lane.id} challengeId={ctx.challengeId} lane={lane} />)}
            <GeneratedOverview challengeId={ctx.challengeId} resources={description.surface.resources} />
          </div>
        ),
      },
      ctx.common.rankings,
    ],
    manageHeroStat: (ctx) => heroStat(description, ctx.rewards, ctx.contributions.length),

    rulesView: rulesOf(description),
  };
}

// ── Un template publié en base : les mêmes slots, sur sa description servie ──

const described = new Map<string, Promise<DescribedTemplate | null>>();

/** La description d'une version publiée, une fois par `(clé, version)` : une version publiée ne change jamais. */
function describe(key: string, version: string | null | undefined): Promise<DescribedTemplate | null> {
  const ref = `${key}@${version ?? 'latest'}`;
  if (!described.has(ref)) {
    const query = version ? `?version=${encodeURIComponent(version)}` : '';
    described.set(
      ref,
      fetch(`/api/templates/${encodeURIComponent(key)}/describe${query}`)
        .then((res) => (res.ok ? (res.json() as Promise<DescribedTemplate>) : null))
        .catch(() => null)
    );
  }
  return described.get(ref)!;
}

function Described({ type, version, render }: { type: string; version?: string | null; render: (description: DescribedTemplate) => ReactNode }) {
  const [description, setDescription] = useState<DescribedTemplate | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    describe(type, version).then((result) => !cancelled && setDescription(result));
    return () => { cancelled = true; };
  }, [type, version]);
  if (description === undefined) return <p className="py-6 text-sm" style={{ color: fgAt(0.45) }}>Loading…</p>;
  if (description === null) return <p className="py-6 text-sm" style={{ color: fgAt(0.45) }}>This template cannot be described.</p>;
  return <>{render(description)}</>;
}

/** La mesure du hero sans description : les instances fermées du premier type que `rewards.summarize` compte. */
function summarizedStat(rewards: ChallengeRewards | null, contributions: number): HeroStat {
  const counts = rewards?.resources as Record<string, { total?: number; closed?: number }> | undefined;
  const first = counts ? Object.entries(counts)[0] : undefined;
  if (!first) return { key: 'contributions', label: 'Contributions', value: String(contributions), meta: 'recorded' };
  const [type, row] = first;
  const total = row.total ?? 0;
  const closed = row.closed ?? 0;
  return { key: type, label: humanize(type), value: String(closed), unit: `/ ${total}`, meta: 'resolved', barWidth: total > 0 ? `${Math.round((closed / total) * 100)}%` : '0%' };
}

const slotsByType = new Map<string, FlowUiSlots>();

/**
 * Les slots d'un type absent des tables du client : un template publié en
 * base. Chaque panneau attend la description de la version du challenge,
 * puis rend les slots générés — les mêmes composants que pour un template
 * système, et que la prévisualisation d'un brouillon.
 */
export function describedSlots(type: string): FlowUiSlots {
  const cached = slotsByType.get(type);
  if (cached) return cached;
  const slots: FlowUiSlots = {
    readsRewards: true,
    contributorTabs: (ctx) => [
      {
        label: 'Participate',
        panel: <Described type={type} version={ctx.challenge.template_version} render={(description) => generatedSlots(description).contributorTabs(ctx)[0]?.panel} />,
      },
    ],
    contributorHeroStat: (ctx) => summarizedStat(ctx.rewards, ctx.contributions.length),
    anonymousView: () => <p className="py-6 text-sm" style={{ color: fgAt(0.45) }}>Sign in to take part in this challenge.</p>,
    manageTabs: (ctx) => [
      ctx.common.overview,
      {
        label: 'Manage',
        panel: <Described type={type} version={ctx.challenge.template_version} render={(description) => generatedSlots(description).manageTabs(ctx)[1]?.panel} />,
      },
      ctx.common.rankings,
    ],
    manageHeroStat: (ctx) => summarizedStat(ctx.rewards, ctx.contributions.length),
    rulesView: function DescribedRules({ challenge }: { challenge: RulesChallenge }) {
      return (
        <Described
          type={type}
          version={challenge.template_version}
          render={(description) => {
            const Rules = generatedSlots(description).rulesView;
            return <Rules challenge={challenge} />;
          }}
        />
      );
    },
  };
  slotsByType.set(type, slots);
  return slots;
}
