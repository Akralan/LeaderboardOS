import type { FlowDescriptor } from '../../../../../packages/registry/flows';
import type { SurfaceParam, TemplateSurface } from '../../../../../packages/interpreter/describe';
import type { FlowFormLogic } from '@/lib/flowFormSlots';
import { flowConfigRecord } from './shared';

/**
 * La section d'un template en base (templates-in-db, T1)
 * ------------------------------------------------------
 * Un template publié depuis l'éditeur n'a pas de section écrite à la main :
 * elle se génère de ses déclarations de paramètres, servies par
 * `GET /api/templates`. Le pool va dans le champ commun, le challenge source
 * dans `source_challenge_id`, les paramètres figés dans `flow_config`, les
 * éditables dans `reward_rules`. Le serveur revalide avec le vrai schéma : les
 * checks nommés reviennent comme messages d'erreur.
 */

/** Un template publié, tel que le liste `GET /api/templates`. */
export interface PublishedTemplateEntry {
  key: string;
  name: string;
  latest: { version: string; descriptor: FlowDescriptor; surface: TemplateSurface } | null;
}

export interface TemplateFormState {
  /** Par paramètre : la valeur saisie. Un paramètre `json` s'y tient en texte jusqu'à l'envoi. */
  values: Record<string, unknown>;
  sourceChallengeId: string;
}

/** Les paramètres que la section saisit : ni le pool, qui a son champ commun, ni la source, qui a le sien. */
export function editableParams(surface: TemplateSurface): SurfaceParam[] {
  return surface.params.filter((param) => param.binding === 'config' || param.binding === 'rules');
}

function initialValue(param: SurfaceParam, stored: unknown): unknown {
  const value = stored !== undefined ? stored : param.default;
  if (param.kind === 'json') return value === undefined ? '' : JSON.stringify(value, null, 2);
  return value;
}

/** La valeur à envoyer, ou le message qui bloque l'envoi. */
function parsed(param: SurfaceParam, raw: unknown): { value: unknown } | { error: string } {
  if (raw === undefined || raw === '' || raw === null) return { error: `${param.name} is required` };
  if (param.kind === 'json') {
    try {
      return { value: JSON.parse(String(raw)) };
    } catch {
      return { error: `${param.name} is not valid JSON` };
    }
  }
  if ((param.kind === 'int' || param.kind === 'number') && typeof raw !== 'number') return { error: `${param.name} is a number` };
  return { value: raw };
}

export function templateFormLogic(entry: PublishedTemplateEntry): FlowFormLogic<TemplateFormState> {
  const surface = entry.latest?.surface ?? { lanes: [], resources: [], params: [] };
  const params = editableParams(surface);
  const needsSource = surface.params.some((param) => param.binding === 'source');

  const collect = (state: TemplateFormState, bindings: readonly SurfaceParam['binding'][]): { values: Record<string, unknown> } | { error: string } => {
    const values: Record<string, unknown> = {};
    for (const param of params.filter((candidate) => bindings.includes(candidate.binding))) {
      const result = parsed(param, state.values[param.name]);
      if ('error' in result) return { error: result.error };
      values[param.name] = result.value;
    }
    return { values };
  };

  return {
    key: entry.key,
    covers: (flowKey) => flowKey === entry.key,

    initialState(ctx) {
      const config = flowConfigRecord(ctx.challenge);
      const rules = ctx.challenge?.reward_rules && typeof ctx.challenge.reward_rules === 'object' ? (ctx.challenge.reward_rules as Record<string, unknown>) : {};
      return {
        values: Object.fromEntries(params.map((param) => [param.name, initialValue(param, (param.binding === 'rules' ? rules : config)[param.name])])),
        sourceChallengeId: ctx.challenge?.source_challenge_id ?? '',
      };
    },

    validate(state, ctx) {
      if (ctx.mode === 'edit') {
        const rules = collect(state, ['rules']);
        return 'error' in rules ? rules.error : null;
      }
      if (needsSource && !state.sourceChallengeId) return 'Pick the source challenge this template works on.';
      const all = collect(state, ['config', 'rules']);
      return 'error' in all ? all.error : null;
    },

    body(state, ctx) {
      const rules = collect(state, ['rules']);
      const rewardRules = 'values' in rules && Object.keys(rules.values).length > 0 ? rules.values : null;
      if (ctx.mode === 'edit') return { reward_rules: rewardRules };
      const config = collect(state, ['config']);
      return {
        type: entry.key,
        flow_config: 'values' in config ? config.values : {},
        reward_rules: rewardRules,
        compute_enabled: false,
        ...(needsSource ? { source_challenge_id: state.sourceChallengeId } : {}),
      };
    },
  };
}
