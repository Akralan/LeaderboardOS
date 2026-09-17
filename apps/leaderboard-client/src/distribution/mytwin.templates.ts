import { templateSource as codeSource } from '../../../../content/templates/code/template.source';
import { templateSource as dataAnnotationSource } from '../../../../content/templates/data-annotation/template.source';
import { templateSource as endpointCheckSource } from '../../../../content/templates/endpoint-check/template.source';
import { templateSource as journeyValidationSource } from '../../../../content/templates/journey-validation/template.source';
import { templateSource as mlSource } from '../../../../content/templates/ml/template.source';

/**
 * Distribution MyTwin — templates système
 * ---------------------------------------
 * Le texte des templates que la distribution installe depuis ses fichiers :
 * en lecture seule dans la bibliothèque de l'éditeur, duplicables comme point
 * de départ, et surveillés pour leur dérive au démarrage. Données pures.
 */
export const systemTemplateSources: readonly { key: string; yaml: string }[] = [
  { key: 'code', yaml: codeSource },
  { key: 'data-annotation', yaml: dataAnnotationSource },
  { key: 'endpoint-check', yaml: endpointCheckSource },
  { key: 'journey-validation', yaml: journeyValidationSource },
  { key: 'ml', yaml: mlSource },
];

/**
 * Les qualifications que la distribution déclare (`MEDICAL_PRO` dans
 * mytwin.platform.ts) : l'agent auteur les propose même quand personne ne les
 * détient encore. Données pures, sans charger la plateforme.
 */
export const declaredQualifications: readonly string[] = ['medical_pro'];
