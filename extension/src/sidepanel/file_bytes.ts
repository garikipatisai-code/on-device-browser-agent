// File → base64 (no data: prefix). Kept separate from resume.ts so importing it
// in tests does not pull in pdfjs/mammoth and the `?url` worker import.
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  const chunk = 0x8000; // chunk to avoid call-stack overflow on large files
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
