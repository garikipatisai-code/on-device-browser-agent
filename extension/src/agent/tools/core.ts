// Core tools (Phase 1 from blueprint §05).
import { z } from 'zod';
import type { ToolDefDescriptor } from './registry';
import { memoryGet, memoryList, memorySet } from '@/background/state_store';

export const echoTool: ToolDefDescriptor<{ message: string }> = {
  name: 'echo',
  description: 'Echo a message. Sanity check.',
  argsSchema: z.object({ message: z.string() }),
  async dispatch({ message }) {
    return { ok: true, content: message };
  },
};

export const nextStepTool: ToolDefDescriptor<{ reason: string }> = {
  name: 'next_step',
  description:
    'Mark the current plan step done and advance to the next. For INTERMEDIATE steps only. If the GOAL is fully satisfied, call finish (with the answer) instead — do not advance past a completed goal.',
  argsSchema: z.object({
    reason: z.string().describe('Short evidence that the current step is complete.'),
  }),
  async dispatch({ reason }) {
    return { ok: true, content: `Advancing: ${reason}`, advanceStep: true };
  },
};

export const finishTool: ToolDefDescriptor<{ verdict: string; summary: string }> = {
  name: 'finish',
  description:
    'End the task. The summary is shown to the user AS THE ANSWER — put the actual requested data in it (e.g. a numbered list of products with names and prices), never a meta-description like "the results were extracted". Use when the goal is achieved, impossible, or hard-blocked.',
  argsSchema: z.object({
    verdict: z.enum(['success', 'partial', 'blocked', 'failed']).describe('Outcome category.'),
    summary: z
      .string()
      .describe(
        'The user-facing ANSWER. Include the actual requested values formatted as asked, e.g. "1. Logitech M185 — $13.42\\n2. Logitech M510 — $27.99\\n3. ...". Not "the data was extracted".',
      ),
  }),
  async dispatch({ verdict, summary }) {
    return { ok: true, content: `${verdict}: ${summary}`, finish: { verdict, summary } };
  },
};

export const memoryReadTool: ToolDefDescriptor<{ key: string }> = {
  name: 'memory.read',
  description: 'Read a key from long-term memory (cross-task).',
  argsSchema: z.object({ key: z.string() }),
  async dispatch({ key }) {
    const v = await memoryGet(key);
    if (v === undefined) return { ok: false, content: `No memory for key: ${key}` };
    return { ok: true, content: typeof v === 'string' ? v : JSON.stringify(v), data: { value: v } };
  },
};

export const memoryWriteTool: ToolDefDescriptor<{ key: string; value: string }> = {
  name: 'memory.write',
  description: 'Write a key to long-term memory (cross-task). Use sparingly — for durable knowledge only.',
  argsSchema: z.object({ key: z.string(), value: z.string() }),
  async dispatch({ key, value }) {
    await memorySet(key, value);
    return { ok: true, content: `Stored ${key}` };
  },
};

export const memoryListTool: ToolDefDescriptor<Record<string, never>> = {
  name: 'memory.list',
  description: 'List all keys in long-term memory.',
  argsSchema: z.object({}),
  async dispatch() {
    const keys = await memoryList();
    return { ok: true, content: keys.join('\n') || '(empty)', data: { keys } };
  },
};
