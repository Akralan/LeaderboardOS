'use client';

import { createContext, useContext, type MutableRefObject } from 'react';
import type { DeclarationTab, EditorModel, Path, UiScreen } from './model';
import type { DropSource } from './mutations';
import type { Diagnostic } from './useTemplateDocument';

/** Ce que le canevas, l'inspecteur et les panneaux partagent d'un brouillon ouvert. */
export interface EditorContextValue {
  templateKey: string;
  source: string;
  model: EditorModel;
  readOnly: boolean;
  apply: (next: string, coalesceKey?: string) => void;

  selected: string | null;
  select: (key: string | null) => void;
  /** Les nœuds que la sélection lit : la provenance allumée. */
  provenance: Set<string>;

  /** La mise en page : l'écran composé en cours, et le bloc sélectionné (`ui.<screen>.blocks.<i>`). */
  screen: UiScreen;
  setScreen: (screen: UiScreen) => void;
  selectedBlock: string | null;
  selectBlock: (key: string | null) => void;

  /** Les diagnostics par nœud, par lane, par onglet de déclarations et par bloc d'écran. */
  nodeIssues: Map<string, Diagnostic[]>;
  laneIssues: Map<number, Diagnostic[]>;
  declarationIssues: Map<DeclarationTab, Diagnostic[]>;
  blockIssues: Map<string, Diagnostic[]>;
  /** Les diagnostics d'un écran qui ne visent aucun bloc (le bloc `ui` illisible). */
  screenIssues: Map<UiScreen, Diagnostic[]>;
  /** Les diagnostics dont le chemin commence par celui-ci : les erreurs en ligne d'un champ. */
  issuesAt: (path: Path) => Diagnostic[];

  dragging: MutableRefObject<DropSource | null>;
  refusal: { slot: string; message: string } | null;
  drop: (slot: string, seqPath: Path, index: number) => void;
  addLane: (trigger: 'user' | 'admin' | 'cron') => void;

  setTab: (tab: DeclarationTab) => void;
}

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
  const value = useContext(EditorContext);
  if (!value) throw new Error('useEditor must be used inside the graph editor');
  return value;
}
