import { templateSource as dataAnnotationSource } from '../../../../content/templates/data-annotation/template.source';
import { templateSource as endpointCheckSource } from '../../../../content/templates/endpoint-check/template.source';

/**
 * Distribution MyTwin — templates système
 * ---------------------------------------
 * Le texte des templates que la distribution installe depuis ses fichiers :
 * en lecture seule dans la bibliothèque de l'éditeur, duplicables comme point
 * de départ, et surveillés pour leur dérive au démarrage. Données pures.
 */
export const systemTemplateSources: readonly { key: string; yaml: string }[] = [
  { key: 'data-annotation', yaml: dataAnnotationSource },
  { key: 'endpoint-check', yaml: endpointCheckSource },
];
