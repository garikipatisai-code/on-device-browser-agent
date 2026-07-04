// Fast path for chitchat that isn't a real task — skips the Planner/Executor/Evaluator loop
// entirely (see docs/superpowers/specs/2026-07-04-agent-tab-polish-design.md, Part B1).
import type { OllamaClient } from './ollama';

// Deliberately narrow and explicit — NOT a "short message" heuristic, which would misclassify
// real short goals like "buy milk" or "check gmail".
const CHITCHAT_PHRASES = new Set([
  'hi', 'hello', 'hey', 'hiya', 'yo', 'hello there', 'hey there',
  'good morning', 'good afternoon', 'good evening',
  'test', 'thanks', 'thank you', 'ok', 'okay',
]);

export function isTrivialChitchat(goal: string): boolean {
  const normalized = goal.trim().toLowerCase().replace(/[.!?]+$/, '');
  return CHITCHAT_PHRASES.has(normalized);
}

export const QUICK_CHAT_FALLBACK =
  'Hi! Tell me what you\'d like me to do — e.g. "find the cheapest flight to NYC".';

/** One lightweight, non-tool-calling chat completion — NOT the Planner/Executor/Evaluator
 *  prompts, which are shaped for goal-decomposition and tool-calling and would be the wrong
 *  tool for a friendly reply. Short timeout: if this isn't fast, the caller should fall back
 *  to QUICK_CHAT_FALLBACK rather than let a "quick" aside take as long as a real task. */
export async function quickChatReply(ollama: OllamaClient, model: string, goal: string): Promise<string> {
  const resp = await ollama.chatOnce({
    model,
    messages: [
      {
        role: 'system',
        content:
          'You are a friendly on-device browser assistant. The user just sent a casual greeting or small talk, not a task. Reply warmly in ONE short sentence, then invite them to give you a real task with a concrete example (e.g. "find the cheapest flight to NYC" or "summarize this page"). Do not use tools or ask clarifying questions about a task — there is no task yet.',
      },
      { role: 'user', content: goal },
    ],
    timeoutMs: 15_000,
  });
  const text = resp.message.content?.trim();
  if (!text) throw new Error('Quick chat: empty reply');
  return text;
}
