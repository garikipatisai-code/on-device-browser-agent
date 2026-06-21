import { describe, it, expect, beforeEach } from 'vitest';
import { persistTimeline, loadTimeline, clearPersistedTimeline } from '@/background/timeline_store';
import type { TimelineEvent } from '@/shared/messages';

const log = (message: string): TimelineEvent => ({ kind: 'log', ts: 1, level: 'info', message });

describe('timeline_store — survives the MV3 service-worker kill', () => {
  beforeEach(() => clearPersistedTimeline());

  it('round-trips the timeline through chrome.storage.session', async () => {
    expect(await loadTimeline()).toEqual([]); // nothing persisted yet
    persistTimeline([log('planner started'), log('finished')]);
    const restored = await loadTimeline();
    expect(restored.map((e) => (e.kind === 'log' ? e.message : ''))).toEqual(['planner started', 'finished']);
  });

  it('the latest persist wins (mirrors the live array, not an append log)', async () => {
    persistTimeline([log('a')]);
    persistTimeline([log('a'), log('b'), log('c')]);
    expect((await loadTimeline()).length).toBe(3);
  });

  it('clear empties it (so a fresh run does not resurrect the prior trace)', async () => {
    persistTimeline([log('old run')]);
    clearPersistedTimeline();
    expect(await loadTimeline()).toEqual([]);
  });
});
