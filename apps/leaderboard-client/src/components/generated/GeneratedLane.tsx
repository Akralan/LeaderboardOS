'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import type { SurfaceLane, SurfaceSegment } from '../../../../../packages/interpreter/describe';
import { flowActionUrl } from '@/lib/challengeActions';
import { GeneratedField, type FieldValue } from './GeneratedField';
import { GeneratedValue } from './GeneratedValue';
import { errorOf, fgAt, humanize, laneFileUrl } from './format';

/**
 * Une lane, jouée segment par segment (note §5)
 * ---------------------------------------------
 * Chaque segment est un formulaire généré de ses champs, envoyé à
 * `POST flow/<path>`. Le segment qui pose le claim en rend l'identifiant ; les
 * suivants le renvoient. Entre deux segments, l'écran relit `<lane>/claim` :
 * la ressource telle que l'appelant peut la lire — ce qu'un grant vient
 * d'ouvrir compris — et ce que la lane a gardé (une réponse observée…). Un
 * claim en cours se reprend à l'étape que le contexte n'a pas encore.
 */

interface ClaimView {
  claim_id: string;
  resource: Record<string, unknown> | null;
  context: Record<string, unknown>;
}

type Values = Record<string, FieldValue>;

/** L'état d'une évaluation en arrière-plan, tel que `<lane>/evaluation` le rend. */
interface EvaluationView {
  status: 'running' | 'done' | 'failed' | 'pending' | 'skipped_reuse' | null;
  running: boolean;
  score: number | null;
  cp: number;
}

const EVALUATION_POLL_MS = 3000;

function hasFile(segment: SurfaceSegment, values: Values) {
  return segment.fields.some((field) => field.kind === 'file' && values[field.name] instanceof File);
}

/** Le corps d'un segment : JSON, ou multipart dès qu'il porte un fichier (chaque autre valeur y part en JSON). */
function bodyOf(segment: SurfaceSegment, values: Values, claimId: string | null): { body: BodyInit; headers?: HeadersInit } | string {
  const payload: Record<string, unknown> = {};
  for (const field of segment.fields) {
    const value = values[field.name];
    if (value === undefined || value === '') {
      if (field.conditional) continue;
      return `${humanize(field.name)} is required`;
    }
    if (field.kind === 'json' && typeof value === 'string') {
      try {
        payload[field.name] = JSON.parse(value);
      } catch {
        return `${humanize(field.name)} is not valid JSON`;
      }
      continue;
    }
    payload[field.name] = value;
  }
  if (segment.needsClaim && claimId) payload.claim_id = claimId;
  if (!hasFile(segment, values)) return { body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } };
  const form = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    if (value instanceof File) form.append(key, value);
    else form.append(key, JSON.stringify(value));
  }
  return { body: form };
}

export function GeneratedLane({ challengeId, lane }: { challengeId: string; lane: SurfaceLane }) {
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<Values>({});
  const [claim, setClaim] = useState<ClaimView | null>(null);
  const [done, setDone] = useState<{ cp: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const evaluates = lane.segments.some((candidate) => candidate.evaluates);
  const [evaluation, setEvaluation] = useState<EvaluationView | null>(null);

  const readEvaluation = useCallback(async () => {
    const res = await fetch(flowActionUrl(challengeId, `${lane.id}/evaluation`));
    if (res.ok) setEvaluation(await res.json());
  }, [challengeId, lane.id]);

  // Une évaluation en arrière-plan se suit : lue à l'ouverture, relue tant qu'elle tourne.
  useEffect(() => {
    if (!evaluates) return;
    void readEvaluation().catch(() => undefined);
  }, [evaluates, readEvaluation]);
  useEffect(() => {
    if (!evaluation?.running) return;
    const timer = setInterval(() => void readEvaluation().catch(() => undefined), EVALUATION_POLL_MS);
    return () => clearInterval(timer);
  }, [evaluation?.running, readEvaluation]);

  const readClaim = useCallback(async (claimId: string): Promise<ClaimView | null> => {
    const res = await fetch(flowActionUrl(challengeId, `${lane.id}/claim?claim_id=${encodeURIComponent(claimId)}`));
    if (!res.ok) return null;
    const body = await res.json();
    return body.claim?.released || body.claim?.consumed ? null : body.claim;
  }, [challengeId, lane.id]);

  /** L'étape d'un claim repris : le premier segment dont un geste manque au contexte. */
  const stepOf = useCallback((view: ClaimView) => {
    const index = lane.segments.findIndex((segment) => segment.needsClaim && segment.fields.some((field) => !(field.gesture in view.context)));
    return index < 0 ? lane.segments.length - 1 : index;
  }, [lane.segments]);

  useEffect(() => {
    if (!lane.claims) return;
    let cancelled = false;
    (async () => {
      const res = await fetch(flowActionUrl(challengeId, 'progress'));
      if (!res.ok) return;
      const active = (await res.json())?.active_claim;
      if (!active?.claim_id) return;
      const view = await readClaim(active.claim_id);
      if (!cancelled && view) {
        setClaim(view);
        setStep(stepOf(view));
      }
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [challengeId, lane.claims, readClaim, stepOf]);

  const segment = lane.segments[step];

  const submit = async () => {
    const request = bodyOf(segment, values, claim?.claim_id ?? null);
    if (typeof request === 'string') {
      setError(request);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await fetch(flowActionUrl(challengeId, segment.path), { method: 'POST', ...request });
      if (!res.ok) {
        setError(await errorOf(res));
        return;
      }
      const body = await res.json();
      setValues({});
      if (res.status === 202 && body.scheduled) {
        setDone(null);
        setEvaluation((current) => ({ status: 'running', running: true, score: current?.score ?? null, cp: current?.cp ?? 0 }));
        setClaim(null);
        setStep(0);
        return;
      }
      if (segment.final) {
        setDone({ cp: typeof body.cp_awarded === 'number' ? body.cp_awarded : null });
        setClaim(null);
        setStep(0);
        return;
      }
      const claimId: string | undefined = body.claim?.claim_id ?? claim?.claim_id;
      if (claimId) setClaim((await readClaim(claimId)) ?? { claim_id: claimId, resource: body.claim?.resource ?? null, context: body.claim?.context ?? body.context ?? {} });
      setStep(step + 1);
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  };

  const release = async () => {
    if (!claim) return;
    setBusy(true);
    try {
      await fetch(flowActionUrl(challengeId, `${lane.id}/release`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claim_id: claim.claim_id }),
      });
      setClaim(null);
      setStep(0);
      setValues({});
    } finally {
      setBusy(false);
    }
  };

  const siblingsOf = (name: string) =>
    Object.fromEntries(
      segment.fields
        .filter((field) => field.name !== name && (field.kind === 'ref' || field.kind === 'link') && typeof values[field.name] === 'string' && values[field.name])
        .map((field) => [field.name, values[field.name] as string])
    );

  const fileUrl = claim ? (path: string) => laneFileUrl(challengeId, lane.id, claim.claim_id, path) : undefined;
  const kept = claim ? Object.fromEntries(Object.entries(claim.context).filter(([key]) => !key.startsWith('$'))) : {};

  return (
    <div className="space-y-4 rounded-[20px] border border-white/[0.08] bg-white/[0.02] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-semibold text-white">{humanize(lane.id)}</p>
        {lane.segments.length > 1 && (
          <p className="text-xs" style={{ color: fgAt(0.4) }}>
            Step {step + 1} of {lane.segments.length} · {humanize(segment.path.split('/')[1] ?? lane.id)}
          </p>
        )}
      </div>

      {evaluation?.running && (
        <p className="flex items-center gap-2 text-sm" style={{ color: fgAt(0.6) }}>
          <Loader2 className="h-4 w-4 animate-spin" /> Evaluation in progress…
        </p>
      )}
      {evaluation && !evaluation.running && evaluation.status === 'done' && evaluation.score !== null && (
        <p className="flex items-center gap-2 text-sm text-emerald-400">
          <CheckCircle2 className="h-4 w-4" /> Score {(evaluation.score * 10).toFixed(1)}/10 · {evaluation.cp} CP earned
        </p>
      )}
      {evaluation && !evaluation.running && (evaluation.status === 'failed' || evaluation.status === 'running') && (
        <p className="flex items-center gap-2 text-sm text-amber-300">
          <AlertTriangle className="h-4 w-4" /> Evaluation failed — check your repository and try again.
        </p>
      )}

      {done && step === 0 && (
        <p className="flex items-center gap-2 text-sm text-emerald-400">
          <CheckCircle2 className="h-4 w-4" /> Recorded{done.cp ? ` · +${done.cp} CP` : ''}
        </p>
      )}

      {claim && (claim.resource || Object.keys(kept).length > 0) && (
        <div className="space-y-3 rounded-[14px] border border-white/[0.06] bg-black/10 p-4">
          {claim.resource && <GeneratedValue value={claim.resource} path="resource" fileUrl={fileUrl} />}
          {Object.keys(kept).length > 0 && <GeneratedValue value={kept} path="context" fileUrl={fileUrl} />}
        </div>
      )}

      <form
        className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        {segment.fields.map((field) => (
          <GeneratedField
            key={`${field.gesture}.${field.name}`}
            challengeId={challengeId}
            lane={lane.id}
            field={field}
            value={values[field.name]}
            siblings={siblingsOf(field.name)}
            onChange={(value) => { setDone(null); setValues((current) => ({ ...current, [field.name]: value })); }}
          />
        ))}
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={busy || Boolean(evaluation?.running)}
            style={{ color: '#000' }}
            className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-xs font-semibold hover:bg-white/90 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {segment.evaluates
              ? evaluation?.running ? 'Evaluating…' : evaluation?.status === 'done' ? 'Re-evaluate' : 'Launch evaluation'
              : segment.fields.length === 0 ? 'Start' : segment.final ? 'Submit' : 'Continue'}
          </button>
          {claim && (
            <button type="button" onClick={release} disabled={busy} className="rounded-full border border-white/10 px-4 py-2 text-xs text-white/60 hover:bg-white/5">
              Release
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
