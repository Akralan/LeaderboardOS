'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { parse, stringify } from 'yaml';
import type { ContextEntry } from './model';
import type { Diagnostic } from './useTemplateDocument';

/**
 * Les contrôles de l'inspecteur
 * -----------------------------
 * Chaque contrôle garde sa saisie en local et l'écrit dans le document après
 * une courte pause (ou à la sortie du champ) : une frappe n'est pas une entrée
 * d'historique, et la validation revient pendant qu'on tape. Une valeur
 * changée ailleurs (annuler, le canevas) remplace la saisie tant que le champ
 * n'a pas le focus.
 */

export const inputClass =
  'w-full rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 font-mono text-xs text-white placeholder:text-white/25 focus:border-brandCP/40 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60';

export const labelClass = 'text-[11px] font-semibold text-white/70';

const COMMIT_DELAY = 350;

function useDraftValue(value: string, onCommit: (next: string) => void) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(onCommit);
  latest.current = onCommit;

  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const flush = (next: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (next !== value) latest.current(next);
  };
  return {
    draft,
    change(next: string) {
      setDraft(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => flush(next), COMMIT_DELAY);
    },
    focus() {
      focused.current = true;
    },
    blur(current: string) {
      focused.current = false;
      flush(current);
    },
  };
}

export function FieldShell({ label, type, hint, issues, children }: { label: string; type?: string; hint?: string; issues?: Diagnostic[]; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className={labelClass}>{label}</span>
        {type && <span className="rounded bg-white/[0.05] px-1.5 py-px font-mono text-[10px] text-white/40">{type}</span>}
        {hint && <span className="ml-auto truncate text-[10px] text-white/30">{hint}</span>}
      </div>
      {children}
      {issues?.map((issue, index) => (
        <span key={index} className={`text-[11px] leading-snug ${issue.severity === 'error' ? 'text-red-400' : 'text-amber-300'}`}>
          {issue.message}
        </span>
      ))}
    </div>
  );
}

export function TextInput({ value, onCommit, placeholder, disabled, invalid }: { value: string; onCommit: (next: string) => void; placeholder?: string; disabled?: boolean; invalid?: boolean }) {
  const state = useDraftValue(value, onCommit);
  return (
    <input
      className={`${inputClass} ${invalid ? '!border-red-400/60' : ''}`}
      value={state.draft}
      placeholder={placeholder}
      disabled={disabled}
      onFocus={state.focus}
      onChange={(event) => state.change(event.target.value)}
      onBlur={(event) => state.blur(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
      }}
    />
  );
}

/** Le jeton en cours de frappe : `grade.` dans `params.rate * grade.`. */
function tokenBefore(text: string, caret: number): { token: string; start: number } {
  const before = text.slice(0, caret);
  const match = /[a-z_][a-z0-9_.]*$/i.exec(before);
  return match ? { token: match[0], start: caret - match[0].length } : { token: '', start: caret };
}

/** Une expression : autocomplétion typée sur le contexte en amont, erreurs en ligne. */
export function ExpressionInput({
  value, onCommit, context, placeholder, disabled, invalid, multiline,
}: {
  value: string;
  onCommit: (next: string) => void;
  context: ContextEntry[];
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  multiline?: boolean;
}) {
  const state = useDraftValue(value, onCommit);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const { token, start } = tokenBefore(state.draft, caret);
  const suggestions = useMemo(() => {
    if (!token) return [];
    return context.filter((entry) => entry.path.startsWith(token) && entry.path !== token).slice(0, 8);
  }, [context, token]);
  const showing = open && suggestions.length > 0;

  const accept = (entry: ContextEntry) => {
    const next = state.draft.slice(0, start) + entry.path + state.draft.slice(caret);
    state.change(next);
    const position = start + entry.path.length;
    setCaret(position);
    requestAnimationFrame(() => ref.current?.setSelectionRange(position, position));
    setActive(0);
  };

  const common = {
    ref,
    className: `${inputClass} ${invalid ? '!border-red-400/60 !bg-red-500/[0.06]' : ''} ${multiline ? 'min-h-[64px] resize-y leading-relaxed' : ''}`,
    value: state.draft,
    placeholder,
    disabled,
    spellCheck: false,
    onFocus: () => {
      state.focus();
      setOpen(true);
    },
    onBlur: (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setOpen(false);
      state.blur(event.target.value);
    },
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      state.change(event.target.value);
      setCaret(event.target.selectionStart ?? event.target.value.length);
      setOpen(true);
      setActive(0);
    },
    onSelect: (event: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => setCaret((event.target as HTMLInputElement).selectionStart ?? 0),
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (showing) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActive((index) => (index + 1) % suggestions.length);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActive((index) => (index - 1 + suggestions.length) % suggestions.length);
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          accept(suggestions[Math.min(active, suggestions.length - 1)]);
          return;
        }
        if (event.key === 'Escape') {
          event.stopPropagation();
          setOpen(false);
          return;
        }
      }
      if (event.key === 'Enter' && !multiline) (event.target as HTMLInputElement).blur();
    },
  };

  return (
    <div className="relative">
      {multiline ? <textarea {...common} /> : <input {...common} />}
      {showing && (
        <div className="animate-pop-in absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-white/10 bg-background shadow-2xl">
          <div className="bg-white/[0.03] px-2.5 py-1 text-[10px] uppercase tracking-widest text-white/30">upstream context</div>
          {suggestions.map((entry, index) => (
            <button
              key={entry.path}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                accept(entry);
              }}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left ${index === active ? 'bg-brandCP/10' : 'hover:bg-foreground/[0.04]'}`}
            >
              <span className="truncate font-mono text-xs text-white">{entry.path}</span>
              <span className="ml-auto shrink-0 font-mono text-[10px] text-white/40">{entry.type}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SelectInput({ value, options, onCommit, disabled }: { value: string; options: readonly { value: string; label: string }[]; onCommit: (next: string) => void; disabled?: boolean }) {
  const known = options.some((option) => option.value === value);
  return (
    <select className={inputClass} value={value} disabled={disabled} onChange={(event) => onCommit(event.target.value)}>
      {!known && <option value={value}>{value || '—'}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function ToggleChip({ on, label, onToggle, disabled }: { on: boolean; label: string; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed ${
        on ? 'border-brandCP/40 bg-brandCP/10 text-brandCP' : 'border-white/10 text-white/45 hover:text-white/70'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${on ? 'bg-brandCP' : 'bg-white/25'}`} />
      {label}
    </button>
  );
}

/** Un fragment YAML édité tel quel : ce que les contrôles typés ne couvrent pas. */
export function YamlSnippet({ value, onCommit, disabled, rows = 6 }: { value: unknown; onCommit: (next: unknown) => void; disabled?: boolean; rows?: number }) {
  const text = value === undefined ? '' : stringify(value).trimEnd();
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState('');
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(text);
  }, [text]);

  const apply = (next: string) => {
    try {
      const parsed = next.trim() === '' ? undefined : parse(next);
      setError('');
      if (next.trim() !== text.trim()) onCommit(parsed);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message.split('\n')[0] : 'Invalid YAML');
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <textarea
        className={`${inputClass} resize-y leading-relaxed ${error ? '!border-red-400/60' : ''}`}
        rows={rows}
        spellCheck={false}
        value={draft}
        disabled={disabled}
        onFocus={() => (focused.current = true)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => {
          focused.current = false;
          apply(event.target.value);
        }}
      />
      {error && <span className="text-[11px] text-red-400">{error}</span>}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35">{children}</span>
      <span className="h-px flex-1 bg-white/[0.06]" />
      {action}
    </div>
  );
}
