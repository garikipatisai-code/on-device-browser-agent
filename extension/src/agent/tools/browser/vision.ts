// vision.read — read a page VISUALLY by screenshot, for when aria.extract is blind.
// Captures the tab and feeds the image to a multimodal model (gemma4:e4b) which
// transcribes what it sees. Fallback channel, not the primary one.

import { z } from 'zod';
import type { ToolDefDescriptor } from '../registry';
import { NUM_CTX } from '@/agent/budget';
import { sleep } from '@/background/signal';
import { withCdp } from './lifecycle';

/** Strip the `data:image/png;base64,` prefix → raw base64 (what Ollama wants). */
export function stripDataUri(uri: string): string {
  if (!uri.startsWith('data:')) return uri;
  const comma = uri.indexOf(',');
  return comma >= 0 ? uri.slice(comma + 1) : uri;
}

async function captureTabPng(tabId: number): Promise<string> {
  // Capture via CDP — the debugger is already used for reads/clicks. Unlike
  // chrome.tabs.captureVisibleTab, Page.captureScreenshot grabs the TARGET tab
  // without making it the active/foreground tab: no focus steal, and it works on
  // a background tab. Returns raw base64 PNG (no data: prefix).
  await sleep(300); // brief settle so a freshly-navigated page has painted
  return withCdp(tabId, async (send) => {
    await send('Page.enable').catch(() => undefined);
    const res = await send<{ data?: string }>('Page.captureScreenshot', { format: 'png' });
    return res.data ?? '';
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
    let b64: string;
    try {
      b64 = stripDataUri(await captureTabPng(tabId));
    } catch (err) {
      return {
        ok: false,
        content: `vision.read: screenshot capture failed (${(err as Error).message}) — use aria.extract instead.`,
        data: { error: (err as Error).message },
      };
    }
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
