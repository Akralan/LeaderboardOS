import type { UiPlacement, UiScreen } from "../format/schema.js";
import { LANE_TRIGGER_OF_SCREEN, UI_COLUMNS, uiComponent } from "./catalog.js";

/**
 * La géométrie d'un écran composé
 * -------------------------------
 * Pur : ce que le validateur, l'éditeur de mise en page et les écrans générés
 * partagent — le recouvrement de deux blocs, la mise en page par défaut d'un
 * écran (celle que le client empile sans bloc `ui`, écrite en blocs), la
 * première place libre pour un bloc neuf.
 */

export interface PlacedBlock {
  id: string;
  component: string;
  at: UiPlacement;
  props: Record<string, unknown>;
}

/** Ce qu'une mise en page par défaut lit d'un template. */
export interface LayoutSource {
  lanes: readonly { id: string; trigger: string }[];
  board: boolean;
  workspace: boolean;
}

export function overlaps(a: UiPlacement, b: UiPlacement): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** La hauteur occupée : la ligne sous le bloc le plus bas. */
export function heightOf(blocks: readonly { at: UiPlacement }[]): number {
  return blocks.reduce((max, block) => Math.max(max, block.at.y + block.at.h), 0);
}

/** Un placement ramené dans la grille, à la taille minimale du composant. */
export function clampPlacement(at: UiPlacement, component: string): UiPlacement {
  const spec = uiComponent(component);
  const minW = spec?.size.minW ?? 1;
  const minH = spec?.size.minH ?? 1;
  const w = Math.max(minW, Math.min(UI_COLUMNS, Math.round(at.w)));
  const h = Math.max(minH, Math.round(at.h));
  const x = Math.max(0, Math.min(UI_COLUMNS - w, Math.round(at.x)));
  const y = Math.max(0, Math.round(at.y));
  return { x, y, w, h };
}

/** La première place libre, en lisant la grille ligne par ligne ; sinon sous tout. */
export function freeSpot(blocks: readonly { at: UiPlacement }[], w: number, h: number): UiPlacement {
  const height = heightOf(blocks);
  for (let y = 0; y <= height; y++) {
    for (let x = 0; x + w <= UI_COLUMNS; x++) {
      const candidate = { x, y, w, h };
      if (!blocks.some((block) => overlaps(block.at, candidate))) return candidate;
    }
  }
  return { x: 0, y: height, w, h };
}

/** Un identifiant de bloc libre : le nom du composant, suffixé s'il est pris. */
export function freeBlockId(blocks: readonly { id: string }[], base: string): string {
  const taken = new Set(blocks.map((block) => block.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

/**
 * La mise en page par défaut d'un écran : exactement ce que le client empile
 * sans bloc `ui`, écrit en blocs pleine largeur — le point de départ d'une
 * composition.
 */
export function defaultScreen(source: LayoutSource, screen: UiScreen): PlacedBlock[] {
  const blocks: PlacedBlock[] = [];
  const place = (component: string, props: Record<string, unknown> = {}, id = component) => {
    const spec = uiComponent(component);
    if (!spec) return;
    blocks.push({ id: freeBlockId(blocks, id), component, at: { x: 0, y: heightOf(blocks), w: spec.size.w, h: spec.size.h }, props });
  };
  const lanes = source.lanes.filter((lane) => lane.trigger === LANE_TRIGGER_OF_SCREEN[screen]);
  if (screen === "contributor") {
    if (source.workspace) place("workspace");
    if (source.board) place("board");
    for (const lane of lanes) place("lane", { lane: lane.id }, lane.id);
    place("mine");
  } else {
    for (const lane of lanes) place("lane", { lane: lane.id }, lane.id);
    place("overview");
    place("resources");
  }
  return blocks;
}
