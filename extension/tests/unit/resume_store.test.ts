import { beforeEach, describe, expect, it } from 'vitest';
import { loadResumeFile, memorySet, saveResumeFile } from '@/background/state_store';
import { resetStorage } from '../helpers';

describe('résumé file storage', () => {
  beforeEach(async () => {
    await resetStorage();
  });

  it('round-trips a stored résumé file', async () => {
    expect(await loadResumeFile()).toBeNull();
    await saveResumeFile({ name: 'resume.pdf', mime: 'application/pdf', base64: 'QUJD' });
    const got = await loadResumeFile();
    expect(got?.name).toBe('resume.pdf');
    expect(got?.mime).toBe('application/pdf');
    expect(got?.base64).toBe('QUJD');
    expect(typeof got?.savedAt).toBe('number');
  });

  it('returns null when the stored value lacks bytes', async () => {
    await memorySet('resume:file', { name: 'x.pdf' });
    expect(await loadResumeFile()).toBeNull();
  });
});
