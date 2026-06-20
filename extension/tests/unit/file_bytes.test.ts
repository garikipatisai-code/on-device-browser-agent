import { describe, expect, it } from 'vitest';
import { fileToBase64 } from '@/sidepanel/file_bytes';

describe('fileToBase64', () => {
  it('encodes the file bytes as base64', async () => {
    const f = new File([new Uint8Array([65, 66, 67])], 'a.bin', { type: 'application/octet-stream' });
    expect(await fileToBase64(f)).toBe('QUJD'); // "ABC"
  });

  it('round-trips a large file across the 0x8000 chunk boundary', async () => {
    const n = 0x8000 * 2 + 123; // spans three chunks
    const arr = new Uint8Array(n);
    for (let i = 0; i < n; i++) arr[i] = i % 256;
    const b64 = await fileToBase64(new File([arr], 'big.bin'));
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(arr);
  });
});
