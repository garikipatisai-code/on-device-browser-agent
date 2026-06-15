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

describe('LOCATE_FN (functional, in happy-dom)', () => {
  // Materialize the in-page locator string and run it against a real DOM so the
  // selection heuristic the live upload depends on is actually exercised.
  const locate = new Function('return ' + LOCATE_FN)() as (label: string) => Element | null;

  it('returns null when the page has no file input', () => {
    document.body.innerHTML = '<div>no inputs here</div>';
    expect(locate('')).toBeNull();
  });

  it('prefers the input whose label/name/aria matches labelContains', () => {
    document.body.innerHTML =
      '<input type="file" name="resume_field" id="a">' +
      '<input type="file" aria-label="Cover letter" id="b">';
    expect((locate('cover') as HTMLElement).id).toBe('b');
  });

  it('falls back to the résumé/cv input when no label hint is given', () => {
    document.body.innerHTML =
      '<input type="file" name="portfolio" id="a">' +
      '<label for="b">Upload CV</label><input type="file" id="b">';
    expect((locate('') as HTMLElement).id).toBe('b');
  });

  it('falls back to the first file input when nothing matches', () => {
    document.body.innerHTML =
      '<input type="file" name="doc1" id="a"><input type="file" name="doc2" id="b">';
    expect((locate('') as HTMLElement).id).toBe('a');
  });
});
