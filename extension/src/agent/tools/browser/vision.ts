// vision.read / vision.verify — multimodal page perception via screenshot.
// Primary usage: fallback when the ARIA tree is sparse (JS-heavy pages, SPAs, tables).
// vision.verify: quick visual confirmation after an action (did the click land?).

import { z } from 'zod';
import type { ToolDefDescriptor } from '../registry';
import { NUM_CTX } from '@/agent/budget';
import { sleep } from '@/background/signal';
import { withCdp } from './lifecycle';
import { clearExtractionCache } from './aria_tool';

/** Strip the `data:image/png;base64,` prefix → raw base64 (what Ollama wants). */
export function stripDataUri(uri: string): string {
  if (!uri.startsWith('data:')) return uri;
  const comma = uri.indexOf(',');
  return comma >= 0 ? uri.slice(comma + 1) : uri;
}

async function captureTabPng(tabId: number): Promise<string> {
  // Capture via CDP — Page.captureScreenshot grabs the TARGET tab without
  // making it the active/foreground tab: no focus steal, works on background tabs.
  await sleep(300); // brief settle so a freshly-navigated page has painted
  return withCdp(tabId, async (send) => {
    await send('Page.enable').catch(() => undefined);
    const res = await send<{ data?: string }>('Page.captureScreenshot', { format: 'png' });
    return res.data ?? '';
  });
}

const DEFAULT_TRANSCRIPTION =
  'Read this web page screenshot. Transcribe it literally and thoroughly: all visible headings, text, links, buttons, form fields, and any products with their names, prices, and ratings. Do not summarize — list what you actually see.';

export const visionReadTool: ToolDefDescriptor<{ tabId: number; question?: string }> = {
  name: 'vision.read',
  description:
    'Read a page VISUALLY via screenshot, using the multimodal model (gemma4 has vision). Use this when aria.extract returns sparse or incomplete content (e.g. JS-heavy pages, tables, product grids, SPAs, charts, or any page with fewer than 5 interactive elements). Takes a screenshot of the tab and asks the vision model to transcribe what it sees. Optionally provide a specific question to guide the transcription (e.g. "What products and prices are listed?" vs full literal dump).',
  argsSchema: z.object({
    tabId: z.number().int().describe('Target tab ID'),
    question: z
      .string()
      .optional()
      .describe('What to look for on the page (e.g. "all product names and prices", "the main heading"). Defaults to full literal transcription.'),
  }),
  async dispatch({ tabId, question }, ctx) {
    let b64: string;
    try {
      b64 = stripDataUri(await captureTabPng(tabId));
    } catch (err) {
      return {
        ok: false,
        content: `vision.read: screenshot capture failed (${(err as Error).message}) — use aria.extract or dom.query instead.`,
        data: { error: (err as Error).message },
      };
    }
    console.log(`[BA] vision.read: captured ${b64.length} base64 chars for tab ${tabId}`);
    if (b64.length < 100) {
      return {
        ok: false,
        content: `vision.read: screenshot was empty (${b64.length} bytes) — the tab may not be the visible foreground tab. Use aria.extract instead.`,
        data: { capturedBytes: b64.length },
      };
    }
    const prompt =
      question
        ? `Look at this web page screenshot. ${question} Be specific — read text and numbers exactly as they appear, do not infer values not visible.`
        : DEFAULT_TRANSCRIPTION;
    const resp = await ctx.ollama.chatOnce({
      model: ctx.settings.visionModel,
      messages: [{ role: 'user', content: prompt, images: [b64] }],
      thinking: false,
      numCtx: ctx.numCtx ?? NUM_CTX,
      timeoutMs: 300_000,
      signal: ctx.signal,
    });
    const text = (resp.message.content ?? '').trim();
    if (!text) {
      return {
        ok: false,
        content: `vision.read: model "${ctx.settings.visionModel}" returned no text (is it a multimodal model?).`,
      };
    }
    clearExtractionCache(tabId); // invalidate stale ARIA cache — page may have changed
    return {
      ok: true,
      content: text,
      data: { chars: text.length, model: ctx.settings.visionModel, question: question ?? null },
    };
  },
};

// ── vision.verify ──────────────────────────────────────────
// Quick visual yes/no check after an action. Much faster than a full
// vision.read — directed question, no full transcription.

export const visionVerifyTool: ToolDefDescriptor<{
  tabId: number;
  expectation: string;
}> = {
  name: 'vision.verify',
  description:
    'Take a quick screenshot and check if something specific is visible on the page. Use this after clicking or typing to verify the action had the expected visual result (e.g. "Is there a search results table now?", "Did a popup appear?", "Is the form field filled?"). Returns a yes/no answer with the relevant detail. Much faster than a full vision.read because the question is targeted.',
  argsSchema: z.object({
    tabId: z.number().int().describe('Target tab ID'),
    expectation: z
      .string()
      .describe('What you expect to see. A specific yes/no question about visible page state (e.g. "Is there a search results section?", "Did a confirmation message appear?").'),
  }),
  async dispatch({ tabId, expectation }, ctx) {
    let b64: string;
    try {
      b64 = stripDataUri(await captureTabPng(tabId));
    } catch (err) {
      return {
        ok: false,
        content: `vision.verify: screenshot failed (${(err as Error).message}) — try another approach.`,
      };
    }
    if (b64.length < 100) {
      return { ok: false, content: 'vision.verify: screenshot was empty — tab may not be visible.' };
    }
    const resp = await ctx.ollama.chatOnce({
      model: ctx.settings.visionModel,
      messages: [
        {
          role: 'user',
          content: `Look at this web page screenshot. Answer with JUST "YES: <what you see>" or "NO: <what you see instead>". Question: ${expectation}`,
          images: [b64],
        },
      ],
      thinking: false,
      numCtx: ctx.numCtx ?? NUM_CTX,
      timeoutMs: 60_000,
      signal: ctx.signal,
    });
    const text = (resp.message.content ?? '').trim();
    if (!text) return { ok: false, content: 'vision.verify: model returned no answer.' };
    const passed = text.toUpperCase().startsWith('YES');
    return {
      ok: passed,
      content: passed ? `Verified: ${text}` : `Not verified: ${text}`,
      data: { passed, model: ctx.settings.visionModel },
    };
  },
};
