'use client';

import { LayoutTemplate, RotateCcw } from 'lucide-react';
import { useEditor } from '../EditorContext';
import { UI_SCREENS, type UiScreen } from '../model';
import { useLayoutActions } from './actions';

/**
 * Le panneau d'un écran, quand aucun bloc n'est sélectionné : quel écran on
 * compose, son état (généré ou composé), et les deux gestes d'ensemble —
 * partir de la mise en page générée, y revenir.
 */

const LABELS: Record<UiScreen, { label: string; who: string }> = {
  contributor: { label: 'Contributor', who: 'what a participant sees on the challenge' },
  manage: { label: 'Manage', who: 'what a manager sees in the Manage tab' },
};

export function ScreenPanel() {
  const { model, readOnly, screen, setScreen, screenIssues } = useEditor();
  const { blocks, startScreen, resetScreen } = useLayoutActions();
  const issues = screenIssues.get(screen) ?? [];

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35">Screen</span>
        <div className="flex gap-1 rounded-lg bg-white/[0.04] p-1">
          {UI_SCREENS.map((candidate) => {
            const composed = model.screens[candidate] !== null;
            return (
              <button
                key={candidate}
                type="button"
                onClick={() => setScreen(candidate)}
                className={`flex flex-1 flex-col items-start rounded-md px-2.5 py-1.5 text-left ${screen === candidate ? 'bg-brandCP/15 text-brandCP' : 'text-white/55 hover:text-white'}`}
              >
                <span className="text-xs font-semibold">{LABELS[candidate].label}</span>
                <span className="text-[10px] opacity-70">{composed ? `composed · ${model.screens[candidate]!.length} block${model.screens[candidate]!.length === 1 ? '' : 's'}` : 'generated'}</span>
              </button>
            );
          })}
        </div>
        <span className="text-[11px] leading-snug text-white/40">{LABELS[screen].who}.</span>
      </div>

      {issues.length > 0 && (
        <div className="flex flex-col gap-1">
          {issues.map((issue, index) => (
            <div key={index} className={`rounded-lg border px-2.5 py-1.5 text-[11px] leading-snug ${issue.severity === 'error' ? 'border-red-400/30 bg-red-500/[0.07] text-red-300' : 'border-amber-400/30 bg-amber-400/[0.06] text-amber-200'}`}>
              <span className="font-mono opacity-70">{issue.path}</span> — {issue.message}
            </div>
          ))}
        </div>
      )}

      {blocks === null ? (
        <div className="flex flex-col gap-2 rounded-xl border border-white/[0.08] p-3">
          <span className="text-xs font-medium text-white/80">This screen is generated.</span>
          <span className="text-[11px] leading-relaxed text-white/45">
            The client stacks the lanes and the panels this template declares. Compose it to place them yourself: start from that stack, or drop a component on the empty grid.
          </span>
          {!readOnly && (
            <button type="button" onClick={startScreen} className="mt-1 flex w-fit items-center gap-1.5 rounded-lg bg-brandCP px-3 py-1.5 text-xs font-semibold text-black hover:opacity-90">
              <LayoutTemplate className="h-3.5 w-3.5" /> Start from the generated screen
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-xl border border-white/[0.08] p-3">
          <span className="text-xs font-medium text-white/80">This screen is composed.</span>
          <span className="text-[11px] leading-relaxed text-white/45">
            Drag a block to move it, its corner to resize it, click it for its arguments. Twelve columns; on a phone the blocks stack in reading order.
          </span>
          {!readOnly && (
            <button type="button" onClick={resetScreen} className="mt-1 flex w-fit items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70 hover:bg-foreground/[0.04]">
              <RotateCcw className="h-3.5 w-3.5" /> Back to the generated screen
            </button>
          )}
        </div>
      )}
    </div>
  );
}
