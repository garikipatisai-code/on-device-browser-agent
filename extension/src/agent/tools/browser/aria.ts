// ARIA tree extraction.

export interface AxNode {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  description?: { value?: string };
  ignored?: boolean;
  backendDOMNodeId?: number;
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
}

export interface SimplifiedNode {
  role: string;
  name?: string;
  value?: string;
  backendDOMNodeId?: number;
  children: SimplifiedNode[];
  index?: number;
}

const SKIP_ROLES = new Set([
  'generic',
  'none',
  'presentation',
  'InlineTextBox',
  'StaticText',
  'RootWebArea',
]);

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menu',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'select',
  'slider',
  'spinbutton',
  'tablist',
]);

export function buildIndex(nodes: AxNode[]): Map<string, AxNode> {
  const m = new Map<string, AxNode>();
  for (const n of nodes) m.set(n.nodeId, n);
  return m;
}

export function simplifyAxTree(nodes: AxNode[]): SimplifiedNode {
  if (!nodes.length) return { role: 'root', children: [] };
  const byId = buildIndex(nodes);
  const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId));
  const built = roots.map((r) => buildNode(r, byId));
  let root: SimplifiedNode = built.length === 1 ? built[0] : { role: 'root', children: built };
  for (let i = 0; i < 5; i++) {
    if (
      (root.role === 'root' || isWrapperRole(root.role)) &&
      root.children.length === 1 &&
      !root.name
    ) {
      root = root.children[0];
    } else {
      break;
    }
  }
  return root;
}

function isWrapperRole(role: string): boolean {
  return SKIP_ROLES.has(role);
}

function buildNode(n: AxNode, byId: Map<string, AxNode>): SimplifiedNode {
  const childIds = n.childIds ?? [];
  const built: SimplifiedNode[] = [];
  for (const cid of childIds) {
    const c = byId.get(cid);
    if (!c) continue;
    const role = c.role?.value ?? 'generic';
    const name = c.name?.value;
    // InlineTextBox is a pure text-layout duplicate of its StaticText parent — drop it.
    if (role === 'InlineTextBox') continue;
    // A StaticText child that merely echoes the parent's accessible name is redundant noise.
    if (role === 'StaticText' && name && name === n.name?.value) continue;
    // An ignored node is transparent: skip the node itself but keep its
    // descendants (real pages bury content under ignored wrapper nodes).
    if (c.ignored) {
      const sub = buildNode(c, byId);
      built.push(...sub.children);
      continue;
    }
    if (SKIP_ROLES.has(role) && !name) {
      const sub = buildNode(c, byId);
      built.push(...sub.children);
    } else {
      built.push(buildNode(c, byId));
    }
  }
  return {
    role: n.role?.value ?? 'generic',
    // CDP AX name/value can be number/boolean (sliders, ratings, spinbuttons),
    // not just strings — coerce so downstream string ops (.slice) never throw.
    ...(n.name?.value != null && n.name.value !== '' ? { name: String(n.name.value) } : {}),
    ...(n.value?.value != null && n.value.value !== '' ? { value: String(n.value.value) } : {}),
    ...(typeof n.backendDOMNodeId === 'number' ? { backendDOMNodeId: n.backendDOMNodeId } : {}),
    children: built,
  };
}

export function assignIndices(root: SimplifiedNode): { byIndex: Map<number, number>; total: number } {
  const byIndex = new Map<number, number>();
  let i = 1;
  const visit = (n: SimplifiedNode) => {
    if (INTERACTIVE_ROLES.has(n.role) && typeof n.backendDOMNodeId === 'number') {
      n.index = i;
      byIndex.set(i, n.backendDOMNodeId);
      i += 1;
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
  return { byIndex, total: i - 1 };
}

export function serializeTree(root: SimplifiedNode): string {
  const lines: string[] = [];
  const visit = (n: SimplifiedNode, depth: number) => {
    const tag = n.index !== undefined ? `[${n.index}]` : '   ';
    const name = n.name ? ` "${escape(n.name)}"` : '';
    const value = n.value ? ` =${JSON.stringify(String(n.value).slice(0, 80))}` : '';
    lines.push(`${'  '.repeat(depth)}${tag} ${n.role}${name}${value}`);
    for (const c of n.children) visit(c, depth + 1);
  };
  visit(root, 0);
  return lines.join('\n');
}

function escape(s: string): string {
  return s.replace(/"/g, '\\"').slice(0, 120);
}

export interface CapResult {
  text: string;
  truncated: boolean;
  removed: number;
}

// ARIA landmark roles that are page chrome, not primary content. Trimmed first
// when over budget so product/article content (in main) survives. Universal —
// these are standard accessibility landmarks, not site-specific.
const NOISE_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary']);

// Form inputs are interactive things the agent must be able to find and use — the
// site search box and any form fields. These survive landmark trimming even when
// they live in the header/banner (where Amazon's search box is), so "type in the
// search box" and form-filling work.
const FORM_ROLES = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'listbox',
  'menuitemcheckbox',
  'menuitemradio',
]);

export function capTree(root: SimplifiedNode, maxChars: number): CapResult {
  let text = serializeTree(root);
  if (text.length <= maxChars) return { text, truncated: false, removed: 0 };

  // Step 1: collapse chrome landmark subtrees (nav, banner/header, footer, sidebars).
  let cur = trimNoiseLandmarks(root);
  text = serializeTree(cur);
  if (text.length <= maxChars) {
    return { text: `${text}\n[truncated — trimmed nav/header/footer/sidebars]`, truncated: true, removed: 1 };
  }

  // Step 2: drop uninformative empty structure (unnamed list/group leaves), keeping
  // any node that carries a name, value, or interactive index (titles, prices, links).
  for (let pass = 0; pass < 8; pass++) {
    const next = pruneUninformativeLeaves(cur);
    if (serializeTree(next).length === text.length) break; // converged
    cur = next;
    text = serializeTree(cur);
    if (text.length <= maxChars) {
      return { text: `${text}\n[truncated — dropped empty structure]`, truncated: true, removed: 2 };
    }
  }

  // Step 3: still over budget — keep the TOP of the document and cut the tail at
  // a line boundary. Main content and product results come first; filter sidebars
  // and footer come last. This preserves product titles/prices, which uniform
  // leaf-pruning would destroy.
  return { text: keepTopLines(text, maxChars), truncated: true, removed: 3 };
}

function keepTopLines(text: string, maxChars: number): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > maxChars) break;
    out.push(line);
    len += line.length + 1;
  }
  return `${out.join('\n')}\n[truncated — kept top of page]`;
}

// Keep only the form-input nodes (and the path down to them); drop everything else.
// Returns null when the subtree has no form inputs.
function keepFormInputs(n: SimplifiedNode): SimplifiedNode | null {
  if (FORM_ROLES.has(n.role)) return n;
  const kept = n.children
    .map(keepFormInputs)
    .filter((c): c is SimplifiedNode => c !== null);
  return kept.length ? { ...n, children: kept } : null;
}

function trimNoiseLandmarks(n: SimplifiedNode): SimplifiedNode {
  if (NOISE_ROLES.has(n.role)) {
    // Collapse chrome, but keep any form inputs inside it (the site search box
    // lives in the header/banner) — needed to type/submit and fill forms.
    return keepFormInputs(n) ?? { ...n, children: [] };
  }
  if (!n.children.length) return n;
  return { ...n, children: n.children.map(trimNoiseLandmarks) };
}

function isInformative(n: SimplifiedNode): boolean {
  return n.children.length > 0 || !!n.name || !!n.value || n.index !== undefined;
}

function pruneUninformativeLeaves(n: SimplifiedNode): SimplifiedNode {
  if (!n.children.length) return n;
  const kept = n.children.map(pruneUninformativeLeaves).filter(isInformative);
  return { ...n, children: kept };
}
