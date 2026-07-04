import { describe, expect, it } from 'vitest';
import { isTrivialChitchat, quickChatReply, QUICK_CHAT_FALLBACK } from '@/background/quick_chat';
import { makeFakeOllama, rawResponse } from '../helpers';

describe('isTrivialChitchat', () => {
  it('matches common greetings and chitchat, case-insensitively and with trailing punctuation', () => {
    const matches = ['hi', 'Hi', 'HELLO', 'hey', 'hey!', 'hello there.', 'good morning', 'test', 'thanks', 'thank you', 'ok', 'okay?'];
    for (const m of matches) {
      expect(isTrivialChitchat(m)).toBe(true);
    }
  });

  it('does not match real goals, even short ones', () => {
    const realGoals = ['find a wireless mouse under $30', 'buy milk', 'check gmail', 'what is the price of a Raspberry Pi 5?'];
    for (const g of realGoals) {
      expect(isTrivialChitchat(g)).toBe(false);
    }
  });

  it('trims surrounding whitespace before matching', () => {
    expect(isTrivialChitchat('   hi   ')).toBe(true);
  });
});

describe('quickChatReply', () => {
  it('returns the trimmed reply text from a normal chat completion', async () => {
    const ollama = makeFakeOllama({ unknown: [rawResponse({ content: '  Hi there! What can I help you with?  ' })] });
    const reply = await quickChatReply(ollama, 'gemma4:e4b', 'hi');
    expect(reply).toBe('Hi there! What can I help you with?');
  });

  it('throws when the model returns an empty reply, so the caller can fall back', async () => {
    const ollama = makeFakeOllama({ unknown: [rawResponse({ content: '   ' })] });
    await expect(quickChatReply(ollama, 'gemma4:e4b', 'hi')).rejects.toThrow();
  });
});

describe('QUICK_CHAT_FALLBACK', () => {
  it('is a non-empty static string', () => {
    expect(QUICK_CHAT_FALLBACK.length).toBeGreaterThan(0);
  });
});
