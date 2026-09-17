'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2, Lock, Users } from 'lucide-react';
import type { SurfaceBlock, SurfaceSubmissionStep } from '../../../../../packages/interpreter/describe';
import { flowActionUrl } from '@/lib/challengeActions';
import { InitialsAvatar } from '@/components/ui/InitialsAvatar';
import type { ScreenRuntime } from './GeneratedScreen';
import { resolveBinding, useScreenVars } from './screenBlocks';
import { errorOf, fgAt, humanize } from './format';

/**
 * Les briques des soumissions par URL (capacité `submissions`)
 * ------------------------------------------------------------
 * `GET workspace` rend les dépôts du challenge, chacun sous le rôle de son
 * étape, avec l'URL de chaque participant (`userUrls`) et, pour l'étape de
 * sélection, les URL qu'il garde des autres (`datasetUrls`). Une `steps_bar`
 * choisit l'étape (`$step`), un `submit_url` soumet mon URL pour ses dépôts,
 * un `community` garde ou non celles des autres. Les étapes viennent de la
 * surface (`submissions.steps`), dans l'ordre déclaré.
 */

interface Repo {
  repo_id: string;
  repo_type: string;
  role: string | null;
  workspace_meta: { userUrls?: Record<string, string>; datasetUrls?: Record<string, string[]> };
}

interface Workspace {
  currentUserId: string | null;
  workspaceOwnerId: string | null;
  repos: Repo[];
  users?: Record<string, { fullName: string; avatarUrl?: string }>;
}

function Hint({ children }: { children: string }) {
  return <p className="text-xs" style={{ color: fgAt(0.4) }}>{children}</p>;
}

const card = 'space-y-3 rounded-[20px] border border-white/[0.08] bg-white/[0.02] p-4';

/** Le workspace, relu après chaque geste enregistré sur l'écran. */
function useWorkspace(runtime: ScreenRuntime) {
  const [workspace, setWorkspace] = useState<Workspace | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    fetch(flowActionUrl(runtime.challengeId, 'workspace'))
      .then(async (res) => (res.ok ? ((await res.json()) as Workspace) : null))
      .then((body) => !cancelled && setWorkspace(body))
      .catch(() => !cancelled && setWorkspace(null));
    return () => { cancelled = true; };
  }, [runtime.challengeId, runtime.version]);
  return workspace;
}

/** La clé de lecture des URL : le porteur du groupe, sinon moi. */
const ownerOf = (workspace: Workspace) => workspace.workspaceOwnerId ?? workspace.currentUserId ?? null;

/** L'étape qu'un bloc vise : la variable choisie, ou une clé écrite. */
function stepOf(block: SurfaceBlock, runtime: ScreenRuntime, vars: Record<string, unknown>): SurfaceSubmissionStep | string {
  const steps = runtime.description.surface.submissions?.steps ?? [];
  const { bound, value } = resolveBinding(block.props.step, vars);
  if (bound && value === undefined) return 'Choose a step first.';
  const key = value && typeof value === 'object' ? (value as { key?: unknown }).key : value;
  const step = steps.find((candidate) => candidate.key === key);
  return step ?? `No submission step '${String(key ?? '')}' on this template.`;
}

/** Une étape est faite quand chacun de ses dépôts porte mon URL — sauf un dépôt non artefact partagé avec une étape artefact du même titre. */
function isDone(step: SurfaceSubmissionStep, steps: SurfaceSubmissionStep[], repos: Repo[], owner: string | null): boolean {
  const optional = !step.artifact && steps.some((other) => other.key !== step.key && other.title === step.title && other.artifact);
  const mine = repos.filter((repo) => repo.role === step.key);
  if (mine.length === 0 || !owner) return false;
  return optional ? true : mine.every((repo) => Boolean(repo.workspace_meta?.userUrls?.[owner]));
}

// ─── Steps bar ──────────────────────────────────────────────────────────────

export function StepsBarBlock({ block, runtime }: { block: SurfaceBlock; runtime: ScreenRuntime }) {
  const { vars, set } = useScreenVars();
  const workspace = useWorkspace(runtime);
  const steps = runtime.description.surface.submissions?.steps ?? [];
  const selects = block.selects ?? null;
  const chosen = selects ? (vars[selects] as SurfaceSubmissionStep | undefined) : undefined;
  const thresholdReached = runtime.data.rewards?.thresholdReached === true;

  // Les étapes présentes sur le challenge : celles dont un dépôt existe (une étape `unless_input` peut manquer).
  const present = workspace ? steps.filter((step) => !step.removable || workspace.repos.some((repo) => repo.role === step.key)) : steps;

  useEffect(() => {
    if (selects && present.length > 0 && !present.some((step) => step.key === chosen?.key)) set(selects, present[0]);
  }, [present, selects, chosen, set]);

  if (steps.length === 0) return <Hint>This template declares no submission step.</Hint>;
  if (workspace === undefined) return <Hint>Loading…</Hint>;
  const owner = workspace ? ownerOf(workspace) : null;

  return (
    <div className="flex items-center px-4">
      {present.map((step, index) => {
        const done = workspace ? isDone(step, steps, workspace.repos, owner) : false;
        const locked = step.gated && thresholdReached && !done;
        const active = chosen?.key === step.key;
        return (
          <div key={step.key} className="flex flex-1 items-center last:flex-none">
            <button
              type="button"
              onClick={() => selects && set(selects, step)}
              className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 transition-all ${done ? 'border-green-500 bg-green-500/15' : locked ? 'border-white/10 bg-white/[0.02]' : active ? 'border-brandCP bg-brandCP/15' : 'border-white/15 bg-white/[0.03] hover:border-white/30'}`}
              title={step.title}
            >
              {done ? <CheckCircle2 className="h-5 w-5 text-green-400" /> : locked ? <Lock className="h-4 w-4 text-white/20" /> : <span className={`text-xs font-semibold ${active ? 'text-brandCP' : 'text-white/40'}`}>{index + 1}</span>}
              <span className={`absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-semibold ${active ? 'text-white' : done ? 'text-green-400' : 'text-white/30'}`}>{step.repoTitle}</span>
            </button>
            {index < present.length - 1 && (
              <div className="relative mx-2 h-px flex-1 bg-white/[0.08]">
                <div className="absolute inset-y-0 left-0 rounded-full bg-brandCP/50 transition-[width]" style={{ width: done ? '100%' : '0%' }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Submit URL ─────────────────────────────────────────────────────────────

function RepoForm({ repo, step, workspace, runtime, locked }: { repo: Repo; step: SurfaceSubmissionStep; workspace: Workspace; runtime: ScreenRuntime; locked: boolean }) {
  const owner = ownerOf(workspace);
  const mine = owner ? repo.workspace_meta?.userUrls?.[owner] : undefined;
  const [url, setUrl] = useState(mine ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => setUrl(mine ?? ''), [mine]);

  const submit = async () => {
    const value = url.trim();
    if (!value) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(flowActionUrl(runtime.challengeId, 'workspace'), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo_id: repo.repo_id, workspace_url: value }) });
      if (!res.ok) setError(await errorOf(res));
      else runtime.onRecorded();
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: fgAt(0.45) }}>{humanize(repo.repo_type)}{step.artifact ? '' : ' · optional'}</span>
      <div className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && void submit()}
          placeholder="https://"
          disabled={locked}
          className="flex-1 rounded-[14px] border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-sm text-white placeholder:text-white/25 focus:border-brandCP/40 focus:outline-none disabled:opacity-50"
        />
        <button type="button" onClick={() => void submit()} disabled={locked || busy || !url.trim() || url.trim() === mine} className="shrink-0 rounded-[14px] bg-brandCP/15 px-4 py-2.5 text-sm font-semibold text-brandCP hover:bg-brandCP/25 disabled:opacity-40">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : mine ? 'Update' : 'Submit'}
        </button>
      </div>
      {mine && (
        <a href={mine} target="_blank" rel="ugc noopener noreferrer" className="flex items-center gap-1 truncate text-xs text-green-400 hover:underline">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> {mine} <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

export function SubmitUrlBlock({ block, runtime }: { block: SurfaceBlock; runtime: ScreenRuntime }) {
  const { vars } = useScreenVars();
  const workspace = useWorkspace(runtime);
  const step = stepOf(block, runtime, vars);
  if (typeof step === 'string') return <Hint>{step}</Hint>;
  if (workspace === undefined) return <Hint>Loading…</Hint>;
  if (!workspace) return <Hint>Sign in and join the challenge to submit.</Hint>;
  const repos = workspace.repos.filter((repo) => repo.role === step.key);
  if (repos.length === 0) return <Hint>{`No ${step.repoTitle.toLowerCase()} repository on this challenge.`}</Hint>;
  const steps = runtime.description.surface.submissions?.steps ?? [];
  const locked = step.gated && runtime.data.rewards?.thresholdReached === true && !isDone(step, steps, workspace.repos, ownerOf(workspace));
  return (
    <div className={card}>
      <p className="text-sm font-semibold text-white">{step.title}</p>
      {locked && <p className="flex items-center gap-1.5 text-xs" style={{ color: fgAt(0.4) }}><Lock className="h-3.5 w-3.5" /> Threshold reached — submissions are closed for this step.</p>}
      {repos.map((repo) => <RepoForm key={repo.repo_id} repo={repo} step={step} workspace={workspace} runtime={runtime} locked={locked} />)}
    </div>
  );
}

// ─── Community picks ────────────────────────────────────────────────────────

export function CommunityBlock({ block, runtime }: { block: SurfaceBlock; runtime: ScreenRuntime }) {
  const { vars } = useScreenVars();
  const workspace = useWorkspace(runtime);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const step = stepOf(block, runtime, vars);
  if (typeof step === 'string') return <Hint>{step}</Hint>;
  if (workspace === undefined) return <Hint>Loading…</Hint>;
  if (!workspace) return null;
  const owner = ownerOf(workspace);
  const repo = workspace.repos.find((candidate) => candidate.role === step.key);
  if (!repo) return <Hint>{`No ${step.repoTitle.toLowerCase()} repository on this challenge.`}</Hint>;
  const selection = runtime.description.surface.submissions?.selection === step.key;
  const community = Object.entries(repo.workspace_meta?.userUrls ?? {}).filter(([userId]) => userId !== owner);
  const kept = owner ? repo.workspace_meta?.datasetUrls?.[owner] ?? (repo.workspace_meta?.userUrls?.[owner] ? [repo.workspace_meta.userUrls[owner]] : []) : [];
  if (community.length === 0) return <Hint>Nobody else submitted for this step yet.</Hint>;

  const toggle = async (url: string) => {
    if (!selection) return;
    const next = kept.includes(url) ? kept.filter((candidate) => candidate !== url) : [...kept, url];
    setBusy(true);
    setError('');
    try {
      const res = await fetch(flowActionUrl(runtime.challengeId, 'workspace'), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo_id: repo.repo_id, dataset_urls: next.length ? next : null }) });
      if (!res.ok) setError(await errorOf(res));
      else runtime.onRecorded();
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={card}>
      <p className="flex items-center gap-1.5 text-xs" style={{ color: fgAt(0.5) }}><Users className="h-3.5 w-3.5" /> From the community ({community.length}){selection ? '' : ' · read-only'}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {community.map(([userId, url]) => {
          const name = workspace.users?.[userId]?.fullName ?? userId;
          const selected = kept.includes(url);
          return (
            <button key={userId} type="button" disabled={busy || !selection} onClick={() => void toggle(url)} aria-pressed={selected} className={`flex min-w-0 flex-col gap-2 rounded-[14px] border p-3 text-left ${selected ? 'border-brandCP/35 bg-brandCP/[0.06]' : 'border-white/[0.06] bg-white/[0.02] hover:border-brandCP/20'} disabled:cursor-default`}>
              <span className="flex items-center gap-2"><InitialsAvatar name={name} size={24} avatarUrl={workspace.users?.[userId]?.avatarUrl} /><span className="truncate text-xs font-medium text-white/80">{name}</span></span>
              <span className="truncate font-mono text-[10px]" style={{ color: fgAt(0.4) }}>{url}</span>
              {selection && <span className={`w-fit rounded-full px-2 py-0.5 text-[10px] font-bold ${selected ? 'bg-brandCP/15 text-brandCP' : 'bg-white/[0.06] text-white/50'}`}>{selected ? 'Kept' : 'Use'}</span>}
            </button>
          );
        })}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
