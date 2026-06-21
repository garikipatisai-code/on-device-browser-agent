import { describe, it, expect, beforeEach } from 'vitest';
import { openResultTool } from '@/agent/tools/browser/tab';
import { getLastSearchResults, clearSearchResults } from '@/agent/tools/browser/search';
import type { ToolContext } from '@/agent/tools/registry';
import { _setHot } from '@/background/state_store';
import { resetStorage } from '../helpers';

// Live bug: the model repeatedly called open_result {"index":0} (a 0-based "first result"); the
// schema rejected it ("Number must be greater than 0") and the whole turn was wasted — three times
// in one run. open_result must treat 0 as the first result instead of erroring.
describe('open_result — tolerates a 0-based index for "the first result"', () => {
  beforeEach(async () => {
    await resetStorage();
    await _setHot('open-result test');
    clearSearchResults();
    getLastSearchResults().push(
      { title: 'First', url: 'https://example.com/first', snippet: '' },
      { title: 'Second', url: 'https://example.com/second', snippet: '' },
    );
  });

  it('accepts index 0 in the schema (was rejected as "must be greater than 0")', () => {
    expect(openResultTool.argsSchema.safeParse({ index: 0 }).success).toBe(true);
    expect(openResultTool.argsSchema.safeParse({ index: 1 }).success).toBe(true);
    expect(openResultTool.argsSchema.safeParse({ index: -1 }).success).toBe(false);
  });

  it('maps index 0 to the FIRST result instead of erroring', async () => {
    const ctx = { hot: { ownedTabs: [] } } as unknown as ToolContext;
    const res = await openResultTool.dispatch({ index: 0 }, ctx);
    expect(res.ok).toBe(true);
    expect((res.data as { url: string }).url).toBe('https://example.com/first');
  });

  it('still opens by 1-based number for index >= 1', async () => {
    const ctx = { hot: { ownedTabs: [] } } as unknown as ToolContext;
    const res = await openResultTool.dispatch({ index: 2 }, ctx);
    expect((res.data as { url: string }).url).toBe('https://example.com/second');
  });
});
