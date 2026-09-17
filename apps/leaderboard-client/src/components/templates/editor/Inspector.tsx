'use client';

import { Plus, Trash2, X } from 'lucide-react';
import { FAMILIES } from './families';
import { useEditor } from './EditorContext';
import { ExpressionInput, FieldShell, SectionTitle, SelectInput, TextInput, ToggleChip, YamlSnippet, inputClass } from './inputs';
import { contextFor, humanize, isRec, provenanceOf, type CanvasNode, type ContextEntry, type Path, type Rec } from './model';
import { addBranch, removeAt, renameKey, setAt, setGateMode } from './mutations';

/**
 * L'inspecteur d'un nœud
 * ----------------------
 * Généré du schéma de sa famille : des champs typés, des expressions avec
 * autocomplétion sur ce qui est en amont, des sélecteurs de ressources et
 * d'aggregates. Ce que les contrôles ne couvrent pas s'édite dans le YAML du
 * nœud, en bas. Les diagnostics d'un champ s'affichent sous lui.
 */

type Control = 'text' | 'expr' | 'enum' | 'bool' | 'number' | 'resource' | 'aggregate' | 'yaml';

interface FieldSpec {
  path: string[];
  label: string;
  control: Control;
  options?: readonly string[];
  hint?: string;
  show?: (body: Rec) => boolean;
  /** `clamp: pool` se lit comme un booléen. */
  truthy?: unknown;
}

interface Group {
  title: string;
  fields: FieldSpec[];
  show?: (body: Rec) => boolean;
}

const has = (key: string) => (body: Rec) => body[key] !== undefined;
const at = (body: Rec, path: readonly string[]): unknown => path.reduce<unknown>((value, key) => (isRec(value) ? value[key] : undefined), body);

const DESCRIPTIONS: Record<string, string> = {
  entry: 'Who may start this lane, and how: a user gesture, an admin gesture, or a schedule.',
  collect: 'A form step: the fields this actor fills. It generates the participant’s form.',
  gate: 'A check. Blocking: every condition must hold. Routing: branches that reconverge below.',
  act: 'The system does something: claim a work unit, create resources, observe, or reveal a hidden field.',
  transition: 'Closes (or reopens) a resource, with a verdict.',
  assess: 'A judgment: a human verdict, an AI grid, or a computed metric — it may emit to an aggregate.',
  reward: 'Pays points: a formula, tiers, a rank, or the reverse of an earlier payment. Clamped by the pool.',
  aggregate: 'Consensus over a resource: resolves when enough inputs arrive, sets a verdict, runs its effects.',
  unknown: 'This node does not declare a single family key (collect, act, assess, gate or reward).',
};

function groupsOf(node: CanvasNode): Group[] {
  switch (node.docKey) {
    case 'entry':
      return [
        {
          title: 'Entry',
          fields: [
            { path: ['trigger'], label: 'Trigger', control: 'enum', options: ['user', 'admin', 'cron'] },
            { path: ['access', 'mode'], label: 'Access', control: 'enum', options: ['', 'open', 'role', 'author_of'], show: (b) => b.trigger === 'user' },
            { path: ['access', 'role'], label: 'Role', control: 'expr', hint: 'a role param', show: (b) => at(b, ['access', 'mode']) === 'role' },
            { path: ['access', 'resource'], label: 'Author of', control: 'resource', show: (b) => at(b, ['access', 'mode']) === 'author_of' },
            { path: ['access', 'runs_per_participation'], label: 'Runs per participant', control: 'number', show: (b) => b.trigger === 'user' },
            { path: ['schedule'], label: 'Schedule', control: 'text', hint: 'cron syntax', show: (b) => b.trigger === 'cron' },
            { path: ['over', 'resource'], label: 'Over resource', control: 'resource', show: (b) => b.trigger === 'cron' },
            { path: ['over', 'where'], label: 'Where', control: 'expr', show: (b) => b.trigger === 'cron' },
            { path: ['over', 'sample'], label: 'Sample', control: 'expr', hint: 'ratio', show: (b) => b.trigger === 'cron' },
          ],
        },
      ];
    case 'act':
      if (isRec(node.body.transition)) {
        return [
          {
            title: 'Transition',
            fields: [
              { path: ['transition', 'resource'], label: 'Resource', control: 'expr' },
              { path: ['transition', 'to'], label: 'To', control: 'enum', options: ['closed', 'open'] },
              { path: ['transition', 'verdict'], label: 'Verdict', control: 'expr' },
              { path: ['transition', 'from'], label: 'Only from verdict', control: 'text' },
              { path: ['transition', 'resolution'], label: 'Resolution', control: 'yaml' },
            ],
          },
        ];
      }
      return [
        { title: 'Act', fields: [{ path: ['kind'], label: 'Kind', control: 'enum', options: ['', 'effector', 'observer', 'grant'] }] },
        {
          title: 'Claim',
          fields: [
            { path: ['claim', 'resource'], label: 'Claims', control: 'expr', hint: 'a resource type or a ref field' },
            { path: ['claim', 'where'], label: 'Filter', control: 'expr', show: (b) => isRec(b.claim) },
            { path: ['claim', 'substitute', 'resource'], label: 'Substitute with', control: 'resource', show: (b) => isRec(b.claim) },
            { path: ['claim', 'substitute', 'rate'], label: 'Substitution rate', control: 'expr', show: (b) => isRec(at(b, ['claim', 'substitute'])) },
            { path: ['claim', 'scope'], label: 'Scope', control: 'yaml', show: (b) => isRec(b.claim) },
          ],
        },
        {
          title: 'Create',
          fields: [
            { path: ['create'], label: 'Creates', control: 'resource' },
            { path: ['from'], label: 'From', control: 'expr', show: has('create') },
            { path: ['many', 'from_file'], label: 'Many, from file', control: 'expr', show: has('create') },
            { path: ['set'], label: 'Set fields', control: 'yaml', show: has('create') },
          ],
        },
        {
          title: 'Observe',
          show: (b) => b.kind === 'observer' || b.capability !== undefined,
          fields: [
            { path: ['capability'], label: 'Capability', control: 'text' },
            { path: ['store'], label: 'Stores as', control: 'text' },
          ],
        },
        {
          title: 'Grant',
          show: (b) => b.kind === 'grant' || b.grant !== undefined,
          fields: [{ path: ['grant', 'field'], label: 'Unlocks field', control: 'expr' }],
        },
      ];
    case 'assess':
      return [
        {
          title: 'Assess',
          fields: [
            { path: ['kind'], label: 'Kind', control: 'enum', options: ['human', 'metric', 'ai_grid', 'self'] },
            { path: ['value'], label: 'Value', control: 'expr', show: (b) => b.kind === 'metric' || b.value !== undefined },
            { path: ['grid'], label: 'Grid', control: 'expr', show: (b) => b.kind === 'ai_grid' },
            { path: ['input'], label: 'Inputs', control: 'yaml', hint: 'the artifact URL first', show: (b) => b.kind === 'ai_grid' },
            { path: ['snapshot'], label: 'Snapshot', control: 'enum', options: ['', 'history', 'latest'], hint: 'branch history · latest state', show: (b) => b.kind === 'ai_grid' },
            { path: ['background'], label: 'Run in background', control: 'bool', show: (b) => b.kind === 'ai_grid' },
            { path: ['from'], label: 'From form', control: 'text', hint: 'an upstream Collect id' },
            { path: ['gating'], label: 'Gating', control: 'bool' },
          ],
        },
        {
          title: 'Emit',
          fields: [
            { path: ['emit', 'to'], label: 'Emits to', control: 'aggregate' },
            { path: ['emit', 'scope'], label: 'Scope', control: 'expr', show: (b) => isRec(b.emit) },
          ],
        },
        { title: 'Counters', fields: [{ path: ['counters'], label: 'Updates', control: 'yaml', hint: 'name: {add: expr}' }] },
      ];
    case 'reward':
      return [
        {
          title: 'Reward',
          fields: [
            { path: ['amount'], label: 'Amount', control: 'expr', show: (b) => !isRec(b.amount) },
            { path: ['amount'], label: 'Amount', control: 'yaml', show: (b) => isRec(b.amount) },
            { path: ['to'], label: 'To', control: 'expr', hint: 'the participant by default' },
            { path: ['pool'], label: 'Pool', control: 'expr' },
            { path: ['clamp'], label: 'Clamp to pool', control: 'bool', truthy: 'pool' },
            { path: ['order'], label: 'Order', control: 'enum', options: ['', 'commit_time'] },
            { path: ['rule_key'], label: 'Ledger key', control: 'text' },
            { path: ['basis'], label: 'Basis', control: 'enum', options: ['', 'delta'], hint: 'delta: pay only the improvement' },
            { path: ['meta'], label: 'Ledger meta', control: 'yaml', hint: 'key: expression' },
          ],
        },
      ];
    case 'aggregate':
      return [
        {
          title: 'Aggregate',
          fields: [
            { path: ['over'], label: 'Over', control: 'resource' },
            { path: ['per_participation'], label: 'Inputs per participant', control: 'number' },
            { path: ['resolve', 'when'], label: 'Resolve when', control: 'expr' },
            { path: ['resolve', 'verdict'], label: 'Verdict', control: 'expr' },
            { path: ['resolve', 'then'], label: 'Then', control: 'yaml' },
            { path: ['state_visibility', 'count'], label: 'Count visible to', control: 'enum', options: ['', 'everyone', 'admin', 'author'] },
            { path: ['state_visibility', 'split'], label: 'Split visible to', control: 'enum', options: ['', 'everyone', 'admin', 'author'] },
          ],
        },
      ];
    default:
      return [];
  }
}

const TYPE_SUGGESTIONS = ['string', 'int', 'number', 'bool', 'url', 'file', 'json', 'date', 'enum(a, b)', 'ref(resource)', 'link'];

export function Inspector({ nodeKey }: { nodeKey: string }) {
  const editor = useEditor();
  const { model, source, apply, readOnly, select, nodeIssues, issuesAt } = editor;
  const node = model.nodes.get(nodeKey);
  if (!node) return null;

  const family = node.family === 'unknown' ? null : FAMILIES[node.family];
  const issues = nodeIssues.get(node.key) ?? [];
  const context = contextFor(model, node.key);
  const body = node.body;

  const write = (relative: readonly (string | number)[], value: unknown, coalesce = true) =>
    apply(setAt(source, [...node.bodyPath, ...relative], value), coalesce ? `${node.key}:${relative.join('.')}` : undefined);

  const rename = (next: string) => {
    if (!next.trim()) return;
    if (node.docKey === 'entry') apply(setAt(source, ['lanes', node.laneIndex!, 'id'], next.trim()), `${node.key}:id`);
    else write(['id'], next.trim());
  };

  const remove = () => {
    select(null);
    if (node.docKey === 'entry') {
      if (window.confirm('Deleting an entry deletes its whole lane. Continue?')) apply(removeAt(source, ['lanes', node.laneIndex!]));
      return;
    }
    apply(removeAt(source, node.path));
  };

  const provenance = provenanceOf(model, node.key).map((key) => model.nodes.get(key)!);
  const declared = node.reads.filter((root) => root === 'params' || root === 'counters' || root === 'aggregates' || root === 'challenge' || root === 'participation');
  const touched = model.resources.filter((resource) => node.resources.some((use) => use.type === resource.name));

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-2 border-b border-white/[0.07] px-4 py-3.5">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-[3px]" style={{ background: family?.hue ?? '#f87171' }} />
          <span className="text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: family?.hue ?? '#f87171' }}>
            {family?.label ?? 'Unreadable node'}
          </span>
          <span className="font-mono text-[10px] text-white/30">{node.badge}</span>
          <button type="button" onClick={() => select(null)} className="ml-auto rounded p-0.5 text-white/35 hover:text-white" title="Close (Esc)">
            <X className="h-4 w-4" />
          </button>
        </div>
        {node.docKey ? (
          <TextInput value={node.docKey === 'entry' ? node.id : String(body.id ?? '')} onCommit={rename} disabled={readOnly} placeholder="id" />
        ) : (
          <span className="font-mono text-base text-white">{node.id}</span>
        )}
        <span className="text-xs leading-relaxed text-white/45">{DESCRIPTIONS[node.family]}</span>
        {issues.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {issues.map((issue, index) => (
              <div
                key={index}
                className={`flex flex-col gap-0.5 rounded-lg border px-2.5 py-2 ${issue.severity === 'error' ? 'border-red-400/30 bg-red-500/[0.08] text-red-300' : 'border-amber-400/30 bg-amber-400/[0.07] text-amber-200'}`}
              >
                <span className="text-[10px] font-bold uppercase tracking-wider">
                  {issue.severity === 'error' ? 'Error' : 'Advisory'} · {issue.code}
                </span>
                <span className="text-xs leading-snug">{issue.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4 px-4 py-4">
        {node.docKey === 'collect' && <FieldsEditor node={node} fieldsPath={['fields']} context={context} />}
        {node.docKey === 'gate' && <GateEditor node={node} context={context} />}
        {groupsOf(node).map((group) => {
          if (group.show && !group.show(body)) return null;
          const fields = group.fields.filter((field) => !field.show || field.show(body));
          if (fields.length === 0) return null;
          return (
            <div key={group.title} className="flex flex-col gap-2.5">
              <SectionTitle>{group.title}</SectionTitle>
              {fields.map((field) => (
                <SpecField key={`${field.path.join('.')}:${field.control}`} node={node} field={field} context={context} write={write} />
              ))}
            </div>
          );
        })}
        {node.docKey === 'assess' && (body.kind === 'human' || body.kind === 'self' || body.fields !== undefined) && (
          <FieldsEditor node={node} fieldsPath={['fields']} context={context} title="Verdict form" />
        )}

        {(provenance.length > 0 || declared.length > 0) && (
          <div className="flex flex-col gap-1.5">
            <SectionTitle>Reads from upstream</SectionTitle>
            {provenance.map((upstream) => (
              <button
                key={upstream.key}
                type="button"
                onClick={() => select(upstream.key)}
                className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2.5 py-1.5 text-left hover:bg-foreground/[0.06]"
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: upstream.family === 'unknown' ? '#f87171' : FAMILIES[upstream.family].hue }} />
                <span className="font-mono text-xs text-white">{upstream.id}</span>
                <span className="ml-auto text-[11px] text-white/35">{upstream.family === 'unknown' ? 'node' : FAMILIES[upstream.family].label}</span>
              </button>
            ))}
            {declared.map((root) => (
              <div key={root} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2.5 py-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-brandCP" />
                <span className="font-mono text-xs text-white">{root}.*</span>
                <span className="ml-auto text-[11px] text-white/35">{humanize(root)}</span>
              </div>
            ))}
          </div>
        )}

        {touched.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <SectionTitle>Resources it touches</SectionTitle>
            {touched.map((resource) => (
              <div key={resource.name} className="flex flex-col gap-1 rounded-lg border border-brandCP/40 px-2.5 py-2 shadow-[0_0_0_3px_color-mix(in_srgb,var(--theme-primary)_12%,transparent)]">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-white">{resource.name}</span>
                  <span className="ml-auto text-[10px] text-white/40">{node.resources.filter((use) => use.type === resource.name).map((use) => use.verb).join(' · ')}</span>
                </div>
                {resource.claim && <span className="text-[11px] text-white/45">claim · {resource.claim}</span>}
              </div>
            ))}
          </div>
        )}

        <details className="group flex flex-col gap-2">
          <summary className="cursor-pointer list-none text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35 hover:text-white/60">
            Advanced · node YAML
          </summary>
          <div className="mt-2">
            <YamlSnippet
              value={body}
              rows={10}
              disabled={readOnly}
              onCommit={(value) => apply(setAt(source, node.bodyPath, value ?? {}))}
            />
            {issuesAt(node.path).length > 0 && <span className="text-[11px] text-white/35">{issuesAt(node.path).length} diagnostic(s) on this node</span>}
          </div>
        </details>

        {!readOnly && (
          <button
            type="button"
            onClick={remove}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-white/10 py-1.5 text-xs text-white/45 transition-colors hover:border-red-400/40 hover:text-red-400"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {node.docKey === 'entry' ? 'Delete lane' : 'Delete node'}
          </button>
        )}
      </div>
    </div>
  );
}

function SpecField({ node, field, context, write }: { node: CanvasNode; field: FieldSpec; context: ContextEntry[]; write: (path: readonly (string | number)[], value: unknown, coalesce?: boolean) => void }) {
  const { readOnly, model, issuesAt } = useEditor();
  const raw = at(node.body, field.path);
  const issues = issuesAt([...node.bodyPath, ...field.path]);
  const invalid = issues.some((issue) => issue.severity === 'error');
  const text = raw === undefined || raw === null ? '' : typeof raw === 'string' ? raw : String(raw);
  const clean = (value: string) => (value.trim() === '' ? undefined : value);

  let control;
  switch (field.control) {
    case 'expr':
      control = <ExpressionInput value={text} context={context} onCommit={(value) => write(field.path, clean(value))} disabled={readOnly} invalid={invalid} multiline={text.length > 48} />;
      break;
    case 'text':
      control = <TextInput value={text} onCommit={(value) => write(field.path, clean(value))} disabled={readOnly} invalid={invalid} />;
      break;
    case 'number':
      control = (
        <TextInput
          value={text}
          onCommit={(value) => write(field.path, value.trim() === '' ? undefined : Number.isFinite(Number(value)) ? Number(value) : value)}
          disabled={readOnly}
          invalid={invalid}
        />
      );
      break;
    case 'enum':
      control = (
        <SelectInput
          value={text}
          options={(field.options ?? []).map((option) => ({ value: option, label: option || '—' }))}
          onCommit={(value) => write(field.path, clean(value), false)}
          disabled={readOnly}
        />
      );
      break;
    case 'bool': {
      const on = field.truthy !== undefined ? raw === field.truthy : raw === true;
      control = <ToggleChip on={on} label={on ? 'on' : 'off'} disabled={readOnly} onToggle={() => write(field.path, on ? undefined : (field.truthy ?? true), false)} />;
      break;
    }
    case 'resource':
      control = (
        <SelectInput
          value={text}
          options={[{ value: '', label: '—' }, ...model.resources.map((resource) => ({ value: resource.name, label: resource.name }))]}
          onCommit={(value) => write(field.path, clean(value), false)}
          disabled={readOnly}
        />
      );
      break;
    case 'aggregate':
      control = (
        <SelectInput
          value={text}
          options={[{ value: '', label: '— none' }, ...model.aggregates.map((aggregate) => ({ value: `lifecycle.${aggregate.id}`, label: aggregate.id }))]}
          onCommit={(value) => {
            if (!value) write(field.path.slice(0, -1), undefined, false);
            else write(field.path, value, false);
          }}
          disabled={readOnly}
        />
      );
      break;
    case 'yaml':
      control = <YamlSnippet value={raw} rows={Math.min(8, Math.max(3, (JSON.stringify(raw ?? '').match(/[,{[]/g)?.length ?? 1) + 1))} disabled={readOnly} onCommit={(value) => write(field.path, value, false)} />;
      break;
  }

  return (
    <FieldShell label={field.label} type={field.control === 'expr' ? 'expression' : field.control} hint={field.hint} issues={issues}>
      {control}
    </FieldShell>
  );
}

/** Les champs d'un formulaire (Collect, ou le verdict d'un Assess humain) : nom, type, condition. */
function FieldsEditor({ node, fieldsPath, context, title = 'Form fields' }: { node: CanvasNode; fieldsPath: string[]; context: ContextEntry[]; title?: string }) {
  const { source, apply, readOnly, issuesAt } = useEditor();
  const fields = at(node.body, fieldsPath);
  const entries = isRec(fields) ? Object.entries(fields) : [];
  const base: Path = [...node.bodyPath, ...fieldsPath];

  const addField = () => {
    const taken = new Set(entries.map(([name]) => name));
    let name = 'field';
    for (let n = 2; taken.has(name); n++) name = `field_${n}`;
    apply(setAt(source, [...base, name], { type: 'string' }));
  };

  return (
    <div className="flex flex-col gap-2.5">
      <SectionTitle
        action={
          !readOnly && (
            <button type="button" onClick={addField} className="flex items-center gap-1 text-[11px] font-semibold text-brandCP hover:opacity-80">
              <Plus className="h-3 w-3" /> field
            </button>
          )
        }
      >
        {title}
      </SectionTitle>
      <datalist id="graph-field-types">
        {TYPE_SUGGESTIONS.map((type) => (
          <option key={type} value={type} />
        ))}
      </datalist>
      {entries.length === 0 && <span className="text-[11px] text-white/35">No field yet.</span>}
      {entries.map(([name, decl]) => {
        const record = isRec(decl) ? decl : {};
        const issues = issuesAt([...base, name]);
        return (
          <div key={name} className="flex flex-col gap-1.5 rounded-lg border border-white/[0.07] bg-white/[0.015] p-2">
            <div className="flex items-center gap-1.5">
              <div className="w-[42%]">
                <TextInput value={name} disabled={readOnly} onCommit={(next) => next.trim() && apply(renameKey(source, base, name, next.trim()))} />
              </div>
              <input
                list="graph-field-types"
                className={inputClass}
                defaultValue={typeof record.type === 'string' ? record.type : JSON.stringify(record.type)}
                key={String(record.type)}
                disabled={readOnly}
                onBlur={(event) => event.target.value.trim() && event.target.value !== record.type && apply(setAt(source, [...base, name, 'type'], event.target.value.trim()))}
                onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
              />
              {!readOnly && (
                <button type="button" title="Remove field" onClick={() => apply(removeAt(source, [...base, name]))} className="rounded p-1 text-white/30 hover:text-red-400">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {(record.when !== undefined || record.check !== undefined || record.where !== undefined) && (
              <div className="flex flex-col gap-1">
                {(['when', 'check', 'where'] as const).map((key) =>
                  record[key] === undefined ? null : (
                    <div key={key} className="flex items-center gap-1.5">
                      <span className="w-10 shrink-0 text-[10px] text-white/35">{key}</span>
                      <div className="flex-1">
                        <ExpressionInput value={String(record[key])} context={context} disabled={readOnly} onCommit={(value) => apply(setAt(source, [...base, name, key], value.trim() || undefined), `${node.key}:${name}.${key}`)} />
                      </div>
                    </div>
                  )
                )}
              </div>
            )}
            {!readOnly && (
              <div className="flex gap-1">
                {(['when', 'check'] as const)
                  .filter((key) => record[key] === undefined)
                  .map((key) => (
                    <button key={key} type="button" onClick={() => apply(setAt(source, [...base, name, key], 'true'))} className="text-[10px] text-white/30 hover:text-brandCP">
                      + {key}
                    </button>
                  ))}
              </div>
            )}
            {issues.map((issue, index) => (
              <span key={index} className={`text-[11px] ${issue.severity === 'error' ? 'text-red-400' : 'text-amber-300'}`}>
                {issue.message}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function GateEditor({ node, context }: { node: CanvasNode; context: ContextEntry[] }) {
  const { source, apply, readOnly, issuesAt } = useEditor();
  const routing = Array.isArray(node.body.branch);
  const gatePath = node.bodyPath;
  const conditions = Array.isArray(node.body.all) ? node.body.all : [];
  const branches = Array.isArray(node.body.branch) ? node.body.branch : [];

  return (
    <div className="flex flex-col gap-2.5">
      <SectionTitle>Gate</SectionTitle>
      <div className="flex gap-1.5">
        <ToggleChip on={!routing} label="Blocking" disabled={readOnly} onToggle={() => routing && apply(setGateMode(source, gatePath, 'blocking'))} />
        <ToggleChip on={routing} label="Routing" disabled={readOnly} onToggle={() => !routing && apply(setGateMode(source, gatePath, 'routing'))} />
      </div>
      {!routing && (
        <>
          {conditions.map((condition, index) => (
            <FieldShell key={index} label={`Condition ${index + 1}`} type="expression" issues={issuesAt([...gatePath, 'all', index])}>
              <div className="flex items-start gap-1">
                <div className="flex-1">
                  <ExpressionInput value={String(condition)} context={context} disabled={readOnly} onCommit={(value) => apply(setAt(source, [...gatePath, 'all', index], value), `${node.key}:all.${index}`)} />
                </div>
                {!readOnly && conditions.length > 1 && (
                  <button type="button" onClick={() => apply(removeAt(source, [...gatePath, 'all', index]))} className="rounded p-1.5 text-white/30 hover:text-red-400">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </FieldShell>
          ))}
          {!readOnly && (
            <button type="button" onClick={() => apply(setAt(source, [...gatePath, 'all', conditions.length], 'true'))} className="self-start text-[11px] font-semibold text-brandCP hover:opacity-80">
              + condition
            </button>
          )}
          <FieldShell label="Refusal status" type="enum">
            <SelectInput
              value={node.body.refuse === undefined ? '' : String(node.body.refuse)}
              options={[{ value: '', label: '422 (default)' }, { value: '403', label: '403 — not you' }, { value: '409', label: '409 — conflict' }, { value: '422', label: '422' }]}
              disabled={readOnly}
              onCommit={(value) => apply(setAt(source, [...gatePath, 'refuse'], value ? Number(value) : undefined))}
            />
          </FieldShell>
        </>
      )}
      {routing && (
        <>
          {branches.map((branch, index) => {
            const isElse = isRec(branch) && branch.else !== undefined;
            return (
              <FieldShell key={index} label={isElse ? 'Else' : `Branch ${index + 1} · when`} type={isElse ? undefined : 'expression'} issues={issuesAt([...gatePath, 'branch', index])}>
                <div className="flex items-start gap-1">
                  <div className="flex-1">
                    {isElse ? (
                      <span className="block rounded-lg border border-white/[0.06] px-2.5 py-1.5 text-xs text-white/40">every other case</span>
                    ) : (
                      <ExpressionInput
                        value={isRec(branch) ? String(branch.when ?? '') : ''}
                        context={context}
                        disabled={readOnly}
                        onCommit={(value) => apply(setAt(source, [...gatePath, 'branch', index, 'when'], value), `${node.key}:branch.${index}`)}
                      />
                    )}
                  </div>
                  {!readOnly && branches.length > 1 && (
                    <button type="button" title="Remove branch and its nodes" onClick={() => apply(removeAt(source, [...gatePath, 'branch', index]))} className="rounded p-1.5 text-white/30 hover:text-red-400">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </FieldShell>
            );
          })}
          {!readOnly && (
            <div className="flex gap-3">
              <button type="button" onClick={() => apply(addBranch(source, gatePath))} className="text-[11px] font-semibold text-brandCP hover:opacity-80">
                + branch
              </button>
              {!branches.some((branch) => isRec(branch) && branch.else !== undefined) && (
                <button type="button" onClick={() => apply(setAt(source, [...gatePath, 'branch', branches.length], { else: { nodes: [] } }))} className="text-[11px] font-semibold text-white/40 hover:text-brandCP">
                  + else
                </button>
              )}
            </div>
          )}
          <span className="text-[11px] leading-snug text-white/35">Branches always reconverge to the next node below the gate — the editor draws the merge.</span>
        </>
      )}
    </div>
  );
}
