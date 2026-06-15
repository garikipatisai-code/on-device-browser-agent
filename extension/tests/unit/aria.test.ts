import { describe, expect, it } from 'vitest';
import { assignIndices, capTree, serializeTree, simplifyAxTree, type AxNode } from '@/agent/tools/browser/aria';

function n(id: string, role: string, opts: Partial<AxNode> & { children?: string[] } = {}): AxNode {
  return {
    nodeId: id,
    parentId: opts.parentId,
    childIds: opts.children,
    role: { value: role },
    name: opts.name,
    value: opts.value,
    ignored: opts.ignored,
    backendDOMNodeId: opts.backendDOMNodeId,
  };
}

describe('simplifyAxTree', () => {
  it('collapses generic wrappers without names', () => {
    const nodes: AxNode[] = [
      n('1', 'RootWebArea', { children: ['2'] }),
      n('2', 'generic', { children: ['3'], parentId: '1' }),
      n('3', 'button', { parentId: '2', name: { value: 'Click me' }, backendDOMNodeId: 99 }),
    ];
    const tree = simplifyAxTree(nodes);
    expect(tree.role).toBe('button');
    expect(tree.name).toBe('Click me');
  });

  it('preserves backendDOMNodeId', () => {
    const nodes: AxNode[] = [
      n('1', 'RootWebArea', { children: ['2'] }),
      n('2', 'button', { parentId: '1', name: { value: 'Add' }, backendDOMNodeId: 42 }),
    ];
    const tree = simplifyAxTree(nodes);
    expect(tree.backendDOMNodeId).toBe(42);
  });

  it('drops ignored nodes', () => {
    const nodes: AxNode[] = [
      n('1', 'RootWebArea', { children: ['2', '3'] }),
      n('2', 'button', { parentId: '1', name: { value: 'A' }, backendDOMNodeId: 1 }),
      n('3', 'button', { parentId: '1', name: { value: 'B' }, backendDOMNodeId: 2, ignored: true }),
    ];
    const tree = simplifyAxTree(nodes);
    expect(tree.role).toBe('button');
    expect(tree.name).toBe('A');
  });

  it('keeps descendants of an ignored wrapper node (does not drop the subtree)', () => {
    // Real pages bury content under ignored generic wrappers.
    const nodes: AxNode[] = [
      n('1', 'RootWebArea', { children: ['2'] }),
      n('2', 'generic', { parentId: '1', ignored: true, children: ['3', '4'] }),
      n('3', 'link', { parentId: '2', name: { value: 'Wireless Mouse' }, backendDOMNodeId: 50 }),
      n('4', 'button', { parentId: '2', name: { value: 'Add to Cart' }, backendDOMNodeId: 51 }),
    ];
    const tree = simplifyAxTree(nodes);
    const { byIndex, total } = assignIndices(tree);
    expect(total).toBe(2); // both the link and button survived the ignored wrapper
    expect([...byIndex.values()].sort()).toEqual([50, 51]);
  });
  it('does not crash on non-string AX values (numbers/booleans)', () => {
    // Regression: results page had a node with a numeric value → "s.value.slice is not a function".
    const nodes: AxNode[] = [
      n('1', 'main', { children: ['2', '3'] }),
      n('2', 'slider', {
        parentId: '1',
        name: { value: 'Volume' },
        backendDOMNodeId: 7,
        value: { value: 5 as unknown as string },
      }),
      n('3', 'checkbox', {
        parentId: '1',
        name: { value: 'Agree' },
        backendDOMNodeId: 8,
        value: { value: true as unknown as string },
      }),
    ];
    const tree = simplifyAxTree(nodes);
    expect(() => serializeTree(tree)).not.toThrow();
    expect(() => capTree(tree, 10_000)).not.toThrow();
    expect(serializeTree(tree)).toContain('"5"'); // numeric value coerced to string
  });
  it('drops InlineTextBox noise and StaticText that echoes its parent name', () => {
    const nodes: AxNode[] = [
      n('1', 'main', { children: ['2'] }),
      n('2', 'link', {
        parentId: '1',
        name: { value: 'Logitech M185 $13.42' },
        backendDOMNodeId: 5,
        children: ['3', '4'],
      }),
      n('3', 'StaticText', { parentId: '2', name: { value: 'Logitech M185 $13.42' } }), // echoes parent → drop
      n('4', 'InlineTextBox', { parentId: '2', name: { value: 'Logitech M185 $13.42' } }), // layout dup → drop
    ];
    const tree = simplifyAxTree(nodes);
    const text = serializeTree(tree);
    expect(text).toContain('link "Logitech M185 $13.42"');
    expect(text).not.toContain('StaticText');
    expect(text).not.toContain('InlineTextBox');
  });
});

describe('assignIndices', () => {
  it('assigns numeric indices to interactive nodes', () => {
    const nodes: AxNode[] = [
      n('1', 'main', { children: ['2', '3', '4'] }),
      n('2', 'link', { parentId: '1', name: { value: 'home' }, backendDOMNodeId: 10 }),
      n('3', 'paragraph', { parentId: '1', name: { value: 'text' } }),
      n('4', 'button', { parentId: '1', name: { value: 'go' }, backendDOMNodeId: 20 }),
    ];
    const tree = simplifyAxTree(nodes);
    const { byIndex, total } = assignIndices(tree);
    expect(total).toBe(2);
    expect(byIndex.get(1)).toBe(10);
    expect(byIndex.get(2)).toBe(20);
  });
});

describe('serializeTree', () => {
  it('renders indices', () => {
    const nodes: AxNode[] = [
      n('1', 'main', { children: ['2'] }),
      n('2', 'button', { parentId: '1', name: { value: 'Save' }, backendDOMNodeId: 99 }),
    ];
    const tree = simplifyAxTree(nodes);
    assignIndices(tree);
    const text = serializeTree(tree);
    expect(text).toContain('[1] button "Save"');
  });
});

describe('capTree', () => {
  it('returns text unchanged when below cap', () => {
    const tree = simplifyAxTree([n('1', 'button', { name: { value: 'x' } })]);
    const r = capTree(tree, 10_000);
    expect(r.truncated).toBe(false);
  });
  it('marks truncated when exceeding cap', () => {
    const nodes: AxNode[] = [n('1', 'main', { children: ['2'] })];
    for (let i = 2; i < 200; i++) {
      nodes.push(n(String(i), 'link', { parentId: '1', name: { value: 'item-' + i } }));
    }
    nodes[0].childIds = nodes.slice(1).map((x) => x.nodeId);
    const tree = simplifyAxTree(nodes);
    const r = capTree(tree, 500);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('truncated');
  });

  it('trims chrome landmarks (nav/footer/sidebar) before main content', () => {
    const nodes: AxNode[] = [
      n('1', 'RootWebArea', { children: ['2', '3'] }),
      n('2', 'navigation', { parentId: '1', name: { value: 'Primary' }, children: ['4', '5', '6', '7', '8'] }),
      n('4', 'link', { parentId: '2', name: { value: 'Departments menu link one' }, backendDOMNodeId: 40 }),
      n('5', 'link', { parentId: '2', name: { value: 'Departments menu link two' }, backendDOMNodeId: 41 }),
      n('6', 'link', { parentId: '2', name: { value: 'Departments menu link three' }, backendDOMNodeId: 42 }),
      n('7', 'link', { parentId: '2', name: { value: 'Departments menu link four' }, backendDOMNodeId: 43 }),
      n('8', 'link', { parentId: '2', name: { value: 'Departments menu link five' }, backendDOMNodeId: 44 }),
      n('3', 'main', { parentId: '1', children: ['9'] }),
      n('9', 'link', { parentId: '3', name: { value: 'PRODUCT Logitech M330 $19.99' }, backendDOMNodeId: 99 }),
    ];
    const tree = simplifyAxTree(nodes);
    const r = capTree(tree, 200);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('PRODUCT Logitech M330'); // main content survives
    expect(r.text).not.toContain('Departments menu link five'); // nav contents trimmed
  });

  it('keeps a search box inside trimmed chrome (banner) so the agent can use it', () => {
    // Regression: the site search box lives in the header/banner; capTree used to
    // strip the whole banner, so the model couldn't see or target it.
    const headerLinks = [
      'Account and Lists header menu',
      'Returns and Orders header link',
      'Cart header link area',
      'Hello sign in dropdown menu',
      'Deliver to your location link',
      'Language selector header link',
      'Best Sellers navigation link',
      'Customer Service navigation link',
    ];
    const nodes: AxNode[] = [
      n('1', 'RootWebArea', { children: ['2', '3'] }),
      n('2', 'banner', { parentId: '1', children: ['s', ...headerLinks.map((_, i) => `h${i}`)] }),
      n('s', 'searchbox', { parentId: '2', name: { value: 'Search Amazon' }, backendDOMNodeId: 40 }),
      ...headerLinks.map((name, i) =>
        n(`h${i}`, 'link', { parentId: '2', name: { value: name }, backendDOMNodeId: 50 + i }),
      ),
      n('3', 'main', { parentId: '1', children: ['p'] }),
      n('p', 'link', { parentId: '3', name: { value: 'PRODUCT Logitech M330 $19.99' }, backendDOMNodeId: 99 }),
    ];
    const tree = simplifyAxTree(nodes);
    assignIndices(tree);
    const r = capTree(tree, 250);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('searchbox "Search Amazon"'); // the search box survives
    expect(r.text).toContain('PRODUCT Logitech M330'); // main content survives
    expect(r.text).not.toContain('Account and Lists'); // surrounding header clutter trimmed
  });
});
