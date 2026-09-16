import { flowActionUrl } from '@/lib/challengeActions';

/**
 * L'UI générée d'un template (note §5) — ce que ses composants partagent
 * ---------------------------------------------------------------------
 * Aucun composant ici ne connaît un flow : ils lisent la surface que
 * `describeTemplate` tire du template, et les lectures que le compilateur
 * génère (`<lane>/options`, `<lane>/claim`, `<lane>/file`, `progress`,
 * `overview`, `export`).
 */

/** `submit_case` → `Submit case`. */
export function humanize(id: string): string {
  const words = id.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function fgAt(opacity: number) {
  return `color-mix(in srgb, var(--foreground) ${Math.round(opacity * 100)}%, transparent)`;
}

export async function errorOf(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return typeof body?.error === 'string' ? body.error : `Request failed (${res.status})`;
}

/** Une référence de fichier, telle qu'un champ `file` ou un observateur la range. */
export interface BlobRef {
  blob_id: string;
  content_type: string;
  filename: string | null;
  size: number;
}

export function isBlobRef(value: unknown): value is BlobRef {
  return !!value && typeof value === 'object' && typeof (value as { blob_id?: unknown }).blob_id === 'string';
}

export function laneFileUrl(challengeId: string, lane: string, claimId: string, path: string): string {
  return flowActionUrl(challengeId, `${lane}/file?claim_id=${encodeURIComponent(claimId)}&path=${encodeURIComponent(path)}`);
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
