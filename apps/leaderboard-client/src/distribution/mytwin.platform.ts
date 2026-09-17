import type { PlatformDefinitions } from '../../../../packages/registry/platform';
import { codeFlow } from '../../../../content/flows/code';
import { codeTemplateFlow } from '../../../../content/templates/code';
import { mlFlow } from '../../../../content/flows/ml';
import { mlTemplateFlow } from '../../../../content/templates/ml';
import { endpointValidationFlow } from '../../../../content/flows/endpoint-validation';
import { journeyValidationTemplateFlow } from '../../../../content/templates/journey-validation';
import { dataAnnotationTemplateFlow } from '../../../../content/templates/data-annotation';
import { endpointCheckTemplateFlow } from '../../../../content/templates/endpoint-check';
import { validationKit } from '../../../../content/kits/validation';
import { slackSignalsExtension } from '../../../../content/extensions/slack-signals';
import { computeExtension } from '../../../../content/extensions/compute';
import { sandboxModule } from '../../../../modules/sandbox';
import { meetingsModule } from '../../../../modules/meetings';
import { digestModule } from '../../../../modules/digest';
import { onboardingModule } from '../../../../modules/onboarding';

/** La qualification des professionnels de santé, exigée par les validations MyTwin. */
export const MEDICAL_PRO = 'medical_pro';

/**
 * Distribution MyTwin — plateforme
 * --------------------------------
 * Les flows, extensions et modules installés, avec ce qu'ils écrivent dans le
 * ledger et dans `contributions`. Séparé de `mytwin.server.ts` pour pouvoir
 * être vérifié sans charger les connecteurs ni leurs credentials.
 */
export const platform: PlatformDefinitions = {
  flows: [
    // Compilé depuis content/templates/code/template.yaml (parité P3), avec continuité : les challenges code en cours
    // passent au template. Le flow écrit à la main reste la référence d'équivalence ; la distribution garde ses quêtes
    // et sa proposition de sandbox.
    { ...codeTemplateFlow, events: codeFlow.events, quests: codeFlow.quests, proposable: codeFlow.proposable },
    // Compilé depuis content/templates/ml/template.yaml (parité P5), avec continuité : mêmes dépôts d'étape, contributions
    // et ledger. La distribution garde la lecture des récompenses du flow (métrique, seuil) et sa proposition de sandbox.
    { ...mlTemplateFlow, rewards: mlFlow.rewards, proposable: mlFlow.proposable },
    // Les validations MyTwin sont jugées par des professionnels de santé.
    // Retiré par attrition : il sert ses challenges existants, les nouveaux prennent endpoint-check.
    { ...endpointValidationFlow, retired: true, configDefaults: { reviewer_qualification: MEDICAL_PRO } },
    // Compilé depuis content/templates/journey-validation/template.yaml (parité P4), avec continuité : les données des
    // challenges en cours sont copiées en ressources au déploiement (db:migrate-journey-resources). La clé de ledger et la
    // contribution `validation` restent déclarées une fois, par le kit que la validation d'endpoints partage encore.
    { ...journeyValidationTemplateFlow, ruleKeys: [], contributionTypes: [], configDefaults: { expert_comment_qualification: MEDICAL_PRO } },
    // Compilé depuis content/templates/data-annotation/template.yaml : le premier flow servi par l'interpréteur.
    dataAnnotationTemplateFlow,
    // Compilé depuis content/templates/endpoint-check/template.yaml : les validations d'endpoint nouvelles.
    { ...endpointCheckTemplateFlow, configDefaults: { reviewer_qualification: MEDICAL_PRO } },
  ],
  kits: [validationKit],
  extensions: [slackSignalsExtension, computeExtension],
  modules: [sandboxModule, meetingsModule, digestModule, onboardingModule],
  qualifications: [
    {
      key: MEDICAL_PRO,
      label: 'Health professional',
      description: 'A health professional whose qualification an admin has checked.',
    },
  ],
};
