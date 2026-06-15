import { describe, expect, it } from 'vitest';
import { INJECT_FN, LOCATE_FN, buildInjectParams, buildLocateExpression } from '@/agent/tools/browser/upload';

describe('buildLocateExpression', () => {
  it('JSON-escapes the label into an immediately-invoked locator call', () => {
    expect(buildLocateExpression('resume')).toBe(`(${LOCATE_FN})("resume")`);
  });
  it('defaults to an empty-string argument and escapes quotes', () => {
    expect(buildLocateExpression()).toBe(`(${LOCATE_FN})("")`);
    expect(buildLocateExpression('a"b')).toContain('"a\\"b"');
  });
});

describe('buildInjectParams', () => {
  it('passes the bytes as a call ARGUMENT, not inlined into the source', () => {
    const p = buildInjectParams('obj-1', { base64: 'QUJD', name: 'r.pdf', mime: 'application/pdf' });
    expect(p.functionDeclaration).toBe(INJECT_FN);
    expect(p.functionDeclaration).not.toContain('QUJD');
    expect(p.arguments).toEqual([{ value: 'QUJD' }, { value: 'r.pdf' }, { value: 'application/pdf' }]);
    expect(p.returnByValue).toBe(true);
    expect(p.objectId).toBe('obj-1');
  });
});

describe('the in-page function strings', () => {
  it('LOCATE_FN targets file inputs and prefers résumé/cv', () => {
    expect(LOCATE_FN).toContain("querySelectorAll('input[type=file]')");
    expect(LOCATE_FN).toContain('resume');
    expect(LOCATE_FN).toContain('cv');
  });
  it('INJECT_FN sets files via DataTransfer and fires input + change (bubbling, composed)', () => {
    expect(INJECT_FN).toContain('DataTransfer');
    expect(INJECT_FN).toContain('this.files=dt.files');
    expect(INJECT_FN).toContain("dispatchEvent(new Event('input'");
    expect(INJECT_FN).toContain("dispatchEvent(new Event('change'");
    expect(INJECT_FN).toContain('composed:true');
  });
});
