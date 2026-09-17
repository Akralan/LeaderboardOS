'use client';

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { LayoutTemplate } from 'lucide-react';
import { describeTemplate, type TemplateSurface } from '../../../../../../../packages/interpreter/describe';
import { uiComponent, UI_COLUMNS } from '../../../../../../../packages/interpreter/ui/catalog';
import { clampPlacement, heightOf } from '../../../../../../../packages/interpreter/ui/layout';
import { useToast } from '@/components/ui/Toast';
import { useEditor } from '../EditorContext';
import type { BlockView } from '../model';
import { UI_COMPONENT_DRAG, useLayoutActions } from './actions';
import { BlockPreview } from './previews';

/**
 * La grille d'un écran composé
 * ----------------------------
 * Douze colonnes, des lignes d'une hauteur fixe ; chaque bloc est posé en
 * absolu à sa place, avec la prévisualisation de son composant. On le
 * déplace en le tirant, on le redimensionne par son coin ; le geste s'écrit
 * dans le document au relâcher, aimanté à la grille, refusé s'il recouvre un
 * autre bloc. Un composant de la palette se dépose là où on le lâche.
 */

const ROW = 44;
const GAP = 12;
const MIN_ROWS = 10;

type Gesture = { key: string; mode: 'move' | 'resize'; startX: number; startY: number; origin: BlockView['at']; current: BlockView['at'] };

export function LayoutEditor() {
  const { source, templateKey, model, readOnly, screen, selectedBlock, selectBlock, blockIssues } = useEditor();
  const { blocks, addBlock, placeBlock, startScreen } = useLayoutActions();
  const toast = useToast();
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [over, setOver] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // La surface du brouillon, pour les prévisualisations de lanes ; nulle tant qu'il ne valide pas.
  const surface: TemplateSurface | null = useMemo(() => {
    try {
      return describeTemplate(source, templateKey).surface;
    } catch {
      return null;
    }
  }, [source, templateKey]);

  const column = width > 0 ? (width - GAP * (UI_COLUMNS - 1)) / UI_COLUMNS : 0;
  const rows = Math.max(MIN_ROWS, heightOf(blocks ?? []) + 3);
  const height = rows * ROW + (rows - 1) * GAP;

  const cellOf = (clientX: number, clientY: number) => {
    const rect = container.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: Math.floor((clientX - rect.left) / (column + GAP)), y: Math.floor((clientY - rect.top) / (ROW + GAP)) };
  };
  const rectOf = (at: BlockView['at']) => ({
    left: at.x * (column + GAP),
    top: at.y * (ROW + GAP),
    width: at.w * column + (at.w - 1) * GAP,
    height: at.h * ROW + (at.h - 1) * GAP,
  });

  const begin = (event: ReactPointerEvent, block: BlockView, mode: Gesture['mode']) => {
    if (readOnly || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    selectBlock(block.key);
    setGesture({ key: block.key, mode, startX: event.clientX, startY: event.clientY, origin: block.at, current: block.at });
  };

  const move = (event: ReactPointerEvent) => {
    if (!gesture || column <= 0) return;
    const dx = Math.round((event.clientX - gesture.startX) / (column + GAP));
    const dy = Math.round((event.clientY - gesture.startY) / (ROW + GAP));
    const block = blocks?.find((candidate) => candidate.key === gesture.key);
    if (!block) return;
    const wanted = gesture.mode === 'move' ? { ...gesture.origin, x: gesture.origin.x + dx, y: gesture.origin.y + dy } : { ...gesture.origin, w: gesture.origin.w + dx, h: gesture.origin.h + dy };
    const current = clampPlacement(wanted, block.component);
    if (current.x !== gesture.current.x || current.y !== gesture.current.y || current.w !== gesture.current.w || current.h !== gesture.current.h) {
      setGesture({ ...gesture, current });
    }
  };

  const end = () => {
    if (!gesture) return;
    const block = blocks?.find((candidate) => candidate.key === gesture.key);
    setGesture(null);
    if (!block) return;
    const refused = placeBlock(block, gesture.current);
    if (refused) toast(refused, 'error');
  };

  const dropSpec = (event: React.DragEvent) => (event.dataTransfer.types.includes(UI_COMPONENT_DRAG) ? uiComponent(event.dataTransfer.getData(UI_COMPONENT_DRAG) || '') : undefined);

  if (blocks === null) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto p-8"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(UI_COMPONENT_DRAG) && !readOnly) event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          const name = event.dataTransfer.getData(UI_COMPONENT_DRAG);
          if (name) addBlock(name);
        }}
      >
        <span className="text-sm font-medium text-white/70">The {screen} screen is generated.</span>
        <span className="max-w-[420px] text-center text-xs leading-relaxed text-white/40">
          Start from what the client stacks today, then move and resize the blocks — or drop a component from the palette to compose it from scratch.
        </span>
        {!readOnly && (
          <button type="button" onClick={startScreen} className="flex items-center gap-1.5 rounded-lg bg-brandCP px-3.5 py-2 text-xs font-semibold text-black hover:opacity-90">
            <LayoutTemplate className="h-3.5 w-3.5" /> Start from the generated screen
          </button>
        )}
      </div>
    );
  }

  const guides = column > 0 ? `repeating-linear-gradient(to right, rgb(255 255 255 / 0.035) 0 ${column}px, transparent ${column}px ${column + GAP}px)` : undefined;

  return (
    <div className="min-h-0 flex-1 overflow-auto" onClick={() => selectBlock(null)}>
      <div className="mx-auto w-full max-w-[1040px] px-6 py-6">
        <div
          ref={container}
          className="relative w-full select-none"
          style={{ height, backgroundImage: guides, backgroundSize: `${column + GAP}px ${ROW + GAP}px` }}
          onDragOver={(event) => {
            const spec = dropSpec(event);
            if (!spec || readOnly) return;
            event.preventDefault();
            const cell = cellOf(event.clientX, event.clientY);
            setOver(clampPlacement({ x: cell.x, y: cell.y, w: spec.size.w, h: spec.size.h }, spec.name));
          }}
          onDragLeave={() => setOver(null)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(null);
            const name = event.dataTransfer.getData(UI_COMPONENT_DRAG);
            if (!name) return;
            addBlock(name, cellOf(event.clientX, event.clientY));
          }}
        >
          {over && (
            <div className="pointer-events-none absolute rounded-[14px] border-2 border-dashed border-brandCP/60 bg-brandCP/[0.06]" style={rectOf(over)} />
          )}
          {blocks.map((block) => {
            const live = gesture?.key === block.key ? gesture.current : block.at;
            const selected = selectedBlock === block.key;
            const issues = blockIssues.get(block.key) ?? [];
            const tone = issues.some((issue) => issue.severity === 'error') ? 'border-red-400/70' : issues.length ? 'border-amber-300/60' : selected ? 'border-brandCP' : 'border-transparent hover:border-white/20';
            return (
              <div
                key={block.key}
                data-block={block.key}
                className={`absolute rounded-[16px] border-2 transition-[box-shadow] ${tone} ${gesture?.key === block.key ? 'z-20 shadow-2xl' : selected ? 'z-10' : ''} ${readOnly ? '' : 'cursor-grab active:cursor-grabbing'}`}
                style={rectOf(live)}
                onPointerDown={(event) => begin(event, block, 'move')}
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={end}
                onClick={(event) => {
                  event.stopPropagation();
                  selectBlock(block.key);
                }}
              >
                <div className="pointer-events-none h-full">
                  <BlockPreview block={block} surface={surface} />
                </div>
                <span className={`pointer-events-none absolute left-2 top-2 rounded-md px-1.5 py-px font-mono text-[10px] ${selected ? 'bg-brandCP text-black' : 'bg-black/50 text-white/70'}`}>
                  {block.id}
                </span>
                {!readOnly && (
                  <div
                    role="presentation"
                    className="absolute bottom-0 right-0 h-5 w-5 cursor-nwse-resize rounded-tl-md rounded-br-[14px] border-l border-t border-white/20 bg-white/10 hover:bg-brandCP/60"
                    onPointerDown={(event) => begin(event, block, 'resize')}
                    onPointerMove={move}
                    onPointerUp={end}
                    onPointerCancel={end}
                  />
                )}
              </div>
            );
          })}
          {blocks.length === 0 && (
            <span className="pointer-events-none absolute inset-x-0 top-10 text-center text-xs text-white/35">An empty screen — drop a component here.</span>
          )}
        </div>
      </div>
    </div>
  );
}
