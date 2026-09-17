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

function PoolPreview() {
  return (
    <div className={`${card} border-brandCP/[0.22]`}>
      <div className="flex items-baseline gap-1.5">
        <span className="text-xl font-semibold text-white">—</span>
        <span className="text-[10px] font-bold text-brandCP">CP left</span>
      </div>
      <span className={`${skeleton} h-1 w-full`} />
    </div>
  );
}

function ActivityPreview({ block }: { block: BlockView }) {
  return (
    <div className={card}>
      <Title meta={block.props.reward_breakdown === true ? 'with ledger lines' : undefined}>Contributions</Title>
      {Array.from({ length: 3 }, (_, row) => (
        <div key={row} className="flex items-center gap-2">
          <span className={`${skeleton} h-6 w-6 shrink-0 rounded-full`} />
          <div className="flex flex-1 flex-col gap-1">
            <span className={`${skeleton} h-2.5 w-2/3`} />
            <span className={`${skeleton} h-2 w-1/3`} />
          </div>
          <span className="text-[10px] font-semibold text-brandCP">+— CP</span>
        </div>
      ))}
      <Title>Repository</Title>
      <Rows count={2} columns={2} />
    </div>
  );
}

function MetricsPreview() {
  const points = [0.42, 0.55, 0.61, 0.6, 0.72, 0.78];
  const path = points.map((value, index) => `${index === 0 ? 'M' : 'L'} ${10 + index * 20} ${44 - value * 40}`).join(' ');
  return (
    <div className={card}>
      <Title meta="version by version">Metrics</Title>
      <svg viewBox="0 0 120 48" className="h-16 w-full text-white/20" preserveAspectRatio="none">
        {[0.25, 0.5, 0.75].map((tick) => <line key={tick} x1={10} x2={110} y1={44 - tick * 40} y2={44 - tick * 40} stroke="currentColor" strokeWidth={0.5} strokeDasharray="2 3" />)}
        <path d={path} fill="none" stroke="var(--color-brandCP, #6366f1)" strokeWidth={1.5} />
      </svg>
      <div className="grid grid-cols-2 gap-2">
        {['Dataset', 'Model'].map((kind) => (
          <div key={kind} className="flex flex-col gap-1 rounded-lg border border-white/[0.06] p-2">
            <span className="text-[10px] text-white/45">{kind}</span>
            <span className={`${skeleton} h-2 w-2/3`} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ParticipantsPreview({ block }: { block: BlockView }) {
  return (
    <div className={card}>
      <Title meta={block.props.workspace_status === true ? 'with workspace status' : undefined}>Participants</Title>
      {Array.from({ length: 3 }, (_, row) => (
        <div key={row} className="flex items-center gap-2">
          <span className={`${skeleton} h-6 w-6 shrink-0 rounded-full`} />
          <span className={`${skeleton} h-2.5 w-1/4`} />
          <span className={`${skeleton} ml-auto h-1.5 w-1/3`} />
          <span className="text-[10px] text-white/40">—%</span>
        </div>
      ))}
    </div>
  );
}

/** Le nom lisible d'une ressource désignée par un argument, ou l'argument manquant. */
function resourceArg(block: BlockView, name: string) {
  return typeof block.props[name] === 'string' ? humanize(block.props[name] as string) : null;
}

function WalkthroughPreview({ block }: { block: BlockView }) {
  const { model } = useEditor();
  const stepsType = typeof block.props.steps === 'string' ? block.props.steps : null;
  const apps = resourceArg(block, 'targets');
  return (
    <div className={card}>
      <div className="flex items-baseline gap-1.5 rounded-lg border border-brandCP/[0.22] px-3 py-2">
        <span className="text-lg font-semibold text-white">—</span>
        <span className="text-[10px] font-bold text-brandCP">CP left</span>
        <span className="ml-auto text-[10px] text-white/40">per completed walkthrough</span>
      </div>
      {Array.from({ length: 2 }, (_, row) => (
        <div key={row} className="flex items-center gap-2 rounded-lg border border-white/[0.06] px-3 py-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brandCP/10 text-[9px] font-bold text-brandCP">AB</span>
          <div className="flex flex-1 flex-col gap-1">
            <span className={`${skeleton} h-2.5 w-1/3`} />
            <span className={`${skeleton} h-2 w-1/2`} />
          </div>
          <span className="rounded-full bg-brandCP/10 px-2 py-0.5 text-[10px] font-semibold text-brandCP">Start</span>
        </div>
      ))}
      <span className="text-[10px] text-white/40">
        {apps ?? 'Apps?'} · {stepsType ? `${humanize(stepsType)} in order` : 'Steps?'} · {model.lanes.filter((lane) => ['open', 'record', 'complete'].some((name) => block.props[name] === lane.id)).length}/3 lanes
      </span>
    </div>
  );
}

function TargetsPreview({ block }: { block: BlockView }) {
  return (
    <div className={card}>
      <Title meta={block.props.withdraw ? 'expose · withdraw' : 'expose'}>{resourceArg(block, 'targets') ?? 'Targets'}</Title>
      <div className="flex gap-2">
        <span className="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-[10px] text-white/35">Pick a submission…</span>
        <span className="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-[10px] text-white/35">https://</span>
        <span className="rounded-lg bg-brandCP/15 px-2 py-1.5 text-[10px] font-semibold text-brandCP">Add</span>
      </div>
      <Rows count={3} columns={3} />
    </div>
  );
}

function StepsPreview({ block }: { block: BlockView }) {
  return (
    <div className={card}>
      <Title meta="ordered · frozen by the first walkthrough">{resourceArg(block, 'steps') ?? 'Steps'}</Title>
      {Array.from({ length: 3 }, (_, row) => (
        <div key={row} className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-white/30">{String(row + 1).padStart(2, '0')}</span>
          <span className={`${skeleton} h-2.5 flex-1`} />
          <span className="text-[10px] text-white/30">↑ ↓ ✕</span>
        </div>
      ))}
      <span className="rounded-lg border border-dashed border-white/15 px-2 py-1.5 text-[10px] text-white/35">+ New step</span>
    </div>
  );
}

function WalkthroughsPreview({ block }: { block: BlockView }) {
  const marks = ['bg-green-500/60', 'bg-green-500/60', 'bg-red-500/60', 'bg-amber-500/60', 'bg-white/15'];
  return (
    <div className={card}>
      <Title meta={`${resourceArg(block, 'targets') ?? 'apps'} · ${resourceArg(block, 'steps') ?? 'steps'}`}>Walkthroughs</Title>
      {Array.from({ length: 3 }, (_, row) => (
        <div key={row} className="flex items-center gap-2">
          <span className={`${skeleton} h-2.5 w-1/4`} />
          <span className="flex gap-1">
            {marks.map((mark, index) => <span key={index} className={`h-2.5 w-2.5 rounded-sm ${mark}`} />)}
          </span>
          <span className="ml-auto rounded-full bg-green-500/15 px-2 py-0.5 text-[9px] font-bold text-green-400">Completed</span>
        </div>
      ))}
    </div>
  );
}

function ProjectPreview() {
  return (
    <div className={card}>
      <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] px-3 py-2">
        <span className={`${skeleton} h-4 w-4 rounded`} />
        <span className={`${skeleton} h-2.5 w-1/3`} />
        <span className="ml-auto rounded-full bg-green-500/15 px-2 py-0.5 text-[9px] font-bold text-green-400">ready</span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-3 gap-2">
        {['To do', 'Doing', 'Done'].map((column, index) => (
          <div key={column} className="flex flex-col gap-1.5 rounded-lg bg-white/[0.03] p-2">
            <span className="text-[10px] font-semibold text-white/45">{column}</span>
            {Array.from({ length: 2 - (index % 2) }, (_, row) => <span key={row} className={`${skeleton} h-5`} />)}
          </div>
        ))}
      </div>
      <span className="w-fit rounded-lg bg-brandCP/15 px-3 py-1 text-[10px] font-semibold text-brandCP">Launch evaluation</span>
    </div>
  );
}

function SubmissionsPreview() {
  const steps = ['Dataset', 'Model', 'API'];
  return (
    <div className={card}>
      <div className="flex items-center px-4">
        {steps.map((step, index) => (
          <div key={step} className="flex flex-1 items-center last:flex-none">
            <span className={`flex h-7 w-7 items-center justify-center rounded-full border-2 text-[9px] font-semibold ${index === 0 ? 'border-brandCP text-brandCP' : 'border-white/15 text-white/40'}`}>{index + 1}</span>
            {index < steps.length - 1 && <span className="mx-2 h-px flex-1 bg-white/[0.08]" />}
          </div>
        ))}
      </div>
      <Title meta="Kaggle · GitHub">Submission</Title>
      <div className="flex gap-2">
        <span className="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-[10px] text-white/35">https://www.kaggle.com/…</span>
        <span className="rounded-lg bg-brandCP/15 px-2 py-1.5 text-[10px] font-semibold text-brandCP">Submit</span>
      </div>
      <Rows count={1} columns={2} />
    </div>
  );
}

function SubmissionListPreview() {
  return (
    <div className={card}>
      {['Dataset', 'Model'].map((step) => (
        <div key={step} className="flex flex-col gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-white/40">{step}</span>
          <Rows count={2} columns={2} />
        </div>
      ))}
    </div>
  );
}

function ComputePreview() {
  return (
    <div className={card}>
      <Title meta="compute extension">GPU compute</Title>
      <div className="flex items-center gap-2">
        <span className="rounded-lg bg-brandCP/15 px-3 py-1 text-[10px] font-semibold text-brandCP">Request a GPU</span>
        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[9px] font-bold text-amber-300">Pending approval</span>
      </div>
    </div>
  );
}

function AnnotationPreview() {
  return (
    <div className={card}>
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg" style={{ backgroundImage: 'repeating-linear-gradient(135deg, rgb(255 255 255 / 0.05) 0 8px, transparent 8px 16px)' }}>
        <span className="font-mono text-[10px] text-white/40">image_url</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {['Option A', 'Option B', 'Skip'].map((option, index) => (
          <span key={option} className={`rounded-full border px-2.5 py-1 text-[10px] ${index === 2 ? 'border-white/10 text-white/40' : 'border-brandCP/40 text-brandCP'}`}>{option}</span>
        ))}
      </div>
    </div>
  );
}

function CampaignPreview() {
  return (
    <div className={card}>
      <div className="grid grid-cols-2 gap-2">
        {['Import items', 'Import golds'].map((label) => (
          <span key={label} className="rounded-lg border border-dashed border-white/15 px-2 py-2 text-center text-[10px] text-white/40">{label}</span>
        ))}
      </div>
      <Title meta="labeled · contested">Progress</Title>
      <span className={`${skeleton} h-1.5 w-full`} />
      <Rows count={2} columns={3} />
    </div>
  );
}

export function BlockPreview({ block, surface }: { block: BlockView; surface: TemplateSurface | null }) {
  switch (block.component) {
    case 'project':
      return <ProjectPreview />;
    case 'submissions':
      return <SubmissionsPreview />;
    case 'submission_list':
      return <SubmissionListPreview />;
    case 'compute':
      return <ComputePreview />;
    case 'annotation':
      return <AnnotationPreview />;
    case 'campaign':
      return <CampaignPreview />;
    case 'walkthrough':
      return <WalkthroughPreview block={block} />;
    case 'targets':
      return <TargetsPreview block={block} />;
    case 'steps':
      return <StepsPreview block={block} />;
    case 'walkthroughs':
      return <WalkthroughsPreview block={block} />;
    case 'pool':
      return <PoolPreview />;
    case 'activity':
      return <ActivityPreview block={block} />;
    case 'metrics':
      return <MetricsPreview />;
    case 'participants':
      return <ParticipantsPreview block={block} />;
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
