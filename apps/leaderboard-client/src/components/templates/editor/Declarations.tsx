'use client';

import { useState } from 'react';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { parse } from 'yaml';
import { FAMILIES } from './families';
import { useEditor } from './EditorContext';
import { ExpressionInput, FieldShell, SelectInput, TextInput, ToggleChip, YamlSnippet } from './inputs';
import { contextFor, isRec, type DeclarationTab } from './model';
import { insertAt, newAggregateValue, removeAt, renameKey, setAt } from './mutations';

/**
 * Les déclarations, hors du canevas
 * ---------------------------------
 * Params, Resources, Counters, Lifecycle — et l'en-tête du template. Ce que
 * les lanes lisent sans le dessiner : la surface de configuration, les unités
 * de travail et leur politique de claim, les statistiques dérivées, le
 * consensus.
 */

export const TABS: readonly { key: DeclarationTab; label: string }[] = [
  { key: 'params', label: 'Params' },
  { key: 'resources', label: 'Resources' },
  { key: 'counters', label: 'Counters' },
  { key: 'lifecycle', label: 'Lifecycle' },
  { key: 'template', label: 'Template' },
];

const IDENT = /^[a-z][a-z0-9_]*$/;

function freeName(taken: Iterable<string>, base: string) {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) if (!names.has(`${base}_${n}`)) return `${base}_${n}`;
}

export function Declarations({ tab, setTab }: { tab: DeclarationTab; setTab: (tab: DeclarationTab) => void }) {
  const { declarationIssues } = useEditor();
  return (
    <div className="flex flex-col">
      <div className="flex gap-0.5 overflow-x-auto border-b border-white/[0.07] px-2.5 py-2.5">
        {TABS.map((entry) => {
          const issues = declarationIssues.get(entry.key) ?? [];
          const errors = issues.filter((issue) => issue.severity === 'error').length;
          return (
            <button
              key={entry.key}
              type="button"
              onClick={() => setTab(entry.key)}
              className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
                tab === entry.key ? 'bg-brandCP/10 font-semibold text-brandCP' : 'font-medium text-white/45 hover:text-white/75'
              }`}
            >
              {entry.label}
              {issues.length > 0 && <span className={`h-1.5 w-1.5 rounded-full ${errors ? 'bg-red-400' : 'bg-amber-300'}`} />}
            </button>
          );
        })}
      </div>
      <IssueList tab={tab} />
      {tab === 'params' && <ParamsPanel />}
      {tab === 'resources' && <ResourcesPanel />}
      {tab === 'counters' && <CountersPanel />}
      {tab === 'lifecycle' && <LifecyclePanel />}
      {tab === 'template' && <TemplatePanel />}
    </div>
  );
}

function IssueList({ tab }: { tab: DeclarationTab }) {
  const { declarationIssues } = useEditor();
  const issues = declarationIssues.get(tab) ?? [];
  if (issues.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 px-4 pt-3">
      {issues.map((issue, index) => (
        <div key={index} className={`rounded-lg border px-2.5 py-1.5 text-[11px] leading-snug ${issue.severity === 'error' ? 'border-red-400/30 bg-red-500/[0.07] text-red-300' : 'border-amber-400/30 bg-amber-400/[0.06] text-amber-200'}`}>
          <span className="font-mono opacity-70">{issue.path}</span> — {issue.message}
        </div>
      ))}
    </div>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  const { readOnly } = useEditor();
  if (readOnly) return null;
  return (
    <button type="button" onClick={onClick} className="flex items-center justify-center gap-1 rounded-lg border border-dashed border-white/10 py-2 text-xs font-medium text-white/45 transition-colors hover:border-brandCP/40 hover:text-brandCP">
      <Plus className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

function ParamsPanel() {
  const { model, source, apply, readOnly, issuesAt } = useEditor();
  const [open, setOpen] = useState<string | null>(null);
  const context = contextFor(model, null);

  return (
    <div className="flex flex-col px-4 pb-5 pt-1">
      {model.params.map((param) => {
        const expanded = open === param.name;
        const base = ['params', param.name];
        const issues = issuesAt(base);
        return (
          <div key={param.name} className="flex flex-col gap-1.5 border-b border-white/[0.05] py-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <button type="button" onClick={() => setOpen(expanded ? null : param.name)} className="flex items-center gap-1.5 text-left">
                <ChevronDown className={`h-3 w-3 text-white/30 transition-transform ${expanded ? '' : '-rotate-90'}`} />
                <span className={`font-mono text-[13px] font-medium ${issues.some((issue) => issue.severity === 'error') ? 'text-red-300' : 'text-white'}`}>{param.name}</span>
              </button>
              <span className="rounded bg-white/[0.05] px-1.5 py-px font-mono text-[10px] text-white/45">{param.type}</span>
              {param.mutable && <span className="rounded bg-brandCP/10 px-1.5 py-px text-[10px] font-semibold text-brandCP">editable after creation</span>}
            </div>
            {param.defaultText !== null && <span className="pl-[18px] font-mono text-xs text-white/50">default {param.defaultText}</span>}
            {param.checks.map((check) => (
              <span key={check.name} className="pl-[18px] text-[11px] text-white/35">
                check · {check.name === 'check' ? check.expr : check.name.replace(/_/g, ' ')}
              </span>
            ))}
            {expanded && (
              <div className="mt-1.5 flex flex-col gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.015] p-2.5">
                <FieldShell label="Name">
                  <TextInput value={param.name} disabled={readOnly} invalid={!IDENT.test(param.name)} onCommit={(next) => {
                    if (!next.trim() || model.params.some((other) => other.name === next.trim())) return;
                    apply(renameKey(source, ['params'], param.name, next.trim()));
                    setOpen(next.trim());
                  }} />
                </FieldShell>
                <FieldShell label="Type" hint="points · int · ratio · role · challenge_ref · {…}" issues={issuesAt([...base, 'type'])}>
                  <TextInput value={param.type} disabled={readOnly} onCommit={(next) => {
                    let value: unknown = next;
                    // Un type structuré (`{min_seen: int, …}`) reste une map ; un type écrit en chaîne reste une chaîne.
                    if (isRec(param.decl.type) && next.trim().startsWith('{')) {
                      try { value = parse(next); } catch { value = next; }
                    }
                    apply(setAt(source, [...base, 'type'], value), `params.${param.name}.type`);
                  }} />
                </FieldShell>
                <FieldShell label="Default" hint="a YAML value" issues={issuesAt([...base, 'default'])}>
                  <TextInput value={param.defaultText ?? ''} disabled={readOnly} onCommit={(next) => {
                    let value: unknown;
                    try { value = next.trim() === '' ? undefined : parse(next); } catch { value = next; }
                    apply(setAt(source, [...base, 'default'], value), `params.${param.name}.default`);
                  }} />
                </FieldShell>
                <FieldShell label="Editable after creation">
                  <div>
                    <ToggleChip on={param.mutable} label={param.mutable ? 'editable — a reward rule' : 'fixed at creation'} disabled={readOnly} onToggle={() => apply(setAt(source, [...base, 'mutable'], !param.mutable))} />
                  </div>
                </FieldShell>
                <FieldShell label="Check" type="expression" hint="value …" issues={issuesAt([...base, 'check'])}>
                  <ExpressionInput value={String(param.decl.check ?? '')} context={[{ path: 'value', type: param.type, from: 'Param' }, ...context]} disabled={readOnly} onCommit={(next) => apply(setAt(source, [...base, 'check'], next.trim() || undefined), `params.${param.name}.check`)} />
                </FieldShell>
                <FieldShell label="Named checks" hint="name: expression — the name is the message" issues={issuesAt([...base, 'checks'])}>
                  <YamlSnippet value={param.decl.checks} rows={3} disabled={readOnly} onCommit={(value) => apply(setAt(source, [...base, 'checks'], value))} />
                </FieldShell>
                {!readOnly && (
                  <button type="button" onClick={() => apply(removeAt(source, base))} className="flex items-center gap-1 self-start text-[11px] text-white/35 hover:text-red-400">
                    <Trash2 className="h-3 w-3" /> Delete param
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      <div className="pt-3">
        <AddButton
          label="Add param"
          onClick={() => {
            const name = freeName(model.params.map((param) => param.name), 'param');
            apply(setAt(source, ['params', name], { type: 'int', mutable: false }));
            setOpen(name);
          }}
        />
      </div>
    </div>
  );
}

const VISIBILITY_TONE = {
  everyone: 'bg-white/[0.05] text-white/50',
  restricted: 'bg-sky-400/10 text-sky-300',
  hidden: 'bg-red-400/10 text-red-300',
} as const;

function ResourcesPanel() {
  const { model, source, apply, readOnly, selected, issuesAt } = useEditor();
  const [editing, setEditing] = useState<string | null>(null);
  const touched = new Set(selected ? model.nodes.get(selected)?.resources.map((use) => use.type) : []);

  return (
    <div className="flex flex-col gap-3 px-4 pb-5 pt-3">
      {model.resources.map((resource) => {
        const glow = touched.has(resource.name);
        const issues = issuesAt(['resources', resource.name]);
        return (
          <div
            key={resource.name}
            className={`flex flex-col gap-2.5 rounded-xl border p-3 transition-shadow ${glow ? 'border-brandCP/50 shadow-[0_0_0_3px_color-mix(in_srgb,var(--theme-primary)_14%,transparent)]' : issues.some((issue) => issue.severity === 'error') ? 'border-red-400/40' : 'border-white/[0.08]'}`}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-medium text-white">{resource.name}</span>
              <span className="ml-auto text-[10px] font-bold uppercase tracking-widest text-white/25">resource</span>
            </div>
            <div className="flex flex-col gap-2">
              {resource.fields.map((field) => (
                <div key={field.name} className="flex flex-col gap-1">
                  <div className="flex items-baseline gap-1.5 font-mono text-xs">
                    <span className="text-white/85">{field.name}</span>
                    <span className="truncate text-white/35">{field.type}</span>
                  </div>
                  <span className={`self-start rounded px-1.5 py-0.5 text-[10px] ${VISIBILITY_TONE[field.tone]}`}>{field.visibility}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-1 border-t border-white/[0.06] pt-2 text-[11px] leading-snug text-white/50">
              {resource.claim && <span>claim · {resource.claim}</span>}
              {resource.closure && <span>closure · {resource.closure}</span>}
              {resource.createdBy.length > 0 && <span>created by · {resource.createdBy.join(', ')}</span>}
              {!resource.claim && !resource.closure && <span className="text-white/30">no claim policy, no closure</span>}
            </div>
            {!readOnly && (
              <div className="flex items-center gap-3">
                <button type="button" onClick={() => setEditing(editing === resource.name ? null : resource.name)} className="text-[11px] font-semibold text-brandCP hover:opacity-80">
                  {editing === resource.name ? 'Done' : 'Edit'}
                </button>
                <button type="button" onClick={() => apply(removeAt(source, ['resources', resource.name]))} className="ml-auto text-white/30 hover:text-red-400" title="Delete resource">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {editing === resource.name && (
              <div className="flex flex-col gap-2">
                <FieldShell label="Name">
                  <TextInput value={resource.name} onCommit={(next) => {
                    if (!next.trim() || model.resources.some((other) => other.name === next.trim())) return;
                    apply(renameKey(source, ['resources'], resource.name, next.trim()));
                    setEditing(next.trim());
                  }} />
                </FieldShell>
                <FieldShell label="Declaration" hint="fields · claim · closure · created_by" issues={issues}>
                  <YamlSnippet value={resource.decl} rows={10} onCommit={(value) => isRec(value) && apply(setAt(source, ['resources', resource.name], value))} />
                </FieldShell>
              </div>
            )}
          </div>
        );
      })}
      <AddButton
        label="Add resource"
        onClick={() => {
          const name = freeName(model.resources.map((resource) => resource.name), 'unit');
          apply(setAt(source, ['resources', name], { fields: { title: { type: 'string', visibility: ['claimant', 'admin'] } }, claim: { mode: 'exclusive', ttl: '48h' } }));
          setEditing(name);
        }}
      />
    </div>
  );
}

function CountersPanel() {
  const { model, source, apply, readOnly } = useEditor();
  return (
    <div className="flex flex-col gap-2 px-4 pb-5 pt-3">
      {model.counters.map((counter) => (
        <div key={counter.name} className="flex items-center gap-2 rounded-lg border border-white/[0.08] px-2.5 py-2">
          <div className="w-[38%]">
            <TextInput value={counter.name} disabled={readOnly} onCommit={(next) => next.trim() && apply(renameKey(source, ['counters'], counter.name, next.trim()))} />
          </div>
          <div className="w-[30%]">
            <SelectInput value={counter.type} disabled={readOnly} options={['int', 'number', 'ratio', 'points'].map((type) => ({ value: type, label: type }))} onCommit={(next) => apply(setAt(source, ['counters', counter.name, 'type'], next))} />
          </div>
          <div className="flex-1">
            <TextInput
              value={counter.lag === null ? '' : String(counter.lag)}
              placeholder="lag"
              disabled={readOnly}
              onCommit={(next) => apply(setAt(source, ['counters', counter.name, 'lag'], next.trim() === '' ? undefined : Number(next)))}
            />
          </div>
          {!readOnly && (
            <button type="button" onClick={() => apply(removeAt(source, ['counters', counter.name]))} className="text-white/30 hover:text-red-400" title="Delete counter">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ))}
      {model.counters.length === 0 && <span className="text-xs text-white/35">No counter declared.</span>}
      <span className="text-[11px] leading-relaxed text-white/35">
        Derived per participant, updated by Assess nodes. Read them in expressions as <span className="font-mono">counters.name</span>; a lag hides the most recent claims.
      </span>
      <AddButton label="Add counter" onClick={() => apply(setAt(source, ['counters', freeName(model.counters.map((counter) => counter.name), 'count'), 'type'], 'int'))} />
    </div>
  );
}

function LifecyclePanel() {
  const { model, source, apply, readOnly, select, selected } = useEditor();
  const lifecycle = isRec(model.doc.lifecycle) ? model.doc.lifecycle : {};
  const hue = FAMILIES.aggregate.hue;
  return (
    <div className="flex flex-col gap-3 px-4 pb-5 pt-3">
      {model.aggregates.map((aggregate) => (
        <button
          key={aggregate.id}
          type="button"
          onClick={() => select(aggregate.node.key)}
          className="flex flex-col gap-2 rounded-xl border p-3 text-left transition-shadow"
          style={{ borderColor: `${hue}55`, background: `color-mix(in srgb, ${hue} 6%, transparent)`, boxShadow: selected === aggregate.node.key ? `0 0 0 3px ${hue}30` : undefined }}
        >
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-[3px]" style={{ background: hue }} />
            <span className="font-mono text-sm font-medium text-white">{aggregate.id}</span>
            <span className="ml-auto text-[10px] font-bold uppercase tracking-widest" style={{ color: hue }}>aggregate</span>
          </div>
          {aggregate.rows.map((row, index) => (
            <div key={index} className="flex items-baseline gap-2 text-xs">
              <span className="shrink-0" style={{ color: `${hue}cc` }}>{row.k}</span>
              <span className="h-px flex-1" style={{ background: `${hue}30` }} />
              <span className="truncate font-mono text-white/80" title={row.v}>{row.v}</span>
            </div>
          ))}
          <span className="border-t pt-1.5 text-[11px]" style={{ borderColor: `${hue}30`, color: hue }}>
            {aggregate.emitters.length === 0 ? 'no emit link yet — an Assess node emits to it' : `${aggregate.emitters.length} emit link${aggregate.emitters.length === 1 ? '' : 's'} · from Assess ${aggregate.emitters.join(', ')}`}
          </span>
        </button>
      ))}
      <AddButton label="Add aggregate" onClick={() => {
        const count = Array.isArray(lifecycle.aggregates) ? lifecycle.aggregates.length : 0;
        apply(insertAt(source, ['lifecycle', 'aggregates'], count, newAggregateValue(model)));
        select(`lifecycle.aggregates.${count}`);
      }} />
      <FieldShell label="States" hint="standard · {close_at}">
        <YamlSnippet value={lifecycle.states} rows={2} disabled={readOnly} onCommit={(value) => apply(setAt(source, ['lifecycle', 'states'], value))} />
      </FieldShell>
      <FieldShell label="On close" hint="effects when the challenge closes">
        <YamlSnippet value={lifecycle.on_close} rows={3} disabled={readOnly} onCommit={(value) => apply(setAt(source, ['lifecycle', 'on_close'], value))} />
      </FieldShell>
    </div>
  );
}

function TemplatePanel() {
  const { model, source, apply, readOnly, issuesAt } = useEditor();
  const presentation = isRec(model.doc.presentation) ? model.doc.presentation : undefined;
  return (
    <div className="flex flex-col gap-3 px-4 pb-5 pt-3">
      <FieldShell label="Name" issues={issuesAt(['template', 'name'])}>
        <TextInput value={model.header.name} disabled={readOnly} onCommit={(next) => apply(setAt(source, ['template', 'name'], next), 'template.name')} />
      </FieldShell>
      <FieldShell label="Summary" issues={issuesAt(['template', 'summary'])}>
        <TextInput value={model.header.summary} disabled={readOnly} onCommit={(next) => apply(setAt(source, ['template', 'summary'], next), 'template.summary')} />
      </FieldShell>
      <FieldShell label="Id" hint="the template key" issues={issuesAt(['template', 'id'])}>
        <TextInput value={model.header.id} disabled invalid={issuesAt(['template', 'id']).length > 0} onCommit={() => {}} />
      </FieldShell>
      <FieldShell label="Version" hint="chosen when you publish" issues={issuesAt(['template', 'version'])}>
        <TextInput value={model.header.version} disabled onCommit={() => {}} />
      </FieldShell>
      <FieldShell label="Presentation" hint="icon · long_label · join_caption · public · contribution" issues={issuesAt(['presentation'])}>
        <YamlSnippet value={presentation} rows={7} disabled={readOnly} onCommit={(value) => apply(setAt(source, ['presentation'], value))} />
      </FieldShell>
    </div>
  );
}
