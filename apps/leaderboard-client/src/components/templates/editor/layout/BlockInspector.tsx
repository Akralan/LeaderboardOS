'use client';

import { Trash2, X } from 'lucide-react';
import { UI_COLUMNS, uiComponent, type UiPropSpec } from '../../../../../../../packages/interpreter/ui/catalog';
import { useEditor } from '../EditorContext';
import { FieldShell, SectionTitle, SelectInput, TextAreaInput, TextInput, ToggleChip, YamlSnippet } from '../inputs';
import { humanize, type BlockView } from '../model';
import { removeAt, setAt } from '../mutations';
import { useLayoutActions } from './actions';

/**
 * L'inspecteur d'un bloc
 * ----------------------
 * Ses arguments, générés du catalogue (une lane à choisir, un texte, un
 * booléen), sa place et sa taille en chiffres — la grille les écrit aussi à
 * la souris —, et ce que les contrôles ne couvrent pas dans le YAML du bloc.
 */

function NumberField({ label, value, min, max, onCommit, disabled }: { label: string; value: number; min: number; max: number; onCommit: (next: number) => void; disabled?: boolean }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-white/40">{label}</span>
      <input
        type="number"
        className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 font-mono text-xs text-white focus:border-brandCP/40 focus:outline-none disabled:opacity-60"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(event) => {
          const next = Number.parseInt(event.target.value, 10);
          if (Number.isFinite(next)) onCommit(Math.max(min, Math.min(max, next)));
        }}
      />
    </label>
  );
}

function PropControl({ block, name, spec }: { block: BlockView; name: string; spec: UiPropSpec }) {
  const { source, model, readOnly, apply, screen, issuesAt } = useEditor();
  const value = block.props[name];
  const path = [...block.path, 'props', name];
  const commit = (next: unknown) => apply(setAt(source, path, next === '' ? undefined : next), `prop:${block.key}.${name}`);
  const issues = issuesAt(path);

  switch (spec.kind) {
    case 'lane': {
      const trigger = screen === 'contributor' ? 'user' : 'admin';
      const options = model.lanes.filter((lane) => String(lane.entry.body.trigger) === trigger).map((lane) => ({ value: lane.id, label: `${humanize(lane.id)} · ${trigger}` }));
      return (
        <FieldShell label={spec.label} hint={spec.hint} issues={issues}>
          <SelectInput value={typeof value === 'string' ? value : ''} options={[{ value: '', label: 'Choose a lane…' }, ...options]} onCommit={commit} disabled={readOnly} />
        </FieldShell>
      );
    }
    case 'resource':
      return (
        <FieldShell label={spec.label} hint={spec.hint} issues={issues}>
          <SelectInput
            value={typeof value === 'string' ? value : ''}
            options={[{ value: '', label: 'Choose a resource…' }, ...model.resources.map((resource) => ({ value: resource.name, label: humanize(resource.name) }))]}
            onCommit={commit}
            disabled={readOnly}
          />
        </FieldShell>
      );
    case 'bool':
      return (
        <FieldShell label={spec.label} hint={spec.hint} issues={issues}>
          <ToggleChip on={value === true} label={value === true ? 'yes' : 'no'} onToggle={() => commit(value !== true)} disabled={readOnly} />
        </FieldShell>
      );
    case 'values':
      return (
        <FieldShell label={spec.label} hint={spec.hint} issues={issues}>
          <YamlSnippet value={value} onCommit={commit} disabled={readOnly} rows={3} />
        </FieldShell>
      );
    case 'markdown':
      return (
        <FieldShell label={spec.label} hint={spec.hint} issues={issues}>
          <TextAreaInput value={typeof value === 'string' ? value : ''} onCommit={commit} disabled={readOnly} rows={5} />
        </FieldShell>
      );
    default:
      return (
        <FieldShell label={spec.label} hint={spec.hint} issues={issues}>
          <TextInput value={typeof value === 'string' ? value : ''} onCommit={commit} disabled={readOnly} />
        </FieldShell>
      );
  }
}

export function BlockInspector({ block }: { block: BlockView }) {
  const { source, model, readOnly, apply, selectBlock, blockIssues, issuesAt, screen } = useEditor();
  const { placeBlock, removeBlock } = useLayoutActions();
  const spec = uiComponent(block.component);
  const screenVars = (model.screens[screen] ?? []).map((candidate) => candidate.selects).filter((name): name is string => Boolean(name));
  const issues = blockIssues.get(block.key) ?? [];
  const at = block.at;
  const place = (patch: Partial<BlockView['at']>) => placeBlock(block, { ...at, ...patch });
  const known = new Set(Object.keys(spec?.props ?? {}));
  const extra = Object.fromEntries(Object.entries(block.props).filter(([name]) => !known.has(name)));

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-start gap-2">
        <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-[3px] bg-brandCP/70" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[15px] font-semibold tracking-tight text-white">{spec?.label ?? humanize(block.component || 'block')}</span>
          <span className="text-[11px] leading-snug text-white/40">{spec?.role ?? 'This component is not in the catalogue.'}</span>
        </div>
        <button type="button" onClick={() => selectBlock(null)} className="rounded p-1 text-white/40 hover:text-white" title="Close">
          <X className="h-4 w-4" />
        </button>
      </div>

      {issues.length > 0 && (
        <div className="flex flex-col gap-1">
          {issues.map((issue, index) => (
            <div key={index} className={`rounded-lg border px-2.5 py-1.5 text-[11px] leading-snug ${issue.severity === 'error' ? 'border-red-400/30 bg-red-500/[0.07] text-red-300' : 'border-amber-400/30 bg-amber-400/[0.06] text-amber-200'}`}>
              {issue.message}
            </div>
          ))}
        </div>
      )}

      <FieldShell label="Block id" type="snake_case">
        <TextInput value={block.id} onCommit={(next) => apply(setAt(source, [...block.path, 'id'], next.trim()), `id:${block.key}`)} disabled={readOnly} />
      </FieldShell>

      {spec?.selects && (
        <FieldShell label="Selects" type={spec.selects === 'resource' ? 'instance' : 'created'} hint="a screen variable: other blocks read $name" issues={issuesAt([...block.path, 'selects'])}>
          <TextInput value={block.selects ?? ''} onCommit={(next) => apply(setAt(source, [...block.path, 'selects'], next.trim() || undefined), `selects:${block.key}`)} placeholder="app" disabled={readOnly} />
        </FieldShell>
      )}
      {screenVars.length > 0 && (
        <span className="text-[11px] leading-snug text-white/35">Variables on this screen: {screenVars.map((name) => `$${name}`).join(', ')} — an argument can read one, or a field of it ($app.app_url).</span>
      )}

      {spec && Object.keys(spec.props).length > 0 && (
        <div className="flex flex-col gap-3">
          <SectionTitle>Arguments</SectionTitle>
          {Object.entries(spec.props).map(([name, propSpec]) => (
            <PropControl key={name} block={block} name={name} spec={propSpec} />
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <SectionTitle>Place and size</SectionTitle>
        <div className="grid grid-cols-4 gap-2">
          <NumberField label="x" value={at.x} min={0} max={UI_COLUMNS - 1} onCommit={(x) => place({ x })} disabled={readOnly} />
          <NumberField label="y" value={at.y} min={0} max={999} onCommit={(y) => place({ y })} disabled={readOnly} />
          <NumberField label="w" value={at.w} min={spec?.size.minW ?? 1} max={UI_COLUMNS} onCommit={(w) => place({ w })} disabled={readOnly} />
          <NumberField label="h" value={at.h} min={spec?.size.minH ?? 1} max={999} onCommit={(h) => place({ h })} disabled={readOnly} />
        </div>
        <span className="text-[11px] leading-snug text-white/35">
          {UI_COLUMNS} columns; a row is a minimum height, a taller block stretches it. Phones stack the blocks in reading order.
        </span>
      </div>

      {Object.keys(extra).length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionTitle>Other arguments</SectionTitle>
          <span className="text-[11px] text-amber-300">These arguments are not in the catalogue for this component.</span>
          <YamlSnippet value={extra} onCommit={(next) => apply(setAt(source, [...block.path, 'props'], { ...Object.fromEntries(Object.entries(block.props).filter(([name]) => known.has(name))), ...(next && typeof next === 'object' ? (next as Record<string, unknown>) : {}) }))} disabled={readOnly} />
        </div>
      )}

      {!readOnly && (
        <div className="flex flex-col gap-2 border-t border-white/[0.07] pt-3">
          <button type="button" onClick={() => removeBlock(block)} className="flex items-center gap-1.5 text-xs text-red-300 hover:text-red-200">
            <Trash2 className="h-3.5 w-3.5" /> Remove this block
          </button>
          {Object.keys(extra).length > 0 && (
            <button type="button" onClick={() => apply(removeAt(source, [...block.path, 'props']))} className="text-left text-[11px] text-white/40 hover:text-white/70">
              Clear every argument
            </button>
          )}
        </div>
      )}
    </div>
  );
}
