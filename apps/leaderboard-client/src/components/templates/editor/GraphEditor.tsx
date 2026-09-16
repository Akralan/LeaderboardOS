'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ChevronsLeft, ChevronsRight, Code2, Copy, Eye, Loader2, Redo2, Undo2 } from 'lucide-react';
import { useToast } from '@/components/ui/Toast';
import { Canvas, LockedPaletteItem, PaletteItem } from './Canvas';
import { Declarations } from './Declarations';
import { EditorContext, type EditorContextValue } from './EditorContext';
import { LOCKED_FAMILIES, PALETTE, type Family } from './families';
import { Inspector } from './Inspector';
import { locate, pathKey, provenanceOf, type DeclarationTab, type DiagnosticTarget, type Path } from './model';
import { bump, insertAt, moveNode, newAggregateValue, newLaneValue, newNodeValue, refusalOf, removeAt, setAt, type DropSource } from './mutations';
import { ProblemsDrawer, PreviewPanel, PublishModal, SourcePanel, type VersionOption } from './Panels';
import { useTemplateDocument, type Diagnostic } from './useTemplateDocument';
import { DuplicateTemplateModal } from '../TemplateLibrary';

/**
 * L'éditeur de graphe d'un template
 * ---------------------------------
 * Trois états, lus de la base : un brouillon (éditable, sauvegardé à chaque
 * geste), une version publiée (immuable : « New version » en repart), un
 * template système (lecture seule : on le duplique). La publication reste
 * désactivée tant que le brouillon a une erreur.
 */

interface Detail {
  template: { key: string; name: string };
  versions: { version: string; published_at: string; challenges: number }[];
  draft: { yaml: string; updated_at: string; diagnostics: Diagnostic[] } | null;
}

type Loaded =
  | { mode: 'draft'; name: string; yaml: string; diagnostics: Diagnostic[]; versions: Detail['versions'] }
  | { mode: 'published'; name: string; yaml: string; version: string; versions: Detail['versions']; hasDraft: boolean }
  | { mode: 'system'; name: string; yaml: string };

export function TemplateEditorPage({ templateKey, version }: { templateKey: string; version: string | null }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoaded(null);
      const detailRes = await fetch(`/api/templates/${encodeURIComponent(templateKey)}`);
      if (detailRes.ok) {
        const detail = (await detailRes.json()) as Detail;
        if (detail.draft && !version) {
          if (!cancelled) setLoaded({ mode: 'draft', name: detail.template.name, yaml: detail.draft.yaml, diagnostics: detail.draft.diagnostics, versions: detail.versions });
          return;
        }
        const sourceRes = await fetch(`/api/templates/${encodeURIComponent(templateKey)}/source${version ? `?version=${encodeURIComponent(version)}` : ''}`);
        if (!sourceRes.ok) {
          if (!cancelled) setError(version ? `Version ${version} not found.` : 'This template has neither a draft nor a published version.');
          return;
        }
        const body = await sourceRes.json();
        if (!cancelled) setLoaded({ mode: 'published', name: detail.template.name, yaml: body.yaml, version: body.version, versions: detail.versions, hasDraft: !!detail.draft });
        return;
      }
      if (detailRes.status === 404) {
        const sourceRes = await fetch(`/api/templates/${encodeURIComponent(templateKey)}/source`);
        if (sourceRes.ok) {
          const body = await sourceRes.json();
          if (!cancelled) setLoaded({ mode: 'system', name: templateKey, yaml: body.yaml });
          return;
        }
      }
      if (!cancelled) setError(detailRes.status === 404 ? 'Template not found.' : `Could not load the template (${detailRes.status}).`);
    })().catch(() => !cancelled && setError('Could not load the template.'));
    return () => {
      cancelled = true;
    };
  }, [templateKey, version, reload]);

  if (error) {
    return (
      <FullBleed>
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <span className="text-sm text-white/60">{error}</span>
        <Link href="/admin/templates" className="text-sm font-semibold text-brandCP">
          Back to templates
        </Link>
      </div>
      </FullBleed>
    );
  }
  if (!loaded) {
    return (
      <FullBleed>
        <div className="flex h-full items-center justify-center text-white/40">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      </FullBleed>
    );
  }
  const identity = loaded.mode === 'published' ? `published:${loaded.version}` : loaded.mode;
  return (
    <FullBleed>
      <GraphEditor key={`${templateKey}:${identity}:${reload}`} templateKey={templateKey} loaded={loaded} onReload={() => setReload((n) => n + 1)} />
    </FullBleed>
  );
}

/**
 * Le canevas occupe toute la fenêtre sous la navigation d'administration, hors
 * du conteneur centré des autres pages : il se fixe à la hauteur où la page le
 * pose.
 */
function FullBleed({ children }: { children: ReactNode }) {
  const anchor = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const measure = () => anchor.current && setTop(anchor.current.getBoundingClientRect().top + window.scrollY);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  return (
    <div ref={anchor}>
      {top !== null && (
        <div className="graph-editor fixed inset-x-0 bottom-0 z-30 flex flex-col" style={{ top, background: 'var(--background)' }}>
          {children}
        </div>
      )}
    </div>
  );
}

function GraphEditor({ templateKey, loaded, onReload }: { templateKey: string; loaded: Loaded; onReload: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const readOnly = loaded.mode !== 'draft';
  const document = useTemplateDocument(templateKey, {
    yaml: loaded.yaml,
    diagnostics: loaded.mode === 'draft' ? loaded.diagnostics : [],
    readOnly,
  });
  const { source, model, diagnostics, apply, undo, redo } = document;

  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<DeclarationTab>('params');
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [panel, setPanel] = useState<'preview' | 'source' | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(loaded.mode === 'draft');
  const [publishOpen, setPublishOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [refusal, setRefusal] = useState<{ slot: string; message: string } | null>(null);
  const dragging = useRef<DropSource | null>(null);
  const refusalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Une sélection que l'écriture a fait disparaître (nœud supprimé, annulé) se relâche.
  const selection = selected && model.nodes.has(selected) ? selected : null;

  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const advisories = diagnostics.length - errors.length;

  const grouped = useMemo(() => {
    const nodeIssues = new Map<string, Diagnostic[]>();
    const laneIssues = new Map<number, Diagnostic[]>();
    const declarationIssues = new Map<DeclarationTab, Diagnostic[]>();
    const push = <K,>(map: Map<K, Diagnostic[]>, key: K, diagnostic: Diagnostic) => map.set(key, [...(map.get(key) ?? []), diagnostic]);
    for (const diagnostic of diagnostics) {
      const target = locate(model, diagnostic.path);
      if (target.kind === 'node') push(nodeIssues, target.key, diagnostic);
      else if (target.kind === 'lane') push(laneIssues, target.index, diagnostic);
      else if (target.kind === 'declaration') push(declarationIssues, target.tab, diagnostic);
      else push(declarationIssues, 'template', diagnostic);
    }
    return { nodeIssues, laneIssues, declarationIssues };
  }, [diagnostics, model]);

  const issuesAt = useCallback(
    (path: Path) => {
      const prefix = pathKey(path);
      return diagnostics.filter((diagnostic) => diagnostic.path === prefix || diagnostic.path.startsWith(`${prefix}.`));
    },
    [diagnostics]
  );

  const refuse = useCallback((slot: string, message: string) => {
    if (refusalTimer.current) clearTimeout(refusalTimer.current);
    setRefusal({ slot, message });
    refusalTimer.current = setTimeout(() => setRefusal(null), 3800);
  }, []);

  const addLane = useCallback(
    (trigger: 'user' | 'admin' | 'cron') => {
      if (readOnly) return;
      apply(insertAt(source, ['lanes'], model.lanes.length, newLaneValue(model, trigger)));
      setSelected(`lanes.${model.lanes.length}.entry`);
    },
    [apply, model, readOnly, source]
  );

  const insertFamily = useCallback(
    (family: Family, seqPath: Path, index: number) => {
      const value = newNodeValue(family as Exclude<Family, 'entry' | 'aggregate'>, model);
      apply(insertAt(source, seqPath, index, value));
      setSelected(pathKey([...seqPath, index]));
    },
    [apply, model, source]
  );

  const drop = useCallback(
    (slot: string, seqPath: Path, index: number) => {
      const current = dragging.current;
      dragging.current = null;
      if (!current || readOnly) return;
      const refused = refusalOf(source, model, current, seqPath, index);
      if (refused) {
        refuse(slot, refused);
        return;
      }
      if (current.kind === 'palette') {
        insertFamily(current.family, seqPath, index);
        return;
      }
      const next = moveNode(source, current.path, seqPath, index);
      apply(next);
      setSelected(null);
    },
    [apply, insertFamily, model, readOnly, refuse, source]
  );

  /** Un clic sur la palette : après la sélection, sinon en fin de dernière lane. */
  const pick = useCallback(
    (family: Family) => {
      if (readOnly) return;
      if (family === 'entry') return addLane('user');
      if (family === 'aggregate') {
        const count = model.aggregates.length;
        apply(insertAt(source, ['lifecycle', 'aggregates'], count, newAggregateValue(model)));
        setSelected(`lifecycle.aggregates.${count}`);
        return;
      }
      const node = selection ? model.nodes.get(selection) : null;
      if (node && node.laneIndex !== null) {
        if (node.docKey === 'entry') return insertFamily(family, ['lanes', node.laneIndex, 'nodes'], 0);
        const position = node.path[node.path.length - 1];
        if (typeof position === 'number') return insertFamily(family, node.path.slice(0, -1), position + 1);
      }
      const last = model.lanes.at(-1);
      if (!last) {
        toast('Add an entry first: a lane starts with who may run it', 'error');
        return;
      }
      insertFamily(family, last.nodesPath, last.items.length);
    },
    [addLane, apply, insertFamily, model, readOnly, selection, source, toast]
  );

  const focusTarget = useCallback((target: DiagnosticTarget) => {
    if (target.kind === 'node') {
      setSelected(target.key);
      requestAnimationFrame(() => window.document.getElementById(`node-${target.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }));
    } else if (target.kind === 'lane') {
      setSelected(`lanes.${target.index}.entry`);
      requestAnimationFrame(() => window.document.querySelector(`[data-lane="${target.index}"]`)?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }));
    } else if (target.kind === 'declaration') {
      setSelected(null);
      setTab(target.tab);
    } else {
      setSelected(null);
      setTab('template');
    }
  }, []);

  // Clavier : annuler / rétablir partout, flèches sur le rail, Entrée vers l'inspecteur, Suppr, Échap.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !typing && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && !typing && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if (typing || publishOpen) return;
      if (event.key === 'Escape') {
        setSelected(null);
        return;
      }
      if (!selection) {
        if (event.key.startsWith('Arrow') && model.lanes[0]) setSelected(model.lanes[0].entry.key);
        return;
      }
      const node = model.nodes.get(selection);
      if (!node) return;
      if ((event.key === 'Delete' || event.key === 'Backspace') && !readOnly && node.docKey !== 'entry') {
        event.preventDefault();
        setSelected(null);
        apply(removeAt(source, node.path));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        (window.document.querySelector('#graph-inspector input, #graph-inspector select, #graph-inspector textarea') as HTMLElement | null)?.focus();
        return;
      }
      if (node.laneIndex === null) return;
      const lane = model.lanes[node.laneIndex];
      const position = lane.order.indexOf(selection);
      let next: string | undefined;
      if (event.key === 'ArrowDown') next = lane.order[position + 1];
      if (event.key === 'ArrowUp') next = lane.order[position - 1];
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        const other = model.lanes[node.laneIndex + (event.key === 'ArrowRight' ? 1 : -1)];
        if (other) next = other.order[Math.min(position, other.order.length - 1)];
      }
      if (next) {
        event.preventDefault();
        focusTarget({ kind: 'node', key: next });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [apply, focusTarget, model, publishOpen, readOnly, redo, selection, source, undo]);

  const context: EditorContextValue = {
    templateKey,
    source,
    model,
    readOnly,
    apply,
    selected: selection,
    select: setSelected,
    provenance: new Set(selection ? provenanceOf(model, selection) : []),
    nodeIssues: grouped.nodeIssues,
    laneIssues: grouped.laneIssues,
    declarationIssues: grouped.declarationIssues,
    issuesAt,
    dragging,
    refusal,
    drop,
    addLane,
    setTab,
  };

  const latestPublished = loaded.mode !== 'system' ? loaded.versions.at(-1)?.version ?? null : null;
  const versionOptions: VersionOption[] = latestPublished
    ? (['patch', 'minor', 'major'] as const).map((level) => ({ level, label: level.charAt(0).toUpperCase() + level.slice(1), version: bump(latestPublished, level) }))
    : [{ level: 'initial', label: 'Initial', version: /^\d+\.\d+\.\d+$/.test(model.header.version) ? model.header.version : '1.0.0' }];

  const publish = async (version: string) => {
    const next = setAt(source, ['template', 'version'], version);
    apply(next);
    await document.flush(next);
    const res = await fetch(`/api/templates/${encodeURIComponent(templateKey)}/publish`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (Array.isArray(body.diagnostics)) document.setDiagnostics(body.diagnostics);
      return { error: body.error ?? `Publication refused (${res.status})`, diagnostics: body.diagnostics };
    }
    toast(`Published ${model.header.name || templateKey} v${body.version}`, 'success');
    setPublishOpen(false);
    router.replace(`/admin/templates/${encodeURIComponent(templateKey)}?version=${encodeURIComponent(body.version)}`);
    return null;
  };

  const newVersion = async () => {
    if (loaded.mode !== 'published') return;
    if (loaded.hasDraft) {
      router.push(`/admin/templates/${encodeURIComponent(templateKey)}`);
      return;
    }
    const yaml = setAt(loaded.yaml, ['template', 'version'], bump(latestPublished ?? loaded.version, 'patch'));
    const res = await fetch(`/api/templates/${encodeURIComponent(templateKey)}/draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml }),
    });
    if (!res.ok) {
      toast('Could not start a new version', 'error');
      return;
    }
    if (window.location.search) router.push(`/admin/templates/${encodeURIComponent(templateKey)}`);
    else onReload();
  };

  const saving = document.saveState === 'pending' || document.saveState === 'saving';
  const canPublish = !readOnly && errors.length === 0 && !saving && document.saveState !== 'error' && model.lanes.length > 0;

  const versionChip =
    loaded.mode === 'draft'
      ? { label: `v${model.header.version || '?'} · draft`, tone: 'border-white/10 text-white/55' }
      : loaded.mode === 'published'
        ? { label: `v${loaded.version} · published`, tone: 'border-brandCP/30 bg-brandCP/10 text-brandCP' }
        : { label: 'system · read-only', tone: 'border-white/10 text-white/55' };

  return (
    <EditorContext.Provider value={context}>
      <div className="flex h-full min-h-0 flex-col">
        {/* ── Top bar ── */}
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.08] px-4">
          <Link href="/admin/templates" className="flex items-center gap-1.5 text-xs text-white/40 transition-colors hover:text-brandCP">
            <ArrowLeft className="h-3.5 w-3.5" /> Templates
          </Link>
          <span className="h-5 w-px bg-white/10" />
          <span className="max-w-[260px] truncate text-[15px] font-semibold tracking-tight text-white">{model.header.name || loaded.name}</span>
          <span className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${versionChip.tone}`}>{versionChip.label}</span>
          {loaded.mode === 'draft' && (
            <button
              type="button"
              onClick={() => setDrawerOpen((open) => !open)}
              className={`ml-1 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${errors.length ? 'bg-red-500/15 text-red-300' : 'bg-brandCP/10 text-brandCP'}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${errors.length ? 'bg-red-400' : 'bg-brandCP'}`} />
              {errors.length ? `${errors.length} problem${errors.length === 1 ? '' : 's'}` : advisories ? `Valid · ${advisories} advisory` : 'Valid'}
            </button>
          )}
          {loaded.mode === 'draft' && (
            <span className="text-[11px] text-white/30">
              {document.saveState === 'error' ? <span className="text-red-400">Not saved — retrying on next edit</span> : saving ? 'Saving…' : document.saveState === 'saved' ? 'Saved' : ''}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            {!readOnly && (
              <>
                <button type="button" title="Undo (Ctrl+Z)" disabled={!document.canUndo} onClick={undo} className="rounded-lg p-1.5 text-white/45 hover:bg-foreground/[0.05] hover:text-white disabled:opacity-30">
                  <Undo2 className="h-4 w-4" />
                </button>
                <button type="button" title="Redo (Ctrl+Shift+Z)" disabled={!document.canRedo} onClick={redo} className="rounded-lg p-1.5 text-white/45 hover:bg-foreground/[0.05] hover:text-white disabled:opacity-30">
                  <Redo2 className="h-4 w-4" />
                </button>
              </>
            )}
            <TopButton active={panel === 'source'} onClick={() => setPanel(panel === 'source' ? null : 'source')} icon={<Code2 className="h-3.5 w-3.5" />} label="View source" />
            <TopButton active={panel === 'preview'} onClick={() => setPanel(panel === 'preview' ? null : 'preview')} icon={<Eye className="h-3.5 w-3.5" />} label="Preview" />
            {loaded.mode === 'draft' && (
              <button
                type="button"
                disabled={!canPublish}
                title={canPublish ? 'Publish this draft' : errors.length ? 'Fix every problem to publish' : saving ? 'Saving…' : 'Add a lane to publish'}
                onClick={() => setPublishOpen(true)}
                className="ml-1 rounded-lg bg-brandCP px-3.5 py-1.5 text-xs font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-foreground/[0.07] disabled:text-foreground/30"
              >
                Publish
              </button>
            )}
            {loaded.mode === 'published' && (
              <button type="button" onClick={newVersion} className="ml-1 rounded-lg bg-brandCP px-3.5 py-1.5 text-xs font-semibold text-black hover:opacity-90">
                {loaded.hasDraft ? 'Open draft' : 'New version'}
              </button>
            )}
            {loaded.mode === 'system' && (
              <button type="button" onClick={() => setDuplicateOpen(true)} className="ml-1 flex items-center gap-1.5 rounded-lg bg-brandCP px-3.5 py-1.5 text-xs font-semibold text-black hover:opacity-90">
                <Copy className="h-3.5 w-3.5" /> Duplicate
              </button>
            )}
          </div>
        </div>

        {readOnly && (
          <div className="flex shrink-0 items-center gap-2 border-b border-brandCP/20 bg-brandCP/[0.06] px-4 py-2 text-xs text-brandCP">
            {loaded.mode === 'published' ? (
              <>
                <span className="font-semibold">v{loaded.version} · published · read-only.</span>
                <span className="text-brandCP/80">Published versions are immutable — future edits create a new version.</span>
                {loaded.versions.length > 1 && (
                  <select
                    className="ml-auto rounded-md border border-brandCP/30 bg-transparent px-2 py-0.5 font-mono text-[11px] text-brandCP"
                    value={loaded.version}
                    onChange={(event) => router.push(`/admin/templates/${encodeURIComponent(templateKey)}?version=${encodeURIComponent(event.target.value)}`)}
                  >
                    {loaded.versions.map((entry) => (
                      <option key={entry.version} value={entry.version}>
                        v{entry.version} · {entry.challenges} challenge{entry.challenges === 1 ? '' : 's'}
                      </option>
                    ))}
                  </select>
                )}
              </>
            ) : (
              <>
                <span className="font-semibold">System template · read-only.</span>
                <span className="text-brandCP/80">Shipped with the distribution — duplicate it to draw your own version.</span>
              </>
            )}
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {/* ── Palette ── */}
          {paletteOpen ? (
            <div className="flex w-[214px] shrink-0 flex-col overflow-auto border-r border-white/[0.08]">
              <div className="flex items-center justify-between px-3.5 pb-2 pt-3">
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/35">Palette</span>
                <button type="button" onClick={() => setPaletteOpen(false)} className="text-white/30 hover:text-white" title="Collapse">
                  <ChevronsLeft className="h-4 w-4" />
                </button>
              </div>
              <div className="flex flex-col gap-0.5 px-2 pb-3">
                {PALETTE.map((family) => (
                  <PaletteItem key={family} family={family} onPick={() => pick(family)} />
                ))}
              </div>
              <span className="px-3.5 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/25">Not yet executable</span>
              <div className="flex flex-col gap-0.5 px-2 pb-4">
                {LOCKED_FAMILIES.map((locked) => (
                  <LockedPaletteItem key={locked.label} label={locked.label} tip={locked.tip} />
                ))}
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setPaletteOpen(true)} className="flex w-9 shrink-0 justify-center border-r border-white/[0.08] pt-3.5 text-white/30 hover:text-white" title="Palette">
              <ChevronsRight className="h-4 w-4" />
            </button>
          )}

          {/* ── Canvas + problems ── */}
          <div className="flex min-w-0 flex-1 flex-col" onClick={(event) => event.target === event.currentTarget && setSelected(null)}>
            <Canvas zoom={zoom} setZoom={setZoom} />
            {loaded.mode === 'draft' && <ProblemsDrawer diagnostics={diagnostics} open={drawerOpen} onToggle={() => setDrawerOpen((open) => !open)} onFocus={focusTarget} />}
          </div>

          {panel === 'source' && <SourcePanel onClose={() => setPanel(null)} />}
          {panel === 'preview' && <PreviewPanel onClose={() => setPanel(null)} />}

          {/* ── Inspector / declarations ── */}
          <div id="graph-inspector" className={`flex shrink-0 flex-col overflow-auto border-l border-white/[0.08] ${panel ? 'w-[300px]' : 'w-[336px]'}`}>
            {selection ? <Inspector key={selection} nodeKey={selection} /> : <Declarations tab={tab} setTab={setTab} />}
          </div>
        </div>
      </div>

      {publishOpen && <PublishModal name={model.header.name || loaded.name} diagnostics={diagnostics} options={versionOptions} onClose={() => setPublishOpen(false)} onPublish={publish} />}
      {duplicateOpen && <DuplicateTemplateModal seedKey={templateKey} seedName={model.header.name || templateKey} onClose={() => setDuplicateOpen(false)} />}
    </EditorContext.Provider>
  );
}

function TopButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
        active ? 'border-brandCP/40 bg-brandCP/10 text-brandCP' : 'border-white/10 text-white/55 hover:text-white'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

