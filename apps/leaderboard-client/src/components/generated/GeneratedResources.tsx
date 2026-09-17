'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SurfaceResource } from '../../../../../packages/interpreter/describe';
import { flowActionUrl } from '@/lib/challengeActions';
import { GeneratedValue } from './GeneratedValue';
import { errorOf, fgAt, humanize } from './format';

/**
 * Les instances d'un template, générées
 * -------------------------------------
 * `GeneratedResources` : le navigateur d'un manager (`GET resources?type=`),
 * un onglet par type, brouillons compris — qui, quand, dans quel état, avec
 * quels champs et quelle résolution. `GeneratedMine` : ce que l'appelant a
 * créé (`GET mine`), pour reprendre là où il s'était arrêté.
 */

interface Instance {
  id: string;
  author_name?: string | null;
  open: boolean;
  verdict: string | null;
  resolution: Record<string, unknown> | null;
  created_at: string;
  fields: Record<string, unknown>;
}

/** Une référence projetée (`{id}`) se lit par son identifiant court ; le reste par son renderer. */
function Cell({ value }: { value: unknown }) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && typeof (value as { id?: unknown }).id === 'string') {
    return <span className="font-mono text-xs" style={{ color: fgAt(0.55) }}>#{(value as { id: string }).id.slice(0, 8)}</span>;
  }
  return <GeneratedValue value={value} path="" />;
}

function stateOf(instance: Pick<Instance, 'open' | 'verdict'>) {
  return instance.open ? 'open' : humanize(instance.verdict ?? 'closed');
}

function InstancesTable({ instances, columns, showAuthor }: { instances: Instance[]; columns: string[]; showAuthor: boolean }) {
  const resolutionKeys = [...new Set(instances.flatMap((instance) => Object.keys(instance.resolution ?? {})))].filter((key) => key !== 'consensus');
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-widest" style={{ color: fgAt(0.4) }}>
            <th className="py-1 pr-3">#</th>
            {showAuthor && <th className="py-1 pr-3">By</th>}
            <th className="py-1 pr-3">State</th>
            {columns.map((column) => <th key={column} className="py-1 pr-3">{humanize(column)}</th>)}
            {resolutionKeys.map((key) => <th key={key} className="py-1 pr-3">{humanize(key)}</th>)}
          </tr>
        </thead>
        <tbody>
          {instances.map((instance) => (
            <tr key={instance.id} className="border-t border-white/[0.06] align-top" style={{ color: fgAt(0.75) }}>
              <td className="py-1.5 pr-3 font-mono text-xs" style={{ color: fgAt(0.45) }}>{instance.id.slice(0, 8)}</td>
              {showAuthor && <td className="py-1.5 pr-3">{instance.author_name ?? '—'}</td>}
              <td className="py-1.5 pr-3 whitespace-nowrap">{stateOf(instance)}</td>
              {columns.map((column) => <td key={column} className="py-1.5 pr-3"><Cell value={instance.fields[column]} /></td>)}
              {resolutionKeys.map((key) => <td key={key} className="py-1.5 pr-3"><Cell value={instance.resolution?.[key] ?? null} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function GeneratedResources({ challengeId, resources }: { challengeId: string; resources: SurfaceResource[] }) {
  const [type, setType] = useState(resources[0]?.type ?? '');
  const [instances, setInstances] = useState<Instance[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!type) return;
    setInstances(null);
    setError('');
    const res = await fetch(flowActionUrl(challengeId, `resources?type=${encodeURIComponent(type)}`));
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    setInstances(((await res.json()) as { instances: Instance[] }).instances);
  }, [challengeId, type]);

  useEffect(() => {
    void load().catch(() => setError('Network error'));
  }, [load]);

  if (resources.length === 0) return null;
  const columns = resources.find((resource) => resource.type === type)?.fields.map((field) => field.name) ?? [];

  return (
    <div className="space-y-4 rounded-[20px] border border-white/[0.08] bg-white/[0.02] p-5">
      <div className="flex flex-wrap items-center gap-2">
        {resources.map((resource) => (
          <button
            key={resource.type}
            type="button"
            onClick={() => setType(resource.type)}
            className={`rounded-full border px-3 py-1.5 text-xs ${resource.type === type ? 'border-brandCP/60 bg-brandCP/15 text-white' : 'border-white/10 text-white/60 hover:bg-white/5'}`}
          >
            {humanize(resource.type)}
          </button>
        ))}
        <button type="button" onClick={() => void load()} className="ml-auto text-xs text-brandCP hover:underline">Refresh</button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {!error && !instances && <p className="text-xs" style={{ color: fgAt(0.35) }}>Loading…</p>}
      {instances && instances.length === 0 && <p className="text-xs" style={{ color: fgAt(0.35) }}>Nothing yet.</p>}
      {instances && instances.length > 0 && <InstancesTable instances={instances} columns={columns} showAuthor />}
    </div>
  );
}

export function GeneratedMine({ challengeId, resources, version }: { challengeId: string; resources: SurfaceResource[]; version: number }) {
  const [mine, setMine] = useState<Record<string, (Record<string, unknown> & Omit<Instance, 'fields'>)[]> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(flowActionUrl(challengeId, 'mine'))
      .then(async (res) => (res.ok ? ((await res.json()) as { resources: typeof mine }).resources : null))
      .then((resources) => !cancelled && setMine(resources))
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [challengeId, version]);

  if (!mine || Object.keys(mine).length === 0) return null;
  return (
    <div className="space-y-4 rounded-[20px] border border-white/[0.08] bg-white/[0.02] p-5">
      <p className="text-sm font-semibold text-white">Your work</p>
      {Object.entries(mine).map(([type, rows]) => {
        const columns = resources.find((resource) => resource.type === type)?.fields.map((field) => field.name) ?? [];
        const instances = rows.map(({ id, open, verdict, resolution, created_at, ...fields }) => ({ id, open, verdict, resolution, created_at, fields }));
        return (
          <div key={type} className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: fgAt(0.45) }}>{humanize(type)}</p>
            <InstancesTable instances={instances} columns={columns} showAuthor={false} />
          </div>
        );
      })}
    </div>
  );
}
