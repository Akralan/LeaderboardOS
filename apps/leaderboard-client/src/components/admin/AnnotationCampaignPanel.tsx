'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download, Loader2, Upload } from 'lucide-react';
import { flowActionUrl } from '@/lib/challengeActions';
import { parseCsv } from '@/lib/csv';
import type { LabelOption } from '@/components/challenges/AnnotationWorkbench';

/**
 * Le contrat de données est celui que l'interpréteur génère pour le template
 * data-annotation : `GET overview` pour l'avancement, les participants et ce
 * qu'une lane admin attend ; `POST import/batch` pour les lots ;
 * `POST resolve/decide` pour trancher un item contesté ; `GET export` pour le
 * CSV. Les noms sont ceux du template — types de ressources, verdicts,
 * compteurs, lanes.
 */

interface ResourceCount {
  total: number;
  open: number;
  closed: number;
  verdicts: Record<string, number>;
}

/** `GET overview`, généré. */
interface Overview {
  resources: Record<string, ResourceCount>;
  pool: { pool: number; distributed: number; remaining: number };
  participants: {
    user_id: string;
    name: string | null;
    delivered: number;
    cp: number;
    counters: { gold_seen?: number; gold_correct?: number };
  }[];
  pending: {
    resource_id: string;
    type: string;
    verdict: string;
    fields: { image_url?: string | null };
    inputs: Record<string, { value?: unknown }[]>;
  }[];
}

function fgAt(opacity: number) {
  return `color-mix(in srgb, var(--foreground) ${Math.round(opacity * 100)}%, transparent)`;
}

const CARD = 'space-y-3 rounded-[18px] border border-white/10 bg-white/[0.02] p-4';
const HEADING = 'text-[10px] font-semibold uppercase tracking-widest';
const EMPTY_COUNT: ResourceCount = { total: 0, open: 0, closed: 0, verdicts: {} };

function ImportDropzone({
  challengeId, kind, title, columns, onImported,
}: { challengeId: string; kind: 'items' | 'golds'; title: string; columns: string; onImported(): void }) {
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setStatus(null);
    try {
      // Le fichier devient des lignes ici ; l'action valide chaque ligne et refuse le lot entier au moindre écart.
      const rows = parseCsv(await file.text());
      const body = kind === 'items'
        ? { kind, class: 'standard', file: rows.map(row => ({ image_url: row.image_url, class: row.class || 'standard' })) }
        : { kind, file: rows.map(row => ({ image_url: row.image_url, expected: row.expected })) };
      const res = await fetch(flowActionUrl(challengeId, 'import/batch'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => null);
        setStatus({ tone: 'error', text: error?.error ?? `Import failed (${res.status})` });
        return;
      }
      setStatus({ tone: 'ok', text: `${rows.length} ${kind} imported from ${file.name}` });
      onImported();
    } finally {
      setBusy(false);
    }
  };

  return (
    <label
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); void upload(e.dataTransfer.files[0]); }}
      className={`block cursor-pointer rounded-xl border border-dashed px-4 py-5 text-center transition ${dragging ? 'border-brandCP/60 bg-brandCP/[0.04]' : 'border-white/15'}`}
    >
      <input type="file" accept=".csv,text/csv" className="hidden" onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
      <p className="flex items-center justify-center gap-2 text-sm font-medium" style={{ color: fgAt(0.75) }}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} {title}
      </p>
      <p className="mt-1 text-[11px]" style={{ color: fgAt(0.35) }}>CSV with columns {columns}</p>
      {status && (
        <div className={`mt-2 text-left text-[11px] ${status.tone === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>
          {status.text.split('; ').map(line => <p key={line}>{line}</p>)}
        </div>
      )}
    </label>
  );
}

/** Le décompte des labels d'un item contesté, depuis les entrées de son aggregate. */
function tallyOf(inputs: { value?: unknown }[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const input of inputs) {
    const key = String(input.value ?? '');
    tally[key] = (tally[key] ?? 0) + 1;
  }
  return tally;
}

/** La campagne côté admin et manager : import, avancement, qualité des annotateurs, contestés, export. */
export function AnnotationCampaignPanel({ challengeId, options }: { challengeId: string; options: LabelOption[] }) {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(flowActionUrl(challengeId, 'overview'));
    setData(res.ok ? await res.json() : null);
    setLoading(false);
  }, [challengeId]);

  useEffect(() => { void load(); }, [load]);

  const resolve = async (resourceId: string, value: string) => {
    setResolving(resourceId);
    try {
      await fetch(flowActionUrl(challengeId, 'resolve/decide'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: resourceId, value }),
      });
      await load();
    } finally {
      setResolving(null);
    }
  };

  const labelOf = (key: string) => options.find(o => o.key === key)?.label ?? key;
  const items = data?.resources.item ?? EMPTY_COUNT;
  const golds = data?.resources.gold ?? EMPTY_COUNT;
  const contested = data?.pending.filter(entry => entry.type === 'item' && entry.verdict === 'contested') ?? [];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <ImportDropzone challengeId={challengeId} kind="items" title="Import items" columns="image_url, class (standard | sensitive)" onImported={load} />
        <ImportDropzone challengeId={challengeId} kind="golds" title="Import hidden checks (golds)" columns="image_url, expected (an option key)" onImported={load} />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs" style={{ color: fgAt(0.35) }}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : !data ? (
        <p className="text-xs" style={{ color: fgAt(0.4) }}>The campaign could not be loaded.</p>
      ) : (
        <>
          <div className={CARD}>
            <div className="flex items-center justify-between">
              <p className={HEADING} style={{ color: fgAt(0.3) }}>Progress</p>
              <a
                href={flowActionUrl(challengeId, 'export')}
                className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs"
                style={{ color: fgAt(0.7) }}
              >
                <Download className="h-3.5 w-3.5" /> Export labels (CSV)
              </a>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5" style={{ color: fgAt(0.7) }}>
              <p><b>{items.verdicts.labeled ?? 0}</b> / {items.total} labeled</p>
              <p><b>{items.open}</b> open</p>
              <p><b>{items.verdicts.contested ?? 0}</b> contested</p>
              <p><b>{golds.total}</b> hidden checks</p>
              <p><b>{data.pool.remaining.toLocaleString()}</b> / {data.pool.pool.toLocaleString()} CP left</p>
            </div>
          </div>

          <div className={CARD}>
            <p className={HEADING} style={{ color: fgAt(0.3) }}>Annotators</p>
            {data.participants.length === 0 ? (
              <p className="text-xs" style={{ color: fgAt(0.4) }}>No label yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs" style={{ color: fgAt(0.65) }}>
                  <thead style={{ color: fgAt(0.35) }}>
                    <tr>
                      <th className="py-1.5 font-medium">Annotator</th>
                      <th className="py-1.5 font-medium">Labels</th>
                      <th className="py-1.5 font-medium">Hidden checks</th>
                      <th className="py-1.5 font-medium">Accuracy</th>
                      <th className="py-1.5 font-medium">Net CP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.participants.map(participant => {
                      const seen = participant.counters.gold_seen ?? 0;
                      const correct = participant.counters.gold_correct ?? 0;
                      return (
                        <tr key={participant.user_id} className="border-t border-white/[0.06]">
                          <td className="py-1.5">{participant.name ?? 'Unknown'}</td>
                          <td className="py-1.5">{participant.delivered}</td>
                          <td className="py-1.5">{correct} / {seen}</td>
                          <td className="py-1.5">{seen === 0 ? '—' : `${Math.round((correct / seen) * 100)}%`}</td>
                          <td className="py-1.5">{participant.cp}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className={CARD}>
            <p className={HEADING} style={{ color: fgAt(0.3) }}>Contested items</p>
            {contested.length === 0 ? (
              <p className="text-xs" style={{ color: fgAt(0.4) }}>Nothing to settle.</p>
            ) : (
              <div className="space-y-3">
                {contested.map(item => (
                  <div key={item.resource_id} className="flex flex-col gap-3 rounded-xl border border-white/[0.06] p-3 sm:flex-row sm:items-center">
                    {item.fields.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element -- images hébergées ailleurs
                      <img src={item.fields.image_url} alt="Contested item" referrerPolicy="no-referrer" className="h-24 w-24 rounded-lg bg-black/40 object-contain" />
                    )}
                    <div className="flex-1 space-y-2">
                      <p className="text-[11px]" style={{ color: fgAt(0.45) }}>
                        {Object.entries(tallyOf(item.inputs.agreement ?? [])).map(([key, count]) => `${labelOf(key)} × ${count}`).join(' · ')}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {options.map(option => (
                          <button
                            key={option.key}
                            type="button"
                            disabled={resolving === item.resource_id}
                            onClick={() => resolve(item.resource_id, option.key)}
                            className="rounded-lg border border-white/15 px-3 py-1.5 text-xs disabled:opacity-40"
                            style={{ color: fgAt(0.75) }}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
