'use client';

import { useEffect, useState } from 'react';
import { Link2, SlidersHorizontal } from 'lucide-react';
import { SelectDropdown } from '@/components/ui/SelectDropdown';
import { Field, INPUT_CLASS, LockedValue, fgAt } from '@/components/admin/challengeFormFields';
import type { FlowFormSectionProps } from '@/lib/flowFormSlots';
import type { SurfaceParam, TemplateSurface } from '../../../../../packages/interpreter/describe';
import { editableParams, type TemplateFormState } from './template';

/** `reviewer_qualification` → `Reviewer qualification`. */
function humanize(name: string): string {
  const words = name.replace(/_+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function display(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function ParamInput({
  param, value, onChange, qualifications,
}: { param: SurfaceParam; value: unknown; onChange(value: unknown): void; qualifications: { key: string; label: string }[] }) {
  const style = { color: 'var(--foreground)' };
  switch (param.kind) {
    case 'int':
    case 'number':
      return (
        <input
          type="number"
          step={param.kind === 'int' ? 1 : 'any'}
          value={typeof value === 'number' ? value : ''}
          onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          className={`w-40 ${INPUT_CLASS}`}
          style={style}
        />
      );
    case 'bool':
      return <input type="checkbox" checked={value === true} onChange={e => onChange(e.target.checked)} />;
    case 'enum':
      return (
        <SelectDropdown
          options={(param.values ?? []).map(option => ({ value: option, label: option }))}
          value={typeof value === 'string' ? value : ''}
          onChange={onChange}
        />
      );
    case 'role':
      return (
        <SelectDropdown
          options={qualifications.map(q => ({ value: q.key, label: q.label }))}
          value={typeof value === 'string' ? value : ''}
          onChange={onChange}
        />
      );
    case 'json':
      return (
        <textarea
          rows={5}
          value={typeof value === 'string' ? value : ''}
          onChange={e => onChange(e.target.value)}
          className={`w-full font-mono text-xs ${INPUT_CLASS}`}
          style={style}
        />
      );
    default:
      return <input value={typeof value === 'string' ? value : ''} onChange={e => onChange(e.target.value)} className={`w-full ${INPUT_CLASS}`} style={style} />;
  }
}

/**
 * Les champs générés d'un template en base : un contrôle par paramètre. Les
 * paramètres figés se verrouillent après la création, les règles restent
 * éditables ; un check nommé qui échoue revient du serveur sous son nom.
 */
export function templateFields(surface: TemplateSurface) {
  const params = editableParams(surface);
  const needsSource = surface.params.some(param => param.binding === 'source');

  return function TemplateFields({ state, onChange, ctx }: FlowFormSectionProps<TemplateFormState>) {
    const isCreate = ctx.mode !== 'edit';
    const [qualifications, setQualifications] = useState<{ key: string; label: string }[]>([]);
    const [sources, setSources] = useState<{ id: string; title: string }[]>([]);
    const setValue = (name: string, value: unknown) => onChange({ values: { ...state.values, [name]: value } });

    useEffect(() => {
      if (!ctx.open || !params.some(param => param.kind === 'role')) return;
      fetch('/api/qualifications').then(r => (r.ok ? r.json() : [])).then(setQualifications).catch(() => {});
    }, [ctx.open]);

    useEffect(() => {
      if (!ctx.open || !isCreate || !needsSource) return;
      fetch('/api/challenges')
        .then(r => (r.ok ? r.json() : []))
        .then((all: { uuid: string; title: string }[]) => setSources((Array.isArray(all) ? all : []).map(c => ({ id: c.uuid, title: c.title }))))
        .catch(() => {});
    }, [ctx.open, isCreate]);

    return (
      <>
        {needsSource && (
          <Field icon={<Link2 className="h-3.5 w-3.5" />} label="Source challenge">
            {isCreate ? (
              <SelectDropdown options={sources.map(c => ({ value: c.id, label: c.title }))} value={state.sourceChallengeId} onChange={id => onChange({ sourceChallengeId: id })} />
            ) : (
              <LockedValue text="Source challenge" />
            )}
          </Field>
        )}
        {params.map(param => (
          <Field key={param.name} icon={<SlidersHorizontal className="h-3.5 w-3.5" />} label={humanize(param.name)}>
            {!isCreate && param.binding === 'config' ? (
              <LockedValue text={display(state.values[param.name])} />
            ) : (
              <ParamInput param={param} value={state.values[param.name]} onChange={value => setValue(param.name, value)} qualifications={qualifications} />
            )}
            {param.binding === 'rules' && (
              <p className="mt-1 text-[11px]" style={{ color: fgAt(0.3) }}>Editable during the challenge.</p>
            )}
          </Field>
        ))}
      </>
    );
  };
}
