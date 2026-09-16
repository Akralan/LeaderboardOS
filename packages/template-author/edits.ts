import { isMap, isSeq, parseDocument } from "yaml";
import { z } from "zod";
import { stringifyPreserving } from "./yaml-text.js";

/**
 * Les éditions de l'agent
 * -----------------------
 * Pour changer un document existant, l'agent ne réécrit pas le texte : il
 * envoie des éditions adressées par chemin, appliquées sur le document YAML.
 * Ce qu'il ne touche pas reste identique à l'octet près, commentaires compris
 * (note §3, A2) — et une édition mal adressée revient comme un diagnostic de
 * plus, pas comme un document abîmé.
 */

const path = z.array(z.union([z.string(), z.number().int().min(0)])).min(1);

export const editSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), path, value: z.unknown() }),
  z.object({ op: z.literal("insert"), path, index: z.number().int().min(0).optional(), value: z.unknown() }),
  z.object({ op: z.literal("delete"), path }),
]);
export type TemplateEdit = z.infer<typeof editSchema>;

export interface EditsResult {
  yaml: string;
  /** Les éditions refusées, avec leur raison : renvoyées au modèle au tour suivant. */
  failures: string[];
}

export function applyEdits(source: string, edits: readonly TemplateEdit[]): EditsResult {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) {
    return { yaml: source, failures: ["The current document does not parse as YAML: answer with the complete \"yaml\" instead of edits."] };
  }
  const failures: string[] = [];
  edits.forEach((edit, index) => {
    const where = `edit ${index + 1} (${edit.op} ${edit.path.join(".")})`;
    try {
      if (edit.op === "set") {
        doc.setIn(edit.path, doc.createNode(edit.value));
      } else if (edit.op === "delete") {
        if (!doc.hasIn(edit.path)) failures.push(`${where}: nothing at this path`);
        else doc.deleteIn(edit.path);
      } else {
        let seq = doc.getIn(edit.path, true);
        if (seq === undefined) {
          doc.setIn(edit.path, doc.createNode([]));
          seq = doc.getIn(edit.path, true);
        }
        if (!isSeq(seq)) {
          failures.push(`${where}: the path is not a sequence${isMap(seq) ? " (it is a mapping — use set)" : ""}`);
          return;
        }
        const at = Math.min(edit.index ?? seq.items.length, seq.items.length);
        seq.items.splice(at, 0, doc.createNode(edit.value));
      }
    } catch (error) {
      failures.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { yaml: stringifyPreserving(source, doc), failures };
}

/** Réécrit `template.id` : la clé du template est décidée par la plateforme, pas par le modèle. */
export function withTemplateId(source: string, key: string): string {
  const doc = parseDocument(source);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return source;
  if (doc.getIn(["template", "id"]) === key) return source;
  if (!isMap(doc.getIn(["template"], true))) return source;
  doc.setIn(["template", "id"], key);
  return stringifyPreserving(source, doc);
}
