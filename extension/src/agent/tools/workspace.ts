// Workspace — episodic memory for multi-page tasks.
// Stores structured notes per page visit so the planner can reason across
// pages without re-reading raw HTML. Backed by chrome.storage.local.
//
// ponytail: flat JSON array in storage.local. Upgrade to IndexedDB or a
// knowledge graph if the workspace regularly exceeds ~100 entries.

import { z } from 'zod';
import type { ToolDefDescriptor, ToolContext } from './registry';

const STORAGE_KEY = 'agent.workspace';
const MAX_ENTRIES = 50;
const MAX_ENTRY_LENGTH = 3000;

interface WorkspaceEntry {
  title: string;
  content: string;
  url?: string;
  ts: number;
}

async function load(): Promise<WorkspaceEntry[]> {
  const { [STORAGE_KEY]: raw } = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(raw) ? raw as WorkspaceEntry[] : [];
}

async function save(entries: WorkspaceEntry[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: entries });
}

export const workspaceAddTool: ToolDefDescriptor<{ title: string; content: string; url?: string }> = {
  name: 'workspace.add',
  description:
    'Save a structured note about the current page to your workspace. Use this when you finish reading a page — summarize what you found (prices, names, facts, key data) so you can reference it across multiple pages without re-reading. The workspace persists across steps and can be listed anytime. Max 50 entries, 3000 chars each.',
  argsSchema: z.object({
    title: z.string().describe('Short label for this page/note (e.g. "Amazon product page — LG C5 OLED")'),
    content: z.string().describe('Structured summary of what you found on this page. Include specific values, prices, names, numbers.'),
    url: z.string().optional().describe('The page URL this note is about'),
  }),
  async dispatch({ title, content, url }) {
    const entries = await load();
    entries.push({ title, content: content.substring(0, MAX_ENTRY_LENGTH), url, ts: Date.now() });
    // Keep newest entries, drop oldest if over limit
    const trimmed = entries.slice(-MAX_ENTRIES);
    await save(trimmed);
    return { ok: true, content: `Saved to workspace: "${title}" (entry ${trimmed.length}/${MAX_ENTRIES})` };
  },
};

export const workspaceListTool: ToolDefDescriptor<Record<string, never>> = {
  name: 'workspace.list',
  description:
    'List everything you have saved in your workspace — structured notes from pages you have read this task. Each entry shows the title, URL, and a summary of what was found. Use this when you need to compare data across previously visited pages or recall what a page said before navigating away.',
  argsSchema: z.object({}),
  async dispatch() {
    const entries = await load();
    if (entries.length === 0) {
      return { ok: true, content: 'Workspace is empty. Use workspace.add after reading a page to save structured notes.' };
    }
    const lines = entries.map((e, i) => {
      const url = e.url ? ` (${e.url})` : '';
      return `[${i + 1}] ${e.title}${url}\n    ${e.content.substring(0, 500).replace(/\n/g, '\n    ')}`;
    });
    return { ok: true, content: `Workspace (${entries.length} entries):\n\n${lines.join('\n\n')}` };
  },
};

export const workspaceClearTool: ToolDefDescriptor<Record<string, never>> = {
  name: 'workspace.clear',
  description: 'Clear all workspace entries for a fresh start.',
  argsSchema: z.object({}),
  async dispatch() {
    await save([]);
    return { ok: true, content: 'Workspace cleared.' };
  },
};
