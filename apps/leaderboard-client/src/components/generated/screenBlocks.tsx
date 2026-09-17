'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, ExternalLink, Loader2 } from 'lucide-react';
import type { SurfaceBlock, SurfaceField, SurfaceLane, SurfaceSegment } from '../../../../../packages/interpreter/describe';
import { BINDING } from '../../../../../packages/interpreter/ui/catalog';
import { flowActionUrl } from '@/lib/challengeActions';
import { GeneratedField, type FieldValue } from './GeneratedField';
import type { ScreenRuntime } from './GeneratedScreen';
import { errorOf, fgAt, humanize } from './format';

/**
 * Les briques d'un écran composé, et les variables qui les coordonnent
 * ------------------------------------------------------------------
 * Un `picker` choisit une instance pour l'écran (`selects: app`), un `stepper`
 * une étape, un `form` fixe des champs d'un segment sur ces choix
 * (`values: {app: $app}`) et garde ce que le geste a créé (`selects: run`), un
 * `frame` montre l'URL d'un choix. Les variables vivent dans l'écran ; une
 * liaison `$name.field` se lit ici, après que le validateur l'a admise.
 */

interface ScreenVars {
  vars: Record<string, unknown>;
  set: (name: string, value: unknown) => void;
}

export const ScreenVarsContext = createContext<ScreenVars>({ vars: {}, set: () => undefined });

export function useScreenVars(): ScreenVars {
  return useContext(ScreenVarsContext);
}

/** Une liaison résolue sur les variables de l'écran ; `undefined` tant que son choix n'est pas fait. `unbound` : une valeur littérale. */
export function resolveBinding(value: unknown, vars: Record<string, unknown>): { bound: boolean; value: unknown } {
  if (typeof value !== 'string') return { bound: false, value };
  const match = BINDING.exec(value);
  if (!match) return { bound: false, value };
  const [, name, field] = match;
  const chosen = vars[name];
  if (chosen === undefined || chosen === null) return { bound: true, value: undefined };
  if (!field) return { bound: true, value: chosen };
  return { bound: true, value: chosen && typeof chosen === 'object' ? (chosen as Record<string, unknown>)[field] : undefined };
}

/** Le nom d'une variable dans une liaison, pour dire ce qu'il manque. */
function bindingName(value: unknown): string | null {
  const match = typeof value === 'string' ? BINDING.exec(value) : null;
  return match ? match[1] : null;
}

function Hint({ children }: { children: string }) {
  return <p className="text-xs" style={{ color: fgAt(0.4) }}>{children}</p>;
}

const card = 'space-y-3 rounded-[20px] border border-white/[0.08] bg-white/[0.02] p-4';

/** La lane d'un bloc et le segment qu'il joue (`segment`, le premier sinon), ou la raison de leur absence. */
function laneOf(block: SurfaceBlock, runtime: ScreenRuntime): { lane: SurfaceLane; segment: SurfaceSegment } | string {
  const id = typeof block.props.lane === 'string' ? block.props.lane : '';
  const lane = runtime.description.surface.lanes.find((candidate) => candidate.id === id);
  if (!lane) return `Lane '${id}' is not on this template.`;
  const index = typeof block.props.segment === 'number' ? block.props.segment : 0;
  const segment = lane.segments[index];
  if (!segment) return `Lane '${id}' has no segment ${index} to play.`;
  return { lane, segment };
}

/** Le champ par lequel un picker ou un stepper choisit : celui du bloc, sinon le premier `ref` ou `link` du segment. */
function pickField(block: SurfaceBlock, segment: SurfaceSegment): SurfaceField | null {
  const wanted = typeof block.props.field === 'string' ? block.props.field : null;
  return segment.fields.find((field) => (wanted ? field.name === wanted : field.kind === 'ref' || field.kind === 'link')) ?? null;
}

interface Option {
  id: string;
  [key: string]: unknown;
}

/** Les options d'un champ, relues à chaque geste enregistré sur l'écran. */
function useOptions(runtime: ScreenRuntime, lane: SurfaceLane | null, field: SurfaceField | null) {
  const [options, setOptions] = useState<Option[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!lane || !field) return;
    let cancelled = false;
    fetch(flowActionUrl(runtime.challengeId, `${lane.id}/options?field=${encodeURIComponent(`${field.gesture}.${field.name}`)}`))
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) setError(typeof body?.error === 'string' ? body.error : `Request failed (${res.status})`);
        else setOptions(Array.isArray(body?.options) ? body.options : []);
      })
      .catch(() => !cancelled && setError('Network error'));
    return () => { cancelled = true; };
  }, [runtime.challengeId, runtime.version, lane, field]);
  return { options, error };
}

/** Ce qui nomme une instance : un titre, un nom, un auteur, sinon une adresse — jamais un identifiant. */
function nameOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['title', 'name', 'author_name']) if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  for (const item of Object.values(record)) {
    const nested = item && typeof item === 'object' && !Array.isArray(item) ? nameOf(item) : null;
    if (nested) return nested;
  }
  return null;
}

function urlOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const found = Object.values(value as Record<string, unknown>).find((item) => typeof item === 'string' && /^https?:\/\//.test(item));
  return typeof found === 'string' ? found : null;
}

// ─── Picker ─────────────────────────────────────────────────────────────────

/** Ce que j'ai créé qui désigne une instance : l'état que le picker montre sur chacune. */
function useMineStatus(runtime: ScreenRuntime, type: string | null) {
  const [mine, setMine] = useState<Record<string, unknown>[] | null>(null);
  useEffect(() => {
    if (!type) return;
    let cancelled = false;
    fetch(flowActionUrl(runtime.challengeId, 'mine'))
      .then(async (res) => (res.ok ? ((await res.json()) as { resources?: Record<string, Record<string, unknown>[]> }).resources?.[type] ?? [] : []))
      .then((rows) => !cancelled && setMine(rows))
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [runtime.challengeId, runtime.version, type]);
  return mine;
}

function statusOf(mine: Record<string, unknown>[] | null, optionId: string): 'completed' | 'in_progress' | null {
  if (!mine) return null;
  const row = mine.find((candidate) => Object.values(candidate).some((value) => value && typeof value === 'object' && (value as { id?: unknown }).id === optionId));
  if (!row) return null;
  return row.open === false ? 'completed' : 'in_progress';
}

export function PickerBlock({ block, runtime }: { block: SurfaceBlock; runtime: ScreenRuntime }) {
  const { vars, set } = useScreenVars();
  const resolved = laneOf(block, runtime);
  const lane = typeof resolved === 'string' ? null : resolved.lane;
  const field = typeof resolved === 'string' ? null : pickField(block, resolved.segment);
  const { options, error } = useOptions(runtime, lane, field);
  const statusType = typeof block.props.status === 'string' ? block.props.status : null;
  const mine = useMineStatus(runtime, statusType);
  const selects = block.selects ?? null;
  const chosen = selects ? (vars[selects] as Option | undefined) : undefined;

  if (typeof resolved === 'string') return <Hint>{resolved}</Hint>;
  if (!field) return <Hint>{`Lane '${lane?.id}' picks nothing: its first segment has no ref or link field.`}</Hint>;
  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (!options) return <Hint>Loading…</Hint>;
  if (options.length === 0) return <Hint>Nothing to pick yet.</Hint>;

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: fgAt(0.45) }}>{humanize(field.resource ?? field.name)}</p>
      {options.map((option, index) => {
        const active = chosen?.id === option.id;
        const status = statusOf(mine, option.id);
        const url = urlOf(option);
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => selects && set(selects, option)}
            className={`flex w-full flex-col gap-1 rounded-[14px] border px-3.5 py-3 text-left transition-colors ${active ? 'border-brandCP/60 bg-brandCP/10' : 'border-white/[0.08] bg-white/[0.02] hover:border-white/20'}`}
          >
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-white">{nameOf(option) ?? `${humanize(field.resource ?? field.name)} #${index + 1}`}</span>
              {status && (
                <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${status === 'completed' ? 'bg-green-500/15 text-green-400' : 'bg-amber-500/15 text-amber-300'}`}>
                  {status === 'completed' ? 'Completed' : 'In progress'}
                </span>
              )}
            </span>
            {url && <span className="truncate font-mono text-[11px]" style={{ color: fgAt(0.45) }}>{url}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ─── Stepper ────────────────────────────────────────────────────────────────

export function StepperBlock({ block, runtime }: { block: SurfaceBlock; runtime: ScreenRuntime }) {
  const { vars, set } = useScreenVars();
  const resolved = laneOf(block, runtime);
  const lane = typeof resolved === 'string' ? null : resolved.lane;
  const field = typeof resolved === 'string' ? null : pickField(block, resolved.segment);
  const { options, error } = useOptions(runtime, lane, field);
  const order = typeof block.props.order === 'string' ? block.props.order : 'position';
  const steps = useMemo(() => {
    if (!options) return null;
    const sorted = [...options];
    if (sorted.every((step) => typeof step[order] === 'number')) sorted.sort((a, b) => (a[order] as number) - (b[order] as number));
    return sorted;
  }, [options, order]);
  const selects = block.selects ?? null;
  const chosen = selects ? (vars[selects] as Option | undefined) : undefined;
  const index = steps && chosen ? steps.findIndex((step) => step.id === chosen.id) : -1;

  // La première étape est choisie dès que les étapes arrivent.
  useEffect(() => {
    if (steps && steps.length > 0 && selects && index < 0) set(selects, steps[0]);
  }, [steps, selects, index, set]);

  if (typeof resolved === 'string') return <Hint>{resolved}</Hint>;
  if (!field) return <Hint>{`Lane '${lane?.id}' picks nothing: its first segment has no ref field.`}</Hint>;
  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (!steps) return <Hint>Loading…</Hint>;
  if (steps.length === 0) return <Hint>No step yet.</Hint>;
  const current = steps[Math.max(0, index)];
  const title = typeof current.title === 'string' ? current.title : nameOf(current) ?? `Step ${Math.max(0, index) + 1}`;
  const body = typeof current.instructions === 'string' ? current.instructions : typeof current.description === 'string' ? current.description : null;
  const go = (delta: number) => selects && set(selects, steps[Math.min(steps.length - 1, Math.max(0, index + delta))]);

  return (
    <div className={card}>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: fgAt(0.45) }}>Step {Math.max(0, index) + 1} of {steps.length}</span>
        <span className="ml-auto flex gap-1">
          <button type="button" disabled={index <= 0} onClick={() => go(-1)} className="rounded-full border border-white/10 p-1.5 text-white/60 hover:bg-white/5 disabled:opacity-30" aria-label="Previous step"><ArrowLeft className="h-3.5 w-3.5" /></button>
          <button type="button" disabled={index >= steps.length - 1} onClick={() => go(1)} className="rounded-full border border-white/10 p-1.5 text-white/60 hover:bg-white/5 disabled:opacity-30" aria-label="Next step"><ArrowRight className="h-3.5 w-3.5" /></button>
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-brandCP/60 transition-[width]" style={{ width: `${Math.round(((Math.max(0, index) + 1) / steps.length) * 100)}%` }} />
      </div>
      <p className="text-sm font-semibold text-white">{title}</p>
      {body && <p className="text-sm leading-relaxed" style={{ color: fgAt(0.65) }}>{body}</p>}
      <div className="flex flex-wrap gap-1">
        {steps.map((step, position) => (
          <button key={step.id} type="button" onClick={() => selects && set(selects, step)} className={`h-2 w-2 rounded-full ${position === index ? 'bg-brandCP' : 'bg-white/20 hover:bg-white/40'}`} aria-label={`Step ${position + 1}`} />
        ))}
      </div>
    </div>
  );
}

// ─── Form ───────────────────────────────────────────────────────────────────

type Values = Record<string, FieldValue>;

/** Ce qu'une valeur fixée envoie : l'identifiant d'une instance choisie, sinon la valeur. */
function sendable(value: unknown): unknown {
  return value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : value;
}

export function FormBlock({ block, runtime }: { block: SurfaceBlock; runtime: ScreenRuntime }) {
  const { vars, set } = useScreenVars();
  const resolved = laneOf(block, runtime);
  const fixedDecl = block.props.values && typeof block.props.values === 'object' && !Array.isArray(block.props.values) ? (block.props.values as Record<string, unknown>) : {};
  const fixed = useMemo(() => Object.fromEntries(Object.entries(fixedDecl).map(([field, bound]) => [field, resolveBinding(bound, vars)])), [fixedDecl, vars]);
  const missing = Object.entries(fixed).filter(([, entry]) => entry.bound && entry.value === undefined).map(([field]) => bindingName(fixedDecl[field]) ?? field);
  const fixedKey = JSON.stringify(Object.fromEntries(Object.entries(fixed).map(([field, entry]) => [field, sendable(entry.value)])));
  const [values, setValues] = useState<Values>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ cp: number | null; scheduled: boolean } | null>(null);
  const selects = block.selects ?? null;
  const setVar = set;

  // Un autre choix en amont : ce que ce formulaire avait créé ne vaut plus.
  useEffect(() => {
    if (selects) setVar(selects, undefined);
    setDone(null);
  }, [fixedKey, selects, setVar]);

  const submit = useCallback(async () => {
    if (typeof resolved === 'string') return;
    const { segment } = resolved;
    const payload: Record<string, unknown> = {};
    for (const [field, entry] of Object.entries(fixed)) payload[field] = sendable(entry.value);
    for (const field of segment.fields) {
      if (field.name in fixedDecl) continue;
      const value = values[field.name];
      if (value === undefined || value === '') {
        if (field.conditional || field.optional) continue;
        setError(`${humanize(field.name)} is required`);
        return;
      }
      if (field.kind === 'json' && typeof value === 'string') {
        try {
          payload[field.name] = JSON.parse(value);
        } catch {
          setError(`${humanize(field.name)} is not valid JSON`);
          return;
        }
        continue;
      }
      payload[field.name] = value;
    }
    const hasFile = Object.values(payload).some((value) => value instanceof File);
    const request: RequestInit = hasFile
      ? { method: 'POST', body: Object.entries(payload).reduce((form, [key, value]) => { form.append(key, value instanceof File ? value : JSON.stringify(value)); return form; }, new FormData()) }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
    setBusy(true);
    setError('');
    try {
      const res = await fetch(flowActionUrl(runtime.challengeId, segment.path), request);
      if (!res.ok) {
        setError(await errorOf(res));
        return;
      }
      const body = await res.json();
      const createdId = body.created && typeof body.created === 'object' ? Object.values(body.created as Record<string, unknown>).find((value) => typeof value === 'string') : undefined;
      const claimId = body.claim?.claim_id;
      // Un claim posé : la ressource tirée se lit sur la variable (`$card.image_url`), son identifiant vaut le claim.
      const claimed = body.claim?.resource && typeof body.claim.resource === 'object' ? (body.claim.resource as Record<string, unknown>) : {};
      if (selects) setVar(selects, { ...claimed, ...body, id: claimId ?? createdId ?? null });
      setValues({});
      setDone({ cp: typeof body.cp_awarded === 'number' ? body.cp_awarded : null, scheduled: res.status === 202 && Boolean(body.scheduled) });
      runtime.onRecorded();
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  }, [fixed, fixedDecl, resolved, runtime, selects, setVar, values]);

  if (typeof resolved === 'string') return <Hint>{resolved}</Hint>;
  const { lane, segment } = resolved;
  const asked = segment.fields.filter((field) => !(field.name in fixedDecl));
  const label = typeof block.props.label === 'string' && block.props.label ? block.props.label : asked.length === 0 ? (segment.final ? 'Submit' : segment.opensClaim ? 'Draw' : 'Start') : segment.final ? 'Submit' : 'Continue';
  // Un segment qui reprend un claim l'attend dans `values: {claim_id: $card}` ; sans, il ne peut pas jouer.
  const claimMissing = segment.needsClaim && !('claim_id' in fixedDecl);
  const siblingsOf = (name: string) =>
    Object.fromEntries(asked.filter((field) => field.name !== name && (field.kind === 'ref' || field.kind === 'link') && typeof values[field.name] === 'string' && values[field.name]).map((field) => [field.name, values[field.name] as string]));

  return (
    <form className={card} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <p className="text-sm font-semibold text-white">{humanize(segment.path.split('/')[1] ?? lane.id)}</p>
      {missing.length > 0 && <Hint>{`Choose ${missing.map((name) => humanize(name).toLowerCase()).join(' and ')} first.`}</Hint>}
      {claimMissing && <Hint>This segment resumes a claim: fix claim_id on the form that drew it.</Hint>}
      {asked.map((field) => (
        <GeneratedField
          key={`${field.gesture}.${field.name}`}
          challengeId={runtime.challengeId}
          lane={lane.id}
          field={field}
          value={values[field.name]}
          siblings={siblingsOf(field.name)}
          onChange={(value) => { setDone(null); setValues((current) => ({ ...current, [field.name]: value })); }}
        />
      ))}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {done && (
        <p className="flex items-center gap-2 text-sm text-emerald-400">
          <CheckCircle2 className="h-4 w-4" /> {done.scheduled ? 'Evaluation in progress…' : `Recorded${done.cp ? ` · +${done.cp} CP` : ''}`}
        </p>
      )}
      <button type="submit" disabled={busy || missing.length > 0 || claimMissing} style={{ color: '#000' }} className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-xs font-semibold hover:bg-white/90 disabled:opacity-50">
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {label}
      </button>
    </form>
  );
}

// ─── Image et progression ───────────────────────────────────────────────────

export function ImageBlock({ block }: { block: SurfaceBlock; runtime: ScreenRuntime }) {
  const { vars } = useScreenVars();
  const { bound, value } = resolveBinding(block.props.src, vars);
  const src = typeof value === 'string' && /^https?:\/\//.test(value) ? value : null;
  if (!src) {
    const name = bindingName(block.props.src);
    return <Hint>{bound && name ? `Nothing drawn yet: ${humanize(name).toLowerCase()} is empty.` : 'No image to show.'}</Hint>;
  }
  return (
    <div className="flex h-full min-h-[240px] items-center justify-center overflow-hidden rounded-[14px] border border-white/10 bg-black/20">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" className="max-h-full max-w-full object-contain" />
    </div>
  );
}

/** `GET progress`, généré : ce que l'appelant a livré et gagné, ses compteurs. */
interface Progress {
  delivered?: number;
  cp?: number;
  counters?: Record<string, number>;
}

export function ProgressBlock({ runtime }: { block: SurfaceBlock; runtime: ScreenRuntime }) {
  const [progress, setProgress] = useState<Progress | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(flowActionUrl(runtime.challengeId, 'progress'))
      .then(async (res) => (res.ok ? ((await res.json()) as Progress) : null))
      .then((body) => !cancelled && setProgress(body))
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [runtime.challengeId, runtime.version]);
  if (!progress) return <Hint>Loading…</Hint>;
  const counters = Object.entries(progress.counters ?? {});
  return (
    <div className={card}>
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        <span className="flex items-baseline gap-1.5 text-sm"><span style={{ color: fgAt(0.5) }}>Delivered</span><span className="font-semibold text-white">{progress.delivered ?? 0}</span></span>
        <span className="flex items-baseline gap-1.5 text-sm"><span style={{ color: fgAt(0.5) }}>Earned</span><span className="font-semibold text-brandCP">{progress.cp ?? 0} CP</span></span>
        {counters.map(([name, value]) => (
          <span key={name} className="flex items-baseline gap-1.5 text-sm"><span style={{ color: fgAt(0.5) }}>{humanize(name)}</span><span className="font-semibold text-white">{value}</span></span>
        ))}
      </div>
    </div>
  );
}

// ─── Frame ──────────────────────────────────────────────────────────────────

export function FrameBlock({ block }: { block: SurfaceBlock; runtime: ScreenRuntime }) {
  const { vars } = useScreenVars();
  const { bound, value } = resolveBinding(block.props.url, vars);
  const url = typeof value === 'string' && /^https?:\/\//.test(value) ? value : null;
  if (!url) {
    const name = bindingName(block.props.url);
    return <Hint>{bound && name ? `Choose ${humanize(name).toLowerCase()} first.` : 'No address to show.'}</Hint>;
  }
  return (
    <div className="space-y-2">
      <iframe src={url} title="Application under test" className="h-full min-h-[420px] w-full rounded-[14px] border border-white/10 bg-white" allow="camera; microphone; fullscreen" />
      <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-brandCP hover:underline">Open in a new tab <ExternalLink className="h-3 w-3" /></a>
    </div>
  );
}
