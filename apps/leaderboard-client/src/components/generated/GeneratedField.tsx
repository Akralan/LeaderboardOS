'use client';

import { useEffect, useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import type { SurfaceField } from '../../../../../packages/interpreter/describe';
import { flowActionUrl } from '@/lib/challengeActions';
import { fgAt, humanize } from './format';

/**
 * Le renderer de formulaire d'un champ de Collect (note §5) : un contrôle par
 * type déclaré — texte, nombre, booléen, énumération (boutons jusqu'à cinq
 * valeurs, liste au-delà), URL, fichier, JSON, et `ref`/`link` comme un
 * sélecteur sur la lecture `options` générée.
 */

export type FieldValue = string | number | boolean | File | unknown;

const inputClass =
  'w-full rounded-[14px] border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-sm text-white placeholder:text-white/25 focus:border-brandCP/40 focus:outline-none';

interface Option {
  id: string;
  [key: string]: unknown;
}

/** Ce qui nomme une valeur : un titre, un nom, sinon une URL — jamais un identifiant. */
function nameOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['title', 'name']) if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  for (const item of Object.values(record)) {
    const nested = item && typeof item === 'object' ? nameOf(item) : null;
    if (nested) return nested;
  }
  const url = Object.values(record).find((item) => typeof item === 'string' && /^https?:\/\//.test(item));
  return typeof url === 'string' ? url : null;
}

/** Le libellé d'un choix : ce qui le nomme, l'état de ses aggregates, sinon son rang. */
function labelOf(option: Option, index: number, field: SurfaceField): string {
  const base = nameOf(option) ?? `${humanize(field.resource ?? field.name)} #${index + 1}`;
  const aggregates = option.aggregates as Record<string, { count?: number }> | undefined;
  const counts = aggregates ? Object.values(aggregates).map((state) => state.count).filter((count) => typeof count === 'number') : [];
  return counts.length ? `${base} · ${counts[0]} in` : base;
}

export function GeneratedField({
  challengeId, lane, field, value, siblings, onChange,
}: {
  challengeId: string;
  lane: string;
  field: SurfaceField;
  value: FieldValue;
  /** Les autres choix du même geste : ils restreignent les options d'un claim désigné. */
  siblings: Record<string, string>;
  onChange: (value: FieldValue) => void;
}) {
  const label = (
    <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: fgAt(0.45) }}>
      {humanize(field.name)}
    </span>
  );

  switch (field.kind) {
    case 'enum':
      if (field.values && field.values.length <= 5) {
        return (
          <div className="space-y-1.5">
            {label}
            <div className="flex flex-wrap gap-2">
              {field.values.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => onChange(option)}
                  className={`rounded-full border px-4 py-2 text-sm transition-colors ${value === option ? 'border-brandCP/60 bg-brandCP/15 text-white' : 'border-white/10 text-white/60 hover:bg-white/5'}`}
                >
                  {humanize(option)}
                </button>
              ))}
            </div>
          </div>
        );
      }
      if (field.values) {
        return (
          <label className="block space-y-1.5">
            {label}
            <select className={inputClass} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
              <option value="">Choose…</option>
              {field.values.map((option) => <option key={option} value={option}>{humanize(option)}</option>)}
            </select>
          </label>
        );
      }
      break;
    case 'bool':
      return (
        <label className="flex items-center gap-2 text-sm" style={{ color: fgAt(0.7) }}>
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          {humanize(field.name)}
        </label>
      );
    case 'int':
    case 'number':
      return (
        <label className="block space-y-1.5">
          {label}
          <input
            type="number"
            step={field.kind === 'int' ? 1 : 'any'}
            className={inputClass}
            value={typeof value === 'number' ? value : ''}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          />
        </label>
      );
    case 'url':
      return (
        <label className="block space-y-1.5">
          {label}
          <input type="url" placeholder="https://" className={inputClass} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />
        </label>
      );
    case 'file':
      return <div className="space-y-1.5">{label}<FilePicker file={value instanceof File ? value : null} onChange={onChange} /></div>;
    case 'json':
      return (
        <label className="block space-y-1.5">
          {label}
          <textarea rows={5} className={`${inputClass} font-mono text-xs`} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />
        </label>
      );
    case 'ref':
    case 'link':
      return (
        <div className="space-y-1.5">
          {label}
          <OptionPicker challengeId={challengeId} lane={lane} field={field} value={typeof value === 'string' ? value : ''} siblings={siblings} onChange={onChange} />
        </div>
      );
  }

  return (
    <label className="block space-y-1.5">
      {label}
      <textarea rows={3} className={inputClass} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function OptionPicker({
  challengeId, lane, field, value, siblings, onChange,
}: {
  challengeId: string;
  lane: string;
  field: SurfaceField;
  value: string;
  siblings: Record<string, string>;
  onChange: (value: FieldValue) => void;
}) {
  const [options, setOptions] = useState<Option[] | null>(null);
  const [error, setError] = useState('');
  const query = new URLSearchParams({ field: `${field.gesture}.${field.name}`, ...siblings }).toString();

  useEffect(() => {
    let cancelled = false;
    setOptions(null);
    fetch(flowActionUrl(challengeId, `${lane}/options?${query}`))
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) setError(typeof body?.error === 'string' ? body.error : `Request failed (${res.status})`);
        else setOptions(Array.isArray(body?.options) ? body.options : []);
      })
      .catch(() => !cancelled && setError('Network error'));
    return () => { cancelled = true; };
  }, [challengeId, lane, query]);

  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (!options) return <p className="text-xs" style={{ color: fgAt(0.35) }}>Loading…</p>;
  if (options.length === 0) return <p className="text-xs" style={{ color: fgAt(0.35) }}>Nothing to choose from yet.</p>;
  return (
    <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose…</option>
      {options.map((option, index) => <option key={option.id} value={option.id}>{labelOf(option, index, field)}</option>)}
    </select>
  );
}

function FilePicker({ file, onChange }: { file: File | null; onChange: (file: File | undefined) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="relative">
      <input ref={ref} type="file" onChange={(e) => onChange(e.target.files?.[0] ?? undefined)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
      <div className={`flex items-center gap-2.5 rounded-[14px] border border-dashed px-3.5 py-3 text-sm ${file ? 'border-brandCP/35 bg-brandCP/[0.05] text-white/80' : 'border-white/12 bg-white/[0.02] text-white/35'}`}>
        <Upload className={`h-4 w-4 shrink-0 ${file ? 'text-brandCP' : 'text-white/25'}`} />
        <span className="min-w-0 flex-1 truncate">{file ? file.name : 'Choose a file'}</span>
        {file && (
          <button
            type="button"
            onClick={() => { onChange(undefined); if (ref.current) ref.current.value = ''; }}
            className="relative z-10 shrink-0 rounded-full p-1 text-white/30 hover:bg-white/10 hover:text-white/70"
            aria-label="Remove file"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
