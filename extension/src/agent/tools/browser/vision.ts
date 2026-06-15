// vision.read — read a page VISUALLY by screenshot, for when aria.extract is blind.
// Captures the tab and feeds the image to a multimodal model (gemma4:e4b) which
// transcribes what it sees. Fallback channel, not the primary one.

import { z } from 'zod';
import type { ToolDefDescriptor } from '../registry';
import { NUM_CTX } from '@/agent/budget';
import { sleep } from '@/background/signal';

/** Strip the `data:image/png;base64,` prefix → raw base64 (what Ollama wants). */
export function stripDataUri(uri: string): string {
  if (!uri.startsWith('data:')) return uri;
  const comma = uri.indexOf(',');
  return comma >= 0 ? uri.slice(comma + 1) : uri;
}

async function captureTabPng(tabId: number): Promise<string> {
  // captureVisibleTab grabs the active tab of its window, so activate first.
  await new Promise<void>((resolve) => chrome.tabs.update(tabId, { active: true }, () => resolve()));
  const tab = await new Promise<chrome.tabs.Tab>((resolve) => chrome.tabs.get(tabId, (t) => resolve(t)));
  // A just-activated / freshly-navigated tab can capture blank before it paints.
  await sleep(500);
  return new Promise<string>((resolve, reject) => {
    chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (uri) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(uri ?? '');
    });
  });
}

const DEFAULT_QUESTION =
  'Read this web page screenshot. Transcribe it literally and thoroughly: all visible headings, text, links, buttons, form fields, and any products with their names, prices, and ratings. Do not summarize — list what you actually see.';

export const visionReadTool: ToolDefDescriptor<{ tabId: number; question?: string }> = {
  name: 'vision.read',
  description:
    'Read a page VISUALLY via screenshot, using the multimodal model. Use this as a fallback when aria.extract returns little or no content (an empty/near-root ARIA tree). Returns a text transcription of what is on screen.',
  argsSchema: z.object({
    tabId: z.number().int(),
    question: z
      .string()
      .optional()
      .describe('What to look for on the page. Defaults to a full literal transcription.'),
  }),
  async dispatch({ tabId, question }, ctx) {
    const dataUri = await captureTabPng(tabId);
    const b64 = stripDataUri(dataUri);
    console.log(`[BA] vision.read: captured ${b64.length} base64 chars for tab ${tabId}`);
    // A near-empty capture means the tab wasn't the visible/painted foreground tab.
    // Calling the model with no real image yields "you have not provided me with an
    // image" — so fail clearly here and let the executor fall back to aria.extract.
    if (b64.length < 100) {
      return {
        ok: false,
        content: `vision.read: screenshot was empty (${b64.length} bytes) — the tab may not be the visible foreground tab. Use aria.extract instead.`,
        data: { capturedBytes: b64.length },
      };
    }
    const resp = await ctx.ollama.chatOnce({
      model: ctx.settings.visionModel,
      messages: [{ role: 'user', content: question ?? DEFAULT_QUESTION, images: [b64] }],
      thinking: false,
      numCtx: NUM_CTX,
      timeoutMs: 120_000,
      signal: ctx.signal,
    });
    const text = (resp.message.content ?? '').trim();
    if (!text) {
      return {
        ok: false,
        content: `vision.read: model "${ctx.settings.visionModel}" returned no text (is it a multimodal model?).`,
      };
    }
    return {
      ok: true,
      content: text,
      data: { chars: text.length, model: ctx.settings.visionModel },
    };
  },
};
