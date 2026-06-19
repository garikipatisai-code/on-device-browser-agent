// Résumé → text, in the side panel (a real window context — pdf.js needs a worker/DOM).
// The extracted text is sent to the SW, where gemma4 turns it into a profile JSON.
// We use the same engines MarkItDown uses (mammoth for docx, a pdf text layer for pdf),
// but in-browser so there's no second process to run.

import mammoth from 'mammoth';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

async function extractPdf(buf: ArrayBuffer): Promise<string> {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  return parts.join('\n\n');
}

function stripHtml(html: string): string {
  return new DOMParser().parseFromString(html, 'text/html').body?.textContent ?? '';
}

// A résumé is normally well under 1MB; cap generously so a mis-picked huge file
// (e.g. a video) can't be slurped into an ArrayBuffer and shipped to the SW.
const MAX_RESUME_BYTES = 20 * 1024 * 1024;

/** Convert a user-picked résumé file to plain text. Throws on unsupported types. */
export async function extractResumeText(file: File): Promise<string> {
  if (file.size > MAX_RESUME_BYTES) {
    throw new Error(
      `File "${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 20MB.`,
    );
  }
  const name = file.name.toLowerCase();
  const buf = await file.arrayBuffer();
  if (name.endsWith('.docx')) {
    const { value } = await mammoth.extractRawText({ arrayBuffer: buf });
    return value;
  }
  if (name.endsWith('.pdf')) return extractPdf(buf);
  const text = new TextDecoder().decode(buf);
  if (name.endsWith('.html') || name.endsWith('.htm')) return stripHtml(text);
  if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.markdown')) return text;
  throw new Error(`Unsupported file "${file.name}". Use .pdf, .docx, .txt, .md, or .html.`);
}
