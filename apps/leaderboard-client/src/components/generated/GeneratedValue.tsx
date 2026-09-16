'use client';

import { useState } from 'react';
import { Download, Eye, Loader2 } from 'lucide-react';
import { ValidationOutputViewer } from '@/components/challenges/ValidationOutputViewer';
import { errorOf, fgAt, formatBytes, humanize, isBlobRef, type BlobRef } from './format';

/**
 * Les renderers de sortie, par type (note §5) : un fichier se montre (image,
 * JSON, texte) ou se télécharge, une URL est un lien, un objet se déplie champ
 * par champ, le reste est du texte. `fileUrl` dit où lire les octets d'une
 * référence à ce chemin ; sans lui, un fichier n'est qu'un nom.
 */
export function GeneratedValue({
  value, path, fileUrl,
}: {
  value: unknown;
  path: string;
  fileUrl?: (path: string) => string;
}) {
  if (value === null || value === undefined) return <span style={{ color: fgAt(0.35) }}>—</span>;
  if (isBlobRef(value)) return <BlobValue blob={value} url={fileUrl?.(path)} />;
  if (typeof value === 'string' && /^https?:\/\//.test(value)) {
    return (
      <a href={value} target="_blank" rel="noreferrer" className="break-all text-brandCP underline-offset-2 hover:underline">
        {value}
      </a>
    );
  }
  if (Array.isArray(value)) {
    return <pre className="whitespace-pre-wrap break-all text-xs" style={{ color: fgAt(0.6) }}>{JSON.stringify(value, null, 2)}</pre>;
  }
  if (typeof value === 'object') {
    // Ni identifiant ni référence (`{$resource}`) : ce que la lane a choisi se lit déjà dans ce qu'elle montre.
    const isReference = (item: unknown) => !!item && typeof item === 'object' && '$resource' in (item as object);
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([key, item]) => !key.startsWith('$') && key !== 'id' && !isReference(item)
        && !(item && typeof item === 'object' && !Array.isArray(item) && Object.values(item).length > 0 && Object.values(item).every(isReference))
    );
    if (entries.length === 0) return null;
    return (
      <dl className="space-y-2">
        {entries.map(([key, item]) => (
          <div key={key} className="grid grid-cols-[minmax(0,9rem)_1fr] gap-3 text-sm">
            <dt className="truncate text-xs font-semibold uppercase tracking-wider" style={{ color: fgAt(0.4) }}>{humanize(key)}</dt>
            <dd className="min-w-0"><GeneratedValue value={item} path={`${path}.${key}`} fileUrl={fileUrl} /></dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span className="text-sm" style={{ color: fgAt(0.8) }}>{String(value)}</span>;
}

function BlobValue({ blob, url }: { blob: BlobRef; url?: string }) {
  const [shown, setShown] = useState<Blob | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const show = async () => {
    if (!url) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(url);
      if (!res.ok) {
        setError(await errorOf(res));
        return;
      }
      setShown(await res.blob());
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm" style={{ color: fgAt(0.7) }}>
        <span className="truncate">{blob.filename ?? 'file'}</span>
        <span className="text-xs" style={{ color: fgAt(0.35) }}>{formatBytes(blob.size)}</span>
        {url && !shown && (
          <button type="button" onClick={show} className="inline-flex items-center gap-1 rounded-full border border-white/10 px-2.5 py-1 text-xs hover:bg-white/5">
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />} Show
          </button>
        )}
        {url && (
          <a href={url} className="inline-flex items-center gap-1 rounded-full border border-white/10 px-2.5 py-1 text-xs hover:bg-white/5">
            <Download className="h-3 w-3" /> Download
          </a>
        )}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {shown && <ValidationOutputViewer blob={shown} contentType={blob.content_type} />}
    </div>
  );
}
