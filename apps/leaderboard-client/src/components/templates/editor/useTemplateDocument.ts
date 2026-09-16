'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildModel, type EditorModel } from './model';

/**
 * Le document d'un brouillon
 * --------------------------
 * Le texte, son historique (annuler / rétablir) et sa sauvegarde : chaque
 * écriture part au serveur après une courte pause, et les diagnostics de ce
 * texte reviennent avec la réponse — exactement ceux qui refuseraient sa
 * publication. Des frappes successives sur un même champ se fondent en une
 * seule entrée d'historique.
 */

export interface Diagnostic {
  severity: 'error' | 'advisory';
  code: string;
  path: string;
  message: string;
}

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

const SAVE_DELAY = 600;
const COALESCE_WINDOW = 1500;
const HISTORY_LIMIT = 200;

export function useTemplateDocument(templateKey: string, initial: { yaml: string; diagnostics: Diagnostic[]; readOnly: boolean }) {
  const [source, setSource] = useState(initial.yaml);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>(initial.diagnostics);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const coalesce = useRef<{ key: string; at: number } | null>(null);
  const [, setHistoryTick] = useState(0);
  const saved = useRef(initial.yaml);
  const sending = useRef<string | null>(null);
  /** Le texte dont les diagnostics sont affichés. */
  const diagnosed = useRef(initial.yaml);
  const inflight = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(source);
  latest.current = source;

  const modelRef = useRef<EditorModel | undefined>(undefined);
  const model = useMemo(() => {
    const next = buildModel(source, modelRef.current);
    modelRef.current = next;
    return next;
  }, [source]);

  const save = useCallback(async (yaml: string) => {
    // Un texte déjà enregistré, ou en cours d'envoi, ne repart pas : après une
    // publication, une seconde écriture recréerait un brouillon.
    if (initial.readOnly || yaml === sending.current || (yaml === saved.current && yaml === diagnosed.current)) return;
    sending.current = yaml;
    setSaveState('saving');
    try {
      const res = await fetch(`/api/templates/${encodeURIComponent(templateKey)}/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      const body = (await res.json()) as { diagnostics: Diagnostic[] };
      saved.current = yaml;
      // Une réponse plus ancienne que le texte courant ne remplace pas ses diagnostics.
      if (latest.current === yaml) {
        setDiagnostics(body.diagnostics);
        diagnosed.current = yaml;
        setSaveState('saved');
      }
    } catch {
      setSaveState('error');
    } finally {
      if (sending.current === yaml) sending.current = null;
    }
  }, [initial.readOnly, templateKey]);

  useEffect(() => {
    if (initial.readOnly) return;
    if (timer.current) clearTimeout(timer.current);
    if (source === saved.current && source === diagnosed.current) {
      // Revenu au texte enregistré (annuler) : rien à renvoyer.
      setSaveState((state) => (state === 'idle' ? state : 'saved'));
      return;
    }
    setSaveState('pending');
    timer.current = setTimeout(() => {
      timer.current = null;
      inflight.current = save(latest.current);
    }, SAVE_DELAY);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [initial.readOnly, save, source]);

  /** Sauvegarde tout de suite ce texte (la publication lit le brouillon enregistré). */
  const flush = useCallback(async (yaml?: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (inflight.current) await inflight.current;
    const text = yaml ?? latest.current;
    inflight.current = save(text);
    await inflight.current;
  }, [save]);

  const apply = useCallback((next: string, coalesceKey?: string) => {
    if (initial.readOnly || next === latest.current) return;
    const now = Date.now();
    const merge = coalesceKey && coalesce.current?.key === coalesceKey && now - coalesce.current.at < COALESCE_WINDOW;
    if (!merge) {
      past.current = [...past.current, latest.current].slice(-HISTORY_LIMIT);
    }
    coalesce.current = coalesceKey ? { key: coalesceKey, at: now } : null;
    future.current = [];
    latest.current = next;
    setSource(next);
    setHistoryTick((tick) => tick + 1);
  }, [initial.readOnly]);

  const undo = useCallback(() => {
    const previous = past.current.at(-1);
    if (previous === undefined) return;
    past.current = past.current.slice(0, -1);
    future.current = [latest.current, ...future.current];
    coalesce.current = null;
    latest.current = previous;
    setSource(previous);
    setHistoryTick((tick) => tick + 1);
  }, []);

  const redo = useCallback(() => {
    const next = future.current[0];
    if (next === undefined) return;
    future.current = future.current.slice(1);
    past.current = [...past.current, latest.current];
    coalesce.current = null;
    latest.current = next;
    setSource(next);
    setHistoryTick((tick) => tick + 1);
  }, []);

  return {
    source,
    model,
    diagnostics,
    saveState,
    apply,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    flush,
    setDiagnostics,
  };
}
