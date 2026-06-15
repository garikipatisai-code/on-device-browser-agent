import { describe, expect, it } from 'vitest';
import { sameModel, DEFAULT_SETTINGS } from '@/shared/messages';

describe('sameModel', () => {
  it('treats a bare name as equal to its :latest tag', () => {
    expect(sameModel('mxbai-embed-large', 'mxbai-embed-large:latest')).toBe(true);
    expect(sameModel('mxbai-embed-large:latest', 'mxbai-embed-large')).toBe(true);
  });
  it('matches identical explicit tags', () => {
    expect(sameModel('gemma4:e4b', 'gemma4:e4b')).toBe(true);
  });
  it('distinguishes different tags of the same model', () => {
    expect(sameModel('gemma4:e4b', 'gemma4:12b')).toBe(false);
    expect(sameModel('gemma4:e4b', 'gemma4:26b')).toBe(false);
  });
  it('distinguishes different models', () => {
    expect(sameModel('gemma4:e4b', 'qwen3:4b')).toBe(false);
  });
  it('bare vs bare', () => {
    expect(sameModel('llama3', 'llama3')).toBe(true);
    expect(sameModel('llama3', 'mistral')).toBe(false);
  });
});

describe('DEFAULT_SETTINGS', () => {
  it('every role has a non-empty model assigned', () => {
    expect(DEFAULT_SETTINGS.plannerModel).toBeTruthy();
    expect(DEFAULT_SETTINGS.executorModel).toBeTruthy();
    expect(DEFAULT_SETTINGS.evaluatorModel).toBeTruthy();
    expect(DEFAULT_SETTINGS.compactorModel).toBeTruthy();
    expect(DEFAULT_SETTINGS.embeddingModel).toBeTruthy();
  });
  it('compactor shares the executor model (cache reuse)', () => {
    expect(sameModel(DEFAULT_SETTINGS.compactorModel, DEFAULT_SETTINGS.executorModel)).toBe(true);
  });
});
