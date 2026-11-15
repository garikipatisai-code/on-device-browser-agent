import { beforeEach, describe, expect, it } from 'vitest';
import { loadSettings } from '@/background/state_store';
import { DEFAULT_SETTINGS } from '@/shared/messages';
import { resetStorage } from '../helpers';

beforeEach(async () => {
  await resetStorage();
});

function seedStoredSettings(v: unknown): Promise<void> {
  return new Promise<void>((resolve) => {
    chrome.storage.local.set({ 'agent.settings': v }, () => resolve());
  });
}

describe('settings migration: stale bare gemma4:e4b tags → PC baseline q4', () => {
  it('migrates stored bare gemma4:e4b brain/body/vision to the q4 tags', async () => {
    await seedStoredSettings({
      ...DEFAULT_SETTINGS,
      schemaVersion: 1,
      agent: {
        brain: { provider: 'ollama', model: 'gemma4:e4b', thinkingLevel: 'standard', numCtx: 32_768 },
        body: { provider: 'ollama', model: 'gemma4:e4b', thinkingLevel: 'off', numCtx: 16_384 },
      },
      visionModel: 'gemma4:e4b',
    });
    const s = await loadSettings();
    expect(s.agent?.brain.model).toBe('gemma4:e4b-it-q4_K_M');
    expect(s.agent?.body.model).toBe('gemma4:e2b-it-q4_K_M');
    expect(s.visionModel).toBe('gemma4:e4b-it-q4_K_M');
  });

  it('migrates v0 bare planner/executor tags through the same rule', async () => {
    await seedStoredSettings({
      ...DEFAULT_SETTINGS,
      schemaVersion: undefined,
      agent: undefined,
      plannerModel: 'gemma4:e4b',
      executorModel: 'gemma4:e4b',
      visionModel: 'gemma4:e4b',
    });
    const s = await loadSettings();
    expect(s.agent?.brain.model).toBe('gemma4:e4b-it-q4_K_M');
    expect(s.agent?.body.model).toBe('gemma4:e2b-it-q4_K_M');
    expect(s.visionModel).toBe('gemma4:e4b-it-q4_K_M');
  });

  it('leaves user-custom non-e4b tags untouched', async () => {
    await seedStoredSettings({
      ...DEFAULT_SETTINGS,
      schemaVersion: 1,
      agent: {
        brain: { provider: 'ollama', model: 'custom-brain:7b', thinkingLevel: 'standard', numCtx: 32_768 },
        body: { provider: 'ollama', model: 'custom-body:3b', thinkingLevel: 'off', numCtx: 16_384 },
      },
      visionModel: 'custom-vision:7b',
    });
    const s = await loadSettings();
    expect(s.agent?.brain.model).toBe('custom-brain:7b');
    expect(s.agent?.body.model).toBe('custom-body:3b');
    expect(s.visionModel).toBe('custom-vision:7b');
  });
});
