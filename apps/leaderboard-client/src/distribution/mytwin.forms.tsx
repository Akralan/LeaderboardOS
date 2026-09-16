import { BrainCircuit, Code2, LayoutTemplate, ShieldCheck, Tags } from 'lucide-react';
import type { FlowFormSection } from '@/lib/flowFormSlots';
import { codeFormLogic } from './forms/code';
import { mlFormLogic } from './forms/ml';
import { validationFormLogic } from './forms/validation';
import { annotationFormLogic } from './forms/annotation';
import { CodeDetails, CodeFields } from './forms/code-fields';
import { MlFields } from './forms/ml-fields';
import { ValidationDetails, ValidationFields } from './forms/validation-fields';
import { AnnotationFields } from './forms/annotation-fields';
import { templateFormLogic, type PublishedTemplateEntry } from './forms/template';
import { templateFields } from './forms/template-fields';

export type { PublishedTemplateEntry } from './forms/template';

export { sandboxKinds, sandboxKindOf, type SandboxKind } from './forms/sandbox';

/**
 * Distribution MyTwin — formulaires de challenge
 * ----------------------------------------------
 * Les entrées du sélecteur de type du tiroir de challenge, avec leurs champs.
 * La logique de chaque section vit dans `forms/<entrée>.ts`, testable sans
 * navigateur ; les champs dans `forms/<entrée>-fields.tsx`.
 */
export const creatableFormSections: readonly FlowFormSection[] = [
  { ...codeFormLogic, label: 'Code', description: 'Tasks, Kanban, GitHub', icon: Code2, Fields: CodeFields, Details: CodeDetails },
  { ...mlFormLogic, label: 'ML', description: 'Dataset, Model, API', icon: BrainCircuit, Fields: MlFields },
  {
    ...validationFormLogic,
    label: 'Validation',
    description: 'Test a submitted API live',
    icon: ShieldCheck,
    Fields: ValidationFields,
    Details: ValidationDetails,
  },
  { ...annotationFormLogic, label: 'Annotation', description: 'Label images, hidden checks', icon: Tags, Fields: AnnotationFields },
];

/**
 * La section générée d'un template publié en base : ses champs viennent de
 * ses déclarations de paramètres. Aucune section écrite à la main ne le couvre.
 */
export function templateFormSection(entry: PublishedTemplateEntry): FlowFormSection {
  const surface = entry.latest?.surface ?? { lanes: [], resources: [], params: [] };
  return {
    ...templateFormLogic(entry),
    label: entry.latest?.descriptor.label ?? entry.name,
    description: entry.latest ? `Template · v${entry.latest.version}` : 'Template',
    icon: LayoutTemplate,
    Fields: templateFields(surface),
  };
}

export function formSectionByKey(key: string, extra: readonly FlowFormSection[] = []): FlowFormSection {
  return [...creatableFormSections, ...extra].find((section) => section.key === key) ?? creatableFormSections[0];
}

/** La section d'un challenge existant ou d'une proposition, par la clé de son flow. */
export function formSectionFor(flowKey: string | null | undefined, extra: readonly FlowFormSection[] = []): FlowFormSection {
  return [...creatableFormSections, ...extra].find((section) => section.covers(flowKey)) ?? creatableFormSections[0];
}
