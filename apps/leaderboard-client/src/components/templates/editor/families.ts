/**
 * Les familles de nœuds de l'éditeur de graphe
 * --------------------------------------------
 * La couleur porte un sens — la famille —, jamais une décoration. `Transition`
 * s'écrit `act: {transition: …}` dans le document et `Aggregate` vit dans
 * `lifecycle.aggregates` : ce sont des familles de l'éditeur, pas du format.
 */

export type Family = 'entry' | 'collect' | 'gate' | 'act' | 'assess' | 'reward' | 'transition' | 'aggregate';

export interface FamilyInfo {
  family: Family;
  label: string;
  role: string;
  hue: string;
}

export const FAMILIES: Record<Family, FamilyInfo> = {
  entry: { family: 'entry', label: 'Entry', role: 'who starts this lane: user, admin or cron', hue: '#94a3b8' },
  collect: { family: 'collect', label: 'Collect', role: 'a form step the actor fills', hue: '#60a5fa' },
  gate: { family: 'gate', label: 'Gate', role: 'blocking check or routing branches', hue: '#f59e0b' },
  act: { family: 'act', label: 'Act', role: 'observer, effector or grant', hue: '#a78bfa' },
  assess: { family: 'assess', label: 'Assess', role: 'AI grid, human verdict, metric', hue: '#4ade80' },
  reward: { family: 'reward', label: 'Reward', role: 'pays points, pool-clamped', hue: '#facc15' },
  aggregate: { family: 'aggregate', label: 'Aggregate', role: 'consensus over a resource', hue: '#2dd4bf' },
  transition: { family: 'transition', label: 'Transition', role: 'closes a resource with a verdict', hue: '#9ca3af' },
};

export const PALETTE: readonly Family[] = ['entry', 'collect', 'gate', 'act', 'assess', 'reward', 'transition', 'aggregate'];

/** Ce que le moteur n'exécute pas encore : la palette le dit plutôt que de le cacher. */
export const LOCKED_FAMILIES: readonly { label: string; tip: string }[] = [
  { label: 'Webhook entry', tip: 'Coming with its first template' },
  { label: 'Spawn / Link', tip: 'Coming with its first template' },
  { label: 'Stake access', tip: 'Coming with its first template' },
];

export const ERROR_HUE = '#f87171';
export const ADVISORY_HUE = '#fbbf24';
