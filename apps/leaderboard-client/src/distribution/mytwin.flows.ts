import { createFlowCatalog } from '../../../../packages/registry/flows';
import { codeFlowDescriptor } from '../../../../content/flows/code/descriptor';
import { mlFlowDescriptor } from '../../../../content/flows/ml/descriptor';
import { endpointValidationFlowDescriptor } from '../../../../content/flows/endpoint-validation/descriptor';
import { journeyValidationFlowDescriptor } from '../../../../content/flows/journey-validation/descriptor';
import { dataAnnotationFlowDescriptor } from '../../../../content/templates/data-annotation/descriptor';
import { endpointCheckFlowDescriptor } from '../../../../content/templates/endpoint-check/descriptor';

/**
 * Distribution MyTwin — catalogue des flows
 * -----------------------------------------
 * Les descripteurs des flows installés, lus par le client comme par le
 * serveur : noms, icônes, brief et visibilité publique. Données pures.
 *
 * `code` est le flow d'un challenge sans type, comme le défaut de la colonne
 * `challenges.type`.
 */
export const flowCatalog = createFlowCatalog(
  [
    codeFlowDescriptor,
    mlFlowDescriptor,
    endpointValidationFlowDescriptor,
    journeyValidationFlowDescriptor,
    dataAnnotationFlowDescriptor,
    endpointCheckFlowDescriptor,
  ],
  {
    defaultKey: 'code',
    // Un type hors du catalogue est un template publié en base : il se décrit
    // lui-même (`/api/templates/:key/describe`) et s'affiche en UI générée,
    // jamais sous le nom ni les écrans du flow code.
    unknown: (key) => ({
      key,
      label: key.replace(/-/g, ' ').replace(/^./, (first) => first.toUpperCase()),
      longLabel: key.replace(/-/g, ' ').replace(/^./, (first) => first.toUpperCase()),
      icon: 'sparkles',
      briefRequired: false,
      publiclyVisible: false,
    }),
  },
);
