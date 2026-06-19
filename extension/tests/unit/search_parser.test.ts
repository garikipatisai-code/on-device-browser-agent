import { describe, expect, it } from 'vitest';
import { isAdUrl, parseDuckDuckGoResults } from '@/agent/tools/browser/search';
import { openUrlAllowed, urlIsFromResults } from '@/agent/tools/browser/tab';

const SAMPLE_HTML = `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1">First <b>result</b></a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1">First <b>snippet</b> here</a>
</div>
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.org%2Fguide">Second &amp; final</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.org%2Fguide">A different snippet</a>
</div>
`;

describe('parseDuckDuckGoResults', () => {
  it('extracts title, decoded url, and snippet', () => {
    const r = parseDuckDuckGoResults(SAMPLE_HTML, 10);
    expect(r).toHaveLength(2);
    expect(r[0].title).toBe('First result');
    expect(r[0].url).toBe('https://example.com/page1');
    expect(r[0].snippet).toBe('First snippet here');
    expect(r[1].title).toBe('Second & final');
    expect(r[1].url).toBe('https://docs.example.org/guide');
  });

  it('respects max limit', () => {
    const r = parseDuckDuckGoResults(SAMPLE_HTML, 1);
    expect(r).toHaveLength(1);
  });

  it('returns empty array on garbage', () => {
    expect(parseDuckDuckGoResults('<html>no results</html>', 5)).toEqual([]);
    expect(parseDuckDuckGoResults('', 5)).toEqual([]);
  });

  it('strips <b> tags', () => {
    const r = parseDuckDuckGoResults(SAMPLE_HTML);
    expect(r[0].title).not.toContain('<b>');
    expect(r[0].snippet).not.toContain('<b>');
  });

  it('does not leak regex lastIndex across calls (each search starts fresh)', () => {
    const a = parseDuckDuckGoResults(SAMPLE_HTML, 1);
    const b = parseDuckDuckGoResults(SAMPLE_HTML, 1);
    expect(b).toEqual(a);
    expect(b[0].title).toBe('First result');
  });

  it('pairs snippets by link position, so a dropped (empty-title) link does not shift them', () => {
    const html = `
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com"></a>
<a class="result__snippet" href="x">SNIPPET-FOR-DROPPED</a>
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.com">Real Two</a>
<a class="result__snippet" href="x">SNIPPET-FOR-REAL-TWO</a>`;
    const r = parseDuckDuckGoResults(html, 10);
    const two = r.find((x) => x.title === 'Real Two');
    expect(two?.snippet).toBe('SNIPPET-FOR-REAL-TWO');
  });
});

describe('isAdUrl', () => {
  it('flags DuckDuckGo/Bing sponsored redirector URLs', () => {
    expect(isAdUrl('https://duckduckgo.com/y.js?ad_domain=amazon.com&ad_provider=bingv7aa')).toBe(true);
    expect(isAdUrl('https://www.bing.com/aclick?ld=abc')).toBe(true);
  });
  it('keeps genuine result URLs', () => {
    expect(isAdUrl('https://www.amazon.com/wireless-mouse/s?k=wireless+mouse')).toBe(false);
    expect(isAdUrl('https://www.pcmag.com/picks/the-best-wireless-mice')).toBe(false);
  });
});

describe('urlIsFromResults (anti-hallucination grounding)', () => {
  const results = [{ url: 'https://www.amazon.com/wireless-mouse/s?k=wireless+mouse' }];
  it('rejects a fabricated URL not in the results (the exact bug from the run)', () => {
    expect(
      urlIsFromResults(
        'https://www.amazon.com/wireless-mouse/zgbs/electronics/computer-peripherals/wireless-mice',
        results,
      ),
    ).toBe(false);
  });
  it('accepts a result URL copied verbatim, modulo a trailing slash', () => {
    expect(urlIsFromResults('https://www.amazon.com/wireless-mouse/s?k=wireless+mouse', results)).toBe(true);
    expect(urlIsFromResults('https://www.amazon.com/wireless-mouse/s?k=wireless+mouse/', results)).toBe(true);
  });
  it('returns false against an empty result set (tab.open then skips the grounding check)', () => {
    expect(urlIsFromResults('https://example.com', [])).toBe(false);
  });
});

describe('openUrlAllowed (tab.open grounding)', () => {
  const results = [{ url: 'https://www.amazon.com/wireless-mouse/s?k=wireless+mouse' }];
  it('allows anything when there are no results to ground against', () => {
    expect(openUrlAllowed('https://www.amazon.com', [])).toBe(true);
  });
  it('allows a bare homepage URL even with results present ("go to amazon.com")', () => {
    expect(openUrlAllowed('https://www.amazon.com', results)).toBe(true);
    expect(openUrlAllowed('https://www.amazon.com/', results)).toBe(true);
  });
  it('blocks a fabricated deep path not in the results', () => {
    expect(openUrlAllowed('https://www.amazon.com/wireless-mouse/zgbs/electronics', results)).toBe(false);
  });
  it('allows an exact result URL', () => {
    expect(openUrlAllowed('https://www.amazon.com/wireless-mouse/s?k=wireless+mouse', results)).toBe(true);
  });
});
