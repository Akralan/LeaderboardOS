import type { FlowUiSlots } from '@/lib/flowSlots';
import { codeFlowDescriptor } from '../../../../content/flows/code/descriptor';
import { mlFlowDescriptor } from '../../../../content/flows/ml/descriptor';
import { endpointValidationFlowDescriptor } from '../../../../content/flows/endpoint-validation/descriptor';
import { journeyValidationFlowDescriptor } from '../../../../content/flows/journey-validation/descriptor';
import { dataAnnotationFlowDescriptor } from '../../../../content/templates/data-annotation/descriptor';
import { endpointCheckTemplate } from '../../../../content/templates/endpoint-check/descriptor';
import { flowCatalog } from './mytwin.flows';
import { codeSlots } from './client/code';
import { mlSlots } from './client/ml';
import { endpointValidationSlots } from './client/endpoint-validation';
import { journeyValidationSlots } from './client/journey-validation';
import { dataAnnotationSlots } from './client/data-annotation';
import { generatedSlots } from './client/generated';

/**
 * Distribution MyTwin — slots d'interface des flows
 * -------------------------------------------------
 * Ce que chaque flow installé place dans les écrans du shell (onglets, hero,
 * vue anonyme, règles). Registre client, distinct du registre serveur : il
 * charge des composants React, que le serveur de la plateforme n'a pas à
 * connaître.
 */
const SLOTS: Readonly<Record<string, FlowUiSlots>> = {
  [codeFlowDescriptor.key]: codeSlots,
  [mlFlowDescriptor.key]: mlSlots,
  [endpointValidationFlowDescriptor.key]: endpointValidationSlots,
  [journeyValidationFlowDescriptor.key]: journeyValidationSlots,
  [dataAnnotationFlowDescriptor.key]: dataAnnotationSlots,
  // Aucun écran écrit à la main : l'UI que l'interpréteur génère du template (note §5).
  [endpointCheckTemplate.descriptor.key]: generatedSlots(endpointCheckTemplate),
};

/** Les slots du flow de ce type ; ceux du flow par défaut pour un type absent ou inconnu, comme `flowCatalog`. */
export function flowSlots(type: string | null | undefined): FlowUiSlots {
  return SLOTS[flowCatalog.resolve(type).key] ?? SLOTS[flowCatalog.defaultKey];
}
