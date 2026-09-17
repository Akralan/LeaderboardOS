import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { templateSource as annotation } from '../../../../../../content/templates/data-annotation/template.source';
import { templateSource as endpointCheck } from '../../../../../../content/templates/endpoint-check/template.source';
import { brokenReads, buildModel, contextFor, locate, provenanceOf } from './model';
import { addBranch, blankTemplate, bump, insertAt, moveNode, newNodeValue, refusalOf, renameKey, setAt, setGateMode } from './mutations';

const keyOf = (model: ReturnType<typeof buildModel>, id: string) => [...model.nodes.values()].find((node) => node.id === id)!.key;

describe('the graph editor model', () => {
  it('reads the annotation template as four lanes, with the routing gate and its branches', () => {
    const model = buildModel(annotation);
    expect(model.lanes.map((lane) => `${lane.title} · ${lane.subtitle}`)).toEqual([
      'Import · admin entry',
      'Resolve · admin entry',
      'Annotator · open entry',
      'Audit · cron · 0 4 * * 1',
    ]);
    const annotator = model.lanes[2];
    expect(annotator.items.map((item) => `${item.kind}:${item.node.id}`)).toEqual(['node:open', 'node:draw', 'node:label', 'routing:kind', 'node:pay']);
    const kind = annotator.items[3];
    expect(kind.kind === 'routing' && kind.branches.map((branch) => [branch.label, branch.items.map((item) => item.node.id)])).toEqual([
      ['draw.substituted', ['check']],
      ['else', ['submit']],
    ]);
    expect(model.nodes.get(keyOf(model, 'draw'))!.chips).toContainEqual({ label: 'claims: item', tone: 'resource' });
    expect(model.nodes.get(keyOf(model, 'submit'))!.emitsTo).toBe('agreement');
    expect(model.nodes.get(keyOf(model, 'settle'))!.family).toBe('transition');
    expect(model.aggregates[0].emitters).toEqual(['submit']);
  });

  it('summarizes declarations: visibility, claim policy, closure', () => {
    const model = buildModel(annotation);
    const item = model.resources.find((resource) => resource.name === 'item')!;
    expect(item.fields[0]).toMatchObject({ name: 'image_url', visibility: 'claimant + admin' });
    expect(item.claim).toBe('up to params.k (3) holders · TTL params.ttl_hours (48) h');
    expect(item.closure).toBe('closed by aggregate | admin_act → labeled | contested');
    expect(model.resources.find((resource) => resource.name === 'gold')!.fields[1].visibility).toBe('hidden — grant only');
    expect(model.params.find((param) => param.name === 'per_unit_cp')).toMatchObject({ type: 'points', mutable: true });
    expect(model.params.find((param) => param.name === 'label_schema')!.checks.map((check) => check.name)).toContain('option_keys_must_be_unique');
  });

  it('resolves a claimed ref field to its resource type', () => {
    const model = buildModel(endpointCheck);
    expect(model.nodes.get(keyOf(model, 'probe'))!.chips).toContainEqual({ label: 'claims: reference_case', tone: 'resource' });
    expect(model.lanes[2].subtitle).toBe('role: reviewer_qualification');
  });

  it('highlights provenance: what a node reads upstream', () => {
    const model = buildModel(annotation);
    const provenance = provenanceOf(model, keyOf(model, 'check')).map((key) => model.nodes.get(key)!.id);
    expect(provenance.sort()).toEqual(['draw', 'label']);
    const context = contextFor(model, keyOf(model, 'pay')).map((entry) => entry.path);
    expect(context).toEqual(expect.arrayContaining(['params.per_unit_cp', 'counters.gold_correct', 'label.value', 'draw.item.image_url', 'draw.substituted']));
  });

  it('points a diagnostic path at its node, lane or declaration', () => {
    const model = buildModel(annotation);
    expect(locate(model, 'lanes.2.nodes.4.reward.amount')).toEqual({ kind: 'node', key: 'lanes.2.nodes.4' });
    expect(locate(model, 'lanes.2.nodes.3.gate.branch.1.else.nodes.0.assess.emit.to')).toEqual({ kind: 'node', key: 'lanes.2.nodes.3.gate.branch.1.else.nodes.0' });
    expect(locate(model, 'params.k.check')).toEqual({ kind: 'declaration', tab: 'params', name: 'k' });
    expect(locate(model, 'template.id')).toEqual({ kind: 'declaration', tab: 'template', name: null });
  });

  it('has no broken reads on a valid template', () => {
    expect(brokenReads(buildModel(annotation)).size).toBe(0);
    expect(brokenReads(buildModel(endpointCheck)).size).toBe(0);
  });
});

describe('the graph editor writes', () => {
  it('inserts a palette node into a lane, keeping the comments', () => {
    const model = buildModel(annotation);
    const next = insertAt(annotation, ['lanes', 2, 'nodes'], 1, newNodeValue('gate', model));
    expect(next).toContain('# The data-annotation flow as a template');
    const lane = buildModel(next).lanes[2];
    expect(lane.items[1].node).toMatchObject({ id: 'check_2', family: 'gate' });
  });

  it('moves a node, resolving the target before the removal', () => {
    const next = moveNode(annotation, ['lanes', 2, 'nodes', 0], ['lanes', 2, 'nodes', 3, 'gate', 'branch', 0, 'nodes'], 0);
    const lane = buildModel(next).lanes[2];
    const kind = lane.items.find((item) => item.kind === 'routing')!;
    expect(kind.kind === 'routing' && kind.branches[0].items.map((item) => item.node.id)).toEqual(['open', 'check']);
  });

  it('refuses a move that puts a node above what it reads, with a reason', () => {
    const model = buildModel(annotation);
    const refusal = refusalOf(annotation, model, { kind: 'node', path: ['lanes', 2, 'nodes', 1] }, ['lanes', 2, 'nodes'], 5);
    expect(refusal).toMatch(/reads ‘draw’ — it must stay below ‘draw’/);
    expect(refusalOf(annotation, model, { kind: 'node', path: ['lanes', 2, 'nodes', 3] }, ['lanes', 2, 'nodes', 3, 'gate', 'branch', 0, 'nodes'], 0)).toMatch(/own branches/);
    expect(refusalOf(annotation, model, { kind: 'palette', family: 'entry' }, ['lanes', 2, 'nodes'], 0)).toMatch(/New lane/);
    expect(refusalOf(annotation, model, { kind: 'node', path: ['lanes', 2, 'nodes', 0] }, ['lanes', 2, 'nodes'], 2)).toBeNull();
  });

  it('edits values, branches, gate modes and keys', () => {
    let source = setAt(annotation, ['lanes', 2, 'nodes', 4, 'reward', 'amount'], 'params.rate');
    expect(parse(source).lanes[2].nodes[4].reward.amount).toBe('params.rate');
    source = addBranch(source, ['lanes', 2, 'nodes', 3, 'gate']);
    expect(parse(source).lanes[2].nodes[3].gate.branch.map((branch: object) => Object.keys(branch)[0])).toEqual(['when', 'when', 'else']);
    source = setGateMode(source, ['lanes', 2, 'nodes', 0, 'gate'], 'routing');
    expect(parse(source).lanes[2].nodes[0].gate.branch).toHaveLength(2);
    source = renameKey(source, ['params'], 'k', 'redundancy');
    expect(Object.keys(parse(source).params)[1]).toBe('redundancy');
  });

  it('starts a blank template with no lane, and bumps versions', () => {
    const model = buildModel(blankTemplate('code-review', 'Code review'));
    expect(model.header).toMatchObject({ id: 'code-review', version: '1.0.0', name: 'Code review' });
    expect(model.lanes).toEqual([]);
    expect([bump('1.2.0', 'patch'), bump('1.2.0', 'minor'), bump('1.2.0', 'major')]).toEqual(['1.2.1', '1.3.0', '2.0.0']);
  });
});

describe('the composed screens', () => {
  // Le template système compose ses propres écrans : le test pose les siens.
  const bare = endpointCheck.replace(/\r\n/g, '\n').replace(/\nui:[\s\S]*$/, '\n');
  const composed = `${bare.trimEnd()}\nui:\n  contributor:\n    blocks:\n      - {id: review, component: lane, at: {x: 0, y: 0, w: 8, h: 6}, props: {lane: reviewer}}\n      - {id: mine, component: mine, at: {x: 8, y: 0, w: 4, h: 6}}\n`;

  it('reads a composed screen as blocks, and leaves the other screen generated', () => {
    const model = buildModel(composed);
    expect(model.screens.manage).toBeNull();
    expect(model.screens.contributor?.map((block) => `${block.key} ${block.id}:${block.component}@${block.at.x},${block.at.y} ${block.at.w}x${block.at.h}`)).toEqual([
      'ui.contributor.blocks.0 review:lane@0,0 8x6',
      'ui.contributor.blocks.1 mine:mine@8,0 4x6',
    ]);
    expect(model.screens.contributor?.[0].props).toEqual({ lane: 'reviewer' });
    expect(model.screens.contributor?.[0].selects).toBeNull();
    expect(buildModel(bare).screens).toEqual({ contributor: null, manage: null });
    expect(buildModel(endpointCheck).screens.contributor?.length).toBe(4);
  });

  it('locates a ui diagnostic on its block, or on its screen', () => {
    const model = buildModel(composed);
    expect(locate(model, 'ui.contributor.blocks.1.component')).toEqual({ kind: 'block', screen: 'contributor', key: 'ui.contributor.blocks.1' });
    expect(locate(model, 'ui.manage')).toEqual({ kind: 'block', screen: 'manage', key: null });
  });

  it('moves a block by rewriting only its placement', () => {
    const next = setAt(composed, ['ui', 'contributor', 'blocks', 1, 'at'], { x: 0, y: 6, w: 12, h: 4 });
    expect(buildModel(next).screens.contributor?.[1].at).toEqual({ x: 0, y: 6, w: 12, h: 4 });
    expect(next).toContain('- {id: review, component: lane, at: {x: 0, y: 0, w: 8, h: 6}, props: {lane: reviewer}}');
  });
});
