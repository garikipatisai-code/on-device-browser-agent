import { describe, expect, it } from 'vitest';
import { fileToBase64 } from '@/sidepanel/file_bytes';

describe('fileToBase64', () => {
  it('encodes the file bytes as base64', async () => {
    const f = new File([new Uint8Array([65, 66, 67])], 'a.bin', { type: 'application/octet-stream' });
    expect(await fileToBase64(f)).toBe('QUJD'); // "ABC"
  });
});
