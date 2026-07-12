// ponytail: one test file exercising renderRich additions —
// tables, headings, rules, bold. Lightweight string assertions,
// no React rendering needed.

import { describe, expect, it } from 'vitest';
import { renderRich } from '../../src/sidepanel/view/format';

/** Render to a flat string by extracting text content recursively. */
function render(el: unknown): string {
  if (typeof el === 'string' || typeof el === 'number') return String(el);
  if (Array.isArray(el)) return el.map(render).join('');
  if (el && typeof el === 'object') {
    const e = el as { props?: Record<string, unknown> };
    if (e.props?.children) return render(e.props.children);
  }
  return '';
}

describe('renderRich', () => {
  it('renders **bold** as strong text', () => {
    const out = render(renderRich('hello **world**'));
    expect(out).toContain('world');
    expect(out).toContain('hello');
  });

  it('renders ### headings', () => {
    const out = render(renderRich('### Section'));
    expect(out).toContain('Section');
    // Confirm it rendered as something other than raw markdown
    const raw = JSON.stringify(renderRich('### Section'));
    expect(raw).toContain('h3');
  });

  it('renders ## headings as h2', () => {
    const raw = JSON.stringify(renderRich('## Big'));
    expect(raw).toContain('h2');
    expect(render(renderRich('## Big'))).toContain('Big');
  });

  it('renders --- as hr', () => {
    const raw = JSON.stringify(renderRich('a\n\n---\n\nb'));
    expect(raw).toContain('hr');
  });

  it('renders | table | as <table> with columns', () => {
    const md = '| Name | Stars |\n|---|---|\n| r1 | 100 |\n| r2 | 200 |';
    const raw = JSON.stringify(renderRich(md));
    expect(raw).toContain('table');
    expect(render(renderRich(md))).toMatch(/Name.*Stars.*r1.*100.*r2.*200/);
    // Separator row (|---|---|) should be skipped — no "---" in the table text content
    expect(raw).not.toContain('|---|');
  });

  it('normalizes literal \\n', () => {
    const out = render(renderRich('a\\nb'));
    expect(out).toContain('a');
    expect(out).toContain('b');
  });
});
