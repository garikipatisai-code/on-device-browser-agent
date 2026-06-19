import { beforeEach, describe, expect, it } from 'vitest';
import { memoryListTool, memoryReadTool, memoryWriteTool } from '@/agent/tools/core';
import { memorySet } from '@/background/state_store';
import { resetStorage } from '../helpers';
import type { ToolContext } from '@/agent/tools/registry';

const ctx = {} as ToolContext;

beforeEach(async () => {
  await resetStorage();
});

describe('memory tools — reserved awm: namespace', () => {
  it('rejects writes to the reserved awm: namespace (cannot clobber workflow memory)', async () => {
    const res = await memoryWriteTool.dispatch({ key: 'awm:workflows', value: 'pwned' }, ctx);
    expect(res.ok).toBe(false);
  });

  it('rejects reads of reserved keys (cannot exfiltrate workflow memory)', async () => {
    const res = await memoryReadTool.dispatch({ key: 'awm:workflows' }, ctx);
    expect(res.ok).toBe(false);
  });

  it('memory.list hides reserved keys but shows user keys', async () => {
    await memorySet('awm:workflows', []);
    await memorySet('user-note', 'hi');
    const res = await memoryListTool.dispatch({}, ctx);
    expect(res.content).toContain('user-note');
    expect(res.content).not.toContain('awm:');
  });
});
