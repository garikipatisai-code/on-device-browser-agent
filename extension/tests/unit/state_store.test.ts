import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _setHot,
  appendEvent,
  appendTurnToSession,
  clearHot,
  createSession,
  deleteSession,
  getScratchpad,
  listSessions,
  loadEvents,
  loadHot,
  loadSessionContext,
  loadSettings,
  memoryGet,
  memoryList,
  memorySet,
  patchHot,
  saveSessionContext,
  saveSettings,
  setDomainTier,
  setScratchpad,
  toStatus,
  touchHot,
  updateSessionTurnResult,
  _testing,
} from '@/background/state_store';
import { resetStorage } from '../helpers';

beforeEach(async () => {
  await resetStorage();
});
afterEach(async () => {
  await clearHot();
});

describe('hot state', () => {
  it('_setHot writes the goal', async () => {
    const hot = await _setHot('do the thing');
    expect(hot.goal).toBe('do the thing');
    expect(hot.phase).toBe('IDLE');
  });

  it('patchHot rejects goal mutation', async () => {
    await _setHot('original');
    await expect(patchHot({ goal: 'hijacked' } as unknown as { phase: 'IDLE' })).rejects.toThrow(/immutable/);
  });

  it('patchHot updates phase', async () => {
    await _setHot('g');
    const hot = await patchHot({ phase: 'PLANNING' });
    expect(hot.phase).toBe('PLANNING');
    expect(hot.goal).toBe('g');
  });

  it('clearHot drains the mutex before erasing', async () => {
    await _setHot('a');
    const writeP = patchHot({ phase: 'PLANNING' });
    const clearP = clearHot();
    await Promise.all([writeP, clearP]);
    const hot = await loadHot();
    expect(hot).toBeNull();
  });

  it('touchHot updates lastTouch', async () => {
    const t0 = await _setHot('g');
    await new Promise((r) => setTimeout(r, 5));
    await touchHot();
    const t1 = await loadHot();
    expect(t1!.lastTouch).toBeGreaterThanOrEqual(t0.lastTouch);
  });
});

describe('toStatus', () => {
  it('produces IDLE for null hot', () => {
    expect(toStatus(null).phase).toBe('IDLE');
    expect(toStatus(null).goal).toBeNull();
  });
});

describe('settings', () => {
  it('loadSettings returns defaults when none stored', async () => {
    const s = await loadSettings();
    expect(s.ollamaBaseUrl).toMatch(/^http/);
    expect(s.executorModel).toBeTruthy();
  });

  it('saveSettings merges with defaults', async () => {
    const next = await saveSettings({ executorModel: 'override:1b' });
    expect(next.executorModel).toBe('override:1b');
    expect(next.plannerModel).toBeTruthy();
  });

  it('setDomainTier upserts a host', async () => {
    const next = await setDomainTier('amazon.com', 'click-only');
    expect(next.domainTiers['amazon.com']).toBe('click-only');
  });

  it('serializes concurrent settings writes without losing updates', async () => {
    // Each write is a read-modify-write of chrome.storage; run concurrently they all read the
    // same base before any writes back → last-writer-wins drops the others unless serialized.
    await Promise.all([
      setDomainTier('a.com', 'click-only'),
      setDomainTier('b.com', 'read-only'),
      saveSettings({ executorModel: 'concurrent:9b' }),
    ]);
    const s = await loadSettings();
    expect(s.domainTiers['a.com']).toBe('click-only');
    expect(s.domainTiers['b.com']).toBe('read-only');
    expect(s.executorModel).toBe('concurrent:9b');
  });
});

describe('scratchpad + memory + events', () => {
  it('scratchpad round-trips', async () => {
    await setScratchpad('t1', 'hello scratch');
    expect(await getScratchpad('t1')).toBe('hello scratch');
  });
  it('memory get/set/list', async () => {
    await memorySet('k1', 'v1');
    await memorySet('k2', { a: 1 });
    expect(await memoryGet('k1')).toBe('v1');
    expect((await memoryList()).sort()).toEqual(['k1', 'k2']);
  });
  it('event log accepts appends', async () => {
    await appendEvent('t1', { kind: 'log', ts: 1, level: 'info', message: 'hi' });
    const all = await loadEvents('t1');
    expect(all.length).toBe(1);
    expect(all[0].kind).toBe('log');
  });
});

describe('sessions', () => {
  it('creates, lists, and deletes a session', async () => {
    const s1 = await createSession();
    const s2 = await createSession();
    const listed = await listSessions();
    expect(listed.map((s) => s.id).sort()).toEqual([s1.id, s2.id].sort());
    expect(s1.title).toBe('');
    expect(s1.turns).toEqual([]);

    await deleteSession(s1.id);
    const afterDelete = await listSessions();
    expect(afterDelete.map((s) => s.id)).toEqual([s2.id]);
  });

  it('lists sessions sorted by lastActiveAt descending', async () => {
    const older = await createSession();
    await appendTurnToSession(older.id, 'task-a');
    const newer = await createSession();
    await appendTurnToSession(newer.id, 'task-b');
    // touch `older` again so it becomes the most recently active
    await appendTurnToSession(older.id, 'task-c');
    const listed = await listSessions();
    expect(listed[0].id).toBe(older.id);
    expect(listed[1].id).toBe(newer.id);
  });

  it('appendTurnToSession appends a {taskId, goal} turn and sets the title from the first turn only', async () => {
    const s = await createSession();
    await appendTurnToSession(s.id, 'task-1', 'find the population of Austin');
    await appendTurnToSession(s.id, 'task-2', 'now do Seattle too');
    const listed = await listSessions();
    const found = listed.find((x) => x.id === s.id)!;
    expect(found.turns).toEqual([
      { taskId: 'task-1', goal: 'find the population of Austin' },
      { taskId: 'task-2', goal: 'now do Seattle too' },
    ]);
    expect(found.title).toBe('find the population of Austin');
  });

  it('truncates a long goal to build the title', async () => {
    const s = await createSession();
    const longGoal = 'x'.repeat(200);
    await appendTurnToSession(s.id, 'task-1', longGoal);
    const listed = await listSessions();
    expect(listed[0].title.length).toBeLessThanOrEqual(80);
  });

  it('updateSessionTurnResult patches the matching turn by taskId', async () => {
    const s = await createSession();
    await appendTurnToSession(s.id, 'task-1', 'goal one');
    await appendTurnToSession(s.id, 'task-2', 'goal two');
    await updateSessionTurnResult(s.id, 'task-1', 'success', 'first answer');
    const listed = await listSessions();
    const found = listed.find((x) => x.id === s.id)!;
    expect(found.turns).toEqual([
      { taskId: 'task-1', goal: 'goal one', verdict: 'success', summary: 'first answer' },
      { taskId: 'task-2', goal: 'goal two' },
    ]);
  });

  it('updateSessionTurnResult caps the summary at 500 chars and redacts PII', async () => {
    const s = await createSession();
    await appendTurnToSession(s.id, 'task-1', 'goal one');
    const long = 'y'.repeat(1000);
    await updateSessionTurnResult(s.id, 'task-1', 'success', long);
    const listed = await listSessions();
    expect(listed[0].turns[0].summary!.length).toBe(500);

    await updateSessionTurnResult(s.id, 'task-1', 'success', 'reach jane.doe@example.com for details');
    const relisted = await listSessions();
    expect(relisted[0].turns[0].summary).toContain('[REDACTED: EMAIL]');
    expect(relisted[0].turns[0].summary).not.toContain('jane.doe@example.com');
  });

  it('redacts PII that straddles the 500-char cap, not just PII well within it', async () => {
    const s = await createSession();
    await appendTurnToSession(s.id, 'task-1', 'goal one');
    const straddling = 'x'.repeat(490) + 'jane.doe@example.com'; // email starts at index 490, past the cap
    await updateSessionTurnResult(s.id, 'task-1', 'success', straddling);
    const listed = await listSessions();
    expect(listed[0].turns[0].summary).not.toMatch(/jane\.doe|@example\.com/); // no raw fragment leaked
  });

  it('updateSessionTurnResult is a no-op when the session or turn does not exist', async () => {
    await expect(updateSessionTurnResult('missing-session', 'task-1', 'success', 'x')).resolves.toBeUndefined();
    const s = await createSession();
    await expect(updateSessionTurnResult(s.id, 'missing-task', 'success', 'x')).resolves.toBeUndefined();
    expect((await listSessions())[0].turns).toEqual([]);
  });

  it('redacts PII in the goal before persisting it into turns and title', async () => {
    const s = await createSession();
    await appendTurnToSession(s.id, 'task-1', 'email my resume to jane.doe@example.com');
    const listed = await listSessions();
    const found = listed.find((x) => x.id === s.id)!;
    expect(found.turns[0].goal).toContain('[REDACTED: EMAIL]');
    expect(found.turns[0].goal).not.toContain('jane.doe@example.com');
    expect(found.title).toContain('[REDACTED: EMAIL]');
    expect(found.title).not.toContain('jane.doe@example.com');
  });
});

describe('sessionContext', () => {
  it('a session with no saved context loads as empty facts + empty summary', async () => {
    const s = await createSession();
    const ctx = await loadSessionContext(s.id);
    expect(ctx).toEqual({ sessionId: s.id, facts: [], lastSummary: '', updatedAt: 0 });
  });

  it('round-trips facts and a summary', async () => {
    const s = await createSession();
    const facts = [{ step: 'step-1', text: 'Austin population: 961,855' }];
    await saveSessionContext(s.id, facts, 'success: Austin has 961,855 residents');
    const ctx = await loadSessionContext(s.id);
    expect(ctx.facts).toEqual(facts);
    expect(ctx.lastSummary).toBe('success: Austin has 961,855 residents');
    expect(ctx.updatedAt).toBeGreaterThan(0);
  });

  it('caps lastSummary at 500 chars', async () => {
    const s = await createSession();
    const long = 'y'.repeat(1000);
    await saveSessionContext(s.id, [], long);
    const ctx = await loadSessionContext(s.id);
    expect(ctx.lastSummary.length).toBe(500);
  });

  it('redacts PII in facts and the summary before persisting — sessionContext is durable across turns, not scoped to one run', async () => {
    const s = await createSession();
    const facts = [{ step: 'step-1', text: 'Contact: jane.doe@example.com' }];
    await saveSessionContext(s.id, facts, 'success: reach them at jane.doe@example.com');
    const ctx = await loadSessionContext(s.id);
    expect(ctx.facts[0].text).toContain('[REDACTED: EMAIL]');
    expect(ctx.facts[0].text).not.toContain('jane.doe@example.com');
    expect(ctx.lastSummary).toContain('[REDACTED: EMAIL]');
    expect(ctx.lastSummary).not.toContain('jane.doe@example.com');
  });

  it('redacts PII that straddles the 500-char cap, not just PII well within it', async () => {
    const s = await createSession();
    const straddling = 'x'.repeat(490) + 'jane.doe@example.com'; // email starts at index 490, past the cap
    await saveSessionContext(s.id, [], straddling);
    const ctx = await loadSessionContext(s.id);
    expect(ctx.lastSummary).not.toMatch(/jane\.doe|@example\.com/); // no raw fragment leaked
  });
});

describe('mutex serialization', () => {
  it('serializes concurrent writes', async () => {
    await _setHot('g');
    const promises = Array.from({ length: 5 }, (_, i) => patchHot({ replanCount: i }));
    const results = await Promise.all(promises);
    expect(results.every((r) => typeof r.replanCount === 'number')).toBe(true);
    expect(_testing._hotMutex).toBeDefined();
  });
});
