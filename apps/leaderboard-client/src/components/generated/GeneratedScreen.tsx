'use client';

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { SurfaceBlock, TemplateDescription } from '../../../../../packages/interpreter/describe';
import type { UiScreen } from '../../../../../packages/interpreter/format/schema';
import type { ContributorSlotContext, SlotChallenge } from '@/lib/flowSlots';
import { ContributorTaskBoard } from '@/components/contributor/ContributorTaskBoard';
import { GeneratedLane } from './GeneratedLane';
import { GeneratedOverview } from './GeneratedOverview';
import { GeneratedMine, GeneratedResources } from './GeneratedResources';
import { GeneratedWorkspace } from './GeneratedWorkspace';
import { fgAt } from './format';

/**
 * Un écran composé (note §5, catalogue UI)
 * ----------------------------------------
 * Le template a posé des composants du catalogue sur une grille de 12
 * colonnes (`surface.ui`). Chaque nom du catalogue a ici son composant React ;
 * l'écran les place là où le template l'écrit, et les empile en une colonne
 * sur un téléphone, dans l'ordre de lecture. Le comportement reste celui des
 * écrans générés : une lane joue ses segments, `mine` se relit après chaque
 * geste, une lane réservée à une qualification ne se montre qu'à qui la tient.
 */

export type DescribedTemplate = Pick<TemplateDescription, 'descriptor' | 'surface'>;

export interface ScreenRuntime {
  screen: UiScreen;
  challengeId: string;
  challenge: SlotChallenge;
  description: DescribedTemplate;
  /** Monte après chaque geste enregistré : ce qui relit le serveur suit. */
  version: number;
  onRecorded: () => void;
  /** Les qualifications que le visiteur tient ; `null` tant qu'elles chargent. */
  held: string[] | null;
  /** Le contexte du contributeur ; absent sur l'écran manager. */
  contributor: Pick<ContributorSlotContext, 'isMember' | 'myTasks' | 'myParticipation' | 'reloadBoard'> | null;
}

export function configOf(challenge: { flow_config?: unknown }): Record<string, unknown> {
  return challenge.flow_config && typeof challenge.flow_config === 'object' ? (challenge.flow_config as Record<string, unknown>) : {};
}

/** Les qualifications du visiteur, lues une fois quand un écran en a besoin. */
export function useHeldQualifications(needed: boolean): string[] | null {
  const [held, setHeld] = useState<string[] | null>(null);
  useEffect(() => {
    if (!needed) return;
    fetch('/api/contributors/me')
      .then(async (res) => (res.ok ? await res.json() : null))
      .then((me) => setHeld(Array.isArray(me?.qualifications) ? me.qualifications : []))
      .catch(() => setHeld([]));
  }, [needed]);
  return held;
}

/** Une lane réservée se montre à qui tient la qualification que la configuration nomme. */
export function laneVisible(lane: { role?: string }, challenge: SlotChallenge, held: string[] | null): boolean {
  if (!lane.role) return true;
  const key = configOf(challenge)[lane.role];
  return held !== null && typeof key === 'string' && held.includes(key);
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

function TextBlock({ title, body }: { title: string; body: string }) {
  const paragraphs = body.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  if (!title && paragraphs.length === 0) return null;
  return (
    <div className="space-y-2 rounded-[20px] border border-white/[0.08] bg-white/[0.02] p-5">
      {title && <p className="text-sm font-semibold text-white">{title}</p>}
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="text-sm leading-relaxed" style={{ color: fgAt(0.65) }}>{paragraph}</p>
      ))}
    </div>
  );
}

function Missing({ what }: { what: string }) {
  return <p className="text-xs" style={{ color: fgAt(0.35) }}>{what}</p>;
}

type BlockRenderer = (block: SurfaceBlock, runtime: ScreenRuntime) => ReactNode;

/** Le composant React de chaque nom du catalogue (`packages/interpreter/ui/catalog.ts`). `null` : rien à montrer à ce visiteur. */
const BLOCKS: Readonly<Record<string, BlockRenderer>> = {
  lane: (block, runtime) => {
    const lane = runtime.description.surface.lanes.find((candidate) => candidate.id === block.props.lane);
    if (!lane) return <Missing what={`Lane '${text(block.props.lane)}' is not on this template.`} />;
    if (!laneVisible(lane, runtime.challenge, runtime.held)) return null;
    return <GeneratedLane challengeId={runtime.challengeId} lane={lane} onRecorded={runtime.onRecorded} />;
  },
  text: (block) => <TextBlock title={text(block.props.title)} body={text(block.props.body)} />,
  mine: (_block, runtime) => <GeneratedMine challengeId={runtime.challengeId} resources={runtime.description.surface.resources} version={runtime.version} />,
  board: (_block, runtime) => {
    const contributor = runtime.contributor;
    if (!contributor?.isMember || !runtime.description.surface.board) return null;
    return <ContributorTaskBoard challengeId={runtime.challengeId} tasks={contributor.myTasks} onReload={contributor.reloadBoard} />;
  },
  workspace: (_block, runtime) => {
    const contributor = runtime.contributor;
    const workspace = runtime.description.surface.workspace;
    if (!contributor?.isMember || !workspace) return null;
    const mode = (workspace.param ? configOf(runtime.challenge)[workspace.param] : workspace.mode) === 'own_repo' ? 'own_repo' : 'provided_repo';
    return <GeneratedWorkspace challengeId={runtime.challengeId} mode={mode} participation={contributor.myParticipation} onSaved={contributor.reloadBoard} />;
  },
  overview: (_block, runtime) => <GeneratedOverview challengeId={runtime.challengeId} resources={runtime.description.surface.resources} />,
  resources: (_block, runtime) => <GeneratedResources challengeId={runtime.challengeId} resources={runtime.description.surface.resources} />,
};

/** Les blocs dans l'ordre de lecture : la colonne d'un téléphone les empile ainsi. */
export function readingOrder<T extends { at: { x: number; y: number } }>(blocks: readonly T[]): T[] {
  return [...blocks].sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x);
}

export function GeneratedScreen({ blocks, runtime }: { blocks: readonly SurfaceBlock[]; runtime: ScreenRuntime }) {
  return (
    <div className="ui-screen">
      {readingOrder(blocks).map((block) => {
        const render = BLOCKS[block.component];
        const content = render ? render(block, runtime) : <Missing what={`Unknown component '${block.component}'.`} />;
        if (content === null) return null;
        const placement = { '--gx': block.at.x + 1, '--gy': block.at.y + 1, '--gw': block.at.w, '--gh': block.at.h } as CSSProperties;
        return (
          <div key={block.id} className="ui-block" style={placement}>
            {content}
          </div>
        );
      })}
    </div>
  );
}
