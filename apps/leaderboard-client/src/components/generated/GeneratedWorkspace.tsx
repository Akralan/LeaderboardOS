'use client';

import { useState } from 'react';
import { ExternalLink, GitBranch } from 'lucide-react';
import { flowActionUrl } from '@/lib/challengeActions';
import { errorOf, fgAt } from './format';

/**
 * Le workspace d'une participation (capacité `workspaces`), généré
 * ---------------------------------------------------------------
 * `own_repo` : le dépôt GitHub public que le participant déclare
 * (`PATCH workspace`). `provided_repo` : la branche perso provisionnée au join,
 * son état et son lien. Le kanban et l'évaluation sont rendus à côté.
 */
export function GeneratedWorkspace({
  challengeId, mode, participation, onSaved,
}: {
  challengeId: string;
  mode: 'provided_repo' | 'own_repo';
  participation: { workspace_url?: string | null; workspace_ref?: string | null; workspace_status?: string | null } | null;
  onSaved: () => Promise<void> | void;
}) {
  const [repoUrl, setRepoUrl] = useState(participation?.workspace_url ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  if (mode === 'provided_repo') {
    const status = participation?.workspace_status ?? 'pending';
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-[14px] border border-white/[0.08] bg-white/[0.02] px-4 py-3 text-sm">
        <GitBranch className="h-4 w-4 text-brandCP" />
        <span className="font-mono text-xs text-white/70">{participation?.workspace_ref ?? 'Your branch'}</span>
        <span className="text-xs" style={{ color: fgAt(0.45) }}>{status === 'ready' ? 'ready' : status === 'failed' ? 'provisioning failed' : 'being provisioned…'}</span>
        {participation?.workspace_url && (
          <a href={participation.workspace_url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-brandCP hover:opacity-80">
            Open <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    );
  }

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch(flowActionUrl(challengeId, 'workspace'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo_url: repoUrl }),
      });
      if (!res.ok) {
        setError(await errorOf(res));
        return;
      }
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 rounded-[14px] border border-white/[0.08] bg-white/[0.02] px-4 py-3">
      <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: fgAt(0.45) }}>Your repository</span>
      <div className="flex gap-2">
        <input
          value={repoUrl}
          onChange={(event) => setRepoUrl(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && void save()}
          placeholder="https://github.com/you/your-repo"
          className="w-full rounded-[12px] border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white placeholder:text-white/25 focus:border-brandCP/40 focus:outline-none"
        />
        <button type="button" disabled={saving || !repoUrl.trim()} onClick={() => void save()} className="rounded-full bg-white px-4 py-2 text-xs font-semibold text-black hover:bg-white/90 disabled:opacity-50">
          Save
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
