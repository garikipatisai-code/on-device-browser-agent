// User profile for form-filling (job applications, checkout, etc.).
//
// Stored as a JSON object in Settings (`settings.profileJson`) and injected into the
// Executor context so the model fills form fields from the user's REAL data instead
// of inventing values. The résumé *file* itself is attached separately by the
// tab.upload_file tool (see tools/browser/upload.ts).

import type { ChatMessage } from '@/background/ollama';
import { parseJSONPermissive } from './util';

export function parseProfile(json?: string): Record<string, unknown> | null {
  if (!json || !json.trim()) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A readable "USER PROFILE" block for the Executor, or undefined if empty/invalid. */
export function renderProfileBlock(json?: string): string | undefined {
  const p = parseProfile(json);
  if (!p) return undefined;
  const lines: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (v === null || v === undefined || v === '') continue;
    lines.push(`- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  if (!lines.length) return undefined;
  return `USER PROFILE (the user's real data — fill form fields ONLY from these values; never invent personal data):\n${lines.join('\n')}`;
}

// ---- Résumé → profile extraction (a one-shot LLM call in the SW) -------------

/** Prompt that turns résumé text (from MarkItDown/mammoth/pdfjs) into a profile JSON. */
export function buildProfileExtractionMessages(resumeText: string): ChatMessage[] {
  const system = `You extract a structured profile from a résumé so a browser agent can auto-fill job-application forms.

Output ONLY a JSON object. Include these keys when the information is present (OMIT a key if absent — never guess):
- name, email, phone, location
- current_title, years_experience
- summary (1–2 sentences)
- skills (array of strings)
- linkedin, github, website
- education (array of strings)
- work_history (array of objects: {company, title, dates, summary})

Use ONLY facts found in the résumé text. Never invent an email, phone number, or employer.`;
  const user = `RÉSUMÉ (converted to text):\n\n${resumeText.slice(0, 16_000)}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Clean the model's raw JSON into a tidy profile JSON string (drops empty fields). Null if unusable. */
export function normalizeExtractedProfile(raw: string): string | null {
  const parsed = parseJSONPermissive<Record<string, unknown>>(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    clean[k] = v;
  }
  if (!Object.keys(clean).length) return null;
  return JSON.stringify(clean, null, 2);
}
