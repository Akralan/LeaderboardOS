'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, X } from 'lucide-react';
import { useToast } from '@/components/ui/Toast';
import { FlowIcon } from '@/components/ui/FlowIcon';
import { blankTemplate, bump, setAt } from './editor/mutations';

/**
 * La bibliothèque des templates
 * -----------------------------
 * Ceux de la base — brouillon, versions publiées immuables, usage — et ceux de
 * la distribution, en lecture seule et duplicables. Ouvrir mène au canevas ;
 * « New version » repart de la dernière version publiée.
 */

interface LibraryEntry {
  key: string;
  name: string;
  origin: 'database';
  versions: { version: string; published_at: string; challenges: number }[];
  draft: boolean;
  draft_version: string | null;
  edited_at: string;
  latest: { version: string; descriptor: { icon?: string; longLabel?: string } } | null;
}

interface SystemEntry {
  key: string;
  name: string;
  origin: 'system';
  descriptor: { icon?: string; longLabel?: string } | null;
}

function ago(date: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  const days = Math.floor(seconds / 86400);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(date).toLocaleDateString();
}

const kebab = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 50);

export function TemplateLibrary() {
  const router = useRouter();
  const toast = useToast();
  const [data, setData] = useState<{ system: SystemEntry[]; templates: LibraryEntry[] } | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/templates')
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then(setData)
      .catch(() => toast('Could not load the templates', 'error'));
  }, [toast]);

  const newVersion = async (entry: LibraryEntry) => {
    const latest = entry.versions.at(-1);
    if (!latest) return;
    setBusyKey(entry.key);
    try {
      const source = await fetch(`/api/templates/${encodeURIComponent(entry.key)}/source?version=${encodeURIComponent(latest.version)}`).then((res) => res.json());
      const yaml = setAt(source.yaml, ['template', 'version'], bump(latest.version, 'patch'));
      const res = await fetch(`/api/templates/${encodeURIComponent(entry.key)}/draft`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ yaml }) });
      if (!res.ok) throw new Error();
      router.push(`/admin/templates/${encodeURIComponent(entry.key)}`);
    } catch {
      toast('Could not start a new version', 'error');
      setBusyKey(null);
    }
  };

  const seeds = data
    ? [
        ...data.system.map((entry) => ({ key: entry.key, label: `${entry.name} · system` })),
        ...data.templates.filter((entry) => entry.versions.length).map((entry) => ({ key: entry.key, label: `${entry.name} · v${entry.versions.at(-1)!.version}` })),
      ]
    : [];

  return (
    <div className="graph-editor mx-auto flex max-w-[1080px] flex-col gap-6 py-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brandCP">Challenge templates</span>
          <h1 className="text-3xl font-semibold tracking-tight text-white">Templates</h1>
          <p className="max-w-[520px] text-sm leading-relaxed text-white/50">Graph documents the engine executes. You don’t code the platform, you draw the program.</p>
        </div>
        <button type="button" onClick={() => setCreating(true)} className="flex items-center gap-1.5 rounded-xl bg-brandCP px-4 py-2 text-sm font-semibold text-black hover:opacity-90">
          <Plus className="h-4 w-4" /> New template
        </button>
      </div>

      {!data ? (
        <div className="flex justify-center py-16 text-white/40">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-2xl border border-white/[0.08]">
            <div className="hidden grid-cols-[minmax(0,2.2fr)_170px_minmax(0,1fr)_110px_150px] gap-4 border-b border-white/[0.06] bg-white/[0.02] px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-white/35 md:grid">
              <span>Template</span>
              <span>Status</span>
              <span>Used by</span>
              <span>Last edited</span>
              <span />
            </div>
            {data.templates.length === 0 && <div className="px-5 py-8 text-center text-sm text-white/40">No template yet — draw one, or duplicate a system template below.</div>}
            {data.templates.map((entry) => {
              const latest = entry.versions.at(-1);
              const used = entry.versions.reduce((sum, version) => sum + version.challenges, 0);
              return (
                <div key={entry.key} className="grid grid-cols-1 items-center gap-2 border-b border-white/[0.05] px-5 py-3.5 transition-colors last:border-b-0 hover:bg-foreground/[0.02] md:grid-cols-[minmax(0,2.2fr)_170px_minmax(0,1fr)_110px_150px] md:gap-4">
                  <Link href={`/admin/templates/${encodeURIComponent(entry.key)}`} className="flex min-w-0 items-center gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brandCP/10 text-brandCP">
                      <FlowIcon icon={entry.latest?.descriptor.icon ?? 'sparkles'} className="h-4 w-4" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-semibold tracking-tight text-white">{entry.name}</span>
                      <span className="font-mono text-[11px] text-white/35">{entry.key}</span>
                    </span>
                  </Link>
                  <div className="flex flex-wrap gap-1">
                    {latest && <span className="rounded-full bg-brandCP/10 px-2.5 py-0.5 text-[11px] font-semibold text-brandCP">Published v{latest.version}</span>}
                    {entry.draft && (
                      <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${latest ? 'bg-amber-400/10 text-amber-300' : 'bg-white/[0.06] text-white/55'}`}>
                        {latest ? `v${entry.draft_version ?? '?'} draft` : 'Draft'}
                      </span>
                    )}
                  </div>
                  <span className="text-[13px] text-white/50">{used ? `used by ${used} challenge${used === 1 ? '' : 's'}` : 'not used yet'}</span>
                  <span className="text-[13px] text-white/35">{ago(entry.edited_at)}</span>
                  <div className="flex items-center justify-end gap-3 text-[13px] font-semibold">
                    {latest && !entry.draft && (
                      <button type="button" disabled={busyKey === entry.key} onClick={() => newVersion(entry)} className="text-white/45 hover:text-brandCP disabled:opacity-40">
                        New version
                      </button>
                    )}
                    {latest && entry.draft && (
                      <Link href={`/admin/templates/${encodeURIComponent(entry.key)}?version=${encodeURIComponent(latest.version)}`} className="text-white/45 hover:text-brandCP">
                        v{latest.version}
                      </Link>
                    )}
                    <Link href={`/admin/templates/${encodeURIComponent(entry.key)}`} className="text-brandCP hover:opacity-80">
                      Open
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>

          {data.templates.some((entry) => entry.versions.length > 0) && (
            <p className="text-xs text-white/40">
              A published template becomes a live challenge from <Link href="/admin/challenges" className="text-brandCP hover:opacity-80">Challenges → New challenge</Link>: its configuration section is generated from the template’s params.
            </p>
          )}

          <div className="flex flex-col gap-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/35">Shipped with the distribution</span>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {data.system.map((entry) => (
                <div key={entry.key} className="flex items-center gap-3 rounded-xl border border-white/[0.08] px-4 py-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.05] text-white/60">
                    <FlowIcon icon={entry.descriptor?.icon ?? 'sparkles'} className="h-4 w-4" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-semibold text-white">{entry.descriptor?.longLabel ?? entry.name}</span>
                    <span className="font-mono text-[11px] text-white/35">{entry.key} · system · read-only</span>
                  </span>
                  <Link href={`/admin/templates/${encodeURIComponent(entry.key)}`} className="ml-auto text-[13px] font-semibold text-brandCP hover:opacity-80">
                    View
                  </Link>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {creating && <NewTemplateModal seeds={seeds} onClose={() => setCreating(false)} />}
    </div>
  );
}

function ModalShell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
      <div onClick={(event) => event.stopPropagation()} className="animate-pop-in flex w-full max-w-[440px] flex-col gap-4 rounded-2xl border border-white/10 p-5 shadow-2xl" style={{ background: 'var(--background)' }}>
        <div className="flex items-center">
          <span className="text-lg font-semibold tracking-tight text-white">{title}</span>
          <button type="button" onClick={onClose} className="ml-auto rounded p-1 text-white/40 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const fieldClass = 'w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white placeholder:text-white/25 focus:border-brandCP/40 focus:outline-none';

function useCreateTemplate() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const create = async (body: { key: string; name: string; yaml?: string; seed?: { key: string } }) => {
    setBusy(true);
    setError('');
    const res = await fetch('/api/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      setBusy(false);
      setError(payload.details?.[0]?.message ?? payload.error ?? `Could not create the template (${res.status})`);
      return;
    }
    router.push(`/admin/templates/${encodeURIComponent(body.key)}`);
  };
  return { busy, error, create };
}

function NewTemplateModal({ seeds, onClose }: { seeds: { key: string; label: string }[]; onClose: () => void }) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [seed, setSeed] = useState('');
  const { busy, error, create } = useCreateTemplate();
  const effectiveKey = keyTouched ? key : kebab(name);

  return (
    <ModalShell title="New template" onClose={onClose}>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-white/70">Name</span>
        <input autoFocus className={fieldClass} value={name} placeholder="Code review sprint" onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-white/70">Key</span>
        <input className={`${fieldClass} font-mono`} value={effectiveKey} placeholder="code-review-sprint" onChange={(event) => { setKeyTouched(true); setKey(event.target.value); }} />
        <span className="text-[11px] text-white/35">kebab-case · the flow key challenges reference · cannot change later</span>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-white/70">Start from</span>
        <select className={fieldClass} value={seed} onChange={(event) => setSeed(event.target.value)}>
          <option value="">An empty canvas</option>
          {seeds.map((entry) => (
            <option key={entry.key} value={entry.key}>
              A copy of {entry.label}
            </option>
          ))}
        </select>
      </label>
      {error && <span className="text-xs text-red-400">{error}</span>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2 text-sm text-white/70 hover:bg-foreground/[0.04]">
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !name.trim() || !effectiveKey}
          onClick={() => create(seed ? { key: effectiveKey, name: name.trim(), seed: { key: seed } } : { key: effectiveKey, name: name.trim(), yaml: blankTemplate(effectiveKey, name.trim()) })}
          className="flex items-center gap-2 rounded-xl bg-brandCP px-4 py-2 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-40"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Create and open
        </button>
      </div>
    </ModalShell>
  );
}

export function DuplicateTemplateModal({ seedKey, seedName, onClose }: { seedKey: string; seedName: string; onClose: () => void }) {
  const [name, setName] = useState(`${seedName} (copy)`);
  const [key, setKey] = useState(`${seedKey}-copy`);
  const { busy, error, create } = useCreateTemplate();
  return (
    <ModalShell title={`Duplicate ${seedName}`} onClose={onClose}>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-white/70">Name</span>
        <input autoFocus className={fieldClass} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-white/70">Key</span>
        <input className={`${fieldClass} font-mono`} value={key} onChange={(event) => setKey(event.target.value)} />
      </label>
      {error && <span className="text-xs text-red-400">{error}</span>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2 text-sm text-white/70 hover:bg-foreground/[0.04]">
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !name.trim() || !key.trim()}
          onClick={() => create({ key: key.trim(), name: name.trim(), seed: { key: seedKey } })}
          className="flex items-center gap-2 rounded-xl bg-brandCP px-4 py-2 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-40"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Duplicate and open
        </button>
      </div>
    </ModalShell>
  );
}
