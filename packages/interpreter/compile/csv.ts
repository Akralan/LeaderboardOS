/**
 * CSV minimal (RFC 4180), côté serveur : le fichier d'un `many.from_file`
 * devient des lignes `{ colonne: valeur }`, que la création valide ensuite.
 * Champs entre guillemets, guillemets doublés, retours à la ligne dans un champ
 * cité, fins de ligne CRLF ou LF ; la première ligne est l'en-tête, les lignes
 * vides sont ignorées.
 */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^﻿/, "");

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((cell) => cell.trim() !== ""));
  if (nonEmpty.length === 0) return [];
  const header = nonEmpty[0].map((cell) => cell.trim().toLowerCase());
  return nonEmpty.slice(1).map((cells) => Object.fromEntries(header.map((name, index) => [name, (cells[index] ?? "").trim()])));
}
