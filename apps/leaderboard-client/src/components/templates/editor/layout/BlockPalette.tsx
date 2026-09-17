'use client';

import { Lock } from 'lucide-react';
import { uiComponentsFor, type UiComponentSpec } from '../../../../../../../packages/interpreter/ui/catalog';
import { useEditor } from '../EditorContext';
import { UI_COMPONENT_DRAG, layoutSourceOf, useLayoutActions } from './actions';

/**
 * La palette de la mise en page : les composants du catalogue que l'écran
 * en cours admet. Un composant unique déjà posé, ou qui demande une
 * déclaration absente (board, workspace), reste visible mais verrouillé.
 */

function lockOf(spec: UiComponentSpec, placed: readonly { component: string }[], source: ReturnType<typeof layoutSourceOf>): string | null {
  if (spec.single && placed.some((block) => block.component === spec.name)) return 'Already on this screen';
  if (spec.requires === 'board' && !source.board) return 'Needs presentation.board: true';
  if (spec.requires === 'workspace' && !source.workspace) return 'Needs a workspace declaration';
  return null;
}

export function BlockPalette() {
  const { model, readOnly, screen } = useEditor();
  const { blocks, addBlock } = useLayoutActions();
  const source = layoutSourceOf(model);
  const placed = blocks ?? [];
  return (
    <div className="flex flex-col gap-0.5 px-2 pb-3">
      {uiComponentsFor(screen).map((spec) => {
        const lock = lockOf(spec, placed, source);
        const disabled = readOnly || lock !== null;
        return (
          <div
            key={spec.name}
            role="button"
            tabIndex={0}
            draggable={!disabled}
            onDragStart={(event) => {
              event.dataTransfer.setData(UI_COMPONENT_DRAG, spec.name);
              event.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => !disabled && addBlock(spec.name)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !disabled) addBlock(spec.name);
            }}
            title={readOnly ? 'Read-only' : lock ?? 'Drag onto the screen, or click to place it in the first free spot'}
            className={`flex items-start gap-2.5 rounded-lg border border-transparent px-2.5 py-2 transition-colors ${
              disabled ? 'cursor-default opacity-50' : 'cursor-grab hover:border-foreground/[0.08] hover:bg-foreground/[0.03]'
            }`}
          >
            <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-[3px] bg-brandCP/70" />
            <div className="flex min-w-0 flex-col gap-px">
              <span className="flex items-center gap-1.5 text-[13px] font-semibold tracking-tight text-white">
                {spec.label}
                {lock && <Lock className="h-3 w-3 text-white/40" />}
              </span>
              <span className="text-[11px] leading-snug text-white/40">{spec.role}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
