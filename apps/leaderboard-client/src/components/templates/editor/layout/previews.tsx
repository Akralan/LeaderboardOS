'use client';

import { Download, Upload } from 'lucide-react';
import type { TemplateSurface } from '../../../../../../../packages/interpreter/describe';
import { uiComponent } from '../../../../../../../packages/interpreter/ui/catalog';
import { useEditor } from '../EditorContext';
import { humanize, type BlockView } from '../model';
import { PreviewField } from '../Panels';

/**
 * Ce qu'un bloc montre sur la grille
 * ----------------------------------
 * Une prévisualisation inerte de chaque composant du catalogue, à la taille
 * du bloc : la forme que le joueur verra, tirée du brouillon — les champs de
 * la lane, les types de ressources, le board. Sans surface (brouillon
 * invalide), le modèle du canevas suffit pour esquisser.
 */

const card = 'flex h-full min-h-0 flex-col gap-2 overflow-hidden rounded-[14px] border border-white/[0.08] bg-white/[0.02] p-3';
const skeleton = 'rounded-md bg-white/[0.06]';

function Title({ children, meta }: { children: string; meta?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="truncate text-xs font-semibold text-white">{children}</span>
      {meta && <span className="shrink-0 text-[10px] text-white/35">{meta}</span>}
    </div>
  );
}

function Rows({ count, columns = 3 }: { count: number; columns?: number }) {
  return (
    <div className="flex flex-col gap-1.5">
      {Array.from({ length: count }, (_, row) => (
        <div key={row} className="flex gap-2">
          {Array.from({ length: columns }, (_, column) => (
            <span key={column} className={`${skeleton} h-2.5`} style={{ width: `${column === 0 ? 18 : 30 - column * 4}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

function LanePreview({ block, surface }: { block: BlockView; surface: TemplateSurface | null }) {
  const { model } = useEditor();
  const laneId = typeof block.props.lane === 'string' ? block.props.lane : '';
  const lane = surface?.lanes.find((candidate) => candidate.id === laneId);
  const canvasLane = model.lanes.find((candidate) => candidate.id === laneId);
  if (!lane && !canvasLane) {
    return (
      <div className={card}>
        <Title>{laneId ? humanize(laneId) : 'Lane'}</Title>
        <span className="text-[11px] text-red-300">{laneId ? `No lane ‘${laneId}’ on this template.` : 'Pick a lane in the inspector.'}</span>
      </div>
    );
  }
  const segment = lane?.segments[0];
  const steps = lane?.segments.length ?? 1;
  const first = canvasLane ? [...model.nodes.values()].find((node) => node.laneIndex === canvasLane.index && node.docKey === 'collect') : undefined;
  return (
    <div className={card}>
      <Title meta={steps > 1 ? `step 1 of ${steps}` : undefined}>{humanize(laneId)}</Title>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
        {segment
          ? segment.fields.map((field) => <PreviewField key={`${field.gesture}.${field.name}`} field={field} />)
          : first?.lines.map((line) => (
              <div key={line.k} className="flex flex-col gap-1">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-white/45">{humanize(line.k)}</span>
                <span className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white/35">{line.v}</span>
              </div>
            ))}
        {segment && segment.fields.length === 0 && <span className="text-xs text-white/45">A single action — no field.</span>}
      </div>
      <span className="w-fit rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-black/80">{segment?.final || steps === 1 ? 'Submit' : 'Continue'}</span>
    </div>
  );
}

function TextPreview({ block }: { block: BlockView }) {
  const title = typeof block.props.title === 'string' ? block.props.title : '';
  const body = typeof block.props.body === 'string' ? block.props.body : '';
  return (
    <div className={card}>
      {title ? <span className="text-xs font-semibold text-white">{title}</span> : <span className={`${skeleton} h-3 w-1/3`} />}
      {body ? <p className="line-clamp-4 text-[11px] leading-relaxed text-white/60">{body}</p> : <span className="text-[11px] text-white/35">Write a title and a paragraph in the inspector.</span>}
    </div>
  );
}

function MinePreview() {
  const { model } = useEditor();
  return (
    <div className={card}>
      <Title meta="what I created">My work</Title>
      {model.resources.length === 0 && <span className="text-[11px] text-white/35">No resource declared.</span>}
      {model.resources.slice(0, 3).map((resource) => (
        <div key={resource.name} className="flex flex-col gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-white/40">{humanize(resource.name)}</span>
          <Rows count={2} columns={Math.min(4, resource.fields.length + 1)} />
        </div>
      ))}
    </div>
  );
}

function BoardPreview() {
  return (
    <div className={card}>
      <Title meta="personal">Board</Title>
      <div className="grid min-h-0 flex-1 grid-cols-3 gap-2">
        {['To do', 'Doing', 'Done'].map((column, index) => (
          <div key={column} className="flex flex-col gap-1.5 rounded-lg bg-white/[0.03] p-2">
            <span className="text-[10px] font-semibold text-white/45">{column}</span>
            {Array.from({ length: 3 - index }, (_, row) => (
              <span key={row} className={`${skeleton} h-6`} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkspacePreview() {
  return (
    <div className={card}>
      <Title meta="where I deliver">Workspace</Title>
      <span className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white/35">https://github.com/…</span>
      <span className="w-fit rounded-full border border-white/10 px-3 py-1 text-[11px] text-white/60">Save</span>
    </div>
  );
}

function OverviewPreview() {
  const { model } = useEditor();
  const types = model.resources.length ? model.resources : [{ name: 'resource' }];
  return (
    <div className={card}>
      <Title meta="manager">Overview</Title>
      <div className="grid grid-cols-3 gap-2">
        {types.slice(0, 3).map((resource) => (
          <div key={resource.name} className="flex flex-col gap-1 rounded-lg border border-white/[0.06] p-2">
            <span className="truncate text-[10px] text-white/45">{humanize(resource.name)}</span>
            <span className="text-sm font-semibold text-white">—</span>
            <span className={`${skeleton} h-1.5 w-2/3`} />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 text-[10px] text-white/40">
        <span>Pool · distributed · remaining</span>
        <span className="ml-auto flex items-center gap-1 text-brandCP"><Download className="h-3 w-3" /> CSV</span>
      </div>
    </div>
  );
}

function ResourcesPreview() {
  const { model } = useEditor();
  const first = model.resources[0];
  return (
    <div className={card}>
      <div className="flex flex-wrap gap-1">
        {(model.resources.length ? model.resources : [{ name: 'resource' }]).map((resource, index) => (
          <span key={resource.name} className={`rounded-full border px-2 py-0.5 text-[10px] ${index === 0 ? 'border-brandCP/60 bg-brandCP/15 text-white' : 'border-white/10 text-white/50'}`}>
            {humanize(resource.name)}
          </span>
        ))}
      </div>
      <Rows count={4} columns={Math.min(5, (first?.fields.length ?? 2) + 2)} />
    </div>
  );
}

export function BlockPreview({ block, surface }: { block: BlockView; surface: TemplateSurface | null }) {
  switch (block.component) {
    case 'lane':
      return <LanePreview block={block} surface={surface} />;
    case 'text':
      return <TextPreview block={block} />;
    case 'mine':
      return <MinePreview />;
    case 'board':
      return <BoardPreview />;
    case 'workspace':
      return <WorkspacePreview />;
    case 'overview':
      return <OverviewPreview />;
    case 'resources':
      return <ResourcesPreview />;
    default:
      return (
        <div className={card}>
          <Title>{block.component || 'Block'}</Title>
          <span className="flex items-center gap-1.5 text-[11px] text-red-300">
            <Upload className="h-3 w-3" /> {uiComponent(block.component) ? 'No preview.' : 'Unknown component.'}
          </span>
        </div>
      );
  }
}
