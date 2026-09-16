import { describe, it, expect } from 'vitest';
import { flowSlots } from './mytwin.client';
import { flowCatalog } from './mytwin.flows';

describe('flowSlots', () => {
  it('gives every installed flow its own slots', () => {
    const slots = flowCatalog.list().map(descriptor => flowSlots(descriptor.key));

    expect(new Set(slots).size).toBe(flowCatalog.list().length);
    for (const slot of slots) {
      expect(typeof slot.contributorTabs).toBe('function');
      expect(typeof slot.manageTabs).toBe('function');
      expect(slot.rulesView).toBeDefined();
    }
  });

  it('falls back on the default flow only for a missing type', () => {
    expect(flowSlots(null)).toBe(flowSlots(flowCatalog.defaultKey));
  });

  it('renders a type absent from the tables — a database template — through generated UI, never another flow', () => {
    const slots = flowSlots('db-rating');
    expect(slots).not.toBe(flowSlots(flowCatalog.defaultKey));
    expect(flowSlots('db-rating')).toBe(slots);
    expect(slots.readsRewards).toBe(true);
    expect(flowCatalog.resolve('db-rating')).toMatchObject({ key: 'db-rating', label: 'Db rating', publiclyVisible: false });
    expect(flowCatalog.resolve(null).key).toBe(flowCatalog.defaultKey);
  });
});
