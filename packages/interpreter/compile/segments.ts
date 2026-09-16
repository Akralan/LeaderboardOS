import type { FieldDecl } from "../format/schema.js";
import type { LaneModel, NodeModel } from "../validate/format.js";

/**
 * Les segments d'une lane
 * ----------------------
 * Ce qu'un appel exécute : du geste (s'il y en a un) au prochain. Pur — le
 * compilateur en tire ses actions, la description d'un template (`describe.ts`)
 * en tire les formulaires que le client génère.
 */

export const gestureFields = (node: NodeModel): Record<string, FieldDecl> =>
  node.family === "collect" || node.family === "assess" ? node.body.fields ?? {} : {};

export const isGesture = (node: NodeModel) =>
  node.family === "collect" || (node.family === "assess" && node.body.kind === "human" && Boolean(node.body.fields));

/** Un segment : ce qu'un seul appel exécute, du geste (s'il y en a un) au prochain. */
export interface Segment {
  nodes: NodeModel[];
  gestures: NodeModel[];
  path: string;
  final: boolean;
}

export function segmentsOf(lane: LaneModel): Segment[] {
  const segments: { nodes: NodeModel[]; serverStep: boolean }[] = [];
  for (const node of lane.nodes) {
    const current = segments[segments.length - 1];
    if (!current || (isGesture(node) && current.serverStep)) {
      segments.push({ nodes: [node], serverStep: !isGesture(node) && node.family !== "gate" });
      continue;
    }
    current.nodes.push(node);
    if (!isGesture(node) && node.family !== "gate") current.serverStep = true;
  }
  return segments.map((segment, index) => {
    const first = segment.nodes[0];
    return {
      nodes: segment.nodes,
      gestures: segment.nodes.filter(isGesture),
      path: isGesture(first) ? `${lane.id}/${first.id}` : lane.id,
      final: index === segments.length - 1,
    };
  });
}
