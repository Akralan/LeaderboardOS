'use client';

import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import type { SurfaceResource } from '../../../../../packages/interpreter/describe';
import { flowActionUrl } from '@/lib/challengeActions';
import { errorOf, fgAt, humanize } from './format';

/** `GET overview`, généré. */
interface Overview {
  resources: Record<string, { total: number; open: number; closed: number; verdicts: Record<string, number> }>;
  pool: { pool: number; distributed: number; remaining: number };
  participants: { user_id: string; name: string | null; delivered: number; cp: number }[];
}

/**
 * Le panneau manager généré : l'avancement par type de ressource, le pool,
 * les participants, et l'export CSV des instances fermées de chaque type.
 */
export function GeneratedOverview({ challengeId, resources }: { challengeId: string; resources: SurfaceResource[] }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(flowActionUrl(challengeId, 'overview'))
      .then(async (res) => (res.ok ? setOverview(await res.json()) : setError(await errorOf(res))))
      .catch(() => setError('Network error'));
  }, [challengeId]);

  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (!overview) return <p className="text-xs" style={{ color: fgAt(0.35) }}>Loading…</p>;

  return (
    <div className="space-y-5 rounded-[20px] border border-white/[0.08] bg-white/[0.02] p-5">
      <div className="grid gap-3 sm:grid-cols-3">
        {resources.map(({ type }) => {
          const row = overview.resources[type];
          if (!row) return null;
          return (
            <div key={type} className="space-y-1 rounded-[14px] border border-white/[0.06] p-3">
              <p className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: fgAt(0.4) }}>{humanize(type)}</p>
              <p className="text-lg font-semibold text-white">{row.closed} <span className="text-xs font-normal" style={{ color: fgAt(0.4) }}>/ {row.total} closed</span></p>
              {Object.keys(row.verdicts).length > 0 && (
                <p className="text-xs" style={{ color: fgAt(0.5) }}>
                  {Object.entries(row.verdicts).map(([verdict, count]) => `${humanize(verdict)} ${count}`).join(' · ')}
                </p>
              )}
              <a href={flowActionUrl(challengeId, `export?type=${encodeURIComponent(type)}`)} className="inline-flex items-center gap-1 text-xs text-brandCP hover:underline">
                <Download className="h-3 w-3" /> Export CSV
              </a>
            </div>
          );
        })}
      </div>
      <p className="text-xs" style={{ color: fgAt(0.5) }}>
        Pool {overview.pool.distributed} / {overview.pool.pool} CP distributed · {overview.pool.remaining} left
      </p>
      {overview.participants.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-widest" style={{ color: fgAt(0.4) }}>
              <th className="py-1">Participant</th><th className="py-1">Delivered</th><th className="py-1">CP</th>
            </tr>
          </thead>
          <tbody>
            {overview.participants.map((participant) => (
              <tr key={participant.user_id} className="border-t border-white/[0.06]" style={{ color: fgAt(0.75) }}>
                <td className="py-1.5">{participant.name ?? participant.user_id}</td>
                <td className="py-1.5">{participant.delivered}</td>
                <td className="py-1.5">{participant.cp}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
