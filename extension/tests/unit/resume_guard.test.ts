import { describe, expect, it, vi } from 'vitest';

// pdfjs-dist and its ?url worker import pull in browser-only globals at module load.
// Stub them so importing resume.ts under happy-dom doesn't explode — we only exercise
// the size guard, which runs before any parser touches the file.
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({ promise: Promise.resolve({ numPages: 0 }) }),
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'worker.js' }));
vi.mock('mammoth', () => ({ default: { extractRawText: async () => ({ value: '' }) } }));

const { extractResumeText } = await import('@/sidepanel/resume');

describe('extractResumeText — size guard', () => {
  it('rejects an oversized file before reading its bytes', async () => {
    const file = {
      name: 'huge.pdf',
      size: 25 * 1024 * 1024,
      arrayBuffer: async () => {
        throw new Error('must not read an oversized file into memory');
      },
    } as unknown as File;
    await expect(extractResumeText(file)).rejects.toThrow(/too large/i);
  });

  it('accepts a normal-sized text file', async () => {
    const file = {
      name: 'cv.txt',
      size: 1234,
      arrayBuffer: async () => new TextEncoder().encode('hello world').buffer,
    } as unknown as File;
    expect(await extractResumeText(file)).toContain('hello world');
  });
});
