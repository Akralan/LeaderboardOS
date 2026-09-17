'use client';

import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { GitBranchPlus, Lock, Maximize2, Minus, Plus, Trash2 } from 'lucide-react';
import { ADVISORY_HUE, ERROR_HUE, FAMILIES } from './families';
import { useEditor } from './EditorContext';
import { addBranch, removeAt } from './mutations';
import { pathKey, type Branch, type CanvasLane, type CanvasNode, type Path, type SeqItem } from './model';

/**
 * Le canevas
 * ----------
 * Des lanes côte à côte, chacune un rail vertical : l'entrée, puis la
 * séquence. Le seul embranchement est la Gate de routage, dont les branches
 * se rejoignent toujours plus bas — l'éditeur dessine la jonction. Pas de
 * câbles de données : le rail est la séquence, les liens pointillés vont d'un
 * Assess à l'aggregate qu'il alimente.
 */

const DRAG_TYPE = 'application/x-leaderboard-graph';

export function Canvas({ zoom, setZoom }: { zoom: number; setZoom: (zoom: number) => void }) {
  const { model, readOnly, addLane, select } = useEditor();
  const scroller = useRef<HTMLDivElement>(null);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  // Ctrl + molette : le zoom, sans zoomer la page.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom(Math.min(1.4, Math.max(0.4, Math.round((zoom - event.deltaY * 0.0015) * 100) / 100)));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [setZoom, zoom]);

  const aggregatesByLane = new Map<number, typeof model.aggregates>();
  for (const aggregate of model.aggregates) {
    const emitter = [...model.nodes.values()].find((node) => node.emitsTo === aggregate.id && node.laneIndex !== null);
    if (!emitter || emitter.laneIndex === null) continue;
    aggregatesByLane.set(emitter.laneIndex, [...(aggregatesByLane.get(emitter.laneIndex) ?? []), aggregate]);
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        id="graph-canvas"
        className="min-h-0 flex-1 cursor-grab overflow-auto active:cursor-grabbing"
        style={{
          backgroundImage: 'radial-gradient(color-mix(in srgb, var(--foreground) 9%, transparent) 1px, transparent 1px)',
          backgroundSize: `${22 * zoom}px ${22 * zoom}px`,
        }}
        onPointerDown={(event) => {
          if (event.target !== event.currentTarget && !(event.target as HTMLElement).dataset.canvasBackground) return;
          pan.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!pan.current) return;
          event.currentTarget.scrollLeft = pan.current.left - (event.clientX - pan.current.x);
          event.currentTarget.scrollTop = pan.current.top - (event.clientY - pan.current.y);
        }}
        onPointerUp={() => (pan.current = null)}
        onClick={(event) => {
          // Un clic sur le fond relâche la sélection et rend les déclarations.
          if (event.target === event.currentTarget || (event.target as HTMLElement).dataset.canvasBackground) select(null);
        }}
      >
        <div data-canvas-background="1" className="flex min-w-max items-start gap-9 px-8 pb-24 pt-7" style={{ zoom }}>
          {model.lanes.map((lane) => (
            <LaneColumn key={lane.index} lane={lane} aggregates={aggregatesByLane.get(lane.index) ?? []} />
          ))}
          {!readOnly && <NewLane empty={model.lanes.length === 0} onAdd={addLane} />}
        </div>
      </div>
      <Minimap scroller={scroller} zoom={zoom} setZoom={setZoom} />
    </div>
  );
}

function LaneColumn({ lane, aggregates }: { lane: CanvasLane; aggregates: { id: string; node: CanvasNode; emitters: string[] }[] }) {
  const { readOnly, apply, source, laneIssues, select, selected } = useEditor();
  const issues = laneIssues.get(lane.index) ?? [];
  return (
    <div data-lane={lane.index} className="group/lane flex w-[272px] shrink-0 flex-col gap-2.5">
      <div className="flex items-start gap-2 pl-0.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[13px] font-semibold tracking-tight text-white">{lane.title}</span>
          <span className="truncate text-[11px] text-white/40">{lane.subtitle}</span>
        </div>
        {!readOnly && (
          <button
            type="button"
            title="Delete this lane"
            onClick={() => {
              if (window.confirm(`Delete the lane “${lane.title}” and its ${lane.order.length - 1} node(s)?`)) {
                if (selected && lane.order.includes(selected)) select(null);
                apply(removeAt(source, ['lanes', lane.index]));
              }
            }}
            className="ml-auto rounded p-1 text-transparent transition-colors hover:bg-foreground/[0.06] hover:!text-red-400 group-hover/lane:text-foreground/30"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {issues.length > 0 && (
        <div className="rounded-lg border border-red-400/30 bg-red-500/[0.07] px-2.5 py-1.5 text-[11px] leading-snug text-red-300">{issues[0].message}</div>
      )}
      <div className="flex flex-col items-stretch">
        <NodeCard node={lane.entry} draggable={false} />
        <Sequence items={lane.items} seqPath={lane.nodesPath} />
        {aggregates.map((aggregate) => (
          <div key={aggregate.id} className="flex flex-col items-stretch">
            <div className="flex h-6 justify-center">
              <span className="h-full border-l-2 border-dashed" style={{ borderColor: `${FAMILIES.aggregate.hue}80` }} />
            </div>
            <NodeCard node={aggregate.node} draggable={false} footer={`${aggregate.emitters.length} emit link${aggregate.emitters.length === 1 ? '' : 's'} · from ${aggregate.emitters.join(', ')}`} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Sequence({ items, seqPath, inBranch }: { items: SeqItem[]; seqPath: Path; inBranch?: boolean }) {
  return (
    <>
      {items.map((item, index) => (
        <div key={item.node.key} className="flex flex-col items-stretch">
          <DropSlot seqPath={seqPath} index={index} />
          {item.kind === 'node' ? <NodeCard node={item.node} /> : <Routing node={item.node} branches={item.branches} />}
        </div>
      ))}
      <DropSlot seqPath={seqPath} index={items.length} tail empty={items.length === 0} inBranch={inBranch} />
    </>
  );
}

function Routing({ node, branches }: { node: CanvasNode; branches: Branch[] }) {
  const { readOnly, apply, source } = useEditor();
  return (
    <div className="flex flex-col items-stretch">
      <NodeCard node={node} />
      <div className="mt-2 flex items-stretch gap-2.5">
        {branches.map((branch) => (
          <div key={pathKey(branch.path)} className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-1.5">
              <span className="h-3 w-0.5" style={{ background: `${FAMILIES.gate.hue}90` }} />
              <span
                title={branch.label}
                className="truncate rounded px-1.5 py-px font-mono text-[10px] font-medium"
                style={{ background: `${FAMILIES.gate.hue}1f`, color: FAMILIES.gate.hue }}
              >
                {branch.isElse ? 'else' : branch.label}
              </span>
            </div>
            <Sequence items={branch.items} seqPath={branch.nodesPath} inBranch />
          </div>
        ))}
        {!readOnly && (
          <button
            type="button"
            title="Add a branch"
            onClick={() => apply(addBranch(source, [...node.path, 'gate']))}
            className="flex w-7 shrink-0 items-start justify-center rounded-lg border border-dashed border-white/10 pt-1.5 text-white/30 transition-colors hover:border-amber-400/50 hover:text-amber-300"
          >
            <GitBranchPlus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="mt-1.5 flex h-5 items-center">
        <span className="h-0.5 flex-1 rounded-full bg-white/15" />
        <span className="px-2 text-[10px] text-white/35">reconverge</span>
        <span className="h-0.5 flex-1 rounded-full bg-white/15" />
      </div>
    </div>
  );
}

/** Un point du rail où déposer : la palette y insère, un nœud y déménage. */
function DropSlot({ seqPath, index, tail, empty, inBranch }: { seqPath: Path; index: number; tail?: boolean; empty?: boolean; inBranch?: boolean }) {
  const { readOnly, drop, refusal } = useEditor();
  const [over, setOver] = useState(false);
  const slot = `${pathKey(seqPath)}#${index}`;
  const refused = refusal?.slot === slot ? refusal.message : null;

  const handlers = readOnly
    ? {}
    : {
        onDragOver: (event: DragEvent) => {
          if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
          event.preventDefault();
          setOver(true);
        },
        onDragLeave: () => setOver(false),
        onDrop: (event: DragEvent) => {
          event.preventDefault();
          setOver(false);
          drop(slot, seqPath, index);
        },
      };

  if (tail && !empty) {
    return (
      <div {...handlers} className="flex flex-col items-stretch">
        <div className={`flex justify-center transition-all ${over ? 'h-12' : 'h-4'}`}>
          {over ? <span className="w-full rounded-lg border border-dashed border-brandCP/60 bg-brandCP/[0.06]" /> : <span className="h-full w-0.5 bg-white/[0.07]" />}
        </div>
        {refused && <Refusal message={refused} />}
      </div>
    );
  }

  if (empty) {
    return (
      <div {...handlers} className="mt-1.5 flex flex-col items-stretch">
        <div
          className={`flex min-h-[44px] items-center justify-center rounded-lg border border-dashed px-2 text-center text-[11px] transition-colors ${
            over ? 'border-brandCP/60 bg-brandCP/[0.06] text-brandCP' : 'border-white/10 text-white/30'
          }`}
        >
          {readOnly ? (inBranch ? 'passes through' : 'no node yet') : inBranch ? 'empty branch — drop a node' : 'drop a node from the palette'}
        </div>
        {refused && <Refusal message={refused} />}
      </div>
    );
  }

  return (
    <div {...handlers} className="flex flex-col items-stretch">
      <div className={`flex justify-center transition-all ${over ? 'h-12 py-1' : 'h-[18px]'}`}>
        {over ? <span className="w-full rounded-lg border border-dashed border-brandCP/60 bg-brandCP/[0.06]" /> : <span className="h-full w-0.5 bg-white/[0.16]" />}
      </div>
      {refused && <Refusal message={refused} />}
    </div>
  );
}

function Refusal({ message }: { message: string }) {
  return (
    <div className="animate-[gz-shake_320ms_ease-out_1] mb-1.5 flex flex-col gap-1">
      <span className="ml-3 h-3 border-l-2 border-dashed border-red-400" />
      <div className="flex flex-col gap-0.5 rounded-lg border border-red-400/35 bg-red-500/[0.09] px-2.5 py-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-red-400">Wire refused</span>
        <span className="text-[11px] leading-snug text-red-200">{message}</span>
      </div>
    </div>
  );
}

export function NodeCard({ node, draggable = true, footer }: { node: CanvasNode; draggable?: boolean; footer?: ReactNode }) {
  const { selected, select, provenance, nodeIssues, readOnly, dragging, model } = useEditor();
  const info = node.family === 'unknown' ? null : FAMILIES[node.family];
  const hue = info?.hue ?? ERROR_HUE;
  const issues = nodeIssues.get(node.key) ?? [];
  const error = issues.find((issue) => issue.severity === 'error');
  const advisory = issues.find((issue) => issue.severity === 'advisory');
  const isSelected = selected === node.key;
  const isRead = provenance.has(node.key);
  const selectedNode = selected ? model.nodes.get(selected) : null;
  const emitTarget = selectedNode?.emitsTo && node.docKey === 'aggregate' && selectedNode.emitsTo === node.id;
  const dimmed = !!selected && !isSelected && !isRead && !emitTarget;

  const border = error ? ERROR_HUE : advisory ? `${ADVISORY_HUE}99` : isSelected ? 'var(--theme-primary)' : isRead || emitTarget ? 'color-mix(in srgb, var(--theme-primary) 55%, transparent)' : 'rgb(255 255 255 / 0.09)';
  const shadow = isSelected
    ? '0 0 0 3px color-mix(in srgb, var(--theme-primary) 22%, transparent)'
    : error
      ? `0 0 0 3px ${ERROR_HUE}26`
      : isRead || emitTarget
        ? '0 0 0 2px color-mix(in srgb, var(--theme-primary) 14%, transparent)'
        : 'none';

  return (
    <div
      id={`node-${node.key}`}
      role="button"
      tabIndex={-1}
      draggable={draggable && !readOnly && node.docKey !== null}
      onDragStart={(event) => {
        dragging.current = { kind: 'node', path: node.path };
        event.dataTransfer.setData(DRAG_TYPE, node.key);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => (dragging.current = null)}
      onClick={(event) => {
        event.stopPropagation();
        select(isSelected ? null : node.key);
      }}
      className="relative flex cursor-pointer flex-col gap-2 rounded-xl border px-3 py-2.5 transition-[opacity,box-shadow] duration-150"
      style={{
        borderColor: border,
        boxShadow: shadow,
        opacity: dimmed ? 0.42 : 1,
        background: node.docKey === 'aggregate' ? `color-mix(in srgb, ${hue} 7%, var(--background))` : 'color-mix(in srgb, var(--foreground) 3%, var(--background))',
      }}
    >
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: hue }} />
        <span className="text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: hue }}>
          {info?.label ?? 'Unreadable'}
        </span>
        {isRead && <span className="rounded bg-brandCP/15 px-1.5 text-[9px] font-semibold uppercase tracking-wider text-brandCP">read</span>}
        <span className="ml-auto truncate font-mono text-[11px] text-white/35">{node.badge}</span>
      </div>
      <span className="truncate font-mono text-sm font-medium tracking-tight text-white">{node.id}</span>
      {node.lines.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {node.lines.slice(0, 5).map((line, index) => (
            <div key={index} className="flex items-baseline gap-1.5 font-mono text-[11px]">
              <span className="shrink-0 text-white/55">{line.k}</span>
              <span className="h-px min-w-3 flex-1 bg-white/[0.08]" />
              <span className="truncate text-white/40" title={line.v}>
                {line.v}
              </span>
            </div>
          ))}
          {node.lines.length > 5 && <span className="font-mono text-[10px] text-white/30">+{node.lines.length - 5} more</span>}
        </div>
      )}
      {node.chips.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {node.chips.map((chip) => (
            <span
              key={chip.label}
              className={`rounded-md border px-1.5 py-px font-mono text-[10px] ${chip.tone === 'emit' ? 'border-dashed' : ''}`}
              style={
                chip.tone === 'emit'
                  ? { borderColor: `${FAMILIES.aggregate.hue}80`, color: FAMILIES.aggregate.hue, background: `${FAMILIES.aggregate.hue}12` }
                  : chip.tone === 'resource'
                    ? { borderColor: `${FAMILIES.act.hue}55`, color: FAMILIES.act.hue }
                    : { borderColor: 'rgb(255 255 255 / 0.1)', color: 'color-mix(in srgb, var(--foreground) 55%, transparent)' }
              }
            >
              {chip.label}
            </span>
          ))}
        </div>
      )}
      {(error || advisory) && (
        <div className={`flex items-start gap-1.5 rounded-lg px-2 py-1.5 ${error ? 'bg-red-500/[0.1] text-red-300' : 'bg-amber-400/[0.09] text-amber-200'}`}>
          <span className="shrink-0 text-[10px] font-bold">{error ? '!' : '~'}</span>
          <span className="text-[11px] leading-snug">
            {(error ?? advisory)!.message}
            {issues.length > 1 && <span className="opacity-60"> · +{issues.length - 1}</span>}
          </span>
        </div>
      )}
      {footer && <span className="border-t border-white/[0.06] pt-1.5 text-[10px] text-white/40">{footer}</span>}
    </div>
  );
}

function NewLane({ empty, onAdd }: { empty: boolean; onAdd: (trigger: 'user' | 'admin' | 'cron') => void }) {
  const { dragging } = useEditor();
  const [over, setOver] = useState(false);
  return (
    <div className="flex w-[272px] shrink-0 flex-col gap-2.5 opacity-90">
      <div className="flex flex-col gap-0.5 pl-0.5">
        <span className="text-[13px] font-semibold text-white/40">New lane</span>
        <span className="text-[11px] text-white/30">{empty ? 'a template starts with its first entry' : 'nothing here yet'}</span>
      </div>
      <div
        onDragOver={(event) => {
          if (dragging.current?.kind === 'palette' && dragging.current.family === 'entry') {
            event.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          onAdd('user');
        }}
        className={`flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-3 py-5 transition-colors ${
          over ? 'border-brandCP/60 bg-brandCP/[0.06]' : empty ? 'border-brandCP/30 bg-brandCP/[0.03]' : 'border-white/15 bg-white/[0.01]'
        }`}
      >
        <span className="text-[13px] font-semibold text-white/60">Add an entry</span>
        <span className="text-center text-[11px] text-white/35">a lane starts with who may run it</span>
        <div className="mt-1 flex gap-1.5">
          {(['user', 'admin', 'cron'] as const).map((trigger) => (
            <button
              key={trigger}
              type="button"
              onClick={() => onAdd(trigger)}
              className="rounded-md border border-white/10 px-2 py-1 text-[11px] font-medium text-white/60 transition-colors hover:border-brandCP/40 hover:text-brandCP"
            >
              {trigger}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Minimap({ scroller, zoom, setZoom }: { scroller: React.RefObject<HTMLDivElement | null>; zoom: number; setZoom: (zoom: number) => void }) {
  const { model, selected, nodeIssues } = useEditor();
  const scrollToLane = (index: number) => {
    const element = scroller.current?.querySelector(`[data-lane="${index}"]`);
    element?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  };
  const fit = () => {
    const element = scroller.current;
    if (!element) return;
    const content = element.firstElementChild as HTMLElement | null;
    const natural = content ? content.scrollWidth / zoom : element.clientWidth;
    setZoom(Math.max(0.5, Math.min(1, Math.floor((element.clientWidth / natural) * 100) / 100)));
    element.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
  };
  return (
    <div className="absolute bottom-3 right-3 flex flex-col gap-1.5 rounded-xl border border-white/10 p-2 shadow-xl backdrop-blur-md" style={{ background: 'color-mix(in srgb, var(--background) 88%, transparent)' }}>
      {model.lanes.length > 0 && (
        <div className="flex max-w-[220px] gap-1 overflow-hidden">
          {model.lanes.map((lane) => (
            <button key={lane.index} type="button" title={lane.title} onClick={() => scrollToLane(lane.index)} className="flex w-4 shrink-0 flex-col gap-0.5">
              {lane.order.map((key) => {
                const node = model.nodes.get(key)!;
                const hasError = nodeIssues.get(key)?.some((issue) => issue.severity === 'error');
                const color = hasError ? ERROR_HUE : node.family === 'unknown' ? ERROR_HUE : FAMILIES[node.family].hue;
                return <span key={key} className="h-1 rounded-[1px]" style={{ background: color, opacity: selected && selected !== key ? 0.45 : 0.9 }} />;
              })}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1 border-t border-white/[0.07] pt-1.5">
        <button type="button" title="Zoom out" onClick={() => setZoom(Math.max(0.4, Math.round((zoom - 0.1) * 10) / 10))} className="rounded p-0.5 text-white/40 hover:text-white">
          <Minus className="h-3 w-3" />
        </button>
        <span className="w-9 text-center text-[11px] tabular-nums text-white/50">{Math.round(zoom * 100)}%</span>
        <button type="button" title="Zoom in" onClick={() => setZoom(Math.min(1.4, Math.round((zoom + 0.1) * 10) / 10))} className="rounded p-0.5 text-white/40 hover:text-white">
          <Plus className="h-3 w-3" />
        </button>
        <button type="button" onClick={fit} className="ml-2 flex items-center gap-1 text-[11px] font-semibold text-brandCP hover:opacity-80">
          <Maximize2 className="h-3 w-3" />
          Auto-layout
        </button>
      </div>
    </div>
  );
}

export function PaletteItem({ family, onPick, locked }: { family: keyof typeof FAMILIES; onPick: () => void; locked?: boolean }) {
  const { dragging, readOnly } = useEditor();
  const info = FAMILIES[family];
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={!readOnly && !locked}
      onDragStart={(event) => {
        dragging.current = { kind: 'palette', family };
        event.dataTransfer.setData(DRAG_TYPE, family);
        event.dataTransfer.effectAllowed = 'copy';
      }}
      onDragEnd={() => (dragging.current = null)}
      onClick={() => !readOnly && onPick()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !readOnly) onPick();
      }}
      title={readOnly ? 'Read-only' : 'Drag onto a lane, or click to add after the selection'}
      className={`flex items-start gap-2.5 rounded-lg border border-transparent px-2.5 py-2 transition-colors ${
        readOnly ? 'cursor-default opacity-60' : 'cursor-grab hover:border-foreground/[0.08] hover:bg-foreground/[0.03]'
      }`}
    >
      <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: info.hue }} />
      <div className="flex min-w-0 flex-col gap-px">
        <span className="text-[13px] font-semibold tracking-tight text-white">{info.label}</span>
        <span className="text-[11px] leading-snug text-white/40">{info.role}</span>
      </div>
    </div>
  );
}

export function LockedPaletteItem({ label, tip }: { label: string; tip: string }) {
  return (
    <div title={tip} className="flex cursor-not-allowed items-center gap-2.5 rounded-lg px-2.5 py-2 opacity-45">
      <span className="h-2.5 w-2.5 shrink-0 rounded-[3px] bg-white/25" />
      <span className="text-[13px] font-medium text-white/70">{label}</span>
      <Lock className="ml-auto h-3 w-3 text-white/50" />
    </div>
  );
}
