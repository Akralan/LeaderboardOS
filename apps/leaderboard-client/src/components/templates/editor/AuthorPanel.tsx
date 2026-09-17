'use client';

import { useState } from 'react';
import { CheckCircle2, HelpCircle, Loader2, Sparkles, X } from 'lucide-react';
import type { Diagnostic } from './useTemplateDocument';

/**
 * Le panneau de l'agent auteur (note template-author §3, A3)
 * ----------------------------------------------------------
 * Une consigne → l'agent modifie le brouillon par éditions ciblées, le valide,
 * le répare, l'enregistre ; le canevas se redessine, et le changement
 * s'annule comme n'importe quel geste. Le rapport dit ce que l'agent a
 * supposé et ce qu'il n'a pas su trancher. L'agent ne publie jamais.
 */

export interface AuthorReport {
  choices: string[];
  openQuestions: string[];
  rounds: number;
  validAfterFirstRound: boolean;
  diagnostics: Diagnostic[];
  /** La description ou la consigne qui a produit ce rapport. */
  prompt: string;
  kind: 'author' | 'refine';
}

const STORAGE_PREFIX = 'template-author:';

/** Le rapport d'une création passe de la bibliothèque à l'éditeur par la session du navigateur. */
export function stashReport(key: string, report: AuthorReport) {
  try {
    sessionStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(report));
  } catch {
    // Sans stockage : l'éditeur s'ouvre sans rapport.
  }
}

export function takeStashedReport(key: string): AuthorReport | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    sessionStorage.removeItem(STORAGE_PREFIX + key);
    return JSON.parse(raw) as AuthorReport;
  } catch {
    return null;
  }
}

export function AuthorPanel({
  reports, busy, error, onRefine, onClose,
}: {
  reports: AuthorReport[];
  busy: boolean;
  error: string;
  onRefine: (instruction: string) => void;
  onClose: () => void;
}) {
  const [instruction, setInstruction] = useState('');
  const latest = reports.at(-1);
  const errors = latest?.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length ?? 0;

  const submit = () => {
    if (!instruction.trim() || busy) return;
    onRefine(instruction.trim());
    setInstruction('');
  };

  return (
    <div className="flex w-[340px] shrink-0 flex-col border-l border-white/[0.08]">
      <div className="flex items-center gap-2 border-b border-white/[0.07] px-4 py-2.5">
        <Sparkles className="h-3.5 w-3.5 text-brandCP" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/40">Template author</span>
        <button type="button" onClick={onClose} className="ml-auto rounded p-1 text-white/40 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 py-4">
        {reports.length === 0 && (
          <p className="text-xs leading-relaxed text-white/50">
            Tell the agent what to change — “make golds 20%”, “add an admin lane that settles contested items”, or describe a whole flow on an empty canvas. It edits this draft, validates it, repairs what fails, and saves. It never publishes.
          </p>
        )}

        {reports.map((report, index) => (
          <div key={index} className="flex flex-col gap-2.5">
            <div className="rounded-xl bg-foreground/[0.04] px-3 py-2 text-xs leading-relaxed text-white/75">
              <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-widest text-white/35">{report.kind === 'author' ? 'Described' : 'Asked'}</span>
              {report.prompt}
            </div>
            {index === reports.length - 1 && (
              <>
                <div className={`flex items-center gap-2 text-xs ${errors ? 'text-amber-300' : 'text-brandCP'}`}>
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {errors
                    ? `Saved with ${errors} problem${errors === 1 ? '' : 's'} after ${report.rounds} round${report.rounds === 1 ? '' : 's'} — see Problems`
                    : `Valid ${report.validAfterFirstRound ? 'at first try' : `after ${report.rounds} rounds`}`}
                </div>
                {report.choices.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35">Choices made</span>
                    <ul className="flex flex-col gap-1">
                      {report.choices.map((choice) => (
                        <li key={choice} className="flex gap-1.5 text-xs leading-snug text-white/65">
                          <span className="text-white/30">·</span>
                          {choice}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {report.openQuestions.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35">Open questions</span>
                    {report.openQuestions.map((question) => (
                      <button
                        key={question}
                        type="button"
                        title="Answer it"
                        onClick={() => setInstruction(`${question}\n→ `)}
                        className="flex gap-1.5 rounded-lg border border-amber-400/25 px-2.5 py-1.5 text-left text-xs leading-snug text-amber-200 hover:border-amber-400/50"
                      >
                        <HelpCircle className="mt-0.5 h-3 w-3 shrink-0" />
                        {question}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        ))}

        {busy && (
          <div className="flex items-center gap-2 text-xs text-white/50">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Drawing, validating, repairing… this can take a minute.
          </div>
        )}
        {error && <div className="rounded-lg border border-red-400/30 bg-red-500/[0.07] px-2.5 py-1.5 text-xs text-red-300">{error}</div>}
      </div>

      <div className="flex flex-col gap-2 border-t border-white/[0.07] p-3">
        <textarea
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
          }}
          rows={3}
          disabled={busy}
          placeholder="Change this draft…"
          className="w-full resize-none rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white placeholder:text-white/30 focus:border-brandCP/40 focus:outline-none"
        />
        <div className="flex items-center">
          <span className="text-[10px] text-white/30">Ctrl+Enter · undo reverts the change</span>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !instruction.trim()}
            className="ml-auto flex items-center gap-1.5 rounded-lg bg-brandCP px-3 py-1.5 text-xs font-semibold text-black hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
