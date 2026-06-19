import { describe, expect, it } from 'vitest';
import { simplifyAxTree, assignIndices, type AxNode } from '@/agent/tools/browser/aria';

describe('aria indexing — edge cases', () => {
  it('indexes menuitemcheckbox/menuitemradio (kept by form-trimming, so they must be clickable)', () => {
    const nodes: AxNode[] = [
      { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', role: { value: 'menuitemcheckbox' }, name: { value: 'Toggle' }, backendDOMNodeId: 77, childIds: [] },
    ];
    const { byIndex } = assignIndices(simplifyAxTree(nodes));
    expect([...byIndex.values()]).toContain(77);
  });

  it('does not duplicate a child listed twice in childIds (no phantom duplicate index)', () => {
    const nodes: AxNode[] = [
      { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2', '2'] },
      { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 88, childIds: [] },
    ];
    const { total } = assignIndices(simplifyAxTree(nodes));
    expect(total).toBe(1);
  });
});
