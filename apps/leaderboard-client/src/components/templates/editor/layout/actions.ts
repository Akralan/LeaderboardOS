'use client';

import { useCallback } from 'react';
import type { UiPlacement } from '../../../../../../../packages/interpreter/format/schema';
import { uiComponent } from '../../../../../../../packages/interpreter/ui/catalog';
import { clampPlacement, defaultScreen, freeBlockId, freeSpot, overlaps } from '../../../../../../../packages/interpreter/ui/layout';
import { useEditor } from '../EditorContext';
import { isRec, type BlockView, type UiScreen } from '../model';
import { insertAt, removeAt, setAt } from '../mutations';

/**
 * Les gestes de la mise en page
 * -----------------------------
 * Chaque geste est une réécriture du bloc `ui` du document, comme sur le
 * canevas : poser un composant, déplacer ou redimensionner un bloc, le
 * retirer, ouvrir un écran depuis sa mise en page générée, y revenir. Un
 * déplacement qui recouvrirait un autre bloc est refusé avec sa raison.
 */

export const UI_COMPONENT_DRAG = 'application/x-ui-component';

/** Ce que la mise en page par défaut lit du brouillon, validé ou non. */
export function layoutSourceOf(model: ReturnType<typeof useEditor>['model']) {
  return {
    lanes: model.lanes.map((lane) => ({ id: lane.id, trigger: String(lane.entry.body.trigger ?? '') })),
    board: isRec(model.doc.presentation) && model.doc.presentation.board === true,
    workspace: isRec(model.doc.workspace),
  };
}

export function useLayoutActions() {
  const { source, model, readOnly, apply, screen, selectBlock } = useEditor();
  const blocks = model.screens[screen];

  /** Le bloc `ui` entier disparaît quand plus aucun écran n'est composé. */
  const withoutScreen = useCallback(
    (target: UiScreen) => {
      const other = target === 'contributor' ? 'manage' : 'contributor';
      return model.screens[other] === null ? removeAt(source, ['ui']) : removeAt(source, ['ui', target]);
    },
    [model.screens, source]
  );

  const blockValue = (id: string, component: string, at: UiPlacement, props: Record<string, unknown>) => ({
    id,
    component,
    at,
    ...(Object.keys(props).length > 0 ? { props } : {}),
  });

  /** Pose un composant : à l'endroit demandé s'il est libre, sinon à la première place libre. */
  const addBlock = useCallback(
    (component: string, wanted?: { x: number; y: number }): string | null => {
      if (readOnly) return null;
      const spec = uiComponent(component);
      if (!spec) return null;
      const current = blocks ?? [];
      const asked = wanted ? clampPlacement({ x: wanted.x, y: wanted.y, w: spec.size.w, h: spec.size.h }, component) : null;
      const at = asked && !current.some((block) => overlaps(block.at, asked)) ? asked : freeSpot(current, spec.size.w, spec.size.h);
      const props: Record<string, unknown> = {};
      if (component === 'lane') {
        const trigger = screen === 'contributor' ? 'user' : 'admin';
        const taken = new Set(current.filter((block) => block.component === 'lane').map((block) => String(block.props.lane ?? '')));
        const lane = model.lanes.find((candidate) => String(candidate.entry.body.trigger) === trigger && !taken.has(candidate.id)) ?? model.lanes.find((candidate) => String(candidate.entry.body.trigger) === trigger);
        if (lane) props.lane = lane.id;
      }
      const id = freeBlockId(current, typeof props.lane === 'string' ? props.lane : component);
      const value = blockValue(id, component, at, props);
      const next = blocks === null ? setAt(source, ['ui', screen], { blocks: [value] }) : insertAt(source, ['ui', screen, 'blocks'], current.length, value);
      apply(next);
      const key = `ui.${screen}.blocks.${current.length}`;
      selectBlock(key);
      return key;
    },
    [apply, blocks, model.lanes, readOnly, screen, selectBlock, source]
  );

  /** Déplace ou redimensionne : `null` si le geste passe, sinon la raison du refus. */
  const placeBlock = useCallback(
    (block: BlockView, at: UiPlacement): string | null => {
      if (readOnly) return 'Read-only';
      const placed = clampPlacement(at, block.component);
      const other = (blocks ?? []).find((candidate) => candidate.key !== block.key && overlaps(candidate.at, placed));
      if (other) return `‘${block.id}’ would overlap ‘${other.id}’.`;
      if (placed.x === block.at.x && placed.y === block.at.y && placed.w === block.at.w && placed.h === block.at.h) return null;
      apply(setAt(source, [...block.path, 'at'], placed), `place:${block.key}`);
      return null;
    },
    [apply, blocks, readOnly, source]
  );

  const removeBlock = useCallback(
    (block: BlockView) => {
      if (readOnly) return;
      selectBlock(null);
      apply(removeAt(source, block.path));
    },
    [apply, readOnly, selectBlock, source]
  );

  /** Ouvre l'écran sur sa mise en page générée, écrite en blocs. */
  const startScreen = useCallback(() => {
    if (readOnly) return;
    const generated = defaultScreen(layoutSourceOf(model), screen).map((block) => blockValue(block.id, block.component, block.at, block.props));
    apply(setAt(source, ['ui', screen], { blocks: generated }));
    selectBlock(null);
  }, [apply, model, readOnly, screen, selectBlock, source]);

  const resetScreen = useCallback(() => {
    if (readOnly) return;
    selectBlock(null);
    apply(withoutScreen(screen));
  }, [apply, readOnly, screen, selectBlock, withoutScreen]);

  return { blocks, addBlock, placeBlock, removeBlock, startScreen, resetScreen };
}
