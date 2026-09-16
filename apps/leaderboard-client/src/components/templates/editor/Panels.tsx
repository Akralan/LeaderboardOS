'use client';

import { useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, Loader2, Upload, X } from 'lucide-react';
import { describeTemplate, type SurfaceField, type SurfaceLane } from '../../../../../../packages/interpreter/describe';
import { useEditor } from './EditorContext';
import { humanize, isRec, locate, type DiagnosticTarget } from './model';
import type { Diagnostic } from './useTemplateDocument';

/* ─────────────────────────── Problems ─────────────────────────── */

export function ProblemsDrawer({ diagnostics, open, onToggle, onFocus }: { diagnostics: Diagnostic[]; open: boolean; onToggle: () => void; onFocus: (target: DiagnosticTarget) => void }) {
  const { model } = useEditor();
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  const advisories = diagnostics.length - errors;

  const whereOf = (diagnostic: Diagnostic) => {
    const target = locate(model, diagnostic.path);
    if (target.kind === 'node') return model.nodes.get(target.key)?.id ?? diagnostic.path;
    if (target.kind === 'lane') return `lane ${model.lanes[target.index]?.id ?? target.index}`;
    if (target.kind === 'declaration') return target.name ? `${target.tab}.${target.name}` : target.tab;
    return diagnostic.path || 'document';
  };

  return (
    <div className="shrink-0 border-t border-white/[0.08]" style={{ background: 'color-mix(in srgb, var(--foreground) 2%, var(--background))' }}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2.5 px-4 py-2 text-left">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/40">Problems</span>
        <span className={`rounded-full px-2 py-px text-[11px] font-semibold ${errors ? 'bg-red-500/15 text-red-300' : 'bg-brandCP/10 text-brandCP'}`}>{errors}</span>
        {advisories > 0 && <span className="rounded-full bg-amber-400/10 px-2 py-px text-[11px] font-semibold text-amber-300">{advisories} advisory</span>}
        <span className="ml-auto text-[11px] text-white/30">{open ? 'click a problem to focus it' : 'expand'}</span>
        {open ? <ChevronDown className="h-3.5 w-3.5 text-white/30" /> : <ChevronUp className="h-3.5 w-3.5 text-white/30" />}
      </button>
      {open && (
        <div className="max-h-[164px] overflow-auto border-t border-white/[0.05]">
          {diagnostics.map((diagnostic, index) => (
            <button
              key={index}
              type="button"
              onClick={() => onFocus(locate(model, diagnostic.path))}
              className="flex w-full items-center gap-2.5 border-b border-white/[0.04] px-4 py-2 text-left hover:bg-foreground/[0.03]"
            >
              <span className={`shrink-0 rounded px-1.5 py-px text-[10px] font-bold uppercase tracking-wide ${diagnostic.severity === 'error' ? 'bg-red-500/15 text-red-300' : 'bg-amber-400/12 text-amber-300'}`}>
                {diagnostic.severity === 'error' ? 'error' : 'warn'}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-white/30">{diagnostic.code}</span>
              <span className="shrink-0 font-mono text-xs text-white/85">{whereOf(diagnostic)}</span>
              <span className="min-w-0 truncate text-xs text-white/50" title={diagnostic.message}>{diagnostic.message}</span>
              <span className="ml-auto shrink-0 text-[11px] text-brandCP">Focus</span>
            </button>
          ))}
          {diagnostics.length === 0 && (
            <div className="px-4 py-3.5 text-xs text-brandCP">Format, references, types, graph shape, economy and claims all check out. Ready to publish.</div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────── Source ─────────────────────────── */

export function SourcePanel({ onClose }: { onClose: () => void }) {
  const { source } = useEditor();
  const [copied, setCopied] = useState(false);
  const lines = source.split('\n');
  return (
    <div className="flex w-[360px] shrink-0 flex-col border-l border-white/[0.08] bg-foreground/[0.03]">
      <div className="flex items-center gap-2 border-b border-white/[0.07] px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/40">Source · read-only</span>
        <button
          type="button"
          title="Copy YAML"
          onClick={() => {
            void navigator.clipboard?.writeText(source);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="ml-auto rounded p-1 text-white/40 hover:text-white"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-brandCP" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        <button type="button" onClick={onClose} className="rounded p-1 text-white/40 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto py-3 font-mono text-[11px] leading-[1.65] text-white/70">
        {lines.map((line, index) => (
          <div key={index} className="flex">
            <span className="w-10 shrink-0 select-none pr-3 text-right text-white/20">{index + 1}</span>
            <span className={`whitespace-pre pr-4 ${line.trimStart().startsWith('#') ? 'text-white/35' : ''}`}>{line}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

/* ─────────────────────────── Preview ─────────────────────────── */

/**
 * « Ce que les joueurs verront » : la surface que `describeTemplate` tire du
 * texte courant — les mêmes segments et champs typés que l'UI générée joue —,
 * rendue sans challenge, contrôles inertes. Elle se forme dès que le brouillon
 * valide, et suit chaque écriture.
 */
export function PreviewPanel({ onClose }: { onClose: () => void }) {
  const { source, templateKey, model } = useEditor();
  const [laneId, setLaneId] = useState<string | null>(null);

  const described = useMemo(() => {
    try {
      return { surface: describeTemplate(source, templateKey).surface, error: null };
    } catch (error) {
      return { surface: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [source, templateKey]);

  const lanes = described.surface?.lanes ?? [];
  const lane = lanes.find((candidate) => candidate.id === laneId) ?? lanes.find((candidate) => candidate.trigger === 'user') ?? lanes[0];
  const canvasLane = lane ? model.lanes.find((candidate) => candidate.id === lane.id) : undefined;

  const rewards = canvasLane ? [...model.nodes.values()].filter((node) => node.laneIndex === canvasLane.index && node.docKey === 'reward') : [];
  const claim = canvasLane ? [...model.nodes.values()].find((node) => node.laneIndex === canvasLane.index && node.resources.some((use) => use.verb === 'claims')) : undefined;
  const claimed = claim ? model.resources.find((resource) => resource.name === claim.resources.find((use) => use.verb === 'claims')?.type) : undefined;
  const visibleFields = claimed?.fields.filter((field) => field.tone !== 'hidden' && (field.tone === 'everyone' || /claimant|author|role/.test(field.visibility))) ?? [];

  return (
    <div className="flex w-[330px] shrink-0 flex-col overflow-auto border-l border-white/[0.08]">
      <div className="flex items-center gap-2 border-b border-white/[0.07] px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/40">What players will see</span>
        <button type="button" onClick={onClose} className="ml-auto rounded p-1 text-white/40 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>
      {!described.surface ? (
        <div className="flex flex-col gap-2 px-4 py-5">
          <span className="text-sm font-medium text-white/70">The screens form once the template validates.</span>
          <span className="text-xs leading-relaxed text-white/40">Fix the problems below; the preview follows every edit.</span>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1 px-3 py-2.5">
            {lanes.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() => setLaneId(candidate.id)}
                className={`rounded-md px-2.5 py-1 text-xs ${candidate.id === lane?.id ? 'bg-brandCP/10 font-semibold text-brandCP' : 'font-medium text-white/45 hover:text-white/75'}`}
              >
                {humanize(candidate.id)}
                <span className="ml-1 text-[10px] opacity-60">{candidate.trigger}</span>
              </button>
            ))}
          </div>
          {lane ? (
            <div className="flex flex-col gap-3 px-4 pb-6">
              {model.counters.length > 0 && lane.trigger === 'user' && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-xl bg-brandCP/[0.07] px-3 py-2">
                  {model.counters.map((counter) => (
                    <span key={counter.name} className="flex items-baseline gap-1.5 text-xs">
                      <span className="text-white/55">{humanize(counter.name)}</span>
                      <span className="font-semibold text-brandCP">—</span>
                    </span>
                  ))}
                </div>
              )}
              {claimed && (
                <div className="flex flex-col gap-2 rounded-xl border border-white/[0.08] p-3">
                  <span className="text-[11px] text-white/40">
                    {humanize(claimed.name)} claimed for you{claimed.claim ? ` · ${claimed.claim}` : ''}
                  </span>
                  {visibleFields.map((field) =>
                    field.type === 'url' || field.type === 'file' ? (
                      <div
                        key={field.name}
                        className="flex h-28 items-end justify-center rounded-lg pb-2"
                        style={{ backgroundImage: 'repeating-linear-gradient(135deg, rgb(255 255 255 / 0.05) 0 8px, transparent 8px 16px)' }}
                      >
                        <span className="font-mono text-[10px] text-white/40">{claimed.name}.{field.name}</span>
                      </div>
                    ) : (
                      <div key={field.name} className="flex items-baseline gap-2 text-xs">
                        <span className="text-white/45">{humanize(field.name)}</span>
                        <span className="font-mono text-white/70">{field.type}</span>
                      </div>
                    )
                  )}
                </div>
              )}
              {lane.segments.map((segment, index) => (
                <div key={segment.path} className="flex flex-col gap-2.5 rounded-xl border border-white/[0.08] p-3">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-white/30">
                    Step {index + 1} · {segment.path}
                  </span>
                  {segment.fields.length === 0 && <span className="text-xs text-white/45">A single action — no field.</span>}
                  {segment.fields.map((field) => (
                    <PreviewField key={`${field.gesture}.${field.name}`} field={field} />
                  ))}
                  <span className="mt-1 rounded-lg bg-brandCP/80 py-2 text-center text-xs font-semibold text-black/80">{segment.final ? 'Submit' : 'Continue'}</span>
                  <span className="text-[10px] leading-snug text-white/30">
                    Generated from {[...new Set(segment.fields.map((field) => field.gesture))].join(', ') || 'the lane'}
                  </span>
                </div>
              ))}
              {rewards.map((reward) => (
                <div key={reward.key} className="flex items-center justify-between gap-2 rounded-xl border border-dashed border-white/10 px-3 py-2">
                  <span className="text-xs text-white/50">Reward · {reward.id}</span>
                  <span className="truncate font-mono text-[11px] text-white/80" title={reward.lines[0]?.v}>{reward.lines[0]?.v}</span>
                </div>
              ))}
              <PreviewNote lane={lane} />
            </div>
          ) : (
            <span className="px-4 py-4 text-xs text-white/40">No user or admin lane: nothing to play on screen.</span>
          )}
        </>
      )}
    </div>
  );
}

function PreviewNote({ lane }: { lane: SurfaceLane }) {
  return (
    <span className="text-[11px] leading-relaxed text-white/30">
      {lane.trigger === 'admin' ? 'Manager screen' : 'Contributor screen'} · {lane.segments.length} call{lane.segments.length === 1 ? '' : 's'}
      {lane.claims ? ' · claims a work unit (resume, release and file reads are generated)' : ''}
    </span>
  );
}

function PreviewField({ field }: { field: SurfaceField }) {
  const label = (
    <span className="text-[10px] font-semibold uppercase tracking-widest text-white/45">
      {humanize(field.name)}
      {field.conditional && <span className="ml-1 normal-case tracking-normal text-white/30">(conditional)</span>}
    </span>
  );
  const box = 'rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white/35';
  switch (field.kind) {
    case 'enum':
      return (
        <div className="flex flex-col gap-1.5">
          {label}
          {(field.values ?? ['…']).map((value, index) => (
            <span key={value} className={`flex items-center justify-between rounded-lg border px-3 py-2 text-xs ${index === 1 ? 'border-brandCP/45 bg-brandCP/[0.08] text-brandCP' : 'border-white/10 text-white/75'}`}>
              {value}
              <span className="font-mono text-[10px] text-white/30">{index + 1}</span>
            </span>
          ))}
        </div>
      );
    case 'file':
      return (
        <div className="flex flex-col gap-1.5">
          {label}
          <span className={`${box} flex items-center justify-center gap-1.5 border-dashed py-3`}>
            <Upload className="h-3.5 w-3.5" /> Drop a file
          </span>
        </div>
      );
    case 'bool':
      return (
        <div className="flex items-center justify-between">
          {label}
          <span className="h-4 w-7 rounded-full bg-white/15" />
        </div>
      );
    case 'json':
      return (
        <div className="flex flex-col gap-1.5">
          {label}
          <span className={`${box} h-14 font-mono`}>{'{ … }'}</span>
        </div>
      );
    case 'ref':
    case 'link':
      return (
        <div className="flex flex-col gap-1.5">
          {label}
          <span className={`${box} flex justify-between`}>
            Pick {field.resource ? `a ${humanize(field.resource).toLowerCase()}` : 'a submission'} <ChevronDown className="h-3.5 w-3.5" />
          </span>
        </div>
      );
    default:
      return (
        <div className="flex flex-col gap-1.5">
          {label}
          <span className={box}>{field.kind === 'url' ? 'https://' : field.kind === 'int' || field.kind === 'number' ? '0' : field.kind === 'date' ? 'yyyy-mm-dd' : 'Type here…'}</span>
        </div>
      );
  }
}

/* ─────────────────────────── Publish ─────────────────────────── */

const PASSES: readonly { code: string; label: string }[] = [
  { code: 'format', label: 'Format' },
  { code: 'reference', label: 'References' },
  { code: 'type', label: 'Types' },
  { code: 'shape', label: 'Graph shape' },
  { code: 'economy', label: 'Economy' },
  { code: 'claim', label: 'Claims' },
  { code: 'support', label: 'Engine support' },
];

export interface VersionOption {
  level: string;
  label: string;
  version: string;
}

export function PublishModal({
  name, diagnostics, options, onClose, onPublish,
}: {
  name: string;
  diagnostics: Diagnostic[];
  options: VersionOption[];
  onClose: () => void;
  onPublish: (version: string) => Promise<{ error: string; diagnostics?: Diagnostic[] } | null>;
}) {
  const { model } = useEditor();
  const [choice, setChoice] = useState(options[Math.min(1, options.length - 1)]?.version ?? options[0]?.version);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ error: string; diagnostics?: Diagnostic[] } | null>(null);
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const resources = isRec(model.doc.resources) ? Object.keys(model.doc.resources).length : 0;

  const detail = (code: string) => {
    const count = diagnostics.filter((diagnostic) => diagnostic.code === code && diagnostic.severity === 'error').length;
    if (count) return `${count} error${count === 1 ? '' : 's'}`;
    if (code === 'shape') return `${model.lanes.length} lane${model.lanes.length === 1 ? '' : 's'} · no cycles`;
    if (code === 'claim') return `${resources} resource${resources === 1 ? '' : 's'}`;
    if (code === 'economy') return 'pool-clamped';
    const advisories = diagnostics.filter((diagnostic) => diagnostic.code === code).length;
    return advisories ? `ok · ${advisories} advisory` : 'ok';
  };

  return (
    <div onClick={onClose} className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
      <div onClick={(event) => event.stopPropagation()} className="animate-pop-in flex w-full max-w-[480px] flex-col gap-4 rounded-2xl border border-white/10 p-5 shadow-2xl" style={{ background: 'var(--background)' }}>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brandCP">Publish template</span>
          <span className="text-xl font-semibold tracking-tight text-white">{name}</span>
        </div>
        <div className="flex flex-col gap-1.5 rounded-xl bg-white/[0.03] p-3">
          {PASSES.map((pass) => {
            const failed = errors.some((diagnostic) => diagnostic.code === pass.code);
            return (
              <div key={pass.code} className="flex items-center gap-2.5 text-xs">
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${failed ? 'bg-red-500/80 text-white' : 'bg-brandCP text-black'}`}>{failed ? '!' : '✓'}</span>
                <span className="font-medium text-white/85">{pass.label}</span>
                <span className={`ml-auto ${failed ? 'text-red-300' : 'text-white/45'}`}>{detail(pass.code)}</span>
              </div>
            );
          })}
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-xs font-semibold text-white/80">Version</span>
          <div className="flex gap-2">
            {options.map((option) => (
              <button
                key={option.version}
                type="button"
                onClick={() => setChoice(option.version)}
                className={`flex flex-1 flex-col gap-0.5 rounded-xl border px-3 py-2.5 text-left ${choice === option.version ? 'border-brandCP bg-brandCP/[0.08]' : 'border-white/10 hover:border-foreground/20'}`}
              >
                <span className={`text-xs font-semibold ${choice === option.version ? 'text-brandCP' : 'text-white/80'}`}>{option.label}</span>
                <span className="font-mono text-xs text-white/45">{option.version}</span>
              </button>
            ))}
          </div>
        </div>
        <span className="text-xs leading-relaxed text-white/45">Published versions are immutable — future edits create a new version.</span>
        {failure && (
          <div className="flex flex-col gap-1 rounded-lg border border-red-400/30 bg-red-500/[0.08] px-3 py-2 text-xs text-red-300">
            <span className="font-semibold">{failure.error}</span>
            {failure.diagnostics?.slice(0, 5).map((diagnostic, index) => (
              <span key={index} className="font-mono text-[11px] opacity-80">
                {diagnostic.path} — {diagnostic.message}
              </span>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2 text-sm font-medium text-white/70 hover:bg-foreground/[0.04]">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || errors.length > 0 || !choice}
            onClick={async () => {
              setBusy(true);
              setFailure(null);
              const result = await onPublish(choice!);
              setBusy(false);
              if (result) setFailure(result);
            }}
            className="flex items-center gap-2 rounded-xl bg-brandCP px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Publish v{choice}
          </button>
        </div>
      </div>
    </div>
  );
}
