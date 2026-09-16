/**
 * Une réponse d'erreur d'action, de la forme que sert le dispatcher.
 * Locale : importer `challenge-actions` chargerait les repositories dès la
 * déclaration du flow, ce qu'un flow ne fait jamais avant son premier appel.
 */
export function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}
